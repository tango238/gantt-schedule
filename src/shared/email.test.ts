import { describe, expect, it } from "vitest";
import { normalizeEmail } from "./email";

describe("normalizeEmail", () => {
  it("小文字化と trim", () => {
    expect(normalizeEmail("  Foo.Bar+x@Example.ORG ")).toBe("foo.bar+x@example.org");
  });
  it.each([
    "", " ", "a", "a@", "@b.com", "a@b", "a@@b.com", "a b@c.com", "a@b .com", "a@b.com\u0001", "a\u0000@b.com", "a@b..com",
    "a..b@c.com", "a*b@c.com", "a/b@c.com", "a'b@c.com", "a!b@c.com", "a=b@c.com", "a{b}@c.com", ".a@c.com", "a.@c.com", "a@-b.com", "a@b-.com", "a@b.123", "a@b.com,c@d.com", "山田@example.com",
    "a@" + "x".repeat(64) + ".com", "x".repeat(65) + "@b.com", "a@" + "b.".repeat(130) + "com",
  ])("拒否: %j", (v) => expect(normalizeEmail(v)).toBeNull());
  it("実用的なローカル部は通る", () => {
    for (const v of ["a.b_c%d+e-f@x.com", "first.last+tag@sub.example.co.jp", "1234@x.io"]) expect(normalizeEmail(v)).toBe(v);
  });
  it("文字列以外は拒否", () => {
    for (const v of [null, undefined, 1, {}, ["a@b.com"]]) expect(normalizeEmail(v)).toBeNull();
  });
  it("254 文字まで", () => {
    const dom = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "com"].join(".");
    const ok = "x@" + dom; // 2 + 63*3+3+3 = 197
    expect(normalizeEmail(ok)).toBe(ok);
    expect(normalizeEmail("x".repeat(64) + "@" + dom.slice(0, 190) + ".com")).toBeNull();
  });
});
