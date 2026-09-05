import { defineConfig } from "@vscode/test-cli";

// Integration tests run in a real extension host. The Java fixture is opened as
// the workspace so jdt.ls has something to index, though the tests below do not
// require it to have finished — anything Java-dependent belongs in a suite that
// waits for Standard mode explicitly.
export default defineConfig({
  files: "out/test/**/*.test.js",
  workspaceFolder: "../../fixtures/java",
  mocha: {
    ui: "tdd",
    timeout: 120_000,
  },
});
