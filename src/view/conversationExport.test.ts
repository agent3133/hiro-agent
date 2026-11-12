// The kept conversation as a note the user can read (#412): its Markdown, the note's name, and the free path it goes to.
// These are plain functions with no `obsidian` import, so the tests run in Node.
import { describe, expect, it } from "vitest";

import { conversationMarkdown, exportName, freePath, readableUserMessage } from "./conversationExport";

describe("conversationMarkdown (#412)", () => {
  it("writes the title, the export day, the summary as a callout, then each question and answer, and no system or empty message", () => {
    const markdown = conversationMarkdown(
      "Plan",
      [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "system", content: "x" },
        { role: "user", content: "  " },
      ],
      { text: "Before: a\nb" },
      new Date("2026-11-11T10:00:00Z"),
    );

    // No "# Plan": the note is named after the title, and Obsidian shows the name above the text
    expect(markdown).toBe([
      "*\"Plan\", a conversation with Hiro Agent, exported on 2026-11-11.*",
      "",
      "> [!summary] Earlier in this conversation",
      "> Before: a",
      "> b",
      "",
      "## You",
      "",
      "Hi",
      "",
      "## Hiro Agent",
      "",
      "Hello",
      "",
    ].join("\n"));
    expect(markdown).not.toContain("# Plan");
    expect(markdown).not.toContain("\nx\n");
  });
});

describe("exportName (#412)", () => {
  it("leaves out the characters a file name cannot hold: / : ?", () => {
    const name = exportName("a/b: c?");
    expect(name).not.toMatch(/[/:?]/);
    expect(name).toBe("a b c");
  });

  it("names an export of an untitled conversation \"Conversation\"", () => {
    expect(exportName("")).toBe("Conversation");
  });
});

describe("freePath (#412)", () => {
  it("puts the note in the folder under its name, with .md", () => {
    expect(freePath("Notes", "Plan", () => false)).toBe("Notes/Plan.md");
  });

  it("numbers the note when its name is taken: \"Plan 2.md\"", () => {
    expect(freePath("Notes", "Plan", (path) => path === "Notes/Plan.md")).toBe("Notes/Plan 2.md");
  });

  it("puts the note at the vault root when the folder is \"/\"", () => {
    expect(freePath("/", "Plan", () => false)).toBe("Plan.md");
  });
});

describe("readableUserMessage (#412)", () => {
  it("leaves out the open note's path that the chat added: \"what is this?\"", () => {
    expect(readableUserMessage("what is this?\n\n[Active note: Notes/a.md]")).toBe("what is this?");
  });

  it("keeps the selection the chat sent as a quote, and leaves out the note's path", () => {
    expect(readableUserMessage("tidy these\n\n[Active note: a.md]\n\n[Selected text]\nline one\nline two"))
      .toBe("tidy these\n\n> line one\n> line two");
  });

  it("names the attached files as links, in place of the instructions: \"Attached: [[a.pdf]], [[b c.docx]]\"", () => {
    expect(readableUserMessage(
      "read\n\nAttached (saved in the vault; read each one with read_attachment):\n- ![[a.pdf]]\n- ![[b c.docx]]",
    )).toBe("read\n\nAttached: [[a.pdf]], [[b c.docx]]");
  });

  it("names one attached file as \"Attached: [[a.pdf]]\" when the instruction says \"read it\"", () => {
    expect(readableUserMessage(
      "read it\n\nAttached (saved in the vault; read it with read_attachment):\n- ![[a.pdf]]",
    )).toBe("read it\n\nAttached: [[a.pdf]]");
  });
});

describe("conversationMarkdown reads user messages back (#412)", () => {
  it("leaves out the note path in a user message, and keeps the same text in an assistant message", () => {
    const markdown = conversationMarkdown(
      "Plan",
      [
        { role: "user", content: "hi\n\n[Active note: x]" },
        { role: "assistant", content: "see [Active note: x]" },
      ],
      null,
      new Date("2026-11-11T10:00:00Z"),
    );

    // The header is not what this test is about, so only the two message sections are checked
    expect(markdown).toContain("## You\n\nhi\n\n## Hiro Agent\n\nsee [Active note: x]");
    expect(markdown).not.toContain("hi\n\n[Active note: x]");
  });
});
