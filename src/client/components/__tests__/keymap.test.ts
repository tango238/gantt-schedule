import { describe, expect, it } from "vitest";
import { formatShortcut, mapKey, type KeyContext, type KeyInput } from "../keymap";

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({
  platform: "mac",
  editing: false,
  dragging: false,
  modalOpen: false,
  ...over,
});

describe("undo / redo / file are not handled (browser defaults apply)", () => {
  it("Mod+Z / Mod+Shift+Z / Mod+S / Mod+Y / Mod+Shift+E map to nothing", () => {
    expect(mapKey(key("z", { metaKey: true }), ctx())).toBeNull();
    expect(mapKey(key("Z", { metaKey: true, shiftKey: true }), ctx())).toBeNull();
    expect(mapKey(key("s", { metaKey: true }), ctx())).toBeNull();
    expect(mapKey(key("y", { ctrlKey: true }), ctx({ platform: "windows" }))).toBeNull();
    expect(mapKey(key("z", { ctrlKey: true }), ctx({ platform: "windows" }))).toBeNull();
    expect(mapKey(key("E", { metaKey: true, shiftKey: true }), ctx())).toBeNull();
  });
});

describe("task shortcuts", () => {
  it("Enter: addTask when not editing, null while editing", () => {
    expect(mapKey(key("Enter"), ctx())).toEqual({ type: "addTask" });
    expect(mapKey(key("Enter"), ctx({ editing: true }))).toBeNull();
  });
  it("Shift+Enter: addCategory when not editing, null while editing / composing", () => {
    expect(mapKey(key("Enter", { shiftKey: true }), ctx())).toEqual({ type: "addCategory" });
    expect(mapKey(key("Enter", { shiftKey: true }), ctx({ editing: true }))).toBeNull();
    expect(mapKey(key("Enter", { shiftKey: true, isComposing: true }), ctx())).toBeNull();
  });
  it("Enter during IME composition is ignored", () => {
    expect(mapKey(key("Enter", { isComposing: true }), ctx())).toBeNull();
  });
  it("F2 edits the name", () => {
    expect(mapKey(key("F2"), ctx())).toEqual({ type: "editName" });
  });
  it("Tab / Shift+Tab", () => {
    expect(mapKey(key("Tab"), ctx())).toEqual({ type: "indent" });
    expect(mapKey(key("Tab", { shiftKey: true }), ctx())).toEqual({ type: "outdent" });
    expect(mapKey(key("Tab"), ctx({ editing: true }))).toBeNull();
  });
  it("Alt+ArrowUp / Alt+ArrowDown move", () => {
    expect(mapKey(key("ArrowUp", { altKey: true }), ctx())).toEqual({ type: "moveUp" });
    expect(mapKey(key("ArrowDown", { altKey: true }), ctx())).toEqual({ type: "moveDown" });
    expect(mapKey(key("ArrowUp", { altKey: true }), ctx({ platform: "windows" }))).toEqual({ type: "moveUp" });
  });
  it("Delete / Backspace delete the selection", () => {
    expect(mapKey(key("Delete"), ctx())).toEqual({ type: "deleteSelected" });
    expect(mapKey(key("Backspace"), ctx())).toEqual({ type: "deleteSelected" });
    expect(mapKey(key("Backspace"), ctx({ editing: true }))).toBeNull();
  });
  it("arrows navigate and fold", () => {
    expect(mapKey(key("ArrowUp"), ctx())).toEqual({ type: "selectPrev" });
    expect(mapKey(key("ArrowDown"), ctx())).toEqual({ type: "selectNext" });
    expect(mapKey(key("ArrowLeft"), ctx())).toEqual({ type: "collapse" });
    expect(mapKey(key("ArrowRight"), ctx())).toEqual({ type: "expand" });
    expect(mapKey(key("ArrowLeft"), ctx({ editing: true }))).toBeNull();
  });
  it("Mod+D duplicates; Mod+1/2/3 zoom", () => {
    expect(mapKey(key("d", { metaKey: true }), ctx())).toEqual({ type: "duplicate" });
    expect(mapKey(key("d", { ctrlKey: true }), ctx({ platform: "windows" }))).toEqual({ type: "duplicate" });
    expect(mapKey(key("1", { metaKey: true }), ctx())).toEqual({ type: "zoom", zoom: "day" });
    expect(mapKey(key("2", { metaKey: true }), ctx())).toEqual({ type: "zoom", zoom: "week" });
    expect(mapKey(key("3", { metaKey: true }), ctx())).toEqual({ type: "zoom", zoom: "month" });
    expect(mapKey(key("d", { metaKey: true }), ctx({ editing: true }))).toBeNull();
  });
  it("Escape clears the dependency selection outside inputs", () => {
    expect(mapKey(key("Escape"), ctx())).toEqual({ type: "escape" });
    expect(mapKey(key("Escape"), ctx({ editing: true }))).toBeNull();
  });
  it("plain keys with Ctrl/Meta held are not task shortcuts", () => {
    expect(mapKey(key("Enter", { ctrlKey: true }), ctx({ platform: "windows" }))).toBeNull();
    expect(mapKey(key("Enter", { metaKey: true }), ctx())).toBeNull();
  });
  it("unknown keys give null", () => {
    expect(mapKey(key("a"), ctx())).toBeNull();
  });
});

describe("suppression", () => {
  it("everything is ignored while dragging or with a modal open", () => {
    expect(mapKey(key("Enter"), ctx({ dragging: true }))).toBeNull();
    expect(mapKey(key("Escape"), ctx({ dragging: true }))).toBeNull();
    expect(mapKey(key("z", { metaKey: true }), ctx({ dragging: true }))).toBeNull();
    expect(mapKey(key("Enter"), ctx({ modalOpen: true }))).toBeNull();
  });
});

describe("formatShortcut", () => {
  it("uses glyphs on mac and Ctrl+ on windows", () => {
    expect(formatShortcut("mac", "Mod+Z")).toBe("⌘Z");
    expect(formatShortcut("mac", "Mod+Shift+Z")).toBe("⌘⇧Z");
    expect(formatShortcut("windows", "Mod+Shift+Z")).toBe("Ctrl+Shift+Z");
  });
  it("ignores keys the IME is processing (keyCode 229)", () => {
    expect(mapKey(key("Enter", { keyCode: 229 }), ctx())).toBeNull();
    expect(mapKey(key("Enter"), ctx())).toEqual({ type: "addTask" });
  });
});
