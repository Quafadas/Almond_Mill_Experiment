import * as vscode from "vscode";
import { CONFIG_DEFAULTS } from "./configDefaults";
import { LanguageFeatureRelay } from "./languageFeatures";
import { isLogLevel, LogLevel, Logger } from "./log";
import { DiagnosticRelay } from "./relay";
import { ExtensionConfig, ShadowManager, ShadowState } from "./shadowManager";

function readLogLevel(cfg: vscode.WorkspaceConfiguration): LogLevel {
  const value = cfg.get<string>("logLevel", CONFIG_DEFAULTS.logLevel);
  return isLogLevel(value) ? value : CONFIG_DEFAULTS.logLevel;
}

function readConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("scalaNotebook");
  return {
    logLevel: readLogLevel(cfg),
    completionResolveCount: cfg.get<number>("completionResolveCount", CONFIG_DEFAULTS.completionResolveCount),
    codeActionResolveCount: cfg.get<number>("codeActionResolveCount", CONFIG_DEFAULTS.codeActionResolveCount),
    scalaVersion: cfg.get<string>("scalaVersion", CONFIG_DEFAULTS.scalaVersion),
    mvnDeps: cfg.get<string[]>("mvnDeps", CONFIG_DEFAULTS.mvnDeps),
    preamble: cfg.get<string[]>("preamble", CONFIG_DEFAULTS.preamble),
    almondVersion: cfg.get<string>("almondVersion", CONFIG_DEFAULTS.almondVersion ?? ""),
    ammoniteVersion: cfg.get<string>("ammoniteVersion", CONFIG_DEFAULTS.ammoniteVersion ?? ""),
    shadowDir: cfg.get<string>("shadowDir", CONFIG_DEFAULTS.shadowDir),
    debounceMs: cfg.get<number>("debounceMs", CONFIG_DEFAULTS.debounceMs),
    compileOnSave: cfg.get<boolean>("compileOnSave", CONFIG_DEFAULTS.compileOnSave),
  };
}

/**
 * The code-action kinds a cell can actually be offered, which VS Code uses to skip the
 * provider entirely when a request asks for something else.
 *
 * `source.organizeImports` is deliberately absent. Metals organizes the imports of the whole
 * shadow script, so its edits rewrite the Almond prelude - text no cell contains - and the
 * relay rejects them. Declaring the kind would put an "Organize Imports" entry in the Source
 * Action menu that could only ever do nothing.
 */
const CELL_CODE_ACTION_KINDS: readonly vscode.CodeActionKind[] = [
  vscode.CodeActionKind.QuickFix,
  vscode.CodeActionKind.Refactor,
  vscode.CodeActionKind.RefactorExtract,
  vscode.CodeActionKind.RefactorInline,
  vscode.CodeActionKind.RefactorRewrite,
];

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

  /**
   * Semantic highlighting has to be registered with the *server's* token legend, and the
   * legend can only be asked for against a file the server knows. So unlike every other
   * provider this one cannot be registered at activation: it waits for a notebook to have a
   * shadow script that Metals has actually loaded.
   *
   * Registration is attempted on each analysis change until it succeeds, because the first
   * few attempts happen while Metals is still starting its build server, or before the user
   * has accepted its prompt to import the shadow directory.
   */
  let semanticTokens: vscode.Disposable | undefined;
  let legendPending = false;
  const registerSemanticTokens = async (state: ShadowState): Promise<void> => {
    if (semanticTokens || legendPending) {
      return;
    }
    legendPending = true;
    try {
      const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend | undefined>(
        "vscode.provideDocumentSemanticTokensLegend",
        state.shadowUri
      );
      if (!legend || legend.tokenTypes.length === 0) {
        log.debug(
          () => `No semantic-token legend for ${state.relativePath} yet; cell highlighting stays off for now.`
        );
        return;
      }
      semanticTokens = vscode.languages.registerDocumentSemanticTokensProvider(
        scalaNotebookCells,
        languageFeatures,
        legend
      );
      context.subscriptions.push(semanticTokens);
      log.info(`Semantic highlighting enabled for cells (${legend.tokenTypes.length} token types).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.debug(`Could not read the semantic-token legend: ${message}`);
    } finally {
      legendPending = false;
    }
  };

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
      // Also an adoption attempt: a notebook with no Scala code cell when it opened is
      // skipped, and this is where it gets picked up once one appears.
      void shadowManager.adoptOrRegenerate(e.notebook);
    }),

    // Switching a cell to Scala - picking the Almond kernel on a notebook that carried no
    // Scala metadata - re-opens the cell's text document rather than changing the notebook,
    // so it is the only signal that such a notebook has become eligible.
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.uri.scheme !== "vscode-notebook-cell" || doc.languageId !== "scala") {
        return;
      }
      const notebook = vscode.workspace.notebookDocuments.find(
        (candidate) =>
          candidate.notebookType === "jupyter-notebook" &&
          !shadowManager.getStateForNotebook(candidate) &&
          candidate.getCells().some((cell) => cell.document === doc)
      );
      if (notebook) {
        void shadowManager.openForNotebook(notebook);
      }
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

    shadowManager.onDidChangeAnalysis((state) => {
      void registerSemanticTokens(state);
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
    vscode.languages.registerCodeActionsProvider(scalaNotebookCells, languageFeatures, {
      providedCodeActionKinds: CELL_CODE_ACTION_KINDS,
    }),
    vscode.languages.registerRenameProvider(scalaNotebookCells, languageFeatures),
    vscode.languages.registerDocumentSymbolProvider(scalaNotebookCells, languageFeatures),
    vscode.languages.registerFoldingRangeProvider(scalaNotebookCells, languageFeatures),

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
