/**
 * Command handlers. These own the *interaction* (quick picks, progress,
 * cancellation, peek) and delegate all analysis to the engine.
 */
import * as vscode from "vscode";
import {
  DEFAULT_ANALYSIS_OPTIONS,
  ProviderNotReadyError,
  type AnalysisOptions,
  type ExceptionTypeRef,
  type FlowRequest,
  type FlowResult,
  type ThrowSite,
} from "@leplusorg/catchme-api";
import type { ProviderRegistry } from "../registry/providerRegistry";
import type { UncaughtDiagnostics } from "../ui/diagnostics";
import type { InterproceduralEngine } from "../engine/interproceduralEngine";
import {
  formatPathAsStackTrace,
  pathsForCopy,
  type FlowNode,
  type FlowTreeDataProvider,
} from "../ui/flowView";

interface Deps {
  readonly registry: ProviderRegistry;
  readonly engine: InterproceduralEngine;
  readonly flowView: FlowTreeDataProvider;
  readonly diagnostics: UncaughtDiagnostics;
}

export function registerCommands(deps: Deps): vscode.Disposable[] {
  let lastRequest: FlowRequest | undefined;

  const run = async (
    throwSite: ThrowSite,
    overrides?: Partial<AnalysisOptions>,
  ): Promise<void> => {
    const request: FlowRequest = {
      throwSite,
      options: { ...readOptions(), ...overrides },
    };
    lastRequest = request;

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `CatchMe: tracing ${throwSite.exceptionType.label}…`,
        cancellable: true,
      },
      async (progress, token) =>
        deps.engine.analyze(
          request,
          { report: (p) => progress.report({ message: p.message ?? "" }) },
          token,
        ),
    );

    deps.flowView.setResult(result);
    deps.diagnostics.update(result);
    await maybePeek(result);
  };

  return [
    vscode.commands.registerCommand("catchme.findCatchers", async () => {
      await guarded(async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const provider = await deps.registry.getForLanguage(
          editor.document.languageId,
        );
        if (!provider) {
          void vscode.window.showInformationMessage(
            `CatchMe has no provider for '${editor.document.languageId}'.`,
          );
          return;
        }
        const site = await provider.resolveThrowSite(
          editor.document,
          editor.selection.active,
          tokenSource().token,
        );
        if (!site) {
          void vscode.window.showInformationMessage(
            'Place the cursor on a throw statement, or use "Simulate Exception From Here…".',
          );
          return;
        }
        await run(site);
      });
    }),

    vscode.commands.registerCommand("catchme.simulateThrow", async () => {
      await guarded(async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const provider = await deps.registry.getForLanguage(
          editor.document.languageId,
        );
        if (!provider?.capabilities.simulate) {
          void vscode.window.showInformationMessage(
            "Simulating exceptions is not supported for this language.",
          );
          return;
        }
        const suggestions =
          (await provider.suggestExceptionTypes(
            editor.document,
            editor.selection.active,
            tokenSource().token,
          )) ?? [];

        const picked = await pickExceptionType(suggestions);
        if (!picked) return;

        await run({
          uri: editor.document.uri,
          range: new vscode.Range(
            editor.selection.active,
            editor.selection.active,
          ),
          exceptionType: picked,
          simulated: true,
        });
      });
    }),

    vscode.commands.registerCommand("catchme.rerun", async () => {
      if (lastRequest) await guarded(() => run(lastRequest!.throwSite));
    }),

    vscode.commands.registerCommand("catchme.clear", () => {
      deps.flowView.clear();
      deps.diagnostics.clear();
    }),

    // Invoked from the "depth limit reached" node. Re-runs the same throw site
    // with a deeper cap; `fromDepth` is where this particular chain stopped, so
    // a shallow path does not have to inherit a huge global cap.
    vscode.commands.registerCommand(
      "catchme.expandPath",
      async (fromDepth?: number) => {
        if (!lastRequest) return;
        const current = lastRequest.options.maxDepth;
        const stoppedAt = typeof fromDepth === "number" ? fromDepth : current;
        const maxDepth = Math.max(current * 2, stoppedAt + 4);
        await guarded(() => run(lastRequest!.throwSite, { maxDepth }));
      },
    ),

    vscode.commands.registerCommand(
      "catchme.copyPath",
      async (node?: FlowNode) => {
        const selection = pathsForCopy(node);
        if (!selection || selection.paths.length === 0) {
          void vscode.window.showInformationMessage(
            "CatchMe: nothing to copy for that item.",
          );
          return;
        }
        const text = selection.paths
          .map((p) => formatPathAsStackTrace(p, selection.result))
          .join("\n\n");
        await vscode.env.clipboard.writeText(text);
        void vscode.window.showInformationMessage(
          `CatchMe: copied ${selection.paths.length} path${selection.paths.length === 1 ? "" : "s"} to the clipboard.`,
        );
      },
    ),
  ];
}

// ---------------------------------------------------------------------------

async function pickExceptionType(
  suggestions: readonly ExceptionTypeRef[],
): Promise<ExceptionTypeRef | undefined> {
  type Item = vscode.QuickPickItem & { value?: ExceptionTypeRef };
  const items: Item[] = suggestions.map((t) => ({
    label: t.label,
    description: t.id,
    detail: t.kind && t.kind !== "unknown" ? t.kind : undefined,
    value: t,
  }));
  items.push({ label: "$(edit) Enter a fully-qualified type name…" });

  const choice = await vscode.window.showQuickPick(items, {
    title: "Simulate which exception?",
    placeHolder: "Pick an exception type to throw from the cursor",
    matchOnDescription: true,
  });
  if (!choice) return undefined;
  if (choice.value) return choice.value;

  const typed = await vscode.window.showInputBox({
    title: "Simulate exception",
    prompt: "Fully-qualified exception type",
    value: "java.lang.RuntimeException",
  });
  return typed
    ? { label: typed.split(".").pop() ?? typed, id: typed }
    : undefined;
}

async function maybePeek(result: FlowResult): Promise<void> {
  if (
    !vscode.workspace
      .getConfiguration("catchme")
      .get<boolean>("view.autoPeek", true)
  )
    return;
  const editor = vscode.window.activeTextEditor;
  const targets = result.terminals
    .filter((s) => s.kind === "caught")
    .map((s) => s.location);
  if (!editor || targets.length === 0) return;

  await vscode.commands.executeCommand(
    "editor.action.showReferences",
    editor.document.uri,
    result.throwSite.range.start,
    targets,
  );
}

function readOptions(): AnalysisOptions {
  const cfg = vscode.workspace.getConfiguration("catchme.analysis");
  return {
    maxDepth: cfg.get("maxDepth", DEFAULT_ANALYSIS_OPTIONS.maxDepth),
    precision: cfg.get("precision", DEFAULT_ANALYSIS_OPTIONS.precision),
    includeLibraryCode: cfg.get(
      "includeLibraryCode",
      DEFAULT_ANALYSIS_OPTIONS.includeLibraryCode,
    ),
    timeoutMs: cfg.get("timeoutMs", DEFAULT_ANALYSIS_OPTIONS.timeoutMs),
  };
}

function tokenSource(): vscode.CancellationTokenSource {
  return new vscode.CancellationTokenSource();
}

/** Turn ProviderNotReadyError into a retry affordance rather than a stack trace. */
async function guarded(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProviderNotReadyError) {
      const retry = "Retry";
      const choice = await vscode.window.showWarningMessage(
        err.hint ? `${err.message} ${err.hint}` : err.message,
        retry,
      );
      if (choice === retry) await guarded(fn);
      return;
    }
    void vscode.window.showErrorMessage(
      `CatchMe: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
