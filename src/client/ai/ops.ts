// AI 向けの操作語彙の定義・検証・engine の Command への翻訳。
// AI は「操作のリスト」を返す。新規のタスク・リソース・色ラベルには仮 ID ("new:1" など) を付け、後続の操作から参照できる。
// 実 UUID への解決は実行時 (addTask が作った実 ID が分かった時点) に行う。
import {
  buildTreeIndex,
  getChildren,
  type Command,
  type CommandErr,
  type CommandOk,
} from "../../shared/engine";
import { isValidIsoDate } from "../../shared/model/date";
import { idKey } from "../../shared/model/id";
import type { GanttDocument, Task } from "../../shared/model/types";

export const MAX_OPS = 200;
export const TEMP_ID = /^new:[A-Za-z0-9_-]{1,32}$/;
const MAX_TEXT = 2000;
const HEX = /^#[0-9A-Fa-f]{6}$/;

export interface DepRef {
  id: string;
}

export type AiOp =
  | {
      op: "addTask";
      tempId: string;
      name: string;
      start?: string;
      end?: string;
      parentId?: string;
      afterId?: string;
      hours?: number;
      notes?: string;
      resourceIds?: string[];
      colorLabelId?: string;
      dependsOn?: DepRef[];
    }
  | { op: "addCategory"; tempId: string; name: string; parentId?: string; afterId?: string }
  | { op: "addMilestone"; tempId: string; name: string; date: string; parentId?: string; afterId?: string; notes?: string; colorLabelId?: string }
  | {
      op: "updateTask";
      id: string;
      name?: string;
      start?: string;
      end?: string;
      durationDays?: number;
      /** マイルストーンの日付 (マイルストーンのみ)。 */
      date?: string;
      status?: "todo" | "doing" | "done";
      hours?: number | null;
      notes?: string;
      resourceIds?: string[];
      colorLabelId?: string | null;
    }
  | { op: "setCategory"; id: string; categoryId: string | null }
  | { op: "shiftTask"; id: string; deltaDays: number }
  | { op: "deleteTask"; id: string }
  | { op: "arrangeTask"; id: string; action: "indent" | "outdent" | "up" | "down" }
  | { op: "addDependency"; taskId: string; predecessorId: string }
  | { op: "removeDependency"; taskId: string; predecessorId: string }
  | { op: "setCalendar"; weekends: number[]; holidays: string[] }
  | { op: "clearCalendar" }
  | { op: "setProjectInfo"; name?: string; description?: string }
  | { op: "addResource"; tempId: string; name: string; color?: string }
  | { op: "updateResource"; id: string; name?: string; color?: string | null }
  | { op: "deleteResource"; id: string }
  | { op: "addColorLabel"; tempId: string; name: string; color: string }
  | { op: "updateColorLabel"; id: string; name?: string; color?: string }
  | { op: "deleteColorLabel"; id: string };

export type AiOpName = AiOp["op"];

// ---------------------------------------------------------------------------
// 検証 (AI の出力は信用しない: 型・長さ・形式をすべて確かめる)
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
class Bad extends Error {}
const bad = (msg: string): never => {
  throw new Bad(msg);
};

function str(o: Rec, k: string, opt = false, max = MAX_TEXT): string | undefined {
  const v = o[k];
  if (v === undefined) {
    if (opt) return undefined;
    return bad(`"${k}" が必要です`);
  }
  if (typeof v !== "string") return bad(`"${k}" は文字列にしてください`);
  if (v.length > max) return bad(`"${k}" が長すぎます`);
  return v;
}
function idRef(o: Rec, k: string, opt = false): string | undefined {
  const v = str(o, k, opt, 80);
  if (v !== undefined && v === "") bad(`"${k}" が空です`);
  return v;
}
function date(o: Rec, k: string): string | undefined {
  const v = str(o, k, true, 10);
  if (v !== undefined && !isValidIsoDate(v)) bad(`"${k}" は YYYY-MM-DD の実在する日付にしてください`);
  return v;
}
function int(o: Rec, k: string, opt: boolean, min: number, max: number): number | undefined {
  const v = o[k];
  if (v === undefined) {
    if (opt) return undefined;
    return bad(`"${k}" が必要です`);
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return bad(`"${k}" は ${min}〜${max} の整数にしてください`);
  return v;
}
function color(o: Rec, k: string, opt: boolean, nullable = false): string | null | undefined {
  const v = o[k];
  if (v === undefined) {
    if (opt) return undefined;
    return bad(`"${k}" が必要です`);
  }
  if (v === null && nullable) return null;
  if (typeof v !== "string" || !HEX.test(v)) return bad(`"${k}" は #RRGGBB 形式の色にしてください`);
  return v;
}
function idList(o: Rec, k: string): string[] | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 100 || v.some((x) => typeof x !== "string" || x === "" || x.length > 80)) {
    return bad(`"${k}" は ID の配列にしてください`);
  }
  return v as string[];
}
function tempId(o: Rec): string {
  const v = str(o, "tempId", false, 40)!;
  if (!TEMP_ID.test(v)) bad(`"tempId" は "new:1" のような形式にしてください`);
  return v;
}
function status(o: Rec): "todo" | "doing" | "done" | undefined {
  const v = o.status;
  if (v === undefined) return undefined;
  if (v !== "todo" && v !== "doing" && v !== "done") return bad(`"status" は todo / doing / done のいずれかにしてください`);
  return v;
}
function onlyDefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

function parseOp(raw: unknown): AiOp {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return bad("操作はオブジェクトにしてください");
  const o = raw as Rec;
  const op = o.op;
  if (typeof op !== "string") return bad(`"op" が必要です`);
  switch (op) {
    case "addTask": {
      let dependsOn: DepRef[] | undefined;
      if (o.dependsOn !== undefined) {
        if (!Array.isArray(o.dependsOn) || o.dependsOn.length > 50) return bad(`"dependsOn" は配列にしてください`);
        dependsOn = o.dependsOn.map((d) => {
          if (d === null || typeof d !== "object") return bad(`"dependsOn" の要素は {id} にしてください`);
          const r = d as Rec;
          return { id: idRef(r, "id")! };
        });
      }
      const hours = o.hours;
      if (hours !== undefined && (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0)) return bad(`"hours" は 0 以上の数値にしてください`);
      return onlyDefined({
        op,
        tempId: tempId(o),
        name: str(o, "name", false, 500)!,
        start: date(o, "start"),
        end: date(o, "end"),
        parentId: idRef(o, "parentId", true),
        afterId: idRef(o, "afterId", true),
        hours: hours as number | undefined,
        notes: str(o, "notes", true),
        resourceIds: idList(o, "resourceIds"),
        colorLabelId: idRef(o, "colorLabelId", true),
        dependsOn,
      }) as AiOp;
    }
    case "addCategory":
      return onlyDefined({
        op,
        tempId: tempId(o),
        name: str(o, "name", false, 500)!,
        parentId: idRef(o, "parentId", true),
        afterId: idRef(o, "afterId", true),
      }) as AiOp;
    case "addMilestone": {
      const d = date(o, "date");
      if (d === undefined) return bad(`"date" が必要です`);
      return onlyDefined({
        op,
        tempId: tempId(o),
        name: str(o, "name", false, 500)!,
        date: d,
        parentId: idRef(o, "parentId", true),
        afterId: idRef(o, "afterId", true),
        notes: str(o, "notes", true),
        colorLabelId: idRef(o, "colorLabelId", true),
      }) as AiOp;
    }
    case "updateTask": {
      const hours = o.hours;
      if (hours !== undefined && hours !== null && (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0)) {
        return bad(`"hours" は 0 以上の数値か null にしてください`);
      }
      const cl = o.colorLabelId;
      if (cl !== undefined && cl !== null && (typeof cl !== "string" || cl === "" || cl.length > 80)) return bad(`"colorLabelId" は ID か null にしてください`);
      const r = onlyDefined({
        op,
        id: idRef(o, "id")!,
        name: str(o, "name", true, 500),
        start: date(o, "start"),
        end: date(o, "end"),
        durationDays: int(o, "durationDays", true, 1, 36600),
        date: date(o, "date"),
        status: status(o),
        hours: hours as number | null | undefined,
        notes: str(o, "notes", true),
        resourceIds: idList(o, "resourceIds"),
        colorLabelId: cl as string | null | undefined,
      }) as Extract<AiOp, { op: "updateTask" }>;
      if (Object.keys(r).length <= 2) return bad("更新する項目がありません");
      return r;
    }
    case "setCategory": {
      const c = o.categoryId;
      if (c === undefined) return bad(`"categoryId" が必要です (カテゴリなしにするときは null)`);
      return { op, id: idRef(o, "id")!, categoryId: c === null ? null : idRef(o, "categoryId")! };
    }
    case "shiftTask":
      return { op, id: idRef(o, "id")!, deltaDays: int(o, "deltaDays", false, -36500, 36500)! };
    case "deleteTask":
      return { op, id: idRef(o, "id")! };
    case "arrangeTask": {
      const a = o.action;
      if (a !== "indent" && a !== "outdent" && a !== "up" && a !== "down") return bad(`"action" は indent / outdent / up / down のいずれかにしてください`);
      return { op, id: idRef(o, "id")!, action: a };
    }
    case "addDependency":
      return { op, taskId: idRef(o, "taskId")!, predecessorId: idRef(o, "predecessorId")! };
    case "removeDependency":
      return { op, taskId: idRef(o, "taskId")!, predecessorId: idRef(o, "predecessorId")! };
    case "setCalendar": {
      const w = o.weekends;
      if (!Array.isArray(w) || w.length > 6 || w.some((x) => !Number.isInteger(x) || x < 0 || x > 6) || new Set(w).size !== w.length) {
        return bad(`"weekends" は 0〜6 の重複しない整数の配列 (最大 6 個) にしてください`);
      }
      const h = o.holidays;
      if (!Array.isArray(h) || h.length > 1000 || h.some((x) => typeof x !== "string" || !isValidIsoDate(x))) {
        return bad(`"holidays" は YYYY-MM-DD の配列にしてください`);
      }
      return { op, weekends: w as number[], holidays: h as string[] };
    }
    case "clearCalendar":
      return { op };
    case "setProjectInfo": {
      const r = onlyDefined({ op, name: str(o, "name", true, 200), description: str(o, "description", true, 10000) }) as AiOp;
      if (Object.keys(r).length <= 1) return bad("更新する項目がありません");
      if ("name" in r && (r.name ?? "").trim() === "") return bad(`"name" が空です`);
      return r;
    }
    case "addResource":
      return onlyDefined({ op, tempId: tempId(o), name: str(o, "name", false, 200)!, color: color(o, "color", true) as string | undefined }) as AiOp;
    case "updateResource": {
      const r = onlyDefined({ op, id: idRef(o, "id")!, name: str(o, "name", true, 200), color: color(o, "color", true, true) }) as AiOp;
      if (Object.keys(r).length <= 2) return bad("更新する項目がありません");
      return r;
    }
    case "deleteResource":
      return { op, id: idRef(o, "id")! };
    case "addColorLabel":
      return { op, tempId: tempId(o), name: str(o, "name", false, 200)!, color: color(o, "color", false) as string };
    case "updateColorLabel": {
      const r = onlyDefined({ op, id: idRef(o, "id")!, name: str(o, "name", true, 200), color: color(o, "color", true) as string | undefined }) as AiOp;
      if (Object.keys(r).length <= 2) return bad("更新する項目がありません");
      return r;
    }
    case "deleteColorLabel":
      return { op, id: idRef(o, "id")! };
    default:
      return bad(`未知の操作です: ${op.slice(0, 40)}`);
  }
}

export type ParseOpsResult = { ok: true; ops: AiOp[] } | { ok: false; error: string };

/** AI が返した操作リストを検証する。仮 ID の重複もここで弾く。 */
export function parseOps(raw: unknown): ParseOpsResult {
  if (!Array.isArray(raw)) return { ok: false, error: `"operations" は配列にしてください` };
  if (raw.length > MAX_OPS) return { ok: false, error: `操作が多すぎます (最大 ${MAX_OPS} 件)` };
  const ops: AiOp[] = [];
  const temps = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    try {
      const op = parseOp(raw[i]);
      if ("tempId" in op) {
        if (temps.has(op.tempId)) throw new Bad(`tempId が重複しています: ${op.tempId}`);
        temps.add(op.tempId);
      }
      ops.push(op);
    } catch (e) {
      if (e instanceof Bad) return { ok: false, error: `操作 #${i + 1}: ${e.message}` };
      throw e;
    }
  }
  return { ok: true, ops };
}

// ---------------------------------------------------------------------------
// 実行 (翻訳 + 順次実行)
// ---------------------------------------------------------------------------

export type ExecResult = CommandOk | CommandErr;
/** Command を 1 つ実行する。dry run ではローカルの executeCommand、適用では store.dispatch。 */
export type Exec = (cmd: Command) => ExecResult;

export interface OpFailure {
  /** 0 始まりの操作番号。 */
  index: number;
  op: AiOp;
  /** engine のエラーコード、または翻訳時のエラー (UNRESOLVED など)。 */
  code: string;
  params?: Record<string, string | number>;
  /** AI に返す説明 (日本語)。 */
  message: string;
}

export interface RunResult {
  /** 最後まで実行できた操作の数。 */
  doneOps: number;
  /** 成功した Command の数。 */
  doneCommands: number;
  failure?: OpFailure;
}

class Unresolved extends Error {
  constructor(msg: string) {
    super(msg);
  }
}
class EngineFail extends Error {
  constructor(
    readonly code: string,
    readonly params?: Record<string, string | number>,
  ) {
    super(code);
  }
}

interface Env {
  exec: Exec;
  getDoc: () => GanttDocument;
  temps: Map<string, string>; // 仮 ID(小文字) -> 実 ID
  count: { n: number };
}

const taskById = (doc: GanttDocument, id: string): Task | undefined => doc.tasks.find((t) => idKey(t.id) === idKey(id));

function resolveTask(env: Env, ref: string): string {
  const mapped = env.temps.get(idKey(ref));
  if (mapped !== undefined) return mapped;
  const t = taskById(env.getDoc(), ref);
  if (!t) throw new Unresolved(`タスク ID が見つかりません: ${ref}`);
  return t.id;
}
function resolveResource(env: Env, ref: string): string {
  const mapped = env.temps.get(idKey(ref));
  if (mapped !== undefined) return mapped;
  const r = (env.getDoc().resources ?? []).find((x) => idKey(x.id) === idKey(ref));
  if (!r) throw new Unresolved(`リソース ID が見つかりません: ${ref}`);
  return r.id;
}
function resolveLabel(env: Env, ref: string): string {
  const mapped = env.temps.get(idKey(ref));
  if (mapped !== undefined) return mapped;
  const c = (env.getDoc().colorLabels ?? []).find((x) => idKey(x.id) === idKey(ref));
  if (!c) throw new Unresolved(`色ラベル ID が見つかりません: ${ref}`);
  return c.id;
}

function run(env: Env, cmd: Command): ExecResult & { ok: true } {
  const r = env.exec(cmd);
  if (!r.ok) throw new EngineFail(r.code, r.params);
  env.count.n++;
  return r;
}

/** addTask / addCategory 共通: parentId / afterId から、挿入の基準になる afterId と、作成後にインデントが要るかを決める。 */
function resolvePosition(
  env: Env,
  op: { parentId?: string; afterId?: string },
  parentMustBeCategory: boolean,
): { afterId: string | null; needIndent: boolean } {
  const ix = buildTreeIndex(env.getDoc());
  let afterId: string | null = null;
  let needIndent = false;
  const parent = op.parentId !== undefined ? resolveTask(env, op.parentId) : undefined;
  if (parent !== undefined && parentMustBeCategory && ix.byId.get(idKey(parent))?.kind !== "category") {
    throw new Unresolved(`カテゴリの parentId にはカテゴリを指定してください: ${op.parentId}`);
  }
  if (op.afterId !== undefined) {
    afterId = resolveTask(env, op.afterId);
    if (!parentMustBeCategory && parent !== undefined && ix.byId.get(idKey(afterId))?.kind === "category") {
      throw new Unresolved(`afterId (${op.afterId}) がカテゴリのときは、そのカテゴリの子の末尾に入ります。兄弟として並べたいときは parentId だけを指定してください`);
    }
    if (parent !== undefined) {
      const actual = ix.byId.get(idKey(afterId))?.parentId ?? null;
      if (actual === null || idKey(actual) !== idKey(parent)) {
        throw new Unresolved(`afterId (${op.afterId}) は parentId (${op.parentId}) の直下の子ではありません`);
      }
    }
  } else if (parent !== undefined) {
    const children = getChildren(ix, parent);
    if (!parentMustBeCategory && ix.byId.get(idKey(parent))?.kind === "category") {
      // addTask の afterId がカテゴリなら、そのカテゴリの子の末尾に入る (最後の子がカテゴリでも同じ)。
      afterId = parent;
    } else if (children.length > 0) afterId = children[children.length - 1]!;
    else {
      afterId = parent;
      // addTask の afterId がカテゴリなら、そのカテゴリの子の末尾に入るのでインデント不要。
      needIndent = parentMustBeCategory || ix.byId.get(idKey(parent))?.kind !== "category";
    }
  }
  return { afterId, needIndent };
}

function runOp(env: Env, op: AiOp): void {
  switch (op.op) {
    case "addCategory": {
      if (env.temps.has(idKey(op.tempId))) throw new Unresolved(`tempId が重複しています: ${op.tempId}`);
      const { afterId, needIndent } = resolvePosition(env, op, true);
      const created = run(env, { type: "addCategory", afterId }).createdId;
      if (created === undefined) throw new Unresolved("カテゴリを作成できませんでした");
      env.temps.set(idKey(op.tempId), created);
      if (needIndent) run(env, { type: "indent", id: created });
      run(env, { type: "setName", id: created, name: op.name });
      return;
    }
    case "addTask": {
      if (env.temps.has(idKey(op.tempId))) throw new Unresolved(`tempId が重複しています: ${op.tempId}`);
      const { afterId, needIndent } = resolvePosition(env, op, false);
      const created = run(env, { type: "addTask", afterId }).createdId;
      if (created === undefined) throw new Unresolved("タスクを作成できませんでした");
      env.temps.set(idKey(op.tempId), created);
      if (needIndent) run(env, { type: "indent", id: created });
      run(env, { type: "setName", id: created, name: op.name });
      if (op.start !== undefined || op.end !== undefined) {
        const t = taskById(env.getDoc(), created)!;
        run(env, { type: "setDates", id: created, start: (op.start ?? op.end ?? t.start)!, end: (op.end ?? op.start ?? t.end)! });
      }
      if (op.hours !== undefined) run(env, { type: "setHours", id: created, hours: op.hours });
      if (op.notes !== undefined) run(env, { type: "setNotes", id: created, notes: op.notes });
      if (op.resourceIds !== undefined) {
        run(env, { type: "setResources", id: created, resourceIds: op.resourceIds.map((r) => resolveResource(env, r)) });
      }
      if (op.colorLabelId !== undefined) run(env, { type: "setColorLabel", id: created, colorLabelId: resolveLabel(env, op.colorLabelId) });
      for (const d of op.dependsOn ?? []) {
        run(env, { type: "addDependency", succId: created, predId: resolveTask(env, d.id) });
      }
      return;
    }
    case "addMilestone": {
      if (env.temps.has(idKey(op.tempId))) throw new Unresolved(`tempId が重複しています: ${op.tempId}`);
      const { afterId } = resolvePosition(env, op, false);
      const ix = buildTreeIndex(env.getDoc());
      if (op.parentId !== undefined && ix.byId.get(idKey(resolveTask(env, op.parentId)))?.kind !== "category") {
        throw new Unresolved(`マイルストーンの parentId にはカテゴリを指定してください: ${op.parentId}`);
      }
      const created = run(env, { type: "addMilestone", afterId }).createdId;
      if (created === undefined) throw new Unresolved("マイルストーンを作成できませんでした");
      env.temps.set(idKey(op.tempId), created);
      run(env, { type: "setName", id: created, name: op.name });
      run(env, { type: "setDates", id: created, start: op.date, end: op.date });
      if (op.notes !== undefined) run(env, { type: "setNotes", id: created, notes: op.notes });
      if (op.colorLabelId !== undefined) run(env, { type: "setColorLabel", id: created, colorLabelId: resolveLabel(env, op.colorLabelId) });
      return;
    }
    case "updateTask": {
      const id = resolveTask(env, op.id);
      const kind = taskById(env.getDoc(), id)?.kind;
      if (
        kind === "category" &&
        (op.start !== undefined || op.end !== undefined || op.durationDays !== undefined || op.hours !== undefined || op.resourceIds !== undefined || op.status !== undefined || op.date !== undefined)
      ) {
        // カテゴリは名前・メモ・色ラベルだけ。
        throw new EngineFail("CATEGORY_NOT_EDITABLE", { id });
      }
      if (kind === "milestone") {
        // マイルストーンは名前・日付 (date)・詳細・色ラベルだけ。
        if (op.start !== undefined || op.end !== undefined || op.durationDays !== undefined || op.hours !== undefined || op.resourceIds !== undefined || op.status !== undefined) {
          throw new EngineFail("MILESTONE_NOT_EDITABLE", { id });
        }
        if (op.name !== undefined) run(env, { type: "setName", id, name: op.name });
        if (op.date !== undefined) run(env, { type: "setDates", id, start: op.date, end: op.date });
        if (op.notes !== undefined) run(env, { type: "setNotes", id, notes: op.notes });
        if (op.colorLabelId !== undefined) {
          run(env, { type: "setColorLabel", id, colorLabelId: op.colorLabelId === null ? null : resolveLabel(env, op.colorLabelId) });
        }
        return;
      }
      if (op.name !== undefined) run(env, { type: "setName", id, name: op.name });
      if (op.start !== undefined || op.end !== undefined) {
        const t = taskById(env.getDoc(), id)!;
        const start = op.start ?? t.start;
        const end = op.end ?? t.end;
        // 親タスク (日付が子から導出される) で片方だけ指定された場合は、そのまま engine に拒否させる。
        if (start === undefined || end === undefined) throw new EngineFail("PARENT_NOT_EDITABLE", { id });
        run(env, { type: "setDates", id, start, end });
      }
      if (op.durationDays !== undefined) run(env, { type: "setDuration", id, days: op.durationDays });
      if (op.status !== undefined) run(env, { type: "setStatus", id, status: op.status });
      if (op.date !== undefined) throw new EngineFail("INVALID_VALUE", { field: "date" }); // マイルストーン以外に date は使えない
      if (op.hours !== undefined) run(env, { type: "setHours", id, hours: op.hours });
      if (op.notes !== undefined) run(env, { type: "setNotes", id, notes: op.notes });
      if (op.resourceIds !== undefined) run(env, { type: "setResources", id, resourceIds: op.resourceIds.map((r) => resolveResource(env, r)) });
      if (op.colorLabelId !== undefined) {
        run(env, { type: "setColorLabel", id, colorLabelId: op.colorLabelId === null ? null : resolveLabel(env, op.colorLabelId) });
      }
      return;
    }
    case "setCategory":
      run(env, { type: "setCategory", id: resolveTask(env, op.id), categoryId: op.categoryId === null ? null : resolveTask(env, op.categoryId) });
      return;
    case "shiftTask":
      run(env, { type: "moveTask", id: resolveTask(env, op.id), deltaDays: op.deltaDays });
      return;
    case "deleteTask":
      run(env, { type: "deleteTask", id: resolveTask(env, op.id) });
      return;
    case "arrangeTask": {
      const id = resolveTask(env, op.id);
      const type = op.action === "indent" ? "indent" : op.action === "outdent" ? "outdent" : op.action === "up" ? "moveUp" : "moveDown";
      run(env, { type, id });
      return;
    }
    case "addDependency":
      run(env, {
        type: "addDependency",
        succId: resolveTask(env, op.taskId),
        predId: resolveTask(env, op.predecessorId),
      });
      return;
    case "removeDependency":
      run(env, { type: "removeDependency", succId: resolveTask(env, op.taskId), predId: resolveTask(env, op.predecessorId) });
      return;
    case "setCalendar":
      run(env, { type: "setCalendar", calendar: { weekends: op.weekends as never, holidays: op.holidays } });
      return;
    case "clearCalendar":
      run(env, { type: "setCalendar", calendar: null });
      return;
    case "setProjectInfo":
      run(env, { type: "setProjectInfo", ...(op.name !== undefined ? { name: op.name } : {}), ...(op.description !== undefined ? { description: op.description } : {}) });
      return;
    case "addResource": {
      if (env.temps.has(idKey(op.tempId))) throw new Unresolved(`tempId が重複しています: ${op.tempId}`);
      const r = run(env, { type: "addResource", name: op.name, ...(op.color !== undefined ? { color: op.color } : {}) });
      if (r.createdId === undefined) throw new Unresolved("リソースを作成できませんでした");
      env.temps.set(idKey(op.tempId), r.createdId);
      return;
    }
    case "updateResource":
      run(env, {
        type: "updateResource",
        id: resolveResource(env, op.id),
        ...(op.name !== undefined ? { name: op.name } : {}),
        ...(op.color !== undefined ? { color: op.color } : {}),
      });
      return;
    case "deleteResource":
      run(env, { type: "deleteResource", id: resolveResource(env, op.id) });
      return;
    case "addColorLabel": {
      if (env.temps.has(idKey(op.tempId))) throw new Unresolved(`tempId が重複しています: ${op.tempId}`);
      const r = run(env, { type: "addColorLabel", name: op.name, color: op.color });
      if (r.createdId === undefined) throw new Unresolved("色ラベルを作成できませんでした");
      env.temps.set(idKey(op.tempId), r.createdId);
      return;
    }
    case "updateColorLabel":
      run(env, {
        type: "updateColorLabel",
        id: resolveLabel(env, op.id),
        ...(op.name !== undefined ? { name: op.name } : {}),
        ...(op.color !== undefined ? { color: op.color } : {}),
      });
      return;
    case "deleteColorLabel":
      run(env, { type: "deleteColorLabel", id: resolveLabel(env, op.id) });
      return;
  }
}

/** 操作を順に実行する。最初に失敗した操作で止まり、その内容を返す。 */
export function runOps(ops: AiOp[], exec: Exec, getDoc: () => GanttDocument): RunResult {
  const env: Env = { exec, getDoc, temps: new Map(), count: { n: 0 } };
  let done = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    try {
      runOp(env, op);
      done++;
    } catch (e) {
      if (e instanceof Unresolved) {
        return { doneOps: done, doneCommands: env.count.n, failure: { index: i, op, code: "UNRESOLVED", message: e.message } };
      }
      if (e instanceof EngineFail) {
        return {
          doneOps: done,
          doneCommands: env.count.n,
          failure: { index: i, op, code: e.code, ...(e.params ? { params: e.params } : {}), message: `engine が拒否しました (${e.code}${e.params ? " " + JSON.stringify(e.params) : ""})` },
        };
      }
      throw e;
    }
  }
  return { doneOps: done, doneCommands: env.count.n };
}
