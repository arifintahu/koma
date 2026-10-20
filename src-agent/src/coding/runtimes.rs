//! Koma-managed runtimes (Node, Go, Zig, PHP) for language-server installers.
//!
//! A runtime lands under `~/.koma/runtimes/<name>/<version>/` only when the
//! host has no usable one: the managed `bin` dirs are appended to
//! [`super::environment::host_path`], so a system install always wins. Windows
//! is the only host without a reviewed package-manager recipe for these, so the
//! download path is Windows-only; other hosts keep the Language Packs recipes
//! in `packs.rs`.
use anyhow::{Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

const RUNTIMES: [&str; 4] = ["node", "go", "zig", "php"];
const DOWNLOAD_LIMIT: u64 = 512 * 1024 * 1024;

/// Two language-server installs can need the same runtime at once.
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn root() -> Result<PathBuf> {
    Ok(crate::model::store::base_dir()?.join("runtimes"))
}

fn exe_name(runtime: &str) -> String {
    format!("{runtime}{}", if cfg!(windows) { ".exe" } else { "" })
}

/// Directories of installed managed runtimes (those with a `current.json`).
pub(crate) fn bin_dirs() -> Vec<PathBuf> {
    let Ok(root) = root() else {
        return Vec::new();
    };
    RUNTIMES
        .iter()
        .filter_map(|name| current_bin(&root, name))
        .collect()
}

fn current_bin(root: &Path, name: &str) -> Option<PathBuf> {
    let base = root.join(name);
    let record: Value =
        serde_json::from_slice(&std::fs::read(base.join("current.json")).ok()?).ok()?;
    let dir = base.join(record.get("bin")?.as_str()?);
    dir.join(exe_name(name)).is_file().then_some(dir)
}

fn runtime_for(program: &str) -> Option<&'static str> {
    match program {
        "node" | "npm" | "npx" => Some("node"),
        "go" => Some("go"),
        "zig" => Some("zig"),
        "php" => Some("php"),
        _ => None,
    }
}

/// Find `program` on the host, downloading its runtime first when it is absent.
pub(crate) fn ensure_tool(program: &str) -> Result<PathBuf> {
    if let Some(path) = crate::lsp::resolve::find_on_path(program) {
        return Ok(path);
    }
    let runtime = runtime_for(program).with_context(|| format!("{program} is not a managed runtime"))?;
    let _guard = INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Another install may have finished while this one waited.
    if let Some(path) = crate::lsp::resolve::find_on_path(program) {
        return Ok(path);
    }
    anyhow::ensure!(
        cfg!(windows),
        "{program} not found on PATH — install {runtime} with your package manager or Language Packs"
    );
    install(runtime)?;
    crate::lsp::resolve::find_on_path(program)
        .with_context(|| format!("{program} not found after installing the managed {runtime} runtime"))
}

/// A resolved download: the file to fetch plus the digest to check it against.
#[derive(Debug, PartialEq, Eq)]
struct Asset {
    version: String,
    name: String,
    url: String,
    sha256: Option<String>,
}

fn install(runtime: &str) -> Result<()> {
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    let asset = match runtime {
        "node" => {
            let index = super::provision::json_url("https://nodejs.org/dist/index.json")?;
            let mut asset = node_asset(&index, os, arch)?;
            let sums = super::provision::download(
                &format!("https://nodejs.org/dist/{}/SHASUMS256.txt", asset.version),
                1024 * 1024,
            )?;
            asset.sha256 = shasum_for(&String::from_utf8_lossy(&sums), &asset.name);
            asset
        }
        "go" => go_asset(
            &super::provision::json_url("https://go.dev/dl/?mode=json")?,
            os,
            arch,
        )?,
        "zig" => zig_asset(
            &super::provision::json_url("https://ziglang.org/download/index.json")?,
            os,
            arch,
        )?,
        "php" => php_asset(
            &super::provision::json_url(
                "https://downloads.php.net/~windows/releases/releases.json",
            )?,
            os,
            arch,
        )?,
        other => anyhow::bail!("Unknown managed runtime: {other}"),
    };
    println!("Downloading {runtime} {}: {}", asset.version, asset.url);
    let bytes = super::provision::download(&asset.url, DOWNLOAD_LIMIT)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    match &asset.sha256 {
        Some(expected) => anyhow::ensure!(
            hash.eq_ignore_ascii_case(expected),
            "{runtime} download digest mismatch"
        ),
        None => anyhow::bail!("{runtime} release has no published SHA-256; refusing to install"),
    }
    let base = root()?.join(runtime);
    let dest = base.join(&asset.version);
    if dest.exists() {
        std::fs::remove_dir_all(&dest).with_context(|| format!("clear {}", dest.display()))?;
    }
    std::fs::create_dir_all(&dest)?;
    super::provision::extract(&bytes, &asset.name, &dest)?;
    let exe = super::provision::find_file(&dest, &exe_name(runtime))?;
    if runtime == "php" {
        configure_php(exe.parent().context("php.exe has no directory")?)?;
    }
    let bin = exe
        .parent()
        .and_then(|p| p.strip_prefix(&base).ok())
        .context("Runtime executable escaped its directory")?;
    let record = json!({
        "version": asset.version,
        "bin": bin.to_string_lossy(),
        "sha256": hash,
        "installed": crate::lsp::manifest::now_epoch(),
    });
    super::persistence::atomic_write(
        &base.join("current.json"),
        &serde_json::to_vec_pretty(&record)?,
    )?;
    println!("Installed {runtime} {}: {}", asset.version, exe.display());
    Ok(())
}

fn windows_arch(os: &str, arch: &str) -> Result<&'static str> {
    anyhow::ensure!(os == "windows", "Managed runtimes are only downloaded on Windows");
    match arch {
        "x86_64" => Ok("x64"),
        "aarch64" => Ok("arm64"),
        other => anyhow::bail!("No managed runtime build for windows/{other}"),
    }
}

/// `hash  filename` lines of a `SHASUMS256.txt`.
fn shasum_for(text: &str, file: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (hash, name) = line.split_once(char::is_whitespace)?;
        (name.trim().trim_start_matches('*') == file).then(|| hash.to_string())
    })
}

/// Newest LTS release that ships a Windows zip for this architecture.
fn node_asset(index: &Value, os: &str, arch: &str) -> Result<Asset> {
    let arch = windows_arch(os, arch)?;
    let format = format!("win-{arch}-zip");
    let release = index
        .as_array()
        .context("Invalid Node release index")?
        .iter()
        .find(|r| {
            r["lts"].is_string()
                && r["files"]
                    .as_array()
                    .is_some_and(|f| f.iter().any(|v| v == &json!(format)))
        })
        .context("No Node LTS release for this Windows architecture")?;
    let version = release["version"].as_str().context("Node release has no version")?;
    let name = format!("node-{version}-win-{arch}.zip");
    Ok(Asset {
        version: version.to_string(),
        url: format!("https://nodejs.org/dist/{version}/{name}"),
        name,
        sha256: None,
    })
}

/// Newest stable Go release with a Windows zip.
fn go_asset(list: &Value, os: &str, arch: &str) -> Result<Asset> {
    let goarch = match windows_arch(os, arch)? {
        "x64" => "amd64",
        _ => "arm64",
    };
    let (release, file) = list
        .as_array()
        .context("Invalid Go release list")?
        .iter()
        .filter(|r| r["stable"] == true)
        .find_map(|r| {
            r["files"].as_array()?.iter().find_map(|f| {
                (f["os"] == "windows"
                    && f["arch"] == goarch
                    && f["kind"] == "archive"
                    && f["filename"].as_str()?.ends_with(".zip"))
                .then_some((r, f))
            })
        })
        .context("No stable Go release for this Windows architecture")?;
    let name = file["filename"].as_str().context("Go file has no name")?;
    Ok(Asset {
        version: release["version"]
            .as_str()
            .unwrap_or(name)
            .trim_start_matches("go")
            .to_string(),
        url: format!("https://go.dev/dl/{name}"),
        name: name.to_string(),
        sha256: file["sha256"].as_str().map(str::to_string),
    })
}

/// Newest stable Zig release. JSON object keys come back sorted, so compare
/// parsed versions; `master` and pre-release keys do not parse and are skipped.
fn zig_asset(index: &Value, os: &str, arch: &str) -> Result<Asset> {
    let target = match windows_arch(os, arch)? {
        "x64" => "x86_64-windows",
        _ => "aarch64-windows",
    };
    let triple = |key: &str| -> Option<(u32, u32, u32)> {
        let mut parts = key.split('.').map(|p| p.parse::<u32>());
        let version = (parts.next()?.ok()?, parts.next()?.ok()?, parts.next()?.ok()?);
        parts.next().is_none().then_some(version)
    };
    let (version, entry) = index
        .as_object()
        .context("Invalid Zig release index")?
        .iter()
        .filter(|(key, value)| value[target]["tarball"].is_string() && triple(key).is_some())
        .max_by_key(|(key, _)| triple(key))
        .context("No stable Zig release for this Windows architecture")?;
    let url = entry[target]["tarball"].as_str().context("Zig release has no URL")?;
    anyhow::ensure!(url.starts_with("https://"), "Zig download is not HTTPS");
    Ok(Asset {
        version: version.clone(),
        name: url.rsplit('/').next().unwrap_or(url).to_string(),
        url: url.to_string(),
        sha256: entry[target]["shasum"].as_str().map(str::to_string),
    })
}

/// Newest PHP minor with a thread-safe-off (CLI) x64 build. Official Windows
/// builds are x64 only; arm64 hosts run them under emulation.
fn php_asset(releases: &Value, os: &str, arch: &str) -> Result<Asset> {
    windows_arch(os, arch)?;
    let minor = |key: &str| -> Option<(u32, u32)> {
        let (a, b) = key.split_once('.')?;
        Some((a.parse().ok()?, b.parse().ok()?))
    };
    let (_, release) = releases
        .as_object()
        .context("Invalid PHP release index")?
        .iter()
        .filter_map(|(k, v)| Some((minor(k)?, v)))
        .filter(|(_, v)| php_build(v).is_some())
        .max_by_key(|(k, _)| *k)
        .context("No PHP release for Windows")?;
    let build = php_build(release).context("PHP release has no NTS x64 build")?;
    let name = build["zip"]["path"].as_str().context("PHP build has no file")?;
    Ok(Asset {
        version: release["version"].as_str().unwrap_or(name).to_string(),
        url: format!("https://downloads.php.net/~windows/releases/{name}"),
        name: name.to_string(),
        sha256: build["zip"]["sha256"].as_str().map(str::to_string),
    })
}

/// Highest `nts-vsNN-x64` build of a release object.
fn php_build(release: &Value) -> Option<&Value> {
    release
        .as_object()?
        .iter()
        .filter(|(k, _)| k.starts_with("nts-vs") && k.ends_with("-x64"))
        .max_by_key(|(k, _)| {
            k.trim_start_matches("nts-vs")
                .trim_end_matches("-x64")
                .parse::<u32>()
                .unwrap_or(0)
        })
        .map(|(_, v)| v)
}

/// The Windows zip ships without a `php.ini`, so `mbstring`, `openssl` and
/// friends (needed by Phpactor) would not load. Derive one from the
/// development template.
fn configure_php(dir: &Path) -> Result<()> {
    let target = dir.join("php.ini");
    if target.exists() {
        return Ok(());
    }
    let template = std::fs::read_to_string(dir.join("php.ini-development"))
        .context("PHP archive has no php.ini-development")?;
    std::fs::write(&target, php_ini(&template)).with_context(|| format!("write {}", target.display()))
}

fn php_ini(template: &str) -> String {
    const ENABLED: [&str; 7] = ["curl", "fileinfo", "intl", "mbstring", "openssl", "sodium", "zip"];
    let mut out = String::new();
    for line in template.lines() {
        let wanted = line
            .strip_prefix(";extension=")
            .is_some_and(|name| ENABLED.contains(&name))
            || line == ";extension_dir = \"ext\"";
        out.push_str(if wanted { &line[1..] } else { line });
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_picks_lts_with_a_windows_zip() {
        let index = json!([
            {"version":"v25.1.0","lts":false,"files":["win-x64-zip"]},
            {"version":"v24.2.0","lts":"Krypton","files":["linux-x64","win-x64-zip","win-arm64-zip"]},
            {"version":"v22.0.0","lts":"Jod","files":["win-x64-zip"]}
        ]);
        let asset = node_asset(&index, "windows", "x86_64").unwrap();
        assert_eq!(asset.version, "v24.2.0");
        assert_eq!(asset.name, "node-v24.2.0-win-x64.zip");
        assert_eq!(asset.url, "https://nodejs.org/dist/v24.2.0/node-v24.2.0-win-x64.zip");
        assert_eq!(
            node_asset(&index, "windows", "aarch64").unwrap().name,
            "node-v24.2.0-win-arm64.zip"
        );
        assert!(node_asset(&index, "linux", "x86_64").is_err());
    }

    #[test]
    fn shasums_match_the_exact_file() {
        let text = "aa11  node-v24.2.0-win-x64.7z\nbb22  node-v24.2.0-win-x64.zip\n";
        assert_eq!(shasum_for(text, "node-v24.2.0-win-x64.zip").as_deref(), Some("bb22"));
        assert_eq!(shasum_for(text, "missing.zip"), None);
    }

    #[test]
    fn go_picks_stable_windows_zip() {
        let list = json!([
            {"version":"go1.28rc1","stable":false,"files":[
                {"os":"windows","arch":"amd64","kind":"archive","filename":"go1.28rc1.windows-amd64.zip","sha256":"x"}]},
            {"version":"go1.27.3","stable":true,"files":[
                {"os":"windows","arch":"amd64","kind":"installer","filename":"go1.27.3.windows-amd64.msi","sha256":"m"},
                {"os":"windows","arch":"amd64","kind":"archive","filename":"go1.27.3.windows-amd64.zip","sha256":"abc"},
                {"os":"windows","arch":"arm64","kind":"archive","filename":"go1.27.3.windows-arm64.zip","sha256":"def"}]}
        ]);
        let asset = go_asset(&list, "windows", "x86_64").unwrap();
        assert_eq!(asset.version, "1.27.3");
        assert_eq!(asset.url, "https://go.dev/dl/go1.27.3.windows-amd64.zip");
        assert_eq!(asset.sha256.as_deref(), Some("abc"));
        assert_eq!(go_asset(&list, "windows", "aarch64").unwrap().sha256.as_deref(), Some("def"));
    }

    #[test]
    fn zig_skips_master_and_reads_the_shasum() {
        let index = json!({
            "master": {"x86_64-windows": {"tarball":"https://ziglang.org/builds/zig-dev.zip","shasum":"dev"}},
            "0.17.0": {"x86_64-windows": {"tarball":"https://ziglang.org/download/0.17.0/zig-x86_64-windows-0.17.0.zip","shasum":"s17"}},
            "0.16.0": {"x86_64-windows": {"tarball":"https://ziglang.org/download/0.16.0/zig-x86_64-windows-0.16.0.zip","shasum":"s16"}}
        });
        let asset = zig_asset(&index, "windows", "x86_64").unwrap();
        assert_eq!(asset.version, "0.17.0");
        assert_eq!(asset.name, "zig-x86_64-windows-0.17.0.zip");
        assert_eq!(asset.sha256.as_deref(), Some("s17"));
        assert!(zig_asset(&index, "windows", "aarch64").is_err());
    }

    #[test]
    fn php_picks_newest_minor_and_nts_build() {
        let releases = json!({
            "8.4": {"version":"8.4.9",
                "ts-vs17-x64":{"zip":{"path":"php-8.4.9-Win32-vs17-x64.zip","sha256":"ts"}},
                "nts-vs17-x64":{"zip":{"path":"php-8.4.9-nts-Win32-vs17-x64.zip","sha256":"nts"}}},
            "8.10": {"version":"8.10.1",
                "nts-vs16-x64":{"zip":{"path":"php-8.10.1-nts-Win32-vs16-x64.zip","sha256":"a"}},
                "nts-vs17-x64":{"zip":{"path":"php-8.10.1-nts-Win32-vs17-x64.zip","sha256":"b"}}},
            "7.4": {"version":"7.4.33"}
        });
        let asset = php_asset(&releases, "windows", "x86_64").unwrap();
        assert_eq!(asset.version, "8.10.1");
        assert_eq!(
            asset.url,
            "https://downloads.php.net/~windows/releases/php-8.10.1-nts-Win32-vs17-x64.zip"
        );
        assert_eq!(asset.sha256.as_deref(), Some("b"));
    }

    #[test]
    fn php_ini_enables_the_language_server_extensions() {
        let ini = php_ini(";extension_dir = \"ext\"\n;extension=mbstring\n;extension=ldap\n;extension=openssl\n");
        assert_eq!(ini, "extension_dir = \"ext\"\nextension=mbstring\n;extension=ldap\nextension=openssl\n");
    }

    #[test]
    fn tools_map_to_their_runtime() {
        assert_eq!(runtime_for("npm"), Some("node"));
        assert_eq!(runtime_for("go"), Some("go"));
        assert_eq!(runtime_for("cargo"), None);
    }
}
