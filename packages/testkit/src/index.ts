/**
 * Provider conformance test kit.
 *
 * Published so third-party provider authors can verify their implementation
 * against the same expectations the first-party providers must meet. Fixtures
 * are ordinary source files annotated with trailing comments:
 *
 * ```java
 * throw new IOException();          // @throws IOException
 * } catch (Exception e) {           // @caught definite
 * void escapes() throws IOException // @escapes
 * ```
 *
 * The kit drives the provider and asserts the resulting {@link FlowResult}
 * matches those annotations. It is assertion-library agnostic: pass your own
 * `fail` callback (or let it throw).
 */
import type * as vscode from "vscode";
import type {
  AnalysisOptions,
  Confidence,
  ExceptionFlowProvider,
  FlowRequest,
  FlowResult,
  Sink,
  SinkKind,
} from "@leplusorg/catchme-api";
import { DEFAULT_ANALYSIS_OPTIONS } from "@leplusorg/catchme-api";

/** One expectation parsed out of a fixture annotation. */
export interface FixtureExpectation {
  readonly line: number;
  readonly kind: SinkKind;
  readonly confidence?: "definite" | "possible";
  /** Exception type id, when the annotation names one. */
  readonly typeId?: string;
}

/**
 * One fixture to run.
 *
 * The caller supplies an already-opened document rather than a URI: that keeps
 * this package free of any `vscode` *runtime* dependency, so the kit (and its
 * own tests) run in plain Node while integration hosts pass a real
 * `TextDocument`.
 */
export interface ConformanceCase {
  readonly name: string;
  /** Annotations are read from `document.getText()`. */
  readonly document: vscode.TextDocument;
}

export interface ConformanceOptions {
  readonly analysis?: AnalysisOptions;
  /** Checks a provider may legitimately opt out of. */
  readonly skip?: readonly ("stability" | "cancellation")[];
  /** Also fail on sinks the fixture did not predict. Off by default, because
   *  approximate providers may legitimately report extra `possible` results. */
  readonly strict?: boolean;
  /** Milliseconds an already-cancelled request may take to settle. */
  readonly cancellationBudgetMs?: number;
  readonly fail?: (message: string) => void;
}

export interface ConformanceReport {
  /** Number of `@throws` sites exercised across all cases. */
  readonly total: number;
  readonly passed: number;
  readonly failures: readonly string[];
}

/** A `// @throws <typeId>` marker: the seed of an analysis, not a sink. */
export interface ThrowSiteMarker {
  readonly line: number;
  readonly typeId?: string;
}

export interface ParsedFixture {
  /** Where analysis should start. */
  readonly throwSites: readonly ThrowSiteMarker[];
  /** Where it should end up. */
  readonly expectations: readonly FixtureExpectation[];
}

/**
 * Regex for the trailing `// @kind ...` annotations. The remainder of the line
 * is tokenised rather than matched positionally: a positional group would
 * greedily swallow a trailing `definite`/`possible` as if it were a type id.
 */
const ANNOTATION = /\/\/\s*@(throws|caught|escapes|uncaught|unknown)\b(.*)$/;
const CONFIDENCE = new Set(["definite", "possible"]);

/**
 * Parse fixture annotations out of raw source text.
 *
 * Throw sites are returned separately from expectations: `@throws` marks where
 * the exception originates, which is emphatically *not* a place we expect it to
 * be handled. Folding it into the expectation list would assert a handler at
 * the throw line and fail every conforming provider.
 */
export function parseFixture(text: string): ParsedFixture {
  const throwSites: ThrowSiteMarker[] = [];
  const expectations: FixtureExpectation[] = [];

  text.split(/\r?\n/).forEach((rawLine, line) => {
    const m = ANNOTATION.exec(rawLine);
    if (!m) return;
    const kindToken = m[1]!;

    let confidence: Confidence | undefined;
    let typeId: string | undefined;
    for (const tok of (m[2] ?? "").trim().split(/\s+/).filter(Boolean)) {
      if (CONFIDENCE.has(tok)) confidence ??= tok as Confidence;
      else typeId ??= tok;
    }

    if (kindToken === "throws") {
      throwSites.push({ line, ...(typeId ? { typeId } : {}) });
      return;
    }

    const kind: SinkKind =
      kindToken === "caught"
        ? "caught"
        : kindToken === "escapes"
          ? "escapes-function"
          : kindToken === "uncaught"
            ? "uncaught"
            : "unknown";

    expectations.push({
      line,
      kind,
      ...(confidence ? { confidence } : {}),
      ...(typeId ? { typeId } : {}),
    });
  });

  return { throwSites, expectations };
}

/**
 * Assertions every conforming provider must satisfy, independent of language:
 *
 *  1. `capabilities.intraprocedural` is true.
 *  2. If `typeHierarchy` is false, no sink may claim `definite`.
 *  3. An interprocedural provider's paths end in a terminal sink. A provider
 *     that delegates the caller-walk (`interprocedural: false`) instead ends in
 *     `escapes-function`, which the core expands.
 *  4. Depth is never negative.
 *  5. Cancellation is honoured (an already-cancelled token yields promptly).
 *  6. Results are stable across repeated identical requests.
 */
export function checkInvariants(
  provider: ExceptionFlowProvider,
  result: FlowResult,
): string[] {
  const failures: string[] = [];
  const caps = provider.capabilities;

  if (!caps.intraprocedural) {
    failures.push("capabilities.intraprocedural must be true");
  }
  if (!caps.typeHierarchy) {
    const bad = result.terminals.filter((s) => s.confidence === "definite");
    if (bad.length > 0) {
      failures.push(
        `provider declares typeHierarchy:false but emitted ${bad.length} 'definite' sink(s)`,
      );
    }
  }
  for (const path of result.paths) {
    const last = path.steps[path.steps.length - 1];
    if (!last) {
      failures.push("PropagationPath has no steps");
      continue;
    }
    // Only providers that own their caller-walk must produce terminal paths.
    // A provider with `interprocedural: false` is *required* to end in
    // 'escapes-function' — that sink is the hand-off the core's engine expands.
    if (last.kind === "escapes-function" && caps.interprocedural) {
      failures.push(
        "PropagationPath ends in 'escapes-function'; must end in a terminal sink",
      );
    }
    if (path.depth < 0) failures.push("PropagationPath.depth must be >= 0");
  }
  return failures;
}

const NOOP_PROGRESS = { report: () => undefined };
const DEFAULT_CANCELLATION_BUDGET_MS = 2_000;

const token = (cancelled: boolean): vscode.CancellationToken =>
  ({
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose() {} }),
  }) as unknown as vscode.CancellationToken;

const lineOf = (sink: Sink): number => sink.location.range.start.line;

/** Kind + line + confidence, order-independent — used to compare two runs. */
const signature = (result: FlowResult): string =>
  result.terminals
    .map((s) => `${s.kind}@${lineOf(s)}:${s.confidence}`)
    .sort()
    .join("|");

const describe = (e: FixtureExpectation): string =>
  `${e.kind} at line ${e.line + 1}${e.confidence ? ` (${e.confidence})` : ""}`;

/**
 * Every sink the provider reported, anywhere. Expectations are matched against
 * this rather than `terminals` alone: an `@escapes` annotation describes an
 * intermediate step, which by contract never appears as a terminal.
 */
function allSinks(result: FlowResult): Sink[] {
  const out: Sink[] = [];
  for (const path of result.paths) out.push(...path.steps);
  for (const t of result.terminals) if (!out.includes(t)) out.push(t);
  return out;
}

function compareSinks(
  where: string,
  expectations: readonly FixtureExpectation[],
  result: FlowResult,
  strict: boolean,
): string[] {
  const out: string[] = [];
  const sinks = allSinks(result);
  const used = new Set<number>();

  for (const expectation of expectations) {
    const idx = sinks.findIndex(
      (s, i) =>
        !used.has(i) &&
        s.kind === expectation.kind &&
        lineOf(s) === expectation.line &&
        (!expectation.confidence || s.confidence === expectation.confidence),
    );
    if (idx === -1) {
      out.push(
        `${where}: expected ${describe(expectation)}, but no matching sink was reported`,
      );
    } else {
      used.add(idx);
    }
  }

  if (strict) {
    sinks.forEach((s, i) => {
      if (!used.has(i)) {
        out.push(
          `${where}: unexpected ${s.kind} sink at line ${lineOf(s) + 1}`,
        );
      }
    });
  }
  return out;
}

async function runThrowSite(
  provider: ExceptionFlowProvider,
  testCase: ConformanceCase,
  marker: ThrowSiteMarker,
  expectations: readonly FixtureExpectation[],
  options: Required<
    Pick<ConformanceOptions, "strict" | "cancellationBudgetMs">
  > & {
    analysis: AnalysisOptions;
    skip: ReadonlySet<string>;
  },
): Promise<string[]> {
  const { document, name } = testCase;
  const where = `${name}:${marker.line + 1}`;
  const out: string[] = [];

  // Providers must resolve a throw from any position on its line.
  const position = document.lineAt(marker.line).range.start;

  const site = await provider.resolveThrowSite(
    document,
    position,
    token(false),
  );
  if (!site) {
    return [
      `${where}: resolveThrowSite returned nothing for an annotated @throws site`,
    ];
  }
  if (marker.typeId && site.exceptionType.id !== marker.typeId) {
    out.push(
      `${where}: expected thrown type '${marker.typeId}', provider resolved '${site.exceptionType.id}'`,
    );
  }

  const request: FlowRequest = { throwSite: site, options: options.analysis };
  const result = await provider.analyzeExceptionFlow(
    request,
    NOOP_PROGRESS,
    token(false),
  );

  out.push(...checkInvariants(provider, result).map((f) => `${where}: ${f}`));
  out.push(...compareSinks(where, expectations, result, options.strict));

  // Invariant 6: identical requests give identical results.
  if (!options.skip.has("stability")) {
    const again = await provider.analyzeExceptionFlow(
      request,
      NOOP_PROGRESS,
      token(false),
    );
    if (signature(again) !== signature(result)) {
      out.push(
        `${where}: repeated identical requests produced different results`,
      );
    }
  }

  // Invariant 5: an already-cancelled token settles promptly rather than hanging.
  if (!options.skip.has("cancellation")) {
    const settled = await Promise.race([
      provider.analyzeExceptionFlow(request, NOOP_PROGRESS, token(true)).then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), options.cancellationBudgetMs),
      ),
    ]);
    if (!settled) {
      out.push(
        `${where}: did not settle within ${options.cancellationBudgetMs}ms for an already-cancelled token`,
      );
    }
  }

  return out;
}

/** Run the full conformance suite for a provider over a set of fixtures. */
export async function runConformance(
  provider: ExceptionFlowProvider,
  cases: readonly ConformanceCase[],
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const shared = {
    analysis: options.analysis ?? DEFAULT_ANALYSIS_OPTIONS,
    skip: new Set<string>(options.skip ?? []),
    strict: options.strict === true,
    cancellationBudgetMs:
      options.cancellationBudgetMs ?? DEFAULT_CANCELLATION_BUDGET_MS,
  };

  const failures: string[] = [];
  let total = 0;
  let passed = 0;

  for (const testCase of cases) {
    const { throwSites, expectations } = parseFixture(
      testCase.document.getText(),
    );

    if (throwSites.length === 0) {
      failures.push(`${testCase.name}: fixture contains no @throws annotation`);
      continue;
    }

    for (const marker of throwSites) {
      total += 1;
      const caseFailures = await runThrowSite(
        provider,
        testCase,
        marker,
        expectations,
        shared,
      );
      if (caseFailures.length === 0) passed += 1;
      else failures.push(...caseFailures);
    }
  }

  const report: ConformanceReport = { total, passed, failures };
  if (failures.length > 0 && options.fail) options.fail(failures.join("\n"));
  return report;
}
