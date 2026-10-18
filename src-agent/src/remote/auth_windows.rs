//! Native OpenSSH askpass entry point; credentials stay in the owning process.
use anyhow::{bail, ensure, Context, Result};
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

pub(crate) const PIPE_ENV: &str = "KOMA_SSH_ASKPASS_PIPE";
const TOKEN_ENV: &str = "KOMA_SSH_ASKPASS_TOKEN";
const TIMEOUT: Duration = Duration::from_secs(5);

struct Secret(String);
impl Drop for Secret {
    fn drop(&mut self) {
        // SAFETY: this String is exclusively owned and remains valid UTF-8 when zeroed.
        unsafe {
            for byte in self.0.as_bytes_mut() {
                std::ptr::write_volatile(byte, 0);
            }
        }
    }
}

pub(crate) struct PipeAuth {
    path: String,
    token: String,
    stop: Option<oneshot::Sender<()>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl PipeAuth {
    pub(crate) fn new(password: String) -> Result<Self> {
        let path = format!(r"\\.\pipe\koma-askpass-{}", uuid::Uuid::new_v4());
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let (stop, stopped) = oneshot::channel();
        let (ready, started) = std::sync::mpsc::sync_channel(1);
        let pipe_path = path.clone();
        let expected = token.clone();
        let worker = std::thread::Builder::new()
            .name("ssh-askpass".into())
            .spawn(move || {
                let password = Secret(password);
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let first = match crate::ipc::protected_pipe(pipe_path.as_ref(), true) {
                        Ok(pipe) => pipe,
                        Err(error) => {
                            let _ = ready.send(Err(error));
                            return;
                        }
                    };
                    let _ = ready.send(Ok(()));
                    tokio::select! {
                        _ = stopped => {},
                        _ = serve(first, &pipe_path, &expected, &password.0) => {},
                    }
                });
            })?;
        if let Err(error) = started
            .recv()
            .context("SSH password helper did not start")?
        {
            let _ = worker.join();
            return Err(error.into());
        }
        Ok(Self {
            path,
            token,
            stop: Some(stop),
            worker: Some(worker),
        })
    }

    pub(crate) fn environment(&self) -> [(&str, &str); 2] {
        [(PIPE_ENV, &self.path), (TOKEN_ENV, &self.token)]
    }
}

impl Drop for PipeAuth {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

async fn serve(
    mut pipe: tokio::net::windows::named_pipe::NamedPipeServer,
    path: &str,
    token: &str,
    password: &str,
) -> Result<()> {
    loop {
        pipe.connect().await?;
        // Keep the name continuously owned while re-arming for repeated prompts.
        let next = crate::ipc::protected_pipe(path.as_ref(), false)?;
        let _ = tokio::time::timeout(TIMEOUT, async {
            let mut supplied = [0u8; 64];
            pipe.read_exact(&mut supplied).await?;
            ensure!(
                supplied == token.as_bytes(),
                "SSH password helper authentication failed"
            );
            pipe.write_u32(u32::try_from(password.len())?).await?;
            pipe.write_all(password.as_bytes()).await?;
            ensure!(
                pipe.read_u8().await? == 1,
                "SSH password helper did not acknowledge receipt"
            );
            Ok::<_, anyhow::Error>(())
        })
        .await;
        pipe = next;
    }
}

fn password_prompt(prompt: &str) -> bool {
    let prompt = prompt.to_ascii_lowercase();
    prompt.contains("password") || prompt.contains("passphrase")
}

pub(crate) fn run_helper() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let prompt = args.next().context("Missing SSH authentication prompt")?;
    ensure!(
        args.next().is_none() && password_prompt(&prompt.to_string_lossy()),
        "Unsupported SSH authentication prompt"
    );
    let path = PathBuf::from(std::env::var_os(PIPE_ENV).context("Missing SSH password pipe")?);
    let token = std::env::var(TOKEN_ENV).context("Missing SSH password token")?;
    ensure!(
        token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid SSH password token"
    );
    // A helper may only contact this feature's local pipe namespace.
    ensure!(
        path.to_string_lossy()
            .starts_with(r"\\.\pipe\koma-askpass-"),
        "Invalid SSH password pipe"
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let password = runtime.block_on(async {
        tokio::time::timeout(TIMEOUT, async {
            let mut pipe = crate::ipc::IpcStream::connect(&path).await?;
            pipe.write_all(token.as_bytes()).await?;
            let length = pipe.read_u32().await? as usize;
            if length > 1024 * 1024 {
                bail!("SSH password response too large");
            }
            let mut password = vec![0; length];
            pipe.read_exact(&mut password).await?;
            pipe.write_u8(1).await?;
            Ok::<_, anyhow::Error>(Secret(String::from_utf8(password)?))
        })
        .await
        .context("SSH password helper timed out")?
    })?;
    use std::io::Write;
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(password.0.as_bytes())?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}

/// Exercise the packaged executable, not Rust's unit-test harness entry point.
pub(crate) fn self_test() -> Result<()> {
    use super::auth::SshAuth;
    use std::process::{Command, Stdio};
    let password = "秘密 ' & % ! \" $ `";
    let expected = format!("{password}\n").into_bytes();
    let auth = SshAuth::new(password.into())?;
    let exe = std::env::current_exe()?;
    for prompt in ["user@host's password:", "Enter passphrase for key 'a':"] {
        let mut command = Command::new(&exe);
        auth.apply_to_std_command(&mut command);
        let output = command.arg(prompt).stdin(Stdio::null()).output()?;
        ensure!(
            output.status.success() && output.stdout == expected,
            "Native askpass output failed"
        );
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let mut command = tokio::process::Command::new(&exe);
        auth.apply_to_tokio_command(&mut command);
        let output = command
            .arg("Password:")
            .stdin(Stdio::null())
            .output()
            .await?;
        ensure!(
            output.status.success() && output.stdout == expected,
            "Tokio askpass output failed"
        );
        Ok::<_, anyhow::Error>(())
    })?;
    let mut builder = portable_pty::CommandBuilder::new(&exe);
    auth.apply_to_command_builder(&mut builder);
    let mut command = Command::new(&exe);
    command.envs(builder.iter_extra_env_as_str());
    let output = command.arg("Password:").stdin(Stdio::null()).output()?;
    ensure!(
        output.status.success() && output.stdout == expected,
        "PTY adapter askpass output failed"
    );
    for prompt in [
        "Are you sure you want to continue connecting (yes/no)?",
        "Unrelated prompt",
    ] {
        let mut command = Command::new(&exe);
        auth.apply_to_std_command(&mut command);
        let output = command.arg(prompt).stdin(Stdio::null()).output()?;
        ensure!(
            !output.status.success() && output.stdout.is_empty(),
            "Askpass answered a non-password prompt"
        );
    }
    let mut command = Command::new(&exe);
    auth.apply_to_std_command(&mut command);
    let output = command
        .env(TOKEN_ENV, "0".repeat(64))
        .arg("Password:")
        .stdin(Stdio::null())
        .output()?;
    ensure!(
        !output.status.success() && output.stdout.is_empty(),
        "Askpass accepted an invalid token"
    );

    let directory =
        std::env::temp_dir().join(format!("koma askpass test {}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory)?;
    let helper = directory.join("koma helper.exe");
    let result = (|| -> Result<()> {
        if std::fs::hard_link(&exe, &helper).is_err() {
            std::fs::copy(&exe, &helper)?;
        }
        let mut command = Command::new(&helper);
        auth.apply_to_std_command(&mut command);
        command.env("SSH_ASKPASS", &helper);
        let output = command.arg("Password:").stdin(Stdio::null()).output()?;
        ensure!(
            output.status.success() && output.stdout == expected,
            "Askpass executable path with spaces failed"
        );
        Ok(())
    })();
    let _ = std::fs::remove_file(&helper);
    let _ = std::fs::remove_dir(&directory);
    result?;
    let mut expired = Command::new(&exe);
    auth.apply_to_std_command(&mut expired);
    drop(auth);
    let output = expired.arg("Password:").stdin(Stdio::null()).output()?;
    ensure!(
        !output.status.success() && output.stdout.is_empty(),
        "Expired askpass pipe remained usable"
    );
    runtime.block_on(async {
        let path = format!(r"\\.\pipe\koma-askpass-{}", uuid::Uuid::new_v4());
        let silent = crate::ipc::protected_pipe(path.as_ref(), true)?;
        let mut command = tokio::process::Command::new(&exe);
        command.env(PIPE_ENV, &path).env(TOKEN_ENV, "0".repeat(64));
        let child = command
            .arg("Password:")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        tokio::time::timeout(TIMEOUT, silent.connect()).await??;
        let output =
            tokio::time::timeout(TIMEOUT + Duration::from_secs(2), child.wait_with_output())
                .await??;
        ensure!(
            !output.status.success()
                && output.stdout.is_empty()
                && String::from_utf8_lossy(&output.stderr).contains("timed out"),
            "Askpass did not bound a stalled response"
        );
        Ok::<_, anyhow::Error>(())
    })?;
    println!("Native Windows SSH askpass checks passed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_do_not_answer_host_verification() {
        assert!(password_prompt("user@host's password:"));
        assert!(password_prompt("Enter passphrase for key 'a':"));
        assert!(!password_prompt(
            "Are you sure you want to continue connecting (yes/no)?"
        ));
    }

    #[test]
    fn pipe_auth_repeats_rejects_bad_tokens_and_cleans_up() {
        let secret = "秘密 ' & % ! \" $ `";
        let auth = PipeAuth::new(secret.into()).unwrap();
        let path = PathBuf::from(&auth.path);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            for token in ["0".repeat(64), auth.token.clone(), auth.token.clone()] {
                let mut pipe = crate::ipc::IpcStream::connect(&path).await.unwrap();
                pipe.write_all(token.as_bytes()).await.unwrap();
                let length = tokio::time::timeout(TIMEOUT, pipe.read_u32())
                    .await
                    .unwrap();
                if token != auth.token {
                    assert!(length.is_err());
                    continue;
                }
                let mut bytes = vec![0; length.unwrap() as usize];
                pipe.read_exact(&mut bytes).await.unwrap();
                pipe.write_u8(1).await.unwrap();
                assert_eq!(bytes, secret.as_bytes());
            }
        });
        drop(auth);
        runtime.block_on(async {
            assert!(crate::ipc::IpcStream::connect(&path).await.is_err());
        });
    }
}
