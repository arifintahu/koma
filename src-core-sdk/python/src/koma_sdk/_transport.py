"""Bounded byte-framed subprocess transport; no shell and no daemon signalling."""
from __future__ import annotations

import asyncio
import json
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable

from .errors import DeliveryUnknown, EventOverflow, ProtocolError, RequestTimeout, TransportError

MAX_FRAME_BYTES = 40 * 1024 * 1024


@dataclass
class Pending:
    future: asyncio.Future[dict[str, Any]]
    method: str
    mutation: bool
    session_id: str | None
    turn_id: str | None
    written: bool = False


class Transport:
    def __init__(self, process: asyncio.subprocess.Process, *, event_capacity: int = 256,
                 max_frame_bytes: int = MAX_FRAME_BYTES, stderr_bytes: int = 64 * 1024,
                 close_timeout: float = 2.0):
        if not 1 <= event_capacity <= 256 or not 1 <= max_frame_bytes <= MAX_FRAME_BYTES or not 1 <= stderr_bytes <= 65536:
            raise ValueError("invalid transport bounds")
        self.process = process
        self.max_frame_bytes = max_frame_bytes
        self.stderr_limit = stderr_bytes
        self.close_timeout = close_timeout
        self.pending: dict[str, Pending] = {}
        self.events: asyncio.Queue[dict[str, Any]] = asyncio.Queue(event_capacity)
        self.event_error: TransportError | None = None
        self._event_bytes = 0
        self._overflow_observed = False
        self._resync_required = False
        self._event_sizes: deque[int] = deque()
        self.current_frame_bytes = 0
        self.failure: TransportError | None = None
        self.changed = asyncio.Event()
        self.stderr = bytearray()
        self._write_lock = asyncio.Lock()
        self._closed = False
        self._close_task: asyncio.Task[None] | None = None
        self.on_event: Callable[[dict[str, Any]], None] | None = None
        self._reader = asyncio.create_task(self._read_stdout())
        self._stderr = asyncio.create_task(self._read_stderr())

    def _fail(self, error: TransportError) -> None:
        if self.failure is None:
            self.failure = error
        for request_id, pending in list(self.pending.items()):
            if pending.future.done():
                continue
            failure = self._delivery(request_id, pending, error) if pending.written and pending.mutation else error
            pending.future.set_exception(failure)
        self.changed.set()

    @staticmethod
    def _delivery(request_id: str, pending: Pending, cause: BaseException) -> DeliveryUnknown:
        return DeliveryUnknown(request_id, pending.method, session_id=pending.session_id,
                               turn_id=pending.turn_id, cause=cause)

    async def request(self, method: str, params: dict[str, Any], *, mutation: bool,
                      envelope: Callable[[str, str, dict[str, Any]], dict[str, Any]],
                      timeout: float | None) -> dict[str, Any]:
        if len(self.pending) >= 64:
            raise TransportError("pending request limit (64) exceeded before writing")
        request_id = str(uuid.uuid4())
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        pending = Pending(future, method, mutation, params.get("session_id"), params.get("turn_id"))
        payload = json.dumps(envelope(request_id, method, params), ensure_ascii=False,
                             separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n"
        if len(payload) - 1 > self.max_frame_bytes:
            raise ProtocolError("outbound JSONL frame exceeds maximum")
        self.pending[request_id] = pending
        try:
            async with asyncio.timeout(timeout):
                async with self._write_lock:
                    if self.failure:
                        raise self.failure
                    if self._closed:
                        raise TransportError("transport closed")
                    assert self.process.stdin is not None
                    pending.written = True
                    self.process.stdin.write(payload)
                    await self.process.stdin.drain()
                return await asyncio.shield(future)
        except (TimeoutError, asyncio.CancelledError, OSError, ConnectionError) as exc:
            if pending.written and mutation:
                raise self._delivery(request_id, pending, exc) from exc
            if isinstance(exc, TimeoutError):
                raise RequestTimeout(f"{method} timed out") from exc
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise TransportError(str(exc)) from exc
        finally:
            self.pending.pop(request_id, None)
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                future.exception()  # retrieve races with cancellation/timeout

    def _accept(self, message: dict[str, Any]) -> None:
        raise NotImplementedError("wire-specific dispatcher must be installed")

    def publish(self, message: dict[str, Any]) -> None:
        if self.on_event:
            self.on_event(message)
        if self.event_error:
            return
        try:
            if self._event_bytes + self.current_frame_bytes > 64 * 1024 * 1024:
                raise asyncio.QueueFull
            self.events.put_nowait(message)
            self._event_bytes += self.current_frame_bytes
            self._event_sizes.append(self.current_frame_bytes)
        except asyncio.QueueFull:
            self.clear_events()
            self.event_error = EventOverflow("event inbox overflow; restart events to reconcile state")
            self._overflow_observed = False
        self.changed.set()

    def clear_events(self) -> None:
        while not self.events.empty():
            self.events.get_nowait()
        self._event_sizes.clear()
        self._event_bytes = 0

    def restart_events(self) -> bool:
        if self.event_error and not self._overflow_observed:
            return False
        if not self._overflow_observed and not self._resync_required:
            return False
        self.event_error = None
        self._resync_required = True
        self._overflow_observed = False
        return True

    def check_events(self) -> None:
        if self.failure:
            raise self.failure
        if self.event_error:
            self._overflow_observed = True
            raise self.event_error

    def finish_recovery(self, revision: int) -> None:
        self.check_events()
        retained = []
        while not self.events.empty():
            event = self.events.get_nowait()
            size = self._event_sizes.popleft()
            if event.get("state", {}).get("revision", event.get("revision", 0)) > revision:
                retained.append((event, size))
        self._event_bytes = 0
        for event, size in retained:
            self.events.put_nowait(event)
            self._event_sizes.append(size)
            self._event_bytes += size
        self._resync_required = False

    async def next_event(self) -> dict[str, Any]:
        while True:
            self.check_events()
            if not self.events.empty():
                self._event_bytes -= self._event_sizes.popleft()
                return self.events.get_nowait()
            if self.failure:
                raise self.failure
            if self._closed:
                raise TransportError("transport closed")
            self.changed.clear()
            await self.changed.wait()

    async def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        buffer = bytearray()
        try:
            while chunk := await self.process.stdout.read(65536):
                start = 0
                while True:
                    end = chunk.find(b"\n", start)
                    part = chunk[start:] if end == -1 else chunk[start:end]
                    if len(buffer) + len(part) > self.max_frame_bytes:
                        raise ProtocolError("inbound JSONL frame exceeds maximum")
                    buffer.extend(part)
                    if end == -1:
                        break
                    try:
                        message = json.loads(buffer.decode("utf-8"))
                    except (UnicodeError, ValueError) as exc:
                        raise ProtocolError(f"invalid UTF-8 JSONL: {exc}") from exc
                    self.current_frame_bytes = len(buffer)
                    buffer.clear()
                    if not isinstance(message, dict):
                        raise ProtocolError("JSONL record must be an object")
                    self._accept(message)
                    start = end + 1
            if buffer:
                raise ProtocolError("truncated JSONL record at EOF")
            raise TransportError("adapter stdout closed")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._fail(exc if isinstance(exc, TransportError) else ProtocolError(str(exc)))
            asyncio.create_task(self.close())

    async def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        try:
            while chunk := await self.process.stderr.read(8192):
                self.stderr.extend(chunk)
                if len(self.stderr) > self.stderr_limit:
                    del self.stderr[:-self.stderr_limit]
        except (OSError, asyncio.CancelledError):
            pass

    async def close(self) -> None:
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._close())
        await asyncio.shield(self._close_task)

    async def _close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._fail(TransportError("transport closed"))
        if self.process.stdin:
            self.process.stdin.close()
        try:
            await asyncio.wait_for(self.process.wait(), self.close_timeout)
        except TimeoutError:
            try:
                self.process.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(self.process.wait(), self.close_timeout)
            except TimeoutError:
                try:
                    self.process.kill()
                except ProcessLookupError:
                    pass
                await asyncio.wait_for(self.process.wait(), self.close_timeout)
        finally:
            self._reader.cancel()
            self._stderr.cancel()
            await asyncio.gather(self._reader, self._stderr, return_exceptions=True)
