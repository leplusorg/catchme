import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `vscode` only exists inside the extension host. Alias it to a stub so the
// provider's scanning logic is unit-testable in plain Node.
export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL("./test/vscode-stub.ts", import.meta.url)),
    },
  },
});
