import * as vscode from "vscode";
import {
  CellLocationLink,
  cellPositionToShadow,
  cellRangeToShadow,
  isAppendedColumn,
  PlainPosition,
  PlainRange,
  positionWithinSpan,
  selectionChainWithinSpan,
  rangeWithinSpan,
  shadowEditsToCells,
  shadowLinkToCell,
  shadowRangeToCell,
  spanLineBounds,
} from "./mapping";
import { describeError, errorStack, Logger } from "./log";
import { looksLikeScalaCliGeneratedSource } from "./scalaCliBuild";
import { tokensWithinLines } from "./semanticTokens";
import { ExtensionConfig, ShadowManager, ShadowState } from "./shadowManager";
import { CellSpan } from "./transform";

interface CellContext {
  state: ShadowState;
  span: CellSpan;
}

interface RequestContext extends CellContext {
  shadowPosition: vscode.Position;
}

function plainPosition(position: vscode.Position): PlainPosition {
  return { line: position.line, character: position.character };
}

function plainRange(range: vscode.Range): PlainRange {
  return { start: plainPosition(range.start), end: plainPosition(range.end) };
}

function vscodePosition(position: PlainPosition): vscode.Position {
  return new vscode.Position(position.line, position.character);
}

function vscodeRange(range: PlainRange): vscode.Range {
  return new vscode.Range(vscodePosition(range.start), vscodePosition(range.end));
}

function rangeFromShadow(span: CellSpan, range: vscode.Range): vscode.Range {
  return vscodeRange(shadowRangeToCell(span, plainRange(range)));
}

/** A shadow range inside `span`, or undefined if it reaches outside the cell. */
function rangeInCell(span: CellSpan, range: vscode.Range): vscode.Range | undefined {
  const within = rangeWithinSpan(span, plainRange(range));
  return within ? vscodeRange(within) : undefined;
}

/**
 * Completions may carry edits outside the cell - an auto-import Metals wants to put in the
 * shadow file's header. Collapsing the range to the start of the cell keeps the edit's text,
 * so such an edit becomes an insertion at the top of the cell: the same re-homing
 * `shadowEditsToCells` does deliberately for a quick fix, and right for the same reason - an
 * import written in one cell is in scope for the cells after it.
 *
 * It is looser than that one in a way worth knowing: a *replacement* in the header also
 * becomes an insertion here, so if Metals folded the new import into an existing group, the
 * group's old text is copied into the cell rather than moved. Harmless - a duplicate import
 * of the same name is legal - but not the same thing as applying the edit.
 */
function completionRangeFromShadow(span: CellSpan, range: vscode.Range): vscode.Range {
  return rangeInCell(span, range) ?? new vscode.Range(0, 0, 0, 0);
}

export class LanguageFeatureRelay
  implements
    vscode.DefinitionProvider,
    vscode.TypeDefinitionProvider,
    vscode.ImplementationProvider,
    vscode.HoverProvider,
    vscode.SignatureHelpProvider,
    vscode.DocumentHighlightProvider,
    vscode.SelectionRangeProvider,
    vscode.ReferenceProvider,
    vscode.InlayHintsProvider,
    vscode.CompletionItemProvider,
    vscode.CodeActionProvider,
    vscode.RenameProvider,
    vscode.DocumentSymbolProvider,
    vscode.FoldingRangeProvider,
    vscode.DocumentSemanticTokensProvider,
    vscode.Disposable
{
  private readonly inlayHintsChanged = new vscode.EventEmitter<void>();
  private readonly semanticTokensChanged = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;

  readonly onDidChangeInlayHints = this.inlayHintsChanged.event;
  readonly onDidChangeSemanticTokens = this.semanticTokensChanged.event;

  constructor(
    private readonly shadowManager: ShadowManager,
    private readonly log: Logger,
    private readonly getConfig: () => ExtensionConfig
  ) {
    // Both of these are cached by VS Code rather than re-requested on demand, so they only
    // catch up on a shadow rewrite or fresh diagnostics if we say so.
    this.subscription = shadowManager.onDidChangeAnalysis(() => {
      this.inlayHintsChanged.fire();
      this.semanticTokensChanged.fire();
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.inlayHintsChanged.dispose();
    this.semanticTokensChanged.dispose();
  }

  /** The shadow state and span for a cell as they stand, without touching the shadow file. */
  private cellContext(document: vscode.TextDocument): CellContext | undefined {
    const state = this.shadowManager.getStateForCellUri(document.uri);
    const span = state?.mapping.spans.find((candidate) => candidate.cellUri.toString() === document.uri.toString());
    return state && span ? { state, span } : undefined;
  }

  /**
   * As `cellContext`, but flushes pending notebook edits into the shadow file first, so the
   * request is answered against what the user can actually see. Only for features the user
   * triggers deliberately - anything VS Code polls must not drive shadow writes.
   */
  private async syncedCellContext(document: vscode.TextDocument): Promise<CellContext | undefined> {
    const state = this.shadowManager.getStateForCellUri(document.uri);
    if (!state) {
      return undefined;
    }

    await this.shadowManager.synchronizeForLanguageFeature(state.notebook);
    return this.cellContext(document);
  }

  /** `syncedCellContext` plus the request position translated into the shadow script. */
  private async requestContext(document: vscode.TextDocument, position: vscode.Position): Promise<RequestContext | undefined> {
    const context = await this.syncedCellContext(document);
    if (!context) {
      return undefined;
    }

    return {
      ...context,
      shadowPosition: vscodePosition(cellPositionToShadow(context.span, plainPosition(position))),
    };
  }

  // ---------------------------------------------------------------- definition-like

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition | vscode.DefinitionLink[] | undefined> {
    return this.relayDefinitionLike("vscode.executeDefinitionProvider", document, position, token);
  }

  async provideTypeDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition | vscode.DefinitionLink[] | undefined> {
    return this.relayDefinitionLike("vscode.executeTypeDefinitionProvider", document, position, token);
  }

  async provideImplementation(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition | vscode.DefinitionLink[] | undefined> {
    return this.relayDefinitionLike("vscode.executeImplementationProvider", document, position, token);
  }

  /**
   * Definition, type definition and implementation all take a position and hand back
   * locations, so they differ only in which command they forward to.
   */
  private async relayDefinitionLike(
    command: string,
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition | vscode.DefinitionLink[] | undefined> {
    const context = await this.requestContext(document, position);
    if (!context || token.isCancellationRequested) {
      return undefined;
    }

    const results = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
      command,
      context.state.shadowUri,
      context.shadowPosition
    );
    if (!results || token.isCancellationRequested) {
      return undefined;
    }

    const translated = results.map((result) =>
      this.translateDefinition(context, result, this.targetsThisShadow(context, result))
    );
    this.log.debug(
      `${command}: ${results.length} result(s) at shadow ${context.shadowPosition.line}:${context.shadowPosition.character}`
    );
    return translated as vscode.Location[] | vscode.LocationLink[];
  }

  /**
   * Whether a definition target points into *this* notebook's shadow, and so needs
   * translating back to a cell. Anything else - a library source, another notebook's shadow -
   * is handed back untouched.
   */
  private targetsThisShadow(
    context: RequestContext,
    definition: vscode.Location | vscode.LocationLink
  ): boolean {
    const targetUri = "targetUri" in definition ? definition.targetUri : definition.uri;
    return targetUri.toString() === context.state.shadowUri.toString();
  }

  private translateDefinition(
    context: RequestContext,
    definition: vscode.Location | vscode.LocationLink,
    targetsShadow: boolean
  ): vscode.Location | vscode.LocationLink {
    const translate = (link: { targetRange: vscode.Range; targetSelectionRange?: vscode.Range }): CellLocationLink | undefined =>
      targetsShadow
        ? shadowLinkToCell(context.state.mapping, {
            targetRange: plainRange(link.targetRange),
            targetSelectionRange: link.targetSelectionRange ? plainRange(link.targetSelectionRange) : undefined,
          })
        : undefined;

    if ("targetUri" in definition) {
      const originSelectionRange = definition.originSelectionRange
        ? rangeFromShadow(context.span, definition.originSelectionRange)
        : undefined;
      const cellLink = translate(definition);
      if (!cellLink) {
        return { ...definition, originSelectionRange };
      }
      return {
        originSelectionRange,
        targetUri: cellLink.cellUri,
        targetRange: vscodeRange(cellLink.targetRange),
        targetSelectionRange: cellLink.targetSelectionRange ? vscodeRange(cellLink.targetSelectionRange) : undefined,
      };
    }

    const cellLink = translate({ targetRange: definition.range });
    return cellLink ? new vscode.Location(cellLink.cellUri, vscodeRange(cellLink.targetRange)) : definition;
  }

  // ---------------------------------------------------------------- hover

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const context = await this.requestContext(document, position);
    if (!context || token.isCancellationRequested) {
      return undefined;
    }

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      context.state.shadowUri,
      context.shadowPosition
    );
    if (!hovers || hovers.length === 0 || token.isCancellationRequested) {
      return undefined;
    }

    // The command merges every provider's answer; we can only return one Hover, so
    // concatenate the contents and keep the first range that lands inside this cell.
    const contents = hovers.flatMap((hover) => hover.contents);
    if (contents.length === 0) {
      return undefined;
    }
    const range = hovers
      .map((hover) => (hover.range ? rangeInCell(context.span, hover.range) : undefined))
      .find((candidate) => candidate !== undefined);
    return new vscode.Hover(contents, range);
  }

  // ---------------------------------------------------------------- signature help

  async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    signatureContext: vscode.SignatureHelpContext
  ): Promise<vscode.SignatureHelp | undefined> {
    const context = await this.requestContext(document, position);
    if (!context || token.isCancellationRequested) {
      return undefined;
    }

    // Signature help carries no document ranges, so the result needs no translation.
    const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
      "vscode.executeSignatureHelpProvider",
      context.state.shadowUri,
      context.shadowPosition,
      signatureContext.triggerCharacter
    );
    return token.isCancellationRequested ? undefined : help;
  }

  // ---------------------------------------------------------------- document highlights

  async provideDocumentHighlights(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.DocumentHighlight[] | undefined> {
    const context = await this.requestContext(document, position);
    if (!context || token.isCancellationRequested) {
      return undefined;
    }

    const highlights = await vscode.commands.executeCommand<vscode.DocumentHighlight[]>(
      "vscode.executeDocumentHighlights",
      context.state.shadowUri,
      context.shadowPosition
    );
    if (!highlights || token.isCancellationRequested) {
      return undefined;
    }

    // Occurrences elsewhere in the shadow file belong to other cells, which are separate
    // documents; only the ones inside this cell can be highlighted.
    const translated: vscode.DocumentHighlight[] = [];
    for (const highlight of highlights) {
      const range = rangeInCell(context.span, highlight.range);
      if (range) {
        translated.push(new vscode.DocumentHighlight(range, highlight.kind));
      }
    }
    return translated;
  }

  // ---------------------------------------------------------------- references

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _referenceContext: vscode.ReferenceContext,
    token: vscode.CancellationToken
  ): Promise<vscode.Location[] | undefined> {
    const context = await this.requestContext(document, position);
    if (!context || token.isCancellationRequested) {
      return undefined;
    }

    const locations = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      context.state.shadowUri,
      context.shadowPosition
    );
    if (!locations || token.isCancellationRequested) {
      return undefined;
    }

    const translated = locations.map((location) => this.translateReference(context, location));

    // Two shadow hits can land on one cell location; the peek view should show it once.
    const seen = new Set<string>();
    const unique: vscode.Location[] = [];
    for (const location of translated) {
      if (!location) {
        continue;
      }
      const key = `${location.uri.toString()}#${location.range.start.line}:${location.range.start.character}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(location);
      }
    }
    this.log.debug(`references: ${locations.length} result(s) from Metals, ${unique.length} after mapping`);
    return unique;
  }

  /**
   * A reference is either somewhere in this notebook's shadow (translate it to the cell),
   * in another notebook's shadow (drop it - showing generated code helps nobody), or in an
   * ordinary file (hand it back untouched). Unlike a definition, a hit we cannot place in a
   * cell is dropped rather than returned as-is: it sits on a synthesized line, and every
   * result here is a place the user expects to be able to open and edit.
   */
  private translateReference(context: RequestContext, location: vscode.Location): vscode.Location | undefined {
    if (looksLikeScalaCliGeneratedSource(location.uri.fsPath)) {
      // scala-cli's wrapper for some script - generated code either way, so never a result.
      return undefined;
    }
    if (!this.shadowManager.isShadowUri(location.uri)) {
      return location;
    }
    if (location.uri.toString() !== context.state.shadowUri.toString()) {
      // Another notebook's shadow.
      return undefined;
    }

    const link = shadowLinkToCell(context.state.mapping, { targetRange: plainRange(location.range) });
    return link ? new vscode.Location(link.cellUri, vscodeRange(link.targetRange)) : undefined;
  }

  // ---------------------------------------------------------------- inlay hints

  async provideInlayHints(
    document: vscode.TextDocument,
    _range: vscode.Range,
    token: vscode.CancellationToken
  ): Promise<vscode.InlayHint[] | undefined> {
    // Deliberately not synchronized: VS Code asks for hints on every edit and scroll, and
    // forcing a shadow write per request would defeat the regeneration debounce. Hints
    // follow the shadow instead - onDidChangeInlayHints fires once it catches up.
    const context = this.cellContext(document);
    if (!context || token.isCancellationRequested) {
      return undefined;
    }

    // Hints come from the presentation compiler for a file that is genuinely a source of a
    // build target. scala-cli compiles the `.sc` itself, so the shadow is that source and
    // there is nothing else to ask - under Mill this had to try the `.dest/` copy too.
    const hints = await this.requestInlayHints(document, context, token);
    if (token.isCancellationRequested) {
      return undefined;
    }
    this.log.debug(`inlayHints: cell ${context.span.cellIndex} got ${hints.length} hint(s) from the shadow`);
    return hints;
  }

  /** Ask the shadow for this cell's hints, and map what comes back into the cell. */
  private async requestInlayHints(
    cell: vscode.TextDocument,
    context: CellContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlayHint[]> {
    const shadowUri = context.state.shadowUri;
    let sourceDocument: vscode.TextDocument;
    try {
      sourceDocument = await vscode.workspace.openTextDocument(shadowUri);
    } catch {
      // The shadow was deleted from under us; the next regenerate writes it again.
      return [];
    }

    // A cell is small, so ask for its whole span rather than mapping the requested range;
    // everything we return is inside the cell either way.
    const { firstLine, lastLine } = spanLineBounds(context.span);
    const first = firstLine;
    const last = Math.min(lastLine, sourceDocument.lineCount - 1);
    if (last < first || token.isCancellationRequested) {
      return [];
    }

    const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
      "vscode.executeInlayHintProvider",
      shadowUri,
      new vscode.Range(new vscode.Position(first, 0), sourceDocument.lineAt(last).range.end)
    );
    if (!hints || token.isCancellationRequested) {
      return [];
    }

    const translated: vscode.InlayHint[] = [];
    for (const hint of hints) {
      const position = positionWithinSpan(context.span, plainPosition(hint.position));
      if (!position || position.line >= cell.lineCount) {
        continue;
      }
      // A `resN_M` opener is appended to the end of the line *before* its statement, so
      // Metals reports that binding's type hint at a column the cell line does not reach.
      // Keeping it would let VS Code clamp it onto the end of the previous statement and
      // label that statement with the *next* one's type.
      if (isAppendedColumn(position, cell.lineAt(position.line).text.length)) {
        continue;
      }
      translated.push(this.translateInlayHint(context.span, hint, vscodePosition(position)));
    }
    return translated;
  }

  private translateInlayHint(span: CellSpan, hint: vscode.InlayHint, position: vscode.Position): vscode.InlayHint {
    const translated = new vscode.InlayHint(position, this.translateInlayLabel(hint.label), hint.kind);
    translated.tooltip = hint.tooltip;
    translated.paddingLeft = hint.paddingLeft;
    translated.paddingRight = hint.paddingRight;

    // Accepting a hint applies these edits, which is how an inferred type gets written out.
    // Keep them only if every one lands in this cell, so accepting can never edit a
    // synthesized line - a partial application would corrupt the cell.
    const edits = hint.textEdits?.map((edit) => {
      const range = rangeWithinSpan(span, plainRange(edit.range));
      return range ? vscode.TextEdit.replace(vscodeRange(range), edit.newText) : undefined;
    });
    if (edits && edits.every((edit): edit is vscode.TextEdit => edit !== undefined)) {
      translated.textEdits = edits;
    }

    return translated;
  }

  private translateInlayLabel(label: vscode.InlayHint["label"]): string | vscode.InlayHintLabelPart[] {
    if (typeof label === "string") {
      return label;
    }
    return label.map((part) => {
      const translated = new vscode.InlayHintLabelPart(part.value);
      translated.tooltip = part.tooltip;
      translated.command = part.command;
      // Ctrl-clicking a part jumps to the type it names. A target in generated code would
      // drop the user into the shadow file, so drop the link; library targets pass through.
      if (
        part.location &&
        !this.shadowManager.isShadowUri(part.location.uri) &&
        !looksLikeScalaCliGeneratedSource(part.location.uri.fsPath)
      ) {
        translated.location = part.location;
      }
      return translated;
    });
  }

  // ---------------------------------------------------------------- selection ranges

  async provideSelectionRanges(
    document: vscode.TextDocument,
    positions: readonly vscode.Position[],
    token: vscode.CancellationToken
  ): Promise<vscode.SelectionRange[] | undefined> {
    if (positions.length === 0) {
      return undefined;
    }
    const context = await this.requestContext(document, positions[0]);
    if (!context || token.isCancellationRequested) {
      return undefined;
    }

    const shadowPositions = positions.map((position) =>
      vscodePosition(cellPositionToShadow(context.span, plainPosition(position)))
    );
    const ranges = await vscode.commands.executeCommand<vscode.SelectionRange[]>(
      "vscode.executeSelectionRangeProvider",
      context.state.shadowUri,
      shadowPositions
    );
    if (!ranges || token.isCancellationRequested) {
      return undefined;
    }

    // VS Code wants exactly one chain per position, so a short answer is no answer.
    if (ranges.length !== positions.length) {
      this.log.debug(`selectionRanges: got ${ranges.length} chain(s) for ${positions.length} position(s); ignoring`);
      return undefined;
    }
    return ranges.map((range, index) => this.translateSelectionRange(context.span, positions[index], range));
  }

  private translateSelectionRange(
    span: CellSpan,
    position: vscode.Position,
    range: vscode.SelectionRange
  ): vscode.SelectionRange {
    const chain: PlainRange[] = [];
    for (let current: vscode.SelectionRange | undefined = range; current; current = current.parent) {
      chain.push(plainRange(current.range));
    }
    const kept = selectionChainWithinSpan(span, chain);

    if (kept.length === 0) {
      // Nothing the cell can express, but the contract still wants a chain: select the caret.
      return new vscode.SelectionRange(new vscode.Range(position, position));
    }

    // Rebuild outermost first, so each range becomes the parent of the one inside it.
    let rebuilt: vscode.SelectionRange | undefined;
    for (let index = kept.length - 1; index >= 0; index--) {
      rebuilt = new vscode.SelectionRange(vscodeRange(kept[index]), rebuilt);
    }
    return rebuilt as vscode.SelectionRange;
  }

  // ---------------------------------------------------------------- completion

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    completionContext: vscode.CompletionContext
  ): Promise<vscode.CompletionList | undefined> {
    const context = await this.requestContext(document, position);
    if (!context || token.isCancellationRequested) {
      return undefined;
    }

    const triggerCharacter =
      completionContext.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter
        ? completionContext.triggerCharacter
        : undefined;
    // Without a resolve count the items come back unresolved: Metals fills in documentation,
    // detail and auto-import edits on a separate completionItem/resolve round trip, which
    // VS Code makes for its own providers but not for a relayed result. The docs pane beside
    // the completion list would be blank.
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      context.state.shadowUri,
      context.shadowPosition,
      triggerCharacter,
      Math.max(this.getConfig().completionResolveCount, 0)
    );
    if (!completions || token.isCancellationRequested) {
      return undefined;
    }

    this.log.trace(`completion: ${completions.items.length} item(s), incomplete=${completions.isIncomplete}`);
    return new vscode.CompletionList(
      completions.items.map((item) => this.translateCompletionItem(context.span, item)),
      completions.isIncomplete
    );
  }

  private translateCompletionItem(span: CellSpan, item: vscode.CompletionItem): vscode.CompletionItem {
    const translated = Object.assign(new vscode.CompletionItem(item.label, item.kind), item);

    if (item.range) {
      translated.range = "inserting" in item.range
        ? {
            inserting: completionRangeFromShadow(span, item.range.inserting),
            replacing: completionRangeFromShadow(span, item.range.replacing),
          }
        : completionRangeFromShadow(span, item.range);
    }
    if (item.textEdit) {
      translated.textEdit = vscode.TextEdit.replace(
        completionRangeFromShadow(span, item.textEdit.range),
        item.textEdit.newText
      );
    }
    if (item.additionalTextEdits) {
      translated.additionalTextEdits = item.additionalTextEdits.map((edit) =>
        vscode.TextEdit.replace(completionRangeFromShadow(span, edit.range), edit.newText)
      );
    }

    return translated;
  }

  // ---------------------------------------------------------------- workspace edits

  /** Whether a URI names code this extension or scala-cli generated, rather than a real source. */
  private isGeneratedCode(uri: vscode.Uri): boolean {
    return this.shadowManager.isShadowUri(uri) || looksLikeScalaCliGeneratedSource(uri.fsPath);
  }

  /**
   * A `WorkspaceEdit` Metals expressed against shadow scripts, re-expressed against notebook
   * cells. Undefined means at least one edit cannot be honestly re-homed, and the caller must
   * abandon the whole operation - see `shadowEditsToCells` for why that is all-or-nothing.
   *
   * An edit touching no generated file is handed back *unchanged* rather than rebuilt. File
   * creations, renames and deletions are not reachable through `WorkspaceEdit`'s public API -
   * `entries()` reports text edits only - so rebuilding such an edit would silently drop them,
   * which is how a "create class in a new file" quick fix would come to do nothing at all.
   *
   * `hoistTo` is passed on only for the requesting notebook's own shadow: it re-homes an
   * insertion the shadow wanted to make outside every cell, and the only cell that can
   * absorb one is the cell the user asked from.
   */
  private translateWorkspaceEdit(
    requesting: ShadowState,
    edit: vscode.WorkspaceEdit,
    hoistTo?: CellSpan
  ): vscode.WorkspaceEdit | undefined {
    const entries = edit.entries();
    if (!entries.some(([uri]) => this.isGeneratedCode(uri))) {
      return edit;
    }

    const rebuilt = new vscode.WorkspaceEdit();
    for (const [uri, edits] of entries) {
      if (looksLikeScalaCliGeneratedSource(uri.fsPath)) {
        // scala-cli's wrapper for some script. Nothing in it corresponds to a cell, and it
        // is rewritten on every build, so an edit there is both unmappable and pointless.
        return undefined;
      }

      const state = this.shadowManager.getStateForShadowUri(uri);
      if (!state) {
        rebuilt.set(uri, edits);
        continue;
      }

      const translation = shadowEditsToCells(
        state.mapping,
        edits.map((textEdit) => ({ range: plainRange(textEdit.range), newText: textEdit.newText })),
        state.shadowUri.toString() === requesting.shadowUri.toString() ? hoistTo : undefined
      );
      if (!translation) {
        return undefined;
      }
      for (const cell of translation.cells) {
        rebuilt.set(
          cell.cellUri,
          cell.edits.map((cellEdit) => vscode.TextEdit.replace(vscodeRange(cellEdit.range), cellEdit.newText))
        );
      }
    }
    return rebuilt;
  }

  // ---------------------------------------------------------------- code actions

  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    codeActionContext: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.CodeAction[] | undefined> {
    // VS Code asks for code actions every time the caret moves, to decide whether to show
    // the lightbulb. Letting that drive a shadow write would defeat the regeneration
    // debounce, so only a deliberate invocation - the lightbulb opened, or Cmd-. - flushes
    // pending edits first.
    const context =
      codeActionContext.triggerKind === vscode.CodeActionTriggerKind.Invoke
        ? await this.syncedCellContext(document)
        : this.cellContext(document);
    if (!context || token.isCancellationRequested) {
      return undefined;
    }

    // Unlike definition, hover and the rest, `vscode.executeCodeActionProvider` does not
    // load the target's text model when it is missing - it rejects. The shadow is never
    // shown in an editor, so VS Code drops its model a few minutes after the last rewrite,
    // and from then on every code action request would fail. Reopen it first.
    await this.shadowManager.ensureShadowOpen(context.state);
    if (token.isCancellationRequested) {
      return undefined;
    }

    // `codeActionContext.diagnostics` holds the *cell* diagnostics this extension published,
    // and is deliberately unused: the command below has VS Code build a fresh context from
    // the markers on the shadow URI, which are Metals' own, in the coordinates Metals
    // reported them in. So the diagnostics a quick fix keys off need no back-translation.
    let results: (vscode.CodeAction | vscode.Command | undefined)[] | undefined;
    try {
      results = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command | undefined)[]>(
        "vscode.executeCodeActionProvider",
        context.state.shadowUri,
        vscodeRange(cellRangeToShadow(context.span, plainRange(range))),
        codeActionContext.only?.value,
        Math.max(this.getConfig().codeActionResolveCount, 0)
      );
    } catch (error) {
      // VS Code swallows a provider rejection, so without this the lightbulb just never
      // appears and nothing anywhere says why.
      this.log.error(`codeActions: request against ${context.state.relativePath} failed: ${describeError(error)}`);
      this.log.debug(() => errorStack(error));
      return undefined;
    }
    if (!results || token.isCancellationRequested) {
      return undefined;
    }

    const translated: vscode.CodeAction[] = [];
    for (const result of results) {
      // The command's own result type admits undefined entries: a synthesized action whose
      // command VS Code could not convert comes back as a hole in the array.
      const action = result && this.translateCodeAction(context, result);
      if (action) {
        translated.push(action);
      }
    }
    this.log.debug(
      () =>
        `codeActions: ${results.length} from Metals, ${translated.length} offered to cell ${context.span.cellIndex}`
    );
    return translated;
  }

  /**
   * Turn one of Metals' code actions into one that acts on the cell, or drop it.
   *
   * Only edit-carrying actions survive. An action backed by a *command* is computed
   * server-side from arguments naming the shadow file and shadow positions: there is nothing
   * to translate those into, and if it did run, its edit would land in the shadow script,
   * which the next regenerate discards. Dropping it costs a menu entry; keeping it would
   * offer a fix that silently does nothing.
   */
  private translateCodeAction(
    context: CellContext,
    result: vscode.CodeAction | vscode.Command
  ): vscode.CodeAction | undefined {
    if (typeof (result as vscode.Command).command === "string") {
      // A bare Command rather than a CodeAction - `executeCodeActionProvider` returns those
      // for actions VS Code synthesized. Whatever it does, it does to the shadow script.
      this.log.debug(() => `codeActions: dropped bare command "${result.title}"`);
      return undefined;
    }

    const action = result as vscode.CodeAction;
    if (action.command) {
      this.log.debug(() => `codeActions: dropped command-backed "${action.title}"`);
      return undefined;
    }
    if (!action.edit) {
      // `diagnostics` and `disabled` do not survive the command bridge, so an action with
      // neither an edit nor a command has nothing left it could do here.
      return undefined;
    }

    const edit = this.translateWorkspaceEdit(context.state, action.edit, context.span);
    if (!edit) {
      this.log.debug(() => `codeActions: dropped "${action.title}"; its edits do not fit the cell`);
      return undefined;
    }

    const translated = new vscode.CodeAction(action.title, action.kind);
    translated.edit = edit;
    translated.isPreferred = action.isPreferred;
    return translated;
  }

  // ---------------------------------------------------------------- rename

  async prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<{ range: vscode.Range; placeholder: string } | undefined> {
    const context = await this.requestContext(document, position);
    if (!context || token.isCancellationRequested) {
      return undefined;
    }

    const prepared = await vscode.commands.executeCommand<{ range: vscode.Range; placeholder: string } | undefined>(
      "vscode.prepareRename",
      context.state.shadowUri,
      context.shadowPosition
    );
    if (!prepared || token.isCancellationRequested) {
      return undefined;
    }

    const range = rangeInCell(context.span, prepared.range);
    if (!range) {
      // Metals is offering to rename something the cell cannot show: a synthesized `resN_M`
      // binding, or a name the prelude declares. Refusing now beats opening the rename box
      // and failing once the user has typed a new name.
      throw new Error("That name is generated by the shadow script, so it cannot be renamed from a cell.");
    }
    return { range, placeholder: prepared.placeholder };
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    token: vscode.CancellationToken
  ): Promise<vscode.WorkspaceEdit | undefined> {
    const context = await this.requestContext(document, position);
    if (!context || token.isCancellationRequested) {
      return undefined;
    }

    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
      "vscode.executeDocumentRenameProvider",
      context.state.shadowUri,
      context.shadowPosition,
      newName
    );
    if (!edit || token.isCancellationRequested) {
      return undefined;
    }

    // No `hoistTo` here. A rename is one atomic edit over every occurrence of a name, so an
    // occurrence that cannot be placed in a cell has to fail the whole rename: re-homing it
    // would move code the user never wrote, and skipping it would leave the notebook half
    // renamed and no longer compiling.
    const translated = this.translateWorkspaceEdit(context.state, edit);
    if (!translated) {
      throw new Error(
        `Cannot rename to "${newName}" from a cell: some occurrences are in code the shadow script generates.`
      );
    }
    this.log.debug(
      () => `rename: ${edit.entries().length} file(s) from Metals, ${translated.entries().length} after mapping`
    );
    return translated;
  }

  // ---------------------------------------------------------------- document symbols

  async provideDocumentSymbols(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.DocumentSymbol[] | undefined> {
    // The outline and breadcrumbs are refreshed on every document change, so this is another
    // feature that must follow the shadow rather than drive it.
    const context = this.cellContext(document);
    if (!context || token.isCancellationRequested) {
      return undefined;
    }

    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      context.state.shadowUri
    );
    if (!symbols || token.isCancellationRequested) {
      return undefined;
    }

    const translated = this.symbolsWithinSpan(context.span, symbols);
    this.log.debug(
      () => `documentSymbols: ${translated.length} top-level symbol(s) for cell ${context.span.cellIndex}`
    );
    return translated;
  }

  /**
   * The symbols one cell owns, lifted out of the shadow script's outline.
   *
   * The tree is descended rather than filtered. A shadow script's outline is a single
   * `object` containing every cell, with a further nested object per redefinition, so
   * filtering the top level would keep nothing. A symbol that fits the cell is kept with its
   * children; one that does not is discarded but still searched, which strips the wrapper
   * and the redefinition scopes without losing what they hold.
   */
  private symbolsWithinSpan(
    span: CellSpan,
    symbols: readonly vscode.DocumentSymbol[]
  ): vscode.DocumentSymbol[] {
    const kept: vscode.DocumentSymbol[] = [];
    for (const symbol of symbols) {
      const children = this.symbolsWithinSpan(span, symbol.children ?? []);
      const range = rangeInCell(span, symbol.range);
      const selectionRange = range ? rangeInCell(span, symbol.selectionRange) : undefined;
      // DocumentSymbol's constructor rejects an empty name, and a nameless symbol would be
      // an unclickable blank row in the outline anyway.
      if (!range || !selectionRange || symbol.name.length === 0) {
        kept.push(...children);
        continue;
      }

      const translated = new vscode.DocumentSymbol(
        symbol.name,
        symbol.detail ?? "",
        symbol.kind,
        range,
        selectionRange
      );
      translated.children = children;
      kept.push(translated);
    }
    return kept;
  }

  // ---------------------------------------------------------------- folding ranges

  async provideFoldingRanges(
    document: vscode.TextDocument,
    _foldingContext: vscode.FoldingContext,
    token: vscode.CancellationToken
  ): Promise<vscode.FoldingRange[] | undefined> {
    const context = this.cellContext(document);
    if (!context || token.isCancellationRequested) {
      return undefined;
    }

    const ranges = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
      "vscode.executeFoldingRangeProvider",
      context.state.shadowUri
    );
    if (!ranges || token.isCancellationRequested) {
      return undefined;
    }

    // A fold reaching past the cell is the wrapper object or a redefinition scope; folding
    // one from inside a cell would hide lines the cell does not contain.
    const { firstLine, lastLine } = spanLineBounds(context.span);
    const translated: vscode.FoldingRange[] = [];
    for (const range of ranges) {
      if (range.start < firstLine || range.end > lastLine) {
        continue;
      }
      translated.push(new vscode.FoldingRange(range.start - firstLine, range.end - firstLine, range.kind));
    }
    return translated;
  }

  // ---------------------------------------------------------------- semantic tokens

  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.SemanticTokens | undefined> {
    // Requested per visible document and cached until onDidChangeSemanticTokens fires, so
    // like inlay hints this follows the shadow instead of synchronizing it.
    const context = this.cellContext(document);
    if (!context || token.isCancellationRequested) {
      return undefined;
    }

    // Same trap as code actions: this command reads the shadow's text model rather than
    // loading it, and answers undefined when VS Code has evicted it - so cells would lose
    // Metals' highlighting a few minutes after the last edit.
    await this.shadowManager.ensureShadowOpen(context.state);
    if (token.isCancellationRequested) {
      return undefined;
    }

    const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens | undefined>(
      "vscode.provideDocumentSemanticTokens",
      context.state.shadowUri
    );
    if (!tokens || token.isCancellationRequested) {
      return undefined;
    }

    const { firstLine, lastLine } = spanLineBounds(context.span);
    const data = tokensWithinLines(tokens.data, firstLine, lastLine);
    this.log.trace(() => `semanticTokens: ${data.length / 5} token(s) for cell ${context.span.cellIndex}`);
    return new vscode.SemanticTokens(data);
  }
}
