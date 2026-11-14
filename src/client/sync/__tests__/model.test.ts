import { describe, expect, it } from "vitest";
import { executeCommand, type Command } from "../../../shared/engine";
import { doc as mkDoc, task } from "../../../shared/engine/__tests__/fixtures";
import type { GanttDocument } from "../../../shared/model/types";
import { SyncModel } from "../model";

const ctx = { today: "2023-05-22", defaultTaskName: "n", defaultCategoryName: "c", defaultMilestoneName: "m" };
function base(): GanttDocument {
  const { view: _v, ...rest } = mkDoc([
    task({ id: "A", start: "2023-05-22", end: "2023-05-23" }),
    task({ id: "B", start: "2023-05-24", end: "2023-05-25" }),
  ]);
  return rest as GanttDocument;
}
/** サーバーがコマンドを適用した結果 (update 相当)。 */
function serverApply(doc: GanttDocument, cmd: Command, ids: string[] = []) {
  const q = [...ids];
  const r = executeCommand(doc, cmd, { ...ctx, newId: () => q.shift()! });
  if (!r.ok) throw new Error(r.code);
  return r;
}
const name = (d: GanttDocument, id: string) => d.tasks.find((t) => t.id === id)!.name;
const pend = (m: SyncModel, command: Command, ids: string[] = []) => m.add(command, { ...ctx, ids });

describe("SyncModel", () => {
  it("update の patches を rev 順に適用して serverDoc を進める", () => {
    const m = new SyncModel();
    m.reset(base(), 5);
    const r = serverApply(m.serverDoc!, { type: "setName", id: "A", name: "x" });
    expect(m.applyUpdate({ rev: 6, patches: r.patches })).toBe("applied");
    expect(name(m.serverDoc!, "A")).toBe("x");
    expect(m.serverRev).toBe(6);
  });
  it("反映済み (rev 以下) は stale、飛んだ rev は gap で状態を変えない", () => {
    const m = new SyncModel();
    m.reset(base(), 5);
    const r = serverApply(m.serverDoc!, { type: "setName", id: "A", name: "x" });
    expect(m.applyUpdate({ rev: 5, patches: r.patches })).toBe("stale");
    expect(m.applyUpdate({ rev: 7, patches: r.patches })).toBe("gap");
    expect(m.serverRev).toBe(5);
    expect(name(m.serverDoc!, "A")).not.toBe("x");
  });
  it("パッチが適用できなければ gap", () => {
    const m = new SyncModel();
    m.reset(base(), 1);
    expect(m.applyUpdate({ rev: 2, patches: [{ op: "replace", path: ["tasks", 99, "name"], value: "x" }] })).toBe("gap");
  });
  it("表示 doc = serverDoc + 未確定コマンド。他者の update が来ても自分の操作は残る", () => {
    const m = new SyncModel();
    m.reset(base(), 0);
    pend(m, { type: "setName", id: "A", name: "mine" });
    const other = serverApply(m.serverDoc!, { type: "setName", id: "B", name: "theirs" });
    m.applyUpdate({ rev: 1, patches: other.patches });
    const { doc, dropped } = m.rebuild();
    expect(dropped).toHaveLength(0);
    expect(name(doc, "A")).toBe("mine");
    expect(name(doc, "B")).toBe("theirs");
  });
  it("自分のコマンドの update (reqId 付き) で未確定列から外れ、二重適用されない", () => {
    const m = new SyncModel();
    m.reset(base(), 0);
    const p = pend(m, { type: "addTask", afterId: "A" }, ["N1"]);
    const r = serverApply(m.serverDoc!, p.command, ["N1"]);
    expect(m.applyUpdate({ rev: 1, patches: r.patches, reqId: p.reqId })).toBe("applied");
    expect(m.pending).toHaveLength(0);
    expect(m.rebuild().doc.tasks).toHaveLength(3);
  });
  it("ack: update が先なら即外れ、後なら rev に届いた時点で外れる。変更なしの ack も外れる", () => {
    const m = new SyncModel();
    m.reset(base(), 0);
    const p1 = pend(m, { type: "rescheduleAll" });
    m.ack(p1.reqId, 0);
    expect(m.pending).toHaveLength(0);
    const p2 = pend(m, { type: "setName", id: "A", name: "x" });
    m.ack(p2.reqId, 1); // update がまだ
    expect(m.pending).toHaveLength(1);
    const r = serverApply(m.serverDoc!, p2.command);
    m.applyUpdate({ rev: 1, patches: r.patches });
    expect(m.pending).toHaveLength(0);
  });
  it("再適用で engine が拒否するコマンドは捨てる (他者がタスクを削除した場合)", () => {
    const m = new SyncModel();
    m.reset(base(), 0);
    pend(m, { type: "setName", id: "A", name: "mine" });
    pend(m, { type: "setName", id: "B", name: "keep" });
    const del = serverApply(m.serverDoc!, { type: "deleteTask", id: "A" });
    m.applyUpdate({ rev: 1, patches: del.patches });
    const { doc, dropped } = m.rebuild();
    expect(dropped).toHaveLength(1);
    expect(m.pending).toHaveLength(1);
    expect(doc.tasks.map((t) => t.id)).toEqual(["B"]);
    expect(name(doc, "B")).toBe("keep");
  });
  it("addTask は指定した ID を再適用でも使う", () => {
    const m = new SyncModel();
    m.reset(base(), 0);
    pend(m, { type: "addTask", afterId: "A" }, ["NEW1"]);
    const other = serverApply(m.serverDoc!, { type: "setName", id: "B", name: "t" });
    m.applyUpdate({ rev: 1, patches: other.patches });
    expect(m.rebuild().doc.tasks.map((t) => t.id)).toContain("NEW1");
  });
  it("reset は未確定を破棄して返す", () => {
    const m = new SyncModel();
    m.reset(base(), 0);
    pend(m, { type: "setName", id: "A", name: "x" });
    expect(m.reset(base(), 9)).toHaveLength(1);
    expect(m.pending).toHaveLength(0);
    expect(m.serverRev).toBe(9);
  });
  it("reject: 該当コマンドだけ外れる", () => {
    const m = new SyncModel();
    m.reset(base(), 0);
    const a = pend(m, { type: "setName", id: "A", name: "x" });
    pend(m, { type: "setName", id: "B", name: "y" });
    expect(m.reject(a.reqId)).toBe(true);
    expect(m.reject(999)).toBe(false);
    expect(m.pending).toHaveLength(1);
  });
});
