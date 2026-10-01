// Ported from tests/test_server_config.py — the agent's configuration, kept by the plugin (#86). Python's HTTP calls
// are the store's: `client.get("/config").json()` is `await store.config()`, `client.put("/config", json={"values":
// X})` is `await store.putConfig(X)` (a 422 is `ok: false` with `fields`), and `written(config_file)` is what the
// store holds afterwards.
import { describe, expect, it } from "vitest";

import { ConfigStore, merge, withoutObsolete } from "./store";
import { stringify } from "yaml";

/** A made-up credential, joined at runtime: no file holds a whole token for secret scanners (GitHub's push
 * protection blocked the first release over one) to mistake for a leak. */
const fake = (...parts: string[]): string => parts.join("");

const KEY = fake("sk-proj-", "abcdefghijklmnopqrstuvwxyz0123456789");

/** The Python `config_file` fixture: a literal secret, an environment reference, and something ordinary to change. */
const CONFIG = {
  vault: { default_agent: "default" },
  llm: { provider: "openai", model: "gpt-5.4-mini", api_key: KEY, temperature: 0.7 },
  llm_profiles: { local: { provider: "llamacpp", base_url: "http://127.0.0.1:8080" },
                  cloud: { provider: "openai", api_key: "${OPENAI_API_KEY}" } },
  // Python's fixture had `ui: { theme: "dark" }` here; the plugin has no ui section (#180)
  journal: { turns: 20 },
};

/** A store holding *values*, and what it has written (Python's `client` and `written`). */
function storeWith(values: Record<string, unknown> = structuredClone(CONFIG)) {
  let stored = values;
  let writes = 0;
  const store = new ConfigStore(() => stored, async (next) => {
    stored = next;
    writes += 1;
  }, () => "C:/vault");
  return { store, written: () => stored as Record<string, Record<string, unknown>>, writes: () => writes };
}

describe("test_server_config.py", () => {
  it("test_get_config_answers_with_the_schema_the_values_and_the_path", async () => {
    const { store } = storeWith();
    const body = await store.config();
    expect(body.exists).toBe(true);
    expect((body.values.llm as Record<string, unknown>).model).toBe("gpt-5.4-mini");
    expect(body.schema.properties).toHaveProperty("llm");
  });

  it("test_merge_none_value_removes_key", () => {
    expect(merge({ x: 1, y: 2 }, { x: null })).toEqual({ y: 2 });
    expect(merge({ a: { x: 1, y: 2 } }, { a: { x: null } })).toEqual({ a: { y: 2 } });
  });

  it("test_the_full_secret_never_leaves_the_process", async () => {
    const { store } = storeWith();
    const body = await store.config();

    expect(stringify(body)).not.toContain(KEY);
    expect((body.values.llm as Record<string, unknown>).api_key).toBe("…6789");
  });

  it("test_an_environment_reference_is_shown_as_it_is", async () => {
    const { store } = storeWith();
    const body = await store.config();

    expect((body.values.llm_profiles as Record<string, Record<string, unknown>>).cloud.api_key).toBe("${OPENAI_API_KEY}");
  });

  it("test_secret_flags_say_which_fields_hold_something", async () => {
    const { store } = storeWith();
    const body = await store.config();

    expect(body.secrets["llm.api_key"]).toBe(true);
    expect(body.secrets["llm_profiles.cloud.api_key"]).toBe(true);
    expect(body.secrets).not.toHaveProperty("llm_profiles.local.api_key");
  });

  it("test_a_valid_change_lands_in_the_file", async () => {
    const { store, written } = storeWith();
    const answer = await store.putConfig({ llm: { model: "qwen3.8" } });

    expect(answer.ok).toBe(true);
    expect(answer.changed).toEqual(["llm.model"]);
    expect(written()["llm"]["model"]).toBe("qwen3.8");
  });

  it("test_a_partial_change_keeps_the_rest_of_its_section", async () => {
    const { store, written } = storeWith();
    await store.putConfig({ llm: { model: "qwen3.8" } });

    const llm = written()["llm"] as Record<string, unknown>;
    expect(llm["api_key"]).toBe(KEY);
    expect(llm["temperature"]).toBe(0.7);
    expect(llm["provider"]).toBe("openai");
  });

  it("test_an_invalid_value_returns_a_field_error_and_changes_nothing", async () => {
    const { store, written } = storeWith();
    const before = structuredClone(written());

    const answer = await store.putConfig({ llm: { temperature: "warm" } });

    expect(answer.ok).toBe(false);
    expect(answer.fields).toBeDefined();
    expect(answer.fields.some((item: { path: string }) => item.path === "llm.temperature")).toBe(true);
    expect(written()).toEqual(before);
  });

  it("test_an_unknown_key_is_refused_rather_than_quietly_stored", async () => {
    const { store, written } = storeWith();
    const before = structuredClone(written());

    const answer = await store.putConfig({ llm: { temperatrue: 0.2 } });

    expect(answer.ok).toBe(false);
    expect(written()).toEqual(before);
  });

  it("test_a_mask_written_back_leaves_the_stored_secret_alone", async () => {
    const { store, written } = storeWith();
    const shown = ((await store.config()).values.llm as Record<string, unknown>).api_key;

    const answer = await store.putConfig({ llm: { api_key: shown, model: "qwen3.8" } });

    expect(written()["llm"]["api_key"]).toBe(KEY);
    expect(answer.changed).toEqual(["llm.model"]);  // the key did not change, so it is not reported as changed
  });

  // Python stored a new key typed into the field. The plugin keeps keys only in Obsidian's keychain: a key written
  // out is refused, and a reference to one is what gets stored
  it("test_a_real_new_secret_is_stored", async () => {
    const { store, written } = storeWith();

    const refused = await store.putConfig({ llm: { api_key: "sk-a-completely-new-key" } });
    expect(refused.ok).toBe(false);
    expect(refused.fields.map((f) => f.path)).toEqual(["llm.api_key"]);
    expect(written()["llm"]["api_key"]).toBe(KEY);

    await store.putConfig({ llm: { api_key: "${LLM_API_KEY}" } });
    expect(written()["llm"]["api_key"]).toBe("${LLM_API_KEY}");
  });

  it("test_a_change_that_changes_nothing_is_not_a_write", async () => {
    const { store, writes } = storeWith();

    const answer = await store.putConfig({ llm: { model: "gpt-5.4-mini" } });

    expect(answer.ok).toBe(true);
    expect(answer.changed).toEqual([]);
    expect(writes()).toBe(0);
  });

  it("test_merge_none_on_missing_key_does_nothing", () => {
    const result = merge({ a: { x: 1 } }, { a: { z: null } });
    expect(result).toEqual({ a: { x: 1 } });
  });

  it("test_put_config_removes_llm_profile", async () => {
    const { store, written } = storeWith();
    const answer = await store.putConfig({ llm_profiles: { cloud: null } });

    expect(answer.ok).toBe(true);
    const llmProfiles = written()["llm_profiles"] as Record<string, unknown>;
    expect(llmProfiles).not.toHaveProperty("cloud");
    expect(llmProfiles).toHaveProperty("local");
  });
});

describe("withoutObsolete", () => {
  it("drops web_search's settings, gone with the tool (#118), and keeps the rest", () => {
    const stored = { builtin_tools: { web_fetch: { timeout: 10 }, web_search: { enabled: true, provider: "duckduckgo" } },
                     llm: { model: "m" } };
    expect(withoutObsolete(stored)).toEqual({ builtin_tools: { web_fetch: { timeout: 10 } }, llm: { model: "m" } });
  });

  it("is null when nothing is obsolete, so nothing is saved", () => {
    expect(withoutObsolete({ builtin_tools: { web_fetch: { timeout: 10 } } })).toBeNull();
    expect(withoutObsolete({})).toBeNull();
  });

  it("lets a change through that stored web_search settings would have failed", async () => {
    let stored: Record<string, unknown> = { builtin_tools: { web_search: { enabled: true } } };
    const store = new ConfigStore(() => stored, async (values) => { stored = values; }, () => "/vault");
    expect((await store.putConfig({ llm: { model: "m" } })).ok).toBe(false);
    stored = withoutObsolete(stored)!;
    expect((await store.putConfig({ llm: { model: "m" } })).ok).toBe(true);
  });
  // What the Python runtime wrote and the plugin never read (#180)
  const PYTHON_ERA = {
    ui: { theme: "dark" }, agents: { dirs: [] }, tools: { dirs: [] },
    external_tools: { git: { enabled: true }, obsidian_cli: { enabled: true } },
    llm: { model: "m", provider_class: "x.Y", thinking_budget: 1024 },
    llm_profiles: { local: { base_url: "http://127.0.0.1:8080", thinking_budget: 512 }, cloud: { model: "c" } },
    memory: { enabled: true, auto_reflect_on_session_end: true },
    journal: { turns: 20 },
  };

  it("drops the Python runtime's sections and fields, wherever a connection has them (#180)", () => {
    expect(withoutObsolete(PYTHON_ERA)).toEqual({
      llm: { model: "m" },
      llm_profiles: { local: { base_url: "http://127.0.0.1:8080" }, cloud: { model: "c" } },
      memory: { enabled: true },
      journal: { turns: 20 },
    });
  });

  it("lets such settings be saved again: nothing left fails the schema", async () => {
    let stored: Record<string, unknown> = structuredClone(PYTHON_ERA);
    const store = new ConfigStore(() => stored, async (values) => { stored = values; }, () => "/vault");
    expect((await store.putConfig({ journal: { turns: 30 } })).ok).toBe(false);
    stored = withoutObsolete(stored)!;
    expect((await store.putConfig({ journal: { turns: 30 } })).ok).toBe(true);
  });
});
