// @vitest-environment jsdom
// The plugin on the obsidian stand-in: what this device approves of settings that arrived by sync, and settings that
// change on disk while it runs (#396).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeApp, type TestApp } from "./testing/obsidian";
import ObsidianAgentPlugin from "./main";

/** A connection that sends a keychain key to a server elsewhere: it needs approving on each device (#136). */
const CLOUD = { provider: "openai", base_url: "https://api.example.com/v1", api_key: "${cloud-key}", model: "gpt" };

let t: TestApp;
let plugin: ObsidianAgentPlugin;

/** The plugin as Obsidian starts it, with *data* as its synced `data.json`. */
async function start(data: Record<string, unknown> | null): Promise<ObsidianAgentPlugin> {
  const made = new ObsidianAgentPlugin(t.app as never, { id: "obsidian-agent", version: "9.9.9" } as never);
  (made as unknown as { setStoredData(d: unknown): void }).setStoredData(data);
  await made.onload();
  return made;
}

/** What the plugin's settings hold now, as the store gives them. */
function values(of: ObsidianAgentPlugin): Record<string, unknown> {
  return (of as unknown as { store: { values(): Record<string, unknown> } }).store.values();
}

function store(of: ObsidianAgentPlugin): { putConfig(changes: Record<string, unknown>): Promise<{ ok: boolean }> } {
  return (of as unknown as { store: { putConfig(c: Record<string, unknown>): Promise<{ ok: boolean }> } }).store;
}

beforeEach(async () => {
  t = await makeApp();
});

afterEach(async () => {
  plugin?.onunload();
  await t.cleanup();
});

describe("a new device opening a synced vault (#396)", () => {
  it("leaves a synced connection to a remote server unapproved", async () => {
    plugin = await start({ agentConfig: { llm_profiles: { cloud: CLOUD } } });
    expect(plugin.approvalStatus("connection", "cloud")).toEqual({ what: expect.any(String), approved: false });
  });

  it("leaves synced audio programs unapproved", async () => {
    plugin = await start({ agentConfig: { audio: { whisper_cli: "C:/sync/evil.exe" } } });
    expect(plugin.approvalStatus("programs")?.approved).toBe(false);
  });

  it("approves a connection added in the settings on this device", async () => {
    plugin = await start(null);
    expect((await store(plugin).putConfig({ llm_profiles: { cloud: CLOUD } })).ok).toBe(true);
    expect(plugin.approvalStatus("connection", "cloud")?.approved).toBe(true);
  });
});

describe("the keychain (#398)", () => {
  it("gives a key by its keychain name, and nothing for a name the keychain does not have", async () => {
    plugin = await start(null);
    t.app.secrets.set("cloud-key", "sk-test");
    expect(plugin.keychainValue("cloud-key")).toBe("sk-test");
    expect(plugin.keychainValue("other-key")).toBeUndefined();
  });

  it("never looks up a name that is not a keychain name: no environment variable, no written-out key", async () => {
    plugin = await start(null);
    t.app.secrets.set("PATH", "from-the-keychain");
    expect(plugin.keychainValue("PATH")).toBeUndefined();
    expect(plugin.keychainValue("sk-abc123")).toBeUndefined();
  });

  it("lists the keychain's names in order, for the settings", async () => {
    plugin = await start(null);
    t.app.secrets.set("b-key", "2");
    t.app.secrets.set("a-key", "1");
    expect(plugin.keychainNames()).toEqual(["a-key", "b-key"]);
  });
});

describe("approving on this device (#398)", () => {
  it("approves a synced connection with Approve, and the approval follows its address", async () => {
    plugin = await start({ agentConfig: { llm_profiles: { cloud: CLOUD } } });
    plugin.approveOnThisDevice("connection", "cloud");
    expect(plugin.approvalStatus("connection", "cloud")?.approved).toBe(true);
  });

  it("asks nothing for a connection that sends no key", async () => {
    plugin = await start({ agentConfig: { llm_profiles: { local: { provider: "llamacpp", base_url: "http://127.0.0.1:8080" } } } });
    expect(plugin.approvalStatus("connection", "local")).toBeNull();
  });

  it("keeps Developer on this device, outside the synced settings", async () => {
    plugin = await start(null);
    expect(plugin.developer()).toBe(false);
    plugin.setDeveloper(true);
    expect(plugin.developer()).toBe(true);
    expect(JSON.stringify(await plugin.loadData())).not.toContain("developer");
  });
});

describe("the memory profile's editor (#401)", () => {
  /** The profile dialog's text box and buttons, in the document. */
  const box = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>(".obsidian-agent-profile-text")!;
  const button = (text: string): HTMLButtonElement =>
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text)!;

  it("shows the profile kept in the vault, and saves what is changed", async () => {
    await t.app.vault.adapter.write(".memory/user-profile.md", "---\ntype: user-profile\n---\n## Preferences\n\nShort answers.\n");
    plugin = await start(null);
    plugin.editProfile();
    await vi.waitFor(() => expect(box()?.value).toBe("## Preferences\n\nShort answers."));
    box().value = "## Preferences\n\nLong answers.";
    box().dispatchEvent(new Event("input"));
    button("Save").click();
    await vi.waitFor(async () => expect(await t.app.vault.adapter.read(".memory/user-profile.md")).toContain("Long answers."));
    // Saved, the dialog closes
    expect(box()).toBeNull();
  });

  it("starts empty when there is no profile yet, and writes one on save", async () => {
    plugin = await start({ agentConfig: { memory: { profile_path: ".memory/me.md" } } });
    plugin.editProfile();
    await vi.waitFor(() => expect(box()?.value).toBe(""));
    box().value = "## Identity\n\nAlex.";
    box().dispatchEvent(new Event("input"));
    button("Save").click();
    await vi.waitFor(async () => expect(await t.app.vault.adapter.read(".memory/me.md")).toContain("Alex."));
  });
});

describe("settings changed on disk while Obsidian runs (#396)", () => {
  it("are read again, so a connection added on another device shows", async () => {
    plugin = await start({ agentConfig: { llm_profiles: { local: { provider: "llamacpp", base_url: "http://127.0.0.1:8080" } } } });
    (plugin as unknown as { setStoredData(d: unknown): void }).setStoredData({ agentConfig: { llm_profiles: {
      local: { provider: "llamacpp", base_url: "http://127.0.0.1:8080" }, cloud: CLOUD } } });
    await plugin.onExternalSettingsChange();
    expect(Object.keys(values(plugin).llm_profiles as object).sort()).toEqual(["cloud", "local"]);
  });

  it("are kept by the next save made on this device", async () => {
    plugin = await start({ agentConfig: {} });
    (plugin as unknown as { setStoredData(d: unknown): void }).setStoredData({ agentConfig: { llm_profiles: { cloud: CLOUD } } });
    await plugin.onExternalSettingsChange();
    await store(plugin).putConfig({ vault: { default_agent: "assistant" } });
    const saved = (await plugin.loadData()) as { agentConfig: { llm_profiles?: Record<string, unknown> } };
    expect(Object.keys(saved.agentConfig.llm_profiles ?? {})).toEqual(["cloud"]);
  });

  it("leave a connection whose address changed there unapproved here", async () => {
    plugin = await start(null);
    await store(plugin).putConfig({ llm_profiles: { cloud: CLOUD } });
    expect(plugin.approvalStatus("connection", "cloud")?.approved).toBe(true);
    (plugin as unknown as { setStoredData(d: unknown): void }).setStoredData({ agentConfig: { llm_profiles: {
      cloud: { ...CLOUD, base_url: "https://elsewhere.example/v1" } } } });
    await plugin.onExternalSettingsChange();
    expect(plugin.approvalStatus("connection", "cloud")?.approved).toBe(false);
  });
});
