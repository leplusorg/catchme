/**
 * CatchMe extension entry point.
 *
 * Responsibilities kept here and nowhere else:
 *   - build the provider registry and register the built-in providers,
 *   - wire commands, context keys and the results view,
 *   - expose the public {@link CatchMeApi} so other extensions can plug in.
 *
 * Nothing in `src/` may import a language-specific module: all language
 * knowledge lives behind the ExceptionFlowProvider interface.
 */
import * as vscode from "vscode";
import type {
  CatchMeApi,
  FlowRequest,
  FlowResult,
} from "@leplusorg/catchme-api";
import { JavaProvider } from "@leplusorg/catchme-provider-java";
import { GenericLspProvider } from "@leplusorg/catchme-provider-lsp";

import { ProviderRegistry } from "./registry/providerRegistry";
import { InterproceduralEngine } from "./engine/interproceduralEngine";
import { registerCommands } from "./commands";
import { FlowTreeDataProvider } from "./ui/flowView";
import { UncaughtDiagnostics } from "./ui/diagnostics";
import { ContextKeyManager } from "./context/contextKeys";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<CatchMeApi> {
  const registry = new ProviderRegistry();
  const engine = new InterproceduralEngine(registry);
  const flowView = new FlowTreeDataProvider();
  const diagnostics = new UncaughtDiagnostics();

  // ---- built-in providers -------------------------------------------------
  // Registered through the *public* API surface, exactly as a third-party
  // extension would. If the API is not expressive enough for these, it is not
  // expressive enough for anyone.
  context.subscriptions.push(
    registry.register(new JavaProvider()),
    registry.register(new GenericLspProvider()),
  );

  // ---- UI -----------------------------------------------------------------
  const treeView = vscode.window.createTreeView("catchme.flowView", {
    treeDataProvider: flowView,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView, flowView, diagnostics);

  // ---- context keys that gate the menu items ------------------------------
  const contextKeys = new ContextKeyManager(registry);
  context.subscriptions.push(contextKeys);
  contextKeys.start();

  // ---- commands -----------------------------------------------------------
  context.subscriptions.push(
    ...registerCommands({ registry, engine, flowView, diagnostics }),
  );

  // ---- public API ---------------------------------------------------------
  const api: CatchMeApi = {
    version: 1,
    registerProvider: (provider) => registry.register(provider),
    analyze: (request: FlowRequest): Promise<FlowResult> =>
      engine.analyze(request),
    onDidChangeProviders: registry.onDidChangeProviders,
  };
  return api;
}

export function deactivate(): void {
  // All disposables are owned by the ExtensionContext.
}
