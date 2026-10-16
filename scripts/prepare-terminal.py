#!/usr/bin/env python3
"""Prepare or validate the complete, target-specific offline terminal payload."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = '1.4.3'
# Published SHASUMS256.txt from oven-sh/bun, bun-v1.4.3.
TARGETS = {
    'x86_64-unknown-linux-gnu': ('linux', 'x64', 'bun-linux-x64-baseline', '1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b'),
    'aarch64-unknown-linux-gnu': ('linux', 'arm64', 'bun-linux-aarch64', 'efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21'),
    'x86_64-apple-darwin': ('darwin', 'x64', 'bun-darwin-x64-baseline', '0fde04e8b092156b97fe6432e899baf16d9ed6ce52cbb4218d2d9c07a2f827ef'),
    'aarch64-apple-darwin': ('darwin', 'arm64', 'bun-darwin-aarch64', '80afd4c069b46a6fa8f3ec520bebc750a7843e4a8d5b9583d29ad436c00a3403'),
    'x86_64-pc-windows-msvc': ('win32', 'x64', 'bun-windows-x64-baseline', 'd7a7d3eb216614544aab0cde2d8d9f2e4e87839bf5a30a1cd11d077f02d84e0c'),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inputs():
    paths = [ROOT / 'scripts/prepare-terminal.py']
    for name in ['src', 'assets']:
        paths.extend(p for p in (ROOT / 'src-term' / name).rglob('*') if p.is_file())
    paths.extend(ROOT / 'src-term' / name for name in ['package.json', 'bun.lock', 'tsconfig.json'])
    return {p.relative_to(ROOT).as_posix(): digest(p) for p in sorted(paths)}


def host_target():
    os_name = {'Linux': 'unknown-linux-gnu', 'Darwin': 'apple-darwin', 'Windows': 'pc-windows-msvc'}[platform.system()]
    arch = {'AMD64': 'x86_64', 'arm64': 'aarch64'}.get(platform.machine(), platform.machine())
    return f'{arch}-{os_name}'


def download_bun(target, cache):
    _, _, asset, checksum = TARGETS[target]
    archive = cache / f'{asset}-{VERSION}.zip'
    if not archive.exists() or digest(archive) != checksum:
        url = f'https://github.com/oven-sh/bun/releases/download/bun-v{VERSION}/{asset}.zip'
        with urllib.request.urlopen(url, timeout=120) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != checksum:
            raise ValueError(f'Bun checksum mismatch: {url}')
        archive.write_bytes(data)
    return archive


def unpack_bun(archive, destination, target):
    filename = 'bun.exe' if TARGETS[target][0] == 'win32' else 'bun'
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        data = z.read(next(n for n in z.namelist() if n.endswith('/' + filename)))
    exe = destination / filename
    exe.write_bytes(data)
    exe.chmod(0o755)
    return exe


def check(target):
    dest = ROOT / 'target/terminal' / target
    manifest = json.loads((dest / 'manifest.json').read_text())
    require(manifest['target'] == target, 'wrong target')
    require(manifest['inputs'] == inputs(), 'stale terminal inputs')
    require(manifest['bun_version'] == VERSION, 'wrong Bun version')
    require(manifest['archive_sha256'] == digest(dest / 'payload.zip'), 'corrupt payload archive')
    return dest


def prepare(target):
    cache = ROOT / 'target/terminal/downloads'
    cache.mkdir(parents=True, exist_ok=True)
    host = host_target()
    host_archive = download_bun(host, cache)
    target_archive = download_bun(target, cache)
    dest = ROOT / 'target/terminal' / target
    with tempfile.TemporaryDirectory(prefix='prepare-', dir=cache.parent) as temporary:
        tmp = Path(temporary)
        bun = unpack_bun(host_archive, tmp / 'host', host)
        require(subprocess.check_output([str(bun), '--version'], text=True).strip() == VERSION, 'wrong preparation runtime')
        stage = tmp / 'payload'
        stage.mkdir()
        for name in ['src', 'assets']:
            shutil.copytree(ROOT / 'src-term' / name, stage / name)
        for name in ['package.json', 'bun.lock', 'tsconfig.json']:
            shutil.copy2(ROOT / 'src-term' / name, stage / name)
        os_name, arch, _, checksum = TARGETS[target]
        subprocess.run([str(bun), 'install', '--production', '--frozen-lockfile', '--ignore-scripts',
                        '--linker=hoisted', f'--os={os_name}', f'--cpu={arch}'], cwd=stage, check=True)
        unpack_bun(target_archive, stage / 'runtime', target)
        native = stage / f'node_modules/@opentui/core-{os_name}-{arch}'
        require(native.is_dir(), f'missing target native library: {native}')
        require((stage / 'node_modules/@opentui/core/parser.worker.js').is_file(), 'missing parser worker')
        require(list((stage / 'node_modules/web-tree-sitter').rglob('*.wasm')), 'missing tree-sitter runtime')
        files = {p.relative_to(stage).as_posix(): {'sha256': digest(p), 'executable': bool(p.stat().st_mode & 0o111)}
                 for p in sorted(stage.rglob('*')) if p.is_file()}
        versions = {p.parent.relative_to(stage / 'node_modules').as_posix(): json.loads(p.read_text()).get('version')
                    for p in sorted((stage / 'node_modules').rglob('package.json'))}
        archive = tmp / 'payload.zip'
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for name in files:
                info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (0o100755 if files[name]['executable'] else 0o100644) << 16
                z.writestr(info, (stage / name).read_bytes())
        manifest = {'schema': 1, 'target': target, 'bun_version': VERSION, 'bun_archive_sha256': checksum,
                    'dependencies': versions, 'inputs': inputs(), 'files': files, 'archive_sha256': digest(archive)}
        dest.mkdir(parents=True, exist_ok=True)
        os.replace(archive, dest / 'payload.zip')
        (dest / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    check(target)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', default=host_target(), choices=TARGETS)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        if args.check:
            print(check(args.target))
        else:
            prepare(args.target)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.CalledProcessError, StopIteration) as error:
        parser.exit(1, f'Terminal payload: {error}\nRun: python3 scripts/prepare-terminal.py --target {args.target}\n')
