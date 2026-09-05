/**
 * Public API for CatchMe exception-flow providers.
 *
 * A *provider* teaches CatchMe how one language's exceptions work. The core
 * extension owns all UI, orchestration and (optionally) the interprocedural
 * traversal; a provider owns language semantics only.
 *
 * Third-party extensions depend on this package, implement
 * {@link ExceptionFlowProvider}, and register it through {@link CatchMeApi}:
 *
 * ```ts
 * const catchme = await vscode.extensions
 *   .getExtension<CatchMeApi>('leplusorg.catchme')!.activate();
 * context.subscriptions.push(catchme.registerProvider(myProvider));
 * ```
 *
 * `vscode` types are used in this surface but intentionally NOT bundled — the
 * consuming extension supplies its own `@types/vscode`.
 */
import type * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

/** A resolved or user-chosen exception type. Providers define subtyping. */
export interface ExceptionTypeRef {
  /** Short display name, e.g. `"IOException"`. */
  readonly label: string;
  /** Stable identity used for matching, e.g. `"java.io.IOException"`. */
  readonly id: string;
  /**
   * Language-defined classification. Drives UI hints only — e.g. for Java,
   * `unchecked` tells the user no `throws` trail constrains propagation.
   */
  readonly kind?: "checked" | "unchecked" | "error" | "unknown";
}

/** Where the real or simulated exception originates. */
export interface ThrowSite {
  readonly uri: vscode.Uri;
  /** The `throw` statement, or the caret span for a simulated throw. */
  readonly range: vscode.Range;
  readonly exceptionType: ExceptionTypeRef;
  /** True when the user picked the type (Feature 2) rather than it being read
   *  off an actual throw statement (Feature 1). */
  readonly simulated: boolean;
}

export type SinkKind =
  /** A handler that definitely or possibly handles the exception. */
  | "caught"
  /** Leaves this function → continues in its callers. Always intermediate. */
  | "escapes-function"
  /** Reached a top-level boundary with no handler. */
  | "uncaught"
  /** The provider could not decide (dynamic dispatch, reflection, …). */
  | "unknown";

export type Confidence = "definite" | "possible";

/** One point the exception reaches on its way out. */
export interface Sink {
  readonly kind: SinkKind;
  /** The catch clause, function boundary, or call site. */
  readonly location: vscode.Location;
  /** Display label, e.g. `"catch (IOException e)"` or `"escapes run()"`. */
  readonly label: string;
  readonly confidence: Confidence;
  /** Why this confidence, e.g. `"supertype catch"`, `"virtual dispatch"`. */
  readonly reason?: string;
  /**
   * For an `escapes-function` sink: where the escaping function was invoked
   * from, i.e. the call site that carries the exception to the next frame.
   *
   * This is what turns a list of outcomes into a navigable call chain. It is
   * per-branch — the same function reached from three callers yields three
   * paths, each with its own `callSite`.
   */
  readonly callSite?: vscode.Location;
}

/**
 * One route from the throw to a terminal sink. `steps` is ordered; every path
 * ends in `caught`, `uncaught`, or `unknown` — `escapes-function` only ever
 * appears as an intermediate step.
 */
export interface PropagationPath {
  readonly steps: readonly Sink[];
  /** Number of interprocedural hops taken. */
  readonly depth: number;
  /**
   * True when this specific path stopped at the depth cap or time budget rather
   * than at a real terminal. `FlowResult.partial` says *some* path was cut
   * short; this says *which*, so the UI can offer to expand just that one.
   */
  readonly truncated?: boolean;
}

export interface AnalysisOptions {
  /** Cap on interprocedural hops. */
  readonly maxDepth: number;
  readonly precision: "definite" | "possible" | "all";
  /** Follow propagation into dependencies / stdlib. */
  readonly includeLibraryCode: boolean;
  readonly timeoutMs: number;
}

export interface FlowRequest {
  readonly throwSite: ThrowSite;
  readonly options: AnalysisOptions;
}

export interface FlowResult {
  readonly throwSite: ThrowSite;
  /** May be incomplete when {@link partial} is true. */
  readonly paths: readonly PropagationPath[];
  /** Flattened terminal sinks, for the Peek list. */
  readonly terminals: readonly Sink[];
  /** True if a depth/time bound stopped the search early. */
  readonly partial: boolean;
  /** Provider notes surfaced to the user. */
  readonly diagnostics?: readonly string[];
}

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  /** Mandatory baseline: resolve handlers within the enclosing function. */
  readonly intraprocedural: true;
  /** True if the provider walks callers itself; false to let the core drive
   *  traversal via LSP Call Hierarchy + {@link ExceptionFlowProvider.resolveAtCallSite}. */
  readonly interprocedural: boolean;
  /** True if subtype matching uses real type information (not heuristics).
   *  When false the core downgrades every result to `possible`. */
  readonly typeHierarchy: boolean;
  /** Whether Feature 2 (simulated throws) is supported. */
  readonly simulate: boolean;
  /** Best achievable confidence; caps what the UI will label `definite`. */
  readonly precision: Confidence;
  /** Human-readable engine name for the status bar / logs, e.g. `"JDT (jdt.ls)"`. */
  readonly engine: string;
}

/** Streaming channel so long searches render progressively. */
export interface FlowProgress {
  report(partial: {
    paths?: readonly PropagationPath[];
    message?: string;
  }): void;
}

export interface ExceptionFlowProvider {
  /** `languageId`s this provider serves, e.g. `['java']`. */
  readonly languages: readonly string[];
  readonly capabilities: ProviderCapabilities;

  /**
   * Feature 1 seed: the throw at `position`, or undefined if the caret is not
   * on one. Also drives the `catchme.onThrowStatement` context key that gates
   * the menu item, so this must be cheap and cancellable.
   */
  resolveThrowSite(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<ThrowSite>;

  /**
   * Feature 2: candidate types for the Quick Pick at `position`, ordered by
   * relevance (in-scope, then imported, then project-wide).
   */
  suggestExceptionTypes(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<readonly ExceptionTypeRef[]>;

  /**
   * The core question. MUST at minimum resolve the intraprocedural step:
   * handlers within the enclosing function, plus an `escapes-function` sink at
   * the boundary. If {@link ProviderCapabilities.interprocedural} is true the
   * provider SHOULD follow callers itself and return complete paths.
   *
   * Implementations must honour `token` and must not mutate the workspace.
   */
  analyzeExceptionFlow(
    request: FlowRequest,
    progress: FlowProgress,
    token: vscode.CancellationToken,
  ): Promise<FlowResult>;

  /**
   * Optional. Resolve handling within a *caller's* function for an exception
   * arriving at `callSite`. Lets a non-interprocedural provider be driven
   * step-by-step by the core's traversal engine.
   */
  resolveAtCallSite?(
    callSite: vscode.Location,
    exceptionType: ExceptionTypeRef,
    token: vscode.CancellationToken,
  ): Promise<readonly Sink[]>;
}

// ---------------------------------------------------------------------------
// Extension API
// ---------------------------------------------------------------------------

/** Returned from the core extension's `activate()`. */
export interface CatchMeApi {
  /** Bumped only on breaking changes; additive changes keep this stable. */
  readonly version: 1;
  registerProvider(provider: ExceptionFlowProvider): vscode.Disposable;
  /** Programmatic entry point, for tests and other extensions. */
  analyze(request: FlowRequest): Promise<FlowResult>;
  readonly onDidChangeProviders: vscode.Event<void>;
}

/**
 * Throw from a provider when its backend is not ready yet (e.g. the language
 * server is still indexing). The core surfaces a retry affordance instead of
 * a hard failure.
 */
export class ProviderNotReadyError extends Error {
  constructor(
    message: string,
    /** Optional hint shown to the user, e.g. "Java language server starting…". */
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ProviderNotReadyError";
  }
}

/** Sensible defaults; the core overlays user settings on top. */
export const DEFAULT_ANALYSIS_OPTIONS: AnalysisOptions = {
  maxDepth: 8,
  precision: "possible",
  includeLibraryCode: false,
  timeoutMs: 15_000,
};
