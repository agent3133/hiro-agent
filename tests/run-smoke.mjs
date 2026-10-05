/** Bundles a smoke suite (TypeScript, ESM) and runs it — no test runner, no extra dependency. */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const vault = process.argv[2];
const entry = process.argv[3];
if (!vault || !entry) {
  console.error("usage: node tests/run-smoke.mjs <vault path> <test file> [suite arguments]");
  process.exit(2);
}

const dir = await mkdtemp(join(tmpdir(), "obsidian-agent-smoke-"));
const outfile = join(dir, "smoke.mjs");
await build({ entryPoints: [entry], outfile, bundle: true, platform: "node",
              format: "esm", target: "node20", logLevel: "warning" });

// Anything after the test file goes to the suite (obsidian-app.smoke.ts: reload, ui, model)
const child = spawn(process.execPath, [outfile, vault, ...process.argv.slice(4)], { stdio: "inherit" });
child.on("exit", async (code) => {
  await rm(dir, { recursive: true, force: true });
  process.exit(code ?? 1);
});
