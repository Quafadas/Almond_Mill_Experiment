import type * as vscode from "vscode";

/** Minimal fake of vscode.Uri sufficient for transform.ts/mapping.ts, which only
 * ever read `.fragment` and call `.toString()`. Avoids depending on the real
 * `vscode` module so these tests run under plain `node --test`. */
export function fakeUri(fragment: string): vscode.Uri {
  const str = `vscode-notebook-cell:/fake/notebook.ipynb#${fragment}`;
  return {
    fragment,
    toString: () => str,
  } as unknown as vscode.Uri;
}
