// OpenAI's service tier and reasoning effort per connection: flex at about half the price, a fallback to auto when
// flex is refused, and how much a reasoning model thinks.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { resolveConnection } from "../config/connections";
import { FIRST_BYTE_TIMEOUT_MS, FLEX_FIRST_BYTE_TIMEOUT_MS, OpenAiChat, requestBody } from "./llm/openaiChat";

const settings = { baseUrl: "http://x/v1", model: "m", temperature: 0.7 };
const ask = { messages: [{ role: "user" as const, content: "hi" }], tools: [] };

describe("the service tier in a request", () => {
  it("is sent when the connection sets one, and not at all otherwise", () => {
    expect(requestBody({ ...settings, serviceTier: "flex" }, ask).service_tier).toBe("flex");
    expect(requestBody(settings, ask)).not.toHaveProperty("service_tier");
  });

  it("is read from a connection, the fallback on unless switched off", () => {
    const read = (values: Record<string, unknown>) =>
      resolveConnection({ llm_profiles: { cloud: { base_url: "https://api.openai.com/v1", model: "gpt", ...values } } }, "cloud", () => undefined);
    expect(read({ service_tier: "flex" })).toMatchObject({ serviceTier: "flex", serviceTierFallback: true });
    expect(read({ service_tier: "flex", service_tier_fallback: false }).serviceTierFallback).toBe(false);
    expect(read({}).serviceTier).toBeUndefined();
  });

  it("sends the reasoning effort when the connection sets one, and not at all otherwise", () => {
    expect(requestBody({ ...settings, reasoningEffort: "low" }, ask).reasoning_effort).toBe("low");
    expect(requestBody(settings, ask)).not.toHaveProperty("reasoning_effort");
    const read = (values: Record<string, unknown>) =>
      resolveConnection({ llm_profiles: { cloud: { base_url: "https://api.openai.com/v1", model: "gpt", ...values } } }, "cloud", () => undefined);
    expect(read({ reasoning_effort: "high" }).reasoningEffort).toBe("high");
    expect(read({}).reasoningEffort).toBeUndefined();
  });

  it("sends no temperature to a reasoning connection unless one is set, and 0.7 to any other", () => {
    const read = (values: Record<string, unknown>) =>
      resolveConnection({ llm_profiles: { cloud: { base_url: "https://api.openai.com/v1", model: "gpt", ...values } } }, "cloud", () => undefined);
    const reasoning = read({ reasoning_effort: "low" });
    expect(reasoning.temperature).toBeUndefined();
    expect(requestBody({ ...settings, temperature: reasoning.temperature }, ask)).not.toHaveProperty("temperature");
    expect(read({ reasoning_effort: "low", temperature: 1 }).temperature).toBe(1);
    expect(read({}).temperature).toBe(0.7);
  });

  it("gives a flex request OpenAI's 15 minutes before its first byte", () => {
    expect(FLEX_FIRST_BYTE_TIMEOUT_MS).toBe(15 * 60_000);
    expect(FLEX_FIRST_BYTE_TIMEOUT_MS).toBeGreaterThan(FIRST_BYTE_TIMEOUT_MS);
  });
});

describe("a flex request OpenAI refuses", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  /** A server that refuses flex with 429 and answers any other tier; the tiers it was asked for. */
  async function refusingFlex(): Promise<{ baseUrl: string; tiers: unknown[] }> {
    const tiers: unknown[] = [];
    server = createServer((req, res) => {
      let text = "";
      req.on("data", (part) => (text += part));
      req.on("end", () => {
        const body = JSON.parse(text) as Record<string, unknown>;
        tiers.push(body.service_tier);
        if (body.service_tier === "flex") {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Resource unavailable for flex processing", code: "resource_unavailable" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, tiers };
  }

  it("is sent once more at tier auto when the fallback is on", async () => {
    const { baseUrl, tiers } = await refusingFlex();
    const chat = new OpenAiChat({ ...settings, baseUrl, serviceTier: "flex", serviceTierFallback: true });
    expect((await chat.complete(ask, {})).content).toBe("ok");
    expect(tiers).toEqual(["flex", "auto"]);
  });

  it("fails with what happened and what to do when the fallback is off", async () => {
    const { baseUrl, tiers } = await refusingFlex();
    const chat = new OpenAiChat({ ...settings, baseUrl, serviceTier: "flex", serviceTierFallback: false });
    await expect(chat.complete(ask, {})).rejects.toThrow(/refused the request at the flex service tier \(HTTP 429\).*Service tier fallback/s);
    expect(tiers).toEqual(["flex"]);
  });
});
