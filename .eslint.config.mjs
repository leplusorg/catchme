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
];
