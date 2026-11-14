import ja from "./ja.json";

export type Params = Record<string, string | number>;

function lookup(key: string): string | undefined {
  let cur: unknown = ja;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

/** メッセージに埋め込む名前の長さ上限 (コードポイント)。極端に長い名前でダイアログやトーストが画面を覆わないように。 */
export const PARAM_NAME_MAX = 100;
const clip = (v: string | number): string => {
  const s = String(v);
  const chars = Array.from(s);
  return chars.length > PARAM_NAME_MAX ? chars.slice(0, PARAM_NAME_MAX).join("") + "…" : s;
};

/** Translate a dot-separated key; `{name}` placeholders are replaced from params (`name` は長すぎれば省略する). */
export function t(key: string, params?: Params): string {
  const raw = lookup(key);
  if (raw === undefined) {
    if (import.meta.env?.DEV) console.warn(`[i18n] missing key: ${key}`);
    return key;
  }
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? (k === "name" || k === "parentName" ? clip(params[k]!) : String(params[k])) : m));
}
