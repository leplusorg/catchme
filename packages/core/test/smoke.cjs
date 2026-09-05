"use strict";
/**
 * Headless smoke suite: loads the **real bundled extension** (`dist/extension.js`)
 * in plain Node against a mock host.
 *
 * This is not a substitute for the extension-host integration tests, but it does
 * exercise everything that does not need a window — activation, command
 * registration, the provider registry, the interprocedural engine's Call
 * Hierarchy walk, tree rendering, and the context keys that gate the menus.
 * It needs no dependencies and no display, so it runs anywhere.
 */
const assert = require("node:assert");
const Module = require("module");
const path = require("path");

const vscode = require(path.join(__dirname, "mock-vscode.cjs"));
const orig = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") return vscode;
  return orig.call(this, request, ...rest);
};

const ROOT = path.resolve(__dirname, "..");
const ext = require(path.join(ROOT, "dist/extension.js"));

const S = vscode.__state;
const subscriptions = [];
const context = {
  subscriptions,
  extensionPath: ROOT,
  globalState: { get() {}, update() {} },
  workspaceState: { get() {}, update() {} },
};

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log("  ok   " + name);
    pass++;
  } catch (e) {
    console.log("  FAIL " + name + " -> " + e.message);
    fail++;
  }
};
const acheck = async (name, fn) => {
  try {
    await fn();
    console.log("  ok   " + name);
    pass++;
  } catch (e) {
    console.log("  FAIL " + name + " -> " + e.message);
    fail++;
  }
};

const caps = (over) =>
  Object.assign(
    {
      intraprocedural: true,
      interprocedural: true,
      typeHierarchy: true,
      simulate: true,
      precision: "definite",
      engine: "smoke",
    },
    over,
  );

const sink = (kind, uri, line, confidence) => ({
  kind,
  location: new vscode.Location(uri, new vscode.Range(line, 0, line, 1)),
  label: kind + "@" + line,
  confidence: confidence || "definite",
});

const OPTIONS = {
  maxDepth: 4,
  precision: "possible",
  includeLibraryCode: false,
  timeoutMs: 5000,
};

(async () => {
  console.log("running the real bundled extension in plain Node\n");

  console.log("activation");
  const api = await ext.activate(context);
  check("activate() resolves and returns an API", () => assert.ok(api));
  check("API is version 1", () => assert.strictEqual(api.version, 1));
  check("API exposes registerProvider/analyze", () => {
    assert.strictEqual(typeof api.registerProvider, "function");
    assert.strictEqual(typeof api.analyze, "function");
  });
  check("all four commands registered", () => {
    for (const id of [
      "catchme.findCatchers",
      "catchme.simulateThrow",
      "catchme.rerun",
      "catchme.clear",
    ])
      assert.ok(S.commands.has(id), "missing " + id);
  });
  check("Exception Flow tree view created", () => {
    assert.ok(S.treeViews.some((v) => v.id === "catchme.flowView"));
  });
  check("built-in providers registered", () =>
    assert.ok(subscriptions.length >= 2),
  );
  check("clear command executes", () => S.commands.get("catchme.clear")());

  console.log("\nprovider registry");
  const uri = vscode.Uri.parse("untitled:smoke");
  vscode.__makeDocument("untitled:smoke", "throw new Boom();\n", "plaintext");

  let seen = null;
  const reg = api.registerProvider({
    languages: ["plaintext"],
    capabilities: caps(),
    resolveThrowSite: () => undefined,
    suggestExceptionTypes: () => [],
    analyzeExceptionFlow: async (req) => {
      seen = req;
      return {
        throwSite: req.throwSite,
        paths: [],
        terminals: [],
        partial: false,
        diagnostics: ["smoke"],
      };
    },
  });

  const request = {
    throwSite: {
      uri,
      range: new vscode.Range(0, 0, 0, 1),
      exceptionType: { id: "Boom", label: "Boom" },
      simulated: true,
    },
    options: OPTIONS,
  };
  const result = await api.analyze(request);
  check("analyze() reaches the registered provider", () => assert.ok(seen));
  check("analyze() returns the provider result", () =>
    assert.deepStrictEqual(result.diagnostics, ["smoke"]),
  );

  reg.dispose();
  const after = await api.analyze(request);
  check("disposal unregisters the provider", () =>
    assert.ok(
      (after.diagnostics || []).some((d) =>
        d.includes("No exception-flow provider"),
      ),
    ),
  );

  console.log("\ninterprocedural engine (LSP Call Hierarchy)");
  // callee.ts escapes -> caller.ts handles it.
  const calleeUri = vscode.Uri.parse("file:///callee.ts");
  const callerUri = vscode.Uri.parse("file:///caller.ts");
  vscode.__makeDocument(
    "file:///callee.ts",
    "throw new Boom();\n",
    "plaintext",
  );
  vscode.__makeDocument("file:///caller.ts", "callee();\n", "plaintext");
  S.incomingCalls.set("file:///callee.ts", [
    { fromUri: callerUri, range: new vscode.Range(0, 0, 0, 8) },
  ]);

  let callSiteHits = 0;
  const walker = api.registerProvider({
    languages: ["plaintext"],
    capabilities: caps({
      interprocedural: false,
      typeHierarchy: false,
      precision: "possible",
    }),
    resolveThrowSite: () => undefined,
    suggestExceptionTypes: () => [],
    analyzeExceptionFlow: async (req) => ({
      throwSite: req.throwSite,
      paths: [
        {
          steps: [sink("escapes-function", calleeUri, 0, "possible")],
          depth: 0,
        },
      ],
      terminals: [],
      partial: false,
    }),
    resolveAtCallSite: async () => {
      callSiteHits++;
      return [sink("caught", callerUri, 0, "possible")];
    },
  });

  const walked = await api.analyze({
    throwSite: {
      uri: calleeUri,
      range: new vscode.Range(0, 0, 0, 1),
      exceptionType: { id: "Boom", label: "Boom" },
      simulated: false,
    },
    options: OPTIONS,
  });

  check("engine follows incoming calls into the caller", () =>
    assert.ok(callSiteHits > 0, "resolveAtCallSite never called"),
  );
  check("engine produces a terminal after the walk", () => {
    assert.ok(walked.terminals.length > 0, "no terminal after expansion");
    assert.strictEqual(walked.terminals[0].kind, "caught");
  });
  check("expanded path records a non-zero hop depth", () =>
    assert.ok(
      walked.paths.some((p) => p.depth >= 1),
      "expected depth >= 1",
    ),
  );
  // Contract: a provider without a type hierarchy must never yield 'definite'.
  check("engine downgrades confidence for typeHierarchy:false", () =>
    assert.ok(walked.terminals.every((t) => t.confidence === "possible")),
  );
  walker.dispose();

  console.log("\nengine termination");
  const uncaughtUri = vscode.Uri.parse("file:///lonely.ts");
  vscode.__makeDocument(
    "file:///lonely.ts",
    "throw new Boom();\n",
    "plaintext",
  );
  const lonely = api.registerProvider({
    languages: ["plaintext"],
    capabilities: caps({ interprocedural: false }),
    resolveThrowSite: () => undefined,
    suggestExceptionTypes: () => [],
    analyzeExceptionFlow: async (req) => ({
      throwSite: req.throwSite,
      paths: [{ steps: [sink("escapes-function", uncaughtUri, 0)], depth: 0 }],
      terminals: [],
      partial: false,
    }),
    resolveAtCallSite: async () => [],
  });
  const noCallers = await api.analyze({
    throwSite: {
      uri: uncaughtUri,
      range: new vscode.Range(0, 0, 0, 1),
      exceptionType: { id: "Boom", label: "Boom" },
      simulated: false,
    },
    options: OPTIONS,
  });
  check("a function with no callers terminates as uncaught", () =>
    assert.ok(
      noCallers.terminals.some((t) => t.kind === "uncaught"),
      "expected an uncaught terminal",
    ),
  );
  lonely.dispose();

  console.log("\ntree rendering: call chain between origin and destination");
  const view = S.treeViews.find((v) => v.id === "catchme.flowView");
  const tree = view && view.treeDataProvider;
  check("tree data provider was supplied to the view", () => assert.ok(tree));

  // A workspace-backed document, so escaping frames are not folded as library.
  const APP = "file:///app/Main.java";
  const appUri = vscode.Uri.parse(APP);
  vscode.__makeDocument(APP, "throw new Boom();\n", "plaintext");

  const loc = (u, line) =>
    new vscode.Location(
      vscode.Uri.parse(u),
      new vscode.Range(line, 0, line, 1),
    );
  const hop = (fn, declLine, callUri, callLine, confidence) => ({
    kind: "escapes-function",
    location: loc(APP, declLine),
    label: `escapes method '${fn}'`,
    confidence: confidence || "definite",
    callSite: loc(callUri, callLine),
  });
  const handler = (line, confidence) => ({
    kind: "caught",
    location: loc(APP, line),
    label: "catch (Boom e)",
    confidence: confidence || "definite",
  });

  /** Register a provider returning `result`, run findCatchers, return roots. */
  const renderWith = async (paths, terminals, partial) => {
    const reg = api.registerProvider({
      languages: ["plaintext"],
      capabilities: caps(),
      resolveThrowSite: () => ({
        uri: appUri,
        range: new vscode.Range(0, 0, 0, 5),
        exceptionType: { id: "Boom", label: "Boom" },
        simulated: false,
      }),
      suggestExceptionTypes: () => [{ id: "Boom", label: "Boom" }],
      analyzeExceptionFlow: async (req) => ({
        throwSite: req.throwSite,
        paths,
        terminals,
        partial: partial === true,
      }),
    });
    await vscode.__setActiveEditor(S.documents.get(APP), 0);
    await S.commands.get("catchme.findCatchers")();
    reg.dispose();
    return tree.getChildren();
  };

  // Two chains converging on the same handler must read as ONE destination.
  const twoWays = [
    { steps: [hop("load", 10, APP, 71), handler(88)], depth: 1 },
    {
      steps: [hop("load", 10, APP, 55), hop("batch", 30, APP, 60), handler(88)],
      depth: 2,
    },
  ];

  await acheck(
    "groups converging chains under a single destination",
    async () => {
      const roots = await renderWith(twoWays, [handler(88)]);
      const dests = await tree.getChildren(roots[0]);
      assert.strictEqual(
        dests.length,
        1,
        "expected 1 destination, got " + dests.length,
      );
      const item = await tree.getTreeItem(dests[0]);
      assert.strictEqual(item.label, "catch (Boom e)");
      assert.ok(
        String(item.description).includes("Main.java:89"),
        "description=" + item.description,
      );
    },
  );

  await acheck(
    "a destination with several chains lists them as path nodes",
    async () => {
      const roots = await tree.getChildren();
      const dests = await tree.getChildren(roots[0]);
      const kids = await tree.getChildren(dests[0]);
      assert.strictEqual(kids.length, 2, "expected 2 path nodes");
      const item = await tree.getTreeItem(kids[1]);
      assert.ok(String(item.label).startsWith("via "), "label=" + item.label);
      assert.ok(
        String(item.label).includes("→"),
        "chain label should join frames with arrows",
      );
    },
  );

  await acheck("a single chain collapses the intermediate level", async () => {
    const roots = await renderWith([twoWays[0]], [handler(88)]);
    const dests = await tree.getChildren(roots[0]);
    const kids = await tree.getChildren(dests[0]);
    const first = await tree.getTreeItem(kids[0]);
    // Straight to the rows: the first is the origin, not a "via …" node.
    assert.ok(
      !String(first.label).startsWith("via "),
      "expected rows, got a path node",
    );
    assert.ok(String(first.label).includes("throw"), "label=" + first.label);
  });

  await acheck("the chain starts at the throw origin", async () => {
    const roots = await tree.getChildren();
    const dests = await tree.getChildren(roots[0]);
    const rows = await tree.getChildren(dests[0]);
    const origin = await tree.getTreeItem(rows[0]);
    assert.strictEqual(origin.iconPath.id, "flame");
    assert.ok(origin.command, "origin should be navigable");
  });

  // The point of the whole change: each hop shows where it was called from.
  await acheck("each hop shows its call site and jumps there", async () => {
    const roots = await tree.getChildren();
    const dests = await tree.getChildren(roots[0]);
    const rows = await tree.getChildren(dests[0]);
    const hopItem = await tree.getTreeItem(rows[1]);
    assert.ok(
      String(hopItem.description).includes("called at Main.java:72"),
      "description=" + hopItem.description,
    );
    assert.strictEqual(hopItem.command.command, "vscode.open");
    assert.strictEqual(
      hopItem.command.arguments[1].selection.start.line,
      71,
      "should jump to the call site",
    );
  });

  console.log("\nweakest-link confidence");
  await acheck("one shaky hop makes the whole chain possible", async () => {
    const shaky = {
      steps: [hop("load", 10, APP, 71, "possible"), handler(88)],
      depth: 1,
    };
    const roots = await renderWith([shaky], [handler(88)]);
    const dests = await tree.getChildren(roots[0]);
    const rows = await tree.getChildren(dests[0]);
    void rows;
    const item = await tree.getTreeItem(dests[0]);
    assert.ok(
      String(item.description).includes("possible"),
      "description=" + item.description,
    );
  });

  // Reachability is a question of *any* route.
  await acheck("a definite route keeps the destination definite", async () => {
    const mixed = [
      { steps: [hop("load", 10, APP, 71, "possible"), handler(88)], depth: 1 },
      { steps: [hop("load", 10, APP, 55), handler(88)], depth: 1 },
    ];
    const roots = await renderWith(mixed, [handler(88)]);
    const dests = await tree.getChildren(roots[0]);
    const item = await tree.getTreeItem(dests[0]);
    assert.ok(
      String(item.description).includes("definite"),
      "description=" + item.description,
    );
  });

  console.log("\ntruncation");
  await acheck(
    "a truncated chain gets its own unresolved destination",
    async () => {
      const cut = {
        steps: [hop("load", 10, APP, 71)],
        depth: 4,
        truncated: true,
      };
      const roots = await renderWith([cut], [], true);
      const dests = await tree.getChildren(roots[0]);
      const item = await tree.getTreeItem(dests[0]);
      assert.ok(
        String(item.label).includes("unresolved"),
        "label=" + item.label,
      );
    },
  );

  await acheck('it ends in an actionable "expand further" node', async () => {
    const roots = await tree.getChildren();
    const dests = await tree.getChildren(roots[0]);
    const rows = await tree.getChildren(dests[0]);
    const last = await tree.getTreeItem(rows[rows.length - 1]);
    assert.ok(
      String(last.label).includes("expand further"),
      "label=" + last.label,
    );
    assert.strictEqual(last.command.command, "catchme.expandPath");
    assert.strictEqual(
      last.command.arguments[0],
      4,
      "should pass the depth it stopped at",
    );
  });

  await acheck("expandPath re-runs with a deeper cap", async () => {
    let seenDepth = 0;
    const reg = api.registerProvider({
      languages: ["plaintext"],
      capabilities: caps(),
      resolveThrowSite: () => ({
        uri: appUri,
        range: new vscode.Range(0, 0, 0, 5),
        exceptionType: { id: "Boom", label: "Boom" },
        simulated: false,
      }),
      suggestExceptionTypes: () => [],
      analyzeExceptionFlow: async (req) => {
        seenDepth = req.options.maxDepth;
        return {
          throwSite: req.throwSite,
          paths: [],
          terminals: [],
          partial: false,
        };
      },
    });
    await S.commands.get("catchme.expandPath")(4);
    reg.dispose();
    assert.ok(seenDepth >= 8, "expected a deeper cap, got " + seenDepth);
  });

  console.log("\nlibrary folding and copy");
  await acheck("consecutive library frames fold into one node", async () => {
    const viaLib = {
      steps: [
        {
          ...hop("load", 10, APP, 71),
          location: loc("jar:///rt.jar!/L.java", 5),
        },
        {
          ...hop("exec", 11, APP, 72),
          location: loc("jar:///rt.jar!/L.java", 9),
        },
        handler(88),
      ],
      depth: 2,
    };
    const roots = await renderWith([viaLib], [handler(88)]);
    const dests = await tree.getChildren(roots[0]);
    const rows = await tree.getChildren(dests[0]);
    const folded = await Promise.all(rows.map((r) => tree.getTreeItem(r)));
    const lib = folded.find((i) => String(i.label).includes("library frame"));
    assert.ok(lib, "no folded node: " + folded.map((i) => i.label).join(" | "));
    assert.ok(
      String(lib.label).includes("2"),
      "should report the count: " + lib.label,
    );
  });

  await acheck(
    "copyPath writes a stack-trace rendering to the clipboard",
    async () => {
      const roots = await renderWith([twoWays[0]], [handler(88)]);
      const dests = await tree.getChildren(roots[0]);
      await S.commands.get("catchme.copyPath")(dests[0]);
      const text = await vscode.env.clipboard.readText();
      assert.ok(text.includes("Boom"), "missing exception: " + text);
      assert.ok(text.includes("thrown at"), "missing origin line");
      assert.ok(
        text.includes("called at Main.java:72"),
        "missing call site: " + text,
      );
    },
  );

  await acheck("clear empties the tree", async () => {
    S.commands.get("catchme.clear")();
    assert.deepStrictEqual(await tree.getChildren(), []);
  });

  console.log("\ncontext keys (menu visibility)");
  const keyReg = api.registerProvider({
    languages: ["plaintext"],
    capabilities: caps(),
    resolveThrowSite: () => ({
      uri: appUri,
      range: new vscode.Range(0, 0, 0, 5),
      exceptionType: { id: "Boom", label: "Boom" },
      simulated: false,
    }),
    suggestExceptionTypes: () => [],
    analyzeExceptionFlow: async (req) => ({
      throwSite: req.throwSite,
      paths: [],
      terminals: [],
      partial: false,
    }),
  });

  await acheck("supportedLanguage is set for a served language", async () => {
    await vscode.__setActiveEditor(S.documents.get(APP), 0);
    assert.strictEqual(S.contextKeys.get("catchme.supportedLanguage"), true);
  });
  await acheck("onThrowStatement becomes true on a throw site", async () => {
    await vscode.__setActiveEditor(S.documents.get(APP), 0);
    await new Promise((r) => setTimeout(r, 300)); // debounce
    assert.strictEqual(S.contextKeys.get("catchme.onThrowStatement"), true);
  });
  keyReg.dispose();

  await acheck(
    "supportedLanguage clears for an unserved language",
    async () => {
      vscode.__makeDocument("file:///x.rs", "fn main() {}", "rust");
      await vscode.__setActiveEditor(S.documents.get("file:///x.rs"), 0);
      assert.strictEqual(S.contextKeys.get("catchme.supportedLanguage"), false);
    },
  );

  console.log("\npeek hand-off");
  // We cannot render a Peek without a window, but we can prove our side of the
  // contract: the built-in is invoked with the argument types it documents.
  const peek = S.executed
    .filter((c) => c.id === "editor.action.showReferences")
    .pop();
  check("findCatchers hands off to editor.action.showReferences", () =>
    assert.ok(peek, "never invoked"),
  );
  check("peek receives (Uri, Position, Location[])", () => {
    const [uri2, pos2, locs] = peek.args;
    assert.ok(uri2 instanceof vscode.Uri, "arg0 is not a Uri");
    assert.ok(pos2 instanceof vscode.Position, "arg1 is not a Position");
    assert.ok(
      Array.isArray(locs) && locs.length > 0,
      "arg2 is not a non-empty array",
    );
    assert.ok(
      locs.every((l) => l instanceof vscode.Location),
      "arg2 contains non-Locations",
    );
  });

  console.log("\nmanifest wiring");
  const manifest = require(path.join(ROOT, "package.json"));
  const menus = manifest.contributes.menus || {};
  const declared = new Set(
    (manifest.contributes.commands || []).map((c) => c.command),
  );
  const menuCommands = Object.values(menus)
    .flat()
    .map((m) => m.command);

  check("every menu entry points at a declared command", () => {
    for (const id of menuCommands)
      assert.ok(declared.has(id), "menu references undeclared command " + id);
  });
  check("every declared command is registered at runtime", () => {
    for (const id of declared)
      assert.ok(S.commands.has(id), "declared but not registered: " + id);
  });
  // Closes the loop on menu visibility: the keys the manifest gates on are
  // exactly the keys the extension was observed setting above.
  check("every catchme.* when-clause key is one the extension sets", () => {
    const keys = new Set();
    for (const entry of Object.values(menus).flat()) {
      // Drop comparisons first: `view == catchme.flowView` names a view id on
      // the right-hand side, not a context key the extension sets.
      const bare = String(entry.when || "").replace(
        /[\w.]+\s*(==|!=)\s*[\w.]+/g,
        "",
      );
      for (const m of bare.matchAll(/catchme\.[A-Za-z]+/g)) keys.add(m[0]);
    }
    assert.ok(keys.size > 0, "no catchme context keys found in when clauses");
    for (const k of keys)
      assert.ok(
        S.contextKeys.has(k),
        "when-clause gates on " + k + " which the extension never sets",
      );
  });
  // This README *is* the Marketplace listing, so a setting missing from it is
  // invisible to every user. The table drifted once already; this stops it.
  const readmeText = require("node:fs").readFileSync(
    path.join(ROOT, "README.md"),
    "utf8",
  );
  check("every declared setting is documented in the README", () => {
    const undocumented = Object.keys(
      manifest.contributes.configuration.properties,
    ).filter((id) => !readmeText.includes(id));
    assert.deepStrictEqual(
      undocumented,
      [],
      "undocumented settings: " + undocumented.join(", "),
    );
  });

  check("every command title is documented in the README", () => {
    const undocumented = (manifest.contributes.commands || [])
      .filter((c) => !readmeText.includes(c.title))
      .map((c) => c.command);
    assert.deepStrictEqual(
      undocumented,
      [],
      "undocumented commands: " + undocumented.join(", "),
    );
  });

  check("contributed view id matches the created tree view", () => {
    const ids = Object.values(manifest.contributes.views || {})
      .flat()
      .map((v) => v.id);
    for (const id of ids)
      assert.ok(
        S.treeViews.some((v) => v.id === id),
        "view not created: " + id,
      );
  });

  console.log("\nuncaught diagnostics (catchme.diagnostics.reportUncaught)");
  const uncaughtSink = {
    kind: "uncaught",
    location: loc(APP, 12),
    label: "No caller found",
    confidence: "possible",
  };
  const renderUncaught = async () => {
    const reg = api.registerProvider({
      languages: ["plaintext"],
      capabilities: caps(),
      resolveThrowSite: () => ({
        uri: appUri,
        range: new vscode.Range(0, 0, 0, 5),
        exceptionType: { id: "Boom", label: "Boom" },
        simulated: false,
      }),
      suggestExceptionTypes: () => [],
      analyzeExceptionFlow: async (req) => ({
        throwSite: req.throwSite,
        paths: [{ steps: [uncaughtSink], depth: 1 }],
        terminals: [uncaughtSink],
        partial: false,
      }),
    });
    await vscode.__setActiveEditor(S.documents.get(APP), 0);
    await S.commands.get("catchme.findCatchers")();
    reg.dispose();
  };

  // Off by default: an analysis is an explicit action, so it should not quietly
  // populate the Problems panel.
  await acheck("publishes nothing while the setting is off", async () => {
    S.config.delete("catchme.diagnostics.reportUncaught");
    await renderUncaught();
    assert.strictEqual(S.diagnostics.size, 0, "expected no diagnostics");
  });

  await acheck("publishes at the throw site once enabled", async () => {
    S.config.set("catchme.diagnostics.reportUncaught", true);
    await renderUncaught();
    assert.strictEqual(S.diagnostics.size, 1);
    const [diag] = [...S.diagnostics.values()][0];
    assert.ok(String(diag.message).includes("Boom"), "message=" + diag.message);
    assert.ok(
      String(diag.message).includes("uncaught"),
      "message=" + diag.message,
    );
    assert.strictEqual(diag.severity, vscode.DiagnosticSeverity.Information);
  });

  await acheck("links each escaping route as related information", async () => {
    const [diag] = [...S.diagnostics.values()][0];
    assert.strictEqual(diag.relatedInformation.length, 1);
    assert.strictEqual(
      diag.relatedInformation[0].location.range.start.line,
      12,
    );
  });

  await acheck("clear removes the diagnostics too", async () => {
    S.commands.get("catchme.clear")();
    assert.strictEqual(S.diagnostics.size, 0);
    S.config.delete("catchme.diagnostics.reportUncaught");
  });

  console.log("\nprovider overrides (catchme.providerOverrides)");
  const twoEngines = () => {
    const mk = (engine, precision) => ({
      languages: ["plaintext"],
      capabilities: caps({
        engine,
        precision,
        typeHierarchy: precision === "definite",
      }),
      resolveThrowSite: () => ({
        uri: appUri,
        range: new vscode.Range(0, 0, 0, 5),
        exceptionType: { id: "Boom", label: "Boom" },
        simulated: false,
      }),
      suggestExceptionTypes: () => [],
      analyzeExceptionFlow: async (req) => ({
        throwSite: req.throwSite,
        paths: [],
        terminals: [],
        partial: false,
        diagnostics: [engine],
      }),
    });
    return [
      api.registerProvider(mk("deep", "definite")),
      api.registerProvider(mk("shallow", "possible")),
    ];
  };

  const whichEngine = async () => {
    const res = await api.analyze({
      throwSite: {
        uri: appUri,
        range: new vscode.Range(0, 0, 0, 1),
        exceptionType: { id: "Boom", label: "Boom" },
        simulated: true,
      },
      options: OPTIONS,
    });
    return (res.diagnostics || [])[0];
  };

  await acheck("prefers the higher-precision engine by default", async () => {
    const regs = twoEngines();
    const engine = await whichEngine();
    regs.forEach((r) => r.dispose());
    assert.strictEqual(engine, "deep");
  });

  await acheck("an override forces the named engine instead", async () => {
    S.config.set("catchme.providerOverrides", { plaintext: "shallow" });
    const regs = twoEngines();
    const engine = await whichEngine();
    regs.forEach((r) => r.dispose());
    S.config.delete("catchme.providerOverrides");
    assert.strictEqual(engine, "shallow");
  });

  console.log("\nshutdown");
  check("deactivate() runs cleanly", () => {
    if (ext.deactivate) ext.deactivate();
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\nFATAL: " + ((e && e.stack) || e));
  process.exit(1);
});
