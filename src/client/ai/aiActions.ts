// AI ペインの動作: 送信 → 検証 (dry run) → プレビュー → 適用。
import { deepEqual } from "../../shared/engine";
import { todayIso } from "../../shared/model/date";
import type { GanttDocument } from "../../shared/model/types";
import { t } from "../i18n";
import { useAppStore } from "../store/appStore";
import { showToast } from "../components/uiStore";
import { saveAutoVersion } from "../versionsApi";
import { nextMessageId, useAiStore, type AiMessage } from "./aiStore";
import { AiError } from "./errors";
import { runOps, type AiOp, type Exec, type OpFailure } from "./ops";
import { dryRun, isEmptyDiff, withoutView } from "./plan";
import {
  buildSystemPrompt,
  buildUserTurn,
  FORMAT_RETRY,
  MAX_HISTORY_TURNS,
  OPS_RETRY,
  parseReply,
} from "./prompt";
import { callProvider } from "./providers";
import { activeConfig } from "./settings";
import type { ChatTurn } from "./types";

let controller: AbortController | null = null;
/** 会話の世代。新しい会話・別スケジュールへ移ったら進め、古い非同期処理の結果を捨てる。 */
let generation = 0;

const ai = () => useAiStore.getState();
const app = () => useAppStore.getState();

/** 失敗した操作を、AI にもユーザーにも読める日本語にする。 */
export function describeFailure(f: OpFailure): string {
  const reason =
    f.code === "UNRESOLVED"
      ? f.message
      : `${t(`error.engine.${f.code}`, f.params)} (${f.code}${f.params ? " " + JSON.stringify(f.params) : ""})`;
  return `操作 #${f.index + 1} (${f.op.op}): ${reason}`;
}

export function aiErrorText(e: AiError): string {
  const base = t(`ai.error.${e.kind}`);
  return e.detail ? `${base} (${e.detail})` : base;
}

/** 前回の変更案の状況 (次のターンに 1 行で伝える)。 */
function lastOutcome(messages: AiMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind !== "assistant") continue;
    const p = m.proposal;
    if (!p) return undefined;
    switch (p.state) {
      case "applied":
        return "適用されました。";
      case "partial":
        return "途中まで適用されました (残りは適用されていません)。";
      case "discarded":
        return "ユーザーが破棄しました (適用されていません)。";
      case "superseded":
        return "新しい変更案に置き換えられました (適用されていません)。";
      case "stale":
      case "failed":
        return "適用できませんでした (適用されていません)。";
      default:
        return "まだ適用されていません (ユーザーが判断中)。";
    }
  }
  return undefined;
}

/** 完了したターン (指示 + 応答) の組を、直近のものだけ会話履歴にする。 */
export function buildHistory(messages: AiMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let pending: string | null = null;
  for (const m of messages) {
    if (m.kind === "user") pending = m.text;
    else if (m.kind === "assistant" && pending !== null) {
      turns.push({ role: "user", content: pending }, { role: "assistant", content: m.raw });
      pending = null;
    } else if (m.kind === "error") pending = null;
  }
  return turns.slice(-MAX_HISTORY_TURNS * 2);
}

export function cancel(): void {
  controller?.abort();
}

/** 新しい会話 (履歴を消す)。実行中のものは中止する。 */
export function resetConversation(): void {
  generation++;
  controller?.abort();
  controller = null;
  useAiStore.setState({ messages: [], status: "idle" });
}

/** 1 回の指示 (再要求を含む) にかける最長の時間。 */
export const TURN_BUDGET_MS = 8 * 60_000;
/** 再要求をする場合に、最低限残っていてほしい時間。 */
const RETRY_MIN_MS = 60_000;
/** 1 回の呼び出しの上限。 */
const CALL_MAX_MS = 240_000;
/** 適用後、サーバーでの確定を待つ最長の時間。 */
export const CONFIRM_TIMEOUT_MS = 30_000;

/**
 * 「現在のスケジュール」(view なし、未確定のコマンドを含む)。バージョン表示中は画面の doc が過去の版なので、
 * 表示前に退避した現在の内容 (viewing.liveServerDoc) を使う。
 */
export function currentLiveDoc(): GanttDocument | null {
  const a = app();
  if (a.doc === null) return null;
  return a.viewing !== null ? a.viewing.liveServerDoc : withoutView(a.doc);
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function send(instruction: string): Promise<void> {
  const text = instruction.trim();
  const st = ai();
  const a = app();
  if (text === "" || st.status !== "idle" || a.doc === null || a.readOnly || a.scheduleId === null) return;
  const cfg = activeConfig(st.settings);
  if (cfg === null) {
    st.openSettings();
    return;
  }
  const gen = generation;
  const history = buildHistory(st.messages);
  const outcome = lastOutcome(st.messages);
  const push = (m: AiMessage) => {
    if (gen === generation) ai().push(m);
  };
  push({ id: nextMessageId(), kind: "user", text });
  ai().setStatus("thinking");
  const ctrl = new AbortController();
  controller = ctrl;
  const deadline = Date.now() + TURN_BUDGET_MS;

  const system = buildSystemPrompt(todayIso());
  const base = currentLiveDoc()!;
  const turns: ChatTurn[] = [...history, { role: "user", content: buildUserTurn({ doc: base, instruction: text, lastOutcome: outcome }) }];
  let formatRetried = false;
  let opsRetried = false;
  /** まだ時間が残っていれば再要求してよい。 */
  const canRetry = () => deadline - Date.now() > RETRY_MIN_MS;
  try {
    for (;;) {
      const timeoutMs = Math.max(10_000, Math.min(CALL_MAX_MS, deadline - Date.now()));
      ai().setStatus("thinking");
      const reply = await callProvider(cfg.provider, { apiKey: cfg.apiKey, model: cfg.model, timeoutMs }, turns, system, ctrl.signal);
      if (gen !== generation) return;
      let parsed;
      try {
        parsed = parseReply(reply.text);
      } catch (e) {
        if (e instanceof AiError && e.kind === "bad_format" && !formatRetried && canRetry()) {
          formatRetried = true;
          turns.push({ role: "assistant", content: reply.text }, { role: "user", content: FORMAT_RETRY(e.detail ?? "") });
          continue;
        }
        throw e;
      }
      if (app().scheduleId !== a.scheduleId) return;
      if (parsed.ops.length === 0) {
        push({ id: nextMessageId(), kind: "assistant", text: parsed.message, raw: reply.text });
        return;
      }
      ai().setStatus("validating");
      await tick();
      if (gen !== generation) return;
      const doc = currentLiveDoc();
      if (doc === null) return;
      const dr = dryRun(doc, parsed.ops);
      if (!dr.ok) {
        const msg = describeFailure(dr.failure);
        if (!opsRetried && canRetry()) {
          opsRetried = true;
          turns.push({ role: "assistant", content: reply.text }, { role: "user", content: OPS_RETRY(msg) });
          continue;
        }
        push({ id: nextMessageId(), kind: "assistant", text: parsed.message, raw: reply.text });
        push({ id: nextMessageId(), kind: "error", text: t("ai.invalidProposal", { reason: msg }) });
        return;
      }
      if (isEmptyDiff(dr.diff)) {
        push({ id: nextMessageId(), kind: "assistant", text: parsed.message, raw: reply.text });
        push({ id: nextMessageId(), kind: "notice", text: t("ai.noEffect") });
        return;
      }
      // 新しい変更案が届いたら、それ以前の適用待ちの変更案は置き換え済み (適用不可)。
      supersedePending();
      push({
        id: nextMessageId(),
        kind: "assistant",
        text: parsed.message,
        raw: reply.text,
        proposal: { ops: parsed.ops, diff: dr.diff, before: dr.before, state: "pending" },
      });
      return;
    }
  } catch (e) {
    if (gen !== generation) return;
    if (e instanceof AiError) {
      if (e.kind === "aborted") push({ id: nextMessageId(), kind: "notice", text: t("ai.aborted") });
      else push({ id: nextMessageId(), kind: "error", text: aiErrorText(e) });
    } else {
      // 想定外の例外。内容 (API キーを含みうる) は出さない。
      push({ id: nextMessageId(), kind: "error", text: t("ai.error.unknown") });
    }
  } finally {
    if (gen === generation) {
      if (controller === ctrl) controller = null;
      ai().setStatus("idle");
    }
  }
}

function supersedePending(): void {
  for (const m of ai().messages) {
    if (m.kind === "assistant" && m.proposal?.state === "pending") ai().patchProposal(m.id, { state: "superseded" });
  }
}

function findProposal(id: number) {
  const m = ai().messages.find((x) => x.id === id);
  return m && m.kind === "assistant" && m.proposal ? m.proposal : null;
}

export function discardProposal(id: number): void {
  const p = findProposal(id);
  if (!p || p.state !== "pending") return;
  ai().patchProposal(id, { state: "discarded" });
}

type Recheck = "same" | "rebuilt" | "invalid";

/**
 * 変更案のプレビューの基にした doc と、いまの doc (確定 + 未確定) が同一か確かめる。
 * 違えば適用せず、最新の doc で dry run し直して変更案を作り直す (適用待ちに戻す)。
 */
function recheck(id: number, p: { ops: AiOp[]; before: GanttDocument }): Recheck {
  const cur = currentLiveDoc();
  if (cur === null) return "invalid";
  if (deepEqual(cur, p.before)) return "same";
  const dr = dryRun(cur, p.ops);
  if (!dr.ok || isEmptyDiff(dr.diff)) {
    ai().patchProposal(id, { state: "stale", detail: t("ai.apply.stale") });
    return "invalid";
  }
  ai().patchProposal(id, { state: "pending", diff: dr.diff, before: dr.before, notice: t("ai.apply.rebuilt") });
  return "rebuilt";
}

/** 送ったコマンドがすべてサーバーで確定するまで待つ。 */
export function waitConfirmed(lossBefore: number, timeoutMs = CONFIRM_TIMEOUT_MS): Promise<"ok" | "lost" | "timeout"> {
  return new Promise((resolve) => {
    const check = (): "ok" | "lost" | null => {
      const s = useAppStore.getState();
      if (s.syncLoss !== lossBefore) return "lost";
      return s.pending === 0 ? "ok" : null;
    };
    const first = check();
    if (first) return resolve(first);
    const timer = setTimeout(() => {
      unsub();
      resolve("timeout");
    }, timeoutMs);
    const unsub = useAppStore.subscribe(() => {
      const r = check();
      if (r) {
        clearTimeout(timer);
        unsub();
        resolve(r);
      }
    });
  });
}

/**
 * 変更案を適用する:
 * (1) プレビューの基の doc といまの doc が同一か確認 (違えば作り直して終了)
 * (2) 自動バージョン (失敗したら適用しない。再試行できる)
 * (3) もう一度 (1) の確認 → Command を順に dispatch → すべてサーバーで確定するまで待つ
 */
export async function applyProposal(id: number): Promise<void> {
  const p = findProposal(id);
  const a = app();
  if (!p || p.state !== "pending" || ai().status !== "idle") return;
  if (a.readOnly || a.doc === null || a.scheduleId === null) {
    showToast("error", t("ai.readOnlyNotice"));
    return;
  }
  const scheduleId = a.scheduleId;
  const gen = generation;
  ai().patchProposal(id, { state: "applying", notice: undefined });
  ai().setStatus("applying");
  try {
    if (recheck(id, p) !== "same") return;
    try {
      await saveAutoVersion(scheduleId);
    } catch {
      if (gen === generation) ai().patchProposal(id, { state: "pending", notice: t("ai.apply.versionFailed") });
      return;
    }
    if (gen !== generation || app().scheduleId !== scheduleId) return;
    const cur = app();
    if (cur.readOnly || cur.doc === null) {
      ai().patchProposal(id, { state: "pending", notice: t("ai.apply.readOnly") });
      return;
    }
    // バージョン作成の間に他者が編集していないか、もう一度確かめる (ここから dispatch までは同期的)。
    const cur2 = findProposal(id)!;
    if (recheck(id, cur2) !== "same") return;
    const lossBefore = cur.syncLoss;
    const exec: Exec = (cmd) => {
      const r = useAppStore.getState().dispatch(cmd);
      // addTask は新しいタスクの名前編集を開始するが、AI の適用では不要。
      if (r.ok && cmd.type === "addTask") useAppStore.setState({ editing: null });
      return r;
    };
    const res = runOps(p.ops, exec, () => useAppStore.getState().doc!);
    if (res.failure) {
      ai().patchProposal(id, {
        state: "partial",
        detail: t("ai.apply.partial", { done: res.doneOps, total: p.ops.length, reason: describeFailure(res.failure) }),
      });
      showToast("error", t("ai.apply.partialToast"));
      return;
    }
    // 送ったコマンドがすべてサーバーで確定するまで「適用中」。
    const conf = await waitConfirmed(lossBefore);
    if (gen !== generation) return;
    if (conf === "ok") {
      ai().patchProposal(id, { state: "applied", detail: t("ai.apply.done", { count: p.ops.length }) });
      showToast("info", t("ai.apply.doneToast"));
    } else {
      ai().patchProposal(id, { state: "partial", detail: t(conf === "lost" ? "ai.apply.serverLost" : "ai.apply.unconfirmed") });
      showToast("error", t("ai.apply.partialToast"));
    }
  } finally {
    if (gen === generation) ai().setStatus("idle");
  }
}
