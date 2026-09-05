import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `vscode` only exists inside the VS Code extension host. Point it at a stub so
// the provider's own logic (readiness checks, payload shaping) is unit-testable
// in plain Node.
export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL("./test/vscode-stub.ts", import.meta.url)),
    },
  },
});
