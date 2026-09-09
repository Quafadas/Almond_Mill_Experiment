# fixture-nobuild

The second fixture workspace issue #15 §4 asks for: a copy of [`../fixture`](../fixture)'s
notebook with **no build file at all** — no `build.mill.yaml`, no `mill` launcher, no
`.mill-version`.

Under `scalaNotebook.buildTool: "mill"` a notebook here gets a shadow file and nothing
else: there is no Mill build to compile it, so no diagnostics ever arrive. That is the
baseline. Under `"scala-cli"` the shadow is a `.sc` in `notebook-shadow/`, which Metals
should route to its own scala-cli build server without any build file being present — the
claim the probes are there to test.

Open this directory as the workspace folder on its own; opening the repository root
instead puts it under a folder that has no build file either, which tests something else.
