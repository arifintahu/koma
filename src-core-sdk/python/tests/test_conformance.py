import asyncio
from pathlib import Path
import sys
import unittest

from koma_sdk import (Client, Policy, ApprovalPolicy, Disposition, DeliveryUnknown,
                      IncompatibleAdapter, RemoteError, ObservationUnavailable,
                      OutputAppendEvent, ProtocolError, EventOverflow)

FAKE = Path(__file__).resolve().parents[2] / 'conformance' / 'fake_adapter.py'

class Conformance(unittest.IsolatedAsyncioTestCase):
    def client(self, scenario='normal', **kwargs):
        c = Client(sys.executable, adapter_args=(str(FAKE), '--scenario', scenario), close_timeout=.1, **kwargs)
        self.addAsyncCleanup(c.close)
        return c

    async def test_probe_create_resume_owned_results(self):
        c = self.client()
        self.assertEqual((await c.probe()).protocol, 1)
        s = await c.create('/fake/work')
        self.assertEqual((await s.get_state()).policy, Policy())
        first = await s.submit('hello é雪')
        self.assertEqual(first.disposition, Disposition.STARTED)
        self.assertEqual((await s.enqueue('next')).disposition, Disposition.QUEUED)
        rejected = await s.interrupt('stale')
        self.assertEqual(rejected.disposition, Disposition.REJECTED)
        replacement = await s.interrupt_and_submit(first.turn_id, 'replacement')
        self.assertEqual(replacement.interrupted_turn_id, first.turn_id)
        await s.interrupt(replacement.turn_id)
        self.assertEqual((await s.wait_turn(replacement.turn_id)).state.value, 'interrupted')
        await s.detach()
        resumed = await c.resume('saved')
        self.assertEqual(resumed.session_id, 'saved')

    async def test_partial_failure_preserves_interrupted(self):
        s = await self.client('partial').create('/fake/work')
        first = await s.submit('hello')
        result = await s.interrupt_and_submit(first.turn_id, 'replacement')
        self.assertEqual(result.disposition, Disposition.REJECTED)
        self.assertEqual(result.interrupted_turn_id, first.turn_id)

    async def test_unknown_disconnect_not_retried(self):
        for scenario in ('unknown', 'eof', 'bad_result'):
            s = await self.client(scenario).create('/fake/work')
            with self.assertRaises(DeliveryUnknown) as ctx:
                await s.submit('hello')
            self.assertTrue(ctx.exception.request_id)
            self.assertEqual(ctx.exception.session_id, s.session_id)

    async def test_version_missing_executable_and_malformed(self):
        with self.assertRaises(IncompatibleAdapter):
            await self.client('bad_version').probe()
        with self.assertRaises(IncompatibleAdapter):
            await self.client('missing_cap').probe()
        with self.assertRaises(DeliveryUnknown) as ctx:
            await self.client('malformed').create('/fake/work')
        self.assertIsInstance(ctx.exception.cause, ProtocolError)
        with self.assertRaises(Exception) as ctx:
            await Client('/not/an/executable').probe()
        self.assertIn('cannot launch', str(ctx.exception))

    async def test_output_append_unicode_and_early_events(self):
        s = await self.client('output').create('/fake/work')
        await s.submit('é雪')
        events = s.events()
        first = await anext(events)
        second = await anext(events)
        self.assertIsInstance(second, OutputAppendEvent)
        self.assertEqual(second.text, 'é雪')
        await events.aclose()
        self.assertEqual((await s.get_state()).streaming, 'é雪')

    async def test_targeted_approval(self):
        s = await self.client('approval').create('/fake/work', external_approvals=True,
            policy=Policy(approval=ApprovalPolicy.DEFAULT))
        await s.submit('hello')
        pending = (await s.get_state()).pending_approval
        with self.assertRaises(RemoteError):
            await s.approve('stale', True)
        self.assertTrue((await s.approve(pending.call_id, True)).approved)

    async def test_observation_hidden_timeout_cancel_and_stderr(self):
        s = await self.client('hidden').create('/fake/work')
        first = await s.submit('hello')
        with self.assertRaises(ObservationUnavailable):
            await s.wait_turn(first.turn_id, timeout=.1)
        # Hello shares request_timeout. Windows process startup can exceed a
        # few dozen milliseconds, so create uses the default budget. Submit
        # still has to time out: the fake adapter sleeps 2s only on submit.
        client = self.client('timeout')
        s = await client.create('/fake/work')
        client.request_timeout = 1
        with self.assertRaises(DeliveryUnknown):
            await s.submit('hello')
        s = await self.client('stderr').create('/fake/work')
        self.assertLessEqual(len(s._transport.stderr), 65536)
        self.assertTrue(s.stderr_tail)

    async def test_event_consumer_abandoned_overflow_is_explicit(self):
        c = self.client('event_flood')
        with self.assertRaises(EventOverflow):
            s = await c.create('/fake/work')
            await s.get_state()
            await asyncio.sleep(.05)
            await anext(s.events())

    async def test_polling_flood_and_restart(self):
        s = await self.client('flood_finish').create('/fake/work')
        result = await s.submit('long output')
        self.assertEqual((await s.wait_turn(result.turn_id)).state.value, 'finished')
        self.assertEqual(s._transport._event_bytes, 0)
        with self.assertRaises(EventOverflow):
            await anext(s.events())
        events = s.events()
        recovered = await anext(events)
        self.assertTrue(recovered.resynced)
        self.assertEqual(recovered.state.turn.state.value, 'finished')
        with self.assertRaises(RuntimeError):
            await anext(s.events())
        result = await s.submit('again')
        self.assertEqual((await s.wait_turn(result.turn_id)).state.value, 'finished')
        with self.assertRaises(EventOverflow):
            await anext(events)
        await events.aclose()
        recovered = s.events()
        self.assertTrue((await anext(recovered)).resynced)
        await recovered.aclose()

    async def test_recovery_discards_duplicate_appends(self):
        s = await self.client('flood_output').create('/fake/work')
        first = await s.submit('hello')
        with self.assertRaises(EventOverflow):
            await anext(s.events())
        events = s.events()
        recovered = await anext(events)
        self.assertEqual(recovered.state.streaming, 'é雪')
        self.assertTrue(s._transport.events.empty())
        await s.interrupt(first.turn_id)
        # Observe the interrupt before submitting the next turn.
        await anext(events)
        await s.submit('next')
        await anext(events)
        append = await anext(events)
        self.assertIsInstance(append, OutputAppendEvent)
        self.assertEqual(append.text, 'é雪')
        await events.aclose()

    async def test_failed_recovery_retries_and_preserves_later_append(self):
        from koma_sdk.errors import RequestTimeout
        s = await self.client('flood_output').create('/fake/work')
        await s.submit('hello')
        with self.assertRaises(EventOverflow):
            await anext(s.events())
        current = await s.get_state()
        calls = 0
        async def readback():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RequestTimeout('readback timed out')
            s._transport._accept(dict(type='event', event='output_append',
                seq=s._transport.sequence + 1, revision=current.revision + 1,
                offset=len(current.streaming.encode()), text='!'))
            return current
        s.get_state = readback
        with self.assertRaises(RequestTimeout):
            await anext(s.events())
        events = s.events()
        recovered = await anext(events)
        self.assertTrue(recovered.resynced)
        append = await anext(events)
        self.assertGreater(append.seq, recovered.seq)
        self.assertEqual(append.text, '!')
        self.assertEqual(s._state.streaming, 'é雪!')
        await events.aclose()

    async def test_repeated_overflow_during_recovery(self):
        s = await self.client('event_flood').create('/fake/work')
        await s.get_state()
        for _ in range(3):
            with self.assertRaises(EventOverflow):
                await anext(s.events())
        self.assertIsNone(s._transport.failure)
        self.assertEqual(s._transport._event_bytes, 0)

    async def test_readbacks_never_regress_state(self):
        from dataclasses import replace
        s = await self.client().create('/fake/work')
        initial = s._state
        futures = []
        async def request(*args, **kwargs):
            future = asyncio.get_running_loop().create_future()
            futures.append(future)
            return await future
        s._request = request
        from unittest.mock import patch
        with patch('koma_sdk.client.State.from_wire', side_effect=lambda x: x):
            older = asyncio.create_task(s.get_state())
            newer = asyncio.create_task(s.get_state())
            await asyncio.sleep(0)
            futures[1].set_result({'state': replace(initial, revision=3)})
            self.assertEqual((await newer).revision, 3)
            futures[0].set_result({'state': replace(initial, revision=2)})
            self.assertEqual((await older).revision, 3)
            readback = asyncio.create_task(s.get_state())
            await asyncio.sleep(0)
            events = s.events()
            s._transport.publish({'event': 'state', 'seq': 1, '_gap': False,
                'state': replace(initial, revision=4), 'resynced': False})
            self.assertEqual((await anext(events)).state.revision, 4)
            futures[2].set_result({'state': replace(initial, revision=3)})
            self.assertEqual((await readback).revision, 4)
            for seq, revision in enumerate((2, 4, 5), start=2):
                s._transport.publish({'event': 'state', 'seq': seq, '_gap': False,
                    'state': replace(initial, revision=revision), 'resynced': False})
            self.assertEqual((await anext(events)).state.revision, 5)
            await events.aclose()
        cached = s._state
        self.assertIs(s._update_state(replace(initial, revision=5)), cached)
        self.assertIs(s._update_state(initial), cached)

    async def test_gap_and_offset_mismatch_resync(self):
        for scenario in ('output_gap', 'bad_offset'):
            s = await self.client(scenario).create('/fake/work')
            await s.submit('hello')
            events = s.events()
            await anext(events)
            recovered = await anext(events)
            self.assertTrue(recovered.resynced)
            self.assertEqual(recovered.state.streaming, 'é雪')
            await events.aclose()

    async def test_reordered_and_unknown_ids(self):
        c = self.client('out_of_order')
        transport, _ = await c._connect(('create', 'state'))
        def request(method, params):
            return transport.request(method, params, mutation=method == 'create',
                timeout=1, envelope=lambda i,m,p: {"id":i,"method":m,"params":p})
        created, state = await asyncio.gather(request('create', {'cwd':'/fake/work'}), request('state', {}))
        self.assertEqual(created['state']['session_id'], state['state']['session_id'])
        s = await self.client('wrong_id').create('/fake/work')
        self.assertEqual((await s.submit('hello')).disposition, Disposition.STARTED)

    async def test_fragmented_utf8(self):
        s = await self.client('fragmented').create('/fake/work')
        await s.submit('é雪')
        self.assertEqual((await s.get_state()).messages[0].content, 'é雪')

    async def test_configure_two_providers_then_live_main_swap(self):
        c = self.client()
        configured = await c.configure(
            providers=[
                {'name': 'openai', 'endpoint': 'https://api.openai.com/v1', 'api_type': 'openai', 'api_key': 'sk-test'},
                {'name': 'anthropic', 'endpoint': 'https://api.anthropic.com', 'api_type': 'anthropic', 'api_key': 'sk-ant'},
            ],
            models={
                'main': {'provider': 'openai', 'model_id': 'gpt-4.1'},
                'awareness': {'provider': 'openai', 'model_id': 'gpt-4.1-mini'},
                'safeguard': {'provider': 'anthropic', 'model_id': 'claude-sonnet-4-5'},
                'compactor': {'provider': 'openai', 'model_id': 'gpt-4.1-mini'},
                'planner': {'provider': 'anthropic', 'model_id': 'claude-sonnet-4-5'},
            })
        self.assertEqual([item['name'] for item in configured['providers']], ['openai', 'anthropic'])
        self.assertEqual(configured['providers'][0]['uuid'], 'prov-openai')
        self.assertEqual(configured['models']['safeguard']['provider'], 'anthropic')
        encoded = str(configured)
        self.assertNotIn('api_key', encoded)
        self.assertNotIn('sk-test', encoded)
        session = await c.create('/fake/work')
        swapped = await session.configure(models={'main': {'provider': 'anthropic', 'model_id': 'claude-sonnet-4-5'}})
        self.assertEqual(swapped['providers'], [])
        self.assertEqual(swapped['models']['main']['model_id'], 'claude-sonnet-4-5')
        self.assertNotIn('api_key', str(swapped))

    async def test_configure_refuses_empty_key_without_sending(self):
        import os
        import tempfile
        log = tempfile.NamedTemporaryFile(prefix='koma-configure-', delete=False)
        log.close()
        os.environ['KOMA_FAKE_LOG'] = log.name
        try:
            with self.assertRaises(ValueError):
                await self.client().configure(providers=[{
                    'name': 'openai', 'endpoint': 'https://api.openai.com/v1',
                    'api_type': 'openai', 'api_key': '   '}])
            self.assertEqual(Path(log.name).read_text(), '')
        finally:
            os.environ.pop('KOMA_FAKE_LOG', None)
            Path(log.name).unlink(missing_ok=True)

if __name__ == '__main__':
    unittest.main()
