/**
 * 名前 (スケジュール名・バージョン名) の検証。クライアントの入力欄とサーバーで同じ基準を使う。
 * trim 後に 1〜max 文字 (コードポイントで数える。絵文字などのサロゲートペアは 1 文字)、制御文字 (NUL・改行・タブ等) を含まない。
 * 通ったら trim 後の文字列、通らなければ null。
 */
export function validName(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name === "" || /\p{Cc}/u.test(name)) return null;
  if (Array.from(name).length > max) return null;
  return name;
}
