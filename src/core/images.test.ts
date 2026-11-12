import { describe, it, expect } from "vitest";
import { imageKind } from "./images";

describe("imageKind (#380)", () => {
  it("detects png, jpeg, and gif", () => {
    expect(imageKind(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(imageKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpeg");
    expect(imageKind(Buffer.from("GIF89a"))).toBe("gif");
  });

  it("detects webp, bmp, and ico", () => {
    expect(imageKind(Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("webp");
    expect(imageKind(Buffer.from("BM\u0000\u0000\u0000\u0000"))).toBe("bmp");
    expect(imageKind(Uint8Array.from([0, 0, 1, 0, 1, 0]))).toBe("ico");
  });

  it("detects tiff, avif, and heic", () => {
    expect(imageKind(Buffer.from("II*\u0000\u0008\u0000"))).toBe("tiff");
    expect(imageKind(Buffer.from("MM\u0000*\u0000\u0000"))).toBe("tiff");
    expect(imageKind(Buffer.from("\u0000\u0000\u0000\u001cftypavif\u0000\u0000"))).toBe("avif");
    expect(imageKind(Buffer.from("\u0000\u0000\u0000\u0018ftypheic\u0000\u0000"))).toBe("heic");
  });

  it("detects svg and returns null for non-svg html", () => {
    expect(imageKind(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe("svg");
    expect(imageKind(Buffer.from('  <svg width="1"/>'))).toBe("svg");
    expect(imageKind(Buffer.from("<html><body>no</body></html>"))).toBe(null);
  });

  it("returns null for empty, tiny, and plain text bytes", () => {
    expect(imageKind(new Uint8Array())).toBe(null);
    expect(imageKind(Uint8Array.from([1, 2]))).toBe(null);
    expect(imageKind(Buffer.from("hello world"))).toBe(null);
  });
});
