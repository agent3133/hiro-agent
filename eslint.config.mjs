// ESLint with Obsidian's own review rules (#320): what the community plugin review checks, plus typescript-eslint's
// type-checked rules. `npm run lint`; the local test-runner and CI run it beside the build and the tests.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // The plugin's code: tests, the smoke suites and the build scripts are not what the review reads
  { ignores: ["main.js", "node_modules/**", "tests/**", "scripts/**", "src/**/*.test.ts", "src/**/testing/**",
              "*.mjs"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      // Strict type rules that report this code base's checked config values and untyped settings objects rather
      // than mistakes (about 130 findings in the trial of 2026-10-06): off for now, to revisit
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      // The product's name, the acronyms it shows, and what placeholders show as written: an address, a model, a program
      "obsidianmd/ui/sentence-case": ["warn", {
        brands: ["Hiro Agent", "Obsidian", "OpenAI", "TaskNotes", "Ollama", "LM Studio", "BRAT"],
        acronyms: ["MCP", "PDF", "API", "URL", "CLI", "HTTP", "HTTPS", "JSON", "YAML", "LLM"],
        ignoreWords: ["PDFs"],
        // A single lowercase word is a name to type as it is, e.g. a connection called "cloud"
        ignoreRegex: ["^https?://", "^gpt-", "\\b(npx|uvx|node)\\b", "^[a-z0-9_-]+$"],
      }],
    },
  },
  {
    // Timers not tied to a window: the agent core stays free of the browser, for mobile (#304), and a command from
    // the terminal runs whatever window is open; both run under Node in the tests, which has no window
    files: ["src/core/**/*.ts", "src/cli/**/*.ts"],
    rules: { "obsidianmd/prefer-window-timers": "off" },
  },
]);
