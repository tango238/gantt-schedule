import { describe, expect, it } from "vitest";
import { validName } from "./name";

describe("validName", () => {
  it("trim して返す", () => expect(validName("  a b  ", 10)).toBe("a b"));
  it.each(["", "   ", "a\nb", "a\tb", "a\u0000b", "\u007f", 1, null, undefined])("拒否: %j", (v) => expect(validName(v, 10)).toBeNull());
  it("長さはコードポイントで数える", () => {
    expect(validName("😀".repeat(100), 100)).not.toBeNull(); // UTF-16 では 200
    expect(validName("😀".repeat(101), 100)).toBeNull();
    expect(validName("あ".repeat(100), 100)).not.toBeNull();
  });
});
