// 操作の dry run (現在の doc のコピーに対して executeCommand で試す) と、差分の計算。
import { buildTreeIndex, deepEqual, executeCommand, isCategoryId, nearestCategory, type CommandContext, type TreeIndex } from "../../shared/engine";
import { todayIso } from "../../shared/model/date";
import { idKey, newId } from "../../shared/model/id";
import type { GanttDocument, Task } from "../../shared/model/types";
import { t } from "../i18n";
import { runOps, type AiOp, type OpFailure, type RunResult } from "./ops";

export function withoutView(doc: GanttDocument): GanttDocument {
  const { view: _v, ...rest } = doc;
  return rest as GanttDocument;
}

export interface DryRunOptions {
  /** テスト用: ID 生成・今日の日付を差し替える。 */
  ctx?: Partial<CommandContext>;
}

export type DryRunResult =
  | { ok: true; before: GanttDocument; after: GanttDocument; diff: Diff; run: RunResult }
  | { ok: false; failure: OpFailure; run: RunResult };

/** doc のコピーに操作を順に試し適用する。実際のストアには触れない。 */
export function dryRun(doc: GanttDocument, ops: AiOp[], opts: DryRunOptions = {}): DryRunResult {
  const before = withoutView(doc);
  let cur = before;
  const ctx: CommandContext = {
    today: todayIso(),
    newId,
    defaultTaskName: t("task.defaultName"),
    defaultCategoryName: t("category.defaultName"),
    defaultMilestoneName: t("milestone.defaultName"),
    ...opts.ctx,
  };
  const run = runOps(
    ops,
    (cmd) => {
      const r = executeCommand(cur, cmd, ctx);
      if (r.ok) cur = r.doc;
      return r;
    },
    () => cur,
  );
  if (run.failure) return { ok: false, failure: run.failure, run };
  return { ok: true, before, after: cur, diff: computeDiff(before, cur), run };
}

// ---------------------------------------------------------------------------
// 差分
// ---------------------------------------------------------------------------

export interface FieldChange {
  label: string;
  before: string;
  after: string;
}
export interface TaskRef {
  id: string;
  name: string;
  /** カテゴリ (日付を持たない見出し行) */
  isCategory?: true;
  isMilestone?: true;
}
export interface AddedTask extends TaskRef {
  start?: string;
  end?: string;
  parentName?: string;
  hours?: number;
  notes?: string;
  resources?: string[];
  colorLabel?: string;
  /** 状態 (未着手以外のときだけ)。 */
  status?: string;
}
export interface ChangedTask extends TaskRef {
  changes: FieldChange[];
}
export interface DependencyChange {
  kind: "added" | "removed";
  succName: string;
  predName: string;
}
export interface NamedChange {
  kind: "added" | "changed" | "deleted";
  name: string;
  detail?: string;
}
export interface Diff {
  added: AddedTask[];
  changed: ChangedTask[];
  deleted: TaskRef[];
  reordered: boolean;
  dependencies: DependencyChange[];
  resources: NamedChange[];
  colorLabels: NamedChange[];
  project: FieldChange[];
  calendar: FieldChange[];
  /** 他の最上位項目 (未知のフィールド) が変わった。 */
  other: boolean;
  counts: { added: number; changed: number; deleted: number; other: number };
}

const none = (): string => t("ai.diff.none");
const fmt = (v: unknown): string => (v === undefined || v === null || v === "" ? none() : String(v));
const sameIds = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  deepEqual((a ?? []).map(idKey).sort(), (b ?? []).map(idKey).sort());

export function computeDiff(before: GanttDocument, after: GanttDocument): Diff {
  const bIx = buildTreeIndex(before);
  const aIx = buildTreeIndex(after);
  const bTasks = new Map(before.tasks.map((x) => [idKey(x.id), x] as const));
  const aTasks = new Map(after.tasks.map((x) => [idKey(x.id), x] as const));
  const nameOf = (m: Map<string, Task>, id: string | null | undefined) => (id ? (m.get(idKey(id))?.name ?? id) : none());
  const resName = (doc: GanttDocument, id: string) => (doc.resources ?? []).find((r) => idKey(r.id) === idKey(id))?.name ?? id;
  const labelName = (doc: GanttDocument, id: string | undefined) => (id ? ((doc.colorLabels ?? []).find((c) => idKey(c.id) === idKey(id))?.name ?? id) : none());

  const added: AddedTask[] = [];
  const changed: ChangedTask[] = [];
  const deleted: TaskRef[] = [];
  const dependencies: DependencyChange[] = [];

  for (const [k, a] of aTasks) {
    const b = bTasks.get(k);
    if (!b) {
      added.push({
        id: a.id,
        name: a.name,
        ...(a.kind === "category" ? { isCategory: true as const } : {}),
        ...(a.kind === "milestone" ? { isMilestone: true as const } : {}),
        ...(a.start !== undefined ? { start: a.start } : {}),
        ...(a.end !== undefined ? { end: a.end } : {}),
        ...(a.parentId ? { parentName: nameOf(aTasks, a.parentId) } : {}),
        ...(a.status && a.status !== "todo" ? { status: t(`status.label.${a.status}`) } : {}),
        ...(a.hours !== undefined ? { hours: a.hours } : {}),
        ...(a.notes ? { notes: a.notes } : {}),
        ...((a.resourceIds ?? []).length > 0 ? { resources: (a.resourceIds ?? []).map((r) => resName(after, r)) } : {}),
        ...(a.colorLabelId ? { colorLabel: labelName(after, a.colorLabelId) } : {}),
      });
      for (const d of a.dependencies ?? []) {
        dependencies.push({ kind: "added", succName: a.name, predName: nameOf(aTasks, d.predecessorId) });
      }
      continue;
    }
    const changes: FieldChange[] = [];
    const push = (label: string, bv: unknown, av: unknown) => {
      if (!deepEqual(bv ?? null, av ?? null)) changes.push({ label: t(`ai.field.${label}`), before: fmt(bv), after: fmt(av) });
    };
    push("name", b.name, a.name);
    if (a.kind === "milestone") push("date", b.start, a.start);
    else {
      push("start", b.start, a.start);
      push("end", b.end, a.end);
    }
    const sl = (s: Task["status"]) => t(`status.label.${s ?? "todo"}`);
    if ((b.status ?? "todo") !== (a.status ?? "todo")) changes.push({ label: t("ai.field.status"), before: sl(b.status), after: sl(a.status) });
    push("hours", b.hours, a.hours);
    push("notes", b.notes, a.notes);
    if ((b.parentId ?? null) !== (a.parentId ?? null) && idKey(b.parentId ?? "") !== idKey(a.parentId ?? "")) {
      // 親がタスクではない (最上位かカテゴリ直下) 同士の移動は「カテゴリの変更」として示す。
      const topOrCat = (ix: TreeIndex, p: string | null | undefined) => p == null || isCategoryId(ix, p);
      if (a.kind !== "category" && topOrCat(bIx, b.parentId) && topOrCat(aIx, a.parentId)) {
        const catName = (ix: TreeIndex, id: string) => {
          const c = nearestCategory(ix, id);
          return c === null ? t("category.none") : (ix.byId.get(idKey(c))?.name ?? c);
        };
        changes.push({ label: t("ai.field.category"), before: catName(bIx, b.id), after: catName(aIx, a.id) });
      } else {
        changes.push({ label: t("ai.field.parent"), before: nameOf(bTasks, b.parentId), after: nameOf(aTasks, a.parentId) });
      }
    }
    if (!sameIds(b.resourceIds, a.resourceIds)) {
      const list = (doc: GanttDocument, ids: string[] | undefined) => ((ids ?? []).length === 0 ? none() : (ids ?? []).map((i) => resName(doc, i)).join(", "));
      changes.push({ label: t("ai.field.resources"), before: list(before, b.resourceIds), after: list(after, a.resourceIds) });
    }
    if (idKey(b.colorLabelId ?? "") !== idKey(a.colorLabelId ?? "")) {
      changes.push({ label: t("ai.field.colorLabel"), before: labelName(before, b.colorLabelId), after: labelName(after, a.colorLabelId) });
    }
    if (changes.length > 0) changed.push({ id: a.id, name: a.name, ...(a.kind === "category" ? { isCategory: true as const } : {}), ...(a.kind === "milestone" ? { isMilestone: true as const } : {}), changes });

    // 依存関係
    const bDeps = new Map((b.dependencies ?? []).map((d) => [idKey(d.predecessorId), d] as const));
    const aDeps = new Map((a.dependencies ?? []).map((d) => [idKey(d.predecessorId), d] as const));
    for (const [pk, d] of aDeps) {
      const old = bDeps.get(pk);
      if (!old) {
        dependencies.push({ kind: "added", succName: a.name, predName: nameOf(aTasks, d.predecessorId) });
      }
    }
    for (const [pk, d] of bDeps) {
      if (!aDeps.has(pk)) dependencies.push({ kind: "removed", succName: a.name, predName: nameOf(bTasks, d.predecessorId) });
    }
  }
  for (const [k, b] of bTasks) {
    if (!aTasks.has(k)) deleted.push({ id: b.id, name: b.name, ...(b.kind === "category" ? { isCategory: true as const } : {}), ...(b.kind === "milestone" ? { isMilestone: true as const } : {}) });
  }

  const orderB = [...bTasks.keys()].filter((k) => aTasks.has(k));
  const orderA = [...aTasks.keys()].filter((k) => bTasks.has(k));
  const reordered = orderA.some((k, i) => k !== orderB[i]);

  const project: FieldChange[] = [];
  if (before.project.name !== after.project.name) project.push({ label: t("ai.field.projectName"), before: fmt(before.project.name), after: fmt(after.project.name) });
  if ((before.project.description ?? "") !== (after.project.description ?? "")) {
    project.push({ label: t("ai.field.description"), before: fmt(before.project.description), after: fmt(after.project.description) });
  }

  const calendar: FieldChange[] = [];
  const bc = before.project.calendar;
  const ac = after.project.calendar;
  if (!deepEqual(bc ?? null, ac ?? null)) {
    const wd = (c: typeof bc) => (c ? (c.weekends.length === 0 ? none() : c.weekends.map((d) => t(`weekday.${d}`)).join("")) : t("ai.diff.noCalendar"));
    if (!deepEqual(bc?.weekends ?? null, ac?.weekends ?? null)) calendar.push({ label: t("ai.field.weekends"), before: wd(bc), after: wd(ac) });
    const bh = new Set(bc?.holidays ?? []);
    const ah = new Set(ac?.holidays ?? []);
    const addedH = [...ah].filter((h) => !bh.has(h));
    const removedH = [...bh].filter((h) => !ah.has(h));
    if (addedH.length > 0 || removedH.length > 0) {
      calendar.push({
        label: t("ai.field.holidays"),
        before: removedH.length > 0 ? t("ai.diff.holidaysRemoved", { list: removedH.join(", ") }) : none(),
        after: addedH.length > 0 ? t("ai.diff.holidaysAdded", { list: addedH.join(", ") }) : none(),
      });
    }
    if (calendar.length === 0) calendar.push({ label: t("ai.field.calendar"), before: none(), after: t("ai.diff.calendarChanged") });
  }

  const named = <T extends { id: string; name: string; color?: string }>(b: T[] | undefined, a: T[] | undefined): NamedChange[] => {
    const out: NamedChange[] = [];
    const bm = new Map((b ?? []).map((x) => [idKey(x.id), x] as const));
    const am = new Map((a ?? []).map((x) => [idKey(x.id), x] as const));
    for (const [k, x] of am) {
      const old = bm.get(k);
      if (!old) out.push({ kind: "added", name: x.name, ...(x.color ? { detail: x.color } : {}) });
      else if (old.name !== x.name || (old.color ?? "") !== (x.color ?? "")) {
        const parts: string[] = [];
        if (old.name !== x.name) parts.push(`${old.name} → ${x.name}`);
        if ((old.color ?? "") !== (x.color ?? "")) parts.push(`${old.color ?? none()} → ${x.color ?? none()}`);
        out.push({ kind: "changed", name: x.name, detail: parts.join(" / ") });
      }
    }
    for (const [k, x] of bm) if (!am.has(k)) out.push({ kind: "deleted", name: x.name });
    return out;
  };
  const resources = named(before.resources, after.resources);
  const colorLabels = named(before.colorLabels, after.colorLabels);

  const known = new Set(["project", "resources", "colorLabels", "tasks", "view"]);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const other = [...keys].some((k) => !known.has(k) && !deepEqual((before as Record<string, unknown>)[k], (after as Record<string, unknown>)[k]));

  const otherCount = dependencies.length + resources.length + colorLabels.length + project.length + calendar.length + (reordered ? 1 : 0) + (other ? 1 : 0);
  return {
    added,
    changed,
    deleted,
    reordered,
    dependencies,
    resources,
    colorLabels,
    project,
    calendar,
    other,
    counts: { added: added.length, changed: changed.length, deleted: deleted.length, other: otherCount },
  };
}

export const isEmptyDiff = (d: Diff): boolean => d.counts.added + d.counts.changed + d.counts.deleted + d.counts.other === 0;

export function formatCounts(d: Diff): string {
  const parts: string[] = [];
  if (d.counts.added > 0) parts.push(t("ai.summary.added", { count: d.counts.added }));
  if (d.counts.changed > 0) parts.push(t("ai.summary.changed", { count: d.counts.changed }));
  if (d.counts.deleted > 0) parts.push(t("ai.summary.deleted", { count: d.counts.deleted }));
  if (d.counts.other > 0) parts.push(t("ai.summary.other", { count: d.counts.other }));
  return parts.length === 0 ? t("ai.summary.none") : parts.join(t("ai.summary.separator"));
}
