# Scala Notebook Shadow (POC)

[![CI](https://github.com/Quafadas/Almond_Mill_Experiment/actions/workflows/ci.yml/badge.svg)](https://github.com/Quafadas/Almond_Mill_Experiment/actions/workflows/ci.yml)

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
| Which file does Metals report diagnostics against? | **Mill's generated copy**, not the shadow file — e.g. `.bsp/out/notebook-shadow/sample.scala/allSourceFiles.dest/sample.scala`. Mill compiles a copy with two marker lines prepended, so the relay resolves that path back to the shadow file and subtracts the offset (`generatedSource.ts`). Without this the relay saw no diagnostics at all and no squiggles reached the cells. |
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
npm run lint      # ESLint, type-aware; `npm run lint:fix` applies the fixable ones
npm run typecheck # tsc --noEmit
```

Then press F5 in VS Code (with `scala-notebook-shadow/` open as the workspace) to launch an
Extension Development Host. Open the `fixture/` folder in that host window, let Metals import the
build, then open `fixture/sample.ipynb`.

Useful commands (Command Palette):

- **Scala Notebook: Open Shadow File** — reveals the shadow `.scala` file for the active notebook.
- **Scala Notebook: Regenerate Shadow File** — forces regeneration + save, bypassing the
  unchanged-text short-circuit.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:

- **Lint and typecheck** — `npm run lint` (ESLint 9 flat config, type-aware rules from
  `typescript-eslint`) and `tsc --noEmit`.
- **Test** — `npm test` on Node 22 and 24, on Linux and macOS. `pretest` compiles, so a green test
  job also proves the build.
- **Package VSIX** — `vsce package` after lint and test pass, uploading the `.vsix` as a build
  artifact. Nothing is published to the Marketplace; the artifact is there to install by hand
  (`code --install-extension scala-notebook-shadow-<version>.vsix`).

Pushing a `v*` tag runs the same three jobs and then a **Release** job, which attaches the `.vsix`
to a GitHub Release (marked pre-release) with generated notes. The tag must match `version` in
`package.json` or the packaging step fails, and — because GitHub reads workflow files from the ref
being built — the tagged commit must itself contain `.github/workflows/ci.yml`.

Nothing in CI runs Metals or Mill: the fixture build needs a JDK, a Metals import and generated
shadow scripts, so everything it would cover stays on the manual-verification checklist below.
Dependency updates come in via `.github/dependabot.yml` (npm + GitHub Actions, weekly).

## Shadow file layout

Every notebook becomes one Mill script. Cell bodies are copied in verbatim — never re-indented —
one line per source line, so a cell's line *N* is always the shadow's line `span.startLine + N`:

```scala
//| scalaVersion: 3.7.2
//| repositories:                                  # JitPack for the prelude, plus `import $repo`
//| - https://jitpack.io
//| mvnDeps:                                       # prelude + config `mvnDeps` + `$ivy`/`$dep`
//| - com.lihaoyi:ammonite-repl-api_3.3.7:3.0.8
//| - sh.almond::jupyter-api:0.14.5
//| - com.lihaoyi::os-lib:0.11.3
//| scalacOptions:
//| - -Wconf:msg=A pure expression does nothing in statement position:s
object sample {                                    # named after the shadow file
<prelude imports, then config `preamble` lines>
/* --- cell 0 W0sZmlsZQ== */
/* [shadow] import $ivy.`com.lihaoyi::os-lib:0.11.3` */

def add(a: Int, b: Int): Int = a + b ; val res1_2 = (
os.pwd)
/* --- cell 1 W1sZmlsZQ== */ val res2_0 = (
println(res1_2))
}
```

**Why the wrapper.** Scala 3 rejects statements at the top level of a `.scala` file (*"Illegal start
of toplevel definition"*), and Mill splices a script's body in at exactly that position — so
`println("hi")` in a cell was a hard error. Almond sidesteps this by wrapping each cell in an
object, where a bare statement is just part of the template body. We wrap for the same reason, but
share one object across cells rather than opening one per cell: Ammonite can afford per-cell objects
only because it computes an exact import list for each one, and the naive `import cell0.*` version
makes any name defined in two cells ambiguous. One shared object keeps cross-cell references
resolving with no import bookkeeping at all.

**Redefinition (nested scopes).** A shared object does mean that redefining a name — `val n = 2` in
one cell, `val n = 3` in a later one — is a duplicate member, where Almond would simply shadow the
earlier binding. So when a cell redefines a name its scope already holds, that cell and every cell
after it are emitted one object deeper:

```scala
object sample {
/* --- cell 0 W0 */
val total = 1
object `shadow scope 1` {
/* --- cell 1 W1 */
val total = 2
/* --- cell 2 W2 */
val doubled = total * 2
}
}
```

The new `total` shadows the old one lexically, and everything else the earlier cells brought into
scope — imports, givens, extension methods, types — keeps working with no import list to compute.
The nesting is opened only on an actual collision, so ordinary notebooks stay flat, and it is capped
at 100 levels: a few hundred nested objects overflow scalac's stack, which would cost every
diagnostic in the file rather than the one duplicate-definition error the nesting avoids. Deciding
when to nest means reading the names a cell defines; a definition we can't name confidently (an
`extension` block, an anonymous `given`, an `export`, a destructuring `val`) is treated as a
collision, since opening a scope is always safe and missing one only costs the error we would have
reported anyway.

**Why the `-Wconf`.** A cell ending in a bare expression (`n + 1`, `df.show`) is idiomatic — in a
notebook that expression *is* the cell's result. Bare statements we can't bind (below) would
otherwise squiggle with *"A pure expression does nothing in statement position"*. The header
suppresses exactly that message and nothing else.

**Result bindings (`resN_M`).** Almond binds each cell's expression statements to `resN_M`, and
users reference them in later cells — so a shadow file without them reports a phantom *"Not found:
res1_2"*. Each expression statement is therefore bound, numbered exactly as Almond numbers it: `N`
is the cell's 1-based position among Scala code cells, `M` the 0-based index of the statement within
the cell, counting imports and definitions (which get no binding of their own). A cell holding a
single statement also gets the unsuffixed `resN`.

Bindings are added by **appending only** — the opener `val resN_M = (` goes on the end of the line
*before* the statement, and the `)` on the end of the statement's last line, with the parentheses
spanning the lines between. No cell line changes width before its end and no line is inserted, so
line numbers and column positions are untouched and the diagnostic mapping needs no adjustment.
That is also why cell markers and commented-out magic imports are `/* block comments */`: a `//`
comment would swallow anything appended after it.

There is no Scala parser here — just a scanner that knows where comments, strings and brackets are
([`statements.ts`](scala-notebook-shadow/src/statements.ts)). It **bails rather than guesses**: a
cell whose brackets don't balance, or that opens mid-statement, gets no bindings at all, and an
individual binding is skipped when either line ends inside a comment or string. A skipped binding
costs a `resN_M`; a wrong guess would emit an unbalanced paren and bury every real diagnostic.

Numbering follows *document* order, not the kernel's execution counter. A shadow file is
regenerated from the static document on every keystroke, so tying names to execution counts would
rename every binding on each re-run and break references typed earlier. The trade-off: if you first
ran cells out of order, the numbers won't line up with what your kernel printed.

**Magic imports.** None of Ammonite/Almond's `$`-imports are legal Scala, so every line using one is
commented out in place (`// [shadow] ...`), preserving line numbering. `$ivy`/`$dep` (single,
comma-separated, or braced) become `mvnDeps` entries and `$repo` becomes a `repositories` entry;
`$file`, `$plugin`, `$scalac` and `$profile` have no shadow-file equivalent and are only
neutralized. A coordinate using Almond's `_` version placeholder (`sh.almond::scala-kernel-api:_`)
is dropped rather than written to the header, where Mill couldn't resolve it and the failure would
bury every real diagnostic.

**The prelude.** A notebook cell can write `Markdown("# Hello World")`, `publish.stdout(...)` or
`repl.pprinter()` without importing anything, because the kernel injects a predef ahead of every
cell — Ammonite's `interp`/`repl` bridges, then Almond's display API. The shadow file reproduces
both, ahead of any `scalaNotebook.preamble` lines:

| | Dependency added to `mvnDeps` | Names put in scope |
|---|---|---|
| `scalaNotebook.ammoniteVersion` | `com.lihaoyi:ammonite-repl-api_3.3.7:<version>` | `interp`, `repl`, `show`, `codeColorsImplicit`, `tprintColorsImplicit` |
| `scalaNotebook.almondVersion` | `sh.almond::jupyter-api:<version>` | `kernel`, `publish`, `commHandler`, `display`, `Markdown`/`Html`/`Image`/… , `Input`, `DisplayDataSyntax` |

The Almond half also adds JitPack to `repositories`: `com.github.jupyter:jvm-repr`, which
`jupyter-api` depends on, is published nowhere else.

*Why `jupyter-api`, not the `scala-kernel-api` a notebook's `import $ivy` would name.* `jupyter-api`
is cross-published against the Scala *binary* version (`_3`), so it resolves for whatever
`scalaVersion` is set, while `scala-kernel-api` is published per *full* Scala version and only for
the ones Almond ships a kernel for — `3.7.2`, the default here, is not among them. It also carries
`almond.display` without pulling in the Ammonite compiler. Two predef names are lost to that choice:
`almond.display.PrettyPrint`, and `almond.api.JupyterAPIHolder`, which Almond generates per kernel.

*Bridges and stand-ins.* `interp` and `repl` come from the real `InterpBridge`/`ReplBridge` holders,
imported exactly as Ammonite's `initializePredef` does it — `APIHolder.value` only holds a value
once a kernel assigns one, but it type-checks without, which is all a file that is compiled and
never run needs. `kernel` has no such holder here (that is the missing `JupyterAPIHolder`), so the
preamble declares a `val kernel: almond.api.JupyterApi` and never assigns it; `publish`,
`commHandler` and `display` are imported off that.

*Why `ammonite-repl-api` is pinned to `_3.3.7`.* Ammonite publishes it per full Scala version, and
not for every version Scala has released (`3.7.2` included). Scala 3 reads TASTy written by any
earlier 3.x, so pinning the LTS line compiles against every later Scala 3 rather than breaking
whenever `scalaVersion` has no matching build. A `scalaVersion` *older* than 3.3.7 is the one case
it cannot serve — set `ammoniteVersion` to `""` there and use `mvnDeps`/`preamble` instead.

One useful side effect: `ammonite-repl-api` brings os-lib, pprint and fansi onto the classpath, so a
cell can use `os.pwd` or `pprint.Tree` with no `import $ivy` — which is what happens in a real
kernel too, since Ammonite puts its own classpath in scope there.

## Settings

| Setting | Type | Default | Notes |
|---|---|---|---|
| `scalaNotebook.scalaVersion` | string | `"3.7.2"` | Written into `//| scalaVersion`. Must match the kernel you run, otherwise phantom errors. |
| `scalaNotebook.mvnDeps` | string[] | `[]` | Mill coordinates, e.g. `com.lihaoyi::upickle:4.0.2`. Merged with `$ivy`/`$dep` lines found in cells. |
| `scalaNotebook.ammoniteVersion` | string | `"3.0.8"` | Ammonite version behind the kernel, whose `repl`/`interp` bridges go in scope. Should match the Ammonite your Almond version embeds. Empty string leaves them out. |
| `scalaNotebook.almondVersion` | string | `"0.14.5"` | Almond version whose predef the shadow file reproduces. Empty string leaves it out. |
| `scalaNotebook.preamble` | string[] | `[]` | Extra lines inserted inside the wrapper object, after the Almond prelude and before the first cell. Behaves like a predef cell, so statements are allowed. |
| `scalaNotebook.shadowDir` | string | `"notebook-shadow"` | Relative to the Mill build the notebook belongs to (nearest `build.mill`, `build.mill.yaml`, `build.mill.scala` or `.mill-version` at or above it), else the workspace folder root. |
| `scalaNotebook.debounceMs` | number | `400` | Debounce between a notebook edit and shadow regeneration. |
| `scalaNotebook.compileOnCreate` | boolean | `false` | Runs `./mill <shadowPath>:compile` once when a shadow file is first created. See Phase 0 findings — not required in practice, kept as an escape hatch. |

## Repo layout

```
scala-notebook-shadow/
  src/
    transform.ts       # pure: (cells, config) -> { text, mapping }
    statements.ts       # pure: Scala scanner + conservative statement segmentation
    generatedSource.ts   # pure: parse Mill's `.dest/` copy markers
    mapping.ts            # pure: lineToSpan, translateDiagnostic, rebaseDiagnostic
    shadowManager.ts     # per-notebook state: create/open/regenerate/close
    relay.ts             # onDidChangeDiagnostics handler
    extension.ts          # activate(): wires listeners, commands, collection
  test/
    transform.test.ts    # determinism, header sizing, cell wrapping, magic imports, mapping arithmetic
    mapping.test.ts       # span lookup, clamping, outside-cell attachment, generated-copy rebasing
    statements.test.ts     # scanner, statement segmentation, bail-out cases
    generatedSource.test.ts # Mill marker parsing
  eslint.config.mjs      # ESLint flat config (type-aware; no-floating-promises off for tests)
fixture/
  mill                     # official Mill bootstrap launcher, pinned via .mill-version (1.1.8)
  build.mill.yaml           # near-empty; only exists so Metals picks Mill as the build server
  notebook-shadow/          # generated shadow scripts (not checked in)
  sample.ipynb                # notebook used for the acceptance checklist (issue §8)
.github/
  workflows/ci.yml         # lint + typecheck, tests on Node 22/24 (Linux, macOS), VSIX, release on v* tags
  dependabot.yml            # weekly npm and GitHub Actions updates
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
| 8 | Unit tests pass | **Pass** — 56/56 (`npm test` in `scala-notebook-shadow/`) |

Everything gated on "needs a live VS Code + Metals + Mill session" could not be executed in this
environment (no VS Code extension host / Metals server available here); the code paths implementing
each behavior are in place and exercised as far as they can be without that host.

## Local Mill modules via `//| moduleDeps` (not implemented — untested)

A `//|` directive is a valid Scala line comment, so a notebook cell can carry
`//| moduleDeps: [my.module]`: the kernel ignores it, and the extension could hoist it into the
shadow header next to `mvnDeps`, giving Metals a local Mill module to type-check cells against
without publishing anything. The extension does **not** do this today — `collectMagicImports`
(transform.ts) recognizes `$ivy`/`$dep`/`$repo` only. Recorded here because the gotcha below
applies to any local-module scheme, not just this one.

**Gotcha: the compile half and the run half go stale at different rates.** `moduleDeps` feeds
Mill/Metals only. Making the same module available to the running kernel needs a second,
independent step — `interp.load.cp(...)` over the module's `runClasspath`, in a cell before the one
that imports from it. The two halves then diverge:

- Metals recompiles the module through BSP on every source edit, so diagnostics track its current
  API.
- `interp.load.cp` adds URLs to the Ammonite frame's `ReplClassLoader`. The JVM resolves classes by
  *name* and caches them once loaded, so re-running the cell re-invokes Mill (the `.class` files on
  disk do update) but any class already loaded keeps its old bytecode.

Because `runClasspath` points at a classes **directory** and classes load lazily, the update is
*partial*: a class already touched serves old bytecode while an untouched one loads fresh, giving
`NoSuchMethodError`/`AbstractMethodError` at the seam. Combined with the first point the failure is
silent — the editor shows green against the module's new API while the kernel still runs the old
classes.

There is no fix short of restarting the kernel. The working loop is "edit module → Restart & Run
All", not "edit module → re-run cell". `repl.sess.save()`/`repl.sess.load()` does drop the
classloader, but only by discarding every definition made after the checkpoint — a targeted restart,
not a hot reload. Publishing under a bumped version doesn't help either: the class names are
unchanged, so the already-loaded ones still win. This is the ordinary JVM REPL constraint that sbt
`console`, plain Ammonite and `spark-shell` all share, not something the shadow design introduces.
The practical accommodation is the usual division of labour — stable code in the module,
fast-moving code in the cells. `moduleDeps` buys *authoring* against a local module, not live
iteration on one.

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
- A cell that redefines a name *and reads the old value in the same statement* (`val n = n + 1`)
  reports *"Recursive value n needs type"*. Nesting lets the new `n` shadow the old one, but inside
  its own scope the reference resolves to the definition being made; only rewriting the cell's text
  could fix it, and cell text is copied verbatim so that line and column positions survive.
- Nesting is capped at 100 levels (see above), so a notebook that redefines names more than 100
  times reports duplicate-definition errors from there on.
- A class defined in one cell and an object of the same name in a later cell become a shadowing
  pair, not companions. This matches Almond, where a companion pair must be written in one cell.
- `$file` imports are neutralized rather than resolved, so names they would have brought into scope
  report as "not found" in the shadow file.
- `resN_M` bindings are numbered by document order, so they only line up with the kernel if the
  notebook was run top to bottom. A statement the scanner can't read confidently gets no binding,
  and a reference to it still reports "not found".
- A local Mill module made visible to cells via `//| moduleDeps` plus `interp.load.cp` goes stale in
  the kernel but not in the editor, so cells can type-check against an API the running kernel does
  not have. See "Local Mill modules" above; the only remedy is a kernel restart.
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
