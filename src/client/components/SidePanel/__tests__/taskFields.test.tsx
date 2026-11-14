// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cat, doc as mkDoc, seq, task } from "../../../../shared/engine/__tests__/fixtures";
import type { GanttDocument } from "../../../../shared/model/types";
import { setCommandContextOverride, useAppStore } from "../../../store/appStore";
import { useUsersStore } from "../../../users/usersStore";
import { AssigneeField } from "../AssigneeField";
import { CategoryField } from "../CategoryField";
import { categoryOptions, taskCategoryInfo } from "../categoryOptions";
import { TasksTab } from "../TasksTab";

afterEach(cleanup);

const mk = (): GanttDocument =>
  mkDoc([
    cat("K1", null, "設計"),
    cat("K2", "K1", "基本"),
    task({ id: "A", parentId: "K2", start: "2023-05-22" }),
    task({ id: "P", parentId: "K1" }),
    task({ id: "p1", parentId: "P", start: "2023-05-22" }),
    task({ id: "T", start: "2023-05-22" }),
  ]);

beforeEach(() => {
  setCommandContextOverride({ today: "2023-05-22", newId: seq("N"), defaultTaskName: "n", defaultCategoryName: "c" });
  useAppStore.setState({ readOnly: false, viewing: null });
  useAppStore.getState().applySnapshot({ id: "S1", rev: 0, doc: mk() });
  useUsersStore.setState({
    users: [
      { id: "u1", name: "山田", email: "y@example.com" },
      { id: "u2", name: "佐藤", email: "s@example.com" },
    ],
    names: new Map([["u1", "山田"], ["u2", "佐藤"]]),
  });
});

describe("categoryOptions / taskCategoryInfo", () => {
  it("入れ子のカテゴリは「親 / 子」のパスで、表示順", () => {
    expect(categoryOptions(mk()).map((o) => o.label)).toEqual(["設計", "設計 / 基本"]);
  });
  it("最も近い祖先のカテゴリ。サブタスクは変更不可", () => {
    const d = mk();
    expect(taskCategoryInfo(d, "A")).toEqual({ editable: true, categoryId: "K2", label: "設計 / 基本" });
    expect(taskCategoryInfo(d, "T")).toEqual({ editable: true, categoryId: null, label: null });
    expect(taskCategoryInfo(d, "p1")).toEqual({ editable: false, categoryId: "K1", label: "設計" });
  });
});

describe("CategoryField", () => {
  it("選ぶとタスクが移動し、「なし」でカテゴリなしになる", () => {
    const { rerender } = render(<CategoryField doc={useAppStore.getState().doc!} taskId="T" />);
    const sel = screen.getByTestId("panel-category-select") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["カテゴリなし", "設計", "設計 / 基本"]);
    fireEvent.change(sel, { target: { value: "K2" } });
    expect(useAppStore.getState().doc!.tasks.find((t) => t.id === "T")!.parentId).toBe("K2");
    rerender(<CategoryField doc={useAppStore.getState().doc!} taskId="T" />);
    expect((screen.getByTestId("panel-category-select") as HTMLSelectElement).value).toBe("K2");
    fireEvent.change(screen.getByTestId("panel-category-select"), { target: { value: "" } });
    expect(useAppStore.getState().doc!.tasks.find((t) => t.id === "T")!.parentId).toBeNull();
  });
  it("サブタスクは継承したカテゴリを読み取り専用で表示する (選択欄なし)", () => {
    render(<CategoryField doc={useAppStore.getState().doc!} taskId="p1" />);
    expect(screen.queryByTestId("panel-category-select")).toBeNull();
    expect(screen.getByTestId("panel-category-inherited").textContent).toContain("設計");
  });
});

describe("TasksTab のカテゴリ・担当・詳細", () => {
  it("カテゴリ自身を選んでいるときはカテゴリ欄・担当欄を出さず、詳細とコメントは出る", () => {
    useAppStore.setState({ selectedId: "K1" });
    render(<TasksTab />);
    expect(screen.queryByTestId("panel-category-select")).toBeNull();
    expect(screen.queryByTestId("panel-assignees")).toBeNull();
    expect(screen.getByTestId("panel-notes")).toBeTruthy();
    expect(screen.getByTestId("comments")).toBeTruthy();
    expect(screen.getByText("詳細")).toBeTruthy();
  });
  it("タスクにはカテゴリ・担当・リソースの順で欄が出る。詳細は広い入力欄", () => {
    useAppStore.setState({ selectedId: "T" });
    render(<TasksTab />);
    expect((screen.getByTestId("panel-notes") as HTMLTextAreaElement).rows).toBeGreaterThanOrEqual(8);
    const html = document.body.innerHTML;
    expect(html.indexOf("panel-category-select")).toBeLessThan(html.indexOf("panel-assignees"));
    expect(html.indexOf("panel-assignees")).toBeLessThan(html.indexOf("リソース"));
  });
});

describe("AssigneeField", () => {
  it("一覧から追加し、× で外せる (複数可)", () => {
    const get = () => useAppStore.getState().doc!.tasks.find((t) => t.id === "T")!.assigneeIds;
    const { rerender } = render(<AssigneeField taskId="T" assigneeIds={[]} />);
    fireEvent.change(screen.getByTestId("assignee-add"), { target: { value: "u1" } });
    expect(get()).toEqual(["u1"]);
    rerender(<AssigneeField taskId="T" assigneeIds={get() ?? []} />);
    fireEvent.change(screen.getByTestId("assignee-add"), { target: { value: "u2" } });
    expect(get()).toEqual(["u1", "u2"]);
    rerender(<AssigneeField taskId="T" assigneeIds={get() ?? []} />);
    expect(screen.getAllByTestId("assignee-chip").map((c) => c.textContent)).toEqual(["山山田×", "佐佐藤×"]);
    fireEvent.click(screen.getAllByRole("button", { name: /を担当から外す/ })[0]!);
    expect(get()).toEqual(["u2"]);
  });
  it("選択肢は未選択のユーザーだけ。未知の ID は「不明なユーザー」で表示し、外せる", () => {
    render(<AssigneeField taskId="T" assigneeIds={["u1", "ghost"]} />);
    const opts = [...(screen.getByTestId("assignee-add") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(opts.some((o) => o?.includes("山田"))).toBe(false);
    expect(opts.some((o) => o?.includes("佐藤"))).toBe(true);
    expect(screen.getAllByTestId("assignee-chip")[1]!.textContent).toContain("不明なユーザー");
  });
  it("20 人で追加できなくなる", () => {
    const ids = Array.from({ length: 20 }, (_, i) => "x" + i);
    render(<AssigneeField taskId="T" assigneeIds={ids} />);
    expect((screen.getByTestId("assignee-add") as HTMLSelectElement).disabled).toBe(true);
  });
});
