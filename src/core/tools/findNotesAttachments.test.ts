import { describe, expect, it } from "vitest";

import { makeVault } from "../testing/vault";

// #248: find_notes names the attachments that match too when notes match, so "the kickoff slides" are not missed
describe("find_notes and attachments with the same name", () => {
  it("lists the notes and names the attachment that matches too", async () => {
    const vault = await makeVault({ "Projects/Kickoff plan.md": "# Plan", "Inbox/Kickoff deck.pptx": "x" });
    const result = await vault.tool("find_notes").run({ pattern: "*kickoff*" });
    expect(result).toBe("Projects/Kickoff plan.md\n"
      + "[and 1 attachment(s) match too: Inbox/Kickoff deck.pptx; read_attachment reads them]");
  });

  it("adds nothing when only notes match", async () => {
    const vault = await makeVault({ "Projects/Kickoff plan.md": "# Plan", "Inbox/Invoice.pdf": "x" });
    expect(await vault.tool("find_notes").run({ pattern: "kickoff" })).toBe("Projects/Kickoff plan.md");
  });

  it("names three attachments and counts the rest", async () => {
    const vault = await makeVault({
      "Notes/Report.md": "# R", "a/Report 1.pdf": "x", "a/Report 2.pdf": "x", "a/Report 3.pdf": "x", "a/Report 4.pdf": "x",
    });
    const result = await vault.tool("find_notes").run({ pattern: "report" });
    expect(result.split("\n")[0]).toBe("Notes/Report.md");
    expect(result).toContain("[and 4 attachment(s) match too: a/Report 1.pdf, a/Report 2.pdf, a/Report 3.pdf, and 1 more;");
  });

  it("answers a pattern naming a file type with the attachments alone, as before", async () => {
    const vault = await makeVault({ "Notes/Invoice notes.md": "# I", "Inbox/Invoice.pdf": "x" });
    const result = await vault.tool("find_notes").run({ pattern: "*.pdf" });
    expect(result.startsWith("Inbox/Invoice.pdf")).toBe(true);
    expect(result).not.toContain("match too");
  });

  it("keeps attachments outside an agent's folders out of the note", async () => {
    const vault = await makeVault({ "Work/Kickoff plan.md": "# Plan", "Private/Kickoff photo.png": "x" });
    const result = await vault.tool("find_notes", ["Work"]).run({ pattern: "kickoff" });
    expect(result).toBe("Work/Kickoff plan.md");
  });
});
