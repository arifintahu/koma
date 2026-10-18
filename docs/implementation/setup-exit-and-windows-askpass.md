# Setup exit and Windows SSH password authentication

The OpenTUI setup screen must exit when its daemon accepts a quit action. A closed
socket alone cannot distinguish that intent from a crash.

`MenuResult.exit` is an additive boolean, absent when false and defaulting to false
when deserializing old replies. The daemon sets it only for a successful menu
action that requests application exit. Shutdown waits up to one second for the
exiting client to consume its response and send `Detach` or close its connection
before cancelling the runtime. Further requests are not applied
once shutdown is committed.

The terminal honors exit only on a correlated successful menu reply, then detaches
and invokes its normal exit callback. Other connection failures close pending
operations, disable writes, and show the original error even if a prior snapshot
exists. A full-screen suspended state offers exactly Restart and Exit. Restart reconnects
the same session (starting its local daemon if needed); remote sessions restart
the SSH helper with their last session ID. Exit, Escape, and Ctrl+C close the CLI
without waiting for a daemon response.
Keyboard Ctrl+C and SIGINT use the same session callback. Live chat retains its
existing quit/approval rules, and nested setup Escape remains daemon-owned.

On Windows, `SSH_ASKPASS` points to the native Koma executable. Its early helper
entry point is selected by `KOMA_SSH_ASKPASS_PIPE` and authenticates using
`KOMA_SSH_ASKPASS_TOKEN`. Neither variable contains the password. Each auth context
owns a random, locally accessible named pipe using the IPC transport's protected
DACL, which excludes Everyone and Anonymous. Askpass pipes are excluded from
session discovery. The helper accepts password/passphrase prompts only; it does
not answer host-key verification prompts.

The worker checks the random token, writes a length-prefixed UTF-8 password, and
waits for receipt acknowledgement before closing that connection. Exchanges time
out after five seconds. Dropping the auth context cancels the worker, releases the
pipe, and clears its password copy. Unix keeps its existing owner-only script.
All three SSH command adapters use the same platform helper.

Verification:

- `src-term/src/session-lifecycle.test.tsx`: actual rendered setup keyboard input,
  correlated exit, signal callback, connection errors, and pending-operation cleanup.
- Rust daemon tests: setup navigation versus exit, nested editor Escape, and old/new
  response serialization.
- `python src-term/scripts/verify-setup-exit.py`: isolated real daemon exit replies
  and shutdown over Unix sockets or Windows named pipes. Build the debug binary first.
- `koma.exe --ssh-askpass-self-test`: Windows executable launch, command adapters,
  repeated requests, Unicode/secrets containing shell punctuation, executable paths
  with spaces, prompt/token rejection, cleanup, and a stalled-response timeout.

CI runs the real daemon check on every supported platform and the native helper
check on Windows. macOS-only local verification does not establish native Windows
behavior or authentication against a live SSH host. No settings or stored
credential formats change.
