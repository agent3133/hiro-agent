// What this device approves of what the synced settings send keys to or run (#136).
import { describe, expect, it } from "vitest";

import { isLoopbackUrl } from "../core/loopback";

import { changedApprovals, connectionApproval, DeviceApprovals, programsApproval, requiredApprovals }
  from "./deviceApprovals";

const CLOUD = { llm_profiles: { cloud: { provider: "openai", base_url: "https://api.example.com/v1", api_key: "${CLOUD_KEY}" },
                                local: { provider: "llamacpp", base_url: "http://127.0.0.1:8080" } } };

function store(): { approvals: DeviceApprovals; saved: () => unknown } {
  let stored: unknown = null;
  return { approvals: new DeviceApprovals(() => stored, (value) => { stored = value; }), saved: () => stored };
}

describe("a connection's key", () => {
  it("needs approval for where it goes, named in words", () => {
    expect(connectionApproval(CLOUD, "cloud")).toEqual({
      id: "connection:cloud", fingerprint: JSON.stringify(["https://api.example.com/v1", "CLOUD_KEY"]),
      what: "sends the key CLOUD_KEY to https://api.example.com/v1",
    });
  });

  it("needs none when the connection sends no key to a server on this computer", () => {
    expect(connectionApproval(CLOUD, "local")).toBeNull();
  });

  it("asks about a connection without a key on another computer: the messages go there (#407)", () => {
    // A written-out key is no key: the turn refuses it, but the address is still where the messages would go
    expect(connectionApproval({ llm_profiles: { x: { api_key: "written-out" } } }, "x")?.what)
      .toBe("sends your messages to https://api.openai.com/v1");
  });

  it("goes to OpenAI's address when an openai connection names none, and to the bare llm section by ''", () => {
    expect(connectionApproval({ llm: { api_key: "${K}" } }, "")?.what).toBe("sends the key K to https://api.openai.com/v1");
    expect(connectionApproval({ llm: { api_key: "${K}" } }, "")?.id).toBe("connection:llm");
  });

  it("is another approval once the address or the key's name changes", () => {
    const before = connectionApproval(CLOUD, "cloud")!;
    const moved = { llm_profiles: { cloud: { ...CLOUD.llm_profiles.cloud, base_url: "https://peer.example/v1" } } };
    const renamed = { llm_profiles: { cloud: { ...CLOUD.llm_profiles.cloud, api_key: "${OTHER}" } } };
    expect(connectionApproval(moved, "cloud")!.fingerprint).not.toBe(before.fingerprint);
    expect(connectionApproval(renamed, "cloud")!.fingerprint).not.toBe(before.fingerprint);
    const sampled = { llm_profiles: { cloud: { ...CLOUD.llm_profiles.cloud, temperature: 0.2 } } };
    expect(connectionApproval(sampled, "cloud")!.fingerprint).toBe(before.fingerprint);
  });
});

describe("the audio programs", () => {
  it("need none as the plugin's defaults", () => {
    expect(programsApproval({})).toBeNull();
    expect(programsApproval({ audio: { enabled: true, whisper_cli: "whisper-cli", ffmpeg: "ffmpeg", model: "m.bin" } }))
      .toBeNull();
  });

  it("need approval for another program or extra arguments", () => {
    expect(programsApproval({ audio: { whisper_cli: "D:\\llm\\whisper-cli.exe" } })?.what)
      .toBe("runs D:\\llm\\whisper-cli.exe and ffmpeg");
    expect(programsApproval({ audio: { extra_args: ["--flash-attn"] } })?.what)
      .toBe("runs whisper-cli --flash-attn and ffmpeg");
    expect(programsApproval({ audio: { ffmpeg: "C:/sync/ffmpeg.exe" } })?.id).toBe("programs:audio");
  });
});

describe("the approvals kept on this device", () => {
  it("hold for the fingerprint approved, and not for a changed one", () => {
    const { approvals } = store();
    const approval = connectionApproval(CLOUD, "cloud")!;
    expect(approvals.approved(approval)).toBe(false);
    approvals.approve(approval);
    expect(approvals.approved(approval)).toBe(true);
    const moved = connectionApproval({ llm_profiles: { cloud: { ...CLOUD.llm_profiles.cloud, base_url: "https://peer.example" } } }, "cloud")!;
    expect(approvals.approved(moved)).toBe(false);
  });

  it("survive a store that holds something else", () => {
    const approvals = new DeviceApprovals(() => ["junk"], () => undefined);
    expect(approvals.approved(connectionApproval(CLOUD, "cloud")!)).toBe(false);
  });
});

describe("a connection's address", () => {
  it("approves a message-only connection to another computer", () => {
    const approval = connectionApproval({ llm_profiles: { lan: { base_url: "http://192.168.1.20:8080/v1" } } }, "lan");
    expect(approval).toEqual({
      id: "connection:lan",
      fingerprint: JSON.stringify(["http://192.168.1.20:8080/v1", ""]),
      what: "sends your messages to http://192.168.1.20:8080/v1",
    });
  });

  it("needs none for a server on this computer", () => {
    expect(connectionApproval({ llm_profiles: { me: { base_url: "http://127.0.0.1:8080" } } }, "me")).toBeNull();
    expect(connectionApproval({ llm_profiles: { me: { base_url: "http://localhost:11434" } } }, "me")).toBeNull();
  });

  it("is approved while the address stands, and not once it moves", () => {
    const { approvals } = store();
    const approval = connectionApproval({ llm_profiles: { lan: { base_url: "http://192.168.1.20:8080/v1" } } }, "lan")!;
    approvals.approve(approval);
    expect(approvals.approved(approval)).toBe(true);
    const moved = connectionApproval({ llm_profiles: { lan: { base_url: "http://203.0.113.5:8080/v1" } } }, "lan")!;
    expect(approvals.approved(moved)).toBe(false);
  });
});

describe("isLoopbackUrl", () => {
  it("is true for a loopback address, false for one on another computer or one that does not parse", () => {
    expect(isLoopbackUrl("http://[::1]:8080/")).toBe(true);
    expect(isLoopbackUrl("https://example.com")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});

describe("what a save on this device approves", () => {
  it("lists every connection that sends a key, and the programs when set", () => {
    const values = { ...CLOUD, llm: { api_key: "${K}" }, audio: { ffmpeg: "C:/ff.exe" } };
    expect(requiredApprovals(values).map((approval) => approval.id).sort())
      .toEqual(["connection:cloud", "connection:llm", "programs:audio"]);
  });

  it("is what the save changed: a new address, a new connection with a key, new programs", () => {
    const after = { llm_profiles: { cloud: { ...CLOUD.llm_profiles.cloud, base_url: "https://new.example/v1" },
                                    other: { api_key: "${OTHER}" }, local: CLOUD.llm_profiles.local },
                    audio: { whisper_cli: "D:/whisper.exe" } };
    expect(changedApprovals(CLOUD, after).map((approval) => approval.id).sort())
      .toEqual(["connection:cloud", "connection:other", "programs:audio"]);
  });

  it("leaves alone what the save did not touch, so a change that came by sync still waits", () => {
    const synced = { llm_profiles: { cloud: { ...CLOUD.llm_profiles.cloud, base_url: "https://peer.example/v1" } } };
    const savedHere = { ...synced, default_llm_profile: "cloud" };
    expect(changedApprovals(synced, savedHere)).toEqual([]);
  });
});
