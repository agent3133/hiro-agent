import { describe, expect, it } from "vitest";

import { closeNames, sameNameWrittenDifferently } from "./attachments";

// The vault's "Einverstndniserklrung.pdf" had lost its umlauts; the model asked for the German word, then for a
// version with a space where the ä was, and was told only "not found" eight times (2026-10-05)
const FILES = ["Einverstndniserklrung.pdf", "Inbox/Invoice 2026-118.pdf", "Inbox/Whiteboard 2026-09-30.png"];

describe("finding an attachment whose name was written differently", () => {
  it("matches a name whose file lost its umlauts, with the umlauts or with spaces in their place", () => {
    expect(sameNameWrittenDifferently("Einverständniserklärung.pdf", FILES)).toEqual(["Einverstndniserklrung.pdf"]);
    expect(sameNameWrittenDifferently("Einverstndniserkl rung.pdf", FILES)).toEqual(["Einverstndniserklrung.pdf"]);
  });

  it("matches across case, Unicode forms, folded accents and spelled-out umlauts", () => {
    const files = ["Docs/Einverständniserklärung.pdf"];
    expect(sameNameWrittenDifferently("einverstandniserklarung.PDF", files)).toEqual(files);
    expect(sameNameWrittenDifferently("Einverstaendniserklaerung.pdf", files)).toEqual(files);
    expect(sameNameWrittenDifferently("Einverständniserklärung.pdf".normalize("NFD"), files)).toEqual(files);
  });

  it("does not match another name, or the same name with another extension", () => {
    expect(sameNameWrittenDifferently("Einwilligung.pdf", FILES)).toEqual([]);
    expect(sameNameWrittenDifferently("Einverständniserklärung.docx", FILES)).toEqual([]);
  });

  it("names the closest files when nothing matches, by name whatever their folder", () => {
    expect(closeNames("Invoice 2026-181.pdf", FILES)).toEqual(["Inbox/Invoice 2026-118.pdf"]);
    expect(closeNames("Quarterly report.xlsx", FILES)).toEqual([]);
  });
});
