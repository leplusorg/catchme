# `server-java` — the JDT analyzer

The Java half of CatchMe. This is an **OSGi bundle that runs inside jdt.ls**,
not a standalone program and not a plain jar.

## Why a whole separate toolchain

The TypeScript extension can reach jdt.ls only through LSP, and LSP has no
request for "give me the AST" or "resolve this type binding." Precise Java
answers need exactly those. So this bundle is loaded *into* the language server,
where it has the full Eclipse JDT API: `ASTParser` with resolved bindings, the
type hierarchy, the Java model, and JDT's Call Hierarchy.

That's why the repository is polyglot: this directory is Maven/Tycho/OSGi and
deliberately isolated from the pnpm workspace next door.

## How it is reached

```
packages/provider-java  ──'java.execute.workspaceCommand'──►  redhat.java
                                                                  │
                                                                  ▼
                                            CatchMeDelegateCommandHandler
```

`plugin.xml` registers an `org.eclipse.jdt.ls.core.delegateCommandHandler` for
three command ids. **They must stay in sync** with
`packages/provider-java/src/index.ts`:

- `catchme.java.resolveThrowSite`
- `catchme.java.suggestExceptionTypes`
- `catchme.java.analyzeFlow`

Everything returned must be plain JSON matching the model in
[`@leplusorg/catchme-api`](../packages/api).

## Build

```sh
cd server-java && ./mvnw -B verify        # → target/org.leplus.catchme.jdt-*.jar
```

Or from the repo root, which also installs it where the extension expects it:

```sh
pnpm run build:server && pnpm run copy:server   # → packages/core/server/catchme.jdt.jar
```

The Maven wrapper belongs **in this directory** (`mvnw`, `mvnw.cmd`, `.mvn/`),
because `mvnw` locates `.mvn/` by walking up from the current directory.

To exercise the built bundle against a real language server — it starts jdt.ls
as a plain Java process and drives the delegate commands over LSP, so it needs
neither VS Code nor a display:

```sh
pnpm --filter catchme run test:jdtls
```

## Constraints that bite

Tycho and the Eclipse platform enforce several rules that are easy to trip over:

- **`artifactId` must equal `Bundle-SymbolicName`** (`org.leplus.catchme.jdt`).
- **The Maven version must match `Bundle-Version`**, mapping `-SNAPSHOT` ↔
  `.qualifier` (`1.0.0-SNAPSHOT` ↔ `1.0.0.qualifier`).
- **`JavaSE-21` is the floor.** Recent Eclipse platforms require it; building
  against a `JavaSE-17` execution environment fails to resolve SWT/UI bundles.
- **`project.build.outputTimestamp` must always parse.** It defaults to a
  literal instant here; the `source-date-epoch` profile substitutes
  `$SOURCE_DATE_EPOCH` when CI exports it. An unresolved `${env...}` breaks
  Tycho's `build-qualifier` goal.
- **Dependencies come from `META-INF/MANIFEST.MF`**, resolved against the p2
  target platform in `pom.xml` — there is no `<dependencies>` section, and
  nothing to version-pin by hand.
