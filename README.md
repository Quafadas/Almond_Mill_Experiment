# Scala Notebook Shadow (POC)

Implements [Concept #1](https://github.com/Quafadas/Almond_Mill_Experiment/issues/1): show Metals
compile diagnostics as squiggles inside the cells of a `.ipynb` notebook in VS Code, without
modifying Metals or Mill, by concatenating a notebook's Scala cells into a hidden Mill "shadow"
script and remapping the diagnostics VS Code reports for that file back onto the cell URIs.

## Try it yourself

These steps assume Windows + WSL2, with VS Code on Windows and the **WSL** extension installed, and
Node 20+ available inside WSL. Everything below runs inside WSL — do this from a folder on the
Linux filesystem (e.g. `~/...`), not under `/mnt/c`.

1. **Clone and build the extension.**
   ```bash
   git clone https://github.com/Quafadas/Almond_Mill_Experiment.git
   cd Almond_Mill_Experiment/scala-notebook-shadow
   npm install
   npm run compile
   npm test        # optional: confirms the 16 unit tests pass, no VS Code needed for this step
   ```

2. **Open the extension project in VS Code, connected to WSL.**
   ```bash
   code .
   ```
   (or `code --remote wsl+<distro> .` from Windows). Confirm the bottom-left corner shows a
   `WSL: <distro>` indicator.

3. **Launch the Extension Development Host.** With `scala-notebook-shadow/` open as the workspace,
   press `F5` (or Run ▸ Start Debugging). A second VS Code window opens with the extension loaded —
   do all remaining steps in *that* window.

4. **Open the fixture workspace** in the Extension Development Host: File ▸ Open Folder ▸ pick this
   repo's `fixture/` directory.

5. **Install Metals** in that window if it isn't already there (Extensions ▸ search
   `scalameta.metals` ▸ Install). It should auto-detect `build.mill.yaml` and offer to use Mill as
   the build server.

6. **Import the build.** Open Command Palette (`Ctrl+Shift+P`) ▸ **Metals: Import Build**, and wait
   for it to finish (watch the Metals item in the status bar). This step is required — see the
   Phase 0 findings below for why.

7. **Open `fixture/sample.ipynb`.** If VS Code prompts for a kernel, you can dismiss it — no kernel
   needs to be installed or selected for diagnostics to work.

8. **Inspect the shadow file.** Command Palette ▸ **Scala Notebook: Open Shadow File** to see the
   generated `notebook-shadow/sample.scala`, or just look at it directly in the file explorer.

9. **Exercise the acceptance checklist** (see below): edit cell 2 to introduce/fix a type error,
   watch the squiggle move with it; add a markdown cell and confirm nothing shifts incorrectly;
   close and reopen the notebook and confirm squiggles come back without duplicating the shadow
   file.

If squiggles don't show up after adding a dependency via `import $ivy` or after any other edit to
the shadow file's `//|` header, re-run **Metals: Import Build** — and if that alone doesn't clear
it, a full clean of the module was needed during Phase 0 testing too (see findings below). This is
a known Metals/Mill limitation, not a bug in the extension.

**Trying it against your own notebook instead of the fixture:** open any workspace that has a
`build.mill` or `build.mill.yaml` at its root, add/open a `.ipynb` file with Scala code cells in it,
and the extension activates automatically (`onNotebook:jupyter-notebook`) — no fixture-specific
wiring involved. Adjust `scalaNotebook.*` settings (see below) to match your project's Scala
version and dependencies.

This repo has two parts:

- [`scala-notebook-shadow/`](scala-notebook-shadow/) — the VS Code extension.
- [`fixture/`](fixture/) — a throwaway Mill + notebook workspace used for Phase 0 probing and for
  manually running the acceptance checklist below.

## Phase 0 findings

Phase 0 (issue §3) was done by hand, in VS Code against WSL2 + Mill + Metals, before any code was
written. Answers, as recorded on the issue:

| Question | Finding |
|---|---|
| Does Metals report the error without any extra step? | **No.** Running `Metals: Import Build` is necessary before diagnostics for a freshly created script appear. |
| Does the script need to be run once via `./mill <path>:compile` before Metals reports diagnostics? | **No**, once the build has been imported, diagnostics are reported without ever running the compile task. |
| Does a directory name starting with `.` (e.g. `.notebook-shadow/`) still get picked up? | **No.** The dot-prefixed directory made the source file invisible to Mill — it was not compiled. The extension therefore defaults `shadowDir` to the non-hidden `notebook-shadow/`. |
| Is a newly-added script file (e.g. a second notebook's shadow file) picked up automatically? | **No.** A reimport (`Metals: Import Build`) is needed for Metals/Mill to notice a new script file. |
| Does changing the `//|` header (e.g. adding an `mvnDeps` entry) just need a reimport? | **No — it needs a "clean" of the module.** A plain reimport was observed to be insufficient after editing header directives; the module had to be cleaned as well. |
| Which `source` does Metals put on the diagnostics (PC vs BSP)? | **Not conclusively determined during Phase 0** — left as an open question; see "Known limitations" below. |

These findings directly shaped the design:

- The extension does **not** try to fully automate reimports or module cleans — per issue §8
  acceptance criterion 6, where a reimport is needed the POC documents the manual step
  (`Metals: Import Build`, and occasionally a clean) rather than scripting it, since driving Metals'
  own commands reliably from another extension was explicitly out of scope.
- `scalaNotebook.compileOnCreate` (default `false`) exists per issue §5 step 1b but, per the Phase 0
  finding above, is not required for diagnostics to appear once a build is imported — it is provided
  as an escape hatch, not a requirement.
- `shadowDir` defaults to `notebook-shadow` (no leading dot).

## How to run

Requires Node 20+, and a VS Code window connected to a WSL2 remote (per issue §2).

```bash
cd scala-notebook-shadow
npm install
npm run compile   # or: npm run watch
npm test          # unit tests for transform.ts / mapping.ts, no extension host needed
```

Then press F5 in VS Code (with `scala-notebook-shadow/` open as the workspace) to launch an
Extension Development Host. Open the `fixture/` folder in that host window, let Metals import the
build, then open `fixture/sample.ipynb`.

Useful commands (Command Palette):

- **Scala Notebook: Open Shadow File** — reveals the shadow `.scala` file for the active notebook.
- **Scala Notebook: Regenerate Shadow File** — forces regeneration + save, bypassing the
  unchanged-text short-circuit.

## Settings

| Setting | Type | Default | Notes |
|---|---|---|---|
| `scalaNotebook.scalaVersion` | string | `"3.7.2"` | Written into `//| scalaVersion`. Must match the kernel you run, otherwise phantom errors. |
| `scalaNotebook.mvnDeps` | string[] | `[]` | Mill coordinates, e.g. `com.lihaoyi::upickle:4.0.2`. Merged with `$ivy` lines found in cells. |
| `scalaNotebook.preamble` | string[] | `[]` | Lines inserted after the header (e.g. Almond predef imports, once the Almond API artifact is in `mvnDeps`). |
| `scalaNotebook.shadowDir` | string | `"notebook-shadow"` | Relative to the first workspace folder. |
| `scalaNotebook.debounceMs` | number | `400` | Debounce between a notebook edit and shadow regeneration. |
| `scalaNotebook.compileOnCreate` | boolean | `false` | Runs `./mill <shadowPath>:compile` once when a shadow file is first created. See Phase 0 findings — not required in practice, kept as an escape hatch. |

## Repo layout

```
scala-notebook-shadow/
  src/
    transform.ts       # pure: (cells, config) -> { text, mapping }
    mapping.ts          # pure: lineToSpan, translateDiagnostic, groupByCellUri
    shadowManager.ts     # per-notebook state: create/open/regenerate/close
    relay.ts             # onDidChangeDiagnostics handler
    extension.ts          # activate(): wires listeners, commands, collection
  test/
    transform.test.ts    # determinism, header sizing, $ivy rewrite, trailing newline, mapping arithmetic
    mapping.test.ts       # span lookup, clamping, outside-cell attachment, relatedInformation
fixture/
  mill                     # official Mill bootstrap launcher, pinned via .mill-version (1.1.8)
  build.mill.yaml           # near-empty; only exists so Metals picks Mill as the build server
  notebook-shadow/
    Probe.scala             # Phase 0 probe (issue §3 step 1)
    Probe2.scala             # Phase 0 probe (issue §3 step 5, "second file")
  sample.ipynb                # 4-cell notebook used for the acceptance checklist (issue §8)
```

`transform.ts` and `mapping.ts` only take `import type * as vscode from "vscode"` (erased at
compile time), so they have no runtime dependency on the `vscode` module and run under plain
`node --test`.

## Acceptance checklist (issue §8)

| # | Criterion | Status |
|---|---|---|
| 1 | Opening the notebook creates `notebook-shadow/sample.scala` with the §4 layout | Implemented (`shadowManager.openForNotebook`); needs a live VS Code + Metals session to observe |
| 2 | Cell 2 shows a type-mismatch, cell 3 shows "not found", cells 0/1 clean | Depends on Metals/Mill compiling the shadow file — not verifiable outside a running extension host in this environment |
| 3 | Fixing cell 2 clears its squiggle, cell 3's remains | Same as above — relies on live diagnostics |
| 4 | Inserting a markdown cell doesn't change reported diagnostics, mapping shifts correctly | Covered by unit test (`transform.test.ts`: "markdown and non-scala cells are skipped entirely") for the mapping-shift part; live squiggle behavior needs manual verification |
| 5 | An error on cell 1's second line squiggles at line 1, not line 0 or another cell | Covered by unit test (`mapping.test.ts` translateDiagnostic tests) for the line-arithmetic part; live verification needed |
| 6 | `import $ivy` cell: header gains the dep, line is commented in place, no error after reimport | Transform behavior covered by unit tests (`transform.test.ts` $ivy tests); per Phase 0, a manual `Metals: Import Build` (possibly plus a clean) is required and is **not** automated — this is a documented manual step, not a bug |
| 7 | Closing/reopening the notebook clears then restores squiggles without duplicating the shadow file | Implemented (`closeForNotebook` clears diagnostics and drops state; `openForNotebook` no-ops if the file already exists and reconciles `appliedText` from disk) — needs live verification |
| 8 | Unit tests pass | **Pass** — 16/16 (`npm test` in `scala-notebook-shadow/`) |

Everything gated on "needs a live VS Code + Metals + Mill session" could not be executed in this
environment (no VS Code extension host / Metals server available here); the code paths implementing
each behavior are in place and exercised as far as they can be without that host.

## Known limitations / deviations

- The diagnostic `source` field question in Phase 0 (`"metals"` vs `"bloop"`/`"mill"`) was left
  unanswered by manual testing; the relay code doesn't special-case `source`, it just passes it
  through untranslated, so this has no functional impact but is worth confirming later.
- Per issue §5 step 3, the relay does not attempt to reconcile a diagnostics event against a stale
  shadow mapping version — if diagnostics arrive for an older shadow revision than the current
  mapping, they may be mis-positioned. Accepted for the POC, as specified.
- Reimports/cleans required by Mill/Metals (new shadow file, or an edited `//|` header) are surfaced
  to the user as a manual step (via the existing Metals commands), not automated — consistent with
  the issue's explicit scope boundary.
- `compileOnCreate` invokes `./mill <path>:compile` via a plain child process with no timeout or
  output surfaced beyond an output channel; adequate for a POC, not for production use.

## Things Phase 0 got wrong relative to initial assumptions (§10)

This is the most valuable output of the POC, per the issue:

1. **A reimport is required more often than expected** — not just once per workspace, but on every
   new shadow file (i.e., effectively once per newly-opened notebook), and again whenever the
   `//|` header changes shape (new `mvnDeps` entries).
2. **A reimport alone is not enough after a header change** — a full module **clean** was needed,
   which is a heavier, more disruptive operation than initially assumed and makes the "add a
   dependency via `import $ivy`" acceptance flow (§8 item 6) noticeably less smooth than plain
   concatenation would suggest.
3. **Hidden directories are actively harmful, not just untested** — a `.`-prefixed shadow directory
   doesn't merely "not get picked up automatically"; the file becomes invisible to Mill outright and
   is never compiled, confirming the shadow directory must be a normal, visible directory.
