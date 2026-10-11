# Coding notebooks

Everyday `.ipynb` support in the Coding IDE. Document authority stays on the existing `coding.files` buffer (same dirty/save/fingerprint/recovery path as ordinary files). Tab kind remains `codingFile`; the router branches `.ipynb` to `NotebookTab`.

## Status

| Milestone | State |
|-----------|--------|
| M0 boundary | Shipped — no ordinary LSP / format-on-save / kernel on open |
| M1 cell editor | Shipped — lossless span JSON, cells + raw fallback, autosave |
| M2 analysis | **Unavailable** until a real `notebookDocumentSync` probe passes (`notebook-analysis.ts`) |
| M3 kernel | Native supervisor spike + containment tests; **Run UI still disabled** |
| M4 outputs | Policy module shipped; HTML blocked until sandboxed renderer |

## Architecture

```text
NotebookTab
  └── NotebookController  (parse + history + epoch CAS)
        └── updateNotebookText → coding.files[key]   // sole saved-text authority
              └── saveCodingFile / formatBeforeSave bypass for .ipynb

M0 gates
  coding-disk.ts     no LspDidChange for notebooks
  push/coding.ts     no LspDidSave/Change after notebook save
  tabs.ts            no LspDidClose; dispose controller on force-close
  monaco-lsp.ts      notebook cell/raw schemes refused by modelToRootPath
  CodeEditorTab      defensive isNotebookPath skip on LspDidOpen

M3 native (coding/notebook.rs)
  launch only: {interpreter} -m ipykernel_launcher -f {connection_file}
  never metadata.kernelspec.argv
  connection file: private dir, owner-only, loopback, keys native-only
  Unix process group / Windows job object
  has_active() → ServiceInfo activeJobs + daemon idle gate
  consent(workspace, interpreter, path, documentEpoch) before start
```

## Frontend modules

| Path | Role |
|------|------|
| `lib/notebook-workspace.ts` | Host-bound buffer adapter + content/epoch CAS |
| `lib/notebook-document.ts` | Span-preserving JSON mutations |
| `lib/notebook-identity.ts` | Runtime cell ids (no dirty-on-open repair) |
| `lib/notebook-history.ts` | Structural undo stack |
| `lib/notebook-controller.ts` | Open-document controller registry |
| `lib/notebook-output-policy.ts` | Safe output classification (M4) |
| `lib/notebook-analysis.ts` | M2 capability gate |
| `lib/coding-autosave.ts` | Shared 750 ms document autosave |
| `components/NotebookTab.tsx` | Cell UI + raw JSON + Unavailable Run/Analysis |

## Native RPC (Coding service)

Ops (camelCase on the wire): `notebookConsent`, `notebookKernelStart`, `notebookKernelStop`, `notebookKernelInterrupt`, `notebookKernelRestart`, `notebookKernelRelease`, `notebookKernelStatus`, `notebookIpykernelProbe`.

Hello capability token: `notebook`.

## Size policy

- Editable cell UI budget: **4 MiB** UTF-8 serialized notebook
- Oversized / invalid JSON: raw editor only; never silently strip outputs
- Host text read/save cap remains 5 MiB

## Security notes

- `metadata.trusted` grants nothing
- Notebook markdown preview must not resolve workspace images (M4)
- HTML outputs blocked until DOMPurify + opaque sandboxed iframe path ships
- Connection keys and ports never appear in frontend payloads or cell outputs

## Verification

```bash
cd src-webgui && npm run test:logic -- src/lib/notebook
cargo test -p agent --no-default-features coding::notebook
cargo test -p agent --no-default-features app::runtime::client::file_ops::tests
```
