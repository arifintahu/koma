"""Async adapter/session ownership. One subprocess per connected session."""
from __future__ import annotations

import asyncio
import os
from dataclasses import replace
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from ._transport import Transport
from .errors import (DeliveryUnknown, IncompatibleAdapter, ProtocolError, RemoteError,
                     RequestTimeout, TransportError)
from .types import (ApprovalResult, Attachment, Binary, DetachResult, Hello, Policy,
                    ReplacementResult, State, StateEvent, Turn, TurnResult, TurnStatus, Event, OutputAppendEvent, TurnEvent, ApprovalPolicy)


_ROLES = ("main", "awareness", "safeguard", "compactor", "planner")


def _configure_params(providers: Sequence[Mapping[str, Any]] | None,
                      models: Mapping[str, Mapping[str, Any]] | None) -> dict[str, Any]:
    if providers is None and models is None:
        raise ValueError("providers or models required")
    params: dict[str, Any] = {}
    if providers is not None:
        if not isinstance(providers, (list, tuple)):
            raise ValueError("providers must be a list")
        cleaned = []
        seen: set[str] = set()
        for item in providers:
            if not isinstance(item, Mapping):
                raise ValueError("provider must be an object")
            name = item.get("name")
            endpoint = item.get("endpoint")
            api_type = item.get("api_type")
            if not isinstance(name, str) or not name.strip():
                raise ValueError("provider name is empty")
            name = name.strip()
            if name in seen:
                raise ValueError(f"duplicate provider name '{name}'")
            seen.add(name)
            if not isinstance(endpoint, str) or not endpoint.strip():
                raise ValueError("endpoint must be an http(s) URL")
            if api_type not in ("openai", "anthropic"):
                raise ValueError("api_type must be 'openai' or 'anthropic'")
            entry: dict[str, Any] = {"name": name, "endpoint": endpoint.strip(), "api_type": api_type}
            if "api_key" in item and item.get("api_key") is not None:
                key = item.get("api_key")
                if not isinstance(key, str) or not key.strip():
                    raise ValueError("api_key must be non-empty when provided")
                entry["api_key"] = key.strip()
            cleaned.append(entry)
        params["providers"] = cleaned
    if models is not None:
        if not isinstance(models, Mapping):
            raise ValueError("models must be an object")
        cleaned_models: dict[str, Any] = {}
        for role, spec in models.items():
            if role not in _ROLES:
                raise ValueError(f"unknown model role '{role}'")
            if not isinstance(spec, Mapping):
                raise ValueError("model assignment must be an object")
            provider = spec.get("provider")
            model_id = spec.get("model_id")
            if not isinstance(provider, str) or not provider.strip() or not isinstance(model_id, str) or not model_id.strip():
                raise ValueError("model provider and model_id are required")
            assignment: dict[str, Any] = {"provider": provider.strip(), "model_id": model_id.strip()}
            if "route" in spec and spec.get("route") is not None:
                route = spec.get("route")
                if not isinstance(route, str):
                    raise ValueError("route must be a string")
                assignment["route"] = route
            cleaned_models[role] = assignment
        params["models"] = cleaned_models
    if not params.get("providers") and not params.get("models"):
        raise ValueError("providers or models required")
    return params


def _validate_configure(result: dict[str, Any]) -> None:
    providers = result["providers"]
    models = result["models"]
    if not isinstance(providers, list) or not isinstance(models, dict):
        raise ValueError("configure result shape")
    for provider in providers:
        if (not isinstance(provider, dict) or not isinstance(provider.get("name"), str) or not provider["name"]
                or not isinstance(provider.get("uuid"), str) or not provider["uuid"]
                or "api_key" in provider or "key" in provider):
            raise ValueError("configure provider")
    for role, spec in models.items():
        if (role not in _ROLES or not isinstance(spec, dict)
                or any(not isinstance(spec.get(field), str) or not spec[field] for field in ("uuid", "model_id", "provider"))
                or "api_key" in spec or "key" in spec):
            raise ValueError("configure model")


class ObservationUnavailable(TransportError):
    def __init__(self, turn_id: str, message: str):
        self.turn_id = turn_id
        super().__init__(message)


class _Wire(Transport):
    def __init__(self, *args: Any, **kwargs: Any):
        self.hello: asyncio.Future[Hello] = asyncio.get_running_loop().create_future()
        self.sequence = 0
        super().__init__(*args, **kwargs)

    def _fail(self, error: TransportError) -> None:
        if not self.hello.done():
            self.hello.set_exception(error)
        super()._fail(error)

    def _accept(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if not self.hello.done():
            if kind != "hello":
                raise ProtocolError("first adapter frame must be hello")
            if type(message.get("protocol")) is not int or message["protocol"] != 1:
                raise IncompatibleAdapter(f"unsupported protocol {message.get('protocol')!r}; expected 1")
            b = message["binary"]
            caps, diagnostics = message["capabilities"], message["diagnostics"]
            if (not isinstance(b, dict) or not all(isinstance(b.get(k), str) for k in ("path", "version"))
                or not isinstance(caps, list) or not all(isinstance(c, str) for c in caps)
                or not isinstance(diagnostics, list) or not all(isinstance(d, str) for d in diagnostics)):
                raise ProtocolError("malformed hello")
            self.hello.set_result(Hello(1, Binary(b["path"], b["version"]), tuple(caps), tuple(diagnostics)))
        elif kind == "response":
            request_id = message.get("id")
            if not isinstance(request_id, str) or not request_id:
                raise ProtocolError("response has no request id")
            if ("result" in message) == ("error" in message):
                raise ProtocolError("response must contain exactly result or error")
            p = self.pending.get(request_id)
            if p is None or p.future.done():
                return
            if "error" in message:
                error = message["error"]
                if (not isinstance(error, dict) or not isinstance(error.get("code"), str)
                    or not isinstance(error.get("message"), str)
                    or error.get("delivery") not in ("unknown", "not_sent")):
                    raise ProtocolError("malformed remote error")
                remote = RemoteError(error["code"], error["message"], error)
                p.future.set_exception(self._delivery(request_id, p, remote)
                                       if p.mutation and error["delivery"] == "unknown" else remote)
            elif not isinstance(message["result"], dict):
                raise ProtocolError("response result must be object")
            else:
                # Decode before resolving: malformed dispatched mutation results remain unknown.
                try:
                    _validate_result(p.method, message["result"])
                except (ValueError, KeyError, TypeError) as exc:
                    raise ProtocolError(f"malformed {p.method} result: {exc}") from exc
                p.future.set_result(message["result"])
        elif kind == "event":
            seq = message.get("seq")
            if type(seq) is not int or seq <= self.sequence:
                raise ProtocolError("invalid/nonmonotonic event sequence")
            message = dict(message)
            message["_gap"] = seq != self.sequence + 1
            self.sequence = seq
            if not isinstance(message.get("event"), str):
                raise ProtocolError("missing event name")
            if message["event"] == "state":
                State.from_wire(message["state"])
                if type(message["resynced"]) is not bool:
                    raise ProtocolError("invalid resynced flag")
            elif message["event"] in ("output_append", "turn"):
                if type(message["revision"]) is not int or message["revision"] < 1:
                    raise ProtocolError("invalid event revision")
                if message["event"] == "output_append" and (type(message["offset"]) is not int or message["offset"] < 0 or not isinstance(message["text"], str) or not message["text"]):
                    raise ProtocolError("invalid output append")
                if message["event"] == "turn" and message["turn"] is not None:
                    t = message["turn"]
                    if (not isinstance(t, dict) or not isinstance(t["id"], str) or not t["id"]
                        or (t["error"] is not None and not isinstance(t["error"], str))):
                        raise ProtocolError("invalid turn event")
                    TurnStatus(t["state"])
            self.publish(message)
        else:
            raise ProtocolError(f"unexpected frame type {kind!r}")


def _validate_result(method: str, d: dict[str, Any]) -> None:
    if method in ("create", "resume", "state"):
        State.from_wire(d["state"])
    elif method in ("submit", "enqueue", "interrupt", "interrupt_and_submit"):
        result = TurnResult.from_wire(d)
        allowed = {"submit": {"started", "rejected"}, "enqueue": {"queued", "rejected"},
                   "interrupt": {"interrupted", "rejected"},
                   "interrupt_and_submit": {"started", "rejected"}}[method]
        if result.disposition.value not in allowed:
            raise ValueError("invalid disposition for method")
        if result.disposition.value in ("started", "interrupted") and not result.turn_id:
            raise ValueError("successful operation missing turn id")
        if result.disposition.value == "queued" and result.turn_id is not None:
            raise ValueError("enqueue does not reserve a turn id")
        if (result.disposition.value == "rejected") != (result.reason is not None):
            raise ValueError("reason must be present only on rejection")
        if method == "interrupt_and_submit":
            if d["interrupted_turn_id"] is not None and not isinstance(d["interrupted_turn_id"], str):
                raise ValueError("invalid interrupted turn id")
    elif method == "approve":
        if type(d["approved"]) is not bool:
            raise ValueError("approved must be boolean")
    elif method == "detach":
        if d["detached"] is not True:
            raise ValueError("detach not acknowledged")
    elif method == "configure":
        _validate_configure(d)


class Client:
    """Owns session adapters, never the daemon. No subprocess is started at construction.

    Normal argv is exactly [executable, 'sdk', 'serve']; adapter_args exists for
    test adapters. No shell interpretation is ever performed.
    """
    def __init__(self, executable: str | os.PathLike[str] = "koma", *,
                 adapter_args: Sequence[str] = ("sdk", "serve"),
                 request_timeout: float = 30.0, close_timeout: float = 2.0,
                 event_capacity: int = 256):
        if request_timeout <= 0 or close_timeout <= 0 or not 1 <= event_capacity <= 256:
            raise ValueError("timeouts must be positive; event_capacity must be 1..256")
        self.executable = os.fspath(executable)
        self.adapter_args = tuple(adapter_args)
        self.request_timeout = request_timeout
        self.close_timeout = close_timeout
        self.event_capacity = event_capacity
        self._sessions: set[Session] = set()
        self._transports: set[_Wire] = set()
        self._closed = False

    async def __aenter__(self) -> Client:
        if self._closed:
            raise TransportError("client closed")
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    async def _connect(self, required: Sequence[str]) -> tuple[_Wire, Hello]:
        if self._closed:
            raise TransportError("client closed")
        try:
            process = await asyncio.create_subprocess_exec(
                self.executable, *self.adapter_args, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        except OSError as exc:
            raise TransportError(f"cannot launch {self.executable!r}: {exc}") from exc
        t = _Wire(process, event_capacity=self.event_capacity, close_timeout=self.close_timeout)
        self._transports.add(t)
        try:
            if self._closed:
                raise TransportError("client closed during subprocess startup")
            hello = await asyncio.wait_for(asyncio.shield(t.hello), self.request_timeout)
            missing = set(required) - set(hello.capabilities)
            if missing:
                raise IncompatibleAdapter(f"missing required capabilities: {', '.join(sorted(missing))}")
            return t, hello
        except BaseException:
            await t.close()
            if t.hello.done() and not t.hello.cancelled():
                t.hello.exception()
            self._transports.discard(t)
            raise

    async def probe(self, *, required_capabilities: Sequence[str] = ("create", "resume", "state", "detach")) -> Hello:
        """Read/validate unsolicited hello, then close that adapter without binding."""
        t, hello = await self._connect(required_capabilities)
        try:
            return hello
        finally:
            await t.close()
            self._transports.discard(t)

    async def create(self, cwd: str | os.PathLike[str], *, model_id: str | None = None,
                     policy: Policy = Policy(), external_approvals: bool = False) -> Session:
        cwd = os.fspath(cwd)
        if not os.path.isabs(cwd):
            raise ValueError("cwd must be absolute on daemon host")
        if policy.approval == ApprovalPolicy.DEFAULT and not external_approvals:
            raise ValueError("approval default requires external_approvals=True")
        params: dict[str, Any] = {"cwd": cwd, "policy": policy.to_wire(),
                                  "external_approvals": external_approvals}
        if model_id is not None:
            params["model_id"] = model_id
        return await self._bind("create", params)

    async def resume(self, session_id: str, *, policy: Policy | None = None,
                     external_approvals: bool = False) -> Session:
        if not session_id:
            raise ValueError("session_id must not be empty")
        params: dict[str, Any] = {"session_id": session_id, "external_approvals": external_approvals}
        if policy is not None:
            if policy.approval == ApprovalPolicy.DEFAULT and not external_approvals:
                raise ValueError("approval default requires external_approvals=True")
            params["policy"] = policy.to_wire()
        return await self._bind("resume", params)

    async def configure(self, *, providers: Sequence[Mapping[str, Any]] | None = None,
                        models: Mapping[str, Mapping[str, Any]] | None = None) -> dict[str, Any]:
        """Write providers and model roles before a session exists. No daemon is started."""
        params = _configure_params(providers, models)
        transport, _hello = await self._connect(("configure",))
        try:
            return await transport.request(
                "configure", params, mutation=True,
                envelope=lambda i, m, p: {"id": i, "method": m, "params": p},
                timeout=self.request_timeout)
        finally:
            await transport.close()
            self._transports.discard(transport)

    async def _bind(self, method: str, params: dict[str, Any]) -> Session:
        t, hello = await self._connect((method, "state", "detach"))
        session = Session(self, t, hello, external_approvals=params["external_approvals"])
        try:
            response = await session._request(method, params, mutation=True)
            session._update_state(State.from_wire(response["state"]))
            self._sessions.add(session)
            return session
        except BaseException:
            await t.close()
            self._transports.discard(t)
            raise

    async def close(self) -> None:
        self._closed = True
        await asyncio.gather(*(t.close() for t in tuple(self._transports)))
        self._transports.clear()
        self._sessions.clear()


class Session:
    def __init__(self, client: Client, transport: _Wire, hello: Hello, *, external_approvals: bool):
        self._client, self._transport, self.hello = client, transport, hello
        self._state: State | None = None
        self._external_approvals = external_approvals
        self._event_lock = asyncio.Lock()
        self._approval_lock = asyncio.Lock()

    @property
    def session_id(self) -> str:
        assert self._state is not None
        return self._state.session_id

    @property
    def stderr_tail(self) -> str:
        return self._transport.stderr.decode("utf-8", errors="replace")

    async def __aenter__(self) -> Session:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    async def _request(self, method: str, params: dict[str, Any], *, mutation: bool) -> dict[str, Any]:
        if method not in self.hello.capabilities:
            raise IncompatibleAdapter(f"adapter does not support {method}")
        try:
            return await self._transport.request(method, params, mutation=mutation,
                envelope=lambda i, m, p: {"id": i, "method": m, "params": p},
                timeout=self._client.request_timeout)
        except DeliveryUnknown as exc:
            if self._state is not None:
                exc.session_id = self._state.session_id
            raise

    def _update_state(self, state: State) -> State:
        if self._state is None or state.revision > self._state.revision:
            self._state = state
        return self._state

    async def get_state(self) -> State:
        result = await self._request("state", {}, mutation=False)
        return self._update_state(State.from_wire(result["state"]))

    async def events(self) -> AsyncIterator[Event]:
        """Single consumer; revisions/offsets prevent duplicate output after readback."""
        if self._event_lock.locked():
            raise RuntimeError("only one events iterator may consume a session")
        async with self._event_lock:
            if self._transport.restart_events():
                seq = self._transport.sequence
                state = await self.get_state()
                self._transport.finish_recovery(state.revision)
                yield StateEvent(seq, state, True)
            while True:
                e = await self._transport.next_event()
                if e["_gap"]:
                    yield StateEvent(e["seq"], await self.get_state(), True)
                    continue
                if e["event"] == "state":
                    state = State.from_wire(e["state"])
                    if self._state is None or state.revision > self._state.revision:
                        self._update_state(state)
                        yield StateEvent(e["seq"], state, e["resynced"])
                elif e["event"] == "output_append":
                    current = self._state
                    if current is not None and e["revision"] <= current.revision:
                        continue
                    if current is None or e["revision"] != current.revision + 1 or e["offset"] != len((current.streaming or "").encode("utf-8")):
                        yield StateEvent(e["seq"], await self.get_state(), True)
                    else:
                        self._state = replace(current, revision=e["revision"], streaming=(current.streaming or "") + e["text"])
                        yield OutputAppendEvent(e["seq"], e["revision"], e["offset"], e["text"])
                elif e["event"] == "turn":
                    t = e["turn"]
                    if self._state is not None and e["revision"] == self._state.revision:
                        yield TurnEvent(e["seq"], e["revision"], None if t is None else Turn(t["id"], TurnStatus(t["state"]), t["error"]))

    @staticmethod
    def _input(text: str, attachments: Sequence[Attachment]) -> dict[str, Any]:
        if not text.strip() or len(text.encode("utf-8")) > 2 * 1024 * 1024:
            raise ValueError("text must be nonblank and at most 2 MiB UTF-8")
        if len(attachments) > 16:
            raise ValueError("at most 16 attachments")
        wire = [a.to_wire() for a in attachments]
        # Image size/format is validated on daemon host, not on the SDK host.
        return {"text": text, "attachments": wire}

    async def submit(self, text: str, *, attachments: Sequence[Attachment] = ()) -> TurnResult:
        return TurnResult.from_wire(await self._request("submit", self._input(text, attachments), mutation=True))

    async def enqueue(self, text: str, *, attachments: Sequence[Attachment] = ()) -> TurnResult:
        return TurnResult.from_wire(await self._request("enqueue", self._input(text, attachments), mutation=True))

    async def interrupt(self, turn_id: str) -> TurnResult:
        if not turn_id:
            raise ValueError("turn_id must not be empty")
        return TurnResult.from_wire(await self._request("interrupt", {"turn_id": turn_id}, mutation=True))

    async def interrupt_and_submit(self, turn_id: str, text: str, *,
                                   attachments: Sequence[Attachment] = ()) -> ReplacementResult:
        if not turn_id:
            raise ValueError("turn_id must not be empty")
        params = self._input(text, attachments)
        params["turn_id"] = turn_id
        d = await self._request("interrupt_and_submit", params, mutation=True)
        r = TurnResult.from_wire(d)
        return ReplacementResult(r.disposition, r.turn_id, r.reason, d["interrupted_turn_id"])

    async def configure(self, *, providers: Sequence[Mapping[str, Any]] | None = None,
                        models: Mapping[str, Mapping[str, Any]] | None = None) -> dict[str, Any]:
        """Update providers or model roles on this live session. The next turn uses them."""
        return await self._request("configure", _configure_params(providers, models), mutation=True)

    async def approve(self, call_id: str, approve: bool) -> ApprovalResult:
        if not self._external_approvals:
            raise ValueError("external approvals were not opted in on create/resume")
        if not call_id or type(approve) is not bool:
            raise ValueError("approve requires a pending call ID and a boolean decision")
        async with self._approval_lock:
            result = await self._request("approve", {"call_id": call_id, "approve": approve}, mutation=True)
            return ApprovalResult(result["approved"])

    async def wait_turn(self, turn_id: str, *, timeout: float = 60.0, poll_interval: float = .1) -> Turn:
        """Observe terminal state, not goal success. Does not consume the event queue."""
        if not turn_id or timeout <= 0 or poll_interval <= 0:
            raise ValueError("turn_id and positive timeout/poll_interval required")
        observed = False
        try:
            async with asyncio.timeout(timeout):
                while True:
                    state = await self.get_state()
                    if state.turn is not None and state.turn.id == turn_id:
                        observed = True
                        if state.turn.state is not TurnStatus.RUNNING:
                            return state.turn
                    elif observed or state.turn is not None:
                        raise ObservationUnavailable(turn_id, "requested turn hidden by a newer/different turn")
                    await asyncio.sleep(poll_interval)
        except TimeoutError as exc:
            raise ObservationUnavailable(turn_id, "terminal state not observed before timeout; work may continue") from exc

    async def detach(self) -> DetachResult:
        try:
            result = await self._request("detach", {}, mutation=True)
            return DetachResult(result["detached"])
        finally:
            await self.close()

    async def close(self) -> None:
        await self._transport.close()
        self._client._transports.discard(self._transport)
        self._client._sessions.discard(self)
