"""Transport failures are distinct from adapter operation failures."""
from __future__ import annotations


class SDKError(Exception):
    """Base SDK exception."""


class TransportError(SDKError):
    """Adapter transport is unavailable or malformed."""


class ProtocolError(TransportError):
    pass


class IncompatibleAdapter(ProtocolError):
    pass


class EventOverflow(TransportError):
    """The bounded event inbox overflowed. Restart event consumption to reconcile state."""


class RequestTimeout(TransportError):
    pass


class DeliveryUnknown(TransportError):
    """A mutation was written but its result is unknown; NEVER replay blindly."""

    def __init__(self, request_id: str, method: str, *, session_id: str | None = None,
                 turn_id: str | None = None, cause: BaseException | None = None):
        self.request_id = request_id
        self.method = method
        self.session_id = session_id
        self.turn_id = turn_id
        self.cause = cause
        super().__init__(f"Delivery unknown for {method} ({request_id}); reconcile state before retrying")


class RemoteError(SDKError):
    def __init__(self, code: str, message: str, data: object = None):
        self.code = code
        self.message = message
        self.data = data
        super().__init__(f"{code}: {message}")
