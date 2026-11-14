import { countOverdue, durationOf, formatDuration, getDerived, type DerivedIndex, type WorkCalendar } from "../../shared/engine";
import { t } from "../i18n";
import { idKey } from "../../shared/model/id";
import type { GanttDocument } from "../../shared/model/types";

export interface StatusTexts {
  tasks: string;
  hours: string;
  duration: string;
  /** 期限超過の件数 (葉タスクのみ)。 */
  overdue: string;
  overdueCount: number;
  /** Selected task name ("" when nothing is selected). */
  selectionName: string;
  /** Selected task range, e.g. "2023/05/30 – 2023/05/30 (1d)" ("" when nothing is selected). */
  selectionRange: string;
}

/** "2023-05-30" -> "2023/05/30" */
export const formatDateSlash = (d: string): string => d.replace(/-/g, "/");

/** Trim floating point noise (0.1 + 0.2) without hiding real fractions. */
const num = (n: number): string => String(Number(n.toFixed(2)));

/** Status bar strings (03 section 10). Pure. */
export function statusTexts(
  doc: GanttDocument,
  derived: DerivedIndex,
  wc: WorkCalendar,
  selectedId: string | null,
  today: string,
): StatusTexts {
  let hoursSum = 0;
  let anyHours = false;
  let minStart: string | null = null;
  let maxEnd: string | null = null;
  for (const d of derived.byId.values()) {
    if (d.isCategory || d.isMilestone) continue; // マイルストーンは集計に含めない
    if (!d.isParent && d.hours !== undefined) {
      hoursSum += d.hours;
      anyHours = true;
    }
    if (minStart === null || d.start < minStart) minStart = d.start;
    if (maxEnd === null || d.end > maxEnd) maxEnd = d.end;
  }

  let duration = t("status.none");
  if (minStart !== null && maxEnd !== null) {
    duration = formatDuration(durationOf(minStart, maxEnd, wc), wc);
  }

  let selectionName = "";
  let selectionRange = "";
  if (selectedId !== null) {
    const d = getDerived(derived, selectedId);
    const task = doc.tasks.find((x) => idKey(x.id) === idKey(selectedId));
    if (d && task) {
      selectionName = task.name;
      if (d.isMilestone) selectionRange = formatDateSlash(d.start);
      else if (!d.isCategory) selectionRange = t("status.range", {
        start: formatDateSlash(d.start),
        end: formatDateSlash(d.end),
        duration: formatDuration(d.durationDays, wc),
      });
    }
  }

  const overdueCount = countOverdue(doc, today);
  return {
    tasks: t("status.tasks", { count: doc.tasks.filter((x) => x.kind !== "category" && x.kind !== "milestone").length }),
    hours: t("status.hours", { value: anyHours ? t("grid.hoursValue", { value: num(hoursSum) }) : t("status.none") }),
    duration: t("status.duration", { value: duration }),
    overdue: t("status.overdue.count", { count: overdueCount }),
    overdueCount,
    selectionName,
    selectionRange,
  };
}
