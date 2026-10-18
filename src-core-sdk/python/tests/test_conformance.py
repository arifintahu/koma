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
        s = await self.client('timeout', request_timeout=.05).create('/fake/work')
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

if __name__ == '__main__':
    unittest.main()
