import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import type {
  ExceptionFlowProvider,
  FlowResult,
  ProviderCapabilities,
  Sink,
} from "@leplusorg/catchme-api";
import { checkInvariants, parseFixture } from "./index";

// ---------------------------------------------------------------------------
// helpers — vscode types are type-only here, so plain objects suffice
// ---------------------------------------------------------------------------

const loc = (line = 0) =>
  ({
    uri: { toString: () => "file:///T.java" },
    range: { start: { line } },
  }) as unknown as vscode.Location;

const sink = (over: Partial<Sink> = {}): Sink => ({
  kind: "caught",
  location: loc(),
  label: "catch (IOException e)",
  confidence: "definite",
  ...over,
});

const provider = (
  caps: Partial<ProviderCapabilities> = {},
): ExceptionFlowProvider =>
  ({
    languages: ["java"],
    capabilities: {
      intraprocedural: true,
      interprocedural: true,
      typeHierarchy: true,
      simulate: true,
      precision: "definite",
      engine: "test",
      ...caps,
    },
  }) as unknown as ExceptionFlowProvider;

const result = (over: Partial<FlowResult> = {}): FlowResult =>
  ({
    throwSite: {} as never,
    paths: [{ steps: [sink()], depth: 0 }],
    terminals: [sink()],
    partial: false,
    ...over,
  }) as FlowResult;

// ---------------------------------------------------------------------------

describe("parseFixture", () => {
  it("separates throw sites from expectations", () => {
    const { throwSites, expectations } = parseFixture(
      [
        "throw new IOException();   // @throws java.io.IOException",
        "} catch (Exception e) {    // @caught definite",
      ].join("\n"),
    );
    expect(throwSites).toEqual([{ line: 0, typeId: "java.io.IOException" }]);
    expect(expectations).toEqual([
      { line: 1, kind: "caught", confidence: "definite" },
    ]);
  });

  // Regression: a positional capture group used to swallow the confidence
  // keyword as if it were a type id, so `@caught definite` silently parsed
  // with confidence undefined.
  it("reads the confidence keyword rather than mistaking it for a type id", () => {
    const { expectations } = parseFixture("x // @caught definite");
    expect(expectations[0]).toEqual({
      line: 0,
      kind: "caught",
      confidence: "definite",
    });
    expect(expectations[0]).not.toHaveProperty("typeId");
  });

  // Regression: `@throws` used to fall through to kind 'caught', asserting a
  // handler on the very line that throws.
  it("never emits an expectation for a throw site", () => {
    const { expectations } = parseFixture(
      "throw x; // @throws java.io.IOException",
    );
    expect(expectations).toEqual([]);
  });

  it("maps each keyword to its sink kind", () => {
    const { expectations } = parseFixture(
      ["a // @caught", "b // @escapes", "c // @uncaught", "d // @unknown"].join(
        "\n",
      ),
    );
    expect(expectations.map((e) => e.kind)).toEqual([
      "caught",
      "escapes-function",
      "uncaught",
      "unknown",
    ]);
  });

  it("accepts a type id and a confidence together, in either order", () => {
    const a = parseFixture("x // @caught java.io.IOException possible")
      .expectations[0];
    const b = parseFixture("x // @caught possible java.io.IOException")
      .expectations[0];
    expect(a).toEqual({
      line: 0,
      kind: "caught",
      confidence: "possible",
      typeId: "java.io.IOException",
    });
    expect(b).toEqual(a);
  });

  it("omits confidence and typeId when the annotation is bare", () => {
    expect(parseFixture("x // @escapes").expectations[0]).toEqual({
      line: 0,
      kind: "escapes-function",
    });
  });

  it("reports 0-based line numbers and ignores unannotated lines", () => {
    const { expectations } = parseFixture(
      ["", "", "x // @uncaught"].join("\n"),
    );
    expect(expectations).toEqual([{ line: 2, kind: "uncaught" }]);
  });

  it("handles CRLF line endings", () => {
    const { expectations } = parseFixture("a\r\nb // @caught\r\n");
    expect(expectations[0]?.line).toBe(1);
  });

  it("ignores unknown annotation keywords", () => {
    const parsed = parseFixture("x // @somethingelse foo");
    expect(parsed.throwSites).toEqual([]);
    expect(parsed.expectations).toEqual([]);
  });

  it("returns empty results for text with no annotations", () => {
    expect(parseFixture("int x = 1;\n")).toEqual({
      throwSites: [],
      expectations: [],
    });
  });
});

describe("checkInvariants", () => {
  it("passes a well-formed result", () => {
    expect(checkInvariants(provider(), result())).toEqual([]);
  });

  it("rejects a provider that does not support intraprocedural analysis", () => {
    const failures = checkInvariants(
      provider({ intraprocedural: false as unknown as true }),
      result(),
    );
    expect(failures.join()).toMatch(/intraprocedural/);
  });

  // The central honesty rule: no type information means no certainty.
  it("rejects 'definite' sinks from a provider without a type hierarchy", () => {
    const failures = checkInvariants(
      provider({ typeHierarchy: false }),
      result({ terminals: [sink({ confidence: "definite" })] }),
    );
    expect(failures.join()).toMatch(/typeHierarchy/);
  });

  it("allows 'possible' sinks from a provider without a type hierarchy", () => {
    const failures = checkInvariants(
      provider({ typeHierarchy: false }),
      result({
        paths: [{ steps: [sink({ confidence: "possible" })], depth: 0 }],
        terminals: [sink({ confidence: "possible" })],
      }),
    );
    expect(failures).toEqual([]);
  });

  it("rejects a path that ends in escapes-function", () => {
    const failures = checkInvariants(
      provider(),
      result({
        paths: [{ steps: [sink({ kind: "escapes-function" })], depth: 1 }],
      }),
    );
    expect(failures.join()).toMatch(/escapes-function/);
  });

  // A provider that delegates the caller-walk must end there; that sink is the
  // hand-off the core's engine expands.
  it("allows a non-interprocedural provider to end in escapes-function", () => {
    const failures = checkInvariants(
      provider({ interprocedural: false }),
      result({
        paths: [{ steps: [sink({ kind: "escapes-function" })], depth: 0 }],
      }),
    );
    expect(failures).toEqual([]);
  });

  it("accepts escapes-function as an intermediate step", () => {
    const failures = checkInvariants(
      provider(),
      result({
        paths: [
          {
            steps: [
              sink({ kind: "escapes-function" }),
              sink({ kind: "caught" }),
            ],
            depth: 1,
          },
        ],
      }),
    );
    expect(failures).toEqual([]);
  });

  it("rejects a path with no steps", () => {
    const failures = checkInvariants(
      provider(),
      result({ paths: [{ steps: [], depth: 0 }] }),
    );
    expect(failures.join()).toMatch(/no steps/);
  });

  it("rejects a negative depth", () => {
    const failures = checkInvariants(
      provider(),
      result({ paths: [{ steps: [sink()], depth: -1 }] }),
    );
    expect(failures.join()).toMatch(/depth/);
  });

  it("reports every violation, not just the first", () => {
    const failures = checkInvariants(
      provider({ typeHierarchy: false }),
      result({
        paths: [{ steps: [], depth: -1 }],
        terminals: [sink({ confidence: "definite" })],
      }),
    );
    expect(failures.length).toBeGreaterThan(1);
  });
});
