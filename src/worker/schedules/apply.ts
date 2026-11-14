import type { Patch } from "immer";
import { executeCommand, loadDocument, type Command, type CommandContext } from "../../shared/engine";
import { diffDays, isValidIsoDate } from "../../shared/model/date";
import { idKey } from "../../shared/model/id";
import type { GanttDocument } from "../../shared/model/types";
import { MAX_DOC_BYTES, checkSchema, stripView, utf8Length, validateImportedDoc, type ValidationIssue } from "./validate";

/**
 * 「doc + command → 新 doc」の適用処理。HTTP にも D1 にも依存しない純関数
 * (Durable Object (src/worker/room) がこの関数を呼ぶ)。
 */

/** クライアントが実行コンテキストとして送れるもの。サーバーが検証して使う。 */
export interface CommandContextInput {
  /** クライアントのローカル日付 (YYYY-MM-DD)。サーバー日付の前後 2 日以内のときだけ採用。 */
  today?: unknown;
  /** クライアントが楽観的適用で生成した ID (addTask / duplicateTask 用)。同じ ID を採用して画面と一致させる。 */
  ids?: unknown;
  defaultTaskName?: unknown;
  defaultCategoryName?: unknown;
  defaultMilestoneName?: unknown;
}

export type ApplyFailure =
  | { ok: false; status: 400; error: "invalid_command"; message: string }
  | { ok: false; status: 422; error: "command_rejected"; code: string; params?: Record<string, string | number> }
  | { ok: false; status: 422; error: "invalid_document"; kind: "schema" | "integrity"; issues: ValidationIssue[] }
  | { ok: false; status: 413; error: "too_large"; bytes: number; limit: number };

export type ApplyResult =
  | {
      ok: true;
      /** view を含まない新しい doc。 */
      doc: GanttDocument;
      /** 保存用 JSON (UTF-8 で MAX_DOC_BYTES 以下であることを確認済み)。 */
      json: string;
      /** doc.project.name (schedules.name に常に一致させる)。 */
      name: string;
      /** false = 実質変更なし (rev を上げなくてよい)。 */
      changed: boolean;
      /** doc (サーバー保存形 = view なし) に対する immer パッチ。クライアントへ配信して同じ doc を再現させる。 */
      patches: Patch[];
    }
  | ApplyFailure;

/** Command["type"] の網羅性をコンパイル時に保証するための表。 */
const COMMAND_TYPES: Record<Command["type"], true> = {
  moveTask: true,
  resizeTaskEnd: true,
  resizeTaskStart: true,
  setDates: true,
  setDuration: true,
  setStatus: true,
  addMilestone: true,
  setHours: true,
  setName: true,
  setNotes: true,
  addTask: true,
  addCategory: true,
  duplicateTask: true,
  deleteTask: true,
  indent: true,
  outdent: true,
  moveUp: true,
  moveDown: true,
  setResources: true,
  setAssignees: true,
  setCategory: true,
  setColorLabel: true,
  addDependency: true,
  removeDependency: true,
  rescheduleAll: true,
  setProjectInfo: true,
  setCalendar: true,
  addResource: true,
  updateResource: true,
  deleteResource: true,
  addColorLabel: true,
  updateColorLabel: true,
  deleteColorLabel: true,
  replaceDocument: true,
};

export const MAX_CLIENT_IDS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FALLBACK_TASK_NAME = "新しいタスク";
const FALLBACK_CATEGORY_NAME = "新しいカテゴリ";
const FALLBACK_MILESTONE_NAME = "新しいマイルストーン";

/** 検証済みの CommandContext を作る。クライアント指定が不正・範囲外ならサーバー側の値に落とす。 */
export function buildContext(doc: GanttDocument, input: CommandContextInput | undefined, nowMs: number): CommandContext {
  const serverToday = new Date(nowMs).toISOString().slice(0, 10);
  let today = serverToday;
  if (typeof input?.today === "string" && isValidIsoDate(input.today) && Math.abs(diffDays(serverToday, input.today)) <= 2) {
    today = input.today;
  }
  const queue: string[] = [];
  if (Array.isArray(input?.ids)) {
    for (const v of input.ids.slice(0, MAX_CLIENT_IDS)) {
      if (typeof v === "string" && UUID.test(v.toLowerCase())) queue.push(v.toLowerCase());
    }
  }
  const used = new Set(doc.tasks.map((t) => idKey(t.id)));
  const newId = (): string => {
    while (queue.length > 0) {
      const c = queue.shift()!;
      if (!used.has(c)) {
        used.add(c);
        return c;
      }
    }
    const r = crypto.randomUUID().toLowerCase();
    used.add(r);
    return r;
  };
  const name = input?.defaultTaskName;
  const defaultTaskName =
    typeof name === "string" && name.trim() !== "" && name.length <= 100 ? name : FALLBACK_TASK_NAME;
  const cname = input?.defaultCategoryName;
  const defaultCategoryName =
    typeof cname === "string" && cname.trim() !== "" && cname.length <= 100 ? cname : FALLBACK_CATEGORY_NAME;
  const mname = input?.defaultMilestoneName;
  const defaultMilestoneName =
    typeof mname === "string" && mname.trim() !== "" && mname.length <= 100 ? mname : FALLBACK_MILESTONE_NAME;
  return { today, newId, defaultTaskName, defaultCategoryName, defaultMilestoneName };
}

/** 形だけの検査 (中身の妥当性は engine が検査する)。 */
function checkShape(command: unknown): Command | string {
  if (command === null || typeof command !== "object" || Array.isArray(command)) return "command must be an object";
  const type = (command as { type?: unknown }).type;
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(COMMAND_TYPES, type)) {
    return "unknown command type";
  }
  return command as Command;
}

/** doc が保存上限に収まるか確認して JSON にする。 */
export function serializeDoc(doc: GanttDocument): { ok: true; json: string } | Extract<ApplyFailure, { status: 413 }> {
  const json = JSON.stringify(doc);
  const bytes = utf8Length(json);
  if (bytes > MAX_DOC_BYTES) return { ok: false, status: 413, error: "too_large", bytes, limit: MAX_DOC_BYTES };
  return { ok: true, json };
}

/**
 * doc に command を適用する。doc はサーバーの正 (view なし)。
 * 失敗の種類: 形が不正 400 / engine が拒否 422 / 結果が整合しない 422 / サイズ超過 413。
 */
export function applyCommandToDoc(
  doc: GanttDocument,
  commandInput: unknown,
  ctxInput: CommandContextInput | undefined,
  nowMs: number,
): ApplyResult {
  const shaped = checkShape(commandInput);
  if (typeof shaped === "string") return { ok: false, status: 400, error: "invalid_command", message: shaped };
  let command: Command = shaped;

  if (command.type === "replaceDocument") {
    const v = validateImportedDoc((command as { doc?: unknown }).doc);
    if (!v.ok) return { ok: false, status: 422, error: "invalid_document", kind: v.kind, issues: v.issues };
    command = { type: "replaceDocument", doc: v.doc };
  }

  let res;
  try {
    res = executeCommand(doc, command, buildContext(doc, ctxInput, nowMs));
  } catch {
    // フィールドの型違いなど、engine が想定しない入力で例外になった場合。
    return { ok: false, status: 400, error: "invalid_command", message: "command could not be applied" };
  }
  if (!res.ok) {
    return { ok: false, status: 422, error: "command_rejected", code: res.code, ...(res.params ? { params: res.params } : {}) };
  }

  const next = stripView(res.doc) as GanttDocument;
  const changed = res.patches.length > 0;
  if (changed) {
    // 防御: engine を通っても、保存するのはスキーマに適合する doc だけ。
    const schemaIssues = checkSchema(next);
    if (schemaIssues.length > 0) {
      return { ok: false, status: 422, error: "invalid_document", kind: "schema", issues: schemaIssues };
    }
    // 防御: engine が不変条件を保つはずだが、保存前に構造の整合性を確認する (ID 重複・循環など)。
    const check = loadDocument(structuredClone(next));
    if (!check.ok) {
      return {
        ok: false,
        status: 422,
        error: "invalid_document",
        kind: "integrity",
        issues: check.errors.slice(0, 50).map((e) => ({ ...e })),
      };
    }
  }
  const ser = serializeDoc(next);
  if (!ser.ok) return ser;
  // view はサーバーの doc に無い (stripView 済み)。view へのパッチは配信しない。
  const patches = res.patches.filter((p) => p.path[0] !== "view");
  return { ok: true, doc: next, json: ser.json, name: next.project.name, changed, patches };
}
