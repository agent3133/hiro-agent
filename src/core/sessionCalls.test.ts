// Tool calls kept with a conversation (#282): written before the answer they led to, taken out again on load.
import { describe, expect, it } from "vitest";

import {
  type CallsByAnswer, compactSession, loadSession, loadSessionWithCalls, savedCall, saveSession, sessionPath,
  type SessionMessage,
} from "./sessions";
import { makeVault } from "./testing/vault";

const H = (content: string): SessionMessage => ({ role: "user", content });
const A = (content: string): SessionMessage => ({ role: "assistant", content });
const OPTIONS = { agent: "assistant", model: "m" };
/** A secret-looking key built at run time, so the source holds none (redact.test.ts does the same). */
const KEY = ["sk", "-", "abcdefghijklmnopqrstuvwxyz0123"].join("");

describe("tool calls saved with a conversation", () => {
  it("writes an answer's calls before its text, as folded callouts, and marks a failed one", async () => {
    const vault = await makeVault();
    const answer = A("The PDF says yes.");
    const calls: CallsByAnswer = new Map([[answer, [
      savedCall("find_notes", { pattern: "*.pdf" }, "Inbox/Offer.pdf", false),
      savedCall("read_attachment", { path: "Offer.pdf" }, "Error: not found\nline two", true),
    ]]]);
    await saveSession(vault.vault, "c", [H("Read the offer"), answer], { ...OPTIONS, calls });
    const note = await vault.read(sessionPath("c"));
    expect(note).toContain("<!-- session-message: assistant -->\n<!-- session-tools -->\n"
      + '> [!tool]- find_notes {"pattern":"*.pdf"}\n> Inbox/Offer.pdf\n\n'
      + '> [!tool]- read_attachment {"path":"Offer.pdf"} — failed\n> Error: not found\n> line two\n'
      + "<!-- /session-tools -->\n\nThe PDF says yes.\n");
  });

  it("takes the calls out again on load, so the history the model gets is unchanged", async () => {
    const vault = await makeVault();
    const answer = A("The PDF says yes.");
    const calls: CallsByAnswer = new Map([[answer, [savedCall("read_attachment", { path: "a.pdf" }, "Error: x", true)]]]);
    await saveSession(vault.vault, "c", [H("q"), answer], { ...OPTIONS, calls });
    expect(await loadSession(vault.vault, "c")).toEqual([H("q"), A("The PDF says yes.")]);
    const loaded = await loadSessionWithCalls(vault.vault, "c");
    expect(loaded.calls.get(loaded.messages[1])).toEqual([
      { name: "read_attachment", args: '{"path":"a.pdf"}', result: "Error: x", error: true }]);
  });

  it("writes a note without calls exactly as before", async () => {
    const vault = await makeVault();
    const messages = [H("q"), A("a")];
    await saveSession(vault.vault, "plain", messages, OPTIONS);
    const before = (await vault.read(sessionPath("plain"))).replace(/updated: .*\n/, "").replace(/created: .*\n/, "");
    await saveSession(vault.vault, "empty", messages, { ...OPTIONS, calls: new Map() });
    const after = (await vault.read(sessionPath("empty"))).replace(/updated: .*\n/, "").replace(/created: .*\n/, "");
    expect(after.replace("session: empty", "session: plain")).toBe(before);
  });

  it("cuts a long result and arguments, leaves out an image's bytes, and redacts secrets", async () => {
    const long = savedCall("read_note", { path: "x".repeat(400) }, "y".repeat(800), false);
    expect(long.result).toBe(`${"y".repeat(500)}… [800 characters]`);
    expect(long.args.endsWith("… [411 characters]")).toBe(true);
    expect(savedCall("read_attachment", {}, "Image: data:image/png;base64,iVBORw0KGgo= done", false).result)
      .toBe("Image: [image] done");
    const vault = await makeVault();
    const answer = A("done");
    await saveSession(vault.vault, "s", [H("q"), answer],
                      { ...OPTIONS, calls: new Map([[answer, [savedCall("web_fetch", { key: KEY }, `got ${KEY}`, false)]]]) });
    expect(await vault.read(sessionPath("s"))).not.toContain(KEY);
  });

  it("keeps the calls of the exchanges compaction keeps word for word", async () => {
    const vault = await makeVault();
    const messages: SessionMessage[] = [];
    const calls: CallsByAnswer = new Map();
    for (let i = 1; i <= 3; i++) {
      const answer = A(`answer ${i}`);
      messages.push(H(`question ${i}`), answer);
      calls.set(answer, [savedCall("read_note", { path: `n${i}.md` }, `text ${i}`, false)]);
    }
    await saveSession(vault.vault, "long", messages, { ...OPTIONS, calls });
    expect(await compactSession(vault.vault, "long", async () => "Summary.", 1)).toBe(2);
    const note = await vault.read(sessionPath("long"));
    expect(note).toContain('> [!tool]- read_note {"path":"n3.md"}\n> text 3');
    expect(note).not.toContain("n1.md");
    const loaded = await loadSessionWithCalls(vault.vault, "long");
    expect(loaded.messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["answer 3"]);
  });
});
