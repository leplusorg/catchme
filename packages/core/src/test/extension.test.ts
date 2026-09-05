import * as assert from "node:assert";
import * as vscode from "vscode";
import type {
  CatchMeApi,
  ExceptionFlowProvider,
  FlowRequest,
  FlowResult,
} from "@leplusorg/catchme-api";

const EXTENSION_ID = "leplusorg.catchme";

const COMMANDS = [
  "catchme.findCatchers",
  "catchme.simulateThrow",
  "catchme.rerun",
  "catchme.clear",
];

suite("CatchMe extension", () => {
  let api: CatchMeApi;

  suiteSetup(async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension<CatchMeApi>(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} was not found in the host`);
    api = await ext.activate();
  });

  test("activates and exports a versioned API", () => {
    assert.strictEqual(api.version, 1);
    assert.strictEqual(typeof api.registerProvider, "function");
    assert.strictEqual(typeof api.analyze, "function");
  });

  test("registers every contributed command", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of COMMANDS) {
      assert.ok(all.includes(id), `command not registered: ${id}`);
    }
  });

  test("clear command runs without throwing", async () => {
    await vscode.commands.executeCommand("catchme.clear");
  });

  // The whole point of the architecture: a provider registered from outside
  // must be selected and driven by the core with no core changes.
  test("routes analyze() to a third-party provider", async () => {
    const document = await vscode.workspace.openTextDocument({
      content: "throw new Boom();\n",
      language: "plaintext",
    });

    let received: FlowRequest | undefined;
    const fake: ExceptionFlowProvider = {
      languages: ["plaintext"],
      capabilities: {
        intraprocedural: true,
        interprocedural: true,
        typeHierarchy: true,
        simulate: true,
        precision: "definite",
        engine: "integration-fake",
      },
      resolveThrowSite: () => undefined,
      suggestExceptionTypes: () => [],
      analyzeExceptionFlow: async (request): Promise<FlowResult> => {
        received = request;
        return {
          throwSite: request.throwSite,
          paths: [],
          terminals: [],
          partial: false,
          diagnostics: ["from the fake provider"],
        };
      },
    };

    const registration = api.registerProvider(fake);
    try {
      const result = await api.analyze({
        throwSite: {
          uri: document.uri,
          range: new vscode.Range(0, 0, 0, 17),
          exceptionType: { id: "Boom", label: "Boom" },
          simulated: true,
        },
        options: {
          maxDepth: 4,
          precision: "possible",
          includeLibraryCode: false,
          timeoutMs: 5_000,
        },
      });

      assert.ok(received, "the registered provider was never invoked");
      assert.strictEqual(received.throwSite.exceptionType.id, "Boom");
      assert.deepStrictEqual(result.diagnostics, ["from the fake provider"]);
    } finally {
      registration.dispose();
    }
  });

  // Registry contract: disposing must actually remove the provider, otherwise
  // a disabled extension would keep serving results.
  test("disposing a registration unregisters the provider", async () => {
    const document = await vscode.workspace.openTextDocument({
      content: "x\n",
      language: "plaintext",
    });

    let calls = 0;
    const fake = {
      languages: ["plaintext"],
      capabilities: {
        intraprocedural: true,
        interprocedural: true,
        typeHierarchy: true,
        simulate: true,
        precision: "definite",
        engine: "integration-fake-2",
      },
      resolveThrowSite: () => undefined,
      suggestExceptionTypes: () => [],
      analyzeExceptionFlow: async (
        request: FlowRequest,
      ): Promise<FlowResult> => {
        calls += 1;
        return {
          throwSite: request.throwSite,
          paths: [],
          terminals: [],
          partial: false,
        };
      },
    } as unknown as ExceptionFlowProvider;

    const request: FlowRequest = {
      throwSite: {
        uri: document.uri,
        range: new vscode.Range(0, 0, 0, 1),
        exceptionType: { id: "Boom", label: "Boom" },
        simulated: true,
      },
      options: {
        maxDepth: 1,
        precision: "possible",
        includeLibraryCode: false,
        timeoutMs: 5_000,
      },
    };

    const registration = api.registerProvider(fake);
    await api.analyze(request);
    assert.strictEqual(calls, 1);

    registration.dispose();
    const after = await api.analyze(request);
    assert.strictEqual(calls, 1, "provider was still invoked after disposal");
    assert.ok(
      (after.diagnostics ?? []).some((d) =>
        d.includes("No exception-flow provider"),
      ),
      'expected a "no provider" diagnostic once unregistered',
    );
  });
});
