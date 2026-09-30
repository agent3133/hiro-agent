// The first start (#110): whether a connection is set up, and finding a llama.cpp server on this computer.
import { describe, expect, it } from "vitest";

import { hasConnection, resolveConnection } from "../config/connections";
import { addLocalServer, findLocalServers, type ProbeAnswer } from "./connections";

/** A probe where only *answering* URLs answer, with a llama.cpp /v1/models body naming *model*. */
function probeWith(answering: Record<string, string>): { probe: (url: string) => Promise<ProbeAnswer | null>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    probe: async (url) => {
      asked.push(url);
      return url in answering ? { status: 200, body: { data: [{ id: answering[url] }] } } : null;
    },
  };
}

describe("hasConnection", () => {
  it("is false for a new vault's empty settings", () => {
    expect(hasConnection({})).toBe(false);
    expect(hasConnection({ llm: { temperature: 0.5 }, llm_profiles: {} })).toBe(false);
  });

  it("is true with a named connection, or an llm section with a server or a key", () => {
    expect(hasConnection({ llm_profiles: { local: { provider: "llamacpp" } } })).toBe(true);
    expect(hasConnection({ llm: { base_url: "http://127.0.0.1:8080" } })).toBe(true);
    expect(hasConnection({ llm: { api_key: "${OPENAI_API_KEY}" } })).toBe(true);
  });
});

describe("resolveConnection without a model", () => {
  it("assumes no model name for an OpenAI-compatible connection", () => {
    expect(resolveConnection({ llm: { provider: "openai", api_key: "${K}" } }, "", () => "k").model).toBe("");
  });
});

describe("findLocalServers", () => {
  it("finds the servers answering on 8080 and 8090, named local and local-8090", async () => {
    const { probe } = probeWith({ "http://127.0.0.1:8080/v1/models": "qwen", "http://127.0.0.1:8090/v1/models": "gemma" });
    expect(await findLocalServers({}, probe)).toEqual([
      { port: 8080, baseUrl: "http://127.0.0.1:8080", model: "qwen", name: "local" },
      { port: 8090, baseUrl: "http://127.0.0.1:8090", model: "gemma", name: "local-8090" },
    ]);
  });

  it("skips a port a connection already points at, and does not ask it", async () => {
    const { probe, asked } = probeWith({ "http://127.0.0.1:8090/v1/models": "gemma" });
    const found = await findLocalServers({ mine: { base_url: "http://localhost:8080/v1" } }, probe);
    expect(asked).toEqual(["http://127.0.0.1:8090/v1/models"]);
    expect(found.map((server) => server.port)).toEqual([8090]);
  });

  it("finds nothing when nothing answers", async () => {
    expect(await findLocalServers({}, probeWith({}).probe)).toEqual([]);
  });

  it("picks a free name when 'local' is taken", async () => {
    const { probe } = probeWith({ "http://127.0.0.1:8080/v1/models": "qwen" });
    const [server] = await findLocalServers({ local: { base_url: "https://api.example.com" } }, probe);
    expect(server.name).toBe("local-2");
  });
});

describe("addLocalServer", () => {
  const server = { port: 8080, baseUrl: "http://127.0.0.1:8080", model: "qwen", name: "local" };

  it("adds a llama.cpp connection and makes it the default when there is none", () => {
    expect(addLocalServer(server, "")).toEqual({
      llm_profiles: { local: { provider: "llamacpp", base_url: "http://127.0.0.1:8080" } },
      default_llm_profile: "local",
    });
  });

  it("leaves an existing default alone", () => {
    expect(addLocalServer(server, "cloud")).toEqual({
      llm_profiles: { local: { provider: "llamacpp", base_url: "http://127.0.0.1:8080" } },
    });
  });
});
