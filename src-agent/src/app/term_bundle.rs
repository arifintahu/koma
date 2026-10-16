//! Verified, offline terminal payload shared by GUI and headless releases.
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};

static ARCHIVE: &[u8] = include_bytes!(concat!(env!("KOMA_TERM_PAYLOAD"), "/payload.zip"));
const MANIFEST: &str = include_str!(concat!(env!("KOMA_TERM_PAYLOAD"), "/manifest.json"));

#[derive(Deserialize)]
struct Manifest {
    target: String,
    files: BTreeMap<String, PayloadFile>,
}
#[derive(Deserialize)]
struct PayloadFile {
    sha256: String,
    executable: bool,
}

pub struct TermLaunch {
    pub dir: PathBuf,
    pub bun: PathBuf,
}

pub fn prepare() -> Result<TermLaunch> {
    let mut launch = materialize(&crate::model::store::base_dir()?.join("term"))?;
    if let Some(dir) = std::env::var_os("KOMA_TERM_DIR") {
        let dir = fs::canonicalize(dir).context("resolve KOMA_TERM_DIR")?;
        anyhow::ensure!(
            dir.join("src/index.tsx").is_file(),
            "KOMA_TERM_DIR has no src/index.tsx"
        );
        launch.dir = dir;
    }
    Ok(launch)
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid(root: &Path, name: &str, file: &PayloadFile) -> bool {
    let path = root.join(name);
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if file.executable && metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    fs::read(path).is_ok_and(|bytes| sha256(&bytes) == file.sha256)
}

fn materialize(root: &Path) -> Result<TermLaunch> {
    materialize_manifest(root, MANIFEST)
}

fn materialize_manifest(root: &Path, manifest_text: &str) -> Result<TermLaunch> {
    let manifest: Manifest = serde_json::from_str(manifest_text)?;
    anyhow::ensure!(
        manifest.target == env!("KOMA_TERM_TARGET"),
        "terminal payload target mismatch"
    );
    fs::create_dir_all(root).context("create terminal cache")?;
    let id = sha256(manifest_text.as_bytes());
    let lock = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join(format!("{id}.lock")))?;
    lock.lock().context("lock terminal payload")?;
    let dir = root.join(&id);
    let staging = root.join(format!("{id}.partial"));
    // A dead process releases the OS lock; its staging directory is disposable.
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    let complete = dir.join(".complete");
    if !complete.is_file()
        || !manifest
            .files
            .iter()
            .all(|(name, file)| valid(&dir, name, file))
    {
        fs::create_dir_all(&staging)?;
        let result = (|| -> Result<()> {
            let mut archive = zip::ZipArchive::new(Cursor::new(ARCHIVE))?;
            for (name, file) in &manifest.files {
                let mut entry = archive.by_name(name)?;
                let relative = entry
                    .enclosed_name()
                    .context("unsafe terminal archive path")?;
                let path = staging.join(relative);
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes)?;
                anyhow::ensure!(
                    sha256(&bytes) == file.sha256,
                    "corrupt embedded terminal file: {name}"
                );
                fs::create_dir_all(path.parent().context("terminal file parent")?)?;
                fs::write(&path, bytes)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(
                        &path,
                        fs::Permissions::from_mode(if file.executable { 0o755 } else { 0o644 }),
                    )?;
                }
            }
            fs::write(staging.join(".complete"), &id)?;
            if dir.exists() {
                // Repair under the same lock. Valid files may be in use on Windows.
                for (name, file) in &manifest.files {
                    if !valid(&dir, name, file) {
                        let path = dir.join(name);
                        fs::create_dir_all(path.parent().context("terminal repair parent")?)?;
                        if path.exists() {
                            fs::remove_file(&path)?;
                        }
                        fs::rename(staging.join(name), path)?;
                    }
                }
                fs::write(&complete, &id)?;
                fs::remove_dir_all(&staging)?;
            } else {
                fs::rename(&staging, &dir).context("complete terminal extraction")?;
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        result.context("extract offline terminal payload")?;
    }
    let dir = fs::canonicalize(dir)?;
    let bun = dir
        .join("runtime")
        .join(if cfg!(windows) { "bun.exe" } else { "bun" });
    Ok(TermLaunch { dir, bun })
}

/// Hidden release gate: uses the same extraction and absolute runtime as startup.
pub fn self_test() -> Result<()> {
    anyhow::ensure!(
        std::env::var_os("KOMA_TERM_DIR").is_none(),
        "self-test forbids KOMA_TERM_DIR"
    );
    let launch = prepare()?;
    let version = std::process::Command::new(&launch.bun)
        .arg("--version")
        .output()?;
    anyhow::ensure!(
        version.status.success() && version.stdout == b"1.4.3\n",
        "embedded Bun version failed"
    );
    let status = std::process::Command::new(&launch.bun)
        .arg(launch.dir.join("src/packaging-self-test.tsx"))
        .env("KOMA_BIN", std::env::current_exe()?)
        .status()?;
    anyhow::ensure!(
        status.success(),
        "terminal packaging self-test failed: {status}"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extraction_recovers_and_serializes_first_launches() {
        let root =
            std::env::temp_dir().join(format!("koma payload spaces {}", uuid::Uuid::new_v4()));
        let handles: Vec<_> = (0..3)
            .map(|_| {
                let root = root.clone();
                std::thread::spawn(move || materialize(&root).unwrap().dir)
            })
            .collect();
        let dirs: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(dirs.iter().all(|d| d == &dirs[0]));
        let entry = dirs[0].join("src/index.tsx");
        fs::write(&entry, "corrupt").unwrap();
        fs::remove_file(dirs[0].join("package.json")).unwrap();
        let partial = root.join(format!("{}.partial", sha256(MANIFEST.as_bytes())));
        fs::create_dir_all(&partial).unwrap();
        fs::write(partial.join("interrupted"), "partial").unwrap();
        let repaired = materialize(&root).unwrap();
        assert_eq!(fs::read(&entry).unwrap(), zip_entry("src/index.tsx"));
        assert!(repaired.dir.join("package.json").exists());
        assert!(!partial.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&repaired.bun, fs::Permissions::from_mode(0o644)).unwrap();
            let repaired = materialize(&root).unwrap();
            assert_ne!(
                fs::metadata(repaired.bun).unwrap().permissions().mode() & 0o111,
                0
            );
        }
        let upgraded = materialize_manifest(&root, &format!("{MANIFEST}\n")).unwrap();
        assert_ne!(upgraded.dir, repaired.dir);
        assert!(repaired.dir.join(".complete").exists());
        assert_eq!(materialize(&root).unwrap().dir, repaired.dir);
        let wrong = MANIFEST.replace(env!("KOMA_TERM_TARGET"), "wrong-target");
        assert!(materialize_manifest(&root, &wrong).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    fn zip_entry(name: &str) -> Vec<u8> {
        let mut archive = zip::ZipArchive::new(Cursor::new(ARCHIVE)).unwrap();
        let mut bytes = Vec::new();
        archive
            .by_name(name)
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        bytes
    }
}
