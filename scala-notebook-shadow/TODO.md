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
      that arrives both against the shadow file and Mill's copy of it.
- [x] Mimic almond cell handling to allow top level statements when emitting the shadow file.
- [x] ivy import translation to mill import statements in the shadow file.
- [x] Bind cell expressions to Almond's `resN_M` names so later cells can reference them.
- [x] Relay diagnostics reported against Mill's generated `.dest/` copy of the shadow file.
- [x] Allow a name defined in one cell to be redefined in a later cell (nest the redefining cell
      and everything after it in a further object, so the new definition shadows the old).
- [x] Reproduce Almond's predef in the shadow file, so `Markdown("# Hello World")`, `publish` and
      the rest of the display API resolve without an import.
- [x] Put Ammonite's `repl` and `interp` bridges in scope, along with the classpath they carry
      (os-lib, pprint, fansi).
- [x] Name a shadow script after the notebook's path within the workspace, so one notebook
      maps to one shadow file. Replaces a name-handout registry that never released names on
      close, which gave a reopened notebook a second shadow (`sample.scala`, `sample_2.scala`).
- [x] Ask every file a shadow is known by for inlay hints, not just the shadow script.
      Metals answers definition and completion for the script, but inlay hints come from the
      presentation compiler for a real build-target source - Mill's `.dest/` copy - so the
      script alone returned nothing.
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
- [x] Pick up a notebook anywhere under the workspace, not only beside the Mill build: the
      shadow goes in the nearest Mill build at or above the notebook (`build.mill`,
      `build.mill.yaml`, `build.mill.scala`, `.mill-version`), falling back to the workspace
      folder root. Previously the shadow always landed in the workspace folder root, so
      opening a parent of the Mill project wrote it above the build where Mill never saw it -
      the notebook was adopted and the shadow written, but no diagnostics ever arrived.
- [x] Retry adoption for a notebook that had no Scala code cell when it opened. The check ran
      once, at open, and a skipped notebook was never reconsidered, so choosing the kernel or
      typing the first code cell afterwards left it without a shadow until it was reopened.
- [ ] Suppress or rewrite hover text that exposes synthesized machinery (`resN_M` result
      names, the wrapper/nesting objects in an owner path).
- [ ] Translate inlay-hint label links that point into the shadow script back to the defining
      cell, rather than stripping them. Needs the async `.dest/` resolution that definitions
      use, which `provideInlayHints` currently avoids to stay synchronous.
- [ ] Consider code actions (Metals' "import missing symbol"): needs cell diagnostics
      translated back into shadow coordinates for the request, plus `WorkspaceEdit` translation.
- [ ] Resolve `import $file` against sibling scripts instead of neutralizing it.
- [ ] research if there is a way to customise almond's classpath directly... if there is then maybe we could also use mill modules in the same project.

## Automated tests

- [x] Unit-test cell-to-shadow and shadow-to-cell position/range mapping.
- [x] Unit-test the Scala scanner and statement segmentation, including bail-out cases.
- [x] Unit-test `resN_M` numbering and append-only binding placement.
- [x] Unit-test Mill generated-copy marker parsing and diagnostic rebasing.
- [x] Unit-test the names a cell defines, and when a redefinition opens a nested scope.
- [x] Extract definition-result translation into pure, unit-testable functions
      (`shadowLinkToCell`, `rangeWithinSpan` in mapping.ts).
- [x] Unit-test definitions targeting the same notebook cell.
- [x] Unit-test definitions targeting a different notebook cell.
- [x] Unit-test definition targets outside every cell, and targets reported against a Mill
      `.dest/` copy.
- [ ] Unit-test definitions targeting external source files. (Decided by `resolveShadowSource`
      in shadowManager.ts, which needs the VS Code runtime, so this waits on Extension Host tests.)
- [x] Unit-test cell-relative position translation and whole-span shadow ranges
      (`positionWithinSpan`, `spanShadowRange`), which inlay hints are built on.
- [x] Unit-test shadow-script naming: stability across reopens, nested paths, notebooks
      sharing a basename, and names Scala can't hold as identifiers.
- [x] Unit-test log level filtering, line formatting, scoping, and that a filtered-out
      thunk is never evaluated.
- [x] Unit-test selection-chain truncation at the cell boundary.
- [x] Unit-test Mill build-root discovery: nearest build above the notebook, the walk not
      escaping the workspace folder, each marker on its own, and the no-build fallback.
- [ ] Unit-test reference filtering (other notebooks' shadows, synthesized lines,
      de-duplication) - needs the async `resolveShadowSource`, so it waits on Extension Host tests.
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
      shows no results in the shadow file or in `.dest/`.
- [ ] Verify the completion documentation pane is populated, and that an auto-import
      completion still inserts its import.
- [ ] Verify Shift-Alt-Right expands by syntax within a cell and stops at the cell edge.
- [ ] Verify inlay hints appear once Mill has produced a `.dest/` copy, and check the log at
      `debug` to see which source answered.
- [ ] Verify closing and reopening a notebook reuses its shadow file rather than creating a
      second one, and that two notebooks sharing a basename get distinct shadows.