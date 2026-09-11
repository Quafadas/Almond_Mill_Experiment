# Scala Notebook Shadow (POC)

[![CI](https://github.com/Quafadas/Almond_Mill_Experiment/actions/workflows/ci.yml/badge.svg)](https://github.com/Quafadas/Almond_Mill_Experiment/actions/workflows/ci.yml)

Implements [Concept #1](https://github.com/Quafadas/Almond_Mill_Experiment/issues/1): show Metals
compile diagnostics as squiggles inside the cells of a `.ipynb` notebook in VS Code, without
modifying Metals or scala-cli, by concatenating a notebook's Scala cells into a hidden "shadow"
script and remapping the diagnostics VS Code reports for that file back onto the cell URIs.

The shadow is a **scala-cli script** — `notebook-shadow/<name>.sc`, with `//> using` directives for
the Scala version and dependencies. Metals starts a scala-cli build server for a directory of `.sc`
files on its own, so **no build file of any kind is required** in the workspace.

> **Note.** This targeted Mill until [issue #15](https://github.com/Quafadas/Almond_Mill_Experiment/issues/15).
> Under Mill one shadow script was one build target, which meant a `Metals: Import Build` for every
> new notebook and a reimport-plus-clean for every `import $ivy`. Neither was a property of the
> shadow-file approach — both were properties of Mill script-module discovery — and both go away
> when the shadow is a `.sc` that scala-cli resolves for itself. The Mill target has been removed;
> see [Status](#status) for what that leaves unverified.

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
   npm test        # optional: runs the unit tests, no VS Code needed for this step
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
   repo's `fixture/` directory. It holds a notebook and nothing else — no build file.

5. **Install Metals** in that window if it isn't already there (Extensions ▸ search
   `scalameta.metals` ▸ Install).

6. **Open `fixture/sample.ipynb`.** If VS Code prompts for a kernel, you can dismiss it — no kernel
   needs to be installed or selected for diagnostics to work.

   Metals will notice the generated `notebook-shadow/sample.sc` and **prompt to import it** as a
   scala-cli script. Accept. The routing to scala-cli is automatic; the acceptance is not.

7. **Inspect the shadow file.** Command Palette ▸ **Scala Notebook: Open Shadow File** to see the
   generated `notebook-shadow/sample.sc`, or just look at it directly in the file explorer.

8. **Exercise the acceptance checklist** (see below): edit cell 2 to introduce/fix a type error,
   watch the squiggle move with it; add a markdown cell and confirm nothing shifts incorrectly;
   close and reopen the notebook and confirm squiggles come back without duplicating the shadow
   file.

**Trying it against your own notebook instead of the fixture:** open any workspace, add/open a
`.ipynb` file with Scala code cells in it, and the extension activates automatically
(`onNotebook:jupyter-notebook`) — no fixture-specific wiring, and no build file needed. Adjust
`scalaNotebook.*` settings (see below) to match your project's Scala version and dependencies.

**Upgrading from the Mill version?** It wrote `notebook-shadow/<name>.scala`; this writes
`<name>.sc` beside it, wrapped in an object of the same name. Both would compile and every cell
would squiggle with a duplicate definition, so **delete the old `.scala` shadow**. The extension
logs a warning naming the file rather than deleting it for you.

This repo has two parts:

- [`scala-notebook-shadow/`](scala-notebook-shadow/) — the VS Code extension.
- [`fixture/`](fixture/) — a throwaway notebook workspace used for probing and for manually
  running the acceptance checklist below.

## Why the shadow is a scala-cli script

Phase 0 (issue §3) probed the Mill target by hand, before any code was written. Its findings are
what eventually removed Mill:

| Question | Finding |
|---|---|
| Does Metals report the error without any extra step? | **No.** `Metals: Import Build` was necessary before diagnostics for a freshly created script appeared. |
| Is a newly-added script file (a second notebook's shadow) picked up automatically? | **No.** A reimport was needed for Metals/Mill to notice it. |
| Does changing the `//\|` header (adding an `mvnDeps` entry) just need a reimport? | **No — it needed a "clean" of the module** as well. |
| Which file does Metals report diagnostics against? | **Mill's generated copy**, not the shadow — e.g. `.bsp/out/notebook-shadow/sample.scala/allSourceFiles.dest/sample.scala`. Mill compiled a copy with two marker lines prepended, so the relay had to resolve that path back and subtract the offset. |
| Does a directory name starting with `.` still get picked up? | **No.** A dot-prefixed directory made the source invisible to Mill. `shadowDir` therefore defaults to the non-hidden `notebook-shadow/`. |

Every cost in that table traces to one fact: **one Mill script is one build target.** A new notebook
is a new target, so it is a build-structure change; an `import $ivy` changes the header, so it is
another one. None of that is a property of the shadow-file approach.

[Issue #15](https://github.com/Quafadas/Almond_Mill_Experiment/issues/15) probed the alternative and
confirmed the two facts the switch rests on:

| Probe | Finding |
|---|---|
| Does Mill claim `notebook-shadow/*.sc` files? | **No.** Mill's script discovery does not pick up `.sc` files in a subdirectory of its own accord, so there is no contention if the workspace happens to be a Mill project. |
| Does Metals route the directory to scala-cli? | **Yes, automatically** — the existing dedicated-folder heuristic fires with no nudge from the extension. It is not silent, though: the script import has to be accepted at a prompt. |

So a new notebook becomes a new *source* in one directory-level target rather than a new target, and
scala-cli resolves `//> using dep` itself. The Mill target, its `//\|` header, its build-root
discovery, its `./mill <path>:compile` escape hatch and the `.dest/`-copy relay were all removed
rather than kept behind a switch.

Two design decisions survive the change unaltered:

- The extension does **not** drive Metals' own commands. Where an interaction is needed — accepting
  the scala-cli import prompt — it is documented, not scripted.
- `shadowDir` defaults to `notebook-shadow` (no leading dot). Whether scala-cli also skips
  dot-prefixed directories is untested; the default sidesteps the question.

## Status

What is verified, and what is not, as of the Mill removal:

- **Verified** (issue #15 §5.1, §5.2): Mill does not claim the `.sc` files; Metals routes the shadow
  directory to a scala-cli build server on its own, behind an acceptance prompt.
- **§5.4 — observed working.** Squiggles reach the cells, so Metals reports diagnostics against the
  `.sc` itself rather than against scala-cli's generated wrapper under `.scala-build/`. This is one
  manual session, not a recorded probe run: the Metals and scala-cli versions were not captured, and
  the wrapper case has not been ruled out for every request type. The relay still refuses to guess a
  line offset for a `.scala-build/` path and logs it at `debug` instead — set
  `scalaNotebook.logLevel` to `debug` and read **Scala Notebook: Show Log** to check whether it ever
  fires.
- **Not yet verified** — these probes are open, and each one could change the design:
  - **§5.5** Whether a second notebook's `.sc` is picked up without a restart, and whether the
    acceptance prompt reappears per file or only once per workspace.
  - **§5.6** Whether adding a `//> using dep` to a live shadow re-resolves without a restart, and
    whether a bad coordinate recovers. This is the direct replacement for Mill's reimport-plus-clean,
    and the highest-risk probe left.
  - **§5.7** Whether the wrapper object and the `-Wconf` are still needed at all in a `.sc`, where
    top-level statements are already legal.

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
Extension Development Host. Open the `fixture/` folder in that host window, then open
`fixture/sample.ipynb` and accept Metals' prompt to import the generated script.

Useful commands (Command Palette):

- **Scala Notebook: Open Shadow File** — reveals the shadow `.sc` file for the active notebook.
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

Nothing in CI runs Metals or scala-cli: that needs a JDK, a Metals session and generated shadow
scripts, so everything it would cover stays on the manual-verification checklist below.
Dependency updates come in via `.github/dependabot.yml` (npm + GitHub Actions, weekly).

## Shadow file layout

Every notebook becomes one scala-cli script. Cell bodies are copied in verbatim — never
re-indented — one line per source line, so a cell's line *N* is always the shadow's line
`span.startLine + N`:

```scala
//> using scala 3.7.2
//> using repository https://jitpack.io            # JitPack for the prelude, plus `import $repo`
//> using dep com.lihaoyi:ammonite-repl-api_3.3.7:3.0.8   # prelude + config `mvnDeps` + `$ivy`
//> using dep sh.almond::jupyter-api:0.14.5
//> using dep com.lihaoyi::os-lib:0.11.3
//> using option "-Wconf:msg=A pure expression does nothing in statement position:s"  # quoted: the value has spaces
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

**Why the wrapper.** Almond wraps each cell in an object, where a bare statement is just part of
the template body. We wrap for the same reason, but share one object across cells rather than
opening one per cell: Ammonite can afford per-cell objects only because it computes an exact import
list for each one, and the naive `import cell0.*` version makes any name defined in two cells
ambiguous. One shared object keeps cross-cell references resolving with no import bookkeeping at
all. It is also what the redefinition nesting below nests into, and what keeps two notebooks'
shadows in one directory from colliding.

A `.sc` script does allow top-level statements, so the wrapper is no longer load-bearing for that
alone — whether it can go is issue #15 §5.7, unanswered.

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
is dropped rather than written to the header, where scala-cli couldn't resolve it and the failure would
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

**`projectRoot`.** The shadow always sits in `scalaNotebook.shadowDir`, not next to the notebook that
generated it — Metals' own scala-cli build server compiles that one directory, and only that one
([#25](https://github.com/Quafadas/Almond_Mill_Experiment/issues/25)) — so a cell that finds a
resource by navigating from `os.pwd` or the script's own location resolves a different path in the
shadow than a real kernel run would resolve for the same cell. The preamble adds a
`projectRoot(relative: String = ""): java.nio.file.Path` helper instead, resolving `relative` against
the workspace folder itself, baked in as an absolute path when the shadow is (re)generated. A real
kernel run ordinarily starts with that same folder as its working directory, so
`projectRoot("resources/aCsv.csv")` resolves to the same file either way. It depends on nothing
beyond the JDK, so it is always added, regardless of `ammoniteVersion`/`almondVersion`.

## Settings

| Setting | Type | Default | Notes |
|---|---|---|---|
| `scalaNotebook.scalaVersion` | string | `"3.7.2"` | Written into `//> using scala`. Must match the kernel you run, otherwise phantom errors. |
| `scalaNotebook.mvnDeps` | string[] | `[]` | Dependency coordinates, e.g. `com.lihaoyi::upickle:4.0.2`, one `//> using dep` each. Merged with `$ivy`/`$dep` lines found in cells. |
| `scalaNotebook.ammoniteVersion` | string | `"3.0.8"` | Ammonite version behind the kernel, whose `repl`/`interp` bridges go in scope. Should match the Ammonite your Almond version embeds. Empty string leaves them out. |
| `scalaNotebook.almondVersion` | string | `"0.14.5"` | Almond version whose predef the shadow file reproduces. Empty string leaves it out. |
| `scalaNotebook.preamble` | string[] | `[]` | Extra lines inserted inside the wrapper object, after the Almond prelude and before the first cell. Behaves like a predef cell, so statements are allowed. |
| `scalaNotebook.shadowDir` | string | `"notebook-shadow"` | Relative to the first workspace folder. Metals starts a scala-cli build server for it on its own; no build file is needed. |
| `scalaNotebook.debounceMs` | number | `400` | Debounce between a notebook edit and shadow regeneration. |
| `scalaNotebook.completionResolveCount` | number | `30` | How many completion items to have Metals resolve (documentation, detail, auto-import edits) before showing them. `0` disables resolution. |
| `scalaNotebook.codeActionResolveCount` | number | `16` | How many code actions to have Metals resolve (the edits of a lazily-computed refactor) before they are offered. A relayed action is never resolved on demand, so an unresolved one would appear in the lightbulb menu and then do nothing. `0` disables resolution. |
| `scalaNotebook.compileOnSave` | boolean | `true` | Ask Metals to cascade-compile after a regenerated shadow is saved, so diagnostics refresh promptly. |
| `scalaNotebook.logLevel` | string | `"info"` | `off`/`error`/`warn`/`info`/`debug`/`trace`. Takes effect immediately. Run **Scala Notebook: Show Log** to open the channel. |

## Repo layout

```
scala-notebook-shadow/
  src/
    transform.ts       # pure: (cells, config) -> { text, mapping }
    statements.ts       # pure: Scala scanner + conservative statement segmentation
    scalaCliBuild.ts     # pure: spot scala-cli's `.scala-build/` generated wrappers
    mapping.ts            # pure: lineToSpan, translateDiagnostic, shadowLinkToCell, shadowEditsToCells
    semanticTokens.ts     # pure: decode/filter/re-encode delta-encoded semantic tokens
    shadowNaming.ts       # pure: notebook path -> shadow base name
    log.ts                # pure: level-filtered logger over an output channel
    shadowManager.ts     # per-notebook state: create/open/regenerate/close
    languageFeatures.ts  # definition, hover, completion, code actions, rename, tokens, ...
    relay.ts             # onDidChangeDiagnostics handler
    extension.ts          # activate(): wires listeners, commands, collection
  test/
    transform.test.ts    # determinism, header directives, cell wrapping, magic imports
    goldenShadow.test.ts  # the whole fixture notebook against a committed shadow
    mapping.test.ts       # span lookup, clamping, outside-cell attachment, edit translation
    semanticTokens.test.ts  # delta decode/encode, filtering tokens to a cell's lines
    statements.test.ts     # scanner, statement segmentation, bail-out cases
    scalaCliBuild.test.ts   # generated-wrapper detection
    shadowNaming.test.ts    # shadow names: stability, nesting, collisions
    log.test.ts             # level filtering, formatting, scoping
    configDefaults.test.ts  # package.json defaults match readConfig's fallbacks
  eslint.config.mjs      # ESLint flat config (type-aware; no-floating-promises off for tests)
fixture/
  notebook-shadow/         # generated shadow scripts (not checked in)
  sample.ipynb              # notebook used for the acceptance checklist (issue §8)
.github/
  workflows/ci.yml         # lint + typecheck, tests on Node 22/24 (Linux, macOS), VSIX, release on v* tags
  dependabot.yml            # weekly npm and GitHub Actions updates
```

`transform.ts` and `mapping.ts` only take `import type * as vscode from "vscode"` (erased at
compile time), and `semanticTokens.ts` imports nothing at all, so none of them have a runtime
dependency on the `vscode` module and all run under plain `node --test`.

## Acceptance checklist (issue §8)

| # | Criterion | Status |
|---|---|---|
| 1 | Opening the notebook creates `notebook-shadow/sample.scala` with the §4 layout | Implemented (`shadowManager.openForNotebook`); needs a live VS Code + Metals session to observe |
| 2 | Cell 2 shows a type-mismatch, cell 3 shows "not found", cells 0/1 clean | Depends on Metals/scala-cli compiling the shadow file — not verifiable outside a running extension host in this environment |
| 3 | Fixing cell 2 clears its squiggle, cell 3's remains | Same as above — relies on live diagnostics |
| 4 | Inserting a markdown cell doesn't change reported diagnostics, mapping shifts correctly | Covered by unit test (`transform.test.ts`: "markdown and non-scala cells are skipped entirely") for the mapping-shift part; live squiggle behavior needs manual verification |
| 5 | An error on cell 1's second line squiggles at line 1, not line 0 or another cell | Covered by unit test (`mapping.test.ts` translateDiagnostic tests) for the line-arithmetic part; live verification needed |
| 6 | `import $ivy` cell: header gains the dep, line is commented in place, no error after reimport | Transform behavior covered by unit tests (`transform.test.ts` $ivy tests); per Phase 0, a manual `Metals: Import Build` (possibly plus a clean) is required and is **not** automated — this is a documented manual step, not a bug |
| 7 | Closing/reopening the notebook clears then restores squiggles without duplicating the shadow file | Implemented (`closeForNotebook` clears diagnostics and drops state; `openForNotebook` no-ops if the file already exists and reconciles `appliedText` from disk) — needs live verification |
| 8 | Unit tests pass | **Pass** — 148/148 (`npm test` in `scala-notebook-shadow/`). `tsc` does not delete stale output, so a tree that predates the Mill removal runs deleted tests too and reports a higher count; remove `out/` to get this one. |

Everything gated on "needs a live VS Code + Metals + scala-cli session" could not be executed in this
environment (no VS Code extension host / Metals server available here); the code paths implementing
each behavior are in place and exercised as far as they can be without that host.

## Local sources on the shadow's classpath (not implemented — untested)

A `//>` directive is a valid Scala line comment, so a notebook cell could carry
`//> using file ../my/module`: the kernel ignores it, and the extension could hoist it into the
shadow header next to the `dep` directives, giving Metals local sources to type-check cells against
without publishing anything. The extension does **not** do this today — `collectMagicImports`
(transform.ts) recognizes `$ivy`/`$dep`/`$repo` only. Recorded here because the gotcha below
applies to any local-module scheme; it was written against Mill's `moduleDeps`
([issue #10](https://github.com/Quafadas/Almond_Mill_Experiment/issues/10)), which this branch no
longer has a target for.

**Gotcha: the compile half and the run half go stale at different rates.** A source directive feeds
the build server and Metals only. Making the same code available to the running kernel needs a
second, independent step — `interp.load.cp(...)` over the module's `runClasspath`, in a cell before the one
that imports from it. The two halves then diverge:

- Metals recompiles the sources through BSP on every edit, so diagnostics track their current API.
- `interp.load.cp` adds URLs to the Ammonite frame's `ReplClassLoader`. The JVM resolves classes by
  *name* and caches them once loaded, so re-running the cell re-invokes the build (the `.class`
  files on disk do update) but any class already loaded keeps its old bytecode.

Because that classpath points at a classes **directory** and classes load lazily, the update is
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
fast-moving code in the cells. A source directive buys *authoring* against a local
module, not live iteration on one.

## Known limitations / deviations

- The diagnostic `source` field question from Phase 0 (`"metals"` vs the build server's own name)
  was never answered; the relay doesn't special-case `source`, it passes it through untranslated,
  so this has no functional impact but is worth confirming later.
- Per issue §5 step 3, the relay does not attempt to reconcile a diagnostics event against a stale
  shadow mapping version — if diagnostics arrive for an older shadow revision than the current
  mapping, they may be mis-positioned. Accepted for the POC, as specified.
- Metals' prompt to import a newly generated `.sc` is left to the user to accept, not scripted —
  consistent with the issue's explicit scope boundary. Whether it reappears per shadow file or only
  once per workspace is issue #15 §5.5, unanswered.
- Diagnostics reported against scala-cli's generated wrapper under `.scala-build/` are **not**
  relayed: that copy carries no marker naming the script it came from, so the line offset would be
  a guess. They are logged at `debug` instead. Whether Metals reports there at all is issue #15
  §5.4 — see [Status](#status).
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
- A code action Metals computes with a server-side **command** rather than a `WorkspaceEdit`
  ("insert inferred type", "convert to named arguments", "extract method") is offered, but it works
  differently: there is no edit to translate, because Metals computes the result itself and pushes
  it at the shadow script with `workspace/applyEdit`. Picking one runs the command, diffs the shadow
  before and after, and re-homes that single edit into the cell, then rewrites the shadow from the
  notebook. The diff is the tightest range covering every change, so a command that also touched the
  prelude or a neighbouring cell yields a range spanning them and is refused with a message rather
  than applied — the same all-or-nothing rule the `WorkspaceEdit` path uses.
- **Organize Imports** is deliberately not offered. Metals organizes the whole shadow script's
  imports, so its edits rewrite the Almond prelude — text no cell contains — and the relay refuses
  to move generated code into a cell. Only an out-of-cell *insertion* is re-homed, which is what
  lets "import missing symbol" put its import at the top of the requesting cell.
- **Rename** is all-or-nothing: if any occurrence lands on a synthesized `resN_M` binding, in the
  prelude or in another notebook's shadow, the whole rename is refused with a message rather than
  applied to the occurrences that did fit. A half-renamed notebook would no longer compile.
- **Call hierarchy** and **type hierarchy** are relayed, with one notebook-shaped wrinkle: a cell
  that is a bare expression calls from inside a generated `val resN_M` binding, so it appears in
  an incoming-calls tree under that name, at the top of the cell, rather than under a name the
  user wrote. Such a row is a leaf - there is no symbol at the cell's start to walk up from.
  Callers that Metals attributes to the wrapper object itself are dropped, like any other
  generated code.
- **Formatting** is not offered at all. scalafmt would reindent every cell body to sit inside the
  wrapper object, so formatting a cell would return a +2-space edit on every line. This is gated on
  issue #15 §5.7 — see [Status](#status).
- **Semantic highlighting** is registered lazily, because the provider needs Metals' own token
  legend and that can only be read once Metals has loaded a shadow script; until then cells keep
  TextMate colours. Metals also registers a semantic-tokens provider for `scala`, and VS Code picks
  one provider rather than merging them, so which one answers for a cell is not something this
  extension controls.
- `resN_M` bindings are numbered by document order, so they only line up with the kernel if the
  notebook was run top to bottom. A statement the scanner can't read confidently gets no binding,
  and a reference to it still reports "not found".
- Local sources put on the shadow's classpath and loaded into the kernel with `interp.load.cp` go
  stale in the kernel but not in the editor, so cells can type-check against an API the running
  kernel does not have. See "Local sources" above; the only remedy is a kernel restart.

## Things Phase 0 got wrong relative to initial assumptions (§10)

This is the most valuable output of the POC, per the issue:

1. **A reimport was required more often than expected** — not just once per workspace, but on every
   new shadow file (effectively once per newly-opened notebook), and again whenever the `//|` header
   changed shape.
2. **A reimport alone was not enough after a header change** — a full module **clean** was needed,
   heavier and more disruptive than assumed, which made the "add a dependency via `import $ivy`"
   flow (§8 item 6) noticeably less smooth than plain concatenation would suggest.
3. **Hidden directories were actively harmful, not just untested** — a `.`-prefixed shadow directory
   didn't merely "not get picked up automatically"; the file became invisible to Mill outright and
   was never compiled. The shadow directory must be a normal, visible one.

Items 1 and 2 are what
[issue #15](https://github.com/Quafadas/Almond_Mill_Experiment/issues/15) set out to remove, and
why the Mill target is gone. Both need re-measuring against scala-cli before they can be called
fixed — see [Status](#status).
