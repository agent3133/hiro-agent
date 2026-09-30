import { defineConfig } from "vitest/config";

// Unit tests of the agent core (#76): Node only, no Obsidian, no model server.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
