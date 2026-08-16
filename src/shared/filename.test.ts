import { describe, expect, it } from "vitest";
import { buildPdfFilename, normalizePublishedDate, sanitizeFilenamePart } from "./filename.js";

describe("filename helpers", () => {
  it("cleans Windows-invalid characters", () => {
    expect(sanitizeFilenamePart('学院：报道/专题*稿?')).toBe("学院_报道_专题_稿_");
  });

  it("normalizes common Chinese dates", () => {
    expect(normalizePublishedDate("2026年8月5日 10:00")).toBe("2026-08-05");
    expect(normalizePublishedDate("发布时间：2026/02/29")).toBeNull();
  });

  it("uses the required title-date format", () => {
    expect(buildPdfFilename("我院获奖", "2026-08-15")).toBe("我院获奖_2026-08-15.pdf");
  });
});
