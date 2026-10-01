// web_fetch opens pages on the internet, and nothing on this computer or the local network (#138).
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fetchPublic, isBlockedAddress, type FetchRules } from "./publicFetch";

describe("isBlockedAddress", () => {
  it.each(["127.0.0.1", "127.1.2.3", "10.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.1.10", "169.254.169.254",
           "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd12:3456::1",
           "::ffff:127.0.0.1", "::ffff:192.168.0.1", "not an address"])("%s is refused", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "1.1.1.1", "172.15.0.1", "172.32.0.1", "192.169.0.1", "2606:4700:4700::1111",
           "::ffff:93.184.216.34"])("%s is public", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("fetchPublic", () => {
  // A local server stands in for the internet: in these rules "public.example" resolves to it and its loopback
  // address counts as public; "inside.example" resolves to 10.0.0.5, which stays refused
  let server: http.Server;
  let port = 0;
  let hits: string[] = [];
  beforeAll(async () => {
    server = http.createServer((request, response) => {
      hits.push(`${request.headers.host} ${request.url}`);
      const send = (status: number, headers: Record<string, string>, body = ""): void => {
        response.writeHead(status, headers);
        response.end(body);
      };
      if (request.url === "/page") send(200, { "Content-Type": "text/html" }, "<title>A page</title><p>hello</p>");
      else if (request.url === "/to-page") send(301, { Location: "/page" });
      else if (request.url === "/to-inside") send(302, { Location: `http://inside.example:${port}/secret` });
      else if (request.url === "/to-loopback") send(302, { Location: `http://127.0.0.2:${port}/secret` });
      else if (request.url === "/to-file") send(302, { Location: "file:///etc/passwd" });
      else if (request.url === "/loop") send(302, { Location: "/loop" });
      else if (request.url === "/big") send(200, { "Content-Type": "text/plain" }, "x".repeat(10_000));
      else if (request.url === "/umlaut") {
        // "Grüße" with the two bytes of "ü" in different chunks
        const bytes = new TextEncoder().encode("Grüße");
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        response.write(bytes.subarray(0, 3));
        setTimeout(() => response.end(bytes.subarray(3)), 20);
      }
      else send(404, {}, "secret stuff");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const rules: FetchRules = {
    resolve: async (host) => {
      if (host === "public.example") return [{ address: "127.0.0.1", family: 4 }];
      if (host === "inside.example") return [{ address: "10.0.0.5", family: 4 }];
      if (host === "both.example") return [{ address: "127.0.0.1", family: 4 }, { address: "192.168.0.7", family: 4 }];
      throw new Error(`no such host ${host}`);
    },
    blocked: (address) => address !== "127.0.0.1" && isBlockedAddress(address),
  };
  const options = { timeoutMs: 5000, maxBytes: 1000 };
  const at = (path: string, host = "public.example") => `http://${host}:${port}${path}`;

  it("reads a character split across two chunks whole (#183)", async () => {
    expect((await fetchPublic(at("/umlaut"), options, rules)).text).toBe("Grüße");
  });

  it("reads a page and says where it came from", async () => {
    const page = await fetchPublic(at("/page"), options, rules);
    expect(page).toMatchObject({ status: 200, contentType: "text/html", cut: false });
    expect(page.text).toContain("hello");
  });

  it("follows a redirect to the internet", async () => {
    const page = await fetchPublic(at("/to-page"), options, rules);
    expect(page.url).toBe(at("/page"));
    expect(page.text).toContain("hello");
  });

  it("refuses a redirect into the local network or this computer, without connecting there", async () => {
    hits = [];
    await expect(fetchPublic(at("/to-inside"), options, rules)).rejects.toThrow("inside.example is on this computer or the local network (10.0.0.5)");
    await expect(fetchPublic(at("/to-loopback"), options, rules)).rejects.toThrow("(127.0.0.2)");
    expect(hits.filter((hit) => hit.endsWith("/secret"))).toEqual([]);
  });

  it("refuses a redirect to another scheme, and endless redirects", async () => {
    await expect(fetchPublic(at("/to-file"), options, rules)).rejects.toThrow("only http and https");
    await expect(fetchPublic(at("/loop"), { ...options, maxRedirects: 3 }, rules)).rejects.toThrow("more than 3 redirects");
  });

  it("refuses an address inward before connecting, however it is written", async () => {
    hits = [];
    await expect(fetchPublic(at("/page", "inside.example"), options, rules)).rejects.toThrow("(10.0.0.5)");
    await expect(fetchPublic("http://169.254.169.254/latest/meta-data/", options, rules)).rejects.toThrow("169.254.169.254");
    await expect(fetchPublic(`http://[::1]:${port}/page`, options, rules)).rejects.toThrow("::1");
    await expect(fetchPublic(at("/page", "both.example"), options, rules)).rejects.toThrow("192.168.0.7");
    expect(hits).toEqual([]);
  });

  it("refuses the loopback address itself with the real rules", async () => {
    await expect(fetchPublic(`http://127.0.0.1:${port}/page`, options)).rejects.toThrow("local network (127.0.0.1)");
    await expect(fetchPublic(`http://localhost:${port}/page`, options)).rejects.toThrow("on this computer or the local network");
  });

  it("cuts the body at the byte limit and says so", async () => {
    const page = await fetchPublic(at("/big"), options, rules);
    expect(page.cut).toBe(true);
    expect(page.text).toHaveLength(1000);
  });
});
