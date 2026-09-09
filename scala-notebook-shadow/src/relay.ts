import * as vscode from "vscode";
import { groupByCellUri, PlainDiagnostic, translateDiagnostic, TranslatedDiagnostic } from "./mapping";
import { Logger } from "./log";
import { looksLikeScalaCliGeneratedSource } from "./scalaCliBuild";
import { ShadowManager, ShadowState } from "./shadowManager";

function toPlain(diagnostic: vscode.Diagnostic): PlainDiagnostic {
  return {
    range: {
      start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
      end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character },
    },
    message: diagnostic.message,
    severity: diagnostic.severity,
    source: diagnostic.source,
    code: diagnostic.code,
    tags: diagnostic.tags,
    relatedInformation: diagnostic.relatedInformation?.map((info) => ({
      uri: info.location.uri,
      range: {
        start: { line: info.location.range.start.line, character: info.location.range.start.character },
        end: { line: info.location.range.end.line, character: info.location.range.end.character },
      },
      message: info.message,
    })),
  };
}

function toVscodeDiagnostic(plain: PlainDiagnostic): vscode.Diagnostic {
  const range = new vscode.Range(
    new vscode.Position(plain.range.start.line, plain.range.start.character),
    new vscode.Position(plain.range.end.line, plain.range.end.character)
  );
  const diagnostic = new vscode.Diagnostic(range, plain.message, plain.severity);
  diagnostic.source = plain.source;
  diagnostic.code = plain.code;
  diagnostic.tags = plain.tags;
  if (plain.relatedInformation) {
    diagnostic.relatedInformation = plain.relatedInformation.map(
      (info) =>
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(
            info.uri,
            new vscode.Range(
              new vscode.Position(info.range.start.line, info.range.start.character),
              new vscode.Position(info.range.end.line, info.range.end.character)
            )
          ),
          info.message
        )
    );
  }
  return diagnostic;
}

/**
 * Relays diagnostics VS Code reports against a shadow file back onto the
 * notebook cells it was generated from, with line/column ranges remapped.
 */
export class DiagnosticRelay {
  constructor(
    private readonly collection: vscode.DiagnosticCollection,
    private readonly shadowManager: ShadowManager,
    private readonly log: Logger
  ) {}

  /** Handler for vscode.languages.onDidChangeDiagnostics. */
  onDidChangeDiagnostics(e: vscode.DiagnosticChangeEvent): void {
    for (const uri of e.uris) {
      const state = this.shadowManager.getStateForShadowUri(uri);
      if (state) {
        this.publish(state);
      } else if (looksLikeScalaCliGeneratedSource(uri.fsPath)) {
        // Not relayed - see looksLikeScalaCliGeneratedSource. Logged so issue #15 §5.4 can be
        // answered from a session rather than guessed at.
        this.log.debug(
          () => `Diagnostics on a scala-cli generated copy, which the relay does not claim: ${uri.toString()}`
        );
      }
    }
  }

  /** Recompute a notebook's cell diagnostics from what Metals currently reports on its shadow. */
  private publish(state: ShadowState): void {
    const translated: TranslatedDiagnostic[] = [];
    for (const diagnostic of vscode.languages.getDiagnostics(state.shadowUri)) {
      const result = translateDiagnostic(state.mapping, state.shadowUri, toPlain(diagnostic));
      if (result) {
        translated.push(result);
      }
    }

    const grouped = groupByCellUri(translated);

    // Set for every Scala cell, including empty arrays, so stale squiggles clear.
    for (const cell of state.notebook.getCells()) {
      if (cell.kind !== vscode.NotebookCellKind.Code || cell.document.languageId !== "scala") {
        continue;
      }
      const plainDiagnostics = grouped.get(cell.document.uri.toString()) ?? [];
      this.collection.set(cell.document.uri, plainDiagnostics.map(toVscodeDiagnostic));
    }

    this.log.debug(
      () => `${state.relativePath}: ${translated.length} diagnostic(s) across ${grouped.size} cell(s)`
    );

    // Diagnostics landing is the clearest signal that Metals has re-analyzed the shadow,
    // and so that its inlay hints for these cells are worth asking for again.
    this.shadowManager.notifyAnalysisChanged(state);
  }
}
