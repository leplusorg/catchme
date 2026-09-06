# Architecture Decision Record

Decisions that shaped CatchMe, why they were made, and what they cost. Each
entry is immutable once accepted: to change a decision, add a new record that
supersedes the old one rather than editing history.

Records 1–18 were captured retroactively on 2026-09-05, at the point the project
was first published. They document decisions taken during initial development,
so they share a date; later records should carry the date the decision was
actually made.

Format is [Michael Nygard's](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
Status is one of `Accepted`, `Superseded by ADR-NNNN`, or `Deprecated`. If this
file grows past roughly twenty records, split it into `docs/adr/NNNN-title.md`,
one decision per file.

---

## ADR-0001 — Build for Visual Studio Code

**Status:** Accepted

**Context.** Since the first target language was Java, the idea
started as an Eclipse plugin. But considering that the concept can
apply to multiple languages, and that Visual Studio Code is currently the most
popular IDE across most languages, making a Visual Studio Code extension seemed
like the best way to reach the most developers.

**Decision.** Target Visual Studio Code. Delete the Eclipse plugin rather than maintain two
frontends.

**Consequences.** Reaches a far larger audience and opens the door to other
languages via LSP. The Eclipse JDT work was not wasted: the analysis logic moved
into a bundle that now runs _inside_ jdt.ls (ADR-0006), so the hardest part — the
actual type-hierarchy reasoning — carried over. Cost: no Eclipse support, and
nobody is asking for it back.

---

## ADR-0002 — A language-agnostic core with pluggable providers

**Status:** Accepted

**Context.** The obvious build is a Java extension. But "where does this
exception go?" is a question in every language with structured exception
handling, and the _presentation_ of the answer — grouping, ranking, navigation —
is identical regardless of language. Baking Java into the core would mean
rewriting all of it per language.

**Decision.** Split into a language-neutral core plus `ExceptionFlowProvider`
implementations. The core owns the UI, the traversal loop, the confidence rules
and the registry; providers only answer language questions. Java is one provider,
with no privileges the others lack.

**Consequences.** Adding a language means implementing one interface, not forking
the extension. It also forced the honesty model (ADR-0003) to be explicit rather
than implicit, because providers differ wildly in what they can prove. Cost: more
indirection than a Java-only build, and the core must defend against providers
that overclaim. One wrinkle remains — the manifest still declares
`onLanguage:java` as its only explicit activation event, relying on VS Code's
implicit command activation elsewhere.

---

## ADR-0003 — Two confidence levels: `definite` and `possible`

**Status:** Accepted

**Context.** Static analysis cannot be exact in the presence of virtual dispatch,
reflection or dynamic typing. A tool that presents guesses and proofs in the same
visual weight teaches users to distrust all of it — and the failure is silent,
because a confident wrong answer looks exactly like a right one.

**Decision.** Every sink carries a `Confidence` of `definite` or `possible`.
Two levels, not a percentage: anything finer would imply a precision the analysis
does not have. A provider declares `capabilities.typeHierarchy`, and when that is
false the **core downgrades every result to `possible`** regardless of what the
provider claims.

**Consequences.** Users can tell proof from inference at a glance. The core, not
the provider, is the final authority on confidence, so a buggy or optimistic
third-party provider cannot manufacture false certainty. Cost: Java gets
`definite` and most other languages never will, which may read as a
second-class experience — accepted, because the alternative is lying.

---

## ADR-0004 — A chain is rated by its weakest hop; a destination by its best route

**Status:** Accepted

**Context.** Once results span multiple call frames, "how confident are we?"
has two different answers, and they point in opposite directions.

**Decision.** Rate a **chain** by its _weakest_ hop: one approximate step makes
the whole route `possible`, even when the final type match is exact. Rate a
**destination** by its _best_ route, because reachability asks whether _any_
chain gets there.

**Consequences.** Both rules are individually correct and the asymmetry is
deliberate — a chain is a conjunction (every hop must hold), a destination is a
disjunction (one route suffices). It surprises people on first encounter, so it
is documented on the site rather than left to be inferred.

---

## ADR-0005 — The core drives interprocedural traversal via LSP Call Hierarchy

**Status:** Accepted

**Context.** Following an exception out of a function and into its callers is the
expensive part of the feature, and the part most likely to be wrong. Requiring
every provider to implement its own caller walk would put the hardest code in the
place least equipped to get it right, and duplicate it per language.

**Decision.** Providers declare `capabilities.interprocedural`. When false, the
core walks callers itself using the standard LSP Call Hierarchy requests
(`vscode.prepareCallHierarchy`, `vscode.provideIncomingCalls`) and calls back
into the provider's `resolveAtCallSite` at each frame. Providers that can do
better walk it themselves.

**Consequences.** Any language whose extension implements Call Hierarchy — which
is most of them — gets interprocedural analysis for free, from a provider that
only answers local questions. The traversal bound, timeout and truncation logic
live in one place. Cost: Call Hierarchy resolves _static_ call graphs, so results
from this path are inherently `possible`.

---

## ADR-0006 — Java depth comes from a JDT bundle loaded inside jdt.ls

**Status:** Accepted

**Context.** Proving that `catch (IOException e)` handles a thrown
`FileNotFoundException` requires a resolved type hierarchy. The Visual Studio Code
extension host has no such thing. Options were: run our own JDT process
(duplicating a full workspace index), approximate from syntax (giving up
`definite`), or get inside the language server that already has the index.

**Decision.** Ship an OSGi bundle registered through
`contributes.javaExtensions`, which Red Hat's extension passes to jdt.ls as an
`initializationOptions.bundles` entry. The bundle implements
`org.eclipse.jdt.ls.core.delegateCommandHandler`; the provider reaches it via
`java.execute.workspaceCommand`.

**Consequences.** The analysis runs where `ITypeBinding.isSubTypeCompatible` is
available and the workspace is already indexed — no second index, no second JVM,
and genuinely `definite` answers. Cost: coupling to a jdt.ls internal extension
mechanism, a Java build inside a TypeScript monorepo (ADR-0014), and results that
must cross a JSON boundary.

---

## ADR-0007 — Refuse to answer when jdt.ls is in LightWeight mode

**Status:** Accepted

**Context.** jdt.ls starts in LightWeight mode, which provides syntax without
resolved bindings. The analysis will happily run in that state and return
plausible, confidently-labelled, wrong answers.

**Decision.** Check `serverMode` and refuse, with an explanation and a
suggestion to wait for Standard mode. Do not silently downgrade to `possible`.

**Consequences.** Users may hit the refusal while a large project is still
indexing, which is a worse first impression than showing _something_. Accepted:
a wrong answer during the exact minutes a user is forming their opinion of the
tool is more expensive than a clear "not yet". Downgrading was rejected because
it would hide a transient, self-healing condition behind a permanent-looking
label.

---

## ADR-0008 — Red Hat's Java extension is a soft dependency

**Status:** Accepted

**Context.** The Java provider cannot work without `redhat.java`. Declaring it in
`extensionDependencies` would install it automatically — and force it on
users who installed CatchMe for Python or TypeScript.

**Decision.** No `extensionDependencies`. Detect `redhat.java` at runtime; if it
is absent, the Java provider does not register and the LSP provider handles Java
at `possible` confidence like any other language.

**Consequences.** CatchMe installs and works for non-Java users without dragging
in a Java toolchain. Java users get a clear message about what to install rather
than a silent failure. Cost: a Java user can install CatchMe and get degraded
results without understanding why, so the docs lead with the requirement.

---

## ADR-0009 — Publish the provider contract and a conformance kit as separate packages

**Status:** Accepted

**Context.** ADR-0002's pluggability is only real if someone outside this repository
can act on it. A third-party author needs something to compile against and some
way to know their implementation is correct.

**Decision.** Publish `@leplusorg/catchme-api` (types only, no runtime
dependency on the extension) and `@leplusorg/catchme-provider-testkit`, which
drives a provider against fixture files annotated with trailing comments
(`// @caught definite`, `// @escapes`) and asserts the `FlowResult` matches.
Providers register by declaring `contributes.exceptionFlowProviders` in their own
manifest, which the core scans; this also allows lazy activation.

**Consequences.** The contract is versioned and breaking changes are visible as
SemVer rather than as silent runtime failures. The first-party providers are
held to the same conformance kit third parties get, so the kit cannot rot into a
fiction. Cost: three packages to publish and keep in step.

---

## ADR-0010 — Bound the walk with a global visited set, yielding representative routes

**Status:** Accepted

**Context.** Real call graphs are cyclic. An unbounded caller walk does not
terminate, and even a depth-bounded one explodes combinatorially where many
chains converge.

**Decision.** Track expanded call sites in a set that is **global across the
whole walk**, not per path. When two distinct chains converge on the same call
site, only the first continues through it; the second stops. Combined with a
depth limit (`catchme.analysis.maxDepth`) and a timeout
(`catchme.analysis.timeoutMs`), after which in-flight paths are kept rather than
discarded.

**Consequences.** Termination is guaranteed and the result size stays bounded on
graphs where per-path visiting would explode. The results are **representative
routes, not exhaustive ones** — a user may not see a handler that is genuinely
reachable by a second route through an already-expanded call site. This is a real
loss of completeness, documented in the troubleshooting section rather than
hidden, and it is the direct price of finiteness.

---

## ADR-0011 — Truncation is actionable, never silent

**Status:** Accepted

**Context.** Given ADR-0010's bounds, some searches stop early. A tool that
quietly returns partial results while looking complete is worse than one that
returns nothing, because the user draws a conclusion from an absence.

**Decision.** Depth-limited paths surface an explicit `⋯` node that is clickable
and continues the search from that point. Truncated and escaping paths are
excluded from the terminal-destination grouping so they cannot be mistaken for
resolved answers.

**Consequences.** The limit becomes a visible, recoverable state instead of an
invisible cliff. Cost: extra node type in the tree and extra state to carry
through the engine.

---

## ADR-0012 — Group results by destination, nest the call chain underneath

**Status:** Accepted

**Context.** Once paths are multi-hop, a flat list of handlers loses the "how did
it get there?" information, while a flat list of paths repeats the same
destination many times. The question users actually ask is "where can this end
up?", and only then "by what route?".

**Decision.** Top level is the exception. Second level is each **destination**
(handler, uncaught boundary) with its confidence and location. Third level is the
call chain reaching it — throw site, escaped frames, handler. A dedicated tree
view in the activity bar, with Peek (`editor.action.showReferences`) opening at
the first handler for the common single-answer case. Clicking a hop jumps to its
**call site**, not its declaration, because that is the line where the exception
actually leaves for the next frame.

**Consequences.** Matches the shape of the question and collapses converging
chains naturally. Peek keeps the fast path fast without forcing users into the
tree for a one-answer result. Cost: the view is a custom `TreeDataProvider` with
seven node kinds rather than a stock references list.

---

## ADR-0013 — pnpm workspaces, Turborepo, TypeScript project references, esbuild

**Status:** Accepted

**Context.** ADR-0002 and ADR-0009 imply five TypeScript packages with real
dependencies between them, one of which ships to a marketplace where bundle size
and startup time are user-visible.

**Decision.** pnpm workspaces for linking, Turborepo for task orchestration and
caching, TypeScript project references for incremental typed builds, esbuild to
bundle the extension into a single file.

**Consequences.** Provider packages are consumed as real packages, so the
published contract is exercised internally exactly as third parties will
experience it. Cost: `--env-mode=loose` is needed because Turborepo otherwise
drops `TMPDIR`, and the esbuild bundle can fail _silently_ if the workspace link
is broken — which happened, and now the smoke tests run against the real bundle
(ADR-0015) partly to catch it.

---

## ADR-0014 — Tycho-only build for the JDT bundle, Java 21 floor

**Status:** Accepted

**Context.** ADR-0006's bundle is an OSGi artifact resolved from a p2 repository.
A plain Maven jar build would produce something jdt.ls cannot load; maintaining
both was briefly considered and has no consumer.

**Decision.** `eclipse-plugin` packaging via Tycho only, no jar profile. Java 21
as the floor. Both the Eclipse release repository (`releases/2026-06/`) and the
jdt.ls repository are pinned to exact versions, never `latest` or a floating
snapshot.

**Consequences.** One build path, and the `artifactId` must equal the
`Bundle-SymbolicName` (Tycho enforces this; it was learned the hard way). Java 21
matches what jdt.ls itself requires, so it costs no real compatibility. Cost: the
Tycho build resolves a full p2 target platform over the network, which is slow
enough that CodeQL analyses this code with `build-mode: none` rather than
invoking Maven.

---

## ADR-0015 — Three test tiers, because the extension host is not always runnable

**Status:** Accepted

**Context.** The correct way to test a Visual Studio Code extension is in a real extension
host via `@vscode/test-electron`. In the development sandbox Electron cannot
start at all — macOS denies `bootstrap_check_in`/`mach-register`. Six approaches
were tried and none worked. Testing nothing was not an option.

**Decision.** Three tiers that degrade rather than block:

1. **Unit** (vitest) — pure logic, no `vscode`.
2. **Smoke** (headless) — loads the _real_ built `dist/extension.js` with a mock
   `vscode` module injected via `Module._load` interception.
3. **Integration** — jdt.ls started as a plain Java process, driven over LSP,
   exercising the real delegate commands with no editor involved.

Plus the real extension-host suite, which runs wherever Electron works.

**Consequences.** Full coverage of the analysis and wiring without a working
extension host, and tier 2 catches bundling failures that unit tests structurally
cannot see. Tier 3 tests the actual JDT code against a real language server, the
part most likely to be wrong. Cost: four suites to maintain, and the mock
`vscode` is a fidelity risk that only the extension-host suite retires. Counts at
time of writing: 112 unit, 47 smoke, 12 jdt.ls, 5 extension-host.

---

## ADR-0016 — Homepage is Eleventy in `site/` on `main`, deployed by Actions

**Status:** Accepted

**Context.** The project needs a homepage. The traditional GitHub Pages approach
is a `gh-pages` branch holding built output; the alternative is building in CI
and deploying an artifact. Requirements were: static, rendered at build time,
minimal JavaScript, still attractive.

**Decision.** Eleventy in a `site/` directory on `main`, built and deployed by
`.github/workflows/pages.yml` using the Pages artifact actions. No committed
build output. The result ships **zero JavaScript** and makes no third-party
requests — no web fonts, no analytics — enforced by build tests rather than by
intention.

**Consequences.** Source and site version together in one branch, one review, one
history. Content lives in Markdown where it is prose (`docs.md`) and Nunjucks
where it is structure (`index.njk`). Command and setting tables are generated
from `packages/core/package.json` at build time, so documentation cannot drift
from what ships — with a test comparing rendered rows against the manifest in
case that link ever breaks. Cost: a `site` entry in `pnpm-workspace.yaml` and a
build step between edit and preview.

---

## ADR-0017 — The site reads its version from the GitHub API at build time

**Status:** Accepted

**Context.** The homepage should show the current version without a manual edit
per release. Client-side fetching would violate ADR-0016's no-JavaScript
promise.

**Decision.** An Eleventy `_data` file queries the GitHub releases API during the
build. The workflow additionally triggers on `release: published`, so publishing
a release rebuilds the site.

**Consequences.** Always current, still fully static, no JavaScript. Every
failure mode — no releases yet, rate limiting, no network — degrades to a
"Releases" link rather than failing the build or rendering an empty version.
Both branches are covered by a test. Cost: the displayed version is only as fresh
as the last build.

---

## ADR-0018 — Pin every external reference; verify the supply chain in CI

**Status:** Accepted

**Context.** The project executes third-party code in CI, including with
marketplace publish tokens in scope. Version ranges resolved at runtime make
builds unreproducible and turn any upstream compromise into an immediate one.

**Decision.** Pin GitHub Actions to full 40-character commit SHAs with a version
comment; pin Docker images by tag _and_ digest; pin p2 repositories to exact
versions; install with `--frozen-lockfile` everywhere. Enforce with `zizmor`
plus an explicit `forbidden-uses` allowlist, run CodeQL over the workflows
themselves, and grant `permissions: {}` at workflow level with per-job
escalation. Dependabot covers npm, Maven and Actions.

**Consequences.** Builds are reproducible and upstream changes arrive as
reviewable pull requests. Two gaps are known and recorded in `TODO.md`: the
release workflow fetches `@vscode/vsce` and `ovsx` via `npx --yes` at publish
time, unpinned and with tokens present, and `ovsx` is undeclared so Dependabot
cannot see it; and the integration tests run against whatever Visual Studio Code is current
rather than a pinned version, which has already broken CI once.

---

## ADR-0019 — The editor floor is `^1.105.0`, and `@types/vscode` is pinned to it

**Status:** Accepted (2026-09-06)

**Context.** `engines.vscode` declared `^1.90.0` while Dependabot had walked
`@types/vscode` up to `1.134.0`. `vsce package` refuses to build when the types
are ahead of the engine floor, so releases were blocked outright — and until it
was fixed, the compiler had been accepting APIs that do not exist in the oldest
supported editor, which fails only at runtime on a user's machine.

Before choosing a floor, the actual requirement was measured rather than
guessed: every package was compiled against fourteen versions of `@types/vscode`
from 1.44 to 1.90. The boundary is sharp — 1.55 fails, 1.56 passes. The binding
API is `title` on `InputBoxOptions` and `QuickPickOptions`
(`packages/core/src/commands/index.ts:188` and `:196`), absent in 1.55.0 and
present in 1.56.0; the runner-up is `TreeItem.tooltip` accepting a
`MarkdownString`. So the source imposes a floor of **1.56.0** and nothing higher.

**Decision.** Set `engines.vscode` to `^1.105.0` and pin `@types/vscode` to
exactly `1.105.0` in all five packages. Add a Dependabot `ignore` for
`@types/vscode`: it is not an ordinary dependency but a declaration of which
editor APIs the compiler will accept, and it is only correct when it equals the
floor. The two values move together, by hand.

Track the newest published version separately, in
`tools/vscode-types-latest/package.json`, and let Dependabot manage *that*.
Two pinned versions, with opposite update policies: the floor never moves
automatically, the ceiling only moves automatically.

**Consequences.** Packaging works again, and the compiler now enforces the floor
instead of silently permitting APIs beyond it. Users below 1.105 cannot install,
which is a deliberate cost: 1.105 is a tested, recent baseline, and the Java
path depends on Red Hat's extension, which needs a modern editor regardless.

Because the code only needs 1.56, there is roughly fifty releases of headroom —
the floor can be lowered later purely by editing two version strings, with no
source change. The measurement above is what makes that a cheap decision rather
than an investigation.

Ignoring the floor costs the automated pull request that would otherwise flag
upstream change, so `scripts/check-vscode-api.mjs` and the second pin replace
it together. The script compiles the workspace against a chosen `@types/vscode`
using a `paths` redirect, mutating nothing, and answers two questions: does the
code still build against the floor (and does the floor pin still equal
`engines.vscode`), and does it still build against the newest published
version.

Both questions are part of `pnpm test`, not a separate job. Only one
`@types/vscode` can be installed at a time, so an ordinary test run exercises
whichever version happens to be in `node_modules` and is blind to the other by
construction; a suite that claims to guard the floor has to swap the types
itself. Making it a root script rather than a turbo task is deliberate — the
swap is a whole-workspace operation, and it must run even when every package
task is a cache hit.

Both results are blocking, which is only defensible because both versions are
committed. An earlier iteration resolved `latest` from the registry at run
time; that had to be advisory on pull requests, because an upstream release
could turn a contributor's branch red with no diff to point at, and it pushed
the real signal into a weekly scheduled workflow that nobody owns. Pinning the
ceiling and handing it to Dependabot removes both problems: the check is
reproducible, a failure names a specific version, and the notification is a
pull request with the version bump in its diff. `vscode-api.yml` was deleted
in favour of that.

The mechanism is a second manifest rather than an npm alias in the workspace,
because Dependabot's `ignore` matches by dependency name across a whole update
job and it resolves aliases back to the aliased-to name — an alias would be
swallowed by the floor's `ignore`. Separate directories are what let one
package carry two independently managed versions. `tools/` sits outside the
`pnpm-workspace.yaml` globs, so nothing installs it and it cannot reach the
shipped extension.

This makes the canary depend on branch protection: auto-merge only holds a
Dependabot pull request back if CI is a required check. Without that, a
breaking bump merges itself and the warning is lost.

Running inside the test suite imposes two constraints the script honours. It
must be fast — types are staged from `node_modules` when the version already
matches, and everything downloaded is cached under `.vscode-api-check/`, so a
warm run costs about two seconds. And it must not fail offline: the floor never
needs the network, and a version whose types cannot be fetched is skipped
rather than failed, since a network error is not something the developer can
act on. `--strict` removes that tolerance for CI, where the registry is
expected to be reachable.
