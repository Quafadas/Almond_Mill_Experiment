# Scala Notebook Shadow (POC)

Shows Metals compile diagnostics — and hover, completion, go-to-definition, rename, code
actions and the rest — inside the Scala cells of a `.ipynb` notebook in VS Code.

It works by concatenating a notebook's Scala cells into a hidden "shadow" scala-cli script
(`notebook-shadow/<name>.sc`), letting Metals analyse that, and remapping everything Metals
reports for the script back onto the cell it came from. Neither Metals nor scala-cli is
modified, and **no build file of any kind is required** in the workspace — Metals starts a
scala-cli build server for a directory of `.sc` files on its own.

This is a proof of concept. See the
[repository README](https://github.com/Quafadas/Almond_Mill_Experiment#readme) for the full
write-up: how the shadow is built, what is verified and what is not, and a frank list of
known limitations.

## Requirements

- [Metals](https://marketplace.visualstudio.com/items?itemName=scalameta.metals) installed
  in the same window.
- A JDK that Metals and scala-cli can use.

Open a notebook with Scala code cells and the extension activates on its own. Metals will
prompt to import the generated shadow directory as a scala-cli script; accept it.

## Commands

| Command | What it does |
| --- | --- |
| **Scala Notebook: Open Shadow File** | Opens the generated `.sc` for the active notebook. |
| **Scala Notebook: Regenerate Shadow File** | Rewrites and saves it, bypassing the unchanged-text short-circuit. |
| **Scala Notebook: Show Log** | Opens the extension's output channel. |

## Settings

All under `scalaNotebook.*`; the settings UI carries a description for each. The ones worth
knowing about:

- **`scalaVersion`** — written into the shadow's `//> using scala` directive. Must match the
  kernel you run, or you get phantom errors.
- **`almondVersion`** / **`ammoniteVersion`** — which predef the shadow reproduces, so a cell
  can write `Markdown(...)`, `publish.stdout(...)` or `repl.sess` and have it resolve. Set
  either to `""` to leave that half out.
- **`mvnDeps`** — extra dependencies, merged with whatever the notebook's `import $ivy` lines
  ask for.
- **`shadowDir`** — where the `.sc` files are written, relative to the first workspace folder.

Changing any of these rewrites the shadows already open, so it takes effect immediately.

## Licence

Apache 2.0 — see [LICENSE](LICENSE).
