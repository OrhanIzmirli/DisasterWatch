import { describe, it, expect } from "vitest";
import { safeImageUrl } from "./imageUrl";

describe("safeImageUrl", () => {
  it("keeps https URLs", () => {
    expect(safeImageUrl("https://img.example.com/a.jpg?w=600")).toBe("https://img.example.com/a.jpg?w=600");
  });

  it("upgrades http to https (no mixed content)", () => {
    expect(safeImageUrl("http://media.example.com/photo.jpg")).toBe("https://media.example.com/photo.jpg");
  });

  it("drops anything that is not an absolute http(s) URL", () => {
    for (const bad of [null, undefined, "", "   ", "/relative.jpg", "data:image/png;base64,AAAA", "javascript:alert(1)", "ftp://example.com/a.jpg", "not a url"]) {
      expect(safeImageUrl(bad)).toBeNull();
    }
  });
});
