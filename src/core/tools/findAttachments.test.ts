// find_notes and attachments (#95): a pattern naming another file type finds those files, and says they are read
// with read_attachment — where Python's find_notes found nothing, and the model told the user there were no images.
import { describe, expect, it } from "vitest";

import { makeVault } from "../testing/vault";

const FILES = {
  "Notes/Trip.md": "![[photo.png]]",
  "Attachments/photo.png": "png",
  "Attachments/Scan 2026.PNG": "png",
  "Attachments/report.pdf": "pdf",
  "Notes/Meeting 26.09.md": "minutes",
  "Notes/v1.2 release.md": "notes",
  ".trash/old.png": "gone",
};

const NOTE = "\n(Attachments, not notes: read_attachment reads images, PDFs and recordings; read_note does not.)";

describe("find_notes, for attachments", () => {
  it("finds the files a pattern's type names, any case, skipping dot folders, and says how to read them", async () => {
    const vault = await makeVault(FILES);
    expect(await vault.tool("find_notes").run({ pattern: "*.png" }))
      .toBe(`Attachments/Scan 2026.PNG\nAttachments/photo.png${NOTE}`);
    expect(await vault.tool("find_notes").run({ pattern: "report.pdf" })).toBe(`Attachments/report.pdf${NOTE}`);
  });

  it("keeps to the folder and the limit", async () => {
    const vault = await makeVault({ ...FILES, "Other/x.png": "png" });
    expect(await vault.tool("find_notes").run({ pattern: "*.png", folder: "Other" })).toBe(`Other/x.png${NOTE}`);
    expect(await vault.tool("find_notes").run({ pattern: "*.png", limit: 1 }))
      .toBe(`Attachments/Scan 2026.PNG\n[2 more]${NOTE}`);
  });

  it("keeps to a restricted agent's folders", async () => {
    const vault = await makeVault(FILES);
    expect(await vault.tool("find_notes", ["Notes"]).run({ pattern: "*.png" }))
      .toBe("No files or notes match '*.png' (only 'Notes/' searched: this agent is restricted to those folders, so "
            + "a note elsewhere in the vault cannot be found or read by it — tell the user so rather than that the note "
            + "does not exist)");
  });

  it("says when neither a file nor a note matches", async () => {
    const vault = await makeVault(FILES);
    expect(await vault.tool("find_notes").run({ pattern: "*.mp3" })).toBe("No files or notes match '*.mp3'");
  });

  it("still finds a note whose name only has a dot in it", async () => {
    const vault = await makeVault(FILES);
    expect(await vault.tool("find_notes").run({ pattern: "Meeting 26.09" })).toBe("Notes/Meeting 26.09.md");
    expect(await vault.tool("find_notes").run({ pattern: "v1.2" })).toBe("Notes/v1.2 release.md");
  });

  it("finds notes for *.md, as before", async () => {
    const vault = await makeVault(FILES);
    expect(await vault.tool("find_notes").run({ pattern: "*.md", folder: "Notes" }))
      .toBe("Notes/Meeting 26.09.md\nNotes/Trip.md\nNotes/v1.2 release.md");
  });
});
