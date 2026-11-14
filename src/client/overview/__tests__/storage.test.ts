// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_VIEW, loadSelection, loadView, pruneCollapsed, pruneIds, saveSelection, saveView, SELECTION_KEY, VIEW_KEY } from "../storage";

beforeEach(() => localStorage.clear());

describe("チェック状態の保存", () => {
  it("保存して復元する (重複は除く)", () => {
    saveSelection(["a", "b", "a"]);
    expect(loadSelection()).toEqual(["a", "b"]);
  });
  it("無い・壊れている・形が違うときは空", () => {
    expect(loadSelection()).toEqual([]);
    localStorage.setItem(SELECTION_KEY, "{oops");
    expect(loadSelection()).toEqual([]);
    localStorage.setItem(SELECTION_KEY, JSON.stringify({ ids: ["x", 1, null, "y"] }));
    expect(loadSelection()).toEqual(["x", "y"]);
    localStorage.setItem(SELECTION_KEY, JSON.stringify([1]));
    expect(loadSelection()).toEqual([]);
  });
  it("存在しない ID は捨てる (順序は保つ)", () => {
    expect(pruneIds(["c", "a", "z"], new Set(["a", "c"]))).toEqual(["c", "a"]);
  });
});

describe("表示状態の保存", () => {
  it("既定値", () => {
    expect(loadView()).toEqual(DEFAULT_VIEW);
  });
  it("保存して復元する", () => {
    const v = { zoom: "month", valueColumn: "hours", height: 333, collapsed: ["a", "a:b"], assignees: ["u1", ""], statuses: ["todo", "done"] } as const;
    saveView({ ...v, collapsed: [...v.collapsed], assignees: [...v.assignees], statuses: [...v.statuses] });
    expect(loadView()).toEqual(v);
  });
  it("絞り込みが無い古い保存値は、絞り込みなしとして読む。不正な状況は捨てる", () => {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ zoom: "day", valueColumn: "hours", height: 300, collapsed: [] }));
    expect(loadView()).toMatchObject({ zoom: "day", assignees: [], statuses: [] });
    localStorage.setItem(VIEW_KEY, JSON.stringify({ assignees: ["u", 1, "u"], statuses: ["done", "x", "todo"] }));
    expect(loadView()).toMatchObject({ assignees: ["u"], statuses: ["todo", "done"] });
  });
  it("不正な値は既定値に置き換える", () => {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ zoom: "year", valueColumn: 1, height: "x", collapsed: "no" }));
    expect(loadView()).toEqual(DEFAULT_VIEW);
    localStorage.setItem(VIEW_KEY, "null");
    expect(loadView()).toEqual(DEFAULT_VIEW);
  });
  it("存在しないスケジュールの折りたたみは捨てる", () => {
    expect(pruneCollapsed(["a", "a:t", "b:t", "c"], new Set(["a", "c"]))).toEqual(["a", "a:t", "c"]);
  });
});
