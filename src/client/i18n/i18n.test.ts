import { describe, expect, it } from "vitest";
import { PARAM_NAME_MAX, t } from ".";

describe("t: name パラメータの省略", () => {
  it("短い名前はそのまま", () => {
    expect(t("list.confirmDelete", { name: "短い" })).toContain('"短い"');
  });
  it("長い名前は PARAM_NAME_MAX 文字 + … に省略する (サロゲートペアを割らない)", () => {
    const long = "😀".repeat(PARAM_NAME_MAX + 50);
    const out = t("list.confirmDelete", { name: long });
    expect(out).toContain("😀".repeat(PARAM_NAME_MAX) + "…");
    expect(out).not.toContain("😀".repeat(PARAM_NAME_MAX + 1));
  });
  it("name 以外のパラメータは省略しない", () => {
    expect(t("dialog.more", { count: 123456 })).toContain("123456");
  });
});
