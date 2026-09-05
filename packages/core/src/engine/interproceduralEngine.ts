/**
 * Interprocedural traversal engine.
 *
 * This is the language-agnostic half of the analysis. When a provider reports
 * that an exception `escapes-function`, the engine finds that function's
 * callers via **standard LSP Call Hierarchy** and asks the provider to resolve
 * handling at each call site — repeating until a terminal sink, a depth cap, or
 * the time budget is hit.
 *
 * Providers that do their own interprocedural work (`capabilities
 * .interprocedural === true`, e.g. Java/JDT) bypass this entirely; the engine
 * just forwards to them.
 */
import * as vscode from "vscode";
import type {
  ExceptionFlowProvider,
  FlowProgress,
  FlowRequest,
  FlowResult,
  PropagationPath,
  Sink,
} from "@leplusorg/catchme-api";
import type { ProviderRegistry } from "../registry/providerRegistry";

export class InterproceduralEngine {
  constructor(private readonly registry: ProviderRegistry) {}

  async analyze(
    request: FlowRequest,
    progress: FlowProgress = { report: () => undefined },
    token: vscode.CancellationToken = new vscode.CancellationTokenSource()
      .token,
  ): Promise<FlowResult> {
    const document = await vscode.workspace.openTextDocument(
      request.throwSite.uri,
    );
    const provider = await this.registry.getForLanguage(document.languageId);
    if (!provider) {
      return empty(request, [
        `No exception-flow provider is registered for '${document.languageId}'.`,
      ]);
    }

    const base = await provider.analyzeExceptionFlow(request, progress, token);

    // Deep providers already returned complete paths.
    if (provider.capabilities.interprocedural) {
      return downgradeIfNeeded(provider, base);
    }
    const expanded = await this.expand(
      provider,
      base,
      request,
      progress,
      token,
    );
    return downgradeIfNeeded(provider, expanded);
  }

  /**
   * Expand every `escapes-function` leaf by walking incoming calls, breadth
   * first, until terminal sinks / maxDepth / timeout.
   */
  private async expand(
    provider: ExceptionFlowProvider,
    base: FlowResult,
    request: FlowRequest,
    progress: FlowProgress,
    token: vscode.CancellationToken,
  ): Promise<FlowResult> {
    const deadline = Date.now() + request.options.timeoutMs;
    /**
     * Call sites already expanded, **globally across the whole walk** rather
     * than per path. This is what stops a cyclic call graph looping forever and
     * keeps a diamond-shaped graph from blowing up exponentially.
     *
     * The trade-off is deliberate and worth knowing: when two distinct chains
     * converge on the same call site, only the first one continues through it —
     * the second is dropped rather than explored. So the result is a set of
     * *representative* routes, not every possible route. Making this per-path
     * would be more complete and, on a real codebase, unbounded.
     */
    const visited = new Set<string>();
    const completed: PropagationPath[] = [];
    let partial = base.partial;

    let frontier: PropagationPath[] = base.paths.filter(endsInEscape);
    completed.push(...base.paths.filter((p) => !endsInEscape(p)));

    while (frontier.length > 0) {
      const outOfTime = token.isCancellationRequested || Date.now() > deadline;
      if (outOfTime) {
        // Everything still in flight stopped short of a real terminal; keep it
        // rather than dropping it, flagged so the UI can offer to expand.
        partial = true;
        completed.push(...frontier.map(truncate));
        break;
      }
      const next: PropagationPath[] = [];

      for (const path of frontier) {
        const tail = path.steps[path.steps.length - 1];
        if (!tail) continue;
        if (path.depth >= request.options.maxDepth) {
          partial = true;
          completed.push(truncate(path));
          continue;
        }

        const callers = await incomingCalls(tail.location, token);
        if (callers.length === 0) {
          // Nothing calls it (entry point / framework-invoked): terminal.
          completed.push(appendStep(path, uncaughtAt(tail.location)));
          continue;
        }

        for (const caller of callers) {
          const key = locationKey(caller);
          if (visited.has(key)) continue;
          visited.add(key);

          const sinks =
            (await provider.resolveAtCallSite?.(
              caller,
              request.throwSite.exceptionType,
              token,
            )) ?? [];

          // Record which call site carried the exception out of this frame.
          // It belongs to the escaping step and is per-branch: the same
          // function reached from three callers yields three distinct paths.
          const viaCaller = withCallSite(path, caller);

          for (const sink of sinks) {
            const grown = appendStep(viaCaller, sink);
            (sink.kind === "escapes-function" ? next : completed).push(grown);
          }
        }
      }
      progress.report({ paths: completed });
      frontier = next;
    }

    return {
      throwSite: base.throwSite,
      paths: completed,
      // A truncated path ends on an `escapes-function` hand-off, which is not
      // an answer — excluding it keeps "where can it end up" honest.
      terminals: completed
        .filter((p) => p.truncated !== true)
        .map((p) => p.steps[p.steps.length - 1])
        .filter(
          (s): s is Sink => s !== undefined && s.kind !== "escapes-function",
        ),
      partial,
      ...(base.diagnostics ? { diagnostics: base.diagnostics } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Standard LSP Call Hierarchy — works for any server that implements it. */
async function incomingCalls(
  location: vscode.Location,
  _token: vscode.CancellationToken,
): Promise<vscode.Location[]> {
  const items = await vscode.commands.executeCommand<
    vscode.CallHierarchyItem[]
  >("vscode.prepareCallHierarchy", location.uri, location.range.start);
  if (!items?.length) return [];

  const out: vscode.Location[] = [];
  for (const item of items) {
    const incoming = await vscode.commands.executeCommand<
      vscode.CallHierarchyIncomingCall[]
    >("vscode.provideIncomingCalls", item);
    for (const call of incoming ?? []) {
      for (const range of call.fromRanges) {
        out.push(new vscode.Location(call.from.uri, range));
      }
    }
  }
  return out;
}

function endsInEscape(path: PropagationPath): boolean {
  return path.steps[path.steps.length - 1]?.kind === "escapes-function";
}

function appendStep(path: PropagationPath, sink: Sink): PropagationPath {
  return { steps: [...path.steps, sink], depth: path.depth + 1 };
}

/** Copy of `path` whose last step records the call site it escaped through. */
function withCallSite(
  path: PropagationPath,
  callSite: vscode.Location,
): PropagationPath {
  const last = path.steps[path.steps.length - 1];
  if (!last) return path;
  return {
    ...path,
    steps: [...path.steps.slice(0, -1), { ...last, callSite }],
  };
}

/** Mark a path as stopped by a bound rather than by a real terminal. */
function truncate(path: PropagationPath): PropagationPath {
  return { ...path, truncated: true };
}

function uncaughtAt(location: vscode.Location): Sink {
  return {
    kind: "uncaught",
    location,
    label: "No caller found — propagates out of the program/thread",
    confidence: "possible",
    reason: "no incoming calls reported by the language server",
  };
}

function locationKey(l: vscode.Location): string {
  return `${l.uri.toString()}#${l.range.start.line}:${l.range.start.character}`;
}

/** Honour the contract that a provider without type info never says 'definite'. */
function downgradeIfNeeded(
  provider: ExceptionFlowProvider,
  result: FlowResult,
): FlowResult {
  if (provider.capabilities.typeHierarchy) return result;
  const fix = (s: Sink): Sink => ({ ...s, confidence: "possible" });
  return {
    ...result,
    paths: result.paths.map((p) => ({ ...p, steps: p.steps.map(fix) })),
    terminals: result.terminals.map(fix),
  };
}

function empty(request: FlowRequest, diagnostics: string[]): FlowResult {
  return {
    throwSite: request.throwSite,
    paths: [],
    terminals: [],
    partial: false,
    diagnostics,
  };
}
