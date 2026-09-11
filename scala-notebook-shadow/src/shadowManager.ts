import * as path from "path";
import * as vscode from "vscode";
import { describeError, errorStack, Logger, LogLevel } from "./log";
import { looksGenerated, orphanedShadowNames } from "./shadowCleanup";
import { shadowBaseName, SHADOW_FILE_EXTENSION } from "./shadowNaming";
import { ScalaNotebookConfig, ShadowMapping, SourceCell, transform } from "./transform";

export interface ExtensionConfig extends ScalaNotebookConfig {
  logLevel: LogLevel;
  completionResolveCount: number;
  codeActionResolveCount: number;
  shadowDir: string;
  debounceMs: number;
  compileOnSave: boolean;
}

/** What a shadow written by the previous, Mill-targeted version of the extension was called. */
const LEGACY_MILL_SHADOW_EXTENSION = ".scala";

/**
 * Directories the sweep for notebooks skips: expensive to walk, and a notebook found in one
 * would never have been shadowed anyway. Passing any exclude replaces VS Code's default
 * excludes, which is deliberate - a notebook the user has merely hidden from search still
 * has a shadow, and must not be read as a deleted one.
 */
const NOTEBOOK_SEARCH_EXCLUDE = "**/{node_modules,.git,.metals,.bloop,.scala-build,.ipynb_checkpoints}/**";

export interface ShadowState {
  notebook: vscode.NotebookDocument;
  shadowUri: vscode.Uri;
  /** Relative to the workspace folder, e.g. "notebook-shadow/sample.sc". For logging. */
  relativePath: string;
  /** Name of the object cells are wrapped in; unique per shadow file. */
  wrapperObjectName: string;
  mapping: ShadowMapping;
  appliedText: string | undefined;
  closed: boolean;
  debounceHandle: NodeJS.Timeout | undefined;
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
  /**
   * Notebooks whose openForNotebook is mid-flight, by notebook URI. Adoption is retried on
   * every change to an untracked notebook, so without this a burst of keystrokes could run
   * several opens concurrently - each seeing no state yet, and each writing the shadow.
   */
  private readonly opening = new Set<string>();
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

  /**
   * Whether a URI Metals reported against is one of our shadow scripts.
   *
   * Mill needed a second answer here: it compiled a *copy* of each script under `.dest/`
   * with marker lines prepended and reported against that, so the relay had to recognise
   * the copy, read its markers and shift every line number back. scala-cli compiles the
   * `.sc` as itself, so a report either names a shadow or is none of our business, and the
   * whole generated-copy layer went with Mill.
   *
   * Whether that holds is issue #15 §5.4, unanswered: scala-cli does generate a wrapper
   * under `.scala-build/`, and Metals may or may not translate positions back through
   * `workspace/wrappedSources` before reporting. `looksLikeScalaCliGeneratedSource` in
   * relay.ts logs that case rather than guessing an offset for it.
   */
  isShadowUri(uri: vscode.Uri): boolean {
    return this.shadowUriToNotebookUri.has(uri.toString());
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

  /**
   * Warn about a shadow left behind by the Mill-targeted version of this extension.
   *
   * That version wrote `<name>.scala` beside where `<name>.sc` now goes, wrapped in an
   * object of the same name. Both then compile, and every cell squiggles with a duplicate
   * definition naming a file the user cannot see. Deleting someone's file on an upgrade is
   * worse than saying so, so say so.
   */
  private async warnAboutLegacyMillShadow(
    folder: vscode.WorkspaceFolder,
    config: ExtensionConfig,
    baseName: string
  ): Promise<void> {
    const stale = vscode.Uri.joinPath(
      folder.uri,
      config.shadowDir,
      `${baseName}${LEGACY_MILL_SHADOW_EXTENSION}`
    );
    try {
      await vscode.workspace.fs.stat(stale);
    } catch {
      return;
    }
    this.log.warn(
      `${stale.fsPath} is left over from the Mill version of this extension and still defines ` +
        `object ${baseName}. Delete it, or expect duplicate-definition errors on every cell.`
    );
  }

  /**
   * Delete the shadow scripts that no notebook maps to, across every workspace folder.
   *
   * Run once, after the notebooks already open have been adopted: an untitled notebook has
   * no path for the search for `.ipynb` files to find, so its shadow is only accounted for
   * by `isShadowUri`, and that only answers once the notebook is adopted. A notebook opened
   * while the sweep runs is covered by the same check, repeated before each delete.
   *
   * What counts as a leftover, and why one is worth removing, is shadowCleanup.ts.
   */
  async cleanOrphanedShadows(): Promise<void> {
    const shadowDir = this.getConfig().shadowDir;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        await this.cleanFolder(folder, shadowDir);
      } catch (error) {
        this.log.error(`Failed to clean ${folder.name}/${shadowDir}: ${describeError(error)}`);
        this.log.debug(() => errorStack(error));
      }
    }
  }

  private async cleanFolder(folder: vscode.WorkspaceFolder, shadowDir: string): Promise<void> {
    const directory = vscode.Uri.joinPath(folder.uri, shadowDir);
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(directory);
    } catch {
      // No shadow directory yet; the first notebook to open creates it.
      return;
    }

    const fileNames = entries.filter(([, type]) => (type & vscode.FileType.File) !== 0).map(([name]) => name);
    // Worth checking before paying for a workspace-wide search for notebooks.
    if (!fileNames.some((name) => name.endsWith(SHADOW_FILE_EXTENSION))) {
      return;
    }

    const notebooks = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "**/*.ipynb"),
      NOTEBOOK_SEARCH_EXCLUDE
    );
    const orphans = orphanedShadowNames(
      fileNames,
      notebooks.map((uri) => path.relative(folder.uri.fsPath, uri.fsPath))
    );

    const deleted: string[] = [];
    for (const name of orphans) {
      const uri = vscode.Uri.joinPath(directory, name);
      if (this.isShadowUri(uri)) {
        continue;
      }
      try {
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
        if (!looksGenerated(text)) {
          this.log.info(`Kept ${name}: no notebook matches its name, but it is not a generated shadow.`);
          continue;
        }
        await vscode.workspace.fs.delete(uri);
        deleted.push(name);
      } catch (error) {
        this.log.warn(`Could not remove the stale shadow ${name}: ${describeError(error)}`);
      }
    }

    if (deleted.length > 0) {
      this.log.info(
        `Removed ${deleted.length} shadow script(s) from ${shadowDir} whose notebooks are gone: ${deleted.join(", ")}`
      );
    }
  }

  /**
   * A notebook only becomes eligible once it has a Scala code cell, which can arrive after it
   * opens: a kernel is chosen, or the first code cell is typed. So treat every change to an
   * untracked notebook as another chance to adopt it, not just its open event.
   */
  async adoptOrRegenerate(notebook: vscode.NotebookDocument): Promise<void> {
    if (this.states.has(notebook.uri.toString())) {
      this.scheduleRegenerate(notebook);
      return;
    }
    await this.openForNotebook(notebook);
  }

  /** On notebook open: create the shadow file if needed, hold it open, register state. */
  async openForNotebook(notebook: vscode.NotebookDocument): Promise<void> {
    if (notebook.notebookType !== "jupyter-notebook") {
      return;
    }
    const notebookKey = notebook.uri.toString();
    if (this.states.has(notebookKey) || this.opening.has(notebookKey)) {
      return;
    }
    if (!this.hasScalaCodeCell(notebook)) {
      return;
    }

    this.opening.add(notebookKey);
    try {
      await this.createShadow(notebook);
    } catch (error) {
      // No state was registered, so the notebook stays eligible: the next edit comes back
      // through adoptOrRegenerate and tries again, which is what recovers a shadow
      // directory that was missing or read-only when the notebook first opened.
      this.log.error(`Failed to create a shadow for ${notebook.uri.fsPath}: ${describeError(error)}`);
      this.log.debug(() => errorStack(error));
    } finally {
      this.opening.delete(notebookKey);
    }
  }

  private async createShadow(notebook: vscode.NotebookDocument): Promise<void> {
    const folder = this.workspaceFolder(notebook);
    if (!folder) {
      this.log.warn(`No workspace folder for ${notebook.uri.toString()}; skipping.`);
      return;
    }

    const config = this.getConfig();
    // Named relative to the workspace folder, so a notebook anywhere under it gets a name
    // unique within the one shadow directory that holds them all. Where that directory sits
    // no longer depends on finding a build: scala-cli needs no build file, and Metals starts
    // a build server for a directory of `.sc` files wherever it is (issue #15 §5.2).
    const baseName = shadowBaseName(path.relative(folder.uri.fsPath, notebook.uri.fsPath));
    const fileName = `${baseName}${SHADOW_FILE_EXTENSION}`;
    const relativePath = path.posix.join(config.shadowDir, fileName);
    const shadowUri = vscode.Uri.joinPath(folder.uri, config.shadowDir, fileName);
    await this.warnAboutLegacyMillShadow(folder, config, baseName);

    const { text, mapping } = transform(this.toSourceCells(notebook), {
      ...config,
      wrapperObjectName: baseName,
      projectRootPath: folder.uri.fsPath,
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
    }

    const doc = await vscode.workspace.openTextDocument(shadowUri);

    const state: ShadowState = {
      notebook,
      shadowUri,
      relativePath,
      wrapperObjectName: baseName,
      mapping,
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
      void this.regenerate(notebook, false).catch((error: unknown) => {
        this.log.error(`Failed to regenerate ${state.relativePath}: ${describeError(error)}`);
        this.log.debug(() => errorStack(error));
      });
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
    const folder = this.workspaceFolder(notebook);
    const { text, mapping } = transform(this.toSourceCells(notebook), {
      ...config,
      wrapperObjectName: state.wrapperObjectName,
      projectRootPath: folder?.uri.fsPath,
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
        this.log.error(`Metals compile failed to start: ${describeError(error)}`);
        this.log.debug(() => errorStack(error));
      }
    }
  }

  /**
   * Make sure the shadow has a live text model, reopening it if VS Code evicted it.
   *
   * Most `vscode.execute*Provider` commands load the model themselves when it is missing.
   * A few do not - `vscode.executeCodeActionProvider` rejects outright, and
   * `vscode.provideDocumentSemanticTokens` answers undefined - and those are exactly the
   * features that run against a shadow nobody is looking at. VS Code releases the model
   * reference behind `openTextDocument` about three minutes after the last use, so without
   * this they stop working a few minutes after the last edit and never recover: a rewrite
   * reopens the document, but `updateShadow` short-circuits when the text is unchanged.
   */
  async ensureShadowOpen(state: ShadowState): Promise<void> {
    const key = state.shadowUri.toString();
    if (!state.closed && vscode.workspace.textDocuments.some((doc) => doc.uri.toString() === key)) {
      return;
    }
    await vscode.workspace.openTextDocument(state.shadowUri);
    state.closed = false;
    this.log.debug(() => `Reopened ${state.relativePath}; VS Code had evicted its text model`);
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
