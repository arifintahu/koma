# Koma partner SDKs

Phase one provides Python 3.11+ (`koma_sdk`) and Node.js 22+ JavaScript/TypeScript
(`@koma/sdk`) clients for an **installed Koma executable**. These packages are
local/artifact installations, not a claim that either name is published on PyPI
or npm. No SDK installer downloads, updates, or builds Koma.

## Install the engine separately

On macOS/Linux, use the same installer as the root README:

```sh
curl -fsSL https://koma.run/install.sh | sh
```

The Unix installer installs to `~/.local/bin`; ensure that directory is on PATH.
On Windows, use PowerShell (the installer downloads and runs the MSI):

```powershell
irm https://koma.run/install.ps1 | iex
```

The MSI is the canonical Windows package. Security tools and full-internet/research
mode are not supported on Windows. Other execution and security limitations of
Koma also apply to SDK sessions; the SDK is not a sandbox.

Verify the installed executable:

```sh
koma --version
koma sdk --help
```

Older released binaries may not contain `sdk serve`. Manually install an SDK-capable
release before using these clients. An SDK compatibility probe checks the public
protocol; it does not upgrade an incompatible engine. Both clients accept an
explicit executable path when PATH is unsuitable. See their package guides for
that option and exact API examples.

Configure provider/model credentials through Koma's existing configuration flow
before running real inference. The SDK does not expose credentials or a global
configuration API. Partner quickstarts require no Cargo, Bun, terminal preparation,
or Koma source compilation.

## Install a client

Python, from a checkout or a manually supplied wheel:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install /path/to/koma/src-core-sdk/python
# Or: python -m pip install /path/to/koma_sdk-0.1.0-py3-none-any.whl
```

On Windows activate with `.venv\Scripts\Activate.ps1` in PowerShell.
See [Python](python/README.md) for async context managers, events, and examples.

JavaScript/TypeScript consumers install a manually supplied package tarball:

```sh
npm install /path/to/koma-sdk-0.1.0.tgz
```

The same ESM package contains JavaScript and TypeScript declarations; there is no
separate JavaScript implementation. See [JavaScript/TypeScript](typescript/README.md)
for the exact build/package commands and runnable examples.

## Architecture and safety boundaries

```text
Python / JavaScript / TypeScript application
             │ subprocess stdio JSONL, public protocol v1
             ▼
installed `koma sdk serve` (one selected session per adapter)
             │ existing private framed IPC, socket / named pipe
             ▼
session daemon (agent, tools, persistence)
```

Each session connection owns an adapter subprocess. Clients may hold several
sessions. `koma server` remains the private framed bridge, unchanged. The public
adapter is part of the normal executable, not a new HTTP server, daemon extraction,
native library, or additional binary. See [the protocol contract](protocol/CONTRACT.md).

New bot sessions default to plan forbidden and approval reject. **Reject denies
approval-requiring gates; it is not an allowlist, does not deny every tool, and is
not a sandbox.** External tool approvals require explicit opt-in and the actual
pending call ID. General plan/mission approval targeting is not supported; unexpected
gates remain visible rather than being approved automatically. Resume does not
implicitly alter cwd, policy, or persisted configuration. Policy readback confirms
the observed value, not an exclusive lease against another controller.

Submission owns its attachments and never consumes another client's composer.
Images are absolute local paths on the daemon host. Pasted text is UTF-8 with an
optional display name. Limits: 16 attachments, 32 MiB aggregate, 2 MiB per pasted
text, nonblank primary prompt. There is no binary upload, base64 image transport,
remote transfer, or URL fetching API.

Enqueue reports admission, not a future turn ID. The existing queue admits up to
five pending entries, requires an eligible active turn, preserves FIFO order, and
can coalesce follow-ups. It does not guarantee one completed turn per enqueue.
Replacement preserves the interrupted turn ID even if the replacement cannot start.

## Observation and delivery

Output consumers must handle authoritative replacements as well as proven suffix
appends, checking revisions/offsets. Transcript-position keys are connection-local,
not durable message IDs. Sequence gaps cause resync and state replacement; the
SDK does not reconstruct the TUI or promise exhaustive provider/tool/subagent events.
`finished` means execution ended normally, not that the coding goal succeeded.

The daemon exposes the active or most recently observed turn, not a history. A
newer turn may hide a requested terminal record. Wait helpers have bounded waits
and must report observation unavailable/unknown rather than guessing completion.
There is no durable lifecycle journal or event replay.

If a mutation was written but its result is lost, the client reports delivery
unknown with available request/session/turn IDs and **never automatically retries**.
Resume reads current state; it is not deduplication or guaranteed replay. A local
await timeout/cancellation does not stop a turn. Use explicit targeted interruption.

Detach, client close, EOF, and stopping event iteration do not interrupt work,
quit the daemon, or delete the persisted session. Daemon work can continue after
the adapter exits. Event/stderr buffers are bounded; overflow/disconnection is an
explicit observation failure, not a silently dropped control result.

## Maintainers only

Build the Koma executable using the root README's prepared-payload/locked Cargo
procedure. Retain `target/terminal`; do not make SDK consumers prepare or compile it.
Build Python wheels and npm tarballs using each package's maintainer instructions.
Shared fake-adapter fixtures live in [conformance](conformance/); these need no
provider call. Provider-backed end-to-end tests require configured credentials and
an intentional inference run. Platform support in source is not proof of Windows
or Linux runtime testing; consult the actual verification report.

Registry publication, other language clients, durable result storage, request
deduplication, guaranteed per-follow-up completion, general plan/mission approval
targeting, sandboxing, and full workload revocation are outside phase one.
