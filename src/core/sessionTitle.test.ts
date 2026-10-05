// A conversation's title (#286): what the user typed, as typed, in the note; the file name stays its identifier.
import { describe, expect, it } from "vitest";

import { compactSession, listSessions, loadSession, saveSession, sessionMeta, sessionPath, setSessionTitle } from "./sessions";
import { makeVault } from "./testing/vault";

const NAME = "2026-10-05-1143-go-through";
const OPTIONS = { agent: "assistant", model: "m", connection: "local" };
const messages = [{ role: "user" as const, content: "q" }, { role: "assistant" as const, content: "a" }];

describe("a conversation's title", () => {
  it("is written as typed, the note keeping its name and its messages", async () => {
    const vault = await makeVault();
    await saveSession(vault.vault, NAME, messages, OPTIONS);
    await setSessionTitle(vault.vault, NAME, "  Plan: Q4 / Budget?  ");
    expect((await sessionMeta(vault.vault, NAME)).title).toBe("Plan: Q4 / Budget?");
    expect((await sessionMeta(vault.vault, NAME)).session).toBe(NAME);
    expect(await vault.exists(sessionPath(NAME))).toBe(true);
    expect(await loadSession(vault.vault, NAME)).toEqual(messages);
    expect((await listSessions(vault.vault))[0]).toMatchObject({ name: NAME, title: "Plan: Q4 / Budget?" });
  });

  it("stays through later saves and a compaction, and a blank one takes it away", async () => {
    const vault = await makeVault();
    await saveSession(vault.vault, NAME, messages, OPTIONS);
    await setSessionTitle(vault.vault, NAME, "Tool tour");
    await saveSession(vault.vault, NAME, [...messages, { role: "user", content: "q2" }, { role: "assistant", content: "a2" }], OPTIONS);
    expect((await sessionMeta(vault.vault, NAME)).title).toBe("Tool tour");
    await compactSession(vault.vault, NAME, async () => "Summary.", 1);
    expect((await sessionMeta(vault.vault, NAME)).title).toBe("Tool tour");
    await setSessionTitle(vault.vault, NAME, " ");
    expect((await sessionMeta(vault.vault, NAME)).title).toBeUndefined();
    expect((await listSessions(vault.vault))[0].title).toBeUndefined();
  });

  it("is given with the first save of a conversation not written yet, and two may share one", async () => {
    const vault = await makeVault();
    await setSessionTitle(vault.vault, "later", "Ignored: no note yet");
    expect(await vault.exists(sessionPath("later"))).toBe(false);
    await saveSession(vault.vault, "later", messages, { ...OPTIONS, title: "Same" });
    await saveSession(vault.vault, "other", messages, { ...OPTIONS, title: "Same" });
    expect((await listSessions(vault.vault)).map((s) => s.title)).toEqual(["Same", "Same"]);
  });
});

describe("the order of the conversations", () => {
  const note = (name: string, updated?: string): string =>
    `---\nsession: '${name}'\nagent: assistant\n${updated ? `updated: '${updated}'\n` : ""}exchanges: 1\n---\n\n<!-- session-message: human -->\nq\n`;

  it("is by their last change, newest first, whenever they were started; a renamed one keeps its place", async () => {
    const vault = await makeVault({
      ".sessions/2026-09-23-1831-moc.md": note("2026-09-23-1831-moc", "2026-09-29T11:29:54"),
      ".sessions/2026-09-29-1305-notes.md": note("2026-09-29-1305-notes", "2026-09-29T13:05:28"),
      ".sessions/2026-10-01-1230-heading.md": note("2026-10-01-1230-heading", "2026-10-01T12:31:09"),
      ".sessions/by-hand.md": note("by-hand"),
      ".sessions/2026-08-01-0900-old.md": note("2026-08-01-0900-old"),
    });
    await setSessionTitle(vault.vault, "2026-09-23-1831-moc", "Maps of content");
    expect((await listSessions(vault.vault)).map((s) => s.name)).toEqual([
      "2026-10-01-1230-heading", "2026-09-29-1305-notes", "2026-09-23-1831-moc", "by-hand", "2026-08-01-0900-old"]);
  });
});
