// @vitest-environment jsdom
// レビューの再現ケース (rv5-apply) を取り込んだもの: dry run の結果と、実際に dispatch した結果が一致すること。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doc as mkDoc, seq, task } from "../../../shared/engine/__tests__/fixtures";
import { setCommandContextOverride, useAppStore } from "../../store/appStore";
import { applyProposal, resetConversation, send } from "../aiActions";
import { resetAiStoreForTest, useAiStore } from "../aiStore";
import { defaultSettings } from "../settings";
import { dryRun, withoutView } from "../plan";
import { parseOps } from "../ops";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let reply: unknown = null;
beforeEach(() => {
  localStorage.clear();
  resetAiStoreForTest();
  useAppStore.setState({ readOnly: false, viewing: null });
  useAiStore.getState().updateSettings({ ...defaultSettings(), keys: { ...defaultSettings().keys, anthropic: "sk-test-key-123456" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("https://api.anthropic.com/")) return json(200, { content: [{ type: "text", text: JSON.stringify(reply) }], stop_reason: "end_turn" });
      if (url.includes("/versions")) return json(200, { id: "v1", created: true });
      return json(404, {});
    }),
  );
});
afterEach(() => {
  resetConversation();
  setCommandContextOverride(null);
  vi.unstubAllGlobals();
});

function base() {
  return mkDoc([
    task({ id: "P", name: "親" }),
    task({ id: "A", parentId: "P", start: "2023-05-22", end: "2023-05-23", name: "A" }),
    task({ id: "B", parentId: "P", start: "2023-05-24", end: "2023-05-26", name: "B", deps: ["A"] }),
    task({ id: "L", start: "2023-05-29", end: "2023-05-30", name: "葉" }),
    task({ id: "C", start: "2023-06-01", end: "2023-06-02", name: "C" }),
  ]);
}
const lastProposal = () => {
  const m = [...useAiStore.getState().messages].reverse().find((x) => x.kind === "assistant");
  return m && m.kind === "assistant" ? { id: m.id, p: m.proposal } : undefined;
};
const ctx = () => ({ today: "2023-05-22", newId: seq("N"), defaultTaskName: "新しいタスク", defaultCategoryName: "新しいカテゴリ" });

async function roundTrip(ops: unknown[]) {
  setCommandContextOverride(ctx());
  useAppStore.getState().applySnapshot({ id: "S1", rev: 0, doc: base() });
  reply = { message: "m", operations: ops };
  await send("do");
  const lp = lastProposal();
  if (!lp?.p) return { noProposal: true as const };
  const parsed = parseOps(ops);
  if (!parsed.ok) throw new Error(parsed.error);
  const dr = dryRun(base(), parsed.ops, { ctx: ctx() });
  setCommandContextOverride(ctx());
  await applyProposal(lp.id);
  return { noProposal: false as const, state: lastProposal()!.p!.state, dr, after: withoutView(useAppStore.getState().doc!) };
}

describe("dry run == apply", () => {
  const cases: Record<string, unknown[]> = {
    leafParent: [
      { op: "addTask", tempId: "new:1", name: "子1", parentId: "L", start: "2023-05-31", end: "2023-05-31" },
      { op: "addTask", tempId: "new:2", name: "子2", parentId: "L", start: "2023-06-01", end: "2023-06-02", dependsOn: [{ id: "new:1" }] },
    ],
    parentWithKids: [{ op: "addTask", tempId: "new:1", name: "X", parentId: "P", start: "2023-05-22", end: "2023-05-22", dependsOn: [{ id: "B" }] }],
    afterIdTemp: [
      { op: "addTask", tempId: "new:1", name: "X", start: "2023-05-22", end: "2023-05-22" },
      { op: "addTask", tempId: "new:2", name: "Y", afterId: "new:1", start: "2023-05-23", end: "2023-05-23" },
      { op: "addTask", tempId: "new:3", name: "Z", parentId: "new:2", start: "2023-05-24", end: "2023-05-24" },
      { op: "deleteTask", id: "new:1" },
      { op: "arrangeTask", id: "new:2", action: "up" },
      { op: "shiftTask", id: "new:2", deltaDays: 2 },
    ],
    depsAndCal: [
      { op: "setCalendar", weekends: [0, 6], holidays: ["2023-05-25"] },
      { op: "updateTask", id: "A", end: "2023-05-25" },
      { op: "addResource", tempId: "new:r", name: "R" },
      { op: "updateTask", id: "B", resourceIds: ["new:r"] },
      { op: "addColorLabel", tempId: "new:c", name: "red", color: "#ff0000" },
      { op: "updateTask", id: "C", colorLabelId: "new:c", hours: 3 },
      { op: "deleteColorLabel", id: "new:c" },
    ],
    deleteParent: [{ op: "deleteTask", id: "P" }],
    indentUnderLeaf: [{ op: "arrangeTask", id: "C", action: "indent" }],
  };
  for (const [name, ops] of Object.entries(cases)) {
    it(name, async () => {
      const r = await roundTrip(ops);
      expect(r.noProposal).toBe(false);
      if (r.noProposal) return;
      expect(r.state).toBe("applied");
      expect(r.dr.ok).toBe(true);
      if (r.dr.ok) expect(r.after).toEqual(r.dr.after);
    });
  }
});

