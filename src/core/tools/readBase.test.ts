import { describe, expect, it } from "vitest";

import { TEXT_EXTENSIONS, textAttachment } from "../documents/textFile";
import { makeVault } from "../testing/vault";

// A .base file is YAML: read_note sent the model to read_attachment, which refused it, so a Base's definition could
// not be read at all (2026-10-05)
const BASE = "filters:\n  and:\n    - file.hasTag(\"task\")\nviews:\n  - type: table\n    name: Open\n";
const HINT = "[The definition of a Base (YAML). query_base runs it and returns its rows.]";

describe("reading a .base file", () => {
  it("read_note returns the Base's definition and says query_base runs it", async () => {
    const vault = await makeVault({ "Bases/Tasks - Open by project.base": BASE });
    expect(await vault.tool("read_note").run({ path: "Bases/Tasks - Open by project.base" }))
      .toBe(`${BASE.trimEnd()}\n\n${HINT}`);
  });

  it("read_notes reads it among notes, and still refuses an image", async () => {
    const vault = await makeVault({ "Bases/Open.base": BASE, "Notes/Plan.md": "# Plan\n", "img/p.png": "x" });
    const answer = await vault.tool("read_notes").run({ paths: ["Bases/Open.base", "Notes/Plan.md", "img/p.png"] });
    expect(answer).toContain(`## Bases/Open.base\n${BASE.trimEnd()}\n\n${HINT}`);
    expect(answer).toContain("## Notes/Plan.md\n# Plan");
    expect(answer).toContain("Error: 'img/p.png' is an attachment (image), not a note; read it with read_attachment");
  });

  it("read_attachment reads it as text", () => {
    expect(TEXT_EXTENSIONS).toContain("base");
    expect(textAttachment("Bases/Open.base", BASE)).toBe(`File 'Bases/Open.base' — 6 lines:\n\n${BASE}`);
  });
});
