import { describe, expect, it } from "vitest";
import { asStreaming } from "./streamingMarkdown";

describe("asStreaming", () => {
  it("converts a mermaid code fence to text", () => {
    const result = asStreaming("```mermaid\ngraph TD; A-->B\n```");
    expect(result).toBe("```text\ngraph TD; A-->B\n```");
  });

  it("converts tilde fence with spaced uppercase language and keeps indentation", () => {
    const result1 = asStreaming("~~~ Mermaid\nx\n~~~");
    expect(result1).toBe("~~~text\nx\n~~~");

    const result2 = asStreaming("  ```mermaid\nx\n  ```");
    expect(result2).toBe("  ```text\nx\n  ```");
  });

  it("leaves other languages unchanged", () => {
    const result1 = asStreaming("```js\nconst a = 1;\n```");
    expect(result1).toBe("```js\nconst a = 1;\n```");

    const result2 = asStreaming("```mermaidish\nx\n```");
    expect(result2).toBe("```mermaidish\nx\n```");
  });

  it("leaves text mentioning a fence inside a line unchanged", () => {
    const result1 = asStreaming("Write it in a ```mermaid block");
    expect(result1).toBe("Write it in a ```mermaid block");

    const result2 = asStreaming("no fences at all");
    expect(result2).toBe("no fences at all");
  });

  it("converts multiple mermaid blocks with prose between them", () => {
    const result = asStreaming("Intro\n```mermaid\na\n```\nMiddle\n```mermaid\nb\n```");
    expect(result).toBe("Intro\n```text\na\n```\nMiddle\n```text\nb\n```");
  });
});
