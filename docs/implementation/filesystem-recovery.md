# Filesystem recovery

Structured inspection paths normalize separators before resolution and containment
checks. Bare paths use workspace 0; `[N]` selects another root. Absolute workspace
paths retain native filesystem case behavior. Read-only resolution no longer
searches another workspace when the requested file is absent. Existing session,
skill, scratch, mode, activation, and approval restrictions still apply.

`dir_list` reads the resolved directory one level deep using the index's ignore
and generated-directory pruning rules. It caps ordinary listings at 500 entries
and distinguishes empty directories from excluded entries. The file index remains
available for file discovery and autocomplete. Glob validates its base before
using the index and limits indexed matches to that resolved subtree.

`read`, `dir_list`, `grep`, and `glob` share typed failure handling through their
existing `Tool::run` methods, including direct and delegated execution. Missing
paths, wrong target types, and access denials receive a bounded finding. One
nearest authorized ancestor can contribute at most 30 visible entries. Access
denials do not trigger sibling enumeration. Exempt read paths outside configured
workspaces retain access without ancestor recovery.

The session's shared `CallTrack` serializes inspections and retains at most 128
failed records, evicting the oldest. Identity includes tool, canonical arguments,
resolved target, workspace/CWD, index generation, and target/ancestor metadata.
An unchanged repeat returns its prior evidence before executing the tool. User
submissions, delivered follow-ups, workspace changes, explicit index refreshes,
and successful structured file mutations clear the records. Index generations
and relevant metadata changes also permit fresh attempts. Successful searches
without matches and unrelated errors do not create failure records.

Exact foreground model commands `ls`, `ls -l`, `ls -a`, `ls -la`, `ls -al`, and
`dir` run through the same deferred/direct shell implementation. Failure retains
the shell's original output and exit status; native CWD evidence is labeled
separately. Commands with additional syntax, background jobs, and user shell
shortcuts retain their existing routes. Recovery output bypasses duplicate-output
stubs, preserving bounded guidance and the tail of long failure evidence.

Regression coverage includes native Windows absolute and mixed-separator paths.
The CI Windows runner explicitly runs recovery tests before the complete Rust
suite. Local macOS verification cannot establish native Windows behavior; the
Windows CI job remains required platform evidence. No settings or stored-data
migration is introduced.
