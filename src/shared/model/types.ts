export type {
  GanttDocument,
  Task,
  Resource,
  ColorLabel,
  Dependency,
  Project,
  Calendar,
  ViewSettings,
} from "./schema";

export type TaskStatus = "todo" | "doing" | "done";

/** Calendar date "YYYY-MM-DD" (no time, no timezone). */
export type IsoDate = string;
export type Zoom = "day" | "week" | "month";
