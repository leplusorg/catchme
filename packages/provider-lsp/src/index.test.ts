import { beforeEach, describe, expect, it } from "vitest";
import type { FlowRequest, ThrowSite } from "@leplusorg/catchme-api";
import {
  Location,
  Position,
  Range,
  Uri,
  __reset,
  __stub,
  makeDocument,
} from "../test/vscode-stub";
import { GenericLspProvider } from "./index";

const noToken = { isCancellationRequested: false } as never;
const progress = { report: () => undefined };
const URI = "file:///T.java";

/** Register a document with the stub workspace and return it. */
const given = (text: string, uri = URI) => {
  const doc = makeDocument(text, uri);
  __stub.documents.set(uri, doc);
  return doc as never;
};

const offsetToPosition = (text: string, needle: string) => {
  const offset = text.indexOf(needle);
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return new Position(line, offset - (before.lastIndexOf("\n") + 1));
};

const requestAt = (
  text: string,
  needle: string,
  typeId: string,
): FlowRequest => {
  const p = offsetToPosition(text, needle);
  return {
    throwSite: {
      uri: Uri.parse(URI),
      range: new Range(p, p),
      exceptionType: { id: typeId, label: typeId },
      simulated: false,
    } as unknown as ThrowSite,
    options: {
      maxDepth: 8,
      precision: "possible",
      includeLibraryCode: false,
      timeoutMs: 15_000,
    },
  };
};

const CAUGHT = [
  "void m() {",
  "  try {",
  "    throw new IOException();",
  "  } catch (IOException e) {",
  "  }",
  "}",
].join("\n");

const ESCAPES = ["void m() {", "  throw new IOException();", "}"].join("\n");

beforeEach(__reset);

describe("capabilities", () => {
  const caps = new GenericLspProvider().capabilities;

  it("supports the mandatory intraprocedural baseline", () => {
    expect(caps.intraprocedural).toBe(true);
  });

  it("delegates the interprocedural walk to the core", () => {
    expect(caps.interprocedural).toBe(false);
    expect(typeof new GenericLspProvider().resolveAtCallSite).toBe("function");
  });

  it("claims no type hierarchy and therefore only approximate precision", () => {
    expect(caps.typeHierarchy).toBe(false);
    expect(caps.precision).toBe("possible");
  });

  it("serves brace-style languages by default and accepts an override", () => {
    expect(new GenericLspProvider().languages).toContain("typescript");
    expect(new GenericLspProvider(["ruby"]).languages).toEqual(["ruby"]);
  });
});

describe("resolveThrowSite", () => {
  it("finds a throw and reports its type with real Uri/Range instances", async () => {
    const doc = given(CAUGHT);
    const site = await new GenericLspProvider().resolveThrowSite(
      doc,
      offsetToPosition(CAUGHT, "throw") as never,
      noToken,
    );
    expect(site!.exceptionType.id).toBe("IOException");
    expect(site!.range).toBeInstanceOf(Range);
    expect(site!.uri).toBeInstanceOf(Uri);
    expect(site!.simulated).toBe(false);
  });

  it("returns undefined away from any throw", async () => {
    const doc = given(CAUGHT);
    const site = await new GenericLspProvider().resolveThrowSite(
      doc,
      offsetToPosition(CAUGHT, "void") as never,
      noToken,
    );
    expect(site).toBeUndefined();
  });

  // A throw that only appears in a comment must not be reported.
  it("ignores a throw inside a comment", async () => {
    const text = "void m() {\n  // throw new IOException();\n}";
    const doc = given(text);
    const site = await new GenericLspProvider().resolveThrowSite(
      doc,
      offsetToPosition(text, "throw") as never,
      noToken,
    );
    expect(site).toBeUndefined();
  });
});

describe("suggestExceptionTypes", () => {
  it("harvests names from both throws and catch clauses", async () => {
    const doc = given("throw new AlphaError(); try {} catch (BetaError e) {}");
    const types = await new GenericLspProvider().suggestExceptionTypes(
      doc,
      new Position(0, 0) as never,
      noToken,
    );
    expect(types.map((t) => t.id).sort()).toEqual(["AlphaError", "BetaError"]);
  });

  it("deduplicates repeated names", async () => {
    const doc = given("throw new E(); throw new E();");
    const types = await new GenericLspProvider().suggestExceptionTypes(
      doc,
      new Position(0, 0) as never,
      noToken,
    );
    expect(types).toHaveLength(1);
  });
});

describe("analyzeExceptionFlow", () => {
  it("reports the enclosing handler as a terminal sink", async () => {
    given(CAUGHT);
    const res = await new GenericLspProvider().analyzeExceptionFlow(
      requestAt(CAUGHT, "throw", "IOException"),
      progress,
      noToken,
    );
    expect(res.terminals).toHaveLength(1);
    expect(res.terminals[0]!.kind).toBe("caught");
    expect(res.terminals[0]!.location).toBeInstanceOf(Location);
  });

  // Structurally enforced: this provider has no type information.
  it("never claims definite confidence", async () => {
    given(CAUGHT);
    const res = await new GenericLspProvider().analyzeExceptionFlow(
      requestAt(CAUGHT, "throw", "IOException"),
      progress,
      noToken,
    );
    expect(res.terminals[0]!.confidence).toBe("possible");
  });

  it("treats a well-known root as a catch-all", async () => {
    const text = CAUGHT.replace("catch (IOException e)", "catch (Exception e)");
    given(text);
    const res = await new GenericLspProvider().analyzeExceptionFlow(
      requestAt(text, "throw", "IOException"),
      progress,
      noToken,
    );
    expect(res.terminals[0]!.kind).toBe("caught");
  });

  it("does not match an unrelated handler", async () => {
    const text = CAUGHT.replace(
      "catch (IOException e)",
      "catch (SQLException e)",
    );
    given(text);
    const res = await new GenericLspProvider().analyzeExceptionFlow(
      requestAt(text, "throw", "IOException"),
      progress,
      noToken,
    );
    expect(res.paths[0]!.steps[0]!.kind).toBe("escapes-function");
  });

  // The hand-off contract: escapes-function is not an answer, so it must not
  // be reported as a terminal — the core expands it via Call Hierarchy.
  it("emits escapes-function as a path step but not as a terminal", async () => {
    given(ESCAPES);
    const res = await new GenericLspProvider().analyzeExceptionFlow(
      requestAt(ESCAPES, "throw", "IOException"),
      progress,
      noToken,
    );
    expect(res.paths[0]!.steps[0]!.kind).toBe("escapes-function");
    expect(res.terminals).toEqual([]);
  });

  it("does not let a try handle a throw inside its own catch clause", async () => {
    const text = [
      "void m() {",
      "  try {",
      "    a();",
      "  } catch (IOException e) {",
      "    throw new IOException();",
      "  }",
      "}",
    ].join("\n");
    given(text);
    const res = await new GenericLspProvider().analyzeExceptionFlow(
      requestAt(text, "throw new", "IOException"),
      progress,
      noToken,
    );
    expect(res.paths[0]!.steps[0]!.kind).toBe("escapes-function");
  });
});

describe("resolveAtCallSite", () => {
  it("resolves a handler around a call site in the caller", async () => {
    const caller = [
      "void caller() {",
      "  try {",
      "    callee();",
      "  } catch (IOException e) {",
      "  }",
      "}",
    ].join("\n");
    given(caller);
    const p = offsetToPosition(caller, "callee");
    const sinks = await new GenericLspProvider().resolveAtCallSite(
      new Location(Uri.parse(URI), new Range(p, p)) as never,
      { id: "IOException", label: "IOException" },
      noToken,
    );
    expect(sinks).toHaveLength(1);
    expect(sinks[0]!.kind).toBe("caught");
  });
});
