import { describe, expect, it } from "vitest";
import {
  findEnclosingFunction,
  findEnclosingTryBlocks,
  findThrowAt,
  handlerMatches,
  matchBrace,
  simpleName,
  stripNonCode,
  typeNamesFrom,
} from "./syntax";

const at = (text: string, needle: string) => text.indexOf(needle);

describe("stripNonCode", () => {
  it("preserves length so every offset still maps to the original", () => {
    const src = 'a // comment\nb /* block */ c "str" d';
    expect(stripNonCode(src)).toHaveLength(src.length);
  });

  it("keeps newlines so line numbers survive", () => {
    const out = stripNonCode("/* one\ntwo */x");
    expect(out.split("\n")).toHaveLength(2);
    expect(out.endsWith("x")).toBe(true);
  });

  it("blanks line comments, block comments and string literals", () => {
    const out = stripNonCode('x // catch\ny /* catch */ z "catch" w');
    expect(out).not.toContain("catch");
    expect(out).toContain("x");
    expect(out).toContain("w");
  });

  // The whole reason this pass exists: text must not create phantom handlers.
  it("hides a catch that only appears inside a string", () => {
    const src = 'var s = "try { } catch (E e) { }";';
    expect(findEnclosingTryBlocks(stripNonCode(src), 20)).toEqual([]);
  });

  it("does not let an escaped quote end a literal early", () => {
    const out = stripNonCode('"a\\"catch" + real');
    expect(out).not.toContain("catch");
    expect(out).toContain("real");
  });

  it("does not let an unterminated quote swallow the rest of the file", () => {
    const out = stripNonCode('"oops\ncatch (E e) {}');
    expect(out).toContain("catch");
  });
});

describe("matchBrace", () => {
  it("matches across nesting", () => {
    const s = "{ a { b } c }";
    expect(matchBrace(s, 0)).toBe(s.length - 1);
  });

  it("returns -1 when unbalanced", () => {
    expect(matchBrace("{ a { b }", 0)).toBe(-1);
  });
});

describe("typeNamesFrom", () => {
  it("drops the parameter name", () => {
    expect(typeNamesFrom("IOException e")).toEqual(["IOException"]);
  });

  it("expands multi-catch", () => {
    expect(typeNamesFrom("IllegalStateException | IOException e")).toEqual([
      "IllegalStateException",
      "IOException",
    ]);
  });

  // `catch (e)` in JS names a binding, not a type.
  it("treats a lone token as an untyped binding", () => {
    expect(typeNamesFrom("e")).toEqual([]);
  });

  it("handles a bare catch", () => {
    expect(typeNamesFrom("")).toEqual([]);
  });

  it("keeps qualified names", () => {
    expect(typeNamesFrom("java.io.IOException e")).toEqual([
      "java.io.IOException",
    ]);
  });
});

describe("findEnclosingTryBlocks", () => {
  const src = [
    "void m() {",
    "  try {",
    "    BOOM;",
    "  } catch (IOException e) {",
    "    INCATCH;",
    "  }",
    "}",
  ].join("\n");

  it("finds the try whose body contains the offset", () => {
    const blocks = findEnclosingTryBlocks(src, at(src, "BOOM"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.catches[0]!.typeNames).toEqual(["IOException"]);
  });

  // The rule a naive scanner gets wrong: a throw inside a catch is NOT handled
  // by that same try.
  it("excludes an offset inside the catch clause", () => {
    expect(findEnclosingTryBlocks(src, at(src, "INCATCH"))).toEqual([]);
  });

  it("returns nested blocks innermost first", () => {
    const nested = [
      "try {",
      "  try {",
      "    BOOM;",
      "  } catch (Inner e) {}",
      "} catch (Outer e) {}",
    ].join("\n");
    const blocks = findEnclosingTryBlocks(nested, at(nested, "BOOM"));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.catches[0]!.typeNames).toEqual(["Inner"]);
    expect(blocks[1]!.catches[0]!.typeNames).toEqual(["Outer"]);
  });

  it("collects several catch clauses in order", () => {
    const many = "try { BOOM; } catch (A a) {} catch (B b) {}";
    const blocks = findEnclosingTryBlocks(many, at(many, "BOOM"));
    expect(blocks[0]!.catches.map((c) => c.typeNames[0])).toEqual(["A", "B"]);
  });

  it("skips a finally block and keeps parsing", () => {
    const withFinally = "try { BOOM; } finally { }";
    const blocks = findEnclosingTryBlocks(withFinally, at(withFinally, "BOOM"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.catches).toEqual([]);
  });

  it("handles try-with-resources headers", () => {
    const twr = "try (var r = open()) { BOOM; } catch (IOException e) {}";
    const blocks = findEnclosingTryBlocks(twr, at(twr, "BOOM"));
    expect(blocks[0]!.catches[0]!.typeNames).toEqual(["IOException"]);
  });

  it("returns nothing when the offset is outside any try", () => {
    expect(findEnclosingTryBlocks("void m() { BOOM; }", 12)).toEqual([]);
  });
});

describe("findThrowAt", () => {
  it("reads the type from a constructor call", () => {
    const s = 'throw new IOException("x");';
    expect(findThrowAt(s, 2)?.typeName).toBe("IOException");
  });

  it("reads a rethrown variable-free raise", () => {
    const s = "raise ValueError";
    expect(findThrowAt(s, 2)?.typeName).toBe("ValueError");
  });

  it("returns undefined away from any throw", () => {
    expect(findThrowAt("int x = 1;", 4)).toBeUndefined();
  });

  it("bounds the statement at a newline when there is no semicolon", () => {
    const s = "throw new E\nunrelated";
    expect(findThrowAt(s, at(s, "unrelated"))).toBeUndefined();
  });
});

describe("handlerMatches", () => {
  it("matches an exact simple name", () => {
    expect(handlerMatches("IOException", "IOException")).toBe(true);
  });

  it("compares simple names across qualification", () => {
    expect(handlerMatches("java.io.IOException", "IOException")).toBe(true);
  });

  // Without a type hierarchy this is a heuristic, but omitting it would hide
  // the single most common real handler.
  it("treats well-known roots as catch-alls", () => {
    expect(handlerMatches("IOException", "Exception")).toBe(true);
    expect(handlerMatches("IOException", "Throwable")).toBe(true);
  });

  it("does not match unrelated names", () => {
    expect(handlerMatches("IOException", "SQLException")).toBe(false);
  });

  it("treats an untyped catch as matching anything", () => {
    expect(handlerMatches("IOException", "")).toBe(true);
  });
});

describe("findEnclosingFunction", () => {
  it("finds the innermost signature-like block", () => {
    const src = "class C {\n  void m() {\n    BOOM;\n  }\n}";
    const fn = findEnclosingFunction(src, at(src, "BOOM"));
    expect(fn).toBeDefined();
    expect(src.slice(fn!.start, fn!.end)).toContain("BOOM");
    expect(src.slice(0, fn!.start)).toContain("void m()");
  });

  it("returns undefined at top level", () => {
    expect(findEnclosingFunction("int x = 1;", 4)).toBeUndefined();
  });
});

describe("simpleName", () => {
  it("strips package qualification", () => {
    expect(simpleName("java.io.IOException")).toBe("IOException");
    expect(simpleName("IOException")).toBe("IOException");
  });
});
