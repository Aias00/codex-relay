import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "codex-relay/api-schema": fileURLToPath(new URL("./src/api-schema.ts", import.meta.url)),
    },
  },
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
