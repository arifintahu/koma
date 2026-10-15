"""Headless helper integration against an instrumented SSH executable and real
local daemon. Exercises SSH lifecycle without an external account or network.
Build first: cargo build -p agent; python3 src-term/scripts/verify-remote.py
"""
from pathlib import Path
import json, os, select, struct, subprocess, tempfile, time
root=Path(__file__).resolve().parents[2]
binary=root/'target/debug/koma'
with tempfile.TemporaryDirectory(prefix='koma-ssh-',dir='/private/tmp') as directory:
    data=Path(directory);bin_dir=data/'bin';bin_dir.mkdir()
    (data/'config.json').write_text(json.dumps({"providers":[{"uuid":"offline","name":"Offline","endpoint":"http://127.0.0.1:9/v1","api_key":"test"}],"models":[{"uuid":"model","name":"Offline","model_id":"offline","provider_uuid":"offline","roles":["main"]}]}))
    ssh=bin_dir/'ssh'
    ssh.write_text('''#!/usr/bin/env python3
import os,sys,json,subprocess,shlex
from pathlib import Path
base=Path(os.environ['KOMA_TEST_DATA_DIR'])
args=sys.argv[1:]
(base/'ssh-argv.jsonl').open('a').write(json.dumps(args)+'\\n')
if 'KEY_AUTH_OK' in ' '.join(args):sys.exit(1)
ask=os.environ.get('SSH_ASKPASS')
if not ask or subprocess.check_output([ask,'Password:']).decode().strip()!='test-secret':
    print('Authentication failed',file=sys.stderr);sys.exit(1)
command=args[-1]
koma=os.environ['KOMA_TEST_BINARY']
if command.startswith('for p in '): print(koma,end='');sys.exit(0)
if 'install.sh' in command:(base/'installed').touch();sys.exit(0)
if '--version' in command:
    if not (base/'installed').exists():print('koma 0.0.0');sys.exit(0)
    os.execv(koma,[koma,'--version'])
if command.startswith('test -d '):print('/workspace\\n/workspace/project');sys.exit(0)
argv=shlex.split(command)
if argv[0]=='bash':argv=shlex.split(argv[2].rsplit('; exec ',1)[1])
if argv[0]==koma:
    if 'server' in argv:
        (base/'bridge-command').write_text(json.dumps(argv));(base/'bridge-pid').write_text(str(os.getpid()))
    os.execv(koma,argv)
print('Unsupported SSH test command',file=sys.stderr);sys.exit(2)
''');ssh.chmod(0o700)
    env=dict(os.environ,KOMA_TEST_DATA_DIR=directory,KOMA_TEST_BINARY=str(binary),PATH=str(bin_dir)+os.pathsep+os.environ['PATH'])
    log=(data/'helper.log').open('w+')
    child=subprocess.Popen([str(binary),'term-remote','--target','test@example.invalid'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,env=env,start_new_session=True)
    def send(command):
        body=json.dumps(command).encode();child.stdin.write(struct.pack('!I',len(body))+body);child.stdin.flush()
    def exact(n):
        out=b'';deadline=time.monotonic()+30
        while len(out)<n:
            if not select.select([child.stdout],[],[],max(0,deadline-time.monotonic()))[0]:raise RuntimeError('Helper frame timeout')
            chunk=os.read(child.stdout.fileno(),n-len(out))
            if not chunk:log.seek(0);raise RuntimeError(log.read())
            out+=chunk
        return out
    def event():
        e=json.loads(exact(struct.unpack('!I',exact(4))[0]))
        if os.environ.get('KOMA_REMOTE_TEST_DEBUG') and not (isinstance(e,dict) and 'Daemon' in e):print(e,flush=True)
        return e
    stages=[]
    def until(name):
        while True:
            e=event()
            if isinstance(e,dict) and 'Progress' in e:stages.append(e['Progress']['stage'])
            if isinstance(e,dict) and name in e:return e[name]
            if isinstance(e,dict) and ('Error' in e or 'AuthRequired' in e) and name!='AuthRequired':raise RuntimeError(e)
    def daemon_until(name):
        while True:
            d=until('Daemon')['event']
            if isinstance(d,dict) and name in d:return d[name]
    ids=[]
    try:
        until('AuthRequired')
        send({'Password':{'value':'wrong'}});assert until('AuthRequired')['error']
        send({'Password':{'value':'test-secret'}});until('Sessions')
        assert {'Checking','Installing','Verifying','Ready'}.issubset(set(stages)),stages
        send({'Directories':{'path':'/'}});assert '/workspace' in until('Directories')['entries']
        send({'Open':{'session_id':None,'cwd':str(root)}});sid=until('Connected')['session_id'];ids.append(sid)
        send({'Frame':{'Attach':{'foreground_id':None,'cwd':None}}});snap=daemon_until('Snapshot')
        assert snap['sessions'][0]['id']==sid
        send({'Frame':'GetMenuCapabilities'});assert daemon_until('MenuCapabilities')['version']==1
        # Real streamed snapshot updates over the same bridge.
        send({'Frame':{'ReplaceInputTracked':{'request_id':'remote-draft','text':'remote draft','cursor':12}}})
        assert daemon_until('MenuResult')['request_id']=='remote-draft'
        send({'Frame':'Resync'});assert daemon_until('Snapshot')['global']['input']=='remote draft'
        send('Disconnect')
        while event()!='Disconnected':pass
        send('Sessions');listed=until('Sessions');assert any(s['session_id']==sid for s in listed['live'])
        # Re-attach retains the daemon and draft.
        send({'Open':{'session_id':sid,'cwd':None}});until('Connected')
        send({'Frame':{'Attach':{'foreground_id':None,'cwd':None}}});assert daemon_until('Snapshot')['global']['input']=='remote draft'
        # Drop the bridge process to exercise loss reporting; the daemon survives.
        os.kill(int((data/'bridge-pid').read_text()),15)
        assert 'connection lost' in until('Error')['message']
        send('Sessions');assert any(s['session_id']==sid for s in until('Sessions')['live'])
        argv=(data/'ssh-argv.jsonl').read_text();assert 'test-secret' not in argv;assert 'wrong' not in argv
        send('Cancel');child.wait(timeout=5)
        print('PASS: helper auth retry, bootstrap install/verify/progress, directory/session discovery, real daemon frame updates, detach/reconnect, credentials absent from argv')
    finally:
        if child.poll() is None:child.terminate();child.wait(timeout=5)
        for sid in ids:subprocess.run([str(binary),'daemon','kill','--session',sid],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        log.close()
