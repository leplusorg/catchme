# TODO

Actionable work items. The `README.md` files describe what the project **is**
and where it's **going**; this file tracks what still has to be **done**. Keep
them separate — a readme that accumulates task lists goes stale silently, and a
reader can no longer tell current state from wishful thinking.

Roadmap-level direction lives in the root [Readme](README.md#roadmap).
Architectural decisions and their rationale live in [ADR.md](ADR.md). Items here
should be concrete enough to close.

---

## Before a Marketplace release

- [ ] **Create the `leplusorg` publisher** on the Visual Studio Code Marketplace
      _and_ on [Open VSX](https://open-vsx.org). Both are required by
      `release.yml`; Open VSX is what serves VSCodium, Gitpod and Cursor users.
- [ ] **Add the repository secrets** `VSCE_PAT`, `OVSX_PAT` and `NPM_TOKEN`.
      Without them `release.yml` fails at the publish step, after having already
      built and tagged.
- [ ] **Pin `ovsx` in the publish path.** `release.yml` still runs
      `npx --yes ovsx`, which resolves whatever is latest on npm _at publish
      time_ and executes it with `OVSX_PAT` in the environment. Unlike `vsce`,
      `ovsx` is declared in no `package.json`, so it is outside the lockfile and
      invisible to Dependabot — which is why it could not be fixed in the same
      pass. Add it as a devDependency of `packages/core`, then invoke it as
      `pnpm --filter catchme exec ovsx publish "$PWD/catchme.vsix" …` to match
      what the Marketplace step now does. The `$PWD` matters: `pnpm exec` runs
      from `packages/core`, but the artifact is written to the repository root,
      so a bare `catchme.vsix` fails with `ENOENT`. See ADR-0018.
- [ ] **Re-run the extension-host tests** (`pnpm --filter catchme run
    test:integration`). They last passed before the call-chain work landed.
      Risk is low — they assert on the API surface, not tree contents, which the
      47 smoke checks cover — but the gap is real.

## Dependency hygiene

- [ ] **`@types/node` is inconsistent across the workspace.** Root,
      `provider-lsp` and `testkit` are on `^26.4.0`; `core` and `provider-java`
      are still on `^22.7.0`. Dependabot bumped some and not others, so packages
      typecheck against different Node surfaces.
- [ ] **Keep `@types/vscode` pinned to `engines.vscode`.** Both are `1.105.0`
      as of 2026-09-06 and must move together: `vsce package` hard-fails when
      the types exceed the engine floor, and types _below_ it would under-report
      what the oldest supported editor offers. `dependabot.yml` ignores the
      package for this reason, so floor bumps are manual and deliberate. The
      _newest_ published version is pinned separately in
      `tools/vscode-types-latest/package.json` and is Dependabot-managed. Both
      are compiled by `pnpm test` and both block. When a Dependabot pull request
      on that manifest goes red, the fix belongs here — record the breakage and
      adapt the source, rather than raising the floor or skipping past the bad
      version. `pnpm run typecheck:vscode-api` runs the same check on its own.
      See ADR-0019 and `tools/vscode-types-latest/README.md`.
- [ ] **Require the CI check in branch protection.** The `@types/vscode`
      canary above only works if a red pull request actually stops:
      `automerge.yml` calls `gh pr merge --auto`, which waits for _required_
      status checks and merges immediately when none are configured. Until the
      `Node (build, lint, unit tests)` check is required on `main`, a breaking
      upstream bump would merge itself and the warning would be lost.

- [ ] **The `.vsix` ships build noise and no licence.** `vsce package` reports
      `LICENSE, LICENSE.md, or LICENSE.txt not found` — the file lives at the
      repository root, outside the packaged directory — and the archive includes
      `.turbo/turbo-{build,lint,test}.log` plus `.vscode-test.mjs`. Add
      `.turbo/**` and `.vscode-test.mjs` to `packages/core/.vscodeignore`, and
      copy or symlink the licence into `packages/core/`.

## Coverage gaps

- [ ] **Interprocedural Java fixtures beyond the happy path.** `Propagation.java`
      covers a two-hop escape into a handler. Nothing yet exercises multi-catch,
      try-with-resources, or a `finally` _across_ method boundaries — only
      within one method (`BasicHandlers.java`).
- [ ] **A non-Java fixture.** `fixtures/` has one language. The generic provider
      is covered by unit tests but never by an end-to-end fixture run, so the
      conformance kit has never been exercised against a second language.
- [ ] **Wire the conformance kit into CI.** `runConformance` is implemented and
      unit-tested, but no CI job actually runs it over `fixtures/` with a live
      provider.

## Known limitations worth revisiting

- [ ] **The engine's `visited` set is global, not per-path.** When two chains
      converge on the same call site only the first continues, so results are
      _representative_ routes rather than exhaustive ones. Deliberate (it bounds
      cyclic and diamond-shaped graphs), but if users report missing paths this
      is the cause. See ADR-0010 and the comment in
      `packages/core/src/engine/interproceduralEngine.ts`.
- [ ] **Generic provider is brace-only.** Python's indent-based `try`/`except`
      needs a separate scanner; the language list deliberately excludes it
      rather than claiming broken support.
- [ ] **jdt.ls is pinned to a dated snapshot repository**
      (`1.60.0.202606262232`). Bump deliberately — Dependabot cannot see p2
      repositories, so this will never be flagged automatically.

## Housekeeping

- [ ] **Narrow the super-linter prose rules.** The `ci(super-linter): linting`
      pass rewrote link text (`[README]` → `[Readme]`), expanded "VS Code" to
      "Visual Studio Code" inside product names, and broke a continuation indent
      in this file. Prose rules that rewrite proper nouns and link text cost
      more than they return.
- [ ] **Prune `packages/core/.vscode-test/`** occasionally. `vscode-test`
      downloads whatever Visual Studio Code version is current, so builds
      accumulate — currently 2.7 GB across three (1.135.0, 1.136.0, 1.136.1).
      Gitignored, local only. Pinning a version would stop the growth but would
      also have hidden the 1.110+ binary-rename break, so leaving it unpinned is
      the deliberate choice.

## Standing rules

Not closeable, but easy to forget:

- **Commit `pnpm-lock.yaml` whenever dependencies change.** CI uses
  `--frozen-lockfile` and will fail on drift.
- **Run `pnpm run typecheck` before pushing.** `pnpm run build` bundles
  `packages/core` with esbuild, which strips types without checking them, so the
  build alone cannot catch a type error there.
