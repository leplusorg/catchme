import { beforeEach, describe, expect, it } from "vitest";
import { ProviderNotReadyError } from "@leplusorg/catchme-api";
import {
  Location,
  Range,
  Uri,
  __reset,
  __stub,
  type StubExtension,
} from "../test/vscode-stub";
import { JavaProvider } from "./index";

const noToken = { isCancellationRequested: false } as never;
const doc = { uri: { toString: () => "file:///T.java" } } as never;
const pos = { line: 41, character: 8 } as never;

const readyExtension = (over: Record<string, unknown> = {}): StubExtension => ({
  id: "redhat.java",
  isActive: true,
  exports: {
    serverReady: async () => undefined,
    serverMode: "Standard",
    ...over,
  },
  activate: async () => undefined,
});

const rawRange = (line: number) => ({
  start: { line, character: 4 },
  end: { line, character: 20 },
});

const rawSink = (kind: string, line: number) => ({
  kind,
  location: { uri: "file:///Svc.java", range: rawRange(line) },
  label: `${kind} here`,
  confidence: "definite",
});

const requestFor = (): never =>
  ({
    throwSite: {
      uri: { toString: () => "file:///T.java" },
      range: new Range(4, 2, 4, 30),
      exceptionType: { label: "IOException", id: "java.io.IOException" },
      simulated: false,
    },
    options: {
      maxDepth: 3,
      precision: "definite",
      includeLibraryCode: true,
      timeoutMs: 99,
    },
  }) as never;

beforeEach(__reset);

describe("JavaProvider capabilities", () => {
  const caps = new JavaProvider().capabilities;

  it("serves Java only", () => {
    expect(new JavaProvider().languages).toEqual(["java"]);
  });

  // JDT resolves real bindings, so unlike the generic provider this one may
  // legitimately claim certainty and own its caller-walk.
  it("claims a type hierarchy, its own caller-walk, and definite precision", () => {
    expect(caps.typeHierarchy).toBe(true);
    expect(caps.interprocedural).toBe(true);
    expect(caps.precision).toBe("definite");
  });

  it("supports simulated throws", () => {
    expect(caps.simulate).toBe(true);
  });
});

describe("JavaProvider readiness guard", () => {
  it("reports not-ready with an install hint when redhat.java is absent", async () => {
    __stub.extension = undefined;
    const p = new JavaProvider();
    await expect(p.resolveThrowSite(doc, pos, noToken)).rejects.toBeInstanceOf(
      ProviderNotReadyError,
    );
    await p
      .resolveThrowSite(doc, pos, noToken)
      .catch((e: ProviderNotReadyError) => {
        expect(e.hint).toMatch(/install/i);
      });
  });

  // LightWeight mode has no resolved bindings. Running anyway would produce
  // confidently wrong answers, which is worse than refusing.
  it("refuses to run while the server is in LightWeight mode", async () => {
    __stub.extension = readyExtension({ serverMode: "LightWeight" });
    const p = new JavaProvider();
    await expect(p.resolveThrowSite(doc, pos, noToken)).rejects.toBeInstanceOf(
      ProviderNotReadyError,
    );
    await p
      .resolveThrowSite(doc, pos, noToken)
      .catch((e: ProviderNotReadyError) => {
        expect(e.message).toMatch(/lightweight/i);
      });
  });

  it("waits for serverReady() before issuing a command", async () => {
    let readyAwaited = false;
    __stub.extension = readyExtension({
      serverReady: async () => {
        readyAwaited = true;
      },
    });
    await new JavaProvider().resolveThrowSite(doc, pos, noToken);
    expect(readyAwaited).toBe(true);
    expect(__stub.calls).toHaveLength(1);
  });

  it("activates the Java extension if it is installed but not yet active", async () => {
    let activated = false;
    __stub.extension = {
      ...readyExtension(),
      isActive: false,
      activate: async () => {
        activated = true;
        return { serverReady: async () => undefined, serverMode: "Standard" };
      },
    };
    await new JavaProvider().resolveThrowSite(doc, pos, noToken);
    expect(activated).toBe(true);
  });
});

describe("JavaProvider command bridge", () => {
  beforeEach(() => {
    __stub.extension = readyExtension();
  });

  it("routes through the redhat.java workspace-command bridge", async () => {
    await new JavaProvider().resolveThrowSite(doc, pos, noToken);
    expect(__stub.calls[0]?.command).toBe("java.execute.workspaceCommand");
  });

  it("sends the throw-site payload the server expects", async () => {
    await new JavaProvider().resolveThrowSite(doc, pos, noToken);
    const [commandId, payload] = __stub.calls[0]!.args as [
      string,
      Record<string, unknown>,
    ];
    expect(commandId).toBe("catchme.java.resolveThrowSite");
    expect(payload).toEqual({
      uri: "file:///T.java",
      position: { line: 41, character: 8 },
    });
  });

  it("uses a distinct command id per operation", async () => {
    const p = new JavaProvider();
    await p.resolveThrowSite(doc, pos, noToken);
    await p.suggestExceptionTypes(doc, pos, noToken);
    const ids = __stub.calls.map((c) => (c.args as [string])[0]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("catchme.java.suggestExceptionTypes");
  });

  // vscode.Range is a class; the server only speaks JSON, so it must be
  // flattened explicitly rather than relying on incidental serialisation.
  it("flattens the range and forwards options and type id", async () => {
    await new JavaProvider().analyzeExceptionFlow(
      requestFor(),
      { report: () => undefined },
      noToken,
    );
    const [, payload] = __stub.calls[0]!.args as [
      string,
      Record<string, unknown>,
    ];
    expect(payload).toEqual({
      uri: "file:///T.java",
      range: {
        start: { line: 4, character: 2 },
        end: { line: 4, character: 30 },
      },
      exceptionTypeId: "java.io.IOException",
      simulated: false,
      options: {
        maxDepth: 3,
        precision: "definite",
        includeLibraryCode: true,
        timeoutMs: 99,
      },
    });
  });
});

describe("JavaProvider response mapping", () => {
  beforeEach(() => {
    __stub.extension = readyExtension();
  });

  it("turns a JSON throw site into real Uri and Range instances", async () => {
    __stub.result = {
      uri: "file:///T.java",
      range: rawRange(41),
      exceptionType: {
        id: "java.io.IOException",
        label: "IOException",
        kind: "checked",
      },
      simulated: false,
    };
    const site = await new JavaProvider().resolveThrowSite(doc, pos, noToken);
    expect(site!.uri).toBeInstanceOf(Uri);
    expect(site!.range).toBeInstanceOf(Range);
    expect(site!.range.start.line).toBe(41);
    expect(site!.exceptionType.id).toBe("java.io.IOException");
  });

  // null is meaningful: it hides the "Find Where This Is Caught" menu item.
  it("maps a null throw site to undefined rather than an empty object", async () => {
    __stub.result = null;
    await expect(
      new JavaProvider().resolveThrowSite(doc, pos, noToken),
    ).resolves.toBeUndefined();
  });

  it("turns every sink location into a real Location instance", async () => {
    __stub.result = {
      paths: [
        {
          steps: [rawSink("escapes-function", 3), rawSink("caught", 88)],
          depth: 1,
        },
      ],
      terminals: [rawSink("caught", 88)],
      partial: true,
    };
    const res = await new JavaProvider().analyzeExceptionFlow(
      requestFor(),
      { report: () => undefined },
      noToken,
    );
    expect(res.terminals[0]!.location).toBeInstanceOf(Location);
    expect(res.terminals[0]!.location.uri).toBeInstanceOf(Uri);
    expect(res.terminals[0]!.location.range.start.line).toBe(88);
    expect(res.paths[0]!.steps).toHaveLength(2);
    expect(res.paths[0]!.depth).toBe(1);
    expect(res.partial).toBe(true);
  });

  // The call site is what turns a list of outcomes into a navigable chain, so
  // it must survive the JSON boundary as a real Location.
  it("maps a call site into a real Location instance", async () => {
    __stub.result = {
      paths: [
        {
          steps: [
            {
              ...rawSink("escapes-function", 3),
              callSite: { uri: "file:///Caller.java", range: rawRange(71) },
            },
          ],
          depth: 1,
          truncated: true,
        },
      ],
      terminals: [],
    };
    const res = await new JavaProvider().analyzeExceptionFlow(
      requestFor(),
      { report: () => undefined },
      noToken,
    );
    const step = res.paths[0]!.steps[0]!;
    expect(step.callSite).toBeInstanceOf(Location);
    expect(step.callSite!.range.start.line).toBe(71);
    expect(step.callSite!.uri.toString()).toBe("file:///Caller.java");
  });

  it("omits callSite when the server does not send one", async () => {
    __stub.result = {
      paths: [{ steps: [rawSink("caught", 5)], depth: 0 }],
      terminals: [],
    };
    const res = await new JavaProvider().analyzeExceptionFlow(
      requestFor(),
      { report: () => undefined },
      noToken,
    );
    expect(res.paths[0]!.steps[0]).not.toHaveProperty("callSite");
  });

  it("carries the truncated flag through so the UI can offer to expand", async () => {
    __stub.result = {
      paths: [
        { steps: [rawSink("escapes-function", 3)], depth: 4, truncated: true },
        { steps: [rawSink("caught", 9)], depth: 0 },
      ],
      terminals: [],
    };
    const res = await new JavaProvider().analyzeExceptionFlow(
      requestFor(),
      { report: () => undefined },
      noToken,
    );
    expect(res.paths[0]!.truncated).toBe(true);
    expect(res.paths[1]).not.toHaveProperty("truncated");
  });

  it("preserves an optional reason but omits it when absent", async () => {
    __stub.result = {
      terminals: [
        { ...rawSink("caught", 1), reason: "supertype catch" },
        rawSink("caught", 2),
      ],
    };
    const res = await new JavaProvider().analyzeExceptionFlow(
      requestFor(),
      { report: () => undefined },
      noToken,
    );
    expect(res.terminals[0]!.reason).toBe("supertype catch");
    expect(res.terminals[1]).not.toHaveProperty("reason");
  });

  // The tree view cannot render without a throw site, so a server that omits
  // it must not produce an undefined field.
  it("falls back to the requested throw site when the server omits one", async () => {
    __stub.result = { terminals: [], paths: [] };
    const request = requestFor();
    const res = await new JavaProvider().analyzeExceptionFlow(
      request,
      { report: () => undefined },
      noToken,
    );
    expect(res.throwSite).toBe(
      (request as never as { throwSite: unknown }).throwSite,
    );
  });

  it("tolerates a sparse response without throwing", async () => {
    __stub.result = undefined;
    const res = await new JavaProvider().analyzeExceptionFlow(
      requestFor(),
      { report: () => undefined },
      noToken,
    );
    expect(res).toMatchObject({ paths: [], terminals: [], partial: false });
    expect(res).not.toHaveProperty("diagnostics");
  });

  it("passes server diagnostics through when present", async () => {
    __stub.result = {
      paths: [],
      terminals: [],
      diagnostics: ["classpath incomplete"],
    };
    const res = await new JavaProvider().analyzeExceptionFlow(
      requestFor(),
      { report: () => undefined },
      noToken,
    );
    expect(res.diagnostics).toEqual(["classpath incomplete"]);
  });

  it("returns an empty list when the server suggests no types", async () => {
    __stub.result = null;
    await expect(
      new JavaProvider().suggestExceptionTypes(doc, pos, noToken),
    ).resolves.toEqual([]);
  });
});
