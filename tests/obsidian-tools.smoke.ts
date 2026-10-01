/**
 * The agent's tools that only work inside Obsidian (#81), driven through `obsidian agent:tool` against the vault that
 * is open in Obsidian. Everything happens in `_agent-smoke/`, which is emptied first and last.
 *
 * Needs: Obsidian running with the vault open, Settings → Hiro Agent → Advanced → Developer
 * on, and the `obsidian` command on PATH. The suite reloads the plugin first, so the build on disk is what it tests.
 *
 * Run from plugin/:  node tests/run-smoke.mjs <vault name> tests/obsidian-tools.smoke.ts
 */

import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A one-page PDF, built with the byte offsets its cross-reference table needs. */
function onePagePdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 40 >>\nstream\nBT /F1 18 Tf 20 40 Td (Smoke page) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const ATTACHMENTS: Record<string, Buffer> = {
  // A 1×1 PNG
  "pixel.png": Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
  "one page.pdf": onePagePdf(),
  "data.csv": Buffer.from("a,b\n1,2\n"),
  "voice.mp3": Buffer.from("not really audio"),
};

const vault = process.argv[2];
const DIR = "_agent-smoke";

let failures = 0;
function check(what: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

/** One tool call through the CLI: its answer as the model would read it. */
function tool(name: string, args: Record<string, unknown> = {}, flags: string[] = []): string {
  const result = spawnSync("obsidian", [`vault=${vault}`, "agent:tool", `name=${name}`, `args=${JSON.stringify(args)}`, ...flags],
                           { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, shell: false });
  if (result.error) throw result.error;
  return (result.stdout || result.stderr).trim();
}
const confirmed = (name: string, args: Record<string, unknown>): string => tool(name, args, ["confirm"]);

// Test the build on disk, not whatever Obsidian loaded earlier: a run against a stale plugin once reported a
// missing guard as broken. Reloading restarts the plugin (and its runtime), as switching it off and on does.
const reload = spawnSync("obsidian", [`vault=${vault}`, "plugin:reload", "id=agent"], { encoding: "utf-8", timeout: 30_000 });
if (reload.error || !/Reloaded/.test(reload.stdout ?? "")) {
  console.log(`Obsidian did not reload the plugin: ${reload.error?.message ?? reload.stdout ?? ""}`.trim());
  console.log("Is Obsidian running with this vault, and the `obsidian` command on PATH?");
  process.exit(2);
}
const answers = (text: string): boolean => text.startsWith("#") || text.startsWith("No tags");
let probe = "";
for (let attempt = 0; attempt < 20 && !answers(probe); attempt++) {
  if (attempt) spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 500)"]);
  probe = tool("list_tags", { limit: 1 });
}
if (!answers(probe)) {
  console.log(`agent:tool did not answer: ${probe}`);
  console.log("Is Settings → Hiro Agent → Advanced → Developer on?");
  process.exit(2);
}

const ALPHA = `${DIR}/Alpha.md`;
const BETA = `${DIR}/Beta.md`;
const GAMMA = `${DIR}/Sub/Gamma.md`;
const NAMESAKE = `${DIR}/Other/Alpha.md`;
// The test vault keeps its templates in Templates/ (templates.json); the smoke template is removed again
const TEMPLATE = "Templates/_agent-smoke template.md";
const FROM_TEMPLATE = `${DIR}/From template.md`;
const pad = (n: number): string => String(n).padStart(2, "0");
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
function cleanUp(): void {
  for (const path of [ALPHA, BETA, GAMMA, NAMESAKE, TEMPLATE, FROM_TEMPLATE]) {
    confirmed("delete_note", { path, permanent: true });
  }
}

cleanUp();
tool("create_note", { path: ALPHA, content: "# Alpha\n\n## Section\n\n- [ ] open task\n- [x] done task\n\n"
                                          + "Links to [[Beta]] and [[Missing Note]]. #smoketag\n" });
tool("create_note", { path: BETA, content: "---\ntags: [smoketag, other]\nstatus: draft\n---\nBack to [[Alpha|the alpha]].\n" });

try {
  // Links, from Obsidian's index
  check("backlinks come from the index", tool("get_backlinks", { path: BETA }) === ALPHA, tool("get_backlinks", { path: BETA }));
  check("a link through an alias counts as a backlink", tool("get_backlinks", { path: "Alpha" }) === BETA,
        tool("get_backlinks", { path: "Alpha" }));
  const out = tool("get_outlinks", { path: ALPHA });
  check("outlinks are resolved paths, a missing note marked", out === `${BETA}\nMissing Note (unresolved)`, out);
  const broken = tool("find_broken_links");
  check("a broken link is listed", broken.includes(`${ALPHA} -> Missing Note`), broken);

  // Tags, tasks and headings
  const tags = tool("list_tags", {}, [`scope=${DIR}`]);
  check("tags are counted per note, frontmatter and inline", tags.split("\n").includes("#smoketag (2)"), tags);
  check("a scoped agent sees only its folder's tags", !tags.includes("#project"), tags);
  check("todo tasks", tool("list_tasks", { path: DIR }) === `${ALPHA}:5: - [ ] open task`, tool("list_tasks", { path: DIR }));
  check("done tasks", tool("list_tasks", { path: DIR, status: "done" }) === `${ALPHA}:6: - [x] done task`);
  check("a bad status says so", tool("list_tasks", { status: "later" }) === "Error: status must be todo, done or all");
  check("the outline is an indented tree", tool("note_outline", { path: ALPHA }) === "Alpha\n  Section",
        tool("note_outline", { path: ALPHA }));

  // Metadata, from the note itself
  check("metadata as Python's JSON", tool("get_metadata", { path: BETA }) === '{"tags": ["smoketag", "other"], "status": "draft"}',
        tool("get_metadata", { path: BETA }));
  const set = tool("update_metadata", { path: BETA, key: "status", value: "done" });
  check("update_metadata says what it stored", set === `Set status to 'done' (text) in '${BETA}'`, set);
  check("the new value reads back at once", tool("get_metadata", { path: BETA }).includes('"status": "done"'));

  // Destructive tools
  const refused = tool("move_note", { from_path: "Beta", to_path: `${DIR}/Sub/Gamma` });
  check("a destructive tool needs the confirm flag, and names the note it would move",
        refused.startsWith("Error: 'move_note' is destructive") && refused.includes(`"from_path":"${BETA}"`), refused);
  const moved = confirmed("move_note", { from_path: BETA, to_path: `${DIR}/Sub/Gamma` });
  check("move_note moves, and says how many notes' links changed",
        moved === `Moved note from '${BETA}' to '${GAMMA}'; updated links in 1 note(s)`, moved);
  check("Obsidian rewrote the link", tool("read_note", { path: ALPHA }).includes("Gamma"), tool("read_note", { path: ALPHA }));
  check("backlinks follow the move", tool("get_backlinks", { path: GAMMA }) === ALPHA, tool("get_backlinks", { path: GAMMA }));
  check("moving onto a note refuses", confirmed("move_note", { from_path: ALPHA, to_path: GAMMA })
        === `Error: a note already exists at '${GAMMA}'`);
  tool("create_note", { path: NAMESAKE, content: "Another note called Alpha.\n" });
  const ambiguous = confirmed("move_note", { from_path: ALPHA, to_path: `${DIR}/Renamed` });
  check("a note that shares its name with another is not moved with link updates",
        ambiguous.startsWith("Error: another note is also called 'Alpha'") && ambiguous.includes(NAMESAKE), ambiguous);
  check("…and nothing moved", tool("read_note", { path: ALPHA }).startsWith("# Alpha"));
  const plain = confirmed("move_note", { from_path: ALPHA, to_path: `${DIR}/Renamed`, update_links: false });
  check("with update_links=false it moves", plain === `Moved note from '${ALPHA}' to '${DIR}/Renamed.md'`, plain);
  confirmed("move_note", { from_path: `${DIR}/Renamed`, to_path: ALPHA, update_links: false });
  check("open_in_obsidian opens it", tool("open_in_obsidian", { path: ALPHA }) === `Opened '${ALPHA}' in Obsidian`);
  const deleted = confirmed("delete_note", { path: GAMMA });
  check("delete_note uses the vault's trash setting", /^(Moved note|Deleted note)/.test(deleted), deleted);
  check("a deleted note is gone", tool("read_note", { path: GAMMA }).startsWith("Error: note not found"));

  // Core plugins and TaskNotes (#82)
  check("daily_note follows the Daily notes settings", tool("daily_note") === `Journal/Daily/${TODAY}.md`, tool("daily_note"));
  check("daily_note for a given day", tool("daily_note", { date: "2026-01-05" }) === "Journal/Daily/2026-01-05.md");
  check("a date that is not one says so", tool("daily_note", { date: "soon" }).startsWith("Error: 'soon' is not a date"));
  tool("create_note", { path: TEMPLATE, content: "# {{title}}\nDate: {{date}}\nYear: {{date:YYYY}}\n" });
  const templates = tool("list_templates");
  check("list_templates names the templates in the Templates folder",
        templates.split("\n").includes("_agent-smoke template") && templates.split("\n").includes("Meeting"), templates);
  const made = tool("create_from_template", { template: "_agent-smoke template", path: `${DIR}/From template`, title: "Hello" });
  check("create_from_template creates the note", made === `Created '${FROM_TEMPLATE}' from template '_agent-smoke template'`, made);
  check("…with the title and dates filled in", tool("read_note", { path: FROM_TEMPLATE })
        === `# Hello\nDate: ${TODAY}\nYear: ${now.getFullYear()}`, tool("read_note", { path: FROM_TEMPLATE }));  // answers are trimmed
  check("an unknown template says so", tool("create_from_template", { template: "nope", path: `${DIR}/X` })
        === "Error: no template 'nope' (use list_templates)");
  check("create_from_template does not overwrite", tool("create_from_template", { template: "_agent-smoke template",
        path: FROM_TEMPLATE }) === `Error: note already exists at '${FROM_TEMPLATE}'`);
  const task = tool("create_tasknote", { title: "'Smoke task'", projects: "Agent smoke" });
  check("create_tasknote goes through TaskNotes, or says it is not there",
        task.startsWith("Created TaskNotes task 'Smoke task'") || task.startsWith("Error: creating a TaskNotes task needs"), task);
  const taskPath = / at '([^']+)'$/.exec(task)?.[1];
  if (taskPath) {
    // Narrowed to its project: a vault with more than 30 tasks cuts a plain listing short
    const listed = tool("list_tasknotes", { status: "all", project: "Agent smoke" });
    check("…and list_tasknotes finds the task note TaskNotes filed", listed.startsWith(`${taskPath} — status:`), listed);
    confirmed("delete_note", { path: taskPath, permanent: true });
  }
  check("a scoped agent has no create_tasknote", tool("create_tasknote", { title: "x" }, ["scope=Elsewhere"])
        === "Error: no tool 'create_tasknote'");
  check("there is no query_base", tool("query_base", { base: "x" }) === "Error: no tool 'query_base'");

  // Web (#84) — needs a network connection
  const page = tool("web_fetch", { url: "http://example.com" });
  check("web_fetch reads a page as Markdown, headed by its title (http becomes https)",
        page.startsWith("# Example Domain") && page.includes("[Learn more](https://iana.org/"), page.slice(0, 200));
  check("an unreachable page says so", tool("web_fetch", { url: "https://nothing.invalid/" }).startsWith("Error: Could not fetch URL:"));
  check("there is no web_search", tool("web_search", { query: "x" }) === "Error: no tool 'web_search'");

  // Attachments (#84): written straight into the vault, as no tool writes binary files
  const vaultPath = /^path\t(.+)$/m.exec(spawnSync("obsidian", [`vault=${vault}`, "vault"], { encoding: "utf-8" }).stdout ?? "")?.[1];
  check("the CLI names the vault's folder", Boolean(vaultPath));
  if (vaultPath) {
    for (const [name, data] of Object.entries(ATTACHMENTS)) writeFileSync(join(vaultPath, DIR, name), data);
    let seen = "";
    for (let attempt = 0; attempt < 20 && !seen.startsWith("Image"); attempt++) {
      if (attempt) spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 300)"]);
      seen = tool("read_attachment", { path: `${DIR}/pixel.png` });
    }
    check("an image is given to the model", seen === `Image '${DIR}/pixel.png':\n[image]`, seen);
    check("a bare file name is found as Obsidian resolves embeds",
          tool("read_attachment", { path: "pixel.png" }) === "Image 'pixel.png':\n[image]");
    const pdf = tool("read_attachment", { path: `${DIR}/one page.pdf` });
    check("a PDF is rendered page by page", pdf === `PDF '${DIR}/one page.pdf' — 1 page(s):\nPage 1/1:\n[image]`, pdf);
    check("an unsupported type says so", tool("read_attachment", { path: `${DIR}/data.csv` })
          .startsWith("Error: unsupported attachment type '.csv'"));
    check("a broken recording says why it was not transcribed",
          tool("read_attachment", { path: `${DIR}/voice.mp3` }).startsWith("Error: could not transcribe 'voice.mp3'"),
          tool("read_attachment", { path: `${DIR}/voice.mp3` }));
    check("a missing attachment says so", tool("read_attachment", { path: "nothing-here.png" })
          === "Error: attachment 'nothing-here.png' not found anywhere in the vault");
    for (const name of Object.keys(ATTACHMENTS)) rmSync(join(vaultPath, DIR, name), { force: true });

    // Recordings (#84): whisper.cpp and ffmpeg, as the runtime's audio settings name them
    const made = (name: string, args: string[]): boolean =>
      spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args, join(vaultPath, DIR, name)], { stdio: "ignore" }).status === 0;
    if (made("tone.m4a", ["-f", "lavfi", "-i", "sine=frequency=440:duration=2"])
        && made("clip.mp4", ["-f", "lavfi", "-i", "testsrc=duration=3:size=160x120:rate=10", "-f", "lavfi",
                             "-i", "sine=frequency=330:duration=3", "-shortest", "-pix_fmt", "yuv420p"])) {
      tool("create_note", { path: `${DIR}/Memo.md`, content: "# Memo\n\n![[tone.m4a]]\n\nafter\n" });
      let heard = "";
      for (let attempt = 0; attempt < 20 && !heard.startsWith("Transcript") && !heard.startsWith("Error: could"); attempt++) {
        if (attempt) spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 300)"]);
        heard = tool("read_attachment", { path: "tone.m4a" });
      }
      if (heard.includes("audio transcription is disabled")) {
        console.log("      (audio is off in the settings: recordings not checked)");
      } else {
        check("a recording is transcribed and saved below its embed",
              heard.startsWith("Transcript of 'tone.m4a' (") && heard.includes("new transcription")
              && heard.includes(`saved in ${DIR}/Memo.md`), heard);
        const memo = tool("read_note", { path: `${DIR}/Memo.md` });
        check("…as a transcript callout under the embed, the rest of the note kept",
              memo.includes("![[tone.m4a]]\n> [!transcript]- Transcript: tone.m4a") && memo.trimEnd().endsWith("after"), memo);
        check("the second read comes from the cache", tool("read_attachment", { path: "tone.m4a" }).includes("from cache"));
        const clip = tool("read_attachment", { path: `${DIR}/clip.mp4` });
        check("a video gives frames and the transcript of its sound",
              /^Video '.+clip\.mp4' — \d+ frame\(s\) sampled at [\d.]+ fps:/.test(clip) && clip.includes("[image]")
              && clip.includes("Transcript of 'clip.mp4'"), clip.slice(0, 300));
      }
      confirmed("delete_note", { path: `${DIR}/Memo.md`, permanent: true });
      confirmed("delete_note", { path: `${DIR}/clip.mp4.transcript.md`, permanent: true });
    } else {
      console.log("      (ffmpeg is not on PATH: recordings not checked)");
    }
    for (const name of ["tone.m4a", "clip.mp4"]) rmSync(join(vaultPath, DIR, name), { force: true });
  }

  // Scope
  check("a scoped agent cannot read backlinks outside its folder",
        tool("get_backlinks", { path: ALPHA }, ["scope=Elsewhere"]).includes("outside this agent's allowed scope"));
} finally {
  cleanUp();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
