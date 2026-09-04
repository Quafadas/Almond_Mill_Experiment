import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { ScalaNotebookConfig, ShadowMapping, SourceCell, transform } from "./transform";

export interface ExtensionConfig extends ScalaNotebookConfig {
  shadowDir: string;
  debounceMs: number;
  compileOnCreate: boolean;
}

export interface ShadowState {
  notebook: vscode.NotebookDocument;
  shadowUri: vscode.Uri;
  /** Relative to the workspace folder, e.g. "notebook-shadow/sample.scala". Used for `./mill <path>:compile`. */
  relativePath: string;
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
  private readonly assignedBaseNames = new Set<string>();

  constructor(
    private readonly collection: vscode.DiagnosticCollection,
    private readonly getConfig: () => ExtensionConfig,
    private readonly output: vscode.OutputChannel
  ) {}

  dispose(): void {
    for (const state of this.states.values()) {
      if (state.debounceHandle) {
        clearTimeout(state.debounceHandle);
      }
    }
    this.states.clear();
    this.shadowUriToNotebookUri.clear();
  }

  getStateForNotebook(notebook: vscode.NotebookDocument): ShadowState | undefined {
    return this.states.get(notebook.uri.toString());
  }

  getStateForShadowUri(shadowUri: vscode.Uri): ShadowState | undefined {
    const notebookKey = this.shadowUriToNotebookUri.get(shadowUri.toString());
    return notebookKey ? this.states.get(notebookKey) : undefined;
  }

  isShadowUri(uri: vscode.Uri): boolean {
    return this.shadowUriToNotebookUri.has(uri.toString());
  }

  allShadowUris(): vscode.Uri[] {
    return [...this.states.values()].map((s) => s.shadowUri);
  }

  private hasScalaCodeCell(notebook: vscode.NotebookDocument): boolean {
    return notebook.getCells().some((c) => c.kind === vscode.NotebookCellKind.Code && c.document.languageId === "scala");
  }

  private sanitizeBaseName(notebookUri: vscode.Uri): string {
    const base = path.basename(notebookUri.fsPath).replace(/\.[^./]+$/, "");
    let sanitized = base.replace(/[^A-Za-z0-9_]/g, "_");
    if (sanitized.length === 0) {
      sanitized = "notebook";
    }
    if (/^[0-9]/.test(sanitized)) {
      sanitized = `NB_${sanitized}`;
    }

    if (!this.assignedBaseNames.has(sanitized)) {
      this.assignedBaseNames.add(sanitized);
      return sanitized;
    }
    let suffix = 2;
    while (this.assignedBaseNames.has(`${sanitized}_${suffix}`)) {
      suffix++;
    }
    const deduped = `${sanitized}_${suffix}`;
    this.assignedBaseNames.add(deduped);
    return deduped;
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
      this.output.appendLine(`[shadowManager] No workspace folder for ${notebook.uri.toString()}; skipping.`);
      return;
    }

    const config = this.getConfig();
    const baseName = this.sanitizeBaseName(notebook.uri);
    const relativePath = path.posix.join(config.shadowDir, `${baseName}.scala`);
    const shadowUri = vscode.Uri.joinPath(folder.uri, config.shadowDir, `${baseName}.scala`);

    const { text, mapping } = transform(this.toSourceCells(notebook), config);

    let existed = true;
    try {
      await vscode.workspace.fs.stat(shadowUri);
    } catch {
      existed = false;
    }
    if (!existed) {
      await vscode.workspace.fs.writeFile(shadowUri, Buffer.from(text, "utf8"));
      this.output.appendLine(`[shadowManager] Created ${shadowUri.toString()}`);

      if (config.compileOnCreate) {
        await this.compileOnce(folder, relativePath);
      }
    }

    const doc = await vscode.workspace.openTextDocument(shadowUri);

    const state: ShadowState = {
      notebook,
      shadowUri,
      relativePath,
      mapping,
      appliedText: existed ? undefined : text,
      closed: false,
      debounceHandle: undefined,
    };
    this.states.set(notebook.uri.toString(), state);
    this.shadowUriToNotebookUri.set(shadowUri.toString(), notebook.uri.toString());

    if (existed) {
      // Reconcile with what's actually on disk so a no-op edit doesn't fire on first change.
      state.appliedText = doc.getText();
      state.mapping = mapping;
    }
  }

  private compileOnce(folder: vscode.WorkspaceFolder, relativePath: string): Promise<void> {
    return new Promise((resolve) => {
      const child = cp.spawn("./mill", [`${relativePath}:compile`], { cwd: folder.uri.fsPath });
      child.stdout?.on("data", (d) => this.output.append(d.toString()));
      child.stderr?.on("data", (d) => this.output.append(d.toString()));
      child.on("error", (err) => {
        this.output.appendLine(`[shadowManager] ./mill ${relativePath}:compile failed to start: ${err.message}`);
        resolve();
      });
      child.on("close", (code) => {
        this.output.appendLine(`[shadowManager] ./mill ${relativePath}:compile exited with code ${code}`);
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
    const state = this.states.get(notebook.uri.toString());
    if (!state) {
      return;
    }

    const config = this.getConfig();
    const { text, mapping } = transform(this.toSourceCells(notebook), config);

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
    this.states.delete(key);
  }
}
