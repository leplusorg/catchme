import baseConfig from "/action/lib/.automation/eslint.config.mjs"; // path inside the super-linter container

export default [
  ...baseConfig, // keep super-linter defaults
  {
    rules: {
      "n/no-missing-import": "off", // many imports come from vscode during build
    },
  },
];
