# `@leplusorg/catchme-provider-lsp`

The **generic provider** — baseline exception-flow support for any language,
with no language-specific work.

Bundled into the `catchme` extension (not published separately).

## The idea

Most languages have a language server but no reachable semantic API. This
provider gets useful results anyway by splitting the problem:

| Half                                                | How                                                    | Precision                     |
| --------------------------------------------------- | ------------------------------------------------------ | ----------------------------- |
| Intraprocedural (find the handler in this function) | a comment/string-aware **brace scanner** (`syntax.ts`) | syntactic → `possible`        |
| Interprocedural (who calls this?)                   | **LSP Call Hierarchy**, driven by the core             | as good as the server's index |

The scanner is deliberately dependency-free rather than grammar-based: no
per-language Wasm to ship, and it works for every brace-style language at once.
It can be swapped for tree-sitter later without touching the provider interface.

What it does take seriously is not being fooled by text — comments and string
literals are blanked (offsets preserved) before any scanning, so a `catch`
inside a string cannot invent a phantom handler. It also honours the rule a
naive scanner gets wrong: a throw inside a `catch` or `finally` is **not**
handled by that same `try`.

The second half is the interesting one. `prepareCallHierarchy` /
`incomingCalls` are _standard_ LSP requests implemented by many servers
(Java, C#, C/C++, Rust, TypeScript…), so the cross-function walk is genuinely
language-neutral and lives in the core engine — not here.

## Why `interprocedural: false`

This provider deliberately declares:

```ts
{ intraprocedural: true, interprocedural: false, typeHierarchy: false,
  simulate: true, precision: 'possible', engine: 'Generic LSP + tree-sitter' }
```

`interprocedural: false` hands the caller-walk to
`core/src/engine/interproceduralEngine.ts`, which repeatedly calls this
provider's `resolveAtCallSite` as it climbs. That inversion is the whole point
of the two-tier design: one traversal implementation, reused by every language
that can't afford its own.

## Honest limits

Without type bindings there is no reliable subtype matching — a
`catch (BaseError)` handling a thrown `SubError` cannot be confirmed. Handler
matching therefore compares **simple names**, with one pragmatic concession:
well-known roots (`Exception`, `Throwable`, `Error`, `RuntimeException`,
`BaseException`) are treated as catch-alls, because excluding them would hide
the single most common real handler. Hence `typeHierarchy: false`, and the core
**enforces** that no result from this provider is ever labelled `definite`.

`findEnclosingFunction` is likewise approximate: without a grammar it cannot
distinguish a method from an `if`. It only places the `escapes-function`
marker; the cross-function walk itself relies on LSP Call Hierarchy.

Exception models also differ sharply by language (dynamic types in Python/JS,
value-based errors in Go/Rust). This provider targets the `try`/`catch`-shaped
subset — brace-style languages only. Python's indent-based `try`/`except` needs
a separate scanner and is not claimed yet.

## Upgrading a language

Nothing here needs to change when a language graduates. Ship a deep provider
for it (as `provider-java` does), declare higher `precision`, and the registry
prefers it automatically — see `core/src/registry/providerRegistry.ts`.
