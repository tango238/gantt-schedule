import { current, enablePatches, produceWithPatches, type Patch } from "immer";
import { addDays, isValidIsoDate } from "../model/date";
import { idKey } from "../model/id";
import type { Calendar, ColorLabel, GanttDocument, IsoDate, Resource, Task, TaskStatus } from "../model/types";
import {
  addWorkingDays,
  compileCalendar,
  durationOf,
  nextWorkingDay,
  prevWorkingDay,
  workingDayOffset,
  type WorkCalendar,
} from "./calendar";
import { deepEqual } from "./equal";
import { statusOf } from "./status";
import {
  CalendarError,
  CommandRejected,
  SchedulingError,
  type EngineErrorCode,
  type ErrorParams,
} from "./errors";
import {
  buildTreeIndex,
  deleteTasks,
  effectiveStart,
  getAncestors,
  getDescendants,
  getLeafDescendantsOrSelf,
  getSubtreeRange,
  indent,
  isCategoryId,
  isCategoryTask,
  isMilestoneTask,
  isParent,
  normalizeTopLevel,
  moveDown,
  moveUp,
  outdent,
  visibleRows,
  type TreeIndex,
} from "./hierarchy";
import {
  canAddDependency,
  earliestFrom,
  earliestStartFor,
  pushIfViolated,
  rescheduleAll,
  schedule,
  shiftLeafTo,
  validateStructure,
} from "./scheduling";

enablePatches();

export interface CommandContext {
  today: IsoDate;
  newId: () => string;
  defaultTaskName: string;
  defaultCategoryName: string;
  defaultMilestoneName: string;
}

export type Command =
  | { type: "moveTask"; id: string; deltaDays: number }
  | { type: "resizeTaskEnd"; id: string; newEnd: IsoDate }
  | { type: "resizeTaskStart"; id: string; newStart: IsoDate }
  | { type: "setDates"; id: string; start: IsoDate; end: IsoDate }
  | { type: "setDuration"; id: string; days: number }
  /** 状態 (未着手 / 進行中 / 完了)。リーフタスクのみ (親タスク・カテゴリ・マイルストーンは不可)。todo は項目を消す。 */
  | { type: "setStatus"; id: string; status: TaskStatus }
  | { type: "setHours"; id: string; hours: number | null }
  | { type: "setName"; id: string; name: string }
  | { type: "setNotes"; id: string; notes: string }
  | { type: "addTask"; afterId: string | null }
  | { type: "addCategory"; afterId: string | null }
  /** マイルストーン (日付 1 つ)。位置は addCategory と同じ規則 (カテゴリを選んでいればその子の末尾)。既定の日付は context.today。 */
  | { type: "addMilestone"; afterId: string | null }
  | { type: "duplicateTask"; id: string }
  | { type: "deleteTask"; id: string }
  | { type: "indent"; id: string }
  | { type: "outdent"; id: string }
  | { type: "moveUp"; id: string }
  | { type: "moveDown"; id: string }
  | { type: "setResources"; id: string; resourceIds: string[] }
  /** 担当ユーザーを置き換える (最大 MAX_ASSIGNEES 人、重複は除く)。ユーザーの実在確認はサーバー (Durable Object) が行う。 */
  /** トップレベル/カテゴリ直下のタスクを、サブツリーごと指定カテゴリの子の末尾 (null = トップレベルの末尾) へ移す。 */
  | { type: "setCategory"; id: string; categoryId: string | null }
  | { type: "setAssignees"; id: string; userIds: string[] }
  | { type: "setColorLabel"; id: string; colorLabelId: string | null }
  | { type: "addDependency"; succId: string; predId: string }
  | { type: "removeDependency"; succId: string; predId: string }
  | { type: "rescheduleAll" }
  | { type: "setProjectInfo"; name?: string; description?: string }
  | { type: "setCalendar"; calendar: Calendar | null }
  | { type: "addResource"; name: string; color?: string }
  | { type: "updateResource"; id: string; name?: string; color?: string | null }
  | { type: "deleteResource"; id: string }
  | { type: "addColorLabel"; name: string; color: string }
  | { type: "updateColorLabel"; id: string; name?: string; color?: string }
  | { type: "deleteColorLabel"; id: string }
  /** Replace everything except `view` with `doc` (already validated by loadDocument). Does not reschedule. */
  | { type: "replaceDocument"; doc: GanttDocument };

export interface CommandOk {
  ok: true;
  doc: GanttDocument;
  patches: Patch[];
  inversePatches: Patch[];
  selection?: string | null;
  editName?: boolean;
  reveal?: string[];
  createdId?: string;
}

export interface CommandErr {
  ok: false;
  code: EngineErrorCode;
  params?: ErrorParams;
}

/** Side information a recipe hands back besides the document change. */
interface Outcome {
  selection?: string | null;
  editName?: boolean;
  reveal?: string[];
  createdId?: string;
}

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const isHexColor = (v: unknown): v is string => typeof v === "string" && HEX_COLOR.test(v);

/** Upper bound (absolute value, in days) for deltaDays / duration inputs. */
export const MAX_DAYS = 36600;
/** 1 タスクの担当者の上限。 */
export const MAX_ASSIGNEES = 20;
/** project.name: 1..PROJECT_NAME_MAX characters after trim. */
export const PROJECT_NAME_MAX = 200;
const isDayCount = (v: unknown): v is number => Number.isInteger(v) && Math.abs(v as number) <= MAX_DAYS;

function invalid(field: string): CommandRejected {
  return new CommandRejected("INVALID_VALUE", { field });
}

function requireLeaf(ix: TreeIndex, id: string): Task {
  const t = ix.byId.get(idKey(id));
  if (!t) throw new CommandRejected("TASK_NOT_FOUND", { id });
  if (isCategoryTask(t)) throw new CommandRejected("CATEGORY_NOT_EDITABLE", { id });
  if (isMilestoneTask(t)) throw new CommandRejected("MILESTONE_NOT_EDITABLE", { id });
  if (isParent(ix, id)) throw new CommandRejected("PARENT_NOT_EDITABLE", { id });
  return t;
}

/** 日付・担当者・依存などを持てる (カテゴリでもマイルストーンでもない) タスク。 */
function requireNonCategory(ix: TreeIndex, id: string): Task {
  const t = requireTask(ix, id);
  if (isCategoryTask(t)) throw new CommandRejected("CATEGORY_NOT_EDITABLE", { id });
  if (isMilestoneTask(t)) throw new CommandRejected("MILESTONE_NOT_EDITABLE", { id });
  return t;
}

function requireTask(ix: TreeIndex, id: string): Task {
  const t = ix.byId.get(idKey(id));
  if (!t) throw new CommandRejected("TASK_NOT_FOUND", { id });
  return t;
}

function requireDate(value: unknown, field: string): IsoDate {
  if (typeof value !== "string" || !isValidIsoDate(value)) throw invalid(field);
  return value;
}

function snapMove(start: IsoDate, delta: number, wc: WorkCalendar): IsoDate {
  const t = addDays(start, delta);
  return delta > 0 ? nextWorkingDay(t, wc) : prevWorkingDay(t, wc);
}

const structureOk = (d: GanttDocument): boolean => validateStructure(d).length === 0;

function applyCommand(draft: GanttDocument, cmd: Command, ctx: CommandContext, out: Outcome): void {
  const wc = compileCalendar(draft.project.calendar);

  switch (cmd.type) {
    case "moveTask": {
      const ix = buildTreeIndex(draft);
      const mt = requireTask(ix, cmd.id);
      if (isMilestoneTask(mt)) {
        // マイルストーンの日付は固定で、稼働日に補正せず暦日でそのまま動かす (他のタスクには影響しない)。
        if (!isDayCount(cmd.deltaDays)) throw invalid("deltaDays");
        if (cmd.deltaDays !== 0) mt.start = mt.end = addDays(mt.start!, cmd.deltaDays);
        return;
      }
      requireNonCategory(ix, cmd.id);
      if (!isDayCount(cmd.deltaDays)) throw invalid("deltaDays");
      const delta = cmd.deltaDays;
      if (delta === 0) return;
      const moved: string[] = [];
      if (!isParent(ix, cmd.id)) {
        const leaf = ix.byId.get(idKey(cmd.id))!;
        const d = Math.max(1, durationOf(leaf.start!, leaf.end!, wc));
        const s = snapMove(leaf.start!, delta, wc);
        leaf.start = s;
        leaf.end = addWorkingDays(s, d - 1, wc);
        moved.push(cmd.id);
      } else {
        const start = effectiveStart(ix, cmd.id);
        const ps = nextWorkingDay(start, wc);
        let target = snapMove(start, delta, wc);
        const es = earliestStartFor(draft, ix, wc, cmd.id);
        if (es !== null && target < es) target = nextWorkingDay(es, wc);
        const k = workingDayOffset(ps, target, wc);
        for (const l of getLeafDescendantsOrSelf(ix, cmd.id)) {
          const leaf = ix.byId.get(idKey(l))!;
          shiftLeafTo(leaf, addWorkingDays(nextWorkingDay(leaf.start!, wc), k, wc), wc);
          moved.push(l);
        }
      }
      schedule(draft, wc, moved, { clampSeeds: true });
      return;
    }

    case "resizeTaskEnd": {
      const ix = buildTreeIndex(draft);
      const t = requireLeaf(ix, cmd.id);
      const newEnd = requireDate(cmd.newEnd, "newEnd");
      let e = prevWorkingDay(newEnd, wc);
      if (e < t.start!) e = t.start!;
      t.end = e;
      schedule(draft, wc, [cmd.id], { clampSeeds: false });
      return;
    }

    case "resizeTaskStart": {
      const ix = buildTreeIndex(draft);
      const t = requireLeaf(ix, cmd.id);
      const newStart = requireDate(cmd.newStart, "newStart");
      let s = nextWorkingDay(newStart, wc);
      const es = earliestStartFor(draft, ix, wc, cmd.id);
      if (es !== null && s < es) s = es;
      if (s > t.end!) t.end = s;
      t.start = s;
      schedule(draft, wc, [cmd.id], { clampSeeds: false });
      return;
    }

    case "setDates": {
      const ix = buildTreeIndex(draft);
      const mt = requireTask(ix, cmd.id);
      if (isMilestoneTask(mt)) {
        // マイルストーンの日付は 1 つ: start と end は同じ値でなければならない。
        const d = requireDate(cmd.start, "start");
        if (requireDate(cmd.end, "end") !== d) throw invalid("end");
        if (mt.start !== d || mt.end !== d) mt.start = mt.end = d;
        return;
      }
      const t = requireLeaf(ix, cmd.id);
      const start = requireDate(cmd.start, "start");
      const end = requireDate(cmd.end, "end");
      if (start > end) throw new CommandRejected("START_AFTER_END", { id: cmd.id });
      t.start = start;
      t.end = end;
      schedule(draft, wc, [cmd.id], { clampSeeds: true });
      return;
    }

    case "setDuration": {
      const ix = buildTreeIndex(draft);
      const t = requireLeaf(ix, cmd.id);
      if (!isDayCount(cmd.days) || cmd.days < 1) throw invalid("days");
      const working = nextWorkingDay(t.start!, wc) === t.start;
      t.end = addWorkingDays(t.start!, working ? cmd.days - 1 : cmd.days, wc);
      schedule(draft, wc, [cmd.id], { clampSeeds: false });
      return;
    }

    case "setStatus": {
      const t = requireLeaf(buildTreeIndex(draft), cmd.id);
      if (cmd.status !== "todo" && cmd.status !== "doing" && cmd.status !== "done") throw invalid("status");
      if (statusOf(t) === cmd.status) return; // 変更なし (パッチを作らない)
      if (cmd.status === "todo") delete t.status;
      else t.status = cmd.status;
      return;
    }

    case "setHours": {
      const t = requireLeaf(buildTreeIndex(draft), cmd.id);
      if (cmd.hours === null) {
        delete t.hours;
      } else {
        if (!Number.isFinite(cmd.hours) || cmd.hours < 0) throw invalid("hours");
        t.hours = cmd.hours;
      }
      return;
    }

    case "setName": {
      const t = requireTask(buildTreeIndex(draft), cmd.id);
      if (typeof cmd.name !== "string") throw invalid("name");
      t.name = cmd.name;
      return;
    }

    case "setNotes": {
      const t = requireTask(buildTreeIndex(draft), cmd.id);
      if (typeof cmd.notes !== "string") throw invalid("notes");
      if (cmd.notes === "") delete t.notes;
      else t.notes = cmd.notes;
      return;
    }

    case "addTask": {
      const ix = buildTreeIndex(draft);
      let parentId: string | null = null;
      let start: IsoDate;
      let end: IsoDate;
      let insertAt = draft.tasks.length;
      let resourceIds: string[] = [];
      if (cmd.afterId !== null) {
        const after = requireTask(ix, cmd.afterId);
        // カテゴリを指定したときは、兄弟ではなくそのカテゴリの子の末尾に入れる。
        parentId = isCategoryTask(after) ? after.id : (after.parentId ?? null);
        insertAt = getSubtreeRange(draft, ix, cmd.afterId)[1];
        if (isCategoryTask(after)) {
          start = end = nextWorkingDay(ctx.today, wc);
        } else if (isParent(ix, cmd.afterId)) {
          start = end = effectiveStart(ix, cmd.afterId);
        } else {
          start = after.start!;
          end = after.end!;
        }
        if (parentId !== null) resourceIds = [...(requireTask(ix, parentId).resourceIds ?? [])];
      } else {
        start = end = nextWorkingDay(ctx.today, wc);
      }
      const newId = ctx.newId();
      if (ix.byId.has(idKey(newId))) throw new CommandRejected("INVALID_VALUE", { field: "newId" });
      const created: Task = {
        id: newId,
        parentId,
        name: ctx.defaultTaskName,
        start,
        end,
        resourceIds,
        dependencies: [],
      };
      draft.tasks.splice(insertAt, 0, created);
      schedule(draft, wc, [newId], { clampSeeds: true });
      out.selection = newId;
      out.editName = true;
      out.reveal = [newId];
      out.createdId = newId;
      return;
    }

    case "addCategory": {
      const ix = buildTreeIndex(draft);
      let parentId: string | null = null;
      let insertAt = draft.tasks.length;
      if (cmd.afterId !== null) {
        requireTask(ix, cmd.afterId);
        // タスク階層の中なら、そのタスクが属する最も近いカテゴリ階層 (またはトップレベル) まで遡る。
        let cur = cmd.afterId;
        if (!isCategoryId(ix, cur)) {
          for (;;) {
            const p = ix.parentOf.get(idKey(cur)) ?? null;
            if (p === null || isCategoryId(ix, p)) break;
            cur = p;
          }
        }
        parentId = ix.parentOf.get(idKey(cur)) ?? null;
        insertAt = getSubtreeRange(draft, ix, cur)[1];
      }
      const newId = ctx.newId();
      if (ix.byId.has(idKey(newId))) throw new CommandRejected("INVALID_VALUE", { field: "newId" });
      const created: Task = {
        id: newId,
        kind: "category",
        parentId,
        name: ctx.defaultCategoryName,
        resourceIds: [],
        dependencies: [],
      };
      draft.tasks.splice(insertAt, 0, created);
      out.selection = newId;
      out.editName = true;
      out.reveal = [newId];
      out.createdId = newId;
      return;
    }

    case "addMilestone": {
      const ix = buildTreeIndex(draft);
      let parentId: string | null = null;
      let insertAt = draft.tasks.length;
      if (cmd.afterId !== null) {
        requireTask(ix, cmd.afterId);
        if (isCategoryId(ix, cmd.afterId)) {
          // カテゴリを選んでいればその子の末尾。
          parentId = cmd.afterId;
          insertAt = getSubtreeRange(draft, ix, cmd.afterId)[1];
          parentId = ix.byId.get(idKey(cmd.afterId))!.id;
        } else {
          // タスク階層の中なら、addCategory と同じく最も近いカテゴリ階層 (またはトップレベル) まで遡り、そのタスクのサブツリーの後ろ。
          let cur = cmd.afterId;
          for (;;) {
            const p = ix.parentOf.get(idKey(cur)) ?? null;
            if (p === null || isCategoryId(ix, p)) break;
            cur = p;
          }
          parentId = ix.parentOf.get(idKey(cur)) ?? null;
          insertAt = getSubtreeRange(draft, ix, cur)[1];
        }
      }
      const newId = ctx.newId();
      if (ix.byId.has(idKey(newId))) throw new CommandRejected("INVALID_VALUE", { field: "newId" });
      const created: Task = {
        id: newId,
        kind: "milestone",
        parentId,
        name: ctx.defaultMilestoneName,
        start: ctx.today,
        end: ctx.today,
        resourceIds: [],
        dependencies: [],
      };
      draft.tasks.splice(insertAt, 0, created);
      out.selection = newId;
      out.editName = true;
      out.reveal = [newId];
      out.createdId = newId;
      return;
    }

    case "duplicateTask": {
      const ix = buildTreeIndex(draft);
      requireTask(ix, cmd.id);
      const [s, e] = getSubtreeRange(draft, ix, cmd.id);
      const sources = draft.tasks.slice(s, e).map((t) => current(t) as Task);
      const idMap = new Map<string, string>();
      for (const t of sources) idMap.set(idKey(t.id), ctx.newId());
      const rootKey = idKey(cmd.id);
      const clones: Task[] = sources.map((t) => {
        const c = structuredClone(t);
        delete c.status; // 複製は未着手に戻す
        c.id = idMap.get(idKey(t.id))!;
        if (idKey(t.id) !== rootKey) {
          c.parentId = idMap.get(idKey(t.parentId!)) ?? t.parentId ?? null;
        }
        if (c.dependencies) {
          for (const dep of c.dependencies) {
            const mapped = idMap.get(idKey(dep.predecessorId));
            if (mapped !== undefined) dep.predecessorId = mapped;
          }
        }
        return c;
      });
      draft.tasks.splice(e, 0, ...clones);
      const ix2 = buildTreeIndex(draft);
      const rootCopy = idMap.get(rootKey)!;
      schedule(draft, wc, getLeafDescendantsOrSelf(ix2, rootCopy), { clampSeeds: true });
      out.selection = rootCopy;
      return;
    }

    case "deleteTask": {
      const ix = buildTreeIndex(draft);
      requireTask(ix, cmd.id);
      const collapsed = new Set(draft.view?.collapsedTaskIds ?? []);
      const rows = visibleRows(ix, collapsed);
      let pos = rows.findIndex((r) => idKey(r) === idKey(cmd.id));
      if (pos < 0) {
        // Hidden under a collapsed ancestor: use the nearest visible ancestor as the reference row.
        for (const a of getAncestors(ix, cmd.id)) {
          pos = rows.findIndex((r) => idKey(r) === idKey(a));
          if (pos >= 0) break;
        }
      }
      const removed = new Set<string>([idKey(cmd.id), ...getDescendants(ix, cmd.id).map(idKey)]);
      let next: string | null = null;
      for (let i = pos + 1; i < rows.length; i++) {
        if (!removed.has(idKey(rows[i]!))) {
          next = rows[i]!;
          break;
        }
      }
      if (next === null && pos > 0) next = rows[pos - 1]!;
      deleteTasks(draft, [cmd.id], wc);
      out.selection = next;
      return;
    }

    case "indent": {
      indent(draft, cmd.id, structureOk);
      const ix = buildTreeIndex(draft);
      schedule(draft, wc, getLeafDescendantsOrSelf(ix, cmd.id), { clampSeeds: true });
      out.reveal = [cmd.id];
      return;
    }

    case "outdent": {
      const becameLeaf = outdent(draft, cmd.id, wc, structureOk);
      const ix = buildTreeIndex(draft);
      const seeds = getLeafDescendantsOrSelf(ix, cmd.id);
      if (becameLeaf !== null) seeds.push(becameLeaf);
      schedule(draft, wc, seeds, { clampSeeds: true });
      return;
    }

    case "moveUp":
      moveUp(draft, cmd.id);
      return;

    case "moveDown":
      moveDown(draft, cmd.id);
      return;

    case "setResources": {
      const ix = buildTreeIndex(draft);
      const t = requireNonCategory(ix, cmd.id);
      if (!Array.isArray(cmd.resourceIds)) throw invalid("resourceIds");
      const known = new Set((draft.resources ?? []).map((r) => idKey(r.id)));
      const seen = new Set<string>();
      const ids: string[] = [];
      for (const r of cmd.resourceIds) {
        if (!known.has(idKey(r))) throw invalid("resourceIds");
        if (seen.has(idKey(r))) continue;
        seen.add(idKey(r));
        ids.push(r);
      }
      t.resourceIds = [...ids];
      for (const d of getDescendants(ix, cmd.id)) requireTask(ix, d).resourceIds = [...ids];
      return;
    }

    case "setCategory": {
      const ix = buildTreeIndex(draft);
      const t = requireTask(ix, cmd.id); // マイルストーンも移せる
      if (isCategoryTask(t)) throw new CommandRejected("CATEGORY_NOT_EDITABLE", { id: cmd.id });
      const parent = t.parentId ?? null;
      if (parent !== null && !isCategoryId(ix, parent)) throw new CommandRejected("SUBTASK_CATEGORY", { id: cmd.id });
      let target: string | null = null;
      if (cmd.categoryId !== null) {
        if (typeof cmd.categoryId !== "string") throw invalid("categoryId");
        const c = ix.byId.get(idKey(cmd.categoryId));
        if (!c) throw new CommandRejected("TASK_NOT_FOUND", { id: cmd.categoryId });
        if (!isCategoryTask(c)) throw invalid("categoryId");
        target = c.id;
      }
      const same = target === null ? parent === null : parent !== null && idKey(parent) === idKey(target);
      if (same) return;
      const [s, e] = getSubtreeRange(draft, ix, cmd.id);
      const block = draft.tasks.splice(s, e - s);
      block[0]!.parentId = target;
      const ix2 = buildTreeIndex(draft);
      const at = target === null ? draft.tasks.length : getSubtreeRange(draft, ix2, target)[1];
      draft.tasks.splice(at, 0, ...block);
      out.reveal = [cmd.id];
      return;
    }

    case "setAssignees": {
      const t = requireNonCategory(buildTreeIndex(draft), cmd.id);
      if (!Array.isArray(cmd.userIds)) throw invalid("userIds");
      // ユーザー ID は大文字小文字を区別する (idKey は使わない)。
      const ids: string[] = [];
      for (const u of cmd.userIds) {
        if (typeof u !== "string" || u === "" || u.length > 64) throw invalid("userIds");
        if (!ids.includes(u)) ids.push(u);
      }
      if (ids.length > MAX_ASSIGNEES) throw invalid("userIds");
      const cur = t.assigneeIds ?? [];
      if (cur.length === ids.length && cur.every((u, i) => u === ids[i])) return; // 変更なし (パッチを作らない)
      if (ids.length === 0) delete t.assigneeIds;
      else t.assigneeIds = ids;
      return;
    }

    case "setColorLabel": {
      const t = requireTask(buildTreeIndex(draft), cmd.id);
      if (cmd.colorLabelId === null) {
        delete t.colorLabelId;
      } else {
        if (!(draft.colorLabels ?? []).some((c) => idKey(c.id) === idKey(cmd.colorLabelId!))) {
          throw invalid("colorLabelId");
        }
        t.colorLabelId = cmd.colorLabelId;
      }
      return;
    }

    case "addDependency": {
      const check = canAddDependency(draft, cmd.succId, cmd.predId);
      if (!check.ok) throw new CommandRejected(check.code, { succId: cmd.succId, predId: cmd.predId });
      const ix = buildTreeIndex(draft);
      const succ = requireTask(ix, cmd.succId);
      const dep = { predecessorId: cmd.predId };
      if (!succ.dependencies) succ.dependencies = [];
      succ.dependencies.push(dep);
      const moved = pushIfViolated(ix, wc, cmd.succId, earliestFrom(ix, wc, cmd.predId));
      schedule(draft, wc, moved, { clampSeeds: false });
      return;
    }

    case "removeDependency": {
      const succ = requireNonCategory(buildTreeIndex(draft), cmd.succId);
      const i = (succ.dependencies ?? []).findIndex((d) => idKey(d.predecessorId) === idKey(cmd.predId));
      if (i < 0) throw new CommandRejected("DEPENDENCY_NOT_FOUND", { succId: cmd.succId, predId: cmd.predId });
      succ.dependencies!.splice(i, 1);
      return;
    }

    case "rescheduleAll":
      rescheduleAll(draft, wc);
      return;

    case "setProjectInfo": {
      if (cmd.name !== undefined) {
        if (typeof cmd.name !== "string" || cmd.name.trim() === "" || cmd.name.length > PROJECT_NAME_MAX) {
          throw invalid("name");
        }
        draft.project.name = cmd.name;
      }
      if (cmd.description !== undefined) {
        if (typeof cmd.description !== "string") throw invalid("description");
        if (cmd.description === "") delete draft.project.description;
        else draft.project.description = cmd.description;
      }
      return;
    }

    case "setCalendar": {
      if (cmd.calendar === null) {
        delete draft.project.calendar;
        return;
      }
      const { weekends, holidays } = cmd.calendar;
      if (
        !Array.isArray(weekends) ||
        weekends.length > 6 ||
        new Set(weekends).size !== weekends.length ||
        weekends.some((w) => !Number.isInteger(w) || w < 0 || w > 6)
      ) {
        throw invalid("weekends");
      }
      if (!Array.isArray(holidays) || holidays.some((h) => typeof h !== "string" || !isValidIsoDate(h))) {
        throw invalid("holidays");
      }
      const existing = draft.project.calendar ? (current(draft.project.calendar) as Calendar) : {};
      draft.project.calendar = {
        ...existing,
        ...cmd.calendar,
        weekends: [...weekends],
        holidays: [...new Set(holidays)].sort(),
      } as Calendar;
      return;
    }

    case "addResource": {
      if (typeof cmd.name !== "string") throw invalid("name");
      if (cmd.color !== undefined && !isHexColor(cmd.color)) throw invalid("color");
      const id = ctx.newId();
      const r: Resource = { id, name: cmd.name, ...(cmd.color !== undefined ? { color: cmd.color } : {}) };
      (draft.resources ??= []).push(r);
      out.createdId = id;
      return;
    }

    case "updateResource": {
      const r = (draft.resources ?? []).find((x) => idKey(x.id) === idKey(cmd.id));
      if (!r) throw invalid("id");
      if (cmd.name !== undefined) {
        if (typeof cmd.name !== "string") throw invalid("name");
        r.name = cmd.name;
      }
      if (cmd.color === null) delete r.color;
      else if (cmd.color !== undefined) {
        if (!isHexColor(cmd.color)) throw invalid("color");
        r.color = cmd.color;
      }
      return;
    }

    case "deleteResource": {
      const list = draft.resources ?? [];
      const i = list.findIndex((x) => idKey(x.id) === idKey(cmd.id));
      if (i < 0) throw invalid("id");
      list.splice(i, 1);
      for (const t of draft.tasks) {
        if (t.resourceIds?.some((r) => idKey(r) === idKey(cmd.id))) {
          t.resourceIds = t.resourceIds.filter((r) => idKey(r) !== idKey(cmd.id));
        }
      }
      return;
    }

    case "addColorLabel": {
      if (typeof cmd.name !== "string") throw invalid("name");
      if (!isHexColor(cmd.color)) throw invalid("color");
      const id = ctx.newId();
      const c: ColorLabel = { id, name: cmd.name, color: cmd.color };
      (draft.colorLabels ??= []).push(c);
      out.createdId = id;
      return;
    }

    case "updateColorLabel": {
      const c = (draft.colorLabels ?? []).find((x) => idKey(x.id) === idKey(cmd.id));
      if (!c) throw invalid("id");
      if (cmd.name !== undefined) {
        if (typeof cmd.name !== "string") throw invalid("name");
        c.name = cmd.name;
      }
      if (cmd.color !== undefined) {
        if (!isHexColor(cmd.color)) throw invalid("color");
        c.color = cmd.color;
      }
      return;
    }

    case "deleteColorLabel": {
      const list = draft.colorLabels ?? [];
      const i = list.findIndex((x) => idKey(x.id) === idKey(cmd.id));
      if (i < 0) throw invalid("id");
      list.splice(i, 1);
      for (const t of draft.tasks) {
        if (t.colorLabelId !== undefined && idKey(t.colorLabelId) === idKey(cmd.id)) delete t.colorLabelId;
      }
      return;
    }

    case "replaceDocument": {
      const before = current(draft) as unknown as Record<string, unknown>;
      const target = cmd.doc as unknown as Record<string, unknown>;
      const d = draft as unknown as Record<string, unknown>;
      for (const key of Object.keys(before)) {
        if (key !== "view" && !(key in target)) delete d[key];
      }
      for (const key of Object.keys(target)) {
        if (key === "view") continue;
        if (!(key in before) || !deepEqual(before[key], target[key])) d[key] = target[key];
      }
      const known = new Set((before.tasks as Task[]).map((t) => idKey(t.id)));
      const added = cmd.doc.tasks.filter((t) => !known.has(idKey(t.id))).map((t) => t.id);
      if (added.length > 0) out.reveal = added;
      return;
    }
  }
}

export function executeCommand(doc: GanttDocument, cmd: Command, ctx: CommandContext): CommandOk | CommandErr {
  const out: Outcome = {};
  try {
    const [next, patches, inversePatches] = produceWithPatches(doc, (draft) => {
      // トップレベルは常に「カテゴリ → カテゴリなしタスク」の順 (未正規化の doc は前後どちらでも正規化する)。
      normalizeTopLevel(draft as GanttDocument);
      applyCommand(draft as GanttDocument, cmd, ctx, out);
      normalizeTopLevel(draft as GanttDocument);
    });
    if (patches.length > 0) {
      // Date arithmetic must stay inside valid 4-digit-year dates (guards against runaway shifts / lags).
      for (const t of next.tasks) {
        if ((t.start !== undefined && !isValidIsoDate(t.start)) || (t.end !== undefined && !isValidIsoDate(t.end))) {
          return { ok: false, code: "INVALID_VALUE", params: { field: "date" } };
        }
      }
    }
    // No effective change: keep the original reference so memoized selectors stay valid.
    return { ok: true, doc: patches.length === 0 ? doc : next, patches, inversePatches, ...out };
  } catch (e) {
    if (e instanceof CommandRejected) {
      return e.params ? { ok: false, code: e.code, params: e.params } : { ok: false, code: e.code };
    }
    if (e instanceof SchedulingError) return { ok: false, code: e.code };
    if (e instanceof CalendarError) return { ok: false, code: e.code };
    if (e instanceof RangeError) return { ok: false, code: "INVALID_VALUE", params: { field: "date" } };
    throw e;
  }
}
