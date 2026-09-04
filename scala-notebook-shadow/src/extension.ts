import * as vscode from "vscode";
import { DiagnosticRelay } from "./relay";
import { ExtensionConfig, ShadowManager } from "./shadowManager";

function readConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("scalaNotebook");
  return {
    scalaVersion: cfg.get<string>("scalaVersion", "3.7.2"),
    mvnDeps: cfg.get<string[]>("mvnDeps", []),
    preamble: cfg.get<string[]>("preamble", []),
    shadowDir: cfg.get<string>("shadowDir", "notebook-shadow"),
    debounceMs: cfg.get<number>("debounceMs", 400),
    compileOnCreate: cfg.get<boolean>("compileOnCreate", false),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Scala Notebook Shadow");
  const collection = vscode.languages.createDiagnosticCollection("scala-notebook");
  const shadowManager = new ShadowManager(collection, readConfig, output);
  const relay = new DiagnosticRelay(collection, shadowManager);

  context.subscriptions.push(output, collection, shadowManager);

  // Pick up notebooks already open when the extension activates.
  for (const notebook of vscode.workspace.notebookDocuments) {
    void shadowManager.openForNotebook(notebook);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument((notebook) => {
      void shadowManager.openForNotebook(notebook);
    }),

    vscode.workspace.onDidChangeNotebookDocument((e) => {
      const hasRelevantChange = e.contentChanges.length > 0 || e.cellChanges.some((c) => c.document !== undefined);
      if (!hasRelevantChange) {
        return;
      }
      shadowManager.scheduleRegenerate(e.notebook);
    }),

    vscode.workspace.onDidCloseNotebookDocument((notebook) => {
      shadowManager.closeForNotebook(notebook);
    }),

    vscode.workspace.onDidCloseTextDocument((doc) => {
      shadowManager.markClosedIfShadow(doc);
    }),

    vscode.languages.onDidChangeDiagnostics((e) => {
      relay.onDidChangeDiagnostics(e);
    }),

    vscode.commands.registerCommand("scalaNotebook.openShadow", async () => {
      const notebook = vscode.window.activeNotebookEditor?.notebook;
      if (!notebook) {
        vscode.window.showInformationMessage("No active notebook.");
        return;
      }
      const state = shadowManager.getStateForNotebook(notebook);
      if (!state) {
        vscode.window.showInformationMessage("No shadow file for the active notebook (does it have Scala code cells?).");
        return;
      }
      await vscode.window.showTextDocument(state.shadowUri, { preview: false });
    }),

    vscode.commands.registerCommand("scalaNotebook.regenerate", async () => {
      const notebook = vscode.window.activeNotebookEditor?.notebook;
      if (!notebook) {
        vscode.window.showInformationMessage("No active notebook.");
        return;
      }
      await shadowManager.regenerate(notebook, true);
    })
  );
}

export function deactivate(): void {
  // Nothing to do: all disposables are owned by context.subscriptions.
}
