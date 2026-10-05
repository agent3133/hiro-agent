import { describe, expect, it } from "vitest";

import { makeVault } from "../testing/vault";

describe("attachments235", () => {
  it("list_notes with path Inbox shows notes and attachment count", async () => {
    const vault = await makeVault({
      "Inbox/a.md": "# Hello\n",
      "Inbox/b.pdf": "%PDF fake",
    });
    const result = await vault.tool("list_notes").run({ path: "Inbox" });
    expect(result).toContain("Inbox/a.md");
    expect(result).toContain("[and 1 attachment(s) in 'Inbox': list_attachments lists them, or find_notes with their type, such as '*.pdf']");
  });

  it("list_notes with folder that has only attachments says No notes", async () => {
    const vault = await makeVault({
      "Inbox/b.pdf": "%PDF fake",
    });
    const result = await vault.tool("list_notes").run({ path: "Inbox" });
    expect(result).toContain("No notes in 'Inbox'");
    expect(result).toContain("[and 1 attachment(s) in 'Inbox': list_attachments lists them, or find_notes with their type, such as '*.pdf']");
  });

  it("list_notes with path . shows same as no path", async () => {
    const vault = await makeVault({
      "Inbox/a.md": "# Hello\n",
      "root.md": "# Root\n",
    });
    const withDot = await vault.tool("list_notes").run({ path: "." });
    const noPath = await vault.tool("list_notes").run({});
    expect(withDot).not.toBe("");
    expect(withDot).toBe(noPath);
  });

  it("find_notes with pattern that only matches an attachment", async () => {
    const vault = await makeVault({
      "Inbox/Kickoff deck.pptx": "fake pptx",
    });
    const result = await vault.tool("find_notes").run({ pattern: "*kickoff*" });
    expect(result.startsWith("No notes match '*kickoff*', but these attachments do:")).toBe(true);
    expect(result).toContain("Inbox/Kickoff deck.pptx");
  });

  it("read_note and read_notes with an image attachment", async () => {
    const vault = await makeVault({
      "img/p.png": "fake png",
    });
    const single = await vault.tool("read_note").run({ path: "img/p.png" });
    expect(single).toBe("Error: 'img/p.png' is an attachment (image), not a note; read it with read_attachment");
    const many = await vault.tool("read_notes").run({ paths: ["img/p.png"] });
    expect(many).toContain("Error: 'img/p.png' is an attachment (image), not a note; read it with read_attachment");
  });

  it("toolConventions includes attachment hint when list_attachments and read_attachment are present", async () => {
    const { toolConventions } = await import("../paths");
    const result = toolConventions(["find_notes", "list_notes", "list_attachments", "read_attachment"]);
    expect(result).toContain("found with list_attachments and read with read_attachment.");
  });

  it("toolConventions omits list_attachments hint when it is not present", async () => {
    const { toolConventions } = await import("../paths");
    const result = toolConventions(["find_notes", "list_notes"]);
    expect(result).not.toContain("list_attachments");
  });
});
