/** Bundles the plugin into main.js next to manifest.json — what Obsidian loads. */
import esbuild from "esbuild";
import { readFileSync } from "node:fs";

const watch = process.argv.includes("--watch");

// Every copy of main.js carries the licenses of the code bundled into it (#105): THIRD_PARTY_NOTICES.md, kept by
// scripts/notices.mjs, as a closing comment
const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8").replace(/\*\//g, "* /");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  target: "es2022",
  platform: "node",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  treeShaking: true,
  banner: { js: "/*! Hiro Agent — AGPL-3.0-or-later — https://github.com/agent3133/hiro-agent. Third-party notices at the end. */" },
  footer: { js: `/*!
${notices}*/` },
  legalComments: "inline",
  logLevel: "info",
  // Provided by Obsidian at runtime; bundling them would ship a second copy of the app's own modules.
  external: ["obsidian", "electron", "node:child_process", "node:crypto", "node:fs", "node:fs/promises", "node:http", "node:https", "node:os", "node:path"],
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
