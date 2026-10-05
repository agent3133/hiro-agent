/**
 * The parts of the plugin that import `obsidian` and so have no Vitest tests (#182): the command line handlers, the
 * registered commands, the vault port, the agent's catalogue — and, when asked, the settings tabs and one real
 * answer with its undo. Driven through `obsidian eval` and the plugin's own CLI against the vault open in Obsidian;
 * everything it writes is in `_agent-app-smoke/` and `.agent-app-smoke/`, emptied first and last.
 *
 * By default it leaves what the user sees alone: no reload, no settings window, no model. Add the parts wanted:
 *   reload  load the build on disk first (drops conversations that are not kept)
 *   ui      open the settings window and check its tabs
 *   model   one answer from the local model through agent:ask, and taking it back (llama-server must answer)
 *   chat    a chat window of its own: header, copying, the kept selection, dropped files, and with model an
 *           answer taken back through the undo dialog; the window is closed again (#182)
 *
 * Run from plugin/:  node tests/run-smoke.mjs <vault name> tests/obsidian-app.smoke.ts [reload] [ui] [model] [chat]
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const vault = process.argv[2];
const parts = new Set(process.argv.slice(3));
const DIR = "_agent-app-smoke";
const HIDDEN = ".agent-app-smoke";

let failures = 0;
function check(what: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

/** One CLI command; its output. Arguments as a list, no shell: a shell breaks eval's quoting. */
function cli(...args: string[]): string {
  const result = spawnSync("obsidian", [`vault=${vault}`, ...args], { encoding: "utf-8", timeout: 600_000,
                                                                           stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  return (result.stdout || result.stderr).trim();
}

/** JavaScript run inside Obsidian, its value read back as JSON. `p` is the plugin, `w(ms)` waits. */
function run<T>(body: string): T {
  const code = `(async()=>{const p=app.plugins.plugins.agent;const w=(ms)=>new Promise(r=>setTimeout(r,ms));`
    + `return JSON.stringify(await (async()=>{${body}})())})()`;
  // One line: the CLI takes code= up to the first line break
  const out = cli("eval", `code=${code.replace(/\s*\n\s*/g, " ")}`).replace(/^=>\s*/, "");
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new Error(`eval did not answer JSON: ${out.slice(0, 300)}`);
  }
}

function json<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

if (parts.has("reload")) {
  const reloaded = cli("plugin:reload", "id=agent");
  if (!/Reloaded/.test(reloaded)) {
    console.log(`Obsidian did not reload the plugin: ${reloaded}`);
    process.exit(2);
  }
  spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 3000)"]);
}
if (!run<boolean>("return Boolean(p)")) {
  console.log("The plugin is not loaded in this vault. Is Obsidian running with it, and the plugin on?");
  process.exit(2);
}

const cleanUp = (): void => {
  run(`for (const dir of [${JSON.stringify(DIR)}, ${JSON.stringify(HIDDEN)}]) {
         if (await app.vault.adapter.exists(dir)) await app.vault.adapter.rmdir(dir, true); }
       return true;`);
};
cleanUp();

try {
  // --- The command line (cli/register.ts) ----------------------------------------------------------------------
  const manifest = JSON.parse(readFileSync("manifest.json", "utf-8")) as { version: string };
  const status = json<{ version: string; defaultAgent: string; agents: number; connection: { name: string } }>(
    cli("agent:status", "format=json"));
  const agents = json<{ name: string; source: string; default: boolean }[]>(cli("agent:list", "format=json")) ?? [];
  check("agent:status answers JSON with the plugin's version", status?.version === manifest.version,
        JSON.stringify(status)?.slice(0, 200));
  check("agent:status counts the agents agent:list lists", status?.agents === agents.length,
        `${status?.agents} vs ${agents.length}`);
  check("agent:list marks exactly one default, the one agent:status names",
        agents.filter((a) => a.default).map((a) => a.name).join() === status?.defaultAgent,
        JSON.stringify(agents.map((a) => [a.name, a.default])));
  check("agent:list says where each agent comes from", agents.every((a) => ["bundled", "vault"].includes(a.source)),
        JSON.stringify(agents.map((a) => a.source)));
  const sessions = json<{ name: string; updated: string }[]>(cli("agent:sessions", "format=json"));
  check("agent:sessions answers a list, newest first", Array.isArray(sessions)
        && sessions.every((s, i) => i === 0 || sessions[i - 1].updated >= s.updated), JSON.stringify(sessions)?.slice(0, 200));

  // --- Commands (main.ts, commands/AgentCommands.ts) --------------------------------------------------------------
  const commands = run<string[]>("return Object.keys(app.commands.commands).filter((id) => id.startsWith('agent:'))");
  for (const id of ["agent:open-chat", "agent:show-log", "agent:ask", "agent:rename-conversation"]) check(`the command ${id} is there`, commands.includes(id));
  check("every agent has its own Ask command", agents.every((a) => commands.includes(`agent:ask-with-${a.name}`)),
        JSON.stringify(commands));
  check("no command id repeats the plugin id (Obsidian's guideline)", commands.every((id) => !id.slice(6).startsWith("agent")),
        JSON.stringify(commands));

  // --- The agent's catalogue (inprocess/InProcessAgent.ts info) ----------------------------------------------------
  const info = run<{ agents: { name: string }[]; profiles: { name: string }[] }>("return p.inProcess.info()");
  check("the chat offers the agents agent:list lists",
        info.agents.map((a) => a.name).sort().join() === agents.map((a) => a.name).sort().join());
  check("the connection agent:status names is one the chat offers",
        !status?.connection?.name || info.profiles.some((profile) => profile.name === status.connection.name),
        JSON.stringify(info.profiles));

  // --- The vault port (vault/obsidianVault.ts) ---------------------------------------------------------------------
  const port = run<Record<string, unknown>>(`
    const v = p.inProcess.vault, a = ${JSON.stringify(DIR)}, h = ${JSON.stringify(HIDDEN)}, out = {};
    await v.write(a + "/Sub/One.md", "one");
    out.read = await v.read(a + "/Sub/One.md");
    out.isFile = await v.isFile(a + "/Sub/One.md");
    out.isFolder = await v.isFolder(a + "/Sub");
    out.indexed = app.vault.getAbstractFileByPath(a + "/Sub/One.md") !== null;
    await v.write(a + "/Sub/One.md", "two");
    out.replaced = await v.read(a + "/Sub/One.md");
    out.hiddenWindow = document.visibilityState === "hidden";
    if (!out.hiddenWindow) {
      await v.move(a + "/Sub/One.md", a + "/Moved/Two.md");
      out.movedFrom = await v.isFile(a + "/Sub/One.md");
      out.movedTo = await v.read(a + "/Moved/Two.md");
    } else {
      try { await v.move(a + "/Sub/One.md", a + "/Moved/Two.md"); out.refused = ""; }
      catch (error) { out.refused = String(error.message); }
      out.stayed = await v.isFile(a + "/Sub/One.md");
    }
    await v.write(h + "/hidden.md", "dot");
    out.hidden = await v.read(h + "/hidden.md");
    const files = await v.files();
    out.listsHidden = files.includes(h + "/hidden.md");
    out.listsConfig = files.some((f) => f.startsWith(app.vault.configDir + "/"));
    out.sorted = files.every((f, i) => i === 0 || files[i - 1] <= f);
    const left = out.hiddenWindow ? a + "/Sub/One.md" : a + "/Moved/Two.md";
    await v.remove(left);
    await v.remove(h + "/hidden.md");
    out.removed = !(await v.isFile(left)) && !(await v.isFile(h + "/hidden.md"));
    try { await v.read(a + "/nothing.md"); out.missing = "read"; } catch { out.missing = "threw"; }
    return out;`);
  check("the port writes a note, creating its folders, and reads it back", port.read === "one" && port.isFolder === true,
        JSON.stringify(port));
  check("…through Obsidian, so its index knows the note", port.indexed === true);
  check("writing again replaces the text", port.replaced === "two");
  // A minimized Obsidian never finishes a rename that updates links (#207): the move is refused, nothing changes
  if (port.hiddenWindow) {
    check("while Obsidian is minimized, move is refused and the note stays",
          String(port.refused).includes("minimized") && port.stayed === true, JSON.stringify(port));
  } else {
    check("move takes the note to a new folder", port.movedFrom === false && port.movedTo === "two");
  }
  check("a dot folder is written through the adapter", port.hidden === "dot");
  check("files() lists dot folders but never Obsidian's own folder", port.listsHidden === true && port.listsConfig === false);
  check("files() is sorted", port.sorted === true);
  check("remove deletes, in and outside the index", port.removed === true);
  check("reading a note that is not there throws", port.missing === "threw");

  // --- The settings window (settings.ts, settings/*) ---------------------------------------------------------------
  // A minimized window throttles timers to about one a minute, and the settings are drawn on them: shown windows only
  const hidden = run<boolean>("return document.visibilityState === 'hidden'");
  if (parts.has("ui") && hidden) console.log("      (Obsidian is minimized: the settings window is not checked)");
  else if (parts.has("ui")) {
    const tabs = run<{ tabs: string[]; panes: Record<string, string> }>(`
      app.setting.open(); app.setting.openTabById("agent"); await w(800);
      const d = activeDocument, out = { tabs: [], panes: {} };
      const buttons = [...d.querySelectorAll(".obsidian-agent-tab")];
      out.tabs = buttons.map((b) => b.textContent);
      for (const b of buttons) { b.click(); await w(600);
        const pane = [...d.querySelectorAll(".obsidian-agent-pane")].find((el) => el.offsetParent !== null);
        out.panes[b.textContent] = pane ? [...pane.querySelectorAll(".setting-item-name, h3, h4")].map((el) => el.textContent).join("|") : ""; }
      app.setting.close();
      return out;`);
    check("the settings show their four tabs in order", tabs.tabs.join() === "Connections,Features,Agents,Advanced",
          tabs.tabs.join());
    check("every tab draws something", Object.values(tabs.panes).every((text) => text.length > 0), JSON.stringify(tabs.panes));
    check("the Agents tab draws the default agent's editor", /Prompt/.test(tabs.panes.Agents ?? ""), tabs.panes.Agents);
  } else {
    console.log("      (ui not asked for: the settings window is not opened)");
  }

  // --- The chat view (view/ChatView.ts, view/*Modal.ts) — a chat window of the suite's own, closed again ---------------
  if (parts.has("chat") && hidden) console.log("      (Obsidian is minimized: the chat view is not checked)");
  else if (parts.has("chat")) {
    const opened = run<{ added: number; mine: string }>(`
      const before = app.workspace.getLeavesOfType("obsidian-agent-chat").map((l) => l.view.viewId);
      await app.commands.executeCommandById("agent:new-chat-window"); await w(1500);
      const views = app.workspace.getLeavesOfType("obsidian-agent-chat").map((l) => l.view);
      const mine = views.find((v) => !before.includes(v.viewId));
      window.__agentSmokeChat = mine;
      return { added: views.length - before.length, mine: mine ? mine.viewId : "" };`);
    check("New chat window opens a chat of its own (#153)", opened.added === 1 && Boolean(opened.mine), JSON.stringify(opened));
    try {
      const header = run<{ agents: string[]; keep: boolean }>(`
        const v = window.__agentSmokeChat;
        return { agents: [...v.containerEl.querySelectorAll(".obsidian-agent-picker option")].map((o) => o.value),
                 keep: Boolean(v.containerEl.querySelector(".obsidian-agent-keep input")) };`);
      check("the chat's picker offers the agents agent:list lists",
            header.agents.slice().sort().join() === agents.map((a) => a.name).sort().join(), header.agents.join());
      check("…and the Keep box is there", header.keep);

      const copy = run<{ select: string; menu: string[] }>(`
        const v = window.__agentSmokeChat, d = v.containerEl.ownerDocument;
        const msg = v.containerEl.querySelector(".obsidian-agent-message");
        if (!msg) return { select: "", menu: [] };
        const range = d.createRange(); range.selectNodeContents(msg);
        const s = d.getSelection(); s.removeAllRanges(); s.addRange(range);
        const box = msg.getBoundingClientRect();
        msg.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + 5, clientY: box.top + 5 }));
        await w(300);
        const menu = [...d.querySelectorAll(".menu .menu-item-title")].map((e) => e.textContent);
        d.querySelector(".menu")?.remove(); s.removeAllRanges();
        return { select: d.defaultView.getComputedStyle(msg).userSelect, menu };`);
      check("the chat's text can be selected, and offers Copy on a right-click (#217)",
            copy.select === "text" && copy.menu.join() === "Copy", JSON.stringify(copy));

      const kept = run<{ marks: string; line: string; back: number }>(`
        const v = window.__agentSmokeChat, note = ${JSON.stringify(`${DIR}/Selected.md`)};
        await p.inProcess.vault.write(note, "First line\\nThe selected words here\\n"); await w(500);
        const leaf = app.workspace.getLeaf("tab"); await leaf.openFile(app.vault.getAbstractFileByPath(note)); await w(500);
        const ed = leaf.view.editor; ed.focus(); ed.setSelection({ line: 1, ch: 4 }, { line: 1, ch: 18 }); await w(200);
        v.containerEl.querySelector("textarea").focus(); await w(300);
        const cm = leaf.view.containerEl.querySelector(".cm-editor");
        const marks = [...cm.querySelectorAll(".obsidian-agent-kept-selection")].map((e) => e.textContent).join("");
        const line = v.containerEl.querySelector(".obsidian-agent-context-line").textContent;
        ed.focus(); await w(300);
        const back = cm.querySelectorAll(".obsidian-agent-kept-selection").length;
        leaf.detach();
        return { marks, line, back };`);
      check("the note's selection stays marked while the chat has the focus (#218)", kept.marks === "selected words", JSON.stringify(kept));
      check("…the line above the input says what goes along", kept.line === 'Selection in "Selected": "selected words"', kept.line);
      check("…and the marks go once the note has the focus again", kept.back === 0);

      const dropped = run<{ chips: string; notice: string }>(`
        const v = window.__agentSmokeChat;
        const dt = new DataTransfer(); dt.items.add(new File(["png"], "dot.png")); dt.items.add(new File(["x"], "files.zip"));
        v.contentEl.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt })); await w(400);
        const chips = v.containerEl.querySelector(".obsidian-agent-attachments").textContent;
        const notice = [...activeDocument.querySelectorAll(".notice")].map((n) => n.textContent).filter((t) => t.includes("files.zip")).pop() ?? "";
        v.pending = []; v.containerEl.querySelector(".obsidian-agent-attachments").empty();
        return { chips, notice };`);
      check("a dropped image becomes an attachment chip (#190)", dropped.chips.includes("dot.png"), dropped.chips);
      check("…and a file the agent cannot read is refused with a notice", dropped.notice.includes("can't be added"), dropped.notice);

      if (parts.has("model")) {
        const note = `${DIR}/Made in the chat.md`;
        const undo = run<{ diff: string[]; restored: boolean }>(`
          const v = window.__agentSmokeChat;
          const box = v.containerEl.querySelector(".obsidian-agent-keep input");
          if (box.checked) { box.checked = false; box.dispatchEvent(new Event("change")); }
          v.containerEl.querySelector("textarea").value = ${JSON.stringify(`Create the note '${note}' with the text: made in the chat. Then reply only: done.`)};
          v.containerEl.querySelector("button.mod-cta").click();
          let button = null;
          for (let i = 0; i < 240 && !button; i++) { await w(500); button = v.containerEl.querySelector('button[aria-label="Undo what this answer changed"]'); }
          if (!button) return { diff: ["no undo button"], restored: false };
          button.click(); await w(1500);
          const modal = activeDocument.querySelector(".modal.obsidian-agent-undo-modal");
          const diff = modal ? [...modal.querySelectorAll(".obsidian-agent-diff-line")].map((l) => l.className.replace("obsidian-agent-diff-line ", "")) : ["no dialog"];
          const take = modal ? [...modal.querySelectorAll("button")].find((b) => b.textContent === "Take it back") : null;
          if (take) { take.click(); await w(1500); }
          return { diff, restored: !(await app.vault.adapter.exists(${JSON.stringify(note)})) };`);
        check("an answer that wrote a note gets an undo button, whose dialog shows the diff coloured (#131)",
              undo.diff.includes("is-add"), JSON.stringify(undo.diff));
        check("…and Take it back removes the note", undo.restored);
      }
    } finally {
      run("window.__agentSmokeChat?.leaf.detach(); delete window.__agentSmokeChat; return true;");
    }
  } else {
    console.log("      (chat not asked for: no chat window is opened)");
  }

  // --- One real answer, and taking it back (inprocess/InProcessAgent.ts, core/journal.ts) ---------------------------
  if (parts.has("model")) {
    const note = `${DIR}/Made by the agent.md`;
    const answer = json<{ ok: boolean; reply: string; changed: string[]; kept: boolean; tool_calls: number }>(cli(
      "agent:ask", `prompt=Create the note '${note}' with the text: hello from the smoke test. Then reply only: done.`,
      "keep=false", "format=json", "timeout=300"));
    check("agent:ask answers through the local model", answer?.ok === true, JSON.stringify(answer)?.slice(0, 300));
    check("…makes the note, and says it changed it", Boolean(answer?.changed.includes(note)), JSON.stringify(answer?.changed));
    check("…and keep=false saves no conversation", answer?.kept === false);
    const undo = run<{ files: string[]; diff: string; restored: string[]; exists: boolean }>(`
      const turn = p.inProcess.journal?.last();
      if (!turn) return { files: [], diff: "", restored: [], exists: true };
      const diff = await p.inProcess.turnDiff(turn.id);
      const result = await p.inProcess.undoTurn(turn.id);
      return { files: diff.files, diff: diff.diff, restored: result.restored,
               exists: await app.vault.adapter.exists(${JSON.stringify(note)}) };`);
    check("the answer is in the undo journal, with its diff", undo.files.includes(note) && undo.diff.includes("+hello"),
          JSON.stringify(undo).slice(0, 300));
    check("undo takes the note away again", undo.restored.includes(note) && !undo.exists, JSON.stringify(undo.restored));
  } else {
    console.log("      (model not asked for: no answer is run)");
  }
} finally {
  cleanUp();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
