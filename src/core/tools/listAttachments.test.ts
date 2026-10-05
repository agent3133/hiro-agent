import { describe, expect, it } from "vitest";

import { makeVault } from "../testing/vault";

describe("list_attachments", () => {
  it("no arguments lists non-note files sorted, with kind and size", async () => {
    const vault = await makeVault({
      "Notes/a.md": "# Hello",
      "Inbox/Invoice.pdf": "12345",
      "img/p.png": "PNGDATA",
    });
    const result = await vault.tool("list_attachments").run({});
    const lines = result.split("\n");
    // Two non-note files, sorted + footer = 3 lines
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("Inbox/Invoice.pdf");
    expect(lines[0]).toContain("PDF");
    expect(lines[0]).toContain("5 bytes");
    expect(lines[1]).toContain("img/p.png");
    expect(lines[1]).toContain("image");
    // No .md file
    expect(result).not.toContain("Notes/a.md");
    // Ends with footer
    expect(result).toContain("(read_attachment reads them)");
  });

  it("path filters to folder, '.' lists whole vault", async () => {
    const vault = await makeVault({
      "Inbox/Invoice.pdf": "12345",
      "Inbox/sub/x.csv": "csvdata",
      "Notes/a.md": "# Hello",
      "img/p.png": "PNGDATA",
    });
    // path "Inbox" only lists files below Inbox
    const inboxResult = await vault.tool("list_attachments").run({ path: "Inbox" });
    expect(inboxResult).toContain("Inbox/Invoice.pdf");
    expect(inboxResult).toContain("Inbox/sub/x.csv");
    expect(inboxResult).not.toContain("img/p.png");
    expect(inboxResult).not.toContain("Notes/a.md");

    // "." lists the whole vault like no path
    const dotResult = await vault.tool("list_attachments").run({ path: "." });
    expect(dotResult).toContain("Inbox/Invoice.pdf");
    expect(dotResult).toContain("img/p.png");
    expect(dotResult).not.toContain("Notes/a.md");
  });

  it("pattern matches case-insensitively and supports wildcards", async () => {
    const vault = await makeVault({
      "Inbox/Invoice.pdf": "12345",
      "Notes/a.md": "# Hello",
      "img/p.png": "PNGDATA",
    });
    // Wildcard pattern, case-insensitive
    const wildcardResult = await vault.tool("list_attachments").run({ pattern: "*invoice*" });
    expect(wildcardResult).toContain("Inbox/Invoice.pdf");
    expect(wildcardResult).not.toContain("img/p.png");

    // Substring match without wildcard
    const substringResult = await vault.tool("list_attachments").run({ pattern: "voic" });
    expect(substringResult).toContain("Inbox/Invoice.pdf");
  });

  it("dot folders are never listed", async () => {
    const vault = await makeVault({
      ".trash/old.png": "TRASHDATA",
      ".obsidian/x.json": "{}",
      "Inbox/Invoice.pdf": "12345",
    });
    const result = await vault.tool("list_attachments").run({});
    expect(result).not.toContain(".trash");
    expect(result).not.toContain(".obsidian");
    expect(result).toContain("Inbox/Invoice.pdf");
  });

  it("no match returns message, limit truncates with more message", async () => {
    const vault = await makeVault({
      "Inbox/Invoice.pdf": "12345",
      "Inbox/Receipt.pdf": "RECEIPT",
      "Notes/a.md": "# Hello",
    });
    // No match
    const noMatch = await vault.tool("list_attachments").run({ path: "Inbox", pattern: "*zzz*" });
    expect(noMatch).toContain("No attachments in 'Inbox' match '*zzz*'");

    // Limit 1 with two attachments
    const limited = await vault.tool("list_attachments").run({ limit: 1 });
    expect(limited).toContain("[1 more; name a folder or a pattern to narrow the list]");
    // Only one file line
    const fileLines = limited.split("\n").filter((l) => !l.startsWith("[") && l !== "(read_attachment reads them)");
    expect(fileLines.length).toBe(1);
  });
});
