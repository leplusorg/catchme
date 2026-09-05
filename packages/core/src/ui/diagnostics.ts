/**
 * Optional Problems-panel reporting for exceptions that can escape uncaught.
 *
 * Off by default (`catchme.diagnostics.reportUncaught`), and deliberately so:
 * an analysis is an explicit, on-demand action, and quietly filling the
 * Problems panel from it would surprise people.
 *
 * When enabled, one diagnostic is published at the **throw site** rather than
 * one per escaping route — that is the line the developer can actually act on.
 * The individual boundaries are attached as related information so they stay
 * one click away.
 */
import * as vscode from "vscode";
import type { FlowResult } from "@leplusorg/catchme-api";

export class UncaughtDiagnostics implements vscode.Disposable {
  private readonly collection =
    vscode.languages.createDiagnosticCollection("catchme");

  private get enabled(): boolean {
    return vscode.workspace
      .getConfiguration("catchme.diagnostics")
      .get<boolean>("reportUncaught", false);
  }

  update(result: FlowResult): void {
    if (!this.enabled) {
      this.collection.clear();
      return;
    }

    const uncaught = result.terminals.filter((t) => t.kind === "uncaught");
    if (uncaught.length === 0) {
      this.collection.clear();
      return;
    }

    const { throwSite } = result;
    const routes = `${uncaught.length} route${uncaught.length === 1 ? "" : "s"}`;
    const diagnostic = new vscode.Diagnostic(
      throwSite.range,
      `${throwSite.exceptionType.label} can propagate uncaught (${routes}).`,
      vscode.DiagnosticSeverity.Information,
    );
    diagnostic.source = "CatchMe";
    diagnostic.relatedInformation = uncaught.map(
      (sink) =>
        new vscode.DiagnosticRelatedInformation(sink.location, sink.label),
    );

    this.collection.set(throwSite.uri, [diagnostic]);
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}
