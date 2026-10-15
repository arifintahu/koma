"""Real socket settings activation/confirmation/reopen regression. Uses isolated KOMA_TEST_DATA_DIR.
Build first: cargo build -p agent; python3 src-term/scripts/verify-daemon.py
"""
from pathlib import Path
import json, os, socket, struct, subprocess, tempfile, time, uuid
root=Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='koma-menu-',dir='/private/tmp') as directory:
    data=Path(directory)
    (data/'config.json').write_text(json.dumps({"providers":[{"uuid":"seed-provider","name":"Offline test provider","endpoint":"http://127.0.0.1:9/v1","api_key":"test"}],"models":[{"uuid":"seed-model","name":"Offline model","model_id":"offline","provider_uuid":"seed-provider","roles":["main"]}]}))
    session=str(uuid.uuid4())
    env=dict(os.environ, KOMA_TEST_DATA_DIR=directory)
    log=(data/'daemon.log').open('w+')
    child=subprocess.Popen([str(root/'target/debug/koma'),'--daemon','--session',session],cwd=root,env=env,stdout=log,stderr=log)
    sock=socket.socket(socket.AF_UNIX)
    sock.settimeout(10)
    try:
        deadline=time.monotonic()+15
        while True:
            try: sock.connect(str(data/'run'/f'{session}.sock'));break
            except (FileNotFoundError,ConnectionRefusedError):
                if time.monotonic()>deadline: log.seek(0);raise RuntimeError(log.read())
                time.sleep(.05)
        def send(request):
            payload=json.dumps(request).encode();sock.sendall(struct.pack('!I',len(payload))+payload)
        def exact(n):
            out=b''
            while len(out)<n:
                chunk=sock.recv(n-len(out))
                if not chunk: raise RuntimeError('Daemon closed the socket')
                out+=chunk
            return out
        def event():return json.loads(exact(struct.unpack('!I',exact(4))[0]))['event']
        def until(name):
            while True:
                e=event()
                if isinstance(e,dict) and name in e:return e[name]
        def snapshot():send('Resync');return until('Snapshot')
        def menu(action, mode='Settings', error=False):
            request=str(uuid.uuid4());send({'Menu':{'request_id':request,'mode':mode,'action':action}})
            while True:
                result=until('MenuResult')
                if result['request_id']==request:break
            assert bool(result['error'])==error,result
            return until('Snapshot'), result['error']
        def key(code):return {'Key':{'code':code,'mods':0}}
        def open_settings():
            send({'ReplaceInput':{'text':'/settings','cursor':9}});send({'SendKey':{'code':'Enter','mods':0}})
            snap=snapshot()
            assert 'Settings' in snap['global']['mode'],snap['global']['mode']
            return snap['global']['mode']['Settings']
        send({'Attach':{'foreground_id':None,'cwd':str(root)}});boot=until('Snapshot')
        warm_deadline=time.monotonic()+20
        while isinstance(boot['global']['mode'],dict) and 'Loading' in boot['global']['mode']:
            assert time.monotonic()<warm_deadline,'Warmup did not complete'
            time.sleep(.1);boot=snapshot()
        send('GetMenuCapabilities');assert until('MenuCapabilities')['version']==1
        original=open_settings()
        def general(index):
            menu({'Select':{'group':'general','index':index}})
            return menu(key('Enter'))[0]['global']['mode']['Settings']
        def reopen():
            snap,_=menu(key('Esc'));assert snap['global']['mode']=='Chat'
            return open_settings()
        # Confirming text persists without leaving settings or pressing Save.
        general(0)
        menu({'Replace':{'field':'name','value':'socket verified session'}})
        snap,_=menu(key('Enter'));assert snap['global']['mode']['Settings']['name']=='socket verified session'
        assert reopen()['name']=='socket verified session'
        for index,field,value in [(11,'Max turns','321'),(12,'Max out tokens','8192')]:
            general(index);menu({'Replace':{'field':field,'value':value}});menu(key('Enter'))
        saved=reopen();assert saved['subagent_max_turns']==321 and saved['max_output_tokens']==8192
        # Escape cancels just the current text edit; committed settings survive.
        general(0);menu({'Replace':{'field':'name','value':'cancelled session'}});menu(key('Esc'))
        assert reopen()['name']=='socket verified session'
        general(11);menu({'Replace':{'field':'Max turns','value':'999'}});menu(key('Esc'))
        assert reopen()['subagent_max_turns']==321
        for index,field in [(2,'awareness_enabled'),(3,'classifier_enabled'),(5,'short_send_enabled'),(6,'bash_saving'),(7,'coding_autosave'),(8,'internet_mode'),(10,'mouse_capture')]:
            before= snapshot()['global']['mode']['Settings'][field]
            activated=general(index)
            assert activated[field]!=before,(field,activated[field],before)
            assert reopen()[field]==activated[field]
        # Moving the theme cursor never applies or writes it. Enter does both.
        current=snapshot()['global']['mode']['Settings']['palette']
        candidate=2 if current!='forest' else 1
        config_before=(data/'config.json').read_text()
        snap,_=menu({'Select':{'group':'appearance','index':candidate}})
        assert snap['global']['palette']==current
        assert (data/'config.json').read_text()==config_before
        assert reopen()['palette']==current
        menu({'Select':{'group':'appearance','index':candidate}})
        snap,_=menu(key('Enter'));applied=snap['global']['mode']['Settings']['palette']
        assert snap['global']['palette']==applied and applied!=current
        assert json.loads((data/'config.json').read_text())['palette']==applied
        assert reopen()['palette']==applied
        # A stale identity must fail and retain the draft.
        menu({'Select':{'group':'page','index':1}})
        menu(key({'Char':'a'}))
        menu({'Replace':{'field':'name','value':'Socket provider'}})
        menu({'Replace':{'field':'endpoint','value':'https://example.invalid/v1'}})
        menu({'Replace':{'field':'api_key','value':'test-credential'}})
        menu({'Select':{'group':'active','index':3}});menu(key('Enter'));menu(key('Esc'))
        providers=open_settings()['providers'];provider=next(p for p in providers if p['name']=='Socket provider')
        menu({'Select':{'group':'page','index':1}})
        menu({'Select':{'group':'active','index':providers.index(provider),'id':'stale-provider'}},error=True)
        menu({'Select':{'group':'active','index':providers.index(provider),'id':provider['uuid']}})
        menu(key('Enter'))
        menu({'Replace':{'field':'name','value':'Renamed provider'}})
        menu({'Replace':{'field':'api_key','value':''}})
        menu({'Select':{'group':'active','index':3}});menu(key('Enter'));menu(key('Esc'))
        provider2=next(p for p in open_settings()['providers'] if p['name']=='Renamed provider')
        assert provider2['uuid']==provider['uuid'];assert provider2['api_key']=='test-credential'
        menu(key('Esc'))
        # Concurrent catalogue changes refresh saved data without replacing drafts.
        open_settings();general(0);menu({'Replace':{'field':'name','value':'concurrent draft'}})
        send({'SetProvider':{'uuid':None,'name':'Other client','endpoint':'https://other.invalid/v1','api_key':'other'}})
        send('ReloadGlobalCatalogue');concurrent=snapshot()['global']['mode']['Settings']
        assert concurrent['name']=='concurrent draft' and concurrent['editing']
        menu(key('Esc'))
        menu(key('Esc'))
        assert any(p['name']=='Other client' for p in open_settings()['providers']);menu(key('Esc'))
        def open_command(command, expected):
            send({'ReplaceInput':{'text':command,'cursor':len(command)}});send({'SendKey':{'code':'Enter','mods':0}})
            snap=snapshot();assert expected in snap['global']['mode'];return snap['global']['mode'][expected]
        # Actual disabled-server CRUD never starts an external process.
        open_command('/mcp','Mcp');menu(key({'Char':'n'}),'Mcp');menu('Save','Mcp',error=True)
        menu({'Replace':{'field':'name','value':'Socket MCP'}},'Mcp')
        menu({'Replace':{'field':'command','value':'not-executed'}},'Mcp')
        menu({'Select':{'group':'active','index':1}},'Mcp');menu(key({'Char':' '}),'Mcp')
        snap,_=menu('Save','Mcp');server=next(s for s in snap['global']['mode']['Mcp']['servers'] if s['name']=='Socket MCP');assert not server['enabled']
        menu({'Select':{'group':'active','index':0,'id':server['uuid']}},'Mcp');menu(key('Enter'),'Mcp')
        menu({'Replace':{'field':'name','value':'Renamed MCP'}},'Mcp');snap,_=menu('Save','Mcp');assert snap['global']['mode']['Mcp']['servers'][0]['name']=='Renamed MCP'
        menu(key({'Char':'d'}),'Mcp');menu(key('Esc'),'Mcp');menu(key({'Char':'d'}),'Mcp');snap,_=menu(key({'Char':'y'}),'Mcp');assert not snap['global']['mode']['Mcp']['servers']
        menu(key('Esc'),'Mcp')
        # Agent create/edit/delete uses the real session-scoped markdown files.
        open_command('/agents','Agents');menu(key({'Char':'n'}),'Agents');menu('Save','Agents',error=True)
        menu({'Replace':{'field':'name','value':'socket-agent'}},'Agents');menu({'Replace':{'field':'description','value':'Socket test agent'}},'Agents')
        menu({'Replace':{'field':'prompt','value':'Complete prompt\n'+'long content '*200}},'Agents');snap,_=menu('Save','Agents')
        agents=snap['global']['mode']['Agents']['agents'];idx=next(i for i,a in enumerate(agents) if a['name']=='socket-agent');agent=agents[idx]
        assert len(agent['prompt'])>2000 and agent['source']=='session'
        menu({'Select':{'group':'active','index':idx,'id':'socket-agent'}},'Agents');menu(key('Enter'),'Agents')
        menu({'Replace':{'field':'description','value':'Edited agent'}},'Agents');snap,_=menu('Save','Agents');assert any(a['description']=='Edited agent' for a in snap['global']['mode']['Agents']['agents'])
        menu(key({'Char':'d'}),'Agents');menu(key('Esc'),'Agents');menu(key({'Char':'d'}),'Agents');snap,_=menu(key({'Char':'y'}),'Agents');assert not any(a['name']=='socket-agent' for a in snap['global']['mode']['Agents']['agents'])
        menu(key('Esc'),'Agents')
        # Help activation goes through the authoritative command registry.
        help=open_command('/help','Help');idx=next(i for i,source in enumerate(help['filtered_idx']) if help['all'][source]['key']=='/settings')
        menu({'Select':{'group':'active','index':idx}},'Help');snap,_=menu(key('Enter'),'Help');assert 'Settings' in snap['global']['mode'];menu(key('Esc'))
        print('PASS: real daemon immediate settings persistence, reopen, cancelled text, theme activation/highlight, provider identity/secrets, existing MCP/agent forms and help')
    finally:
        try:send('QuitDaemon')
        except Exception:pass
        sock.close()
        try:child.wait(timeout=5)
        except subprocess.TimeoutExpired:child.terminate();child.wait(timeout=5)
        log.close()
