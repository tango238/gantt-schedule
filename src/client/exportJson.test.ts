import { describe, expect, it } from "vitest";
import schemaJson from "../../schema/gantt.schema.json";
import sampleJson from "../../schema/examples/sample.json";
import { loadDocument } from "../shared/engine";
import type { GanttDocument } from "../shared/model/types";
import { exportFileName, exportJsonText, KEY_ORDER } from "./exportJson";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const schema = schemaJson as any;
const sample = sampleJson as unknown as GanttDocument;

describe("KEY_ORDER", () => {
  it("スキーマの properties の並びと一致している", () => {
    const d = schema.$defs;
    expect(KEY_ORDER.root).toEqual(Object.keys(schema.properties));
    expect(KEY_ORDER.project).toEqual(Object.keys(d.project.properties));
    expect(KEY_ORDER.calendar).toEqual(Object.keys(d.calendar.properties));
    expect(KEY_ORDER.resource).toEqual(Object.keys(d.resource.properties));
    expect(KEY_ORDER.colorLabel).toEqual(Object.keys(d.colorLabel.properties));
    expect(KEY_ORDER.task).toEqual(Object.keys(d.task.properties));
    expect(KEY_ORDER.dependency).toEqual(Object.keys(d.dependency.properties));
    expect(KEY_ORDER.view).toEqual(Object.keys(d.view.properties));
  });
});

describe("exportJsonText", () => {
  it("インデント 2・末尾改行・スキーマ順で、再読み込みすると同じ doc になる", () => {
    const r = loadDocument(structuredClone(sample));
    if (!r.ok) throw new Error("sample invalid");
    const text = exportJsonText(r.doc);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.startsWith('{\n  "')).toBe(true);
    expect(text).toContain('\n  "project": {\n    "name"');
    const back = JSON.parse(text);
    expect(Object.keys(back).filter((k) => k !== "$schema")).toEqual(["version", "project", "resources", "colorLabels", "tasks", "view"]);
    const first = back.tasks[0];
    expect(Object.keys(first).slice(0, 3)).toEqual(["id", "parentId", "name"]);
    const re = loadDocument(back);
    expect(re.ok).toBe(true);
    if (re.ok) expect(re.doc.tasks).toEqual(r.doc.tasks);
  });
  it("未知のフィールドは失われない", () => {
    const d = { ...structuredClone(sample), custom: { a: 1 } } as GanttDocument;
    const r = loadDocument(d);
    if (!r.ok) throw new Error("invalid");
    expect(JSON.parse(exportJsonText(r.doc)).custom).toEqual({ a: 1 });
  });
});

describe("exportFileName", () => {
  it("使えない文字を置き換え、空なら既定名", () => {
    expect(exportFileName('a/b:c*"d')).toBe("a_b_c__d.json");
    expect(exportFileName("  ")).toBe("schedule.json");
    expect(exportFileName("Web サイト")).toBe("Web サイト.json");
  });
});

describe("exportFileName with a version name", () => {
  it("版名をファイル名に付ける (使えない文字は除く)", () => {
    expect(exportFileName("計画", "初版")).toBe("計画 (初版).json");
    expect(exportFileName("a/b", "x:y")).toBe("a_b (x_y).json");
    expect(exportFileName("計画")).toBe("計画.json");
  });
});

describe("カテゴリ", () => {
  it("kind: category を含む doc を書き出して読み込み直しても保たれ、kind は id の次に出力される", () => {
    const d = {
      version: 1,
      project: { name: "P" },
      resources: [],
      colorLabels: [],
      tasks: [
        { id: "11111111-1111-4111-8111-111111111111", kind: "category", parentId: null, name: "C", resourceIds: [], dependencies: [] },
        { id: "22222222-2222-4222-8222-222222222222", parentId: "11111111-1111-4111-8111-111111111111", name: "T", start: "2026-11-12", end: "2026-11-12", progress: 0, resourceIds: [], dependencies: [] },
      ],
      view: { zoom: "day", collapsedTaskIds: [] },
    } as unknown as GanttDocument;
    const r = loadDocument(d);
    if (!r.ok) throw new Error("invalid");
    const back = JSON.parse(exportJsonText(r.doc));
    expect(Object.keys(back.tasks[0]).slice(0, 3)).toEqual(["id", "kind", "parentId"]);
    const re = loadDocument(back);
    expect(re.ok).toBe(true);
    if (re.ok) expect(re.doc.tasks).toEqual(r.doc.tasks);
  });
});
