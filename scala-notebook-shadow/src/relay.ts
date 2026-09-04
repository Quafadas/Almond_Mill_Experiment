import * as vscode from "vscode";
import { groupByCellUri, PlainDiagnostic, translateDiagnostic, TranslatedDiagnostic } from "./mapping";
import { ShadowManager } from "./shadowManager";

function toPlain(diagnostic: vscode.Diagnostic): PlainDiagnostic {
  return {
    range: {
      start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
      end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character },
    },
    message: diagnostic.message,
    severity: diagnostic.severity,
    source: diagnostic.source,
    code: diagnostic.code as PlainDiagnostic["code"],
    tags: diagnostic.tags as number[] | undefined,
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
  constructor(private readonly collection: vscode.DiagnosticCollection, private readonly shadowManager: ShadowManager) {}

  /** Handler for vscode.languages.onDidChangeDiagnostics. */
  onDidChangeDiagnostics(e: vscode.DiagnosticChangeEvent): void {
    for (const uri of e.uris) {
      if (this.shadowManager.isShadowUri(uri)) {
        this.relay(uri);
      }
    }
  }

  private relay(shadowUri: vscode.Uri): void {
    const state = this.shadowManager.getStateForShadowUri(shadowUri);
    if (!state) {
      return;
    }

    const shadowDiagnostics = vscode.languages.getDiagnostics(shadowUri);
    const translated: TranslatedDiagnostic[] = [];
    for (const diagnostic of shadowDiagnostics) {
      const result = translateDiagnostic(state.mapping, shadowUri, toPlain(diagnostic));
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
  }
}
