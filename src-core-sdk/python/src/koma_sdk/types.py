"""Immutable public protocol DTOs. Unknown additive fields are ignored."""
from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
from typing import Any

class PlanPolicy(str, Enum):
    ALLOW = "allow"
    FORBID = "forbid"

class ApprovalPolicy(str, Enum):
    DEFAULT = "default"
    REJECT = "reject"

class TurnStatus(str, Enum):
    RUNNING = "running"
    FINISHED = "finished"
    INTERRUPTED = "interrupted"
    FAILED = "failed"

class Disposition(str, Enum):
    STARTED = "started"
    QUEUED = "queued"
    INTERRUPTED = "interrupted"
    REJECTED = "rejected"

class Role(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"

@dataclass(frozen=True)
class Policy:
    plan: PlanPolicy = PlanPolicy.FORBID
    approval: ApprovalPolicy = ApprovalPolicy.REJECT
    def to_wire(self) -> dict[str, str]:
        return {"plan": PlanPolicy(self.plan).value, "approval": ApprovalPolicy(self.approval).value}

@dataclass(frozen=True)
class Binary:
    path: str
    version: str

@dataclass(frozen=True)
class Hello:
    protocol: int
    binary: Binary
    capabilities: tuple[str, ...]
    diagnostics: tuple[str, ...]

@dataclass(frozen=True)
class Turn:
    id: str
    state: TurnStatus
    error: str | None

@dataclass(frozen=True)
class Message:
    role: Role
    content: str

@dataclass(frozen=True)
class PendingApproval:
    call_id: str
    reason: str | None

class GateKind(str, Enum):
    TOOL = "tool"
    PLAN = "plan"
    MISSION = "mission"
    UNKNOWN = "unknown"

@dataclass(frozen=True)
class Gate:
    kind: GateKind
    reason: str | None
    supported: bool

@dataclass(frozen=True)
class State:
    session_id: str
    revision: int
    external_approvals: bool
    pending_approval: PendingApproval | None
    gate: Gate | None
    cwd: str
    model_id: str
    policy: Policy
    turn: Turn | None
    working: bool
    awaiting_approval: bool
    approval_reason: str | None
    pending_count: int
    messages: tuple[Message, ...]
    streaming: str | None
    @classmethod
    def from_wire(cls, d: dict[str, Any]) -> State:
        if not isinstance(d, dict):
            raise ValueError("state must be object")
        for key in ("session_id", "cwd", "model_id"):
            if not isinstance(d[key], str):
                raise ValueError(f"{key} must be string")
        for key in ("working", "awaiting_approval", "external_approvals"):
            if type(d[key]) is not bool:
                raise ValueError(f"{key} must be boolean")
        if type(d["revision"]) is not int or not 1 <= d["revision"] <= 9007199254740991:
            raise ValueError("invalid revision")
        if type(d["pending_count"]) is not int or not 0 <= d["pending_count"] <= 5:
            raise ValueError("invalid queue count")
        for key in ("approval_reason", "streaming"):
            if d[key] is not None and not isinstance(d[key], str):
                raise ValueError(f"invalid {key}")
        if not isinstance(d["messages"], list) or any(not isinstance(m["content"], str) for m in d["messages"]):
            raise ValueError("invalid messages")
        t, a, g = d["turn"], d["pending_approval"], d["gate"]
        if t is not None and (not isinstance(t["id"], str) or not t["id"] or (t["error"] is not None and not isinstance(t["error"], str))):
            raise ValueError("invalid turn")
        if a is not None and (not isinstance(a["call_id"], str) or not a["call_id"] or (a["reason"] is not None and not isinstance(a["reason"], str))):
            raise ValueError("invalid pending approval")
        if g is not None and (type(g["supported"]) is not bool or (g["reason"] is not None and not isinstance(g["reason"], str))):
            raise ValueError("invalid gate")
        return cls(d["session_id"], d["revision"], d["external_approvals"],
                   None if a is None else PendingApproval(a["call_id"], a["reason"]),
                   None if g is None else Gate(GateKind(g["kind"]), g["reason"], g["supported"]),
                   d["cwd"], d["model_id"],
                   Policy(PlanPolicy(d["policy"]["plan"]), ApprovalPolicy(d["policy"]["approval"])),
                   None if t is None else Turn(t["id"], TurnStatus(t["state"]), t["error"]),
                   d["working"], d["awaiting_approval"], d["approval_reason"], d["pending_count"],
                   tuple(Message(Role(m["role"]), m["content"]) for m in d["messages"]), d["streaming"])

@dataclass(frozen=True)
class StateEvent:
    seq: int
    state: State
    resynced: bool = False

@dataclass(frozen=True)
class OutputAppendEvent:
    seq: int
    revision: int
    offset: int
    text: str

@dataclass(frozen=True)
class TurnEvent:
    seq: int
    revision: int
    turn: Turn | None

Event = StateEvent | OutputAppendEvent | TurnEvent

@dataclass(frozen=True)
class Reason:
    code: str
    message: str

@dataclass(frozen=True)
class TurnResult:
    disposition: Disposition
    turn_id: str | None
    reason: Reason | None
    @classmethod
    def from_wire(cls, d: dict[str, Any]) -> TurnResult:
        r = d["reason"]
        if d["turn_id"] is not None and (not isinstance(d["turn_id"], str) or not d["turn_id"]):
            raise ValueError("invalid turn id")
        if r is not None and (not isinstance(r, dict) or not isinstance(r["code"], str) or not isinstance(r["message"], str)):
            raise ValueError("invalid rejection reason")
        return cls(Disposition(d["disposition"]), d["turn_id"], None if r is None else Reason(r["code"], r["message"]))

@dataclass(frozen=True)
class ReplacementResult(TurnResult):
    interrupted_turn_id: str | None

@dataclass(frozen=True)
class ApprovalResult:
    approved: bool

@dataclass(frozen=True)
class DetachResult:
    detached: bool

@dataclass(frozen=True)
class ImageFile:
    path: str
    def to_wire(self) -> dict[str, str]:
        import os
        if not os.path.isabs(self.path):
            raise ValueError("image path must be absolute on daemon host")
        return {"kind": "image_file", "path": self.path}

@dataclass(frozen=True)
class PastedText:
    text: str
    name: str | None = None
    def to_wire(self) -> dict[str, Any]:
        if len(self.text.encode("utf-8")) > 2 * 1024 * 1024:
            raise ValueError("pasted text exceeds 2 MiB")
        return {"kind": "pasted_text", "text": self.text, "name": self.name}

Attachment = ImageFile | PastedText
