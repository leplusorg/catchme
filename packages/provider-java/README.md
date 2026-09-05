# `@leplusorg/catchme-provider-java`

The **Java provider** — CatchMe's deep-backend reference implementation.

Bundled into the `catchme` extension (not published separately).

## What it does _not_ do

Almost everything. This package is a thin **marshalling layer**: it forwards
requests to jdt.ls and maps JSON back onto the CatchMe data model. There is no
analysis logic in TypeScript — deliberately.

All real work happens in [`server-java/`](../../server-java), where the code
runs inside jdt.ls with the full Eclipse JDT API: an AST with **resolved type
bindings**, the type hierarchy, and the Java model. That's what lets this
provider claim `precision: 'definite'` — `catch (Exception)` genuinely matching
a thrown `IOException` requires real subtype knowledge that no syntactic
approach can supply.

## The bridge

```
JavaProvider (this package)
   └─ vscode.commands.executeCommand('java.execute.workspaceCommand', <id>, payload)
        └─ redhat.java
             └─ jdt.ls → CatchMeDelegateCommandHandler (server-java/)
```

Command IDs — **must stay in sync** with `server-java/plugin.xml`:

| ID                                   | Purpose                                     |
| ------------------------------------ | ------------------------------------------- |
| `catchme.java.resolveThrowSite`      | Feature 1 seed; also gates the context menu |
| `catchme.java.suggestExceptionTypes` | Quick Pick candidates for Feature 2         |
| `catchme.java.analyzeFlow`           | The analysis itself                         |

## Runtime requirements

- **`redhat.java` must be installed.** It is intentionally _not_ declared as an
  `extensionDependency` of the extension, so that non-Java users can still use
  the generic provider. This package checks at call time and raises
  `ProviderNotReadyError` with an install hint instead.
- **jdt.ls must be in `Standard` mode.** LightWeight mode has no resolved
  bindings and would silently produce wrong answers, so we refuse to run in it.
- **The analyzer jar must be present** at `packages/core/server/catchme.jdt.jar`
  (see `pnpm run build:server && pnpm run copy:server`).

## Capabilities

```ts
{ intraprocedural: true, interprocedural: true, typeHierarchy: true,
  simulate: true, precision: 'definite', engine: 'JDT (jdt.ls)' }
```

`interprocedural: true` means this provider walks callers **itself** (server-side,
via JDT's Call Hierarchy) and the core's traversal engine steps aside entirely.
Contrast with [`provider-lsp`](../provider-lsp), which delegates that walk.
