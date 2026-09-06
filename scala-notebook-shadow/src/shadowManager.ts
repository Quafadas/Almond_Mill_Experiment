import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { looksLikeGeneratedSource, parseGeneratedSourceHeader } from "./generatedSource";
import { Logger, LogLevel } from "./log";
import { shadowBaseName } from "./shadowNaming";
import { ScalaNotebookConfig, ShadowMapping, SourceCell, transform } from "./transform";

export interface ExtensionConfig extends ScalaNotebookConfig {
  logLevel: LogLevel;
  completionResolveCount: number;
  shadowDir: string;
  debounceMs: number;
  compileOnCreate: boolean;
  compileOnSave: boolean;
}

export interface ShadowState {
  notebook: vscode.NotebookDocument;
  shadowUri: vscode.Uri;
  /** Relative to the workspace folder, e.g. "notebook-shadow/sample.scala". Used for `./mill <path>:compile`. */
  relativePath: string;
  /** Name of the object cells are wrapped in; unique per shadow file. */
  wrapperObjectName: string;
  mapping: ShadowMapping;
  /** Mill `.dest/` copies of this shadow file that diagnostics have been seen on, by URI string. */
  generatedSources: Map<string, DiagnosticSource>;
  appliedText: string | undefined;
  closed: boolean;
  debounceHandle: NodeJS.Timeout | undefined;
}

/** A file diagnostics may be reported against for a given shadow script. */
export interface DiagnosticSource {
  uri: vscode.Uri;
  /** Lines to subtract to get back to shadow-file coordinates; 0 for the shadow file itself. */
  lineOffset: number;
}

/**
 * Owns the per-notebook shadow document: creation, regeneration on notebook
 * edits (debounced), and bookkeeping needed by the diagnostic relay.
 */
export class ShadowManager implements vscode.Disposable {
  private readonly states = new Map<string, ShadowState>(); // key: notebook.uri.toString()
  private readonly shadowUriToNotebookUri = new Map<string, string>(); // shadowUri.toString() -> notebookUri.toString()
  /**
   * cellUri.toString() -> notebookUri.toString(), refreshed whenever a notebook's cells are
   * read. Every hover, completion and inlay-hint request starts by resolving a cell to its
   * notebook, and inlay hints are requested on scroll, so this must not be a scan of every
   * cell of every open notebook.
   */
  private readonly cellUriToNotebookUri = new Map<string, string>();
  private readonly notGeneratedSources = new Set<string>(); // URIs checked and ruled out
  private readonly analysisChangedEmitter = new vscode.EventEmitter<ShadowState>();

  /**
   * Fires when a notebook's shadow script, or Metals' analysis of it, may have moved on:
   * after the shadow is rewritten, and when fresh diagnostics arrive for it. Results that
   * VS Code caches rather than re-requests on demand - inlay hints - hang off this.
   */
  readonly onDidChangeAnalysis = this.analysisChangedEmitter.event;

  constructor(
    private readonly collection: vscode.DiagnosticCollection,
    private readonly getConfig: () => ExtensionConfig,
    private readonly log: Logger
  ) {}

  dispose(): void {
    for (const state of this.states.values()) {
      if (state.debounceHandle) {
        clearTimeout(state.debounceHandle);
      }
    }
    this.states.clear();
    this.shadowUriToNotebookUri.clear();
    this.cellUriToNotebookUri.clear();
    this.analysisChangedEmitter.dispose();
  }

  /** Announce that Metals may have new answers for this notebook (see onDidChangeAnalysis). */
  notifyAnalysisChanged(state: ShadowState): void {
    this.analysisChangedEmitter.fire(state);
  }

  getStateForNotebook(notebook: vscode.NotebookDocument): ShadowState | undefined {
    return this.states.get(notebook.uri.toString());
  }

  getStateForShadowUri(shadowUri: vscode.Uri): ShadowState | undefined {
    const notebookKey = this.shadowUriToNotebookUri.get(shadowUri.toString());
    return notebookKey ? this.states.get(notebookKey) : undefined;
  }

  getStateForCellUri(cellUri: vscode.Uri): ShadowState | undefined {
    const key = cellUri.toString();
    const indexed = this.cellUriToNotebookUri.get(key);
    const state = indexed ? this.states.get(indexed) : undefined;
    if (state) {
      return state;
    }

    // A cell added since the last regenerate isn't in the index yet - the notebook is only
    // re-read on a debounce. Fall back to the scan, and remember what it found.
    const found = [...this.states.values()].find((candidate) =>
      candidate.notebook.getCells().some((cell) => cell.document.uri.toString() === key)
    );
    if (found) {
      this.cellUriToNotebookUri.set(key, found.notebook.uri.toString());
    }
    return found;
  }

  /** Point every one of a notebook's current cells at it. Stale entries resolve to no span. */
  private indexCells(state: ShadowState): void {
    const notebookKey = state.notebook.uri.toString();
    for (const cell of state.notebook.getCells()) {
      this.cellUriToNotebookUri.set(cell.document.uri.toString(), notebookKey);
    }
  }

  isShadowUri(uri: vscode.Uri): boolean {
    return this.shadowUriToNotebookUri.has(uri.toString());
  }

  /** Cheap sync gate, so we only do I/O for URIs that could belong to a shadow script. */
  mightBeShadowSource(uri: vscode.Uri): boolean {
    return this.isShadowUri(uri) || looksLikeGeneratedSource(uri.fsPath);
  }

  /**
   * Resolve a URI diagnostics arrived for to the shadow script it belongs to - either the
   * shadow file itself, or one of Mill's generated `.dest/` copies of it (which is what
   * Metals actually reports against; see generatedSource.ts).
   */
  async resolveShadowSource(uri: vscode.Uri): Promise<{ state: ShadowState; lineOffset: number } | undefined> {
    const direct = this.getStateForShadowUri(uri);
    if (direct) {
      return { state: direct, lineOffset: 0 };
    }
    if (!looksLikeGeneratedSource(uri.fsPath)) {
      return undefined;
    }

    const key = uri.toString();
    for (const state of this.states.values()) {
      const known = state.generatedSources.get(key);
      if (known) {
        return { state, lineOffset: known.lineOffset };
      }
    }
    if (this.notGeneratedSources.has(key)) {
      return undefined;
    }

    let header;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      header = parseGeneratedSourceHeader(Buffer.from(bytes).toString("utf8"));
    } catch {
      header = undefined;
    }
    if (!header) {
      // A `.dest/` Scala file that isn't a Mill script copy at all; never look again.
      this.notGeneratedSources.add(key);
      return undefined;
    }

    const originalPath = header.originalPath;
    const state = [...this.states.values()].find((candidate) => candidate.shadowUri.fsPath === originalPath);
    if (!state) {
      // A shadow file for a notebook that isn't open yet - don't cache a negative answer.
      return undefined;
    }

    state.generatedSources.set(key, { uri, lineOffset: header.lineOffset });
    this.log.debug(`Generated copy ${key} -> ${state.shadowUri.toString()} (+${header.lineOffset} lines)`);
    return { state, lineOffset: header.lineOffset };
  }

  /** Every file diagnostics for this shadow script may arrive on. */
  diagnosticSourcesFor(state: ShadowState): DiagnosticSource[] {
    return [{ uri: state.shadowUri, lineOffset: 0 }, ...state.generatedSources.values()];
  }

  allShadowUris(): vscode.Uri[] {
    return [...this.states.values()].map((s) => s.shadowUri);
  }

  private hasScalaCodeCell(notebook: vscode.NotebookDocument): boolean {
    return notebook.getCells().some((c) => c.kind === vscode.NotebookCellKind.Code && c.document.languageId === "scala");
  }

  private toSourceCells(notebook: vscode.NotebookDocument): SourceCell[] {
    return notebook.getCells().map((cell) => ({
      index: cell.index,
      isCode: cell.kind === vscode.NotebookCellKind.Code,
      languageId: cell.document.languageId,
      text: cell.document.getText(),
      uri: cell.document.uri,
    }));
  }

  private workspaceFolder(notebook: vscode.NotebookDocument): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(notebook.uri) ?? vscode.workspace.workspaceFolders?.[0];
  }

  /** On notebook open: create the shadow file if needed, hold it open, register state. */
  async openForNotebook(notebook: vscode.NotebookDocument): Promise<void> {
    if (notebook.notebookType !== "jupyter-notebook") {
      return;
    }
    if (this.states.has(notebook.uri.toString())) {
      return;
    }
    if (!this.hasScalaCodeCell(notebook)) {
      return;
    }

    const folder = this.workspaceFolder(notebook);
    if (!folder) {
      this.log.warn(`No workspace folder for ${notebook.uri.toString()}; skipping.`);
      return;
    }

    const config = this.getConfig();
    const baseName = shadowBaseName(path.relative(folder.uri.fsPath, notebook.uri.fsPath));
    const relativePath = path.posix.join(config.shadowDir, `${baseName}.scala`);
    const shadowUri = vscode.Uri.joinPath(folder.uri, config.shadowDir, `${baseName}.scala`);

    const { text, mapping } = transform(this.toSourceCells(notebook), {
      ...config,
      wrapperObjectName: baseName,
    });

    let existed = true;
    try {
      await vscode.workspace.fs.stat(shadowUri);
    } catch {
      existed = false;
    }
    if (!existed) {
      await vscode.workspace.fs.writeFile(shadowUri, Buffer.from(text, "utf8"));
      this.log.info(`Created ${shadowUri.toString()} (object ${baseName})`);

      if (config.compileOnCreate) {
        await this.compileOnce(folder, relativePath);
      }
    }

    const doc = await vscode.workspace.openTextDocument(shadowUri);

    const state: ShadowState = {
      notebook,
      shadowUri,
      relativePath,
      wrapperObjectName: baseName,
      mapping,
      generatedSources: new Map(),
      appliedText: existed ? undefined : text,
      closed: false,
      debounceHandle: undefined,
    };
    this.states.set(notebook.uri.toString(), state);
    this.shadowUriToNotebookUri.set(shadowUri.toString(), notebook.uri.toString());
    this.indexCells(state);

    if (existed) {
      // Reconcile with what's actually on disk so a no-op edit doesn't fire on first change.
      state.appliedText = doc.getText();
      state.mapping = mapping;
    }
  }

  private compileOnce(folder: vscode.WorkspaceFolder, relativePath: string): Promise<void> {
    return new Promise((resolve) => {
      const child = cp.spawn("./mill", [`${relativePath}:compile`], { cwd: folder.uri.fsPath });
      this.log.info(`./mill ${relativePath}:compile starting`);
      child.stdout?.on("data", (d: Buffer) => this.log.raw(d.toString()));
      child.stderr?.on("data", (d: Buffer) => this.log.raw(d.toString()));
      child.on("error", (err) => {
        this.log.error(`./mill ${relativePath}:compile failed to start: ${err.message}`);
        resolve();
      });
      child.on("close", (code) => {
        this.log.info(`./mill ${relativePath}:compile exited with code ${code}`);
        resolve();
      });
    });
  }

  /** Debounced regeneration entry point, called on every notebook content change. */
  scheduleRegenerate(notebook: vscode.NotebookDocument): void {
    const state = this.states.get(notebook.uri.toString());
    if (!state) {
      return;
    }
    if (state.debounceHandle) {
      clearTimeout(state.debounceHandle);
    }
    const debounceMs = this.getConfig().debounceMs;
    state.debounceHandle = setTimeout(() => {
      state.debounceHandle = undefined;
      void this.regenerate(notebook, false);
    }, debounceMs);
  }

  /** Regenerate + save the shadow document. `force` bypasses the unchanged-text short-circuit. */
  async regenerate(notebook: vscode.NotebookDocument, force: boolean): Promise<void> {
    await this.updateShadow(notebook, force, true);
  }

  /** Make the shadow current before an interactive language request, without starting a full compile. */
  async synchronizeForLanguageFeature(notebook: vscode.NotebookDocument): Promise<void> {
    const state = this.states.get(notebook.uri.toString());
    if (!state) {
      return;
    }

    if (state.debounceHandle) {
      clearTimeout(state.debounceHandle);
      state.debounceHandle = undefined;
    }
    await this.updateShadow(notebook, false, false);
  }

  private async updateShadow(notebook: vscode.NotebookDocument, force: boolean, compile: boolean): Promise<void> {
    const state = this.states.get(notebook.uri.toString());
    if (!state) {
      return;
    }

    const config = this.getConfig();
    const { text, mapping } = transform(this.toSourceCells(notebook), {
      ...config,
      wrapperObjectName: state.wrapperObjectName,
    });

    if (!force && text === state.appliedText) {
      return;
    }

    // openTextDocument is a no-op if already open; this also re-opens it if VS Code
    // evicted the hidden document while it was marked closed (see markClosedIfShadow).
    const doc = await vscode.workspace.openTextDocument(state.shadowUri);
    state.closed = false;

    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(state.shadowUri, fullRange, text);
    await vscode.workspace.applyEdit(edit);
    await doc.save();

    state.appliedText = text;
    state.mapping = mapping;
    this.indexCells(state);
    this.log.debug(
      () =>
        `Rewrote ${state.relativePath}: ${mapping.spans.length} cell span(s), ` +
        `${text.split("\n").length} lines, ${mapping.headerLines} header lines`
    );
    this.analysisChangedEmitter.fire(state);

    if (compile && config.compileOnSave) {
      try {
        await vscode.commands.executeCommand("metals.compile-cascade");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error(`Metals compile failed to start: ${message}`);
      }
    }
  }

  /** Shadow documents may be evicted by VS Code while hidden; note it, don't treat as an error. */
  markClosedIfShadow(closedDoc: vscode.TextDocument): void {
    const notebookKey = this.shadowUriToNotebookUri.get(closedDoc.uri.toString());
    if (!notebookKey) {
      return;
    }
    const state = this.states.get(notebookKey);
    if (state) {
      state.closed = true;
    }
  }

  /** On notebook close: clear diagnostics for its cells, drop in-memory state. Leaves the shadow file on disk. */
  closeForNotebook(notebook: vscode.NotebookDocument): void {
    const key = notebook.uri.toString();
    const state = this.states.get(key);
    if (!state) {
      return;
    }
    for (const cell of notebook.getCells()) {
      this.collection.delete(cell.document.uri);
    }
    if (state.debounceHandle) {
      clearTimeout(state.debounceHandle);
    }
    this.shadowUriToNotebookUri.delete(state.shadowUri.toString());
    for (const [cellKey, notebookKey] of this.cellUriToNotebookUri) {
      if (notebookKey === key) {
        this.cellUriToNotebookUri.delete(cellKey);
      }
    }
    this.states.delete(key);
    this.log.debug(`Closed ${notebook.uri.toString()}; left ${state.relativePath} on disk`);
  }
}
