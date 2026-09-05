/**
 * Generic provider — baseline exception-flow support for any brace-style
 * language, with no language-specific work and no grammar dependency.
 *
 * Strategy, and its honest limits:
 *  - **Intraprocedural**: a comment/string-aware syntactic scanner (see
 *    `syntax.ts`) locates the enclosing `try` blocks and their handlers. There
 *    are no type bindings, so handler matching compares simple names and treats
 *    well-known roots as catch-alls. Everything is therefore `possible`.
 *  - **Interprocedural**: deliberately not implemented here. We declare
 *    `interprocedural: false` and implement `resolveAtCallSite`, so the core's
 *    engine drives the caller-walk over standard LSP Call Hierarchy.
 *
 * That asymmetry is the point of the two-tier design: a language gets useful
 * results immediately, and can later be upgraded by a deep provider (see
 * provider-java) with no change to the core.
 */
import * as vscode from "vscode";
import type {
  ExceptionFlowProvider,
  ExceptionTypeRef,
  FlowProgress,
  FlowRequest,
  FlowResult,
  PropagationPath,
  ProviderCapabilities,
  Sink,
  ThrowSite,
} from "@leplusorg/catchme-api";
import {
  findEnclosingFunction,
  findEnclosingTryBlocks,
  findThrowAt,
  handlerMatches,
  simpleName,
  stripNonCode,
  typeNamesFrom,
} from "./syntax";

/** Languages whose `try { } catch (…) { }` shape this scanner understands. */
const BRACE_LANGUAGES = [
  "java",
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
  "csharp",
  "cpp",
  "c",
  "php",
] as const;

export class GenericLspProvider implements ExceptionFlowProvider {
  readonly languages: readonly string[];

  readonly capabilities: ProviderCapabilities = {
    intraprocedural: true,
    interprocedural: false, // the core drives the caller-walk
    typeHierarchy: false, // no bindings → never `definite`
    simulate: true,
    precision: "possible",
    engine: "Generic (syntactic + LSP Call Hierarchy)",
  };

  constructor(languages: readonly string[] = BRACE_LANGUAGES) {
    this.languages = languages;
  }

  async resolveThrowSite(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<ThrowSite | undefined> {
    const code = stripNonCode(document.getText());
    const found = findThrowAt(code, document.offsetAt(position));
    if (!found) {
      return undefined;
    }
    return {
      uri: document.uri,
      range: new vscode.Range(
        document.positionAt(found.start),
        document.positionAt(found.end),
      ),
      exceptionType: { id: found.typeName, label: simpleName(found.typeName) },
      simulated: false,
    };
  }

  /**
   * Candidate types harvested from the file itself: names already thrown or
   * caught here. Without a type index that is the best available signal, and it
   * is usually what the user wants anyway.
   */
  async suggestExceptionTypes(
    document: vscode.TextDocument,
    _position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<readonly ExceptionTypeRef[]> {
    const code = stripNonCode(document.getText());
    const names = new Set<string>();

    for (const m of code.matchAll(
      /\b(?:throw|raise)\s+(?:new\s+)?([A-Za-z_$][\w$.]*)/g,
    )) {
      if (m[1]) names.add(m[1]);
    }
    for (const m of code.matchAll(/\bcatch\s*\(([^)]*)\)/g)) {
      for (const t of typeNamesFrom(m[1] ?? "")) names.add(t);
    }
    return [...names].map((id) => ({ id, label: simpleName(id) }));
  }

  async analyzeExceptionFlow(
    request: FlowRequest,
    _progress: FlowProgress,
    _token: vscode.CancellationToken,
  ): Promise<FlowResult> {
    const document = (await vscode.workspace.openTextDocument(
      request.throwSite.uri,
    )) as vscode.TextDocument;

    const steps = this.resolveAt(
      document,
      document.offsetAt(request.throwSite.range.start),
      request.throwSite.exceptionType.id,
    );

    const last = steps[steps.length - 1];
    const paths: PropagationPath[] =
      steps.length > 0 ? [{ steps, depth: 0 }] : [];

    return {
      throwSite: request.throwSite,
      paths,
      // `escapes-function` is a hand-off, not an answer: the core expands it.
      terminals: last && last.kind !== "escapes-function" ? [last] : [],
      partial: false,
    };
  }

  async resolveAtCallSite(
    callSite: vscode.Location,
    exceptionType: ExceptionTypeRef,
    _token: vscode.CancellationToken,
  ): Promise<readonly Sink[]> {
    const document = (await vscode.workspace.openTextDocument(
      callSite.uri,
    )) as vscode.TextDocument;
    return this.resolveAt(
      document,
      document.offsetAt(callSite.range.start),
      exceptionType.id,
    );
  }

  // -------------------------------------------------------------------------

  /**
   * The intraprocedural core: first matching handler enclosing `offset`, or an
   * `escapes-function` sink at the enclosing function boundary.
   */
  private resolveAt(
    document: vscode.TextDocument,
    offset: number,
    thrownId: string,
  ): Sink[] {
    const code = stripNonCode(document.getText());
    const thrownName = simpleName(thrownId);

    for (const block of findEnclosingTryBlocks(code, offset)) {
      for (const clause of block.catches) {
        // An untyped handler — `catch (e)` in JS, or a bare `catch {}` — parses
        // to no type names. Probing with a single empty name is what routes it
        // to `handlerMatches`'s "untyped catches anything" branch; dropping the
        // clause instead would wrongly report the exception as escaping.
        const names = clause.typeNames.length > 0 ? clause.typeNames : [""];
        const hit = names.find((n) => handlerMatches(thrownName, n));
        if (hit === undefined) {
          continue;
        }
        return [
          {
            kind: "caught",
            location: this.locate(document, clause.start, clause.end),
            label: `catch (${clause.typeNames.join(" | ") || "…"})`,
            confidence: "possible",
            reason: "syntactic match; no type information available",
          },
        ];
      }
    }

    const fn = findEnclosingFunction(code, offset);
    return [
      {
        kind: fn ? "escapes-function" : "unknown",
        location: fn
          ? this.locate(document, fn.start, fn.end)
          : this.locate(document, offset, offset),
        label: fn
          ? "escapes the enclosing function"
          : "no enclosing function found",
        confidence: "possible",
        reason: fn
          ? undefined
          : "the scanner could not identify a function boundary",
      },
    ];
  }

  private locate(
    document: vscode.TextDocument,
    start: number,
    end: number,
  ): vscode.Location {
    return new vscode.Location(
      document.uri,
      new vscode.Range(document.positionAt(start), document.positionAt(end)),
    );
  }
}
