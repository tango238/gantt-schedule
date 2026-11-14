import { PROVIDER_IDS, type ProviderId } from "./types";

/** localStorage のキー。API キーはこの値にだけ入り、サーバーへは送らない。 */
export const SETTINGS_STORAGE_KEY = "schedule.ai.settings.v1";

export interface ModelOption {
  id: string;
  label: string;
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  gemini: "Google Gemini",
};

/**
 * モデルの候補。最初の要素が既定。
 * Anthropic: claude-api スキル (2026-11 時点)。OpenAI: developers.openai.com/api/docs/models。
 * Gemini: aistudio.google.com/docs/models (Stable 表示のもの)。
 */
export const MODEL_OPTIONS: Record<ProviderId, ModelOption[]> = {
  anthropic: [
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { id: "claude-fable-5-2", label: "Claude Fable 5.2" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  ],
  openai: [
    { id: "gpt-6-astra", label: "gpt-6-astra" },
    { id: "gpt-6.1-sol", label: "gpt-6.1-sol" },
    { id: "gpt-6-luna", label: "gpt-6-luna" },
    { id: "gpt-6.1-terra", label: "gpt-6.1-terra" },
  ],
  gemini: [
    { id: "gemini-3.6-flash", label: "gemini-3.6-flash" },
    { id: "gemini-3.8-flash", label: "gemini-3.8-flash" },
    { id: "gemini-3.5-flash-lite", label: "gemini-3.5-flash-lite" },
    { id: "gemini-3.1-flash-lite", label: "gemini-3.1-flash-lite" },
    { id: "gemini-4-carbon", label: "gemini-4-carbon" },
    { id: "gemini-4-argon", label: "gemini-4-argon" },
  ],
};

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: MODEL_OPTIONS.anthropic[0]!.id,
  openai: MODEL_OPTIONS.openai[0]!.id,
  gemini: MODEL_OPTIONS.gemini[0]!.id,
};

export interface AiSettings {
  provider: ProviderId;
  /** プロバイダーごとの API キー (未設定は空文字)。 */
  keys: Record<ProviderId, string>;
  /** プロバイダーごとのモデル ID。 */
  models: Record<ProviderId, string>;
}

export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
export const MAX_KEY_LENGTH = 512;

export function defaultSettings(): AiSettings {
  return {
    provider: "anthropic",
    keys: { anthropic: "", openai: "", gemini: "" },
    models: { ...DEFAULT_MODELS },
  };
}

const isProvider = (v: unknown): v is ProviderId => PROVIDER_IDS.includes(v as ProviderId);

/** 保存値の検証。壊れた値は既定に戻す。 */
export function normalizeSettings(raw: unknown): AiSettings {
  const out = defaultSettings();
  if (raw === null || typeof raw !== "object") return out;
  const o = raw as Record<string, unknown>;
  if (isProvider(o.provider)) out.provider = o.provider;
  const keys = o.keys as Record<string, unknown> | undefined;
  const models = o.models as Record<string, unknown> | undefined;
  for (const p of PROVIDER_IDS) {
    const k = keys?.[p];
    if (typeof k === "string" && k.length <= MAX_KEY_LENGTH) out.keys[p] = k;
    const m = models?.[p];
    if (typeof m === "string" && MODEL_ID_PATTERN.test(m)) out.models[p] = m;
  }
  return out;
}

export function loadSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return normalizeSettings(raw === null ? null : JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

/** 保存できたら true。 */
export function saveSettings(s: AiSettings): boolean {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

/** 実際に呼び出しに使う設定。キーが無ければ null。 */
export function activeConfig(s: AiSettings): { provider: ProviderId; apiKey: string; model: string } | null {
  const apiKey = s.keys[s.provider].trim();
  if (apiKey === "") return null;
  return { provider: s.provider, apiKey, model: s.models[s.provider] };
}
