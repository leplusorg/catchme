# TODO

Actionable work items. The `README.md` files describe what the project **is**
and where it's **going**; this file tracks what still has to be **done**. Keep
them separate — a README that accumulates task lists goes stale silently, and a
reader can no longer tell current state from wishful thinking.

Roadmap-level direction lives in the root [README](README.md#roadmap). Items
here should be concrete enough to close.

---

## Before a Marketplace release

- [ ] **Create the `leplusorg` publisher** on the VS Code Marketplace *and* on
      [Open VSX](https://open-vsx.org). Both are required by `release.yml`;
      Open VSX is what serves VSCodium, Gitpod and Cursor users.
- [ ] **Add the repository secrets** `VSCE_PAT`, `OVSX_PAT` and `NPM_TOKEN`.
      Without them `release.yml` fails at the publish step, after having already
      built and tagged.
- [ ] **Re-run the extension-host tests** (`pnpm --filter catchme run
      test:integration`). They last passed before the call-chain work landed.
      Risk is low — they assert on the API surface, not tree contents, which the
      45 smoke checks cover — but the gap is real.
- [ ] **Commit `pnpm-lock.yaml` whenever dependencies change.** CI uses
      `--frozen-lockfile` and will fail on drift.

## Coverage gaps

- [ ] **Interprocedural Java fixtures beyond the happy path.** `Propagation.java`
      covers a two-hop escape into a handler. Nothing yet exercises multi-catch,
      try-with-resources, or a `finally` *across* method boundaries — only
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
      *representative* routes rather than exhaustive ones. Deliberate (it bounds
      cyclic and diamond-shaped graphs), but if users report missing paths this
      is the cause. See the comment in
      `packages/core/src/engine/interproceduralEngine.ts`.
- [ ] **Generic provider is brace-only.** Python's indent-based `try`/`except`
      needs a separate scanner; the language list deliberately excludes it
      rather than claiming broken support.
- [ ] **jdt.ls is pinned to a dated snapshot repo**
      (`1.60.0.202606262232`). Bump deliberately — Dependabot cannot see p2
      repositories, so this will never be flagged automatically.

## Housekeeping

- [ ] **Prune `packages/core/.vscode-test/`** occasionally. `vscode-test`
      downloads whatever VS Code version is current, so builds accumulate
      (~1 GB each). Gitignored, local only. Pinning a version would stop the
      growth but would also have hidden the 1.110+ binary-rename break, so
      leaving it unpinned is the deliberate choice.
