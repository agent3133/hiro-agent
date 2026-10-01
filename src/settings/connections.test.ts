// The first start (#110): whether a connection is set up, and finding a llama.cpp server on this computer.
import { describe, expect, it } from "vitest";

import { hasConnection, resolveConnection } from "../config/connections";
import { addLocalServer, describeConnection, draftChange, draftOf, draftProblem, findLocalServers, modelsUrl, testVerdict,
  type ProbeAnswer } from "./connections";
import { connectionApproval } from "../config/deviceApprovals";

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
      { port: 8080, baseUrl: "http://127.0.0.1:8080", model: "qwen", models: 1, name: "local" },
      { port: 8090, baseUrl: "http://127.0.0.1:8090", model: "gemma", models: 1, name: "local-8090" },
    ]);
  });

  it("skips a port a connection already points at, and does not ask it", async () => {
    const { probe, asked } = probeWith({ "http://127.0.0.1:8090/v1/models": "gemma" });
    const found = await findLocalServers({ mine: { base_url: "http://localhost:8080/v1" } }, probe);
    expect(asked.filter((url) => url.includes(":8080"))).toEqual([]);
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
  const server = { port: 8080, baseUrl: "http://127.0.0.1:8080", model: "qwen", models: 1, name: "local" };

  it("adds the server's address and makes it the default when there is none", () => {
    expect(addLocalServer(server, "")).toEqual({
      llm_profiles: { local: { base_url: "http://127.0.0.1:8080" } },
      default_llm_profile: "local",
    });
  });

  it("leaves an existing default alone", () => {
    expect(addLocalServer(server, "cloud")).toEqual({
      llm_profiles: { local: { base_url: "http://127.0.0.1:8080" } },
    });
  });

  it("names the first model when the server offers several", () => {
    expect(addLocalServer({ ...server, port: 11434, baseUrl: "http://127.0.0.1:11434", model: "qwen3:14b", models: 3 },
                          "cloud")).toEqual({
      llm_profiles: { local: { base_url: "http://127.0.0.1:11434", model: "qwen3:14b" } },
    });
  });
});

describe("the connection form (#149)", () => {
  const cloud = { provider: "openai", model: "gpt-4o-mini", api_key: "${openai-api-key}" };

  it("reads a stored connection into the form", () => {
    expect(draftOf("cloud", cloud)).toEqual({ name: "cloud", baseUrl: "", model: "gpt-4o-mini", key: "openai-api-key" });
    expect(draftOf("x", { provider: "llamacpp", api_key: "written-out" })).toMatchObject({ key: "" });
  });

  it("says what must be fixed before saving", () => {
    const ok = { name: "cloud", baseUrl: "", model: "gpt-4o-mini", key: "" };
    expect(draftProblem(ok, [])).toBeNull();
    expect(draftProblem({ ...ok, name: "my cloud" }, [])).toContain("letters, digits");
    expect(draftProblem(ok, ["cloud"])).toContain("already a connection called cloud");
    expect(draftProblem({ ...ok, model: "" }, [])).toContain("Name the model");
    expect(draftProblem({ ...ok, baseUrl: "api.example.com" }, [])).toContain("http:// or https://");
    // A server of your own may leave the model to what it runs
    expect(draftProblem({ ...ok, model: "", baseUrl: "http://127.0.0.1:11434" }, [])).toBeNull();
  });

  it("saves the whole connection, empty fields removed, and makes it the default when there is none", () => {
    const draft = { name: "cloud", baseUrl: "", model: "gpt-4o-mini", key: "openai-api-key" };
    expect(draftChange(draft, null, "")).toEqual({
      llm_profiles: { cloud: { provider: null, base_url: null, model: "gpt-4o-mini", api_key: "${openai-api-key}" } },
      default_llm_profile: "cloud",
    });
    expect(draftChange(draft, null, "local")).not.toHaveProperty("default_llm_profile");
  });

  it("renames by removing the old entry, and moves the default along", () => {
    const draft = { name: "work", baseUrl: "", model: "m", key: "" };
    expect(draftChange(draft, "cloud", "cloud")).toEqual({
      llm_profiles: { work: { provider: null, base_url: null, model: "m", api_key: null }, cloud: null },
      default_llm_profile: "work",
    });
  });

  it("describes a row by what is set, not by placeholders", () => {
    expect(describeConnection(cloud)).toBe("gpt-4o-mini · api.openai.com · key openai-api-key");
    expect(describeConnection({ provider: "openai" })).toBe("no model set · api.openai.com · no key");
    expect(describeConnection({ base_url: "http://127.0.0.1:8080" }, "llama.cpp"))
      .toBe("the server's model · llama.cpp · 127.0.0.1:8080");
    expect(describeConnection({ base_url: "http://127.0.0.1:11434", model: "qwen3:14b" }))
      .toBe("qwen3:14b · 127.0.0.1:11434");
  });

  it("tests at the models address: /v1 added to a bare server address, OpenAI's when empty", () => {
    expect(modelsUrl({ baseUrl: "" })).toBe("https://api.openai.com/v1/models");
    expect(modelsUrl({ baseUrl: "https://openrouter.ai/api/v1/" })).toBe("https://openrouter.ai/api/v1/models");
    expect(modelsUrl({ baseUrl: "http://127.0.0.1:8080" })).toBe("http://127.0.0.1:8080/v1/models");
    expect(modelsUrl({ baseUrl: "http://127.0.0.1:11434/" })).toBe("http://127.0.0.1:11434/v1/models");
  });

  it("says whether the key was accepted, refused, or not sent", () => {
    const url = "https://api.example.com/v1/models";
    const ok: ProbeAnswer = { status: 200, body: { data: [{ id: "gpt-4o-mini" }] } };
    expect(testVerdict(url, ok, true)).toEqual({ ok: true, text: "Works, and the key was accepted: it serves gpt-4o-mini." });
    expect(testVerdict(url, { status: 401, body: {} }, true).text).toContain("refused the key (HTTP 401)");
    expect(testVerdict(url, { status: 401, body: {} }, false).text).toContain("wants a key");
    expect(testVerdict(url, { status: 404, body: {} }, false).text).toContain("check the address");
    expect(testVerdict(url, null, false).ok).toBe(false);
  });

  it("needs no approval for a key that has no address to go to", () => {
    expect(connectionApproval({ llm_profiles: { l: { provider: "llamacpp", api_key: "${k}" } } }, "l")).toBeNull();
  });
});
