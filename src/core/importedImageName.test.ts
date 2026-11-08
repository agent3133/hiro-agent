import { describe, expect, it } from "vitest";
import { importedImageName } from "./attachments";

describe("importedImageName", () => {
  it("names the image after the book and its own file name", () => {
    expect(importedImageName("Moby Dick", "OEBPS/images/whale.png")).toBe("Moby Dick - whale.png");
  });

  it("keeps only the last part of a path written with backslashes", () => {
    expect(importedImageName("Book", "..\\..\\evil.png")).toBe("Book - evil.png");
  });

  it("never lets an entry name leave the folder", () => {
    for (const entry of ["../../x.png", "a/../../x.png", "..\\x.png", "C:\\x.png", "x:y.png", "a|b?.png"]) {
      const name = importedImageName("Book", entry);
      expect(name).not.toMatch(/[\\/:*?"<>|]/);
      expect(name.startsWith("Book - ")).toBe(true);
    }
  });

  it("falls back to a name when the entry ends in a slash", () => {
    expect(importedImageName("Book", "images/")).toBe("Book - image");
  });
});
