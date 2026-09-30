// Ported from tests/test_list_notes_limit.py — the three list_notes limit tests.
import { describe, expect, it } from "vitest";

import { LIST_LIMIT } from "./vaultTools";
import { makeVault } from "../testing/vault";

describe("test_list_notes_limit.py", () => {
  it("test_a_long_listing_is_cut_off_and_says_how_much_it_left_out", async () => {
    const vault = await makeVault();
    for (let index = 0; index < LIST_LIMIT + 25; index++) {
      await vault.write(`Notes/Note ${index.toString().padStart(3, "0")}.md`, "body\n");
    }
    await vault.folder("Inbox");
    await vault.write("Inbox/Capture.md", "body\n");

    const answer = await vault.tool("list_notes").run({ recursive: true });
    const lines = answer.split("\n");

    expect(lines.length).toBe(LIST_LIMIT + 1);
    expect(lines[lines.length - 1]).toBe("[26 more, name a folder to narrow the list]");
    expect(lines[lines.length - 1].toLowerCase().includes("limit")).toBe(false);
  });

  it("test_a_folder_that_fits_is_listed_whole", async () => {
    const vault = await makeVault();
    for (let index = 0; index < LIST_LIMIT + 25; index++) {
      await vault.write(`Notes/Note ${index.toString().padStart(3, "0")}.md`, "body\n");
    }
    await vault.folder("Inbox");
    await vault.write("Inbox/Capture.md", "body\n");

    const answer = await vault.tool("list_notes").run({ path: "Inbox" });

    expect(answer).toBe("Inbox/Capture.md");
    expect(answer.toLowerCase().includes("more")).toBe(false);
  });

  it("test_an_empty_folder_says_so", async () => {
    const vault = await makeVault();
    for (let index = 0; index < LIST_LIMIT + 25; index++) {
      await vault.write(`Notes/Note ${index.toString().padStart(3, "0")}.md`, "body\n");
    }
    await vault.folder("Inbox");
    await vault.write("Inbox/Capture.md", "body\n");
    await vault.folder("Empty");

    const answer = await vault.tool("list_notes").run({ path: "Empty" });

    expect(answer).toBe("No notes in 'Empty'");
  });
});
