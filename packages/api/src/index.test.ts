import { describe, expect, it } from "vitest";
import { DEFAULT_ANALYSIS_OPTIONS, ProviderNotReadyError } from "./index";

describe("DEFAULT_ANALYSIS_OPTIONS", () => {
  it("defaults to a bounded, approximate, workspace-only search", () => {
    expect(DEFAULT_ANALYSIS_OPTIONS).toEqual({
      maxDepth: 8,
      precision: "possible",
      includeLibraryCode: false,
      timeoutMs: 15_000,
    });
  });

  // A cyclic call graph is normal in real code; without both bounds the
  // interprocedural walk would never terminate.
  it("bounds the search in both depth and time", () => {
    expect(DEFAULT_ANALYSIS_OPTIONS.maxDepth).toBeGreaterThan(0);
    expect(DEFAULT_ANALYSIS_OPTIONS.timeoutMs).toBeGreaterThan(0);
  });

  // Defaulting to 'definite' would hide every result from providers that
  // cannot prove subtype relationships — i.e. most of them.
  it("defaults to 'possible' so approximate providers still show results", () => {
    expect(DEFAULT_ANALYSIS_OPTIONS.precision).toBe("possible");
  });
});

describe("ProviderNotReadyError", () => {
  it("is a real Error subclass with a discoverable name", () => {
    const err = new ProviderNotReadyError("server starting");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProviderNotReadyError);
    expect(err.name).toBe("ProviderNotReadyError");
    expect(err.message).toBe("server starting");
  });

  it("carries an optional hint for the retry affordance", () => {
    const err = new ProviderNotReadyError(
      "not ready",
      "Install the Java extension.",
    );
    expect(err.hint).toBe("Install the Java extension.");
  });

  it("leaves the hint undefined when omitted", () => {
    expect(new ProviderNotReadyError("nope").hint).toBeUndefined();
  });

  // The core distinguishes this from a generic failure via `instanceof` to
  // decide between "offer Retry" and "show an error".
  it("is distinguishable from a plain Error", () => {
    expect(new Error("boom")).not.toBeInstanceOf(ProviderNotReadyError);
  });
});
