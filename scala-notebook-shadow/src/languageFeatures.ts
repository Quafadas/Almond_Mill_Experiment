import * as vscode from "vscode";
import {
  CellLocationLink,
  cellPositionToShadow,
  isAppendedColumn,
  PlainPosition,
  PlainRange,
  positionWithinSpan,
  rebasePosition,
  rebaseRange,
  selectionChainWithinSpan,
  rangeWithinSpan,
  shadowLinkToCell,
  shadowRangeToCell,
  spanLineBounds,
} from "./mapping";
import { Logger } from "./log";
import { DiagnosticSource, ExtensionConfig, ShadowManager, ShadowState } from "./shadowManager";
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
 * shadow file's header. There is nowhere in the cell to apply those, so they collapse to an
 * empty edit at the top rather than landing on an unrelated line.
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
    vscode.Disposable
{
  private readonly inlayHintsChanged = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;

  readonly onDidChangeInlayHints = this.inlayHintsChanged.event;

  constructor(
    private readonly shadowManager: ShadowManager,
    private readonly log: Logger,
    private readonly getConfig: () => ExtensionConfig
  ) {
    this.subscription = shadowManager.onDidChangeAnalysis(() => this.inlayHintsChanged.fire());
  }

  dispose(): void {
    this.subscription.dispose();
    this.inlayHintsChanged.dispose();
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
  private async requestContext(document: vscode.TextDocument, position: vscode.Position): Promise<RequestContext | undefined> {
    const state = this.shadowManager.getStateForCellUri(document.uri);
    if (!state) {
      return undefined;
    }

    await this.shadowManager.synchronizeForLanguageFeature(state.notebook);
    const context = this.cellContext(document);
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

    const translated = await Promise.all(
      results.map(async (result) => {
        const offset = await this.shadowLineOffsetFor(context, result);
        return this.translateDefinition(context, result, offset);
      })
    );
    this.log.debug(
      `${command}: ${results.length} result(s) at shadow ${context.shadowPosition.line}:${context.shadowPosition.character}`
    );
    return translated as vscode.Location[] | vscode.LocationLink[];
  }

  /**
   * How far to shift a definition target to reach shadow-file coordinates, or undefined if
   * it doesn't point at this notebook's shadow at all (a library source, say) and so must
   * be handed back untouched. Metals resolves definitions to Mill's generated `.dest/` copy
   * rather than the shadow file, which is why this isn't a plain URI comparison.
   */
  private async shadowLineOffsetFor(
    context: RequestContext,
    definition: vscode.Location | vscode.LocationLink
  ): Promise<number | undefined> {
    const targetUri = "targetUri" in definition ? definition.targetUri : definition.uri;
    if (!this.shadowManager.mightBeShadowSource(targetUri)) {
      return undefined;
    }
    const resolved = await this.shadowManager.resolveShadowSource(targetUri);
    return resolved && resolved.state === context.state ? resolved.lineOffset : undefined;
  }

  private translateDefinition(
    context: RequestContext,
    definition: vscode.Location | vscode.LocationLink,
    shadowLineOffset: number | undefined
  ): vscode.Location | vscode.LocationLink {
    const translate = (link: { targetRange: vscode.Range; targetSelectionRange?: vscode.Range }): CellLocationLink | undefined =>
      shadowLineOffset === undefined
        ? undefined
        : shadowLinkToCell(
            context.state.mapping,
            {
              targetRange: plainRange(link.targetRange),
              targetSelectionRange: link.targetSelectionRange ? plainRange(link.targetSelectionRange) : undefined,
            },
            shadowLineOffset
          );

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

    const translated = await Promise.all(locations.map((location) => this.translateReference(context, location)));

    // The same hit can arrive twice, once against the shadow file and once against Mill's
    // copy of it; both translate to one cell location, and the peek view should show one.
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
  private async translateReference(
    context: RequestContext,
    location: vscode.Location
  ): Promise<vscode.Location | undefined> {
    if (!this.shadowManager.mightBeShadowSource(location.uri)) {
      return location;
    }
    const resolved = await this.shadowManager.resolveShadowSource(location.uri);
    if (!resolved) {
      // A `.dest/` copy of some other Mill script, not a notebook shadow at all.
      return location;
    }
    if (resolved.state !== context.state) {
      return undefined;
    }

    const link = shadowLinkToCell(
      context.state.mapping,
      { targetRange: plainRange(location.range) },
      resolved.lineOffset
    );
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

    // Metals answers definition and completion for the shadow file, but inlay hints come
    // from the presentation compiler for a file that is genuinely a source of a build
    // target - which is Mill's `.dest/` copy, not the script it was copied from. So try
    // every file this shadow is known by, newest knowledge last, and take the first that
    // has anything to say. The copy only refreshes when Mill compiles, so hints from it
    // lag an edit in exactly the way diagnostics do.
    for (const source of this.shadowManager.diagnosticSourcesFor(context.state)) {
      const hints = await this.requestInlayHints(document, context, source, token);
      if (token.isCancellationRequested) {
        return undefined;
      }
      if (hints.length > 0) {
        this.log.debug(
          `inlayHints: cell ${context.span.cellIndex} got ${hints.length} hint(s) from ` +
            `${source.uri.path.split("/").pop()} (+${source.lineOffset} lines)`
        );
        return hints;
      }
    }

    this.log.debug(`inlayHints: cell ${context.span.cellIndex} got nothing from any shadow source`);
    return [];
  }

  /** Ask one file that carries this cell's code for hints, and map what comes back into the cell. */
  private async requestInlayHints(
    cell: vscode.TextDocument,
    context: CellContext,
    source: DiagnosticSource,
    token: vscode.CancellationToken
  ): Promise<vscode.InlayHint[]> {
    let sourceDocument: vscode.TextDocument;
    try {
      sourceDocument = await vscode.workspace.openTextDocument(source.uri);
    } catch {
      // A `.dest/` copy Mill has since cleaned up.
      return [];
    }

    // A cell is small, so ask for its whole span rather than mapping the requested range;
    // everything we return is inside the cell either way.
    const { firstLine, lastLine } = spanLineBounds(context.span);
    const first = firstLine + source.lineOffset;
    const last = Math.min(lastLine + source.lineOffset, sourceDocument.lineCount - 1);
    if (last < first || token.isCancellationRequested) {
      return [];
    }

    const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
      "vscode.executeInlayHintProvider",
      source.uri,
      new vscode.Range(new vscode.Position(first, 0), sourceDocument.lineAt(last).range.end)
    );
    if (!hints || token.isCancellationRequested) {
      return [];
    }

    const translated: vscode.InlayHint[] = [];
    for (const hint of hints) {
      const shadowPosition = rebasePosition(plainPosition(hint.position), -source.lineOffset);
      const position = positionWithinSpan(context.span, shadowPosition);
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
      translated.push(this.translateInlayHint(context.span, hint, vscodePosition(position), source.lineOffset));
    }
    return translated;
  }

  private translateInlayHint(
    span: CellSpan,
    hint: vscode.InlayHint,
    position: vscode.Position,
    lineOffset: number
  ): vscode.InlayHint {
    const translated = new vscode.InlayHint(position, this.translateInlayLabel(hint.label), hint.kind);
    translated.tooltip = hint.tooltip;
    translated.paddingLeft = hint.paddingLeft;
    translated.paddingRight = hint.paddingRight;

    // Accepting a hint applies these edits, which is how an inferred type gets written out.
    // Keep them only if every one lands in this cell, so accepting can never edit a
    // synthesized line - a partial application would corrupt the cell.
    const edits = hint.textEdits?.map((edit) => {
      const shadowRange = rebaseRange(plainRange(edit.range), -lineOffset);
      const range = rangeWithinSpan(span, shadowRange);
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
      if (part.location && !this.shadowManager.mightBeShadowSource(part.location.uri)) {
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
}
