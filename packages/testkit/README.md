# `@leplusorg/catchme-provider-testkit`

Conformance suite for CatchMe exception-flow providers. Published to npm so
**third-party provider authors can verify their implementation** against the
same expectations the first-party providers must meet.

## Fixture annotations

Fixtures are ordinary source files in the target language, annotated with
trailing comments. The kit parses these and compares them to the provider's
`FlowResult`:

| Annotation                        | Meaning                                       |
| --------------------------------- | --------------------------------------------- |
| `// @throws <typeId>`             | Marks the throw site to analyse, and its type |
| `// @caught [definite\|possible]` | This line is the expected handler             |
| `// @escapes`                     | Expected to leave the enclosing function      |
| `// @uncaught`                    | Expected to reach a top-level boundary        |
| `// @unknown`                     | Analysis is expected to stop here             |

See [`fixtures/java`](../../fixtures/java) for a worked example.

## Invariants

Beyond fixture matching, `checkInvariants()` asserts rules that hold for **every
language**:

1. `capabilities.intraprocedural` is `true`.
2. A provider with `typeHierarchy: false` never emits a `definite` sink.
3. Every `PropagationPath` ends in a terminal sink.
4. `escapes-function` never appears as the final step.
5. Cancellation is honoured promptly.
6. Repeated identical requests give stable results.

## Usage

```ts
import { runConformance } from "@leplusorg/catchme-provider-testkit";

const report = await runConformance(
  myProvider,
  [{ name: "BasicHandlers.java", document }], // an opened vscode.TextDocument
  {
    strict: false, // also fail on sinks the fixture did not predict
    skip: ["cancellation"], // opt out of checks you cannot satisfy yet
    fail: (msg) => assert.fail(msg),
  },
);
// report: { total, passed, failures }
```

You pass an **already-opened `TextDocument`**, not a URI. That keeps this
package free of any `vscode` _runtime_ dependency, so the kit — and its own
tests — run in plain Node while integration hosts supply a real document.

The kit is assertion-library agnostic: pass a `fail` callback, or inspect the
returned `ConformanceReport`.

### What a run checks, per `@throws` site

1. `resolveThrowSite` finds a throw where the fixture says there is one.
2. The resolved type matches the annotation.
3. Every annotated sink is reported (`@escapes` is matched against
   intermediate steps, since it is never a terminal).
4. All `checkInvariants` rules hold.
5. Repeating an identical request gives an identical result.
6. An already-cancelled token settles within the budget instead of hanging.
