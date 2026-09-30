// Ported from tests/test_session_redaction.py — secrets do not reach a session note (#85).
import { describe, expect, it } from "vitest";

import { holdsASecret, redactSecrets } from "./redact";
import { loadSession, saveSession, sessionPath } from "./sessions";
import { makeVault } from "./testing/vault";

/** A made-up credential, joined at runtime: no file holds a whole token for secret scanners (GitHub's push
 * protection blocked the first release over one) to mistake for a leak. */
const fake = (...parts: string[]): string => parts.join("");

describe("test_session_redaction.py", () => {
  it("test_holds_a_secret_reports_whether_anything_would_change", () => {
    expect(holdsASecret(`key: ${fake("sk-", "abcdefghijklmnopqrstuvwxyz")}`)).toBe(true);
    expect(holdsASecret("nothing secret in this sentence")).toBe(false);
  });

  it.each([
    [fake("sk-proj-", "abcdefghijklmnopqrstuvwxyz0123456789"), "API key"],
    [fake("sk-ant-", "api03-Zx9BqLmNoPqRsTuVwXyZ0123456789abcdef"), "API key"],
    [fake("ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), "GitHub token"],
    [fake("AKIA", "IOSFODNN7EXAMPLE"), "AWS access key id"],
    [fake("AIza", "SyD-1234567890abcdefghijklmnopqrstuvw"), "Google API key"],
    [fake("xox", "b-123456789012-abcdefghijklmnop"), "Slack token"],
    [fake("hf_", "abcdefghijklmnopqrstuvwxyz0123456789"), "Hugging Face token"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r0", "token"],
  ])("test_a_pasted_credential_is_replaced_by_a_marker", (secret, what) => {
    const redacted = redactSecrets(`Here is my key: ${secret} — set it up please`);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain(`[redacted ${what}]`);
    expect(redacted).toContain("set it up please");
  });

  it("test_a_private_key_block_goes_whole", () => {
    const block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAv9m2T0Xx8Kq\nZ1ZaWQIDAQAB\n-----END RSA PRIVATE KEY-----";
    const redacted = redactSecrets(`put this in the config:\n${block}\nthanks`);
    expect(redacted).not.toContain("MIIEowIBAAKCAQEA");
    expect(redacted).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(redacted).toContain("[redacted private key]");
    expect(redacted).toContain("thanks");
  });

  it("test_a_config_line_keeps_its_setting_and_loses_its_value", () => {
    const redacted = redactSecrets('OPENAI_API_KEY=Zx9BqLmNoPqRsTuVwXyZ0123456789\napi_key: "aVeryLongSecretValue123"');
    expect(redacted).not.toContain("Zx9BqLmNoPqRsTuVwXyZ0123456789");
    expect(redacted).not.toContain("aVeryLongSecretValue123");
    expect(redacted).toContain("OPENAI_API_KEY=");
    expect(redacted).toContain("api_key:");
  });

  it.each([
    "The password is in the safe, ask Anna for it",
    'Set api_key: yes in the config and it will read it from the environment',
    "My token expired again",
    "See Projects/Secret Santa.md for the list",
    "sk- is the prefix OpenAI uses",
    "The meeting notes are at Journal/2026-09-23.md and cover the token bucket design",
  ])("test_ordinary_prose_is_left_alone", (prose) => {
    expect(redactSecrets(prose)).toBe(prose);
  });

  it("test_a_key_pasted_into_a_conversation_never_reaches_the_note", async () => {
    const vault = await makeVault();
    const key = fake("sk-proj-", "abcdefghijklmnopqrstuvwxyz0123456789");
    const messages = [
      { role: "user" as const, content: `my key is ${key}, add it to the config` },
      { role: "assistant" as const, content: `I will not write ${key} anywhere, it belongs in your config file` },
    ];

    await saveSession(vault.vault, "leaky", messages, { agent: "default", model: "test" });

    const written = await vault.read(sessionPath("leaky"));
    expect(written).not.toContain(key);
    expect(written.split("[redacted API key]").length - 1).toBe(2);
    expect(written).toContain("add it to the config");
  });

  it("test_a_reloaded_session_carries_the_redacted_text", async () => {
    const vault = await makeVault();
    await saveSession(vault.vault, "leaky", [{ role: "user" as const, content: `key ${fake("sk-", "abcdefghijklmnopqrstuvwxyz0123")}` }], {
      agent: "default", model: "test",
    });

    const reloaded = await loadSession(vault.vault, "leaky");

    expect(reloaded[0].content).toContain("[redacted API key]");
  });
});
