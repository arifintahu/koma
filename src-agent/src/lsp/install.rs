//! Per-server install / uninstall for koma-managed language servers.
//!
//! Installs land under `~/.koma/lsp/<id>/` and are recorded in
//! [`super::manifest::Manifest`]. Uninstall deletes that directory + the
//! manifest entry and never touches PATH copies.
//!
//! Network work uses `reqwest::blocking` — callers must run this OFF any tokio
//! worker (CLI short-circuit and host-relay `std::thread::spawn` both qualify).

use anyhow::{anyhow, bail, Context, Result};
use flate2::read::GzDecoder;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use super::catalog::{self, InstallKind, ServerSpec};
use super::manifest::{self, ensure_executable, now_epoch, Manifest, ManifestEntry};
use super::resolve;

/// Optional progress callback: `(id, percent_0_100, optional_error)`.
/// `percent = 100` and `error = None` means success; `error = Some` means failure
/// (percent may be partial). CLI passes a println adapter; GUI pushes LspInstall.
pub type ProgressFn = Box<dyn FnMut(&str, u8, Option<&str>) + Send>;

/// Install one server by catalogue id. Idempotent when already managed unless
/// `force` is set.
pub fn install_one(id: &str, force: bool, mut progress: Option<ProgressFn>) -> Result<()> {
    let spec = catalog::find(id).ok_or_else(|| anyhow!("unknown language server id: {id}"))?;
    report(&mut progress, id, 0, None);

    if !force {
        if let Some(path) = manifest::managed_binary_path(spec.id, spec.binary) {
            report(&mut progress, id, 100, None);
            println!(
                "already installed (managed): {} ({})",
                spec.id,
                path.display()
            );
            return Ok(());
        }
    }

    let result = if matches!(id, "lua-language-server" | "zls") {
        crate::coding::provision::install(id)
    } else {
        match spec.kind {
            InstallKind::GithubGz => install_github_gz(spec, &mut progress),
            InstallKind::GithubZip => install_github_zip(spec, &mut progress),
            InstallKind::Npm => install_npm(spec, &mut progress),
            InstallKind::GoInstall => install_go(spec, &mut progress),
            InstallKind::Composer => crate::coding::provision::install(spec.id),
        }
    };

    match result {
        Ok(()) => {
            report(&mut progress, id, 100, None);
            Ok(())
        }
        Err(e) => {
            let msg = format!("{e:#}");
            report(&mut progress, id, 0, Some(&msg));
            Err(e)
        }
    }
}

/// Install every catalogue server. Continues on individual failures; returns
/// the first error if any failed (after attempting the rest).
pub fn install_all(force: bool, mut progress: Option<ProgressFn>) -> Result<()> {
    let mut first_err: Option<anyhow::Error> = None;
    for spec in catalog::CATALOG {
        // Skip entries whose managed install is not implemented yet.
        if !managed_install_supported(spec) {
            println!(
                "skip {}: managed install not available yet (use PATH binary)",
                spec.id
            );
            continue;
        }
        let cb = progress.take();
        match install_one(spec.id, force, cb) {
            Ok(()) => {}
            Err(e) => {
                eprintln!("error installing {}: {e:#}", spec.id);
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
        // progress was moved; re-create a no-op chain is fine for CLI --all
        // (GUI install-all re-supplies progress per id via separate calls).
        progress = None;
    }
    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Uninstall a koma-managed server. Never touches PATH copies. No-op (Ok) if
/// nothing is installed under the managed dir.
pub fn uninstall_one(id: &str) -> Result<()> {
    let _spec = catalog::find(id).ok_or_else(|| anyhow!("unknown language server id: {id}"))?;
    let tools = crate::coding::provision::tools_dir()?.join(id);
    if tools.exists() {
        std::fs::remove_dir_all(&tools)?;
    }
    let dir = manifest::server_dir(id)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).with_context(|| format!("remove {}", dir.display()))?;
        println!("removed {}", dir.display());
    } else {
        println!("nothing to remove for {id} (not koma-managed)");
    }
    let mut m = Manifest::load().unwrap_or_default();
    if m.remove(id).is_some() {
        m.save()?;
    }
    Ok(())
}

fn managed_install_supported(spec: &ServerSpec) -> bool {
    matches!(
        spec.id,
        "rust-analyzer"
            | "taplo"
            | "clangd"
            | "vtsls"
            | "basedpyright"
            | "gopls"
            | "vscode-langservers"
            | "bash-language-server"
            | "intelephense"
            | "phpactor"
            | "lua-language-server"
            | "zls"
    )
}

fn report(progress: &mut Option<ProgressFn>, id: &str, pct: u8, err: Option<&str>) {
    if let Some(cb) = progress.as_mut() {
        cb(id, pct, err);
    }
}

// ─── shared download / extract ───────────────────────────────────────────────

fn http_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .user_agent(format!("koma/{}", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .context("build http client")
}

fn download_bytes(url: &str, progress: &mut Option<ProgressFn>, id: &str) -> Result<Vec<u8>> {
    report(progress, id, 5, None);
    let client = http_client()?;
    let mut resp = client
        .get(url)
        .send()
        .with_context(|| format!("GET {url}"))?
        .error_for_status()
        .with_context(|| format!("GET {url} bad status"))?;
    let total = resp.content_length().unwrap_or(0);
    let mut buf = Vec::with_capacity(total.min(64 * 1024 * 1024) as usize);
    let mut tmp = [0u8; 64 * 1024];
    let mut read = 0u64;
    loop {
        let n = resp.read(&mut tmp).context("read download body")?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
        read += n as u64;
        if let Some(part) = read.saturating_mul(80).checked_div(total) {
            let pct = 5u8.saturating_add(part as u8).min(85);
            report(progress, id, pct, None);
        }
    }
    report(progress, id, 85, None);
    Ok(buf)
}

fn github_latest_tag(owner_repo: &str) -> Result<String> {
    let url = format!("https://api.github.com/repos/{owner_repo}/releases/latest");
    let client = http_client()?;
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .with_context(|| format!("GET {url}"))?
        .error_for_status()
        .with_context(|| format!("GET {url} bad status"))?;
    let v: serde_json::Value = resp.json().context("parse github latest release")?;
    v.get("tag_name")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("github latest release missing tag_name for {owner_repo}"))
}

fn host_triple_parts() -> Result<(&'static str, &'static str)> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let os = match os {
        "linux" => "linux",
        "macos" => "darwin",
        "windows" => "windows",
        other => bail!("unsupported os for lsp install: {other}"),
    };
    let arch = match arch {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => bail!("unsupported arch for lsp install: {other}"),
    };
    Ok((os, arch))
}

fn prepare_server_dir(id: &str) -> Result<PathBuf> {
    let dir = manifest::server_dir(id)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).with_context(|| format!("clear {}", dir.display()))?;
    }
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).with_context(|| format!("create {}", bin.display()))?;
    Ok(dir)
}

fn write_manifest(spec: &ServerSpec, version: &str, source: &str, binary_rel: &str) -> Result<()> {
    let mut m = Manifest::load().unwrap_or_default();
    m.upsert(ManifestEntry {
        id: spec.id.to_string(),
        version: version.to_string(),
        source: source.to_string(),
        installed_at: now_epoch(),
        binary_rel: Some(binary_rel.to_string()),
    });
    m.save()
}

// ─── github .gz single binary (rust-analyzer, taplo) ─────────────────────────

fn install_github_gz(spec: &ServerSpec, progress: &mut Option<ProgressFn>) -> Result<()> {
    if !managed_install_supported(spec) {
        bail!(
            "managed install for {} is not available yet — install `{}` on PATH",
            spec.id,
            spec.binary
        );
    }
    let (os, arch) = host_triple_parts()?;
    let tag = github_latest_tag(spec.package)?;
    report(progress, spec.id, 3, None);

    let asset = match spec.id {
        "rust-analyzer" => rust_analyzer_asset(os, arch)?,
        "taplo" => taplo_asset(os, arch)?,
        other => bail!("no github-gz asset mapping for {other}"),
    };
    // Windows rust-analyzer / taplo publish `.zip`; unix is `.gz`.
    if asset.ends_with(".zip") {
        return install_github_zip_asset(spec, &tag, asset, progress);
    }
    let url = format!(
        "https://github.com/{}/releases/download/{tag}/{asset}",
        spec.package
    );
    println!("downloading {url} ...");
    let gz_bytes = download_bytes(&url, progress, spec.id)?;

    let dir = prepare_server_dir(spec.id)?;
    let dest = dir.join("bin").join(exe_name(spec.binary));
    {
        let mut decoder = GzDecoder::new(gz_bytes.as_slice());
        let mut out = File::create(&dest).with_context(|| format!("create {}", dest.display()))?;
        std::io::copy(&mut decoder, &mut out)
            .with_context(|| format!("gunzip → {}", dest.display()))?;
        out.flush().ok();
    }
    ensure_executable(&dest)?;
    report(progress, spec.id, 95, None);
    write_manifest(
        spec,
        &tag,
        "github",
        &format!("bin/{}", exe_name(spec.binary)),
    )?;
    println!("installed {} {} → {}", spec.id, tag, dest.display());
    Ok(())
}

/// Shared zip download+extract for a known GitHub release asset name.
fn install_github_zip_asset(
    spec: &ServerSpec,
    tag: &str,
    asset: &str,
    progress: &mut Option<ProgressFn>,
) -> Result<()> {
    let url = format!(
        "https://github.com/{}/releases/download/{tag}/{asset}",
        spec.package
    );
    println!("downloading {url} ...");
    let bytes = download_bytes(&url, progress, spec.id)?;
    let dir = prepare_server_dir(spec.id)?;
    extract_zip_bytes(&bytes, &dir)?;
    let bin = find_named_file(&dir, &exe_name(spec.binary))
        .ok_or_else(|| anyhow!("{} binary not found inside zip", spec.binary))?;
    let dest = dir.join("bin").join(exe_name(spec.binary));
    if bin != dest {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(&bin, &dest)
            .with_context(|| format!("copy {} → {}", bin.display(), dest.display()))?;
    }
    ensure_executable(&dest)?;
    report(progress, spec.id, 95, None);
    write_manifest(
        spec,
        tag,
        "github",
        &format!("bin/{}", exe_name(spec.binary)),
    )?;
    println!("installed {} {} → {}", spec.id, tag, dest.display());
    Ok(())
}

fn rust_analyzer_asset(os: &str, arch: &str) -> Result<&'static str> {
    // Verified against rust-lang/rust-analyzer releases (e.g. 2026-08-17.4).
    Ok(match (os, arch) {
        ("linux", "x86_64") => "rust-analyzer-x86_64-unknown-linux-gnu.gz",
        ("linux", "aarch64") => "rust-analyzer-aarch64-unknown-linux-gnu.gz",
        ("darwin", "x86_64") => "rust-analyzer-x86_64-apple-darwin.gz",
        ("darwin", "aarch64") => "rust-analyzer-aarch64-apple-darwin.gz",
        ("windows", "x86_64") => "rust-analyzer-x86_64-pc-windows-msvc.zip",
        ("windows", "aarch64") => "rust-analyzer-aarch64-pc-windows-msvc.zip",
        (o, a) => bail!("no rust-analyzer build for {o}/{a}"),
    })
}

fn taplo_asset(os: &str, arch: &str) -> Result<&'static str> {
    // Verified against tamasfe/taplo releases (e.g. 0.10.0).
    Ok(match (os, arch) {
        ("linux", "x86_64") => "taplo-linux-x86_64.gz",
        ("linux", "aarch64") => "taplo-linux-aarch64.gz",
        ("darwin", "x86_64") => "taplo-darwin-x86_64.gz",
        ("darwin", "aarch64") => "taplo-darwin-aarch64.gz",
        ("windows", "x86_64") => "taplo-windows-x86_64.zip",
        ("windows", "aarch64") => "taplo-windows-aarch64.zip",
        (o, a) => bail!("no taplo build for {o}/{a}"),
    })
}

// ─── github .zip (clangd; windows rust-analyzer/taplo fall through here too) ─

fn install_github_zip(spec: &ServerSpec, progress: &mut Option<ProgressFn>) -> Result<()> {
    if spec.id != "clangd" {
        bail!(
            "managed install for {} is not available yet — install `{}` on PATH",
            spec.id,
            spec.binary
        );
    }
    let (os, _arch) = host_triple_parts()?;
    let tag = github_latest_tag(spec.package)?;
    report(progress, spec.id, 3, None);
    // clangd assets are OS-only (x86_64 assumed for published zips).
    let asset = match os {
        "linux" => format!("clangd-linux-{tag}.zip"),
        "darwin" => format!("clangd-mac-{tag}.zip"),
        "windows" => format!("clangd-windows-{tag}.zip"),
        other => bail!("no clangd build for {other}"),
    };
    install_github_zip_asset(spec, &tag, &asset, progress)
}

fn extract_zip_bytes(bytes: &[u8], dest: &Path) -> Result<()> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).context("open zip")?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).context("zip entry")?;
        let name = file
            .enclosed_name()
            .ok_or_else(|| anyhow!("zip entry has unsafe path"))?
            .to_owned();
        let out_path = dest.join(&name);
        if file.is_dir() {
            std::fs::create_dir_all(&out_path)?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out =
            File::create(&out_path).with_context(|| format!("create {}", out_path.display()))?;
        std::io::copy(&mut file, &mut out)?;
    }
    Ok(())
}

fn find_named_file(root: &Path, name: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).ok()?;
        for ent in entries.flatten() {
            let p = ent.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.file_name().and_then(|s| s.to_str()) == Some(name) {
                return Some(p);
            }
        }
    }
    None
}

// ─── npm --prefix ────────────────────────────────────────────────────────────

fn install_npm(spec: &ServerSpec, progress: &mut Option<ProgressFn>) -> Result<()> {
    let npm = crate::coding::runtimes::ensure_tool("npm")
        .with_context(|| format!("Node.js is required to manage {}", spec.id))?;
    let dir = prepare_server_dir(spec.id)?;
    report(progress, spec.id, 10, None);
    // `-g --prefix` is required: without `-g`, modern npm only links bins under
    // `node_modules/.bin/` and never creates `<prefix>/bin/<name>`. With `-g`,
    // bins land at `<prefix>/bin/` (Unix) / `<prefix>/` shims (Windows).
    println!(
        "npm install -g --prefix {} {} ...",
        dir.display(),
        spec.package
    );
    let mut cmd = Command::new(&npm);
    cmd.env("PATH", crate::coding::environment::host_path());
    cmd.args([
        "install",
        "-g",
        "--prefix",
        dir.to_str().ok_or_else(|| anyhow!("non-utf8 path"))?,
        spec.package,
    ]);
    crate::tool::shell::no_console_window(&mut cmd);
    let status = cmd
        .status()
        .with_context(|| format!("spawn npm for {}", spec.id))?;
    if !status.success() {
        bail!("npm install failed for {} (status {status})", spec.package);
    }
    report(progress, spec.id, 90, None);

    let found = find_npm_binary(&dir, spec.binary).ok_or_else(|| {
        anyhow!(
            "npm install succeeded but `{}` not found under {} \
             (checked bin/, node_modules/.bin/, and package bin/*.js)",
            spec.binary,
            dir.display()
        )
    })?;
    let rel = found
        .strip_prefix(&dir)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| found.display().to_string());
    ensure_executable(&found)?;
    write_manifest(spec, "latest", "npm", &rel)?;
    println!("installed {} → {}", spec.id, found.display());
    Ok(())
}

/// Locate an npm-installed binary under a `--prefix` root.
///
/// Unix (`-g --prefix`): `bin/<name>` symlink, then the package payload under
/// `lib/node_modules`, then a whole-prefix walk (`<name>`, `<name>.js`).
///
/// Windows: npm writes `<name>.cmd` / `.ps1` / extensionless sh shims into the
/// prefix root and the payload under `node_modules/`. Only `.cmd`/`.exe` can be
/// spawned, so `.js` and extensionless files are never returned there.
fn find_npm_binary(prefix: &Path, binary: &str) -> Option<PathBuf> {
    find_npm_binary_for(prefix, binary, cfg!(windows))
}

fn find_npm_binary_for(prefix: &Path, binary: &str, windows: bool) -> Option<PathBuf> {
    let names = npm_binary_names(binary, windows);
    let mut dirs = vec![
        prefix.to_path_buf(),
        prefix.join("bin"),
        prefix.join("node_modules").join(".bin"),
    ];
    if !windows {
        dirs.remove(0);
    }
    for name in &names {
        for dir in &dirs {
            let candidate = dir.join(name);
            if path_is_runnable(&candidate) {
                return Some(candidate);
            }
        }
    }
    if windows {
        // Last resort: the shim sits somewhere unexpected.
        return names
            .iter()
            .find_map(|name| find_named_file(prefix, name))
            .filter(|p| path_is_runnable(p));
    }
    // Global npm puts the package under lib/node_modules/<pkg>/…; the bin/
    // shim normally points there, but if the shim is missing, dig for the
    // package-local bin script (e.g. bin/vtsls.js, bin/vscode-json-language-server).
    for root in [
        prefix.join("lib").join("node_modules"),
        prefix.join("node_modules"),
        prefix.to_path_buf(),
    ] {
        if !root.is_dir() {
            continue;
        }
        for name in &names {
            if let Some(found) = find_named_file(&root, name) {
                if path_is_runnable(&found) {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// True for regular files and symlinks that resolve to a file.
fn path_is_runnable(p: &Path) -> bool {
    // `is_file` follows symlinks — good for npm's bin/ → lib/node_modules/... shims.
    p.is_file()
}

fn npm_binary_names(binary: &str, windows: bool) -> Vec<String> {
    if windows {
        if binary.ends_with(".cmd") || binary.ends_with(".exe") {
            return vec![binary.to_string()];
        }
        return vec![format!("{binary}.cmd"), format!("{binary}.exe")];
    }
    let mut names = vec![binary.to_string()];
    // Package bins are often `name.js` (e.g. @vtsls/language-server → bin/vtsls.js).
    if !binary.ends_with(".js") {
        names.push(format!("{binary}.js"));
    }
    names
}

// ─── go install (gopls) ──────────────────────────────────────────────────────

fn install_go(spec: &ServerSpec, progress: &mut Option<ProgressFn>) -> Result<()> {
    let go = crate::coding::runtimes::ensure_tool("go")
        .with_context(|| format!("Go is required to manage {}", spec.id))?;
    let dir = prepare_server_dir(spec.id)?;
    let bin_dir = dir.join("bin");
    report(progress, spec.id, 10, None);
    let module = format!("{}@latest", spec.package);
    println!("GOBIN={} go install {module} ...", bin_dir.display());
    let mut cmd = Command::new(&go);
    cmd.args(["install", &module])
        .env("GOBIN", &bin_dir)
        .env("PATH", crate::coding::environment::host_path());
    crate::tool::shell::no_console_window(&mut cmd);
    let status = cmd.status().context("spawn go install")?;
    if !status.success() {
        bail!("go install {module} failed (status {status})");
    }
    report(progress, spec.id, 90, None);
    let bin_rel = format!("bin/{}", exe_name(spec.binary));
    let bin_path = dir.join(&bin_rel);
    if !bin_path.exists() {
        bail!(
            "go install succeeded but {} not found at {}",
            spec.binary,
            bin_path.display()
        );
    }
    ensure_executable(&bin_path)?;
    write_manifest(spec, "latest", "go", &bin_rel)?;
    println!("installed {} → {}", spec.id, bin_path.display());
    Ok(())
}

#[cfg(windows)]
fn exe_name(name: &str) -> String {
    if name.ends_with(".exe") || name.ends_with(".cmd") {
        name.to_string()
    } else {
        format!("{name}.exe")
    }
}

#[cfg(not(windows))]
fn exe_name(name: &str) -> String {
    name.to_string()
}

/// Print a human-readable status table to stdout. Returns process exit code.
pub fn print_status() -> i32 {
    let rows = resolve::status_all();
    let mut any_missing = false;
    println!("{:<22} {:<10} {:<10} PATH", "ID", "SOURCE", "VERSION");
    println!("{}", "-".repeat(78));
    for r in &rows {
        if r.source == resolve::Source::Missing {
            any_missing = true;
        }
        println!(
            "{:<22} {:<10} {:<10} {}",
            r.id,
            r.source.as_str(),
            r.version.as_deref().unwrap_or("-"),
            r.path.as_deref().unwrap_or("-")
        );
    }
    if any_missing {
        println!();
        println!("tip: koma lsp install <id> | koma lsp install --all");
        println!("     (or install.sh --with-lsp)");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_support_covers_core_catalog() {
        for id in [
            "rust-analyzer",
            "taplo",
            "clangd",
            "vtsls",
            "basedpyright",
            "gopls",
            "vscode-langservers",
            "bash-language-server",
            "intelephense",
        ] {
            let spec = catalog::find(id).expect(id);
            assert!(managed_install_supported(spec), "{id}");
        }
    }

    #[test]
    fn npm_binary_names_include_js_shim() {
        let names = npm_binary_names("vtsls", false);
        assert!(names.iter().any(|n| n == "vtsls"));
        assert!(names.iter().any(|n| n == "vtsls.js"));
    }

    #[test]
    fn windows_npm_layout_picks_the_cmd_shim() {
        // `npm install -g --prefix <dir>` on Windows: shims in the prefix root,
        // payload (with a `.js` bin and an extensionless sh shim) elsewhere.
        let tmp = tempfile_dir("koma-lsp-npm-win");
        let pkg_bin = tmp
            .join("node_modules")
            .join("@vtsls")
            .join("language-server")
            .join("bin");
        std::fs::create_dir_all(&pkg_bin).unwrap();
        std::fs::write(pkg_bin.join("vtsls.js"), b"#!/usr/bin/env node\n").unwrap();
        std::fs::write(tmp.join("vtsls"), b"#!/bin/sh\n").unwrap();
        std::fs::write(tmp.join("vtsls.cmd"), b"@node\r\n").unwrap();
        std::fs::write(tmp.join("vtsls.ps1"), b"node\r\n").unwrap();
        let found = find_npm_binary_for(&tmp, "vtsls", true).expect("cmd shim");
        assert_eq!(found, tmp.join("vtsls.cmd"));
        std::fs::remove_file(tmp.join("vtsls.cmd")).unwrap();
        assert!(find_npm_binary_for(&tmp, "vtsls", true).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn find_npm_binary_prefers_bin_then_node_modules() {
        let tmp = tempfile_dir("koma-lsp-npm-bin");
        let bin_dir = tmp.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let target = bin_dir.join("vtsls");
        std::fs::write(&target, b"#!/bin/sh\n").unwrap();
        let found = find_npm_binary(&tmp, "vtsls").expect("found");
        assert_eq!(found, target);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn find_npm_binary_falls_back_to_js() {
        let tmp = tempfile_dir("koma-lsp-npm-js");
        let bin_dir = tmp.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let target = bin_dir.join("vtsls.js");
        std::fs::write(&target, b"#!/usr/bin/env node\n").unwrap();
        let found = find_npm_binary(&tmp, "vtsls").expect("found js");
        assert_eq!(found, target);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn find_npm_binary_follows_global_layout() {
        // Mirrors `npm install -g --prefix <dir>`:
        //   bin/vtsls -> ../lib/node_modules/@vtsls/language-server/bin/vtsls.js
        let tmp = tempfile_dir("koma-lsp-npm-global");
        let pkg_bin = tmp
            .join("lib")
            .join("node_modules")
            .join("@vtsls")
            .join("language-server")
            .join("bin");
        std::fs::create_dir_all(&pkg_bin).unwrap();
        let real = pkg_bin.join("vtsls.js");
        std::fs::write(&real, b"#!/usr/bin/env node\n").unwrap();
        let bin_dir = tmp.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let shim = bin_dir.join("vtsls");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &shim).unwrap();
        #[cfg(not(unix))]
        std::fs::write(&shim, b"@node \"%~dp0\\..\\lib\\node_modules\\@vtsls\\language-server\\bin\\vtsls.js\" %*\r\n").unwrap();
        let found = find_npm_binary(&tmp, "vtsls").expect("found global shim");
        assert!(found.ends_with("vtsls") || found.ends_with("vtsls.js"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn find_npm_binary_finds_vscode_json_under_lib() {
        // No bin/ shim — only the package payload (degraded layout).
        let tmp = tempfile_dir("koma-lsp-npm-vls-lib");
        let pkg_bin = tmp
            .join("lib")
            .join("node_modules")
            .join("vscode-langservers-extracted")
            .join("bin");
        std::fs::create_dir_all(&pkg_bin).unwrap();
        let real = pkg_bin.join("vscode-json-language-server");
        std::fs::write(&real, b"#!/usr/bin/env node\n").unwrap();
        let found = find_npm_binary(&tmp, "vscode-json-language-server").expect("found under lib");
        assert_eq!(found, real);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn tempfile_dir(prefix: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "{prefix}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn additional_language_servers_have_managed_installers() {
        for id in ["lua-language-server", "zls", "phpactor"] {
            let spec = catalog::find(id).expect(id);
            assert!(managed_install_supported(spec), "{id}");
        }
    }
}
