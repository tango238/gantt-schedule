// Engine error codes (docs/design/02-engine.md section 6).
export type EngineErrorCode =
  | "TASK_NOT_FOUND"
  | "PARENT_NOT_EDITABLE"
  /** カテゴリには日付・期間・進捗・工数・担当者・依存を設定できない。 */
  | "CATEGORY_NOT_EDITABLE"
  /** マイルストーンには期間・工数・担当者・リソース・依存・状態を設定できない。 */
  | "MILESTONE_NOT_EDITABLE"
  /** マイルストーンの親は null かカテゴリのみ。マイルストーンの下には何も置けない。 */
  | "MILESTONE_PARENT_INVALID"
  /** カテゴリの親は null か別のカテゴリのみ。 */
  | "CATEGORY_PARENT_INVALID"
  /** サブタスク (親がタスク) のカテゴリは親タスクで変更する。 */
  | "SUBTASK_CATEGORY"
  | "START_AFTER_END"
  | "INVALID_VALUE"
  | "NO_PREVIOUS_SIBLING"
  | "NO_NEXT_SIBLING"
  | "NOT_INDENTED"
  | "DEPENDENCY_CONFLICT"
  | "DEPENDENCY_SELF"
  | "DEPENDENCY_DUPLICATE"
  | "DEPENDENCY_ANCESTOR"
  | "DEPENDENCY_CYCLE"
  | "DEPENDENCY_NOT_FOUND"
  | "SCHEDULING_DIVERGED"
  | "CALENDAR_NO_WORKING_DAY"
  /** サーバー専用 (Durable Object): 担当に指定されたユーザーが存在しない。engine 自体は返さない。 */
  | "UNKNOWN_USER"
  /** クライアント専用: 接続が live でない間は編集できない (サーバー・engine は返さない)。 */
  | "READ_ONLY";

export type ErrorParams = Record<string, string | number>;

/** A command precondition failed. Thrown inside a recipe; converted to CommandErr by executeCommand. */
export class CommandRejected extends Error {
  readonly code: EngineErrorCode;
  readonly params?: ErrorParams;
  constructor(code: EngineErrorCode, params?: ErrorParams) {
    super(code);
    this.name = "CommandRejected";
    this.code = code;
    this.params = params;
  }
}

export class CalendarError extends Error {
  readonly code: "CALENDAR_NO_WORKING_DAY" = "CALENDAR_NO_WORKING_DAY";
  constructor() {
    super("CALENDAR_NO_WORKING_DAY");
    this.name = "CalendarError";
  }
}

export class SchedulingError extends Error {
  readonly code: "SCHEDULING_DIVERGED" = "SCHEDULING_DIVERGED";
  constructor() {
    super("SCHEDULING_DIVERGED");
    this.name = "SchedulingError";
  }
}
