/**
 * THIRD_PARTY_NOTICES.md: the license of every package bundled into main.js (#105). What is bundled is taken from
 * esbuild's own metafile, so the list follows the dependencies. `node scripts/notices.mjs --check` fails when the
 * file is out of date (CI runs it); the build appends the file to main.js, so every copy carries the notices.
 */
import esbuild from "esbuild";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "THIRD_PARTY_NOTICES.md";
const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "license", "license.md"];

const { metafile } = await esbuild.build({
  entryPoints: ["src/main.ts"], bundle: true, write: false, format: "cjs", platform: "node", target: "es2022",
  metafile: true, logLevel: "silent",
  // As esbuild.config.mjs: Obsidian provides CodeMirror, so it is not bundled and its license is not ours to carry
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", "node:*"],
});

const names = new Set();
for (const input of Object.keys(metafile.inputs)) {
  const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (match) names.add(match[1]);
}

const sections = [...names].sort().map((name) => {
  const folder = join("node_modules", name);
  const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
  const file = LICENSE_FILES.find((candidate) => existsSync(join(folder, candidate)));
  if (!file) throw new Error(`${name} has no license file`);
  const text = readFileSync(join(folder, file), "utf8").replace(/\r\n/g, "\n").trim();
  return `## ${name} ${pkg.version} (${pkg.license})\n\n\`\`\`\n${text}\n\`\`\``;
});

const notices = "# Third-party notices\n\n"
  + "Hiro Agent's main.js bundles the packages below. Each is used under its own license, reproduced here.\n\n"
  + sections.join("\n\n") + "\n";

if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== notices) {
    console.error(`${OUT} is out of date: run node scripts/notices.mjs`);
    process.exit(1);
  }
} else {
  writeFileSync(OUT, notices, "utf8");
  console.log(`${OUT}: ${names.size} packages`);
}
