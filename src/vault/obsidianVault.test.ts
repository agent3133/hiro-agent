/**
 * The vault port on Obsidian's API, on the stand-in: what the adapter is allowed to answer for, outside the index.
 * On Windows the stand-in's folder has real 8.3 short names, so `AGENTS~1` reaches `.agents` on disk (#393).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { obsidianVault } from "./obsidianVault";
import { makeApp, type TestApp } from "../testing/obsidian";

let t: TestApp;

beforeEach(async () => {
  t = await makeApp({ ".agents/assistant.md": "AGENT", ".sessions/chat.md": "CHAT", "Notes/plain.md": "PLAIN" });
});

afterEach(async () => {
  await t.cleanup();
});

const port = () => obsidianVault(t.app as never);

describe("listing the dot folders (#399)", () => {
  /** The folders the adapter was asked to list, from now on. */
  function listed(): string[] {
    const seen: string[] = [];
    const adapter = (t.app as unknown as { vault: { adapter: { list(f: string): Promise<unknown> } } }).vault.adapter;
    const list = adapter.list.bind(adapter);
    adapter.list = (folder: string) => {
      seen.push(folder);
      return list(folder);
    };
    return seen;
  }

  it("leaves out .git and other tools' dot folders, and never lists them", async () => {
    await t.app.vault.adapter.write(".git/objects/ab/cdef", "x");
    await t.app.vault.adapter.write(".stfolder/marker", "x");
    const seen = listed();
    const files = await port().files();
    expect(files.some((f) => f.startsWith(".git/") || f.startsWith(".stfolder/"))).toBe(false);
    expect(seen.some((f) => f.startsWith(".git") || f.startsWith(".stfolder"))).toBe(false);
  });

  it("lists the plugin's folders and the trash", async () => {
    await t.app.vault.adapter.write(".trash/old.md", "gone");
    const files = await port().files();
    expect(files).toEqual(expect.arrayContaining([".agents/assistant.md", ".sessions/chat.md", ".trash/old.md", "Notes/plain.md"]));
  });

  it("walks the dot folders once for listings close together", async () => {
    const vault = port();
    const seen = listed();
    await vault.files();
    const once = seen.length;
    await vault.files();
    await vault.folders();
    expect(seen.length).toBe(once);
  });

  it("shows a file written meanwhile in the next listing", async () => {
    const vault = port();
    await vault.files();
    await vault.write(".sessions/new.md", "NEW");
    expect(await vault.files()).toContain(".sessions/new.md");
  });
});

describe("obsidianVault outside the index (#393)", () => {
  it("reads a dot folder's file by its name as written", async () => {
    expect(await port().read(".agents/assistant.md")).toBe("AGENT");
    expect(await port().isFile(".sessions/chat.md")).toBe(true);
  });

  it.each(["AGENTS~1/assistant.md", "SESSIO~1/chat.md", ".agents::$INDEX_ALLOCATION/assistant.md",
           ".agents/assistant.md::$DATA"])("does not reach %s, another name for a protected file", async (path) => {
    expect(await port().isFile(path)).toBe(false);
    await expect(port().read(path)).rejects.toThrow();
    await expect(port().cachedRead!(path)).rejects.toThrow();
    expect(await port().size!(path)).toBe(0);
  });

  it("does not write through another name for a folder", async () => {
    await expect(port().write("AGENTS~1/new.md", "x")).rejects.toThrow("another name for a file");
    expect(await port().isFile(".agents/new.md")).toBe(false);
  });

  it("does not read a file outside the dot folders that the index does not hold", async () => {
    // NOTES~1 is not a short name here (Notes has none), and the index does not know a lower-case 'notes'
    expect(await port().isFile("notes/plain.md")).toBe(false);
    await expect(port().read("notes/plain.md")).rejects.toThrow("was not found");
  });

  it("still reads, writes and changes notes the index holds, and dot-folder files", async () => {
    expect(await port().read("Notes/plain.md")).toBe("PLAIN");
    await port().write(".sessions/new.md", "NEW");
    expect(await port().read(".sessions/new.md")).toBe("NEW");
    expect(await port().modify!(".sessions/new.md", (text) => `${text}!`)).toBe("NEW!");
  });
});

describe("writing, listing, removing and moving through the port (#420)", () => {
  it("writes a note into a dot folder the plugin walks, through the adapter, and reads it back in a listing", async () => {
    const adapter = t.app.vault.adapter;
    const written: string[] = [];
    const write = adapter.write.bind(adapter);
    adapter.write = async (path: string, text: string) => {
      written.push(path);
      return write(path, text);
    };
    await port().write(".agents/x.md", "X");
    expect(written).toContain(".agents/x.md");
    expect(await port().read(".agents/x.md")).toBe("X");
    expect(await port().files()).toContain(".agents/x.md");
  });

  it("moves a removed note to the vault's .trash when the vault keeps deleted files there", async () => {
    t.app.vault.config.trashOption = "local";
    await port().remove("Notes/plain.md");
    expect(await port().isFile("Notes/plain.md")).toBe(false);
    expect(await port().isFile(".trash/plain.md")).toBe(true);
    expect(await port().read(".trash/plain.md")).toBe("PLAIN");
  });

  it("deletes a removed note for good when the vault is set to delete files instead of keeping them", async () => {
    t.app.vault.config.trashOption = "none";
    await port().remove("Notes/plain.md");
    expect(await port().isFile("Notes/plain.md")).toBe(false);
    expect(await port().isFile(".trash/plain.md")).toBe(false);
  });

  it("moves a note to a new folder that does not exist yet: the folder is made and the note is only at the new path", async () => {
    await port().move("Notes/plain.md", "Fresh Folder/Deeper/plain.md");
    expect(await port().isFolder("Fresh Folder/Deeper")).toBe(true);
    expect(await port().isFile("Fresh Folder/Deeper/plain.md")).toBe(true);
    expect(await port().read("Fresh Folder/Deeper/plain.md")).toBe("PLAIN");
    expect(await port().isFile("Notes/plain.md")).toBe(false);
  });

  it("reports a write as a create, then a modify, to the recorder given", async () => {
    const changes: { op: string; path: string; before: string | null; after: string | null }[] = [];
    const vault = obsidianVault(t.app as never, { record: (change) => void changes.push(change) });
    await vault.write("Notes/fresh.md", "one");
    await vault.write("Notes/fresh.md", "two");
    expect(changes.map((c) => c.op)).toEqual(["create", "modify"]);
    expect(changes[0]).toMatchObject({ path: "Notes/fresh.md", before: null, after: "one" });
    expect(changes[1]).toMatchObject({ path: "Notes/fresh.md", before: "one", after: "two" });
  });
});
