#!/usr/bin/env python3
"""Deterministic, dependency-free JSONL peer. Never contacts Koma."""
import argparse
import copy
import json
import sys
import os
import time

MAX_LINE = 40 * 1024 * 1024
METHODS = ['create', 'resume', 'state', 'submit', 'enqueue', 'interrupt',
           'interrupt_and_submit', 'approve', 'detach']
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--scenario', choices=['normal', 'reject', 'partial', 'unknown',
    'eof', 'malformed', 'wrong_id', 'out_of_order', 'event_flood', 'approval',
    'bad_version', 'stderr', 'output', 'timeout', 'hidden', 'fragmented', 'missing_cap', 'output_gap', 'bad_offset', 'finish', 'bad_result'], default=os.environ.get('KOMA_FAKE_SCENARIO', 'normal'))
a = p.parse_args([] if sys.argv[1:] == ['sdk', 'serve'] else None)

def emit(value):
    raw = (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    if a.scenario == 'fragmented':
        for b in raw:
            sys.stdout.buffer.write(bytes([b])); sys.stdout.buffer.flush()
    else:
        sys.stdout.buffer.write(raw); sys.stdout.buffer.flush()

emit(dict(type='hello', protocol=2 if a.scenario == 'bad_version' else 1,
          binary=dict(path='/fake/koma', version='0.0.0-fake'),
          diagnostics=['conformance fake; no daemon'], capabilities=METHODS[:-1] if a.scenario == 'missing_cap' else METHODS))
if a.scenario == 'stderr':
    sys.stderr.write('fake diagnostic\n' * 8192)
    sys.stderr.flush()
session = None
seq = 0
counter = 0
held = None

def event():
    global seq
    seq += 1
    emit(dict(type='event', event='state', seq=seq, state=copy.deepcopy(session), resynced=False))

def response(rid, result=None, code=None, delivery='not_sent'):
    frame = dict(type='response', id=rid)
    if code:
        frame['error'] = dict(code=code, message='fake ' + code, delivery=delivery)
    else:
        frame['result'] = result
    return frame

def outcome(disposition, turn_id=None, code=None, replacement=False, interrupted=None):
    value = dict(disposition=disposition, turn_id=turn_id,
                 reason=None if code is None else dict(code=code, message='fake ' + code))
    if replacement:
        value['interrupted_turn_id'] = interrupted
    return value

while True:
    raw = sys.stdin.buffer.readline(MAX_LINE + 2)
    if not raw:
        break
    if len(raw.rstrip(b'\n')) > MAX_LINE or not raw.endswith(b'\n'):
        sys.stderr.write('invalid or oversized frame\n')
        sys.exit(2)
    try:
        request = json.loads(raw.decode('utf-8'))
        rid, method, params = request['id'], request['method'], request['params']
        if not isinstance(rid, str) or not rid or not isinstance(params, dict):
            raise ValueError('bad request')
    except (ValueError, KeyError, TypeError):
        sys.stderr.write('malformed request\n')
        sys.exit(2)
    if os.environ.get('KOMA_FAKE_LOG'):
        with open(os.environ['KOMA_FAKE_LOG'], 'a') as log: log.write(json.dumps(request) + '\n')
    if a.scenario == 'timeout' and method == 'submit':
        time.sleep(2)
    if a.scenario == 'eof' and method in ('submit', 'interrupt_and_submit'):
        sys.exit(3)
    if a.scenario == 'malformed':
        print('{bad json', flush=True)
        sys.exit(3)
    if method not in METHODS:
        frame = response(rid, code='unsupported_method')
    elif method in ('create', 'resume'):
        if session is not None:
            frame = response(rid, code='invalid_state')
        else:
            session = dict(session_id=params.get('session_id', 'session-1'),
                cwd=params.get('cwd', '/fake/workspace'), model_id=params.get('model_id', 'fake/model'),
                policy=params.get('policy', dict(plan='forbid', approval='reject')),
                revision=1, external_approvals=params.get('external_approvals', False), pending_approval=None, gate=None,
                turn=None, working=False, awaiting_approval=False, approval_reason=None,
                pending_count=0, messages=[], streaming=None)
            frame = response(rid, dict(state=copy.deepcopy(session)))
    elif session is None:
        frame = response(rid, code='invalid_state')
    elif method == 'state':
        if a.scenario == 'finish' and session['turn'] and session['turn']['state'] == 'running':
            session['turn']['state'] = 'finished'
            session['working'] = False
            session['streaming'] = None
            session['messages'].append(dict(role='assistant',content='Fake answer é雪'))
            session['revision'] += 1
        frame = response(rid, dict(state=copy.deepcopy(session)))
    elif method == 'detach':
        emit(response(rid, dict(detached=True)))
        break
    elif method == 'approve':
        if (not session['external_approvals'] or not session['pending_approval'] or params.get('call_id') != session['pending_approval']['call_id']):
            frame = response(rid, code='invalid_state')
        else:
            session.update(awaiting_approval=False, approval_reason=None, pending_approval=None, gate=None)
            session["revision"] += 1
            frame = response(rid, dict(approved=params['approve']))
            event()
    else:
        replacement = method == 'interrupt_and_submit'
        active = session['turn'] if session['turn'] and session['turn']['state'] == 'running' else None
        target = params.get('turn_id')
        code = None
        if method in ('interrupt', 'interrupt_and_submit') and (not active or active['id'] != target):
            code = 'stale_turn'
        elif method == 'submit' and active:
            code = 'busy'
        elif method == 'enqueue' and not active:
            code = 'busy'
        elif method == 'enqueue' and session['pending_count'] >= 5:
            code = 'queue_full'
        elif method != 'interrupt' and not params.get('text', '').strip():
            code = 'invalid_input'
        elif a.scenario == 'reject':
            code = 'invalid_input'
        if code:
            value = outcome('rejected', target if method == 'interrupt' else None, code, replacement)
        elif a.scenario == 'unknown':
            emit(response(rid, code='unavailable', delivery='unknown'))
            continue
        elif method == 'enqueue':
            session['pending_count'] += 1
            value = outcome('queued')
        elif method == 'interrupt':
            session['turn']['state'] = 'interrupted'
            session['working'] = False
            value = outcome('interrupted', target)
        elif replacement and a.scenario == 'partial':
            session['turn']['state'] = 'interrupted'
            session['working'] = False
            value = outcome('rejected', code='internal', replacement=True, interrupted=target)
        else:
            counter += 1
            tid = 'turn-' + str(counter)
            session.update(turn=dict(id=tid, state='running', error=None), working=True,
                           awaiting_approval=a.scenario == 'approval',
                           approval_reason='fake tool' if a.scenario == 'approval' else None)
            session['messages'].append(dict(role='user', content=params['text']))
            value = outcome('started', tid, replacement=replacement, interrupted=target if replacement else None)
        session['revision'] += 1
        if a.scenario == 'approval' and session['awaiting_approval']:
            session['pending_approval'] = dict(call_id='call-1', reason='fake tool')
            session['gate'] = dict(kind='tool', reason='fake tool', supported=session['external_approvals'])
        frame = response(rid, value)
        event()  # Deliberately interleave event BEFORE correlated result.
    if a.scenario == 'hidden' and method == 'state':
        session['turn'] = dict(id='newer', state='running', error=None)
        session['revision'] += 1
        frame = response(rid, dict(state=copy.deepcopy(session)))
    if a.scenario in ('output','output_gap','bad_offset') and method == 'submit':
        session['streaming'] = 'é雪'
        session['revision'] += 1
        seq += 2 if a.scenario == 'output_gap' else 1
        emit(dict(type='event', event='output_append', seq=seq, revision=session['revision'], offset=999 if a.scenario == 'bad_offset' else 0, text='é雪'))
    if a.scenario == 'bad_result' and method == 'submit':
        frame['result']['turn_id'] = 123
    if a.scenario == 'wrong_id':
        emit(response('unrecognized-id', dict(detached=True)))
    if a.scenario == 'event_flood' and session and method == 'state':
        for _ in range(300):
            event()
    if a.scenario == 'out_of_order':
        if held is None:
            held = frame
            continue
        emit(frame)
        emit(held)
        held = None
    else:
        emit(frame)
