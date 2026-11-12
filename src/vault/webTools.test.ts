// web_fetch on the obsidian stand-in (#398): what it asks fetchPublic for, and what the model is told back. The
// address checks themselves are publicFetch's, tested there; here fetchPublic is a stand-in.
import { afterEach, describe, expect, it, vi } from "vitest";

const fetched: { url: string; options: Record<string, unknown> }[] = [];
let respond: (url: string) => Promise<{ status: number; url: string; contentType: string; text: string; cut: boolean }>;

vi.mock("../core/publicFetch", () => ({
  fetchPublic: (url: string, options: Record<string, unknown>) => {
    fetched.push({ url, options });
    return respond(url);
  },
}));

const { DEFAULT_WEB, makeWebTools, normalizeUrl } = await import("./webTools");

const on = { fetch: { ...DEFAULT_WEB.fetch, enabled: true, maxContentLength: 50 } };
const page = (text: string, contentType = "text/plain", status = 200) => async (url: string) =>
  ({ status, url, contentType, text, cut: false });
const binary = (contentType: string, size: number) => async (url: string) =>
  ({ status: 200, url, contentType, text: "", cut: false, binary: true, size });

afterEach(() => {
  fetched.length = 0;
});

describe("web_fetch", () => {
  it("is not offered while Open web pages is off", () => {
    expect(makeWebTools(DEFAULT_WEB)).toEqual([]);
  });

  it("asks for https when given http, and a GitHub file page's raw text", async () => {
    respond = page("hello");
    await makeWebTools(on)[0].run({ url: "http://example.com/a" });
    expect(fetched[0].url).toBe("https://example.com/a");
    expect(normalizeUrl("https://github.com/o/r/blob/main/README.md"))
      .toBe("https://raw.githubusercontent.com/o/r/main/README.md");
  });

  it("turns an HTML page into Markdown without repeating a title it already says, and cuts it to the limit", async () => {
    // The stand-in's htmlToMarkdown keeps the head's text, so the title is in the body already
    respond = page("<html><head><title>The Title</title></head><body><p>Body text</p></body></html>", "text/html");
    expect(await makeWebTools(on)[0].run({ url: "https://example.com" })).toBe("The TitleBody text");
    respond = page("y".repeat(80));
    expect(await makeWebTools(on)[0].run({ url: "https://example.com" }))
      .toBe(`${"y".repeat(50)}\n\n[Content truncated to 50 characters.]`);
  });

  it("says an HTTP error and a refused address as an error for the model, not a throw", async () => {
    respond = page("missing", "text/plain", 404);
    expect(await makeWebTools(on)[0].run({ url: "https://example.com/x" }))
      .toBe("Error: Could not fetch URL: HTTP 404 for https://example.com/x");
    respond = async () => { throw new Error("127.0.0.1 is on this computer or the local network (127.0.0.1)"); };
    expect(await makeWebTools(on)[0].run({ url: "https://localhost" }))
      .toBe("Error: Could not fetch URL: 127.0.0.1 is on this computer or the local network (127.0.0.1)");
  });

  it("asks for the format the model chose", async () => {
    respond = page("x");
    await makeWebTools(on)[0].run({ url: "https://example.com", format: "text" });
    expect(fetched[0].options.headers).toEqual({ Accept: "text/plain" });
  });

  it("answers a binary download's type and size, and not an error", async () => {
    respond = binary("application/pdf", 2_300_000);
    expect(await makeWebTools(on)[0].run({ url: "https://example.com/a.pdf" }))
      .toContain("application/pdf");
    expect(await makeWebTools(on)[0].run({ url: "https://example.com/a.pdf" }))
      .toContain("2.3 MB");
    expect(await makeWebTools(on)[0].run({ url: "https://example.com/a.pdf" })).not.toContain("Error");
  });

  it("asks fetchPublic to leave a body that is not text unread (#417)", async () => {
    respond = page("x");
    await makeWebTools(on)[0].run({ url: "https://example.com" });
    expect(fetched[0].options.textOnly).toBe(true);
  });

  it("retries a refused http address once, as it was given", async () => {
    respond = async (url: string) => {
      if (url.includes("https")) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return { status: 200, url, contentType: "text/plain", text: "hello", cut: false };
    };
    expect(await makeWebTools(on)[0].run({ url: "http://plain.example/x" })).toBe("hello");
    expect(fetched).toEqual([
      { url: "https://plain.example/x", options: expect.any(Object) },
      { url: "http://plain.example/x", options: expect.any(Object) },
    ]);
  });

  it("does not retry a refused https address, and reports the error once", async () => {
    respond = async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); };
    expect(await makeWebTools(on)[0].run({ url: "https://secure.example/x" }))
      .toBe("Error: Could not fetch URL: connect ECONNREFUSED");
    expect(fetched.length).toBe(1);
  });

  it("does not retry an http address when the error has no code", async () => {
    respond = async () => { throw new Error("127.0.0.1 is on this computer or the local network"); };
    expect(await makeWebTools(on)[0].run({ url: "http://plain.example/x" }))
      .toBe("Error: Could not fetch URL: 127.0.0.1 is on this computer or the local network");
    expect(fetched.length).toBe(1);
  });
});

describe("web_fetch asks once per host in a conversation (#403)", () => {
  it("asks about a page on a host the conversation has not opened, runs it, then does not ask about that host again", async () => {
    const hosts = new Set<string>();
    const tool = makeWebTools(on, hosts)[0];
    expect(await tool.destructiveWhen!({ url: "https://example.com/a" })).toBe(true);
    expect(hosts.size).toBe(0);

    respond = page("hello");
    await tool.run({ url: "https://example.com/a" });
    expect([...hosts]).toEqual(["example.com"]);
    // www. is the same host, and another host is asked about
    expect(await tool.destructiveWhen!({ url: "https://www.example.com/b" })).toBe(false);
    expect(await tool.destructiveWhen!({ url: "https://other.org/" })).toBe(true);
  });

  it("does not ask about any page when there is no set of hosts to keep", async () => {
    const tool = makeWebTools(on)[0];
    expect(await tool.destructiveWhen!({ url: "https://example.com/a" })).toBe(false);
  });

  it("gives the confirmation the address and the host it names", async () => {
    const tool = makeWebTools(on, new Set())[0];
    expect(await tool.confirmArgs!({ url: "https://example.com/a" }))
      .toEqual({ url: "https://example.com/a", host: "example.com" });
  });
});
