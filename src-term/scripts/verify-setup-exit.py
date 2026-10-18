"""Check first-run quit over real daemon sockets/pipes, including final reply delivery."""
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
BINARY = ROOT / 'target/debug' / ('koma.exe' if os.name == 'nt' else 'koma')


def verify(key):
    with tempfile.TemporaryDirectory(prefix='ks-', dir=None if os.name == 'nt' else '/tmp') as directory:
        session = str(uuid.uuid4())
        env = dict(os.environ, KOMA_TEST_DATA_DIR=directory)
        with open(Path(directory) / 'daemon.log', 'w+') as log:
            child = subprocess.Popen([str(BINARY), '--daemon', '--session', session],
                                     cwd=directory, env=env, stdout=log, stderr=log)
            connection = None
            try:
                deadline = time.monotonic() + 15
                while connection is None:
                    try:
                        if os.name == 'nt':
                            connection = open(r'\\.\pipe\koma-' + session, 'r+b', buffering=0)
                        else:
                            candidate = socket.socket(socket.AF_UNIX)
                            candidate.settimeout(10)
                            try:
                                candidate.connect(str(Path(directory) / 'run' / (session + '.sock')))
                            except OSError:
                                candidate.close()
                                raise
                            connection = candidate.makefile('rwb', buffering=0)
                            candidate.close()
                    except OSError:
                        if child.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            raise AssertionError('Daemon did not start: ' + log.read())
                        time.sleep(.05)

                def send(request):
                    body = json.dumps(request).encode()
                    packet = memoryview(struct.pack('!I', len(body)) + body)
                    while packet:
                        packet = packet[connection.write(packet):]

                def exact(length):
                    result = b''
                    while len(result) < length:
                        chunk = connection.read(length - len(result))
                        assert chunk, 'Daemon closed before delivering its correlated exit response'
                        result += chunk
                    return result

                def event():
                    size, = struct.unpack('!I', exact(4))
                    return json.loads(exact(size))['event']

                send({'Attach': {'foreground_id': None, 'cwd': directory}})
                while True:
                    reply = event()
                    if isinstance(reply, dict) and 'Snapshot' in reply:
                        assert 'Onboard' in reply['Snapshot']['global']['mode'], reply
                        break
                send({'Menu': {'request_id': 'exit-check', 'mode': 'Onboard',
                               'action': {'Key': key}}})
                while True:
                    reply = event()
                    if isinstance(reply, dict) and 'MenuResult' in reply:
                        assert reply['MenuResult'] == {'request_id': 'exit-check', 'error': None, 'exit': True}, reply
                        break
                send('Detach')
                assert child.wait(timeout=10) == 0, 'Daemon did not exit cleanly'
            finally:
                if connection:
                    connection.close()
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)


if __name__ == '__main__':
    if len(sys.argv) > 1:
        choices = {'esc': {'code': 'Esc', 'mods': 0},
                   'q': {'code': {'Char': 'q'}, 'mods': 0},
                   'ctrl-c': {'code': {'Char': 'c'}, 'mods': 2}}
        verify(choices[sys.argv[1]])
    else:
        for name in ['esc', 'q', 'ctrl-c']:
            subprocess.run([sys.executable, __file__, name], check=True, timeout=30)
        print('First-run Escape, q, and Ctrl+C delivered exit replies and stopped their daemons')
