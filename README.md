# CatchMe

Exception Flow Explorer for Visual Studio Code.

**[Install from the Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=leplusorg.catchme)**
· [Open VSX](https://open-vsx.org/extension/leplusorg/catchme)
· [Homepage](https://leplusorg.github.io/catchme/)

CatchMe answers two questions your editor normally leaves you guessing about:

1. **Where can this exception be caught?** Right-click a `throw` and see every
   handler it can reach — including ones in _callers_, after it escapes the
   current function.
2. **What if I threw one here?** Right-click anywhere, pick an exception type,
   and see where it would land. No code edits, no debugger.

Editors already highlight `try`/`catch` pairs _within_ one function. The part
nobody does — following an exception **across** function boundaries to the
handler that actually catches it — is what this extension is for.

## How it works

Exception semantics differ enormously between languages, but "who calls this
function?" does not. CatchMe splits along exactly that line:

- A **language-agnostic core** owns the UI and the interprocedural walk, which
  runs on standard **LSP Call Hierarchy** and therefore works for any language
  whose server implements it.
- **Pluggable providers** own language semantics — what a throw is, and which
  handler catches which type.

Providers come in two tiers. A _deep_ provider (Java, via Eclipse JDT running
inside jdt.ls) has real type bindings and can answer **definitively**. A
_generic_ provider parses syntax only, so it answers `possible` — and the core
structurally prevents it from claiming otherwise. Adding a language means
writing a provider, not touching the core.

The reasoning behind this split — and behind every other significant choice,
including what each one cost — is recorded in [ADR.md](ADR.md).

## Repository layout

| Path                              | Contents                                                                |
| --------------------------------- | ----------------------------------------------------------------------- |
| [`packages/`](packages)           | The TypeScript workspace — extension, provider API, providers, test kit |
| [`packages/api/`](packages/api)   | `@leplusorg/catchme-api` — the public provider contract                 |
| [`packages/core/`](packages/core) | The Visual Studio Code extension itself                                            |
| [`server-java/`](server-java)     | The Eclipse JDT analyzer that runs inside jdt.ls (Maven/Tycho)          |
| [`fixtures/`](fixtures)           | Annotated test projects, one per language                               |

Each directory has its own `README.md` explaining the decisions behind it.

## Getting started

```sh
pnpm install
pnpm build
```

Then press <kbd>F5</kbd> — the _Run Extension (with Java fixture)_ launch config
opens [`fixtures/java`](fixtures/java) in a development host.

To build the Java analyzer (needed for real Java results):

```sh
pnpm run build:server && pnpm run copy:server
```

This requires Maven; the wrapper belongs in
[`server-java/`](server-java#build). Without it, every other language still
works through the generic provider — the Java provider simply reports that its
backend is unavailable.

## Requirements

| Language | Requirement                                                                                                                  | Precision  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Java     | [Language Support for Java by Red Hat](https://marketplace.visualstudio.com/items?itemName=redhat.java) in **Standard** mode | `definite` |
| Others   | The language's extension, if it implements LSP Call Hierarchy                                                                | `possible` |

Red Hat's Java extension is deliberately not a hard dependency, so non-Java
users can install CatchMe without it.

## Roadmap

More providers? C#, C/C++, Python (indent-based `try`/`except`)...

Concrete open work items live in [Todo.md](TODO.md).

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

Writing a provider for a new language? Start with
[`packages/api/README.md`](packages/api/README.md) and validate against
[`@leplusorg/catchme-provider-testkit`](packages/testkit).

Before changing something that looks odd, check [ADR.md](ADR.md) — it usually
explains why. The record is append-only: to revisit a decision, add one that
supersedes it rather than editing the original.

## Security

Please read [SECURITY.md](SECURITY.md) for details on our security policy and how to report security vulnerabilities.

## Code of Conduct

Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for details on our code of conduct.

## License

This project is licensed under the terms of the [LICENSE](LICENSE) file.
