# `@leplusorg/catchme-api`

The **public contract** every CatchMe exception-flow provider implements.
Types-only (plus a couple of constants) — no runtime behaviour lives here.

Published to npm so third-party extensions can add a language without this
repository knowing anything about it.

## Why this is a separate package

The first-party providers (`provider-java`, `provider-lsp`) depend on **this
package and nothing internal**. The compiler therefore guarantees they cannot
reach into `core`. If the public API were too weak to build the Java provider,
the build would fail immediately — so the extensibility story is verified by
construction rather than by good intentions.

## What's in it

| Group             | Exports                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| Data model        | `ExceptionTypeRef`, `ThrowSite`, `Sink`, `SinkKind`, `Confidence`, `PropagationPath` |
| Requests          | `FlowRequest`, `AnalysisOptions`, `FlowResult`, `FlowProgress`                       |
| Provider          | `ExceptionFlowProvider`, `ProviderCapabilities`                                      |
| Extension API     | `CatchMeApi`                                                                         |
| Errors / defaults | `ProviderNotReadyError`, `DEFAULT_ANALYSIS_OPTIONS`                                  |

## Contract rules

These are not suggestions — the conformance kit
(`@leplusorg/catchme-provider-testkit`) asserts them:

- **Async and cancellable.** Every method honours its `CancellationToken`.
- **Read-only.** Analysis must never mutate the workspace.
- **Terminal paths.** Every `PropagationPath` ends in `caught`, `uncaught`, or
  `unknown`. `escapes-function` is only ever an _intermediate_ step.
- **Honest precision.** A provider declaring `typeHierarchy: false` must never
  emit a `definite` sink. The core defensively downgrades if you do.
- **Readiness.** Throw `ProviderNotReadyError` when your backend is still
  starting; the core shows a retry affordance instead of an error.

## Usage from a third-party extension

```ts
import type { CatchMeApi, ExceptionFlowProvider } from "@leplusorg/catchme-api";

const catchme = await vscode.extensions
  .getExtension<CatchMeApi>("leplusorg.catchme")!
  .activate();
context.subscriptions.push(catchme.registerProvider(myProvider));
```

To get activated on demand, also declare the language in your manifest:

```jsonc
"contributes": {
  "exceptionFlowProviders": [
    { "language": "ruby", "extensionId": "you.catchme-ruby" }
  ]
}
```

## Notes

- `@types/vscode` is a **devDependency**, not a dependency: the API surface uses
  `vscode` types, but the consuming extension supplies its own copy.
- `CatchMeApi.version` is bumped only on breaking changes; additive changes keep
  it stable.
