# `@types/vscode` latest-version marker

This directory holds one dependency and no code. It exists so that Dependabot
can track the newest published `@types/vscode` **without** touching the version
the extension actually compiles and ships against.

## Why it is a separate manifest

The five workspace packages pin `@types/vscode` to exactly `engines.vscode` —
the oldest editor CatchMe supports. That pin is not an ordinary dependency but
a declaration of which editor APIs the compiler will accept, and it may only
move when the floor moves, by hand. `.github/dependabot.yml` therefore ignores
`@types/vscode` for the workspace at `/`.

That ignore is by dependency **name**, and it applies to the whole update job.
An npm alias (`"something": "npm:@types/vscode@1.136.0"`) would not escape it:
Dependabot resolves aliases to the aliased-to package and would record the name
as `@types/vscode` again. A second manifest in its own directory is the only
way to give the same package two independently managed versions, because each
`updates:` entry in `dependabot.yml` is a separate job with its own ignore list.

`pnpm-workspace.yaml` globs `packages/*` and `site`, so `tools/` is outside the
workspace: pnpm never installs this manifest, it is absent from
`pnpm-lock.yaml`, and it cannot affect what the extension builds against.
Dependabot does not need a lockfile to update a `package.json`.

## What it drives

`scripts/check-vscode-api.mjs` reads the version from here and compiles the
whole workspace against it, alongside the pinned floor. Both are part of
`pnpm test`. See ADR-0019.

## When Dependabot opens a pull request here

That pull request *is* the early-warning signal, and CI runs the compile on it:

- **Green** — the new editor API surface is compatible. Merge it. Nothing else
  changes; the shipped extension still targets the floor.
- **Red** — upstream published a breaking change. Do not raise the floor to
  make it pass and do not merge blindly. Record the breakage in `TODO.md`,
  then either adapt the source or leave the pull request open as the tracking
  issue until the API settles.

Bumping this version never changes what users install.
