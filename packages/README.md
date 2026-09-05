# `packages/` — the TypeScript workspace

pnpm workspace containing the Visual Studio Code extension and its npm packages. The Java
half of the project lives outside this tree, in
[`server-java/`](../server-java), because it uses an entirely different
toolchain.

## The packages

| Package                           | npm name                              | Ships as              | Purpose                                                   |
| --------------------------------- | ------------------------------------- | --------------------- | --------------------------------------------------------- |
| [`api/`](api)                     | `@leplusorg/catchme-api`              | npm                   | The public provider contract. Types only.                 |
| [`core/`](core)                   | —                                     | Marketplace (`.vsix`) | The extension: UI, orchestration, interprocedural engine. |
| [`provider-java/`](provider-java) | —                                     | bundled into core     | Deep Java backend via jdt.ls.                             |
| [`provider-lsp/`](provider-lsp)   | —                                     | bundled into core     | Generic baseline for any language.                        |
| [`testkit/`](testkit)             | `@leplusorg/catchme-provider-testkit` | npm                   | Conformance suite for provider authors.                   |

## Dependency edges

```
        ┌─────────────┐
        │     api     │   ← the only thing providers may depend on
        └──────┬──────┘
     ┌─────────┼──────────┬──────────────┐
     ▼         ▼          ▼              ▼
provider-lsp  provider-java   testkit   (3rd-party providers)
     └─────────┬──────────┘
               ▼
             core          ← bundles the two built-in providers via esbuild
```

The important edge is what's **missing**: neither provider depends on `core`.
They see the same public API a third-party extension would, so the plugin
boundary is enforced by the compiler rather than by convention. If a change to
`api` makes `provider-java` impossible to write, the build breaks — which is
exactly when we want to find out.

`provider-lsp` and `provider-java` are separate packages purely to hold that
boundary. They are not published; esbuild inlines them into the extension
bundle. Collapsing them into `core/src/providers/` would be user-invisible — and
would quietly lose the guarantee.

## Build order

Enforced by `turbo.json` (`dependsOn: ["^build"]`) and by TypeScript project
references in each `tsconfig.json`:

```
api → { provider-lsp, provider-java, testkit } → core
```

```sh
pnpm install
pnpm build                      # whole graph, in order
pnpm --filter catchme package   # → catchme.vsix
```

## Adding a package

1. Create `packages/<name>/` with a `package.json` and a `tsconfig.json` that
   extends `../../tsconfig.base.json`.
2. Add a project reference in the dependent packages' `tsconfig.json` and in the
   root `tsconfig.json`.
3. If it is a provider, depend on `@leplusorg/catchme-api` **only**.
