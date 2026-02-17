import { defineConfig } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "openclaw/plugin-sdk": resolve(
        __dirname,
        "tests/__mocks__/openclaw-plugin-sdk.ts",
      ),
    },
  },
  test: {
    globals: true,
    testTimeout: 15_000,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["index.ts", "config.ts", "versionInfo.ts"],
    },
  },
});
