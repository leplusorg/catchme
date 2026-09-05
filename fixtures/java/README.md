# Java conformance fixtures

Annotated sources used by `@leplusorg/catchme-provider-testkit` and the core
integration tests. See the annotation format in `BasicHandlers.java`.

## Why there is no `pom.xml` / `build.gradle`

This project deliberately ships **Eclipse metadata** (`.project` + `.classpath`)
instead of a build file.

jdt.ls imports Eclipse projects natively — it reads the two XML files and is
done. Give it a `pom.xml` instead and it runs its embedded Maven (m2e) importer,
which can reach out to the network for lifecycle plugin descriptors on first
import. For a fixture with **no external dependencies** (only JDK types), that
buys nothing and costs determinism: slower CI and an occasional flake.

So the rule for fixtures here is: **hermetic and offline over conventional.**

If you add a fixture that genuinely needs third-party dependencies, that one
should get a real build file — but prefer JDK-only fixtures where possible.

## Gotchas

- Source root is `src/main/java`, declared in `.classpath`. Adding a new source
  tree means adding a `<classpathentry kind="src" …>` entry.
- The JRE container is intentionally unpinned so any JDK jdt.ls runs on works.
- `bin/` is the compile output and is gitignored.
