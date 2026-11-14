/** AI 呼び出しの失敗を、プロバイダーによらない種別に正規化したもの。 */
export type AiErrorKind =
  | "auth" // 401 / 403: キーが不正・権限なし
  | "rate_limit" // 429
  | "network" // 通信できない (CORS 失敗を含む)
  | "timeout"
  | "aborted" // ユーザーによる中止
  | "server" // 5xx
  | "bad_request" // 400 / 404 など (モデル ID の誤りなど)
  | "blocked" // 安全性による拒否
  | "truncated" // 出力が上限で途切れた
  | "bad_format"; // 応答が期待した形式でない

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    /** ユーザーに見せてよい補足 (キーは除去済み)。 */
    readonly detail?: string,
  ) {
    super(kind);
    this.name = "AiError";
  }
}

const MIN_FRAGMENT = 8;

/** text のうち、secret の連続する 8 文字以上の部分と一致する箇所を *** にする。 */
function redactFragments(text: string, secret: string): string {
  if (secret.length < MIN_FRAGMENT) return text;
  const windows = new Set<string>();
  for (let i = 0; i + MIN_FRAGMENT <= secret.length; i++) windows.add(secret.slice(i, i + MIN_FRAGMENT));
  const hit = new Array<boolean>(text.length).fill(false);
  for (let i = 0; i + MIN_FRAGMENT <= text.length; i++) {
    if (windows.has(text.slice(i, i + MIN_FRAGMENT))) for (let j = i; j < i + MIN_FRAGMENT; j++) hit[j] = true;
  }
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (!hit[i]) out += text[i];
    else if (i === 0 || !hit[i - 1]) out += "***";
  }
  return out;
}

/**
 * テキストに API キーが混ざっていれば伏せる (エラー文の表示・ログ用)。
 * キーそのもの・URL エンコードしたもの・8 文字以上の部分一致 (一部だけ表示された場合) を伏せる。
 */
export function redactKey(text: string, apiKey: string): string {
  if (apiKey.length < 4) return text;
  let out = text.split(apiKey).join("***");
  const enc = encodeURIComponent(apiKey);
  if (enc !== apiKey) out = out.split(enc).join("***");
  out = redactFragments(out, apiKey);
  if (enc !== apiKey) out = redactFragments(out, enc);
  return out;
}
