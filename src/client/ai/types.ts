export type ProviderId = "anthropic" | "openai" | "gemini";
export const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "openai", "gemini"];

/** プロバイダーへ渡す会話の 1 ターン。 */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ProviderConfig {
  apiKey: string;
  model: string;
  /** 1 回の呼び出しのタイムアウト (ms)。省略時は既定。 */
  timeoutMs?: number;
}

/** 共通アダプターの戻り値。構造の解釈は呼び出し側 (parseReply) が行う。 */
export interface ProviderReply {
  text: string;
}

/** 3 社のアダプターが満たす共通インターフェース。 */
export type ProviderAdapter = (
  cfg: ProviderConfig,
  messages: ChatTurn[],
  system: string,
  signal: AbortSignal,
) => Promise<ProviderReply>;
