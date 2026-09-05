/**
 * Provider registry: owns the set of registered providers and decides which one
 * serves a given language.
 *
 * Selection rules (spec §4.3):
 *   1. Filter by `languageId`.
 *   2. Prefer the highest `capabilities.precision` ('definite' > 'possible').
 *   3. Break ties by registration order.
 *   4. A `catchme.providerOverrides` entry for the language overrides everything.
 */
import * as vscode from "vscode";
import type { ExceptionFlowProvider } from "@leplusorg/catchme-api";

/** Custom manifest key used for lazy activation of provider extensions. */
interface ProviderContribution {
  readonly language: string;
  readonly extensionId: string;
}

export class ProviderRegistry implements vscode.Disposable {
  private readonly providers: ExceptionFlowProvider[] = [];
  private readonly changed = new vscode.EventEmitter<void>();

  readonly onDidChangeProviders: vscode.Event<void> = this.changed.event;

  register(provider: ExceptionFlowProvider): vscode.Disposable {
    this.providers.push(provider);
    this.changed.fire();
    return new vscode.Disposable(() => {
      const i = this.providers.indexOf(provider);
      if (i >= 0) {
        this.providers.splice(i, 1);
        this.changed.fire();
      }
    });
  }

  /** True if any provider (registered or merely declared) serves `languageId`. */
  supports(languageId: string): boolean {
    return (
      this.providers.some((p) => p.languages.includes(languageId)) ||
      this.discoverContributions().some((c) => c.language === languageId)
    );
  }

  /**
   * Resolve the provider for a language, activating a declaring extension on
   * demand if the provider has not registered itself yet.
   */
  async getForLanguage(
    languageId: string,
  ): Promise<ExceptionFlowProvider | undefined> {
    let candidates = this.providers.filter((p) =>
      p.languages.includes(languageId),
    );

    if (candidates.length === 0) {
      await this.activateContributor(languageId);
      candidates = this.providers.filter((p) =>
        p.languages.includes(languageId),
      );
    }
    if (candidates.length === 0) return undefined;

    // A declared object map rather than a dynamic `catchme.<lang>.provider`
    // key: the latter worked but never appeared in the Settings UI and got no
    // validation, so nobody could discover it.
    const overrides = vscode.workspace
      .getConfiguration("catchme")
      .get<Record<string, string>>("providerOverrides", {});
    const wanted = overrides?.[languageId];
    if (wanted) {
      const picked = candidates.find((p) => p.capabilities.engine === wanted);
      if (picked) return picked;
    }

    // 'definite' outranks 'possible'; stable within the same rank.
    return candidates.reduce((best, p) => (rank(p) > rank(best) ? p : best));
  }

  /** Scan installed extensions for the `exceptionFlowProviders` manifest key. */
  private discoverContributions(): ProviderContribution[] {
    const out: ProviderContribution[] = [];
    for (const ext of vscode.extensions.all) {
      const contributed = ext.packageJSON?.contributes?.exceptionFlowProviders;
      if (Array.isArray(contributed)) {
        for (const c of contributed as ProviderContribution[]) {
          if (c?.language)
            out.push({ language: c.language, extensionId: ext.id });
        }
      }
    }
    return out;
  }

  private async activateContributor(languageId: string): Promise<void> {
    const match = this.discoverContributions().find(
      (c) => c.language === languageId,
    );
    if (!match) return;
    const ext = vscode.extensions.getExtension(match.extensionId);
    if (ext && !ext.isActive) {
      await ext.activate();
    }
  }

  dispose(): void {
    this.changed.dispose();
    this.providers.length = 0;
  }
}

function rank(p: ExceptionFlowProvider): number {
  return p.capabilities.precision === "definite" ? 1 : 0;
}
