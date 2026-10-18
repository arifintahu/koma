import asyncio
import json
import sys
import unittest

from koma_sdk._transport import Transport
from koma_sdk.errors import DeliveryUnknown, EventOverflow, ProtocolError


class TestTransport(unittest.IsolatedAsyncioTestCase):
    async def launch(self, source, **kwargs):
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-u", "-c", source, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        transport = Transport(process, close_timeout=.1, **kwargs)
        self.addAsyncCleanup(transport.close)
        return transport

    async def test_split_utf8_and_multiple_records(self):
        t = await self.launch("import os,time; b='é'.encode(); os.write(1,b'{\"s\":\"'+b[:1]); time.sleep(.03); os.write(1,b[1:]+b'\"}\\n{\"n\":2}\\n')")
        t._accept = t.publish
        self.assertEqual(await t.next_event(), {"s": "é"})
        self.assertEqual(await t.next_event(), {"n": 2})

    async def test_overflow_does_not_block_response(self):
        t = await self.launch("import sys,json,time; r=json.loads(input()); print('{\"e\":1}'); print('{\"e\":2}'); print(json.dumps({'id':r['id'],'ok':True}),flush=True); time.sleep(1)", event_capacity=1)
        def accept(m):
            if "id" in m:
                t.pending[m["id"]].future.set_result(m)
            else:
                t.publish(m)
        t._accept = accept
        result = await t.request("test", {}, mutation=True, timeout=1,
                                 envelope=lambda i,m,p: {"id": i})
        self.assertTrue(result["ok"])
        self.assertEqual(t._event_bytes, 0)
        self.assertFalse(t._event_sizes)
        self.assertTrue(t.events.empty())
        self.assertIsNone(t.failure)
        with self.assertRaises(EventOverflow):
            await t.next_event()

    async def test_byte_overflow_and_validation_after_overflow(self):
        t = await self.launch("import time; time.sleep(5)")
        t.current_frame_bytes = 33 * 1024 * 1024
        t.publish({"e": 1})
        t.publish({"e": 2})
        self.assertEqual(t._event_bytes, 0)
        with self.assertRaises(EventOverflow):
            await t.next_event()
        self.assertTrue(t.restart_events())
        t.current_frame_bytes = 1
        t.publish({"e": 3})
        self.assertEqual(await t.next_event(), {"e": 3})
        t.publish({"e": 4})
        t.clear_events()
        self.assertEqual(t._event_bytes, 0)

    async def test_after_write_timeout_and_cancel(self):
        for cancel in (False, True):
            t = await self.launch("import time; input(); time.sleep(5)")
            task = asyncio.create_task(t.request("submit", {"session_id":"s"}, mutation=True,
                timeout=.05 if not cancel else 5, envelope=lambda i,m,p: {"id":i}))
            if cancel:
                await asyncio.sleep(.03)
                task.cancel()
            with self.assertRaises(DeliveryUnknown) as ctx:
                await task
            self.assertEqual(ctx.exception.session_id, "s")
            self.assertTrue(ctx.exception.request_id)

    async def test_bounded_frame_and_stderr(self):
        t = await self.launch("import os,time; os.write(2,b'x'*100000); os.write(1,b'x'*129); time.sleep(.1)", max_frame_bytes=128, stderr_bytes=64)
        with self.assertRaises(ProtocolError):
            await t.next_event()
        await asyncio.sleep(.05)
        self.assertLessEqual(len(t.stderr), 64)

    async def test_truncated_frame(self):
        t = await self.launch("print('{',end='',flush=True)")
        with self.assertRaisesRegex(ProtocolError, "truncated"):
            await t.next_event()


if __name__ == '__main__':
    unittest.main()
