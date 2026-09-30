/** Bundles src/headless/run.ts and runs it with the given arguments — `npm run agent -- …`. */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "obsidian-agent-headless-"));
// CommonJS, as the plugin itself is bundled: dependencies such as yaml require() Node modules
const outfile = join(dir, "run.cjs");
await build({ entryPoints: ["src/headless/run.ts"], outfile, bundle: true, platform: "node",
              format: "cjs", target: "node20", logLevel: "warning" });

const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", async (code) => {
  await rm(dir, { recursive: true, force: true });
  process.exit(code ?? 1);
});
