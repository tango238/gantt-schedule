import { describe, expect, it } from "vitest";
import { isAdminEmail, isAllowed, isLocalHostname, parseList, safeRedirect, type AccessConfig } from "./access";

const base: AccessConfig = {
  allowedDomains: "example.com, Corp.Example.org",
  adminEmails: "Boss@gmail.com",
  exceptionEmails: ["guest@gmail.com"],
};

describe("parseList", () => {
  it("trim / 小文字化 / 空要素除去", () => {
    expect(parseList(" A.com, ,b.com,")).toEqual(["a.com", "b.com"]);
    expect(parseList("")).toEqual([]);
    expect(parseList(undefined)).toEqual([]);
  });
});

describe("isAllowed", () => {
  it("ドメイン一致 + hd が ALLOWED_DOMAINS に含まれれば許可", () => {
    expect(isAllowed("a@example.com", "example.com", base)).toBe(true);
  });
  it("hd はメールのドメインと同一でなくてよい (セカンダリドメイン)", () => {
    expect(isAllowed("a@example.com", "corp.example.org", base)).toBe(true);
    expect(isAllowed("a@corp.example.org", "example.com", base)).toBe(true);
  });
  it("大文字小文字を区別しない", () => {
    expect(isAllowed("A@EXAMPLE.COM", "Example.com", base)).toBe(true);
    expect(isAllowed("x@corp.example.org", "CORP.example.org", base)).toBe(true);
  });
  it("サブドメインは不一致", () => {
    expect(isAllowed("a@sub.example.com", "example.com", base)).toBe(false);
    expect(isAllowed("a@example.com", "sub.example.com", base)).toBe(false);
  });
  it("接尾辞だけ一致する別ドメインは不許可", () => {
    expect(isAllowed("a@evilexample.com", "example.com", base)).toBe(false);
    expect(isAllowed("a@example.com.evil.com", "example.com", base)).toBe(false);
  });
  it("hd が ALLOWED_DOMAINS に無ければ不許可", () => {
    expect(isAllowed("a@example.com", "other.com", base)).toBe(false);
  });
  it("hd が無い (null) ならドメイン経由は不許可", () => {
    expect(isAllowed("a@example.com", null, base)).toBe(false);
  });
  it("例外アドレスは hd 無しでも許可 (大文字小文字無視)", () => {
    expect(isAllowed("Guest@gmail.com", null, base)).toBe(true);
    expect(isAllowed("other@gmail.com", null, base)).toBe(false);
  });
  it("ADMIN_EMAILS は許可", () => {
    expect(isAllowed("boss@gmail.com", null, base)).toBe(true);
    expect(isAdminEmail("BOSS@gmail.com", base.adminEmails)).toBe(true);
    expect(isAdminEmail("a@example.com", base.adminEmails)).toBe(false);
  });
  it("空設定は全拒否", () => {
    const empty: AccessConfig = { allowedDomains: "", adminEmails: undefined, exceptionEmails: [] };
    expect(isAllowed("a@example.com", "example.com", empty)).toBe(false);
    expect(isAllowed("", null, empty)).toBe(false);
    expect(isAllowed("@", "", { ...empty, allowedDomains: "," })).toBe(false);
  });
  it("DEV_LOGIN_EMAIL は一致時のみ許可", () => {
    const cfg = { ...base, devLoginEmail: "dev@local.test" };
    expect(isAllowed("dev@local.test", null, cfg)).toBe(true);
    expect(isAllowed("dev@local.test", null, base)).toBe(false);
  });
  it("DEV_LOGIN_EMAIL はカンマ区切りで複数指定できる (大小文字・空白は無視)", () => {
    const cfg = { ...base, devLoginEmail: "dev@local.test, Dev2@local.test" };
    expect(isAllowed("dev@local.test", null, cfg)).toBe(true);
    expect(isAllowed("dev2@local.test", null, cfg)).toBe(true);
    expect(isAllowed("dev3@local.test", null, cfg)).toBe(false);
  });
  it("再判定: 例外アドレス経由 (hd なし) のユーザーは、例外表から消えたら不許可になる", () => {
    const cfg = { allowedDomains: "example.com", adminEmails: "", exceptionEmails: [] as string[] };
    // ログイン時: 例外表にいたので許可。保存される hd は null
    expect(isAllowed("x@example.com", null, { ...cfg, exceptionEmails: ["x@example.com"] })).toBe(true);
    // 例外表から削除後の再判定 (保存済み hd = null): ドメイン経由は hd 無しなので不許可
    expect(isAllowed("x@example.com", null, cfg)).toBe(false);
    // hd を持つ Workspace アカウントなら再判定でも許可のまま
    expect(isAllowed("y@example.com", "example.com", cfg)).toBe(true);
  });
});

describe("isLocalHostname", () => {
  it("localhost 系のみ true", () => {
    for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "[::1]"]) expect(isLocalHostname(h), h).toBe(true);
    for (const h of ["evil.example", "localhost.evil.com", "127.0.0.2", "schedule.workers.dev", ""]) {
      expect(isLocalHostname(h), h).toBe(false);
    }
  });
});

describe("safeRedirect", () => {
  it("相対パスは通す", () => {
    expect(safeRedirect("/")).toBe("/");
    expect(safeRedirect("/s/abc123")).toBe("/s/abc123");
    expect(safeRedirect("/s/abc?x=1#h")).toBe("/s/abc?x=1#h");
  });
  it("拒否して / に落とす", () => {
    for (const bad of [
      "//evil.com",
      "///evil.com",
      "https://evil.com",
      "http://evil.com/x",
      "/\\evil.com",
      "\\\\evil.com",
      "javascript:alert(1)",
      "evil.com",
      "s/abc",
      "/a\\b",
      "/\tevil",
      "/\n//evil.com",
      "",
    ]) {
      expect(safeRedirect(bad), JSON.stringify(bad)).toBe("/");
    }
    expect(safeRedirect(null)).toBe("/");
    expect(safeRedirect(undefined)).toBe("/");
    expect(safeRedirect("/" + "a".repeat(3000))).toBe("/");
  });
});
