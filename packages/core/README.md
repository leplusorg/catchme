# CatchMe — Exception Flow Explorer

Answer two questions that editors normally leave you guessing about:

1. **Where can this exception be caught?** Right-click a `throw` and see every
   handler it can reach — including handlers in _callers_, after it escapes the
   current function.
2. **What if I threw one here?** Right-click _anywhere_, pick an exception type,
   and see where it would land. No code changes, no debugger.

## Features

**Find Where This Is Caught** — available on `throw` statements. Traces the
exception through enclosing `try` blocks and then up the call graph, and shows
each handler it can reach.

**Simulate Exception From Here…** — available anywhere. Pick a type from the
Quick Pick (in-scope and imported types first) and run the same analysis for a
hypothetical throw at the cursor.

Results appear in the **Exception Flow** view, grouped by **destination** —
where the exception can end up — with the call chain that reaches each one
underneath:

```
🔥 IOException                        2 destinations · 3 paths
  ✓ catch (IOException e)          Service.java:88 · definite
      🔥 throw IOException                Repo.java:42
      ↑  Repo.load()        called at Service.java:71
      ✓  catch (IOException e)         Service.java:88
  ~ catch (Exception e)                Api.java:23 · possible
```

Every hop shows **where it was called from** and jumps straight to that call
site. When several chains converge on one handler they collapse into a single
destination; a lone chain skips the intermediate node entirely. Library frames
fold into one `… N library frames` node, and a search stopped by the depth cap
ends in an **expand further** action that re-runs it deeper.

Right-click any node for **Copy Path as Stack Trace** — handy for pasting into
an issue. A Peek also opens at the first handler for quick navigation.

### Results are labelled honestly

Static exception analysis cannot be exact in the presence of virtual dispatch,
lambdas, reflection, or dynamic typing. CatchMe never pretends otherwise:

- ✓ **definite** — the handler certainly applies.
- ~ **possible** — approximate (e.g. reached through virtual dispatch, or the
  language provides no type information).

A chain is rated by its **weakest hop**: one approximate step makes the whole
route `possible`, even if the final type match is exact. A _destination_,
though, is rated by its **best** route — reachability is a question of whether
_any_ chain gets there.

A language backend without real type information is _structurally prevented_
from reporting `definite`.

## Requirements

| Language | Requirement                                                                                                                           | Precision  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Java     | [Language Support for Java by Red Hat](https://marketplace.visualstudio.com/items?itemName=redhat.java), running in **Standard** mode | `definite` |
| Others   | The language's own extension, if it implements LSP Call Hierarchy                                                                     | `possible` |

Red Hat's Java extension is intentionally _not_ a hard dependency, so non-Java
users can install CatchMe without it.

## Commands

| Command                                  | Where                                      |
| ---------------------------------------- | ------------------------------------------ |
| CatchMe: Find Where This Is Caught       | Editor context menu, on a `throw`          |
| CatchMe: Simulate Exception From Here…   | Editor context menu, any supported file    |
| CatchMe: Re-run Analysis / Clear Results | Exception Flow view toolbar                |
| CatchMe: Copy Path as Stack Trace        | Right-click a result, path, or destination |
| CatchMe: Expand Further                  | The "depth limit reached" node             |

## Settings

| Setting                               | Default    | Meaning                                 |
| ------------------------------------- | ---------- | --------------------------------------- |
| `catchme.analysis.maxDepth`           | `8`        | Interprocedural hop limit               |
| `catchme.analysis.precision`          | `possible` | `definite` / `possible` / `all`         |
| `catchme.analysis.includeLibraryCode` | `false`    | Follow into dependencies and stdlib     |
| `catchme.analysis.timeoutMs`          | `15000`    | Time budget; partial results are kept   |
| `catchme.view.autoPeek`               | `true`     | Peek the first handler after analysis   |
| `catchme.diagnostics.reportUncaught`  | `false`    | Report uncaught results in Problems     |
| `catchme.providerOverrides`           | `{}`       | Force a specific engine per language ID |

---

# For contributors

> Everything below is repo documentation. The sections above are what ships as
> the Marketplace listing (vsce publishes this file as the extension's page).

## The one rule

**No file under `src/` may import a language-specific module.** All language
knowledge lives behind `ExceptionFlowProvider`
([`@leplusorg/catchme-api`](../api)). If you find yourself wanting to special-case
Java here, it belongs in [`provider-java`](../provider-java) instead.

## Source layout

| Path               | Responsibility                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `src/extension.ts` | `activate()`: wires everything, returns the public `CatchMeApi`                                                            |
| `src/registry/`    | Provider registration, language selection, precision ranking, lazy activation of third-party provider extensions           |
| `src/engine/`      | The language-agnostic interprocedural walk over LSP Call Hierarchy; depth caps, dedup, timeouts, and precision downgrading |
| `src/commands/`    | Interaction only — Quick Pick, progress, cancellation, Peek                                                                |
| `src/ui/`          | The Exception Flow tree (`TreeDataProvider`)                                                                               |
| `src/context/`     | The `catchme.onThrowStatement` / `catchme.supportedLanguage` context keys that gate the menus (debounced + cached)         |

The built-in providers are registered in `extension.ts` **through the public
API**, exactly as a third-party extension would — dogfooding the contract.

## Build

```sh
pnpm --filter catchme build     # esbuild bundle → dist/extension.js
pnpm --filter catchme package   # vsce → catchme.vsix
```

`server/` holds the bundled jdt.ls analyzer jar, produced from
[`server-java/`](../../server-java) — see [`server/README.md`](server/README.md).

Press <kbd>F5</kbd> (or use the _Run Extension (with Java fixture)_ launch
config) to debug against [`fixtures/java`](../../fixtures/java).
