/**
 * Real jdt.ls integration test — no VS Code, no Electron, no display.
 *
 * Launches the actual Eclipse JDT Language Server as a plain Java process,
 * loads the CatchMe analyzer bundle into it via `initializationOptions.bundles`
 * (exactly how redhat.java loads `contributes.javaExtensions`), and drives the
 * delegate commands over LSP against `fixtures/java`.
 *
 * This is what proves the M1–M3 Java path end to end: real ASTs, real type
 * bindings, real subtype matching. The extension-host tests in
 * `.vscode-test.mjs` cover the UI; this covers the analysis.
 *
 * Usage:  node test/jdtls-integration.mjs
 * jdt.ls is downloaded once into JDTLS_HOME (default: a temp cache).
 */
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(HERE, "..");
const REPO = path.resolve(CORE, "../..");
const FIXTURE = path.join(REPO, "fixtures/java");
const BUNDLE = path.join(CORE, "server/catchme.jdt.jar");

const JDTLS_VERSION = "1.60.0-202606262232";
const JDTLS_URL = `https://download.eclipse.org/jdtls/milestones/1.60.0/jdt-language-server-${JDTLS_VERSION}.tar.gz`;
const CACHE =
  process.env.JDTLS_HOME ||
  path.join(tmpdir(), `catchme-jdtls-${JDTLS_VERSION}`);
const DATA = path.join(tmpdir(), `catchme-jdtls-data-${process.pid}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureJdtls() {
  if (existsSync(path.join(CACHE, "plugins"))) return;
  console.log(`downloading jdt.ls ${JDTLS_VERSION} (once) ...`);
  mkdirSync(CACHE, { recursive: true });
  const tar = path.join(CACHE, "jdtls.tar.gz");
  const res = await fetch(JDTLS_URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const out = createWriteStream(tar);
  await new Promise((resolve, reject) => {
    res.body.pipe
      ? res.body.pipe(out)
      : (async () => {
          const { Readable } = await import("node:stream");
          Readable.fromWeb(res.body).pipe(out);
        })();
    out.on("finish", resolve);
    out.on("error", reject);
  });
  await new Promise((resolve, reject) => {
    const p = spawn("tar", ["xzf", tar, "-C", CACHE], { stdio: "inherit" });
    p.on("exit", (c) =>
      c === 0 ? resolve() : reject(new Error("tar failed")),
    );
  });
}

function configDir() {
  const arm = process.arch === "arm64";
  if (process.platform === "darwin")
    return arm ? "config_mac_arm" : "config_mac";
  if (process.platform === "win32") return "config_win";
  return arm ? "config_linux_arm" : "config_linux";
}

function start() {
  const launcher = path.join(
    CACHE,
    "plugins",
    readdirSync(path.join(CACHE, "plugins")).find((f) =>
      f.startsWith("org.eclipse.equinox.launcher_"),
    ),
  );
  return spawn(
    "java",
    [
      "-Declipse.application=org.eclipse.jdt.ls.core.id1",
      "-Dosgi.bundles.defaultStartLevel=4",
      "-Declipse.product=org.eclipse.jdt.ls.core.product",
      "-Dosgi.locking=none",
      "-Dlog.level=ERROR",
      "-Xmx1G",
      "--add-modules=ALL-SYSTEM",
      "--add-opens",
      "java.base/java.util=ALL-UNNAMED",
      "--add-opens",
      "java.base/java.lang=ALL-UNNAMED",
      "-jar",
      launcher,
      "-configuration",
      path.join(CACHE, configDir()),
      "-data",
      DATA,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
}

// --- minimal LSP client ------------------------------------------------------

function client(proc) {
  let seq = 0;
  const pending = new Map();
  const notes = [];
  let buf = Buffer.alloc(0);

  const write = (msg) => {
    const body = JSON.stringify(msg);
    proc.stdin.write(
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  };

  proc.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const m = /Content-Length: (\d+)/i.exec(
        buf.slice(0, headerEnd).toString(),
      );
      if (!m) return;
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (buf.length < start + len) return;
      const msg = JSON.parse(buf.slice(start, start + len).toString());
      buf = buf.slice(start + len);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error
          ? p.rej(new Error(JSON.stringify(msg.error)))
          : p.res(msg.result);
      } else if (msg.method) {
        notes.push(msg);
        if (msg.id !== undefined)
          write({ jsonrpc: "2.0", id: msg.id, result: null });
      }
    }
  });
  proc.stderr.on("data", () => {});

  return {
    notes,
    request(method, params) {
      const id = ++seq;
      write({ jsonrpc: "2.0", id, method, params });
      return new Promise((res, rej) => pending.set(id, { res, rej }));
    },
    notify(method, params) {
      write({ jsonrpc: "2.0", method, params });
    },
  };
}

// --- the test ----------------------------------------------------------------

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

const SRC_REL = "src/main/java/fixtures/BasicHandlers.java";

/**
 * Positions are located by source text, never hardcoded. The fixtures are
 * formatted by google-java-format, which has already moved them once without
 * anyone noticing: commit 7fe6e60 reflowed a class Javadoc from five lines to
 * three and re-indented four spaces to two, shifting every line below it up by
 * two and every column left by two. Six of these checks failed as a result,
 * reporting "returned null at the annotated @throws line" — which reads like a
 * broken analyzer rather than a stale constant. Anchoring on content keeps the
 * next reformat from doing the same thing.
 */
const lineContaining = (text, needle) => {
  const line = text.split(/\r?\n/).findIndex((l) => l.includes(needle));
  if (line === -1) {
    throw new Error(`fixture no longer contains ${JSON.stringify(needle)}`);
  }
  return line;
};

/** The 0-based range covering `needle` on the single line that holds it. */
const rangeOf = (text, needle) => {
  const line = lineContaining(text, needle);
  const character = text.split(/\r?\n/)[line].indexOf(needle);
  return {
    start: { line, character },
    end: { line, character: character + needle.length },
  };
};

const THROW_STMT = 'throw new IOException("boom");';
const HANDLER_STMT = "} catch (Exception e) {";

let proc;
try {
  if (!existsSync(BUNDLE)) {
    throw new Error(
      `analyzer jar missing: ${BUNDLE}\nRun: pnpm run build:server && pnpm run copy:server`,
    );
  }
  await ensureJdtls();

  proc = start();
  const lsp = client(proc);
  const srcUri = `file://${path.join(FIXTURE, SRC_REL)}`;

  console.log("starting jdt.ls with the CatchMe analyzer bundle ...");
  await lsp.request("initialize", {
    processId: process.pid,
    rootUri: `file://${FIXTURE}`,
    capabilities: {
      workspace: { executeCommand: { dynamicRegistration: true } },
    },
    initializationOptions: {
      bundles: [BUNDLE],
      workspaceFolders: [`file://${FIXTURE}`],
      settings: { java: { autobuild: { enabled: true } } },
    },
    workspaceFolders: [{ uri: `file://${FIXTURE}`, name: "java-fixtures" }],
  });
  lsp.notify("initialized", {});

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (
      lsp.notes.some(
        (n) =>
          n.method === "language/status" &&
          ["ServiceReady", "Started"].includes(n.params?.type),
      )
    )
      break;
    await sleep(500);
  }
  console.log("jdt.ls is ready\n");
  await sleep(4000);

  const srcText = readFileSync(path.join(FIXTURE, SRC_REL), "utf8");
  const throwRange = rangeOf(srcText, THROW_STMT);
  const HANDLER_LINE = lineContaining(srcText, HANDLER_STMT);

  lsp.notify("textDocument/didOpen", {
    textDocument: {
      uri: srcUri,
      languageId: "java",
      version: 1,
      text: srcText,
    },
  });
  await sleep(2000);

  const exec = (command, args) =>
    lsp.request("workspace/executeCommand", { command, arguments: args });
  const position = throwRange.start;

  const site = await exec("catchme.java.resolveThrowSite", [
    { uri: srcUri, position },
  ]);
  check("the analyzer bundle is loaded and its commands are reachable", () => {
    if (site === undefined)
      throw new Error("no response from delegate command handler");
  });
  check("resolveThrowSite finds the throw", () => {
    if (!site) throw new Error("returned null at the annotated @throws line");
  });
  check("the thrown type comes from real JDT bindings", () => {
    if (site?.exceptionType?.id !== "java.io.IOException")
      throw new Error("got " + JSON.stringify(site?.exceptionType));
    if (site?.exceptionType?.kind !== "checked")
      throw new Error(
        "expected kind=checked, got " + site?.exceptionType?.kind,
      );
  });

  const flow = await exec("catchme.java.analyzeFlow", [
    {
      uri: srcUri,
      range: throwRange,
      exceptionTypeId: "java.io.IOException",
      simulated: false,
      options: {
        maxDepth: 4,
        precision: "possible",
        includeLibraryCode: false,
        timeoutMs: 15_000,
      },
    },
  ]);

  const caught = (flow?.terminals || []).find((t) => t.kind === "caught");
  check("analyzeFlow resolves a handler", () => {
    if (!caught)
      throw new Error("terminals=" + JSON.stringify(flow?.terminals));
  });
  // The heart of it: IOException matched by `catch (Exception e)` requires a
  // real type hierarchy, which is the whole reason this backend exists.
  check("supertype catch is matched (IOException -> Exception)", () => {
    if (caught.location.range.start.line !== HANDLER_LINE)
      throw new Error(
        "handler at line " +
          caught.location.range.start.line +
          ", expected " +
          HANDLER_LINE,
      );
  });
  check("supertype match is reported as definite", () => {
    if (caught.confidence !== "definite")
      throw new Error("confidence=" + caught.confidence);
  });
  check("the first path terminates at the handler", () => {
    const steps = flow?.paths?.[0]?.steps || [];
    if (steps[steps.length - 1]?.kind !== "caught")
      throw new Error("steps=" + JSON.stringify(steps));
  });

  // ---- interprocedural: throw in deep(), handler two hops away in top() ----
  const propRel = "src/main/java/fixtures/Propagation.java";
  const propUri = `file://${path.join(FIXTURE, propRel)}`;
  const propText = readFileSync(path.join(FIXTURE, propRel), "utf8");
  // Survived the same reformat only because the line happened not to move;
  // the columns were already stale (character 8 landed mid-keyword).
  const propThrowRange = rangeOf(propText, THROW_STMT);

  lsp.notify("textDocument/didOpen", {
    textDocument: {
      uri: propUri,
      languageId: "java",
      version: 1,
      text: propText,
    },
  });
  await sleep(2000);

  const chain = await exec("catchme.java.analyzeFlow", [
    {
      uri: propUri,
      range: propThrowRange,
      exceptionTypeId: "java.io.IOException",
      simulated: false,
      options: {
        maxDepth: 6,
        precision: "possible",
        includeLibraryCode: false,
        timeoutMs: 20_000,
      },
    },
  ]);

  const chainCaught = (chain?.terminals || []).find((t) => t.kind === "caught");
  check("follows callers across methods to a handler", () => {
    if (!chainCaught) {
      throw new Error(
        "terminals=" + JSON.stringify(chain?.terminals || []).slice(0, 300),
      );
    }
  });
  check("the chain took at least one hop", () => {
    const deepest = Math.max(
      0,
      ...(chain?.paths || []).map((p) => p.depth || 0),
    );
    if (deepest < 1) throw new Error("max depth was " + deepest);
  });
  // This is the feature under test: every escaping frame must say where it was
  // called from, or the tree cannot render a navigable chain.
  check("every escaping frame records its call site", () => {
    const escapes = (chain?.paths || [])
      .flatMap((p) => p.steps || [])
      .filter((s) => s.kind === "escapes-function");
    if (escapes.length === 0)
      throw new Error("no escaping frames in the chain");
    const missing = escapes.filter((s) => !s.callSite);
    if (missing.length > 0) {
      throw new Error(
        missing.length + " of " + escapes.length + " lack a callSite",
      );
    }
    const cs = escapes[0].callSite;
    if (typeof cs.uri !== "string" || !cs.range?.start) {
      throw new Error("malformed callSite: " + JSON.stringify(cs));
    }
  });
  // A reference search cannot prove which override actually runs.
  check("cross-method handlers are labelled possible, not definite", () => {
    if (chainCaught.confidence !== "possible") {
      throw new Error("confidence=" + chainCaught.confidence);
    }
  });

  const types = await exec("catchme.java.suggestExceptionTypes", [
    { uri: srcUri, position },
  ]);
  check("suggestExceptionTypes returns the project Throwable hierarchy", () => {
    if (!Array.isArray(types) || types.length === 0)
      throw new Error("got " + JSON.stringify(types));
  });
  console.log(`  (suggested ${types.length} types)`);

  console.log(`\n${pass} passed, ${fail} failed`);
} catch (e) {
  console.error("\nERROR: " + (e?.stack || e));
  fail++;
} finally {
  if (proc) proc.kill("SIGTERM");
  await rm(DATA, { recursive: true, force: true }).catch(() => {});
}
process.exit(fail ? 1 : 0);
