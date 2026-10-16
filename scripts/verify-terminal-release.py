#!/usr/bin/env python3
"""Exercise a copied release outside the checkout with OS-enforced offline access."""
import argparse
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--inside-network-namespace', action='store_true')
    args = parser.parse_args()
    binary = args.binary.resolve()
    system = platform.system()
    if system == 'Linux' and not args.inside_network_namespace:
        # A new network namespace has no external interfaces or routes.
        subprocess.run(['sudo', '-n', 'unshare', '--net', sys.executable, str(Path(__file__).resolve()),
                        str(binary), '--inside-network-namespace'], check=True)
        return
    with tempfile.TemporaryDirectory(prefix='koma test ', dir=None if system == 'Windows' else '/tmp') as temporary:
        root = Path(temporary)
        copied = root / binary.name
        shutil.copy2(binary, copied)
        copied.chmod(0o755)
        home = root / 'user data'
        home.mkdir()
        empty_path = root / 'empty path'
        empty_path.mkdir()
        env = {k: v for k, v in os.environ.items() if not k.startswith(('KOMA_', 'BUN_', 'OTUI_'))}
        env.update(HOME=str(home), USERPROFILE=str(home), LOCALAPPDATA=str(home),
                   XDG_DATA_HOME=str(home), PATH=str(empty_path), TERM='xterm-256color', NO_COLOR='1')
        data = home / ('koma' if system == 'Windows' else '.koma')
        data.mkdir()
        (data / 'config.json').write_text(json.dumps({
            'palette': 'dark',
            'providers': [{'uuid': 'offline', 'name': 'Offline fixture',
                           'endpoint': 'http://127.0.0.1:9/v1', 'api_key': 'fixture-key'}],
            'models': [{'uuid': 'offline-model', 'name': 'Offline model', 'model_id': 'offline',
                        'provider_uuid': 'offline', 'roles': ['main']}],
        }))
        wrapper = []
        firewall = 'KomaOfflineReleaseVerification'
        if system == 'Darwin':
            wrapper = ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network-outbound (remote ip "*:*"))']
        if system == 'Windows':
            subprocess.run(['powershell', '-NoProfile', '-Command',
                            f'New-NetFirewallRule -DisplayName {firewall} -Direction Outbound -Action Block -RemoteAddress Internet -ErrorAction Stop'], check=True)
        try:
            def self_test():
                subprocess.run(wrapper + [str(copied), '--terminal-self-test'], cwd=root, env=env, check=True, timeout=120)
            self_test()  # cold extraction
            self_test()  # verified cache
            payload = next((data / 'term').glob('*/.complete')).parent
            if system == 'Linux':
                for path in [copied, *payload.rglob('*')]:
                    if path.is_file():
                        content = path.read_bytes()
                        if content.startswith(b'\x7fELF'):
                            versions = [(int(a), int(b)) for a, b in re.findall(rb'GLIBC_(\d+)\.(\d+)', content)]
                            assert all(v <= (2, 35) for v in versions), f'{path}: exceeds glibc 2.35 baseline'

            (payload / 'src/index.tsx').write_text('corrupt cache')
            (payload / 'package.json').unlink()
            partial = payload.with_name(payload.name + '.partial')
            partial.mkdir()
            (partial / 'interrupted').write_text('unfinished extraction')
            self_test()
            assert not partial.exists()
            shutil.rmtree(data / 'term')
            for arguments in [[], ['agents']]:
                exercise_pty(wrapper + [str(copied)] + arguments, root, env, system)
                exercise_pty(wrapper + [str(copied)] + arguments, root, env, system)
            print('Offline copied release passed: cold/cache/repair, keyboard, resize, clean exit')
        finally:
            if system == 'Windows':
                subprocess.run(['powershell', '-NoProfile', '-Command',
                                f'Remove-NetFirewallRule -DisplayName {firewall} -ErrorAction Stop'], check=True)


def exercise_pty(command, cwd, env, system):
    if system == 'Windows':
        from winpty import PtyProcess
        import queue
        import threading
        child = PtyProcess.spawn(command, cwd=str(cwd), env=env, dimensions=(24, 100))
        pending = queue.Queue()
        def reader():
            try:
                while True:
                    pending.put(child.read(65536))
            except (EOFError, OSError):
                pass
        threading.Thread(target=reader, daemon=True).start()
        def read():
            try:
                return pending.get(timeout=.1)
            except queue.Empty:
                return ''
        send = child.write
        resize = lambda columns: child.setwinsize(18, columns)
        alive = child.isalive
        wait = lambda: child.exitstatus
        close = lambda: child.close(force=True)
    else:
        import fcntl
        import pty
        import select
        import signal
        import struct
        import termios
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
        def session():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        child = subprocess.Popen(command, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, preexec_fn=session)
        os.close(slave)
        def read():
            if not select.select([master], [], [], .1)[0]:
                return ''
            try:
                return os.read(master, 65536).decode(errors='replace')
            except OSError:
                return ''
        send = lambda text: os.write(master, text.encode())
        def resize(columns):
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 18, columns, 0, 0))
            os.kill(child.pid, signal.SIGWINCH)
        alive = lambda: child.poll() is None
        wait = lambda: child.wait(timeout=10)
        def close():
            if alive():
                child.kill()
                child.wait()
            os.close(master)
    output = ''
    try:
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline and alive():
            output += read()
            if any(word in output for word in ['[$]', 'Cooking', 'Welcome to Koma']):
                break
        assert alive(), f'early terminal exit: {output[-4000:]}'
        assert any(word in output for word in ['[$]', 'Cooking', 'Welcome to Koma']), f'no interactive screen: {output[-4000:]}'
        assert '\x1b[' in output, f'no native terminal frame: {output[-4000:]}'
        resize(40)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and alive():
            output += read()
            if 'Terminal too small' in output:
                break
        assert 'Terminal too small' in output, f'resize was not forwarded: {output[-4000:]}'
        resize(80)
        restored = ''
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and alive():
            chunk = read()
            restored += chunk
            output += chunk
            if any(word in restored for word in ['[$]', 'Cooking', 'Welcome to Koma']):
                break
        assert any(word in restored for word in ['[$]', 'Cooking', 'Welcome to Koma']), 'screen did not recover after resize'
        send('\x1b[B')
        time.sleep(.5)
        send('\x03')
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and alive():
            output += read()
            if 'Do you want to quit?' in output:
                break
        if alive():
            assert 'Do you want to quit?' in output, f'quit keyboard did not reach daemon: {output[-4000:]}'
            send('k')
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and alive():
            output += read()
        assert not alive(), f'terminal did not exit: {output[:4000]} ... {output[-4000:]}'
        assert wait() == 0, f'terminal failed: {output[-4000:]}'
        while True:
            chunk = read()
            if not chunk:
                break
            output += chunk
        assert '\x1b[?1049l' in output, 'terminal did not restore alternate screen'
    finally:
        close()


if __name__ == '__main__':
    main()
