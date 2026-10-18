import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, DeliveryUnknownError, TurnReplacedError, SdkError } from '../dist/index.js';
const fake = fileURLToPath(new URL('../../conformance/fake_adapter.py', import.meta.url));
const python = process.env.PYTHON ?? 'python3';
function client(scenario='normal', extra={}) { return new Client({ executable: python, adapterArgs: [fake,'--scenario',scenario], timeoutMs:1000,...extra }); }

test('probe create resume results without event consumer', async () => {
 const c=client(); try {
  assert.equal((await c.probe()).protocol,1);
  const s=await c.create({cwd:'/fake/work'});
  assert.deepEqual((await s.getState()).policy,{plan:'forbid',approval:'reject'});
  const first=await s.submit({text:'hello é雪',attachments:[{kind:'pasted_text',text:'context'}]});
  assert.equal(first.disposition,'started');
  assert.equal((await s.enqueue({text:'next'})).disposition,'queued');
  assert.equal((await s.interrupt('stale')).disposition,'rejected');
  const replaced=await s.interruptAndSubmit(first.turn_id,{text:'replacement'});
  assert.equal(replaced.interrupted_turn_id,first.turn_id);
  await s.interrupt(replaced.turn_id);
  assert.equal((await s.waitTurn(replaced.turn_id)).state,'interrupted');
  await s.detach();
  const resumed=await c.resume({session_id:'saved'});assert.equal(resumed.sessionId,'saved');
 } finally {await c.close();}
});
test('replacement partial failure retains old interrupted turn',async()=>{
 const c=client('partial');try {const s=await c.create({cwd:'/fake/work'});const first=await s.submit({text:'hello'});const r=await s.interruptAndSubmit(first.turn_id,{text:'new'});assert.equal(r.disposition,'rejected');assert.equal(r.interrupted_turn_id,first.turn_id);}finally{await c.close();}
});
test('disconnect and explicit unknown after mutation are typed',async()=>{
 for(const scenario of ['eof','unknown','bad_result']){const c=client(scenario);try{const s=await c.create({cwd:'/fake/work'});await assert.rejects(s.submit({text:'hello'}),e=>e instanceof DeliveryUnknownError&&e.sessionId===s.sessionId&&!!e.requestId);}finally{await c.close();}}
});
test('version malformed missing capability and executable errors',async()=>{
 for(const scenario of ['bad_version','missing_cap','malformed']){const c=client(scenario);try{await assert.rejects(scenario==='malformed'?c.create({cwd:'/fake/work'}):c.probe(),SdkError);}finally{await c.close();}}
 const c=new Client({executable:'/not/an/executable'});try{await assert.rejects(c.probe(),SdkError);}finally{await c.close();}
});
test('replacement-aware Unicode output and early event before result',async()=>{
 const c=client('output');try{const s=await c.create({cwd:'/fake/work'});await s.submit({text:'hello'});const it=s.events();assert.equal((await it.next()).value.event,'state');const append=(await it.next()).value;assert.equal(append.event,'output_append');assert.equal(append.text,'é雪');await it.return();assert.equal((await s.getState()).streaming,'é雪');}finally{await c.close();}
});
test('external approvals use actual pending call id',async()=>{
 const c=client('approval');try{const s=await c.create({cwd:'/fake/work',external_approvals:true,policy:{plan:'forbid',approval:'default'}});await s.submit({text:'hello'});const a=(await s.getState()).pending_approval;await assert.rejects(s.approve('stale',true));assert.equal((await s.approve(a.call_id,true)).approved,true);}finally{await c.close();}
});
test('observation unavailable timeout cancellation stderr Unicode',async()=>{
 const c=client('hidden');try{const s=await c.create({cwd:'/fake/work'});const r=await s.submit({text:'hello'});await assert.rejects(s.waitTurn(r.turn_id),TurnReplacedError);}finally{await c.close();}
 for(const cancel of [false,true]){const c=client('timeout');try{const s=await c.create({cwd:'/fake/work'});const controller=new AbortController();const p=s.submit({text:'hello'},{timeoutMs:50,signal:controller.signal});if(cancel){await new Promise(r=>setTimeout(r,20));controller.abort();}await assert.rejects(p,DeliveryUnknownError);}finally{await c.close();}}
 const noisy=client('stderr');try{const s=await noisy.create({cwd:'/fake/work'});assert.ok(Buffer.byteLength(s.stderrTail)<=65536);assert.ok(s.stderrTail.length);}finally{await noisy.close();}
 const unicode=client('fragmented');try{const s=await unicode.create({cwd:'/fake/work'});await s.submit({text:'é雪'});assert.equal((await s.getState()).messages[0].content,'é雪');}finally{await unicode.close();}
});
test('abandoned event consumer fails explicitly instead of deadlock',async()=>{
 const c=client('event_flood');try{await assert.rejects(async()=>{const s=await c.create({cwd:'/fake/work'});await s.getState();await new Promise(r=>setTimeout(r,50));await s.events().next();},e=>e.code==='event_overflow'&&!(e instanceof DeliveryUnknownError));}finally{await c.close();}
});

test('sequence gap and bad UTF-8 offset reconcile by readback',async()=>{
 for(const scenario of ['output_gap','bad_offset']){const c=client(scenario);try{const s=await c.create({cwd:'/fake/work'});await s.submit({text:'hello'});const it=s.events();await it.next();const recovered=(await it.next()).value;assert.equal(recovered.event,'state');assert.equal(recovered.resynced,true);assert.equal(recovered.state.streaming,'é雪');await it.return();}finally{await c.close();}}
});
test('out of order and unknown responses preserve correlation',async()=>{
 const {Transport}=await import('../dist/transport.js');
 const t=new Transport({executable:python,adapterArgs:[fake,'--scenario','out_of_order'],timeoutMs:1000});
 try{const [a,b]=await Promise.all([t.request('create',{cwd:'/fake/work'}),t.request('state',{})]);assert.equal(a.state.session_id,b.state.session_id);}finally{await t.close();}
 const c=client('wrong_id');try{const s=await c.create({cwd:'/fake/work'});assert.equal((await s.submit({text:'hello'})).disposition,'started');}finally{await c.close();}
});

test('polling survives flood, restart resyncs, simultaneous consumer stays exclusive',async()=>{
 const c=client('flood_finish');try{
  const s=await c.create({cwd:'/fake/work'});
  const first=await s.submit({text:'long output'});
  assert.equal((await s.waitTurn(first.turn_id)).state,'finished');
  assert.equal(s.transport.queueBytes,0);
  await assert.rejects(s.events().next(),e=>e.code==='event_overflow');
  const it=s.events();const recovered=(await it.next()).value;
  assert.equal(recovered.resynced,true);assert.equal(recovered.state.turn.state,'finished');
  await assert.rejects(s.events().next(),e=>e.code==='invalid_state');
  const second=await s.submit({text:'again'});
  assert.equal((await s.waitTurn(second.turn_id)).state,'finished');
  await assert.rejects(it.next(),e=>e.code==='event_overflow');
  const restarted=s.events();assert.equal((await restarted.next()).value.resynced,true);await restarted.return();
 }finally{await c.close();}
});
test('overflow during recovery remains explicit and control remains usable',async()=>{
 const c=client('event_flood');try{
  const s=await c.create({cwd:'/fake/work'});await s.getState();
  for(let i=0;i<3;i++) await assert.rejects(s.events().next(),e=>e.code==='event_overflow');
  assert.equal(s.transport.queueBytes,0);assert.equal(s.transport.failure,undefined);
  assert.equal((await s.submit({text:'still usable'})).disposition,'started');
 }finally{await c.close();}
});
test('byte overflow releases accounting and validates later frames',async()=>{
 const c=client();try{
  const s=await c.create({cwd:'/fake/work'});const t=s.transport;
  const state=await s.getState();
  t.frame({type:'event',event:'state',seq:1,state,resynced:false},33*1024*1024);
  t.frame({type:'event',event:'state',seq:2,state,resynced:false},33*1024*1024);
  assert.equal(t.queueBytes,0);assert.equal(t.queue.length,0);
  await assert.rejects(s.events().next(),e=>e.code==='event_overflow');
  const it=s.events();assert.equal((await it.next()).value.resynced,true);await it.return();
  t.data(Buffer.from(JSON.stringify({type:'event',event:'output_append',seq:3,revision:0,offset:0,text:'x'})+'\n'));
  await assert.rejects(s.getState(),e=>e.code==='protocol');
 }finally{await c.close();}
});

test('recovery discards superseded appends and accepts subsequent output',async()=>{
 const c=client('flood_output');try{
  const s=await c.create({cwd:'/fake/work'});const first=await s.submit({text:'hello'});
  await assert.rejects(s.events().next(),e=>e.code==='event_overflow');
  const it=s.events();assert.equal((await it.next()).value.state.streaming,'é雪');assert.equal(s.transport.queue.length,0);
  await s.interrupt(first.turn_id);await it.next();
  await s.submit({text:'next'});await it.next();const append=(await it.next()).value;
  assert.equal(append.event,'output_append');assert.equal(append.text,'é雪');await it.return();
 }finally{await c.close();}
});

test('failed recovery retries and preserves newer observations in sequence order',async()=>{
 const c=client('flood_output');try{
  const s=await c.create({cwd:'/fake/work'});await s.submit({text:'hello'});
  await assert.rejects(s.events().next(),e=>e.code==='event_overflow');
  const current=await s.getState();let calls=0;
  s.getState=async()=>{
   if(++calls===1) throw new SdkError('timeout','readback timed out');
   s.transport.frame({type:'event',event:'output_append',seq:s.transport.seq+1,revision:current.revision+1,offset:Buffer.byteLength(current.streaming),text:'!'},100);
   return current;
  };
  await assert.rejects(s.events().next(),e=>e.code==='timeout');
  const it=s.events();const recovered=(await it.next()).value;assert.equal(recovered.resynced,true);
  const append=(await it.next()).value;assert.ok(append.seq>recovered.seq);assert.equal(append.text,'!');assert.equal(s.state.streaming,'é雪!');await it.return();
 }finally{await c.close();}
});
