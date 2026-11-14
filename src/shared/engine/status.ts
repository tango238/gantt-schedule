import { idKey } from "../model/id";
import type { GanttDocument, IsoDate, Task, TaskStatus } from "../model/types";
import { buildTreeIndex, getChildren, getLeafDescendantsOrSelf, isCategoryTask, isMilestoneTask, isParent, type TreeIndex } from "./hierarchy";

/**
 * 状態 (未着手 / 進行中 / 完了) と、期限超過の導出。期限超過は保存せず、表示時に「閲覧者のローカルの今日」で求める
 * (ここは純関数。today は呼び出し側が渡す)。
 */

export type OverdueReason = "startPassed" | "endPassed";

/** 省略時は未着手。 */
export function statusOf(task: Pick<Task, "status"> | undefined): TaskStatus {
  return task?.status ?? "todo";
}

/**
 * 期限超過の理由 (当てはまるものすべて、startPassed → endPassed の順)。
 * - 未着手で start < today: startPassed
 * - 未着手または進行中で end < today: endPassed
 * today ちょうどは超過ではない。完了は超過にならない。
 */
export function overdueReasons(status: TaskStatus | undefined, start: IsoDate, end: IsoDate, today: IsoDate): OverdueReason[] {
  const s = status ?? "todo";
  const out: OverdueReason[] = [];
  if (s === "todo" && start < today) out.push("startPassed");
  if ((s === "todo" || s === "doing") && end < today) out.push("endPassed");
  return out;
}

/** 状態を持てる (子を持たない通常の) タスクか。 */
export function isStatusTask(ix: TreeIndex, id: string): boolean {
  const t = ix.byId.get(idKey(id));
  return t !== undefined && !isCategoryTask(t) && !isMilestoneTask(t) && !isParent(ix, id);
}

/** 親タスクの表示用: 子孫の葉タスクがすべて完了か (葉が 1 つも無ければ false)。親自身の status は見ない。 */
export function allLeavesDone(ix: TreeIndex, id: string): boolean {
  if (getChildren(ix, id).length === 0) return false;
  const leaves = getLeafDescendantsOrSelf(ix, id);
  return leaves.length > 0 && leaves.every((l) => statusOf(ix.byId.get(idKey(l))) === "done");
}

/** 期限超過の葉タスクの件数 (ステータスバー用)。 */
export function countOverdue(doc: GanttDocument, today: IsoDate): number {
  const ix = buildTreeIndex(doc);
  let n = 0;
  for (const t of doc.tasks) {
    if (!isStatusTask(ix, t.id) || t.start === undefined || t.end === undefined) continue;
    if (overdueReasons(t.status, t.start, t.end, today).length > 0) n++;
  }
  return n;
}
