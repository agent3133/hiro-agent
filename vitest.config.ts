import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Unit tests: Node only, no Obsidian app, no model server (#76). The code that imports `obsidian` gets a stand-in
// (#368): the real module exists only inside the app.
export default defineConfig({
  resolve: {
    alias: { obsidian: fileURLToPath(new URL("./src/testing/obsidian.ts", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // The core's network port, registered as the plugin does when it starts (#418)
    setupFiles: ["src/testing/setup.ts"],
    // `npm run coverage` (#367): reported, never a gate. Every source file counts, tested or not, so the
    // untested ones show as 0 % instead of being left out.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/testing/**", "src/**/*.d.ts"],
      reporter: ["json-summary", "text-summary"],
      reportsDirectory: "coverage",
    },
  },
});
