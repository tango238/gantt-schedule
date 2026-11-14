/**
 * メールアドレスの検証と正規化 (例外アドレスの登録用)。
 * 小文字化 + trim 後に、全体 254 文字以内・ローカル部 64 文字以内・ローカル部は英数字と `._%+-` のみ (ドットの連続・先頭・末尾は不可)・ドメインは ASCII のラベルのみ許可する。
 * 制御文字・空白・複数の @ は拒否。通ったら正規化後の文字列、通らなければ null。
 */
export const EMAIL_MAX = 254;
const LOCAL = /^[a-z0-9_%+-]+(\.[a-z0-9_%+-]+)*$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX) return null;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !LOCAL.test(local)) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null; // 末尾が数字だけ (IP アドレス形式) は拒否
  return email;
}
