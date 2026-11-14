// 3 社の API へブラウザから直接 fetch するアダプター (SDK は使わない)。
// API キーは各社のエンドポイント宛てのヘッダにだけ載せる。自サーバー (Worker) には一切送らない。
import { AiError, redactKey } from "./errors";
import { MODEL_OPTIONS } from "./settings";
import type { ChatTurn, ProviderAdapter, ProviderConfig, ProviderId } from "./types";

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const OPENAI_URL = "https://api.openai.com/v1/responses";
export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
export const ANTHROPIC_VERSION = "2023-06-01";
/** 最大出力トークン。操作 200 件 (1 件 100〜150 トークン) + 推論に十分な値。 */
export const ANTHROPIC_MAX_TOKENS = 32000;
/** OpenAI / Gemini は推論トークンも出力上限に含まれるので大きめにする。 */
export const OTHER_MAX_TOKENS = 48000;
/** 1 回の呼び出しの既定の打ち切り時間。 */
export const REQUEST_TIMEOUT_MS = 240_000;

/** 同じ役割が続くターンを 1 つにまとめる (Gemini などは交互を要求する)。先頭は user にする。 */
export function normalizeTurns(messages: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ ...m });
  }
  while (out.length > 0 && out[0]!.role !== "user") out.shift();
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 中止・タイムアウトを 1 つの signal にまとめて fetch し、通信失敗を AiError にする。 */
async function doFetch(url: string, init: RequestInit, signal: AbortSignal, cfg: ProviderConfig): Promise<Response> {
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  if (signal.aborted) throw new AiError("aborted");
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, cfg.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (signal.aborted) throw new AiError("aborted");
    if (timedOut) throw new AiError("timeout");
    // ブラウザは CORS 失敗・オフライン・DNS 失敗をいずれも TypeError で区別なく返す。
    throw new AiError("network", redactKey(e instanceof Error ? e.message : "", cfg.apiKey));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function readJson(res: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    if (signal.aborted) throw new AiError("aborted");
    throw new AiError(res.ok ? "bad_format" : statusKind(res.status));
  }
}

function statusKind(status: number): AiError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "bad_request";
}

/** 各社のエラー本文から人が読める短い説明を取り出す (キーは伏せる)。 */
function errorDetail(body: unknown, cfg: ProviderConfig): string | undefined {
  if (!isRecord(body)) return undefined;
  const err = body.error;
  const msg = isRecord(err) ? err.message : undefined;
  if (typeof msg !== "string" || msg === "") return undefined;
  return redactKey(msg, cfg.apiKey).slice(0, 300);
}

async function failFromResponse(res: Response, cfg: ProviderConfig, signal: AbortSignal): Promise<never> {
  const body = await readJson(res, signal).catch(() => null);
  let kind = statusKind(res.status);
  // Gemini は不正なキーを 400 (API_KEY_INVALID) で返す。
  if (kind === "bad_request" && isRecord(body) && isRecord(body.error)) {
    const details = body.error.details;
    const invalidKey =
      Array.isArray(details) && details.some((d) => isRecord(d) && (d.reason === "API_KEY_INVALID" || d.reason === "API_KEY_NOT_FOUND"));
    if (invalidKey) kind = "auth";
  }
  // 401/403 の本文にはキーの一部が含まれることがあるので、補足は出さない。
  throw new AiError(kind, kind === "auth" ? undefined : errorDetail(body, cfg));
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

const isKnown = (provider: ProviderId, model: string): boolean => MODEL_OPTIONS[provider].some((m) => m.id === model);

export const callAnthropic: ProviderAdapter = async (cfg, messages, system, signal) => {
  const res = await doFetch(
    ANTHROPIC_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        // ブラウザからの直接呼び出しを許可するヘッダ (これが無いと CORS で拒否される)。
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system,
        messages: normalizeTurns(messages),
        // 応答時間を短くするため effort を medium にする (output_config.effort: GA、現行モデル全て対応)。
        // 候補にない任意のモデル ID (古いモデルは effort を受け付けない) には付けない。
        ...(isKnown("anthropic", cfg.model) ? { output_config: { effort: "medium" } } : {}),
      }),
    },
    signal,
    cfg,
  );
  if (!res.ok) return failFromResponse(res, cfg, signal);
  const body = await readJson(res, signal);
  if (!isRecord(body) || !Array.isArray(body.content)) throw new AiError("bad_format");
  if (body.stop_reason === "refusal") throw new AiError("blocked");
  const text = body.content
    .filter((b): b is { type: "text"; text: string } => isRecord(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  if (body.stop_reason === "max_tokens") throw new AiError("truncated");
  if (text === "") throw new AiError("bad_format");
  return { text };
};

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------

export const callOpenAi: ProviderAdapter = async (cfg, messages, system, signal) => {
  const res = await doFetch(
    OPENAI_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        instructions: system,
        input: normalizeTurns(messages).map((m) => ({ role: m.role, content: m.content })),
        text: { format: { type: "json_object" } },
        max_output_tokens: OTHER_MAX_TOKENS, // 推論トークンも含まれる
        store: false,
        // 推論を軽くして出力が途切れにくく・速くする (公式の例にある reasoning.effort)。候補にないモデル ID には付けない。
        ...(isKnown("openai", cfg.model) ? { reasoning: { effort: "low" } } : {}),
      }),
    },
    signal,
    cfg,
  );
  if (!res.ok) return failFromResponse(res, cfg, signal);
  const body = await readJson(res, signal);
  if (!isRecord(body)) throw new AiError("bad_format");
  if (body.status === "incomplete") {
    const reason = isRecord(body.incomplete_details) ? body.incomplete_details.reason : undefined;
    throw new AiError(reason === "content_filter" ? "blocked" : "truncated");
  }
  if (!Array.isArray(body.output)) throw new AiError("bad_format");
  let text = "";
  for (const item of body.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (!isRecord(c)) continue;
      if (c.type === "refusal") throw new AiError("blocked");
      if (c.type === "output_text" && typeof c.text === "string") text += c.text;
    }
  }
  if (text === "") throw new AiError("bad_format");
  return { text };
};

// ---------------------------------------------------------------------------
// Google Gemini generateContent
// ---------------------------------------------------------------------------

export const callGemini: ProviderAdapter = async (cfg, messages, system, signal) => {
  const res = await doFetch(
    `${GEMINI_BASE}${encodeURIComponent(cfg.model)}:generateContent`,
    {
      method: "POST",
      // キーは URL のクエリではなくヘッダで送る。
      headers: { "content-type": "application/json", "x-goog-api-key": cfg.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: normalizeTurns(messages).map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: OTHER_MAX_TOKENS },
      }),
    },
    signal,
    cfg,
  );
  if (!res.ok) return failFromResponse(res, cfg, signal);
  const body = await readJson(res, signal);
  if (!isRecord(body)) throw new AiError("bad_format");
  if (isRecord(body.promptFeedback) && typeof body.promptFeedback.blockReason === "string") throw new AiError("blocked");
  const cand = Array.isArray(body.candidates) ? body.candidates[0] : undefined;
  if (!isRecord(cand)) throw new AiError("bad_format");
  const finish = cand.finishReason;
  const parts = isRecord(cand.content) && Array.isArray(cand.content.parts) ? cand.content.parts : [];
  const text = parts
    .filter((p): p is { text: string } => isRecord(p) && typeof p.text === "string" && p.thought !== true)
    .map((p) => p.text)
    .join("");
  if (finish === "MAX_TOKENS") throw new AiError("truncated");
  if (typeof finish === "string" && finish !== "STOP" && text === "") {
    throw new AiError(finish === "SAFETY" || finish === "PROHIBITED_CONTENT" || finish === "BLOCKLIST" || finish === "RECITATION" ? "blocked" : "bad_format");
  }
  if (text === "") throw new AiError("bad_format");
  return { text };
};

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  anthropic: callAnthropic,
  openai: callOpenAi,
  gemini: callGemini,
};

export function callProvider(
  provider: ProviderId,
  cfg: ProviderConfig,
  messages: ChatTurn[],
  system: string,
  signal: AbortSignal,
) {
  return ADAPTERS[provider](cfg, messages, system, signal);
}
