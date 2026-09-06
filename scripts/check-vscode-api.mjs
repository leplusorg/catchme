#!/usr/bin/env node
// Compile the whole workspace against a chosen @types/vscode version.
//
// Two questions, one script:
//
//   floor   Does the code still build against the version we pin in the five
//           packages, i.e. the oldest editor we claim to support? It is the
//           same surface `pnpm run typecheck` uses, asserted explicitly so
//           that changing the pin without thinking fails loudly.
//   latest  Does the code still build against the newest published version,
//           pinned in tools/vscode-types-latest/package.json and bumped by
//           Dependabot? This is a canary for API breakage heading our way — a
//           removal or a narrowed signature shows up here months before we
//           raise the floor onto it.
//
// Both are blocking. Neither is resolved from the registry at run time: both
// versions are committed, so a failure is reproducible and belongs to a
// specific commit. The Dependabot pull request that moves the second one is
// where an upstream break surfaces, with the diff attached.
//
// The types are swapped with a `paths` redirect rather than by installing
// them, so running this never mutates package.json, the lockfile or
// node_modules. Everything it writes lands in .vscode-api-check/, which is
// gitignored.
//
// `pnpm test` runs this after the package tests, which is what makes the suite
// cover both versions rather than only the one that happens to be installed.
// To stay usable there it stages types from node_modules when it can, caches
// what it downloads, and — offline only — skips a version whose types it
// cannot fetch rather than failing on a network error nobody can act on. The
// floor never needs the network. `--strict` removes that tolerance.
//
// Usage:
//   node scripts/check-vscode-api.mjs                 # floor and latest
//   node scripts/check-vscode-api.mjs floor
//   node scripts/check-vscode-api.mjs floor latest --strict
//   node scripts/check-vscode-api.mjs 1.120.0         # ad hoc, advisory

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = join(repo, ".vscode-api-check");
const npmCache = join(workDir, ".npm-cache");

// Every package that imports `vscode`. Only `core` typechecks its own tests
// (they are mocha extension-host tests); the rest exclude them, so mirror
// that here instead of inventing a scope the real build never uses.
const PACKAGES = ["api", "core", "provider-lsp", "provider-java", "testkit"];
const EXCLUDES_TESTS = PACKAGES.filter((p) => p !== "core");

// stderr is piped, not inherited: execFileSync inherits it by default, and
// `npm pack` prints a full tarball manifest there on *success*, which would
// bury the result. Captured output is surfaced on failure instead.
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });

/** Read the pinned @types/vscode and the engine floor, and assert they agree. */
function readPins() {
  const manifests = Object.fromEntries(
    PACKAGES.map((p) => [
      p,
      JSON.parse(
        readFileSync(join(repo, "packages", p, "package.json"), "utf8"),
      ),
    ]),
  );

  const pinned = new Map();
  for (const [p, m] of Object.entries(manifests)) {
    const v =
      m.devDependencies?.["@types/vscode"] ?? m.dependencies?.["@types/vscode"];
    if (v) pinned.set(p, v);
  }

  const distinct = [...new Set(pinned.values())];
  if (distinct.length !== 1) {
    const detail = [...pinned].map(([p, v]) => `${p}=${v}`).join(", ");
    throw new Error(
      `@types/vscode must be identical in every package; found ${detail}`,
    );
  }

  const types = distinct[0];
  const engines = manifests.core.engines?.vscode;
  const floor = String(engines ?? "").replace(/^[\^~]/, "");
  if (floor !== types) {
    throw new Error(
      `@types/vscode (${types}) must equal the engines.vscode floor (${engines}). ` +
        "vsce refuses to package when the types are ahead of the floor, and " +
        "types behind it hide APIs the floor really offers. See ADR-0019.",
    );
  }
  return types;
}

/**
 * Read the newest version we compile against, from tools/vscode-types-latest.
 *
 * Pinned and committed rather than resolved from the registry: that is what
 * makes a failure here reproducible and attributable to a specific version,
 * and it is Dependabot that moves the pin. Resolving `latest` live would mean
 * an upstream publication could turn an unrelated branch red with no diff to
 * point at. See tools/vscode-types-latest/README.md.
 */
function readLatestPin() {
  const manifest = join(repo, "tools/vscode-types-latest/package.json");
  const declared = JSON.parse(readFileSync(manifest, "utf8")).devDependencies?.[
    "@types/vscode"
  ];
  if (!declared) {
    throw new Error(`no @types/vscode devDependency in ${manifest}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(declared)) {
    throw new Error(
      `@types/vscode in ${manifest} must be an exact version, not "${declared}". ` +
        "A range would make this check resolve differently on different days, " +
        "which is the behaviour pinning it was meant to remove.",
    );
  }
  return declared;
}

/**
 * Make @types/vscode@version available under .vscode-api-check/types/.
 *
 * Three sources, cheapest first: a previous run's copy, the version already
 * present in node_modules (always true for the floor, since that is what the
 * workspace builds against), and only then the registry. That ordering is what
 * lets `pnpm test` cover the floor with no network at all, and makes repeat
 * runs instant. Caching by version is safe because a new `latest` resolves to
 * a version number that has no cache entry yet.
 */
function ensureTypes(version) {
  const dest = join(workDir, "types", version);
  const staged = join(dest, "vscode", "index.d.ts");
  if (existsSync(staged)) return staged;

  const installed = join(repo, "packages/core/node_modules/@types/vscode");
  try {
    const meta = JSON.parse(
      readFileSync(join(installed, "package.json"), "utf8"),
    );
    if (meta.version === version) {
      mkdirSync(join(dest, "vscode"), { recursive: true });
      copyFileSync(join(installed, "index.d.ts"), staged);
      return staged;
    }
  } catch {
    // Not installed, or a different version. Fall through to the registry.
  }

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  run("npm", [
    "pack",
    `@types/vscode@${version}`,
    "--pack-destination",
    dest,
    "--cache",
    npmCache,
    "--fetch-timeout=60000",
  ]);
  const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error(`no tarball produced for @types/vscode@${version}`);
  // The tarball unpacks to vscode/, not the usual package/.
  run("tar", ["-xzf", join(dest, tgz), "-C", dest]);
  return join(dest, "vscode", "index.d.ts");
}

/**
 * Compile every package's source against the staged types.
 *
 * Workspace packages resolve through `paths` to their `src/`, not their built
 * `dist/`, so the swapped types reach the whole graph — a stale .d.ts built
 * against the pinned version would otherwise mask exactly what we are testing.
 */
function typecheck(version) {
  const cfg = {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022"],
      module: "Node16",
      moduleResolution: "Node16",
      strict: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      noEmit: true,
      composite: false,
      declaration: false,
      types: ["node", "mocha"],
      typeRoots: [
        "../node_modules/@types",
        "../packages/core/node_modules/@types",
      ],
      paths: {
        vscode: [`./types/${version}/vscode/index.d.ts`],
        "@leplusorg/catchme-api": ["../packages/api/src/index.ts"],
        "@leplusorg/catchme-provider-lsp": [
          "../packages/provider-lsp/src/index.ts",
        ],
        "@leplusorg/catchme-provider-java": [
          "../packages/provider-java/src/index.ts",
        ],
      },
    },
    include: PACKAGES.map((p) => `../packages/${p}/src`),
    exclude: EXCLUDES_TESTS.map((p) => `../packages/${p}/src/**/*.test.ts`),
  };

  const cfgPath = join(workDir, `tsconfig.${version}.json`);
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

  try {
    run(join(repo, "node_modules/.bin/tsc"), ["-p", cfgPath], { cwd: repo });
    return { ok: true, errors: [] };
  } catch (err) {
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    return {
      ok: false,
      errors: out.split("\n").filter((l) => l.includes(": error TS")),
    };
  }
}

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const wanted = args.filter((a) => !a.startsWith("--"));

mkdirSync(workDir, { recursive: true });

let floor;
try {
  floor = readPins();
} catch (err) {
  // A misaligned pin is a configuration mistake, not a crash; a stack trace
  // only buries the one sentence that explains how to fix it.
  console.error(`Version pins are inconsistent.\n\n  ${err.message}\n`);
  process.exit(1);
}
console.log(`@types/vscode pinned at ${floor}, matching engines.vscode\n`);

// Two independent notions of "must". `required` is about the compile result:
// does a type error here fail the run? `mustFetch` is about availability: is
// being unable to obtain the types a failure, or merely a skip? They differ
// because the floor is always in node_modules while every other version comes
// from the registry, and an offline developer should still get a real floor
// result rather than a network error about something they cannot fix.
let targets;
try {
  targets = (wanted.length ? wanted : ["floor", "latest"]).map((name) => {
    if (name === "floor") {
      return {
        label: "floor",
        version: floor,
        required: true,
        mustFetch: true,
      };
    }
    if (name === "latest") {
      // Blocking, unlike when this version was resolved live: it is committed,
      // so a type error is a fact about this branch that someone can reproduce
      // and bisect, not an accident of what happened to publish today.
      return {
        label: "latest",
        version: readLatestPin(),
        required: true,
        mustFetch: strict,
      };
    }
    return { label: name, version: name, required: strict, mustFetch: strict };
  });
} catch (err) {
  // Same reasoning as readPins above: a malformed pin is a configuration
  // mistake, and the sentence explaining it is the whole useful output.
  console.error(`Version pins are inconsistent.\n\n  ${err.message}\n`);
  process.exit(1);
}

let failed = false;
const summary = [];

for (const t of targets) {
  process.stdout.write(`Checking ${t.label} (@types/vscode@${t.version})… `);
  try {
    ensureTypes(t.version);
  } catch (err) {
    if (t.mustFetch) {
      console.log("unavailable");
      // execFileSync throws an object whose default rendering is the whole
      // spawn record; npm's own message is the only useful part of it.
      console.error(
        `\nCould not obtain @types/vscode@${t.version}.\n\n` +
          `${(err.stderr ?? err.message ?? "").trim()}\n`,
      );
      process.exit(1);
    }
    console.log("skipped (types unavailable offline)");
    summary.push({ ...t, skipped: true });
    continue;
  }
  const { ok, errors } = typecheck(t.version);
  console.log(ok ? "OK" : `${errors.length} error(s)`);
  for (const e of errors.slice(0, 20)) console.log(`    ${e}`);
  summary.push({ ...t, ok, count: errors.length });
  if (!ok && t.required) failed = true;
}

console.log("\n=== Summary ===");
for (const s of summary) {
  const note = s.skipped
    ? "skipped"
    : s.ok
      ? "pass"
      : s.required
        ? "FAIL"
        : "fail (advisory)";
  console.log(`  ${s.label.padEnd(7)} ${s.version.padEnd(10)} ${note}`);
}

if (summary.some((s) => s.label === "latest" && s.ok === false)) {
  console.log(
    "\nThe latest types no longer compile. Nothing is broken for users today —" +
      "\nthe shipped extension builds against the floor, which is unaffected —" +
      "\nbut this is the API change that will bite when the floor is raised." +
      "\n\nDo not fix this by raising the floor, and do not fix it by bumping" +
      "\ntools/vscode-types-latest past the breakage. Record it in TODO.md and" +
      "\nadapt the source. See tools/vscode-types-latest/README.md.",
  );
}

process.exit(failed ? 1 : 0);
