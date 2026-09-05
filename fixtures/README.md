# `fixtures/` — test projects

Small annotated projects, one directory per language, used by two consumers:

- **`@leplusorg/catchme-provider-testkit`** — the conformance suite reads the
  annotations and asserts a provider's `FlowResult` matches.
- **Core integration tests** — `@vscode/test-electron` opens a fixture directory
  as the workspace, runs the commands, and checks the tree and Peek contents.

They live at the repository root rather than inside a package because both
consumers need them, and because a fixture must be a **real project on disk** for
a language server to index it.

## Annotation format

Expectations are trailing comments on the relevant line, so a fixture is
simultaneously readable source and a test specification:

| Annotation | Meaning |
|---|---|
| `@throws <typeId>` | The throw site to analyse, and its type |
| `@caught [definite\|possible]` | This line is the expected handler |
| `@escapes` | Expected to leave the enclosing function |
| `@uncaught` | Expected to reach a top-level boundary |
| `@unknown` | Analysis is expected to stop here |

## Conventions

**Hermetic over conventional.** Prefer fixtures a language server can import
with **no network access and no build step**. For Java that means shipping
Eclipse metadata (`.project` + `.classpath`) instead of a `pom.xml` — jdt.ls
reads those natively, whereas a build file triggers its embedded Maven importer,
which may fetch plugin descriptors on first import. See
[`java/README.md`](java/README.md).

**JDK/stdlib types only.** A fixture that needs third-party dependencies drags a
dependency-resolution step into CI. Design around it where you can; if you truly
can't, that fixture gets a real build file and should be isolated from the fast
ones.

**One concept per method.** Each case should isolate a single rule (supertype
match, innermost-wins, multi-catch, throw-inside-catch, …) so a failure names
the broken rule.

## Languages

| Directory | Import mechanism | Notes |
|---|---|---|
| [`java/`](java) | Eclipse `.project` + `.classpath` | Six intraprocedural cases |

Adding a language: create `fixtures/<lang>/`, make it importable with the least
machinery that works, and document the choice in a local `README.md`.
