import type { GanttDocument, Task } from "../../model/types";
import { compileCalendar } from "../calendar";

export const WC5 = compileCalendar({ weekends: [0, 6], holidays: [] });
export const WC0 = compileCalendar(undefined);

export function seq(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

export interface TestContext {
  today: string;
  newId: () => string;
  defaultTaskName: string;
  defaultCategoryName: string;
  defaultMilestoneName: string;
}

export function makeCtx(today = "2023-05-22"): TestContext {
  return { today, newId: seq("N"), defaultTaskName: "新しいタスク", defaultCategoryName: "新しいカテゴリ", defaultMilestoneName: "新しいマイルストーン" };
}
export const ctx: TestContext = makeCtx();

export interface TaskSpec {
  id: string;
  parentId?: string | null;
  start?: string;
  end?: string;
  /** 廃止された項目 (古い doc の再現用)。 */
  progress?: number;
  status?: "todo" | "doing" | "done";
  hours?: number;
  /** predecessor ids (FS) */
  deps?: string[];
  resourceIds?: string[];
  name?: string;
}

/** Leaf: pass start (end defaults to start). Parent: omit dates. */
export function task(spec: TaskSpec): Task {
  const t: Task = {
    id: spec.id,
    parentId: spec.parentId ?? null,
    name: spec.name ?? spec.id,
    resourceIds: spec.resourceIds ?? [],
    dependencies: (spec.deps ?? []).map((p) => ({ predecessorId: p })),
  };
  if (spec.start !== undefined) {
    t.start = spec.start;
    t.end = spec.end ?? spec.start;
  }
  if (spec.hours !== undefined) t.hours = spec.hours;
  if (spec.status !== undefined) t.status = spec.status;
  if (spec.progress !== undefined) t.progress = spec.progress;
  return t;
}

/** Category: no dates, no dependencies, no resources. */
export function cat(id: string, parentId: string | null = null, name?: string): Task {
  return { id, kind: "category", parentId, name: name ?? id, resourceIds: [], dependencies: [] };
}

export function doc(tasks: Task[], opts: { calendar?: boolean } = {}): GanttDocument {
  const withCal = opts.calendar ?? true;
  return {
    version: 1,
    project: {
      name: "T",
      ...(withCal ? { calendar: { weekends: [0, 6], holidays: [] } } : {}),
    },
    resources: [],
    colorLabels: [],
    tasks,
    view: { zoom: "day", collapsedTaskIds: [] },
  };
}

export function byId(d: GanttDocument, id: string): Task {
  const t = d.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
}

export function span(d: GanttDocument, id: string): [string | undefined, string | undefined] {
  const t = byId(d, id);
  return [t.start, t.end];
}

/** Milestone: one date (start = end), no deps / resources. */
export function ms(id: string, date: string, parentId: string | null = null, name?: string): Task {
  return { id, kind: "milestone", parentId, name: name ?? id, start: date, end: date, resourceIds: [], dependencies: [] };
}
