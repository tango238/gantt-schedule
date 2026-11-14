const pad = (n: number): string => String(n).padStart(2, "0");

/** ローカル時刻の「YYYY/MM/DD HH:mm」。 */
export function formatCommentTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
