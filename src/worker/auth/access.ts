// 許可判定・redirect 検証の純関数 (I/O なし)。

export interface AccessConfig {
  /** ALLOWED_DOMAINS (カンマ区切りの生文字列) */
  allowedDomains: string | undefined;
  /** ADMIN_EMAILS (カンマ区切りの生文字列) */
  adminEmails: string | undefined;
  /** D1 の例外アドレス表の内容 (照会済みの結果。この関数は DB に触らない) */
  exceptionEmails: readonly string[];
  /** DEV_LOGIN_EMAIL (カンマ区切り。設定されている場合のみ、そのアドレスを許可) */
  devLoginEmail?: string | undefined;
}

/** カンマ区切りを trim + 小文字化し、空要素を除く。 */
export function parseList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1);
}

export function isAdminEmail(email: string, adminEmails: string | undefined): boolean {
  return parseList(adminEmails).includes(email.trim().toLowerCase());
}

/** localhost 系のホスト名か (開発用ログインと Cookie の Secure 判定に使う)。URL.hostname 形式 (IPv6 は角括弧付き)。 */
export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

/**
 * ログイン許可判定。
 * - ドメイン経由: メールのドメインが ALLOWED_DOMAINS に含まれ (完全一致。サブドメインは不一致)、
 *   かつ hd クレームも ALLOWED_DOMAINS に含まれる (hd は Workspace のセカンダリドメインでもよく、
 *   メールのドメインと同一である必要はない)。hd が null (無し) ならドメイン経由は不許可。
 * - または 例外アドレス表 / ADMIN_EMAILS に完全一致 (hd 検査なし)
 * - または cfg.devLoginEmail に一致 (呼び出し側が localhost のときだけ渡す)
 * 設定がすべて空なら全員不許可。
 * hd はログイン時に検証した値 (users.hd に保存し、セッション再判定でも同じ値を渡す)。
 */
export function isAllowed(email: string, hd: string | null, cfg: AccessConfig): boolean {
  const e = email.trim().toLowerCase();
  if (e === "") return false;

  if (parseList(cfg.devLoginEmail).includes(e)) return true;
  if (parseList(cfg.adminEmails).includes(e)) return true;
  if (cfg.exceptionEmails.some((x) => x.trim().toLowerCase() === e)) return true;

  const domains = parseList(cfg.allowedDomains);
  const domain = emailDomain(e);
  if (domain && domains.includes(domain)) {
    return hd !== null && domains.includes(hd.trim().toLowerCase());
  }
  return false;
}

/**
 * ログイン後の戻り先を検証する。同一オリジンの相対パス (先頭 "/" 1 個) のみ許可。
 * 不正なら "/" を返す。
 */
export function safeRedirect(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (raw.length > 2048) return "/";
  if (!raw.startsWith("/")) return "/";
  // "//host", "/\host" (ブラウザは \ を / と解釈する) を拒否
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  // 制御文字・バックスラッシュ・空白類を含むものは拒否
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  // URL として解釈しても同一オリジンのままか確認 (最終防衛線)
  try {
    const u = new URL(raw, "http://localhost");
    if (u.origin !== "http://localhost") return "/";
  } catch {
    return "/";
  }
  return raw;
}
