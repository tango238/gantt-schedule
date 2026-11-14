import { loadDocument, PROJECT_NAME_MAX, type LoadIssue } from "../../shared/engine";
import type { GanttDocument } from "../../shared/model/types";
import { validate as validateSchema, type SchemaValidationError } from "./schemaValidator.generated.js";

/** 保存する doc の上限 (UTF-8 バイト数)。 */
export const MAX_DOC_BYTES = 1024 * 1024;

const encoder = new TextEncoder();
export const utf8Length = (s: string): number => encoder.encode(s).byteLength;

export interface ValidationIssue {
  code: string;
  path: string;
  message?: string;
  params?: Record<string, string | number>;
}

export type ImportResult =
  | { ok: true; doc: GanttDocument; warnings: LoadIssue[] }
  | { ok: false; kind: "schema" | "integrity"; issues: ValidationIssue[] };

const MAX_ISSUES = 50;

/**
 * ajv の standalone 検証 (JSON Schema) の結果を ValidationIssue に変換する。
 * code は ajv のキーワード名 (required / type / pattern / format ...)。クライアントの
 * error.schema.<code> 文言に対応し、params は文言のプレースホルダ用。
 */
function schemaIssues(errors: SchemaValidationError[] | null): ValidationIssue[] {
  return (errors ?? []).slice(0, MAX_ISSUES).map((e) => {
    const p = e.params;
    const params: Record<string, string | number> = {};
    if (typeof p.missingProperty === "string") params.property = p.missingProperty;
    if (typeof p.type === "string") params.expected = p.type;
    if (typeof p.format === "string") params.format = p.format;
    if (typeof p.limit === "number") params.limit = p.limit;
    if (p.allowedValue !== undefined && (typeof p.allowedValue === "string" || typeof p.allowedValue === "number")) {
      params.expected = p.allowedValue;
    }
    return { code: e.keyword, path: e.instancePath, message: e.message, ...(Object.keys(params).length ? { params } : {}) };
  });
}

/** 保存してよい doc か (JSON Schema + project.name の長さ)。command 適用後の最終検査にも使う。 */
export function checkSchema(doc: unknown): ValidationIssue[] {
  if (!validateSchema(doc)) return schemaIssues(validateSchema.errors);
  const name = (doc as { project: { name: string } }).project.name;
  if (name.trim() === "" || name.length > PROJECT_NAME_MAX) {
    return [{ code: "projectName", path: "/project/name", params: { limit: PROJECT_NAME_MAX } }];
  }
  return [];
}

/** doc から view を除く (view は共有ドキュメントに含めない)。入力は変更しない。 */
export function stripView<T extends object>(doc: T): Omit<T, "view"> {
  const { view: _view, ...rest } = doc as T & { view?: unknown };
  return rest;
}

/**
 * 外部から来た doc (JSON インポート・replaceDocument) の検証。
 * 1) JSON Schema (version 1) 2) engine の読み込み検証 (整合性 I1–I8) を通ったものだけを、
 * 正規化 (loadDocument) して view を除いた形で返す。
 */
export function validateImportedDoc(raw: unknown): ImportResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, kind: "schema", issues: [{ code: "type", path: "", message: "must be object", params: { expected: "object" } }] };
  }
  const issues = checkSchema(raw);
  if (issues.length > 0) return { ok: false, kind: "schema", issues };
  const res = loadDocument(structuredClone(raw) as GanttDocument);
  if (!res.ok) {
    return { ok: false, kind: "integrity", issues: res.errors.slice(0, MAX_ISSUES).map((e) => ({ ...e })) };
  }
  return { ok: true, doc: stripView(res.doc) as GanttDocument, warnings: res.warnings };
}
