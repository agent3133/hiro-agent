// @vitest-environment jsdom
// Adding and editing a connection in its form (#368, on the obsidian stub). The create path has its own tests: in
// 0.9.1–0.9.3 a new connection could not be saved while editing one worked (#343).
import { describe, expect, it, vi } from "vitest";

import { App, buttonNamed, settingNamed, type TextComponent } from "../testing/obsidian";

import { ConnectionModal, type ConnectionFormHost } from "./ConnectionModal";
import type { ConnectionDraft } from "./connections";

const EMPTY: ConnectionDraft = { name: "", baseUrl: "", model: "", key: "" };

function host(overrides: Partial<ConnectionFormHost> = {}): ConnectionFormHost {
  return {
    app: new App(".") as never,
    taken: [],
    save: vi.fn(async () => null),
    test: vi.fn(async () => ({ ok: true, text: "The server answers." })),
    ...overrides,
  };
}

function field(modal: ConnectionModal, name: string): TextComponent {
  return settingNamed(modal.contentEl, name).components[0] as TextComponent;
}

function open(h: ConnectionFormHost, draft = EMPTY, editing = false): ConnectionModal {
  const modal = new ConnectionModal(h, draft, editing);
  modal.open();
  return modal;
}

describe("ConnectionModal", () => {
  it("saves a new connection with what was typed, and closes", async () => {
    const h = host();
    const modal = open(h);
    expect(modal.titleEl.textContent).toBe("Add a connection");
    await field(modal, "Name").type("local");
    await field(modal, "Address").type("http://127.0.0.1:8080");
    await buttonNamed(modal.contentEl, "Save").click();
    expect(h.save).toHaveBeenCalledWith({ name: "local", baseUrl: "http://127.0.0.1:8080", model: "", key: "" });
    expect((modal as unknown as { isOpen: boolean }).isOpen).toBe(false);
  });

  it("trims what was typed before it is saved", async () => {
    const h = host();
    const modal = open(h);
    await field(modal, "Name").type("  cloud ");
    await field(modal, "Model").type(" gpt-4o-mini ");
    await buttonNamed(modal.contentEl, "Save").click();
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ name: "cloud", model: "gpt-4o-mini" }));
  });

  it("says why a name already taken cannot be saved, stores nothing and stays open", async () => {
    const h = host({ taken: ["local"] });
    const modal = open(h);
    await field(modal, "Name").type("local");
    await field(modal, "Address").type("http://127.0.0.1:8080");
    await buttonNamed(modal.contentEl, "Save").click();
    expect(h.save).not.toHaveBeenCalled();
    const result = modal.contentEl.querySelector(".obsidian-agent-connection-result")!;
    expect(result.textContent).toBe("There is already a connection called local.");
    expect(result.classList.contains("mod-warning")).toBe(true);
    expect((modal as unknown as { isOpen: boolean }).isOpen).toBe(true);
  });

  it("shows what the store refused, and stays open", async () => {
    const h = host({ save: vi.fn(async () => "Could not write the settings.") });
    const modal = open(h);
    await field(modal, "Name").type("local");
    await field(modal, "Address").type("http://127.0.0.1:8080");
    await buttonNamed(modal.contentEl, "Save").click();
    expect(modal.contentEl.querySelector(".obsidian-agent-connection-result")!.textContent)
      .toBe("Could not write the settings.");
    expect((modal as unknown as { isOpen: boolean }).isOpen).toBe(true);
  });

  it("tests with the fields as typed, shows the verdict and offers the server's models", async () => {
    const h = host({ test: vi.fn(async () => ({ ok: false, text: "The server says 401.", models: ["a", "b"] })) });
    const modal = open(h);
    await field(modal, "Address").type("https://api.example.com/v1");
    await buttonNamed(modal.contentEl, "Test").click();
    expect(h.test).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://api.example.com/v1" }));
    const result = modal.contentEl.querySelector(".obsidian-agent-connection-result")!;
    expect(result.textContent).toBe("The server says 401.");
    expect(result.classList.contains("mod-warning")).toBe(true);
    const options = [...modal.contentEl.querySelectorAll("datalist option")].map((o) => o.getAttribute("value"));
    expect(options).toEqual(["a", "b"]);
  });

  it("opens an existing connection with its fields filled in, under its name", () => {
    const modal = open(host(), { name: "cloud", baseUrl: "https://openrouter.ai/api/v1", model: "m", key: "OR_KEY" }, true);
    expect(modal.titleEl.textContent).toBe("Connection 'cloud'");
    expect(field(modal, "Name").getValue()).toBe("cloud");
    expect(field(modal, "Address").getValue()).toBe("https://openrouter.ai/api/v1");
    expect(field(modal, "Model").getValue()).toBe("m");
  });

  it("cancel closes the form and saves nothing", async () => {
    const h = host();
    const modal = open(h);
    await field(modal, "Name").type("local");
    await field(modal, "Address").type("http://127.0.0.1:8080");
    await buttonNamed(modal.contentEl, "Cancel").click();
    expect(h.save).not.toHaveBeenCalled();
    expect((modal as unknown as { isOpen: boolean }).isOpen).toBe(false);
  });

  // A key over plain http to another computer (#408): the warning is shown while the fields are filled in
  const CLEAR_TEXT = ".obsidian-agent-clear-text";
  const RESULT = ".obsidian-agent-connection-result";

  it("shows the clear-text warning naming the host when a key goes over plain http to another computer", () => {
    const modal = open(host(), { name: "", baseUrl: "http://example.com/v1", model: "", key: "openai" });
    const warning = modal.contentEl.querySelector<HTMLElement>(CLEAR_TEXT)!;
    expect(warning.textContent).toContain("example.com");
    expect(warning.style.display).not.toBe("none");
  });

  it("keeps the clear-text warning empty and hidden for a local server, and shows it once the address is another computer", async () => {
    const modal = open(host(), { name: "", baseUrl: "http://127.0.0.1:8080", model: "", key: "k" });
    const warning = modal.contentEl.querySelector<HTMLElement>(CLEAR_TEXT)!;
    expect(warning.textContent).toBe("");
    expect(warning.style.display).toBe("none");
    await field(modal, "Address").type("http://192.168.1.5:8080");
    expect(warning.textContent).toContain("192.168.1.5");
    expect(warning.style.display).not.toBe("none");
  });

  it("gives the verdict with the clear-text warning appended and marked as a warning", async () => {
    const h = host();
    const modal = open(h, { name: "", baseUrl: "http://example.com/v1", model: "", key: "openai" });
    await buttonNamed(modal.contentEl, "Test").click();
    const result = modal.contentEl.querySelector<HTMLElement>(RESULT)!;
    expect(result.textContent!.startsWith("The server answers.")).toBe(true);
    expect(result.textContent).toContain("The key would go to example.com over plain http");
    expect(result.classList.contains("mod-warning")).toBe(true);
  });

  it("gives exactly the verdict, and no warning, for an https address", async () => {
    const h = host();
    const modal = open(h, { name: "", baseUrl: "https://example.com/v1", model: "", key: "k" });
    await buttonNamed(modal.contentEl, "Test").click();
    const result = modal.contentEl.querySelector<HTMLElement>(RESULT)!;
    expect(result.textContent).toBe("The server answers.");
    expect(result.classList.contains("mod-warning")).toBe(false);
  });
});
