import * as vscode from "vscode";
import { LanguageFeatureRelay } from "./languageFeatures";
import { isLogLevel, LogLevel, Logger } from "./log";
import { DiagnosticRelay } from "./relay";
import { ExtensionConfig, ShadowManager } from "./shadowManager";

function readLogLevel(cfg: vscode.WorkspaceConfiguration): LogLevel {
  const value = cfg.get<string>("logLevel", "info");
  return isLogLevel(value) ? value : "info";
}

function readConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("scalaNotebook");
  return {
    logLevel: readLogLevel(cfg),
    completionResolveCount: cfg.get<number>("completionResolveCount", 30),
    scalaVersion: cfg.get<string>("scalaVersion", "3.7.2"),
    mvnDeps: cfg.get<string[]>("mvnDeps", []),
    preamble: cfg.get<string[]>("preamble", []),
    almondVersion: cfg.get<string>("almondVersion", "0.14.5"),
    ammoniteVersion: cfg.get<string>("ammoniteVersion", "3.0.8"),
    shadowDir: cfg.get<string>("shadowDir", "notebook-shadow"),
    debounceMs: cfg.get<number>("debounceMs", 400),
    compileOnCreate: cfg.get<boolean>("compileOnCreate", false),
    compileOnSave: cfg.get<boolean>("compileOnSave", true),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Scala Notebook Shadow");

  // Cached rather than read per line, and refreshed when the setting changes, so raising
  // the level takes effect without a reload.
  let logLevel = readLogLevel(vscode.workspace.getConfiguration("scalaNotebook"));
  const log = new Logger(output, () => logLevel);

  const collection = vscode.languages.createDiagnosticCollection("scala-notebook");
  const shadowManager = new ShadowManager(collection, readConfig, log.scoped("shadow"));
  const relay = new DiagnosticRelay(collection, shadowManager, log.scoped("diagnostics"));
  const languageFeatures = new LanguageFeatureRelay(shadowManager, log.scoped("language"), readConfig);
  const scalaNotebookCells: vscode.DocumentSelector = [
    { language: "scala", notebookType: "jupyter-notebook" },
  ];

  context.subscriptions.push(output, collection, shadowManager, languageFeatures);

  log.info(`Activated (log level ${logLevel}); use "Scala Notebook: Show Log" to reopen this channel.`);

  // Pick up notebooks already open when the extension activates.
  for (const notebook of vscode.workspace.notebookDocuments) {
    void shadowManager.openForNotebook(notebook);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("scalaNotebook.logLevel")) {
        logLevel = readLogLevel(vscode.workspace.getConfiguration("scalaNotebook"));
        log.info(`Log level set to ${logLevel}`);
      }
    }),

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

    vscode.languages.registerDefinitionProvider(scalaNotebookCells, languageFeatures),
    vscode.languages.registerTypeDefinitionProvider(scalaNotebookCells, languageFeatures),
    vscode.languages.registerImplementationProvider(scalaNotebookCells, languageFeatures),
    vscode.languages.registerHoverProvider(scalaNotebookCells, languageFeatures),
    vscode.languages.registerSignatureHelpProvider(scalaNotebookCells, languageFeatures, "(", ","),
    vscode.languages.registerDocumentHighlightProvider(scalaNotebookCells, languageFeatures),
    vscode.languages.registerSelectionRangeProvider(scalaNotebookCells, languageFeatures),
    vscode.languages.registerReferenceProvider(scalaNotebookCells, languageFeatures),
    vscode.languages.registerInlayHintsProvider(scalaNotebookCells, languageFeatures),
    vscode.languages.registerCompletionItemProvider(scalaNotebookCells, languageFeatures, "."),

    vscode.commands.registerCommand("scalaNotebook.showLog", () => {
      output.show(true);
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
