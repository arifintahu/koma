"""Real framed reader + daemon capability integration, with isolated ledgers.
Build: cargo build -p agent; python3 src-term/scripts/verify-usage.py
"""
from pathlib import Path
import json, os, select, socket, sqlite3, struct, subprocess, tempfile, time, uuid
root = Path(__file__).resolve().parents[2]
binary = root / 'target/debug/koma'

def send(pipe, value):
    payload = json.dumps(value).encode()
    pipe.write(struct.pack('!I', len(payload)) + payload)
    pipe.flush()

def receive(pipe):
    def exact(n):
        data = b''
        while len(data) < n:
            assert select.select([pipe], [], [], 10)[0], 'frame timeout'
            chunk = os.read(pipe.fileno(), n - len(data))
            assert chunk, 'unexpected EOF'
            data += chunk
        return data
    return json.loads(exact(struct.unpack('!I', exact(4))[0]))

with tempfile.TemporaryDirectory(prefix='koma-usage-', dir='/private/tmp') as directory:
    data = Path(directory)
    env = dict(os.environ, KOMA_TEST_DATA_DIR=directory)
    req = dict(version=1, request_id=1, scope='global', range='today', session_uuid=str(uuid.uuid4()))
    reader = subprocess.Popen([str(binary), 'remote-usage'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    daemon = None
    try:
        send(reader.stdin, req)
        result = receive(reader.stdout)
        assert result['missing'] and result['error'] and result['data'] is None, result
        assert not list(data.iterdir()), list(data.iterdir())
        (data / 'usage.sqlite').write_bytes(b'broken sqlite')
        send(reader.stdin, dict(req, request_id=2))
        result = receive(reader.stdout)
        assert not result['missing'] and result['error'], result
        (data / 'usage.sqlite').unlink()
        conn = sqlite3.connect(data / 'usage.sqlite')
        conn.execute('CREATE TABLE usage(id INTEGER PRIMARY KEY,ts INTEGER,model_id TEXT,role TEXT,session_uuid TEXT,pwd_hash TEXT,tokens_in INTEGER,tokens_cached INTEGER,tokens_out INTEGER,cost REAL)')
        for i in range(12):
            conn.execute('INSERT INTO usage(ts,model_id,role,session_uuid,tokens_in,tokens_cached,tokens_out,cost) VALUES(?,?,?,?,10,3,2,0.5)', (int(time.time()), f'model-{i}', 'main', req['session_uuid']))
        conn.commit()
        before = (data / 'usage.sqlite').read_bytes()
        send(reader.stdin, dict(req, request_id=3))
        result = receive(reader.stdout)
        assert result['request_id'] == 3 and len(result['data']['top_models']) == 12, result
        assert result['data']['totals']['calls'] == 12
        assert before == (data / 'usage.sqlite').read_bytes()
        conn.execute('INSERT INTO usage(ts,model_id,role,session_uuid,tokens_in,tokens_cached,tokens_out,cost) VALUES(?,?,?,?,20,3,4,1.0)', (int(time.time()), 'later', 'planner', req['session_uuid']))
        conn.commit()
        send(reader.stdin, dict(req, request_id=4, scope='session'))
        result = receive(reader.stdout)
        assert result['data']['session_calls'] == 13
        assert result['data']['totals']['cost'] == 7
        conn.close()
        reader.stdin.close()
        assert reader.wait(timeout=5) == 0
        # Two simultaneous clients: the older peer continues receiving full ledger data.
        (data / 'config.json').write_text(json.dumps({'providers': [{'uuid': 'offline', 'name': 'Offline', 'endpoint': 'http://127.0.0.1:9/v1', 'api_key': 'test'}], 'models': [{'uuid': 'model', 'name': 'Offline', 'model_id': 'offline', 'provider_uuid': 'offline', 'roles': ['main']}]}))
        log = (data / 'daemon.log').open('w+')
        sid = req['session_uuid']
        daemon = subprocess.Popen([str(binary), '--daemon', '--session', sid], cwd=root, env=env, stdout=log, stderr=log)
        def connect():
            sock = socket.socket(socket.AF_UNIX); sock.settimeout(10)
            deadline = time.monotonic() + 20
            while True:
                try: sock.connect(str(data / 'run' / f'{sid}.sock')); break
                except (FileNotFoundError, ConnectionRefusedError):

                    if daemon.poll() is not None or time.monotonic() >= deadline:
                        log.seek(0); raise RuntimeError(log.read())
                    time.sleep(.05)
            return sock.makefile('rwb', buffering=0)
        def until(pipe, name):
            while True:
                event = receive(pipe)['event']
                if isinstance(event, dict) and name in event: return event[name]
        def snapshot(pipe):
            send(pipe, 'Resync'); return until(pipe, 'Snapshot')
        new = connect(); old = connect()
        for client in (new, old):
            send(client, {'Attach': {'foreground_id': None, 'cwd': None}})
            boot = until(client, 'Snapshot')
            deadline = time.monotonic() + 20
            while isinstance(boot['global']['mode'], dict) and 'Loading' in boot['global']['mode']:
                assert time.monotonic() < deadline
                time.sleep(.05); boot = snapshot(client)
        send(new, 'GetMenuCapabilities'); assert until(new, 'MenuCapabilities')['usage_reader']
        send(new, {'SetUsageReader': {'enabled': True}})
        for client in (new, old):
            send(client, {'ReplaceInput': {'text': '/usage', 'cursor': 6}})
            send(client, {'SendKey': {'code': 'Enter', 'mods': 0}})
        assert snapshot(new)['global']['mode']['Usage']['data']['top_models'] == []
        assert len(snapshot(old)['global']['mode']['Usage']['data']['top_models']) == 13
        send(new, {'SendKey': {'code': {'Char': '3'}, 'mods': 0}})
        assert snapshot(new)['global']['mode']['Usage']['range'] == 'year'
        send(new, {'SendKey': {'code': 'Esc', 'mods': 0}})
        assert snapshot(new)['global']['mode'] == 'Chat'
        send(new, 'QuitDaemon'); daemon.wait(timeout=5)
        new.close(); old.close(); log.close()
        print('PASS: framed reader read-only/missing/corrupt/concurrent updates/EOF; per-client independent capability, old-peer fallback, range and Esc')
    finally:
        if reader.poll() is None: reader.terminate(); reader.wait(timeout=5)
        if daemon is not None and daemon.poll() is None: daemon.terminate(); daemon.wait(timeout=5)
