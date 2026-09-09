# TODO

## Language features

- [x] Generate and synchronize Scala shadow files for notebook cells.
- [x] Relay Metals compile diagnostics back to notebook cells.
- [x] Forward jump-to-definition requests through the shadow file.
- [x] Map definitions in the shadow file back to the originating notebook cell.
- [x] Preserve jump-to-definition targets in external source files.
- [x] Forward completion requests through the shadow file.
- [x] Map completion replacement ranges and additional edits back to the requesting cell.
- [x] Synchronize pending notebook edits before definition and completion requests.
- [x] Forward hover requests through the shadow file, keeping the hovered range only when it
      lies inside the requesting cell.
- [x] Forward signature help (triggered on `(` and `,`); its result carries no ranges, so it
      needs no translation.
- [x] Forward type-definition and implementation requests, reusing the definition translation.
- [x] Forward document highlights, dropping occurrences that fall in other cells or in
      synthesized lines.
- [x] Forward inlay hints (inferred types, implicit arguments and conversions), mapping hint
      positions back into the cell and dropping hints on synthesized lines. Requires the
      `metals.inlayHints.*` settings to be enabled; most are off by default.
- [x] Keep an inlay hint's "accept" edits only when every one lands inside the cell, so
      accepting a hint can never write into generated code.
- [x] Strip inlay-hint label links that point back into the shadow script, so ctrl-clicking a
      type never navigates into generated code. Library targets are left alone.
- [x] Re-request inlay hints when the shadow is rewritten or fresh diagnostics arrive
      (`ShadowManager.onDidChangeAnalysis`), since VS Code caches them rather than polling.
- [x] Forward find-references, translating hits in this notebook's shadow to cells, dropping
      hits on synthesized lines and in other notebooks' shadows, and de-duplicating the hit
      that arrives twice for one position.
- [x] Mimic almond cell handling to allow top level statements when emitting the shadow file.
- [x] ivy import translation to `//> using dep` directives in the shadow file.
- [x] Bind cell expressions to Almond's `resN_M` names so later cells can reference them.
- [x] ~~Relay diagnostics reported against Mill's generated `.dest/` copy of the shadow file.~~
      Removed with the Mill target; scala-cli compiles the `.sc` itself.
- [x] Allow a name defined in one cell to be redefined in a later cell (nest the redefining cell
      and everything after it in a further object, so the new definition shadows the old).
- [x] Reproduce Almond's predef in the shadow file, so `Markdown("# Hello World")`, `publish` and
      the rest of the display API resolve without an import.
- [x] Put Ammonite's `repl` and `interp` bridges in scope, along with the classpath they carry
      (os-lib, pprint, fansi).
- [x] Name a shadow script after the notebook's path within the workspace, so one notebook
      maps to one shadow file. Replaces a name-handout registry that never released names on
      close, which gave a reopened notebook a second shadow (`sample.scala`, `sample_2.scala`).
- [x] ~~Ask every file a shadow is known by for inlay hints, not just the shadow script.~~
      Was needed because Metals answered inlay hints only for a real build-target source, which
      under Mill was the `.dest/` copy rather than the script. scala-cli compiles the `.sc`
      itself, so the shadow is that source and there is nothing else to ask.
- [x] Level-filtered logging (`scalaNotebook.logLevel`, off/error/warn/info/debug/trace) with
      per-component scopes and a "Scala Notebook: Show Log" command. Changing the level takes
      effect without a reload.
- [x] Resolve completion items before showing them (`scalaNotebook.completionResolveCount`).
      A relayed completion is never resolved on demand, so documentation, detail and
      auto-import edits were arriving empty.
- [x] Index cell URIs to their notebook, instead of scanning every cell of every open
      notebook on each language request - inlay hints alone ask on every scroll. Falls back
      to the scan for a cell added since the last regenerate.
- [x] Forward selection ranges (expand/shrink selection), cutting each chain where it grows
      past the cell so expanding stops at the cell boundary instead of selecting the wrapper
      object and then the whole shadow file.
- [x] ~~Put a notebook's shadow in the nearest Mill build at or above it.~~ Removed with the
      Mill target: it existed only because a shadow outside the build was never compiled.
      scala-cli needs no build file, so the shadow goes in one directory relative to the
      workspace folder again, wherever the notebook sits under it.
- [x] Retry adoption for a notebook that had no Scala code cell when it opened. The check ran
      once, at open, and a skipped notebook was never reconsidered, so choosing the kernel or
      typing the first code cell afterwards left it without a shadow until it was reopened.
- [x] Emit the shadow as a scala-cli script (`.sc` with `//> using` directives) and remove the
      Mill target entirely (issue #15): the `//|` header, the Mill build-root discovery, the
      `./mill <path>:compile` escape hatch, and the `.dest/`-copy relay with its marker parsing
      and line-offset plumbing. One Mill script was one build target, which is where the
      reimport-per-notebook and reimport-plus-clean-per-`$ivy` costs came from.
- [x] Issue #15 §5.4, observed: squiggles reach the cells, so Metals reports against the `.sc`
      itself and not scala-cli's `.scala-build/` wrapper. One manual session, not a recorded
      probe run - versions uncaptured, and the wrapper case not ruled out for every request
      type. The relay still refuses to guess a line offset for a `.scala-build/` path and logs
      it at `debug`; if that ever fires, the offset plumbing comes back in a different shape
      (matched by name, since the wrapper carries no marker).
- [ ] Answer issue #15 §5.5/§5.6: whether a second `.sc` and a changed `//> using dep` are
      picked up without a restart, and whether a bad coordinate recovers. These are the direct
      replacements for Mill's reimport and reimport-plus-clean, and the whole reason for the
      switch - until they are measured, the costs are moved rather than known to be gone.
- [ ] Answer issue #15 §5.7: whether the wrapper object and the `-Wconf` are still needed in a
      `.sc`, where top-level statements are already legal. If not, the emitter loses both and
      every cell line maps one-to-one with no wrapper offset.
- [ ] Suppress or rewrite hover text that exposes synthesized machinery (`resN_M` result
      names, the wrapper/nesting objects in an owner path).
- [ ] Translate inlay-hint label links that point into the shadow script back to the defining
      cell, rather than stripping them.
- [x] Forward code actions (Metals' quick fixes and refactors), translating the `WorkspaceEdit`
      each one carries back into cell edits. The diagnostics a quick fix keys off need **no**
      back-translation, contrary to the note this entry used to carry:
      `vscode.executeCodeActionProvider` has VS Code build the request context from the markers
      on the shadow URI, which are still Metals' own - the relay publishes cell diagnostics into
      a *separate* collection and never clears Metals'.
- [x] Re-home a quick fix's out-of-cell *insertion* to the top of the requesting cell, which is
      what makes "import missing symbol" work: Metals puts the import in the prelude, outside
      every span. Faithful to the notebook, where an import in one cell is in scope for the
      cells after it. Only insertions are re-homed - a replacement outside every cell (Metals
      organizing the whole script's imports) would move the prelude into the user's cell, so it
      rejects and the action is not offered.
- [x] Drop a code action backed by a server-side `command` rather than an edit. Its arguments
      name the shadow file and shadow positions, and if it ran, its edit would land in the
      shadow - which the next regenerate discards.
- [x] Hand back an edit that touches no generated file *unchanged* rather than rebuilt: file
      creations, renames and deletions are not reachable through `WorkspaceEdit.entries()`, so
      rebuilding one would silently drop them and leave "create class in a new file" doing
      nothing.
- [x] Forward rename, with the same edit translation but no re-homing: a rename is atomic over
      every occurrence, so an occurrence that cannot be placed in a cell fails the whole rename
      with a message rather than being skipped. `prepareRename` refuses up front when Metals
      offers to rename generated code.
- [x] Forward document symbols, descending the shadow's outline rather than filtering it: a
      symbol that fits the cell is kept with its children, one that does not is discarded but
      still searched, which strips the wrapper object and the redefinition scopes without losing
      what they contain.
- [x] Forward folding ranges, dropping any fold that reaches past the cell (the wrapper object
      and the redefinition scopes).
- [x] Forward semantic tokens, so cells get Metals' own Scala highlighting instead of TextMate
      guesswork. Registered lazily: the provider needs the *server's* token legend, and the
      legend can only be asked for against a file Metals has loaded, so registration retries on
      each analysis change until it succeeds. Unlike the inlay-hint settings this needs no
      configuration - `metals.enableSemanticHighlighting` defaults to true.
- [x] Answer code actions and semantic tokens without driving shadow writes. VS Code asks for
      code actions on every caret move to decide whether to show the lightbulb, so only a
      deliberate invocation (`CodeActionTriggerKind.Invoke`) synchronizes first; semantic tokens
      and document symbols follow the shadow like inlay hints do.
- [ ] Put the completion path's out-of-cell edits through `shadowEditsToCells` too. It re-homes
      them by collapsing the range to the cell's start, which keeps the text and so does the
      right thing for an insertion, but silently turns a header *replacement* into an insertion
      as well - copying the replaced text into the cell rather than moving it.
- [ ] Recover the code actions that are dropped rather than translated: the command-backed ones
      (a Metals server command against the shadow), and "organize imports", whose edits rewrite
      the prelude. Both would need the emitter's cooperation, not more mapping.
- [ ] Formatting (scalafmt through Metals) waits on §5.7. While cell bodies sit inside the
      wrapper object, scalafmt wants to indent every one of them, so formatting a cell would
      return a +2-space edit on every line. Dropping the wrapper makes the feature nearly free,
      which is worth more than §5.7 looks like on its own.
- [ ] Resolve `import $file` against sibling scripts instead of neutralizing it.
- [ ] research if there is a way to customise almond's classpath directly... if there is then maybe
      we could also put the project's own sources on the shadow's classpath (`//> using file`).

## Automated tests

- [x] Unit-test cell-to-shadow and shadow-to-cell position/range mapping.
- [x] Unit-test the Scala scanner and statement segmentation, including bail-out cases.
- [x] Unit-test `resN_M` numbering and append-only binding placement.
- [x] Unit-test the names a cell defines, and when a redefinition opens a nested scope.
- [x] Extract definition-result translation into pure, unit-testable functions
      (`shadowLinkToCell`, `rangeWithinSpan` in mapping.ts).
- [x] Unit-test definitions targeting the same notebook cell.
- [x] Unit-test definitions targeting a different notebook cell.
- [x] Unit-test definition targets outside every cell.
- [ ] Unit-test definitions targeting external source files. (Decided in languageFeatures.ts,
      which needs the VS Code runtime, so this waits on Extension Host tests.)
- [x] Unit-test cell-relative position translation and whole-span shadow ranges
      (`positionWithinSpan`, `spanShadowRange`), which inlay hints are built on.
- [x] Unit-test shadow-script naming: stability across reopens, nested paths, notebooks
      sharing a basename, and names Scala can't hold as identifiers.
- [x] Unit-test log level filtering, line formatting, scoping, and that a filtered-out
      thunk is never evaluated.
- [x] Unit-test selection-chain truncation at the cell boundary.
- [x] Unit-test the `//> using` header: directive spellings, one directive per dependency and
      repository, the quoted `-Wconf` value, ordering, and `$ivy` deduplication.
- [x] Golden-test the shadow the fixture notebook produces, whole.
- [x] Unit-test that scala-cli's `.scala-build/` wrappers are recognised, so generated code is
      never offered as a reference or an inlay-hint link.
- [x] Unit-test shadow-to-cell edit translation: in-cell edits, grouping by cell, an edit
      crossing a cell boundary, an out-of-cell insertion with and without somewhere to re-home
      it, and the refusal to re-home a replacement.
- [x] Unit-test semantic-token re-encoding: delta decoding, the encode/decode round trip,
      defensive ordering, filtering to a cell's lines, and that a column delta is rebuilt after
      an earlier token on the same line is dropped.
- [ ] Unit-test reference filtering (other notebooks' shadows, synthesized lines,
      de-duplication) - needs the VS Code runtime, so it waits on Extension Host tests.
- [ ] Extract completion-result translation into pure, unit-testable functions.
- [ ] Unit-test completion replacement and insertion ranges.
- [ ] Unit-test completion additional edits, including auto-import edits outside a cell span.
- [ ] Add VS Code Extension Host tests for provider registration and request forwarding.
- [ ] Add an end-to-end test with Metals for jump to definition and completions.

## Manual verification

- [ ] Verify `F12` and Cmd-click within one notebook cell.
- [ ] Verify `F12` and Cmd-click across notebook cells.
- [ ] Verify navigation to dependency and standard-library sources.
- [ ] Verify completions while typing and after `.`.
- [ ] Verify completion auto-imports are inserted into the notebook cell correctly.
- [ ] Verify definition and completion requests use unsaved, recently edited cell content.
- [ ] Verify hover shows inferred types, and that its highlight covers the hovered token.
- [ ] Verify signature help appears and updates as arguments are typed.
- [ ] Verify `Go to Implementation` on a trait member, and `Go to Type Definition` (Metals may
      not implement the latter, in which case the provider correctly returns nothing).
- [ ] Verify occurrences of a symbol highlight within a cell and do not bleed across cells.
- [ ] Enable the `metals.inlayHints.*` settings, then verify inferred types appear on cell
      `val`s and that accepting one writes the annotation into the cell, not the shadow.
- [ ] Verify inlay hints refresh after a cell edit once Metals has recompiled, without the
      hints themselves forcing a shadow write on every keystroke.
- [ ] Verify `Find All References` on a name used across several cells lists each cell, and
      shows no results in the shadow file or under `.scala-build/`.
- [ ] Verify the completion documentation pane is populated, and that an auto-import
      completion still inserts its import.
- [ ] Verify Shift-Alt-Right expands by syntax within a cell and stops at the cell edge.
- [ ] Verify a quick fix on an unresolved name inserts its import at the top of the cell, and
      that the import is still there after the shadow regenerates.
- [ ] Verify "organize imports" is absent from the Source Action menu, rather than present and
      inert.
- [ ] Verify renaming a `val` used across several cells rewrites every cell in one undo step,
      and that renaming a `resN_M` binding or a prelude name is refused with a message.
- [ ] Verify the cell outline (Cmd-Shift-O) lists the cell's own definitions and neither the
      wrapper object nor the other cells'.
- [ ] Verify cells get semantic highlighting, and check the log for the line naming the token
      count. Metals registers its own semantic-tokens provider for `scala`; VS Code picks one
      provider rather than merging, so confirm ours is the one asked - if Metals' wins, the
      cells fall back to TextMate colours and this feature is a no-op.
- [ ] Verify expanding/collapsing a fold inside a cell never hides lines the cell does not
      contain.
- [ ] Run issue #15's open probes against `fixture/`, which now has no build file at all:
      capture Metals' acceptance prompt verbatim, note whether it reappears per shadow file,
      and record at `debug` which URI diagnostics actually arrive on (§5.4).
- [ ] Verify a second notebook's `.sc` is compiled without a restart or reimport (§5.5), and
      that adding a `//> using dep` to a live shadow re-resolves - including recovery from a
      bad coordinate, which is a different code path from first resolution (§5.6).
- [ ] Verify that a `.scala` shadow left over from the Mill version logs the warning naming it,
      and that deleting it clears the duplicate-definition errors on every cell.
- [ ] Verify closing and reopening a notebook reuses its shadow file rather than creating a
      second one, and that two notebooks sharing a basename get distinct shadows.