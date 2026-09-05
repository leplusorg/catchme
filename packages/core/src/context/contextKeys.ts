/**
 * Context keys that gate the editor context-menu items.
 *
 *   catchme.supportedLanguage — a provider exists for the active language.
 *   catchme.onThrowStatement  — the caret sits on a throw site (Feature 1).
 *
 * The second key calls into the provider on every selection change, so it is
 * debounced and cached per (uri, version, line). Providers are contractually
 * required to make `resolveThrowSite` cheap for exactly this reason.
 */
import * as vscode from "vscode";
import type { ProviderRegistry } from "../registry/providerRegistry";

const DEBOUNCE_MS = 150;

export class ContextKeyManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private inFlight: vscode.CancellationTokenSource | undefined;
  private cacheKey = "";
  private cacheValue = false;

  constructor(private readonly registry: ProviderRegistry) {}

  start(): void {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshAll()),
      vscode.window.onDidChangeTextEditorSelection((e) =>
        this.scheduleThrowSiteCheck(e.textEditor),
      ),
      this.registry.onDidChangeProviders(() => this.refreshAll()),
    );
    this.refreshAll();
  }

  private refreshAll(): void {
    const editor = vscode.window.activeTextEditor;
    const supported = editor
      ? this.registry.supports(editor.document.languageId)
      : false;
    void setKey("catchme.supportedLanguage", supported);
    if (editor && supported) {
      this.scheduleThrowSiteCheck(editor);
    } else {
      void setKey("catchme.onThrowStatement", false);
    }
  }

  private scheduleThrowSiteCheck(editor: vscode.TextEditor): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.checkThrowSite(editor),
      DEBOUNCE_MS,
    );
  }

  private async checkThrowSite(editor: vscode.TextEditor): Promise<void> {
    const { document, selection } = editor;
    const key = `${document.uri.toString()}@${document.version}#${selection.active.line}`;
    if (key === this.cacheKey) {
      void setKey("catchme.onThrowStatement", this.cacheValue);
      return;
    }

    this.inFlight?.cancel();
    const source = new vscode.CancellationTokenSource();
    this.inFlight = source;

    try {
      const provider = await this.registry.getForLanguage(document.languageId);
      if (!provider || source.token.isCancellationRequested) return;

      const site = await provider.resolveThrowSite(
        document,
        selection.active,
        source.token,
      );
      if (source.token.isCancellationRequested) return;

      this.cacheKey = key;
      this.cacheValue = Boolean(site);
      void setKey("catchme.onThrowStatement", this.cacheValue);
    } catch {
      // Never let menu gating surface an error to the user.
      void setKey("catchme.onThrowStatement", false);
    } finally {
      source.dispose();
      if (this.inFlight === source) this.inFlight = undefined;
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.inFlight?.cancel();
    this.disposables.forEach((d) => d.dispose());
  }
}

function setKey(key: string, value: boolean): Thenable<unknown> {
  return vscode.commands.executeCommand("setContext", key, value);
}
