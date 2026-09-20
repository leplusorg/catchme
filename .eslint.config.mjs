/*
 * eslint rules for super-linter's TYPESCRIPT_ES / JAVASCRIPT_ES steps.
 *
 * CI-only by construction: the import below is an absolute path inside the
 * super-linter container, and eslint is not a dependency of this workspace, so
 * nothing here can be run locally. The leading dot keeps it out of eslint's own
 * flat-config discovery for that reason — which also means super-linter cannot
 * find it by default (it looks for `eslint.config.mjs` under LINTER_RULES_PATH),
 * so `TYPESCRIPT_ES_CONFIG_FILE` points at it explicitly in super-linter.yml,
 * the same way BIOME_CONFIG_PATH and GITHUB_ACTIONS_ZIZMOR_CONFIG_FILE do.
 *
 * Biome remains the linter of record for TypeScript; these entries only stop
 * the second opinion from contradicting it.
 */
import baseConfig from "/action/lib/.automation/eslint.config.mjs"; // path inside the super-linter container

export default [
  ...baseConfig, // keep super-linter defaults
  {
    rules: {
      "n/no-missing-import": "off", // many imports come from vscode during build

      /*
       * The base config pulls in plugin:@typescript-eslint/recommended, which
       * enables no-unused-vars with `args: "after-used"` and no ignore pattern.
       * That reports the six trailing `_`-prefixed parameters in
       * packages/provider-lsp/src/index.ts, which exist because
       * ExceptionFlowProvider's signatures declare them and are marked unused by
       * the one convention TypeScript's own `noUnusedParameters` and Biome both
       * honour. Restore that convention rather than dropping the parameters:
       * they document what the interface hands the provider, and the generic
       * provider simply has no use for cancellation or progress.
       */
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Same convention for plain .js/.mjs, where eslint:recommended enables
      // the base rule instead of the TypeScript one.
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    /*
     * Last block wins in flat config, so this turns the base rule back off for
     * TypeScript, leaving @typescript-eslint/no-unused-vars above as the only
     * one running there. typescript-eslint documents that as a requirement,
     * not a preference: the base rule sees TypeScript-only syntax as plain
     * parameters and cannot tell that they are used.
     *
     * Both shapes it gets wrong are here. `constructor(private readonly
     * registry: ProviderRegistry) {}` declares a parameter *property* - the
     * name is the field, read as `this.registry` throughout the class, so
     * renaming it to `_registry` would rename the field and break every use.
     * And every method on an interface (`ExceptionFlowProvider`, `CatchMeApi`,
     * `FlowProgress`) is a declaration with no body, where a parameter name
     * can never be "used" by construction; it is there to say what the core
     * hands an implementation. Underscoring those would report unused
     * parameters to every provider author reading the API.
     */
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    rules: { "no-unused-vars": "off" },
  },
];
