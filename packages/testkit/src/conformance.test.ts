import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import type {
  ExceptionFlowProvider,
  FlowResult,
  ProviderCapabilities,
  Sink,
  ThrowSite,
} from "@leplusorg/catchme-api";
import { runConformance, type ConformanceCase } from "./index";

// ---------------------------------------------------------------------------
// fakes — `vscode` is type-only here, so plain objects are enough
// ---------------------------------------------------------------------------

const doc = (text: string): vscode.TextDocument =>
  ({
    getText: () => text,
    uri: { toString: () => "file:///T.java" },
    lineAt: (line: number) => ({ range: { start: { line, character: 0 } } }),
  }) as unknown as vscode.TextDocument;

const sink = (
  kind: Sink["kind"],
  line: number,
  confidence: Sink["confidence"] = "definite",
): Sink =>
  ({
    kind,
    location: {
      uri: { toString: () => "file:///T.java" },
      range: { start: { line } },
    },
    label: `${kind}@${line}`,
    confidence,
  }) as unknown as Sink;

const resultOf = (sinks: Sink[]): FlowResult => {
  const terminals = sinks.filter((s) => s.kind !== "escapes-function");
  return {
    throwSite: {} as never,
    paths: [{ steps: sinks, depth: 0 }],
    terminals,
    partial: false,
  } as FlowResult;
};

interface FakeOpts {
  readonly throwSite?: ThrowSite | undefined;
  readonly sinks?: Sink[];
  /** Return a different result on each call, to trip the stability check. */
  readonly unstable?: boolean;
  /** Never settle when the token is already cancelled, to trip that check. */
  readonly hangOnCancel?: boolean;
  readonly caps?: Partial<ProviderCapabilities>;
}

const fake = (o: FakeOpts = {}): ExceptionFlowProvider => {
  let calls = 0;
  return {
    languages: ["java"],
    capabilities: {
      intraprocedural: true,
      interprocedural: true,
      typeHierarchy: true,
      simulate: true,
      precision: "definite",
      engine: "fake",
      ...o.caps,
    },
    resolveThrowSite: async () =>
      "throwSite" in o
        ? o.throwSite
        : ({
            exceptionType: { id: "java.io.IOException", label: "IOException" },
          } as ThrowSite),
    suggestExceptionTypes: async () => [],
    analyzeExceptionFlow: async (_req, _progress, token) => {
      if (o.hangOnCancel && token.isCancellationRequested) {
        return new Promise<FlowResult>(() => undefined); // never settles
      }
      calls += 1;
      const base = o.sinks ?? [sink("caught", 5)];
      return resultOf(o.unstable && calls > 1 ? [sink("caught", 99)] : base);
    },
  } as unknown as ExceptionFlowProvider;
};

const caseOf = (text: string): ConformanceCase => ({
  name: "T.java",
  document: doc(text),
});

const FIXTURE = [
  "throw x;   // @throws java.io.IOException",
  "} catch { // @caught definite",
].join("\n");

// ---------------------------------------------------------------------------

describe("runConformance", () => {
  it("passes when the provider reports the annotated handler", async () => {
    const report = await runConformance(fake({ sinks: [sink("caught", 1)] }), [
      caseOf(FIXTURE),
    ]);
    expect(report).toEqual({ total: 1, passed: 1, failures: [] });
  });

  it("counts one entry per @throws site, not per file", async () => {
    const text = [
      "a // @throws java.io.IOException",
      "b // @throws java.io.IOException",
      "c // @caught",
    ].join("\n");
    const report = await runConformance(
      fake({ sinks: [sink("caught", 2)] }),
      [caseOf(text)],
      {
        skip: ["stability", "cancellation"],
      },
    );
    expect(report.total).toBe(2);
  });

  it("fails a fixture with no @throws annotation", async () => {
    const report = await runConformance(fake(), [caseOf("x // @caught")]);
    expect(report.failures.join()).toMatch(/no @throws annotation/);
  });

  it("fails when the provider finds no throw at an annotated site", async () => {
    const report = await runConformance(fake({ throwSite: undefined }), [
      caseOf(FIXTURE),
    ]);
    expect(report.passed).toBe(0);
    expect(report.failures.join()).toMatch(/resolveThrowSite returned nothing/);
  });

  it("fails when the resolved exception type differs from the annotation", async () => {
    const provider = fake({
      throwSite: {
        exceptionType: { id: "java.lang.RuntimeException", label: "RE" },
      } as ThrowSite,
      sinks: [sink("caught", 1)],
    });
    const report = await runConformance(provider, [caseOf(FIXTURE)]);
    expect(report.failures.join()).toMatch(
      /expected thrown type 'java.io.IOException'/,
    );
  });

  it("fails when an expected handler is not reported", async () => {
    const report = await runConformance(fake({ sinks: [sink("caught", 42)] }), [
      caseOf(FIXTURE),
    ]);
    expect(report.failures.join()).toMatch(/expected caught at line 2/);
  });

  it("respects the confidence in the annotation", async () => {
    const report = await runConformance(
      fake({ sinks: [sink("caught", 1, "possible")] }),
      [caseOf(FIXTURE)],
    );
    expect(report.failures.join()).toMatch(
      /expected caught at line 2 \(definite\)/,
    );
  });

  // @escapes describes an intermediate step, which by contract is never a
  // terminal — so matching must consider every reported sink.
  it("matches an @escapes expectation against an intermediate step", async () => {
    const text = [
      "throw x; // @throws java.io.IOException",
      "void m()  // @escapes",
    ].join("\n");
    const provider = fake({
      sinks: [sink("escapes-function", 1), sink("uncaught", 9)],
    });
    const report = await runConformance(provider, [caseOf(text)], {
      skip: ["stability", "cancellation"],
    });
    expect(report.failures).toEqual([]);
  });

  it("ignores unpredicted sinks by default but flags them in strict mode", async () => {
    const provider = fake({ sinks: [sink("caught", 1), sink("caught", 7)] });
    const lenient = await runConformance(provider, [caseOf(FIXTURE)]);
    expect(lenient.failures).toEqual([]);

    const strict = await runConformance(provider, [caseOf(FIXTURE)], {
      strict: true,
    });
    expect(strict.failures.join()).toMatch(/unexpected caught sink at line 8/);
  });

  it("surfaces checkInvariants violations", async () => {
    const provider = fake({
      caps: { typeHierarchy: false, precision: "possible" },
      sinks: [sink("caught", 1, "definite")],
    });
    const report = await runConformance(provider, [caseOf(FIXTURE)]);
    expect(report.failures.join()).toMatch(/typeHierarchy/);
  });

  it("detects a provider whose results are not reproducible", async () => {
    const report = await runConformance(
      fake({ sinks: [sink("caught", 1)], unstable: true }),
      [caseOf(FIXTURE)],
    );
    expect(report.failures.join()).toMatch(/repeated identical requests/);
  });

  it("can skip the stability check for providers that opt out", async () => {
    const report = await runConformance(
      fake({ sinks: [sink("caught", 1)], unstable: true }),
      [caseOf(FIXTURE)],
      { skip: ["stability", "cancellation"] },
    );
    expect(report.failures).toEqual([]);
  });

  it("detects a provider that ignores an already-cancelled token", async () => {
    const report = await runConformance(
      fake({ sinks: [sink("caught", 1)], hangOnCancel: true }),
      [caseOf(FIXTURE)],
      { cancellationBudgetMs: 25 },
    );
    expect(report.failures.join()).toMatch(/did not settle within 25ms/);
  });

  it("invokes the fail callback once with every failure", async () => {
    let reported: string | undefined;
    await runConformance(
      fake({ sinks: [sink("caught", 42)] }),
      [caseOf(FIXTURE)],
      {
        fail: (m) => {
          reported = m;
        },
      },
    );
    expect(reported).toMatch(/expected caught at line 2/);
  });

  it("does not invoke the fail callback when everything passes", async () => {
    let called = false;
    await runConformance(
      fake({ sinks: [sink("caught", 1)] }),
      [caseOf(FIXTURE)],
      {
        fail: () => {
          called = true;
        },
      },
    );
    expect(called).toBe(false);
  });
});
