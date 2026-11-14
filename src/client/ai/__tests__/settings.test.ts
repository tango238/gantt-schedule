// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { clampPaneHeight, DEFAULT_PANE_HEIGHT, loadPaneState, MIN_PANE_HEIGHT, maxPaneHeight, PANE_STORAGE_KEY, savePaneState } from "../paneSize";
import {
  activeConfig,
  DEFAULT_MODELS,
  defaultSettings,
  loadSettings,
  MODEL_OPTIONS,
  normalizeSettings,
  saveSettings,
  SETTINGS_STORAGE_KEY,
} from "../settings";
import { isAiToggleKey } from "../shortcut";
import { shouldSubmit } from "../../components/AiPane/Composer";
import { resetAiStoreForTest, useAiStore } from "../aiStore";

beforeEach(() => {
  localStorage.clear();
  resetAiStoreForTest();
});

describe("settings", () => {
  it("defaults to Anthropic claude-sonnet-5-5 and lists the documented candidates", () => {
    expect(defaultSettings().provider).toBe("anthropic");
    expect(DEFAULT_MODELS.anthropic).toBe("claude-sonnet-5-5");
    expect(MODEL_OPTIONS.anthropic.map((m) => m.id)).toEqual(["claude-sonnet-5-5", "claude-fable-5-2", "claude-opus-5-5", "claude-haiku-5-5"]);
  });
  it("saves and restores per-provider keys and models", () => {
    const s = defaultSettings();
    s.provider = "openai";
    s.keys.openai = "sk-abc";
    s.keys.gemini = "g-key";
    s.models.gemini = "my-custom-model_1";
    expect(saveSettings(s)).toBe(true);
    expect(loadSettings()).toEqual(s);
    expect(activeConfig(s)).toEqual({ provider: "openai", apiKey: "sk-abc", model: DEFAULT_MODELS.openai });
  });
  it("returns null config without a key and survives corrupted storage", () => {
    expect(activeConfig(defaultSettings())).toBeNull();
    localStorage.setItem(SETTINGS_STORAGE_KEY, "{broken");
    expect(loadSettings()).toEqual(defaultSettings());
    expect(normalizeSettings({ provider: "evil", keys: { openai: 5 }, models: { openai: "bad id!" } })).toEqual(defaultSettings());
  });
});

describe("pane size", () => {
  it("clamps between the minimum and the window-dependent maximum", () => {
    expect(clampPaneHeight(10, 900)).toBe(MIN_PANE_HEIGHT);
    expect(clampPaneHeight(5000, 900)).toBe(maxPaneHeight(900));
    expect(clampPaneHeight(300, 900)).toBe(300);
    expect(clampPaneHeight(NaN, 900)).toBe(DEFAULT_PANE_HEIGHT);
    // 小さすぎるウィンドウでは最小値が優先 (ウィンドウより大きくはならない範囲で)
    expect(clampPaneHeight(400, 300)).toBe(MIN_PANE_HEIGHT);
    expect(maxPaneHeight(900)).toBeLessThan(900);
  });
  it("persists open state and height; the store clamps on set but saves only on commit", () => {
    savePaneState({ open: true, height: 321 });
    expect(loadPaneState()).toEqual({ open: true, height: 321 });
    localStorage.setItem(PANE_STORAGE_KEY, "oops");
    expect(loadPaneState()).toEqual({ open: false, height: DEFAULT_PANE_HEIGHT });
    useAiStore.getState().setOpen(true);
    useAiStore.getState().setHeight(99999);
    expect(useAiStore.getState().height).toBeLessThan(window.innerHeight);
    expect(loadPaneState().height).toBe(DEFAULT_PANE_HEIGHT); // ドラッグ中は保存しない
    useAiStore.getState().commitHeight();
    expect(loadPaneState().height).toBe(useAiStore.getState().height);
  });
  it("the saved height is not overwritten when the store is created in a small window", () => {
    savePaneState({ open: true, height: 600 });
    resetAiStoreForTest();
    expect(useAiStore.getState().height).toBe(600); // 表示のときだけ収める
    expect(loadPaneState().height).toBe(600);
  });
});

describe("keyboard", () => {
  const ev = (o: Partial<Parameters<typeof isAiToggleKey>[0]>) => ({ key: "/", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });
  it("toggles with Cmd+/ on mac and Ctrl+/ on windows only", () => {
    expect(isAiToggleKey(ev({ metaKey: true }), "mac")).toBe(true);
    expect(isAiToggleKey(ev({ ctrlKey: true }), "mac")).toBe(false);
    expect(isAiToggleKey(ev({ ctrlKey: true }), "windows")).toBe(true);
    expect(isAiToggleKey(ev({ ctrlKey: true, shiftKey: true }), "windows")).toBe(false);
    expect(isAiToggleKey(ev({ ctrlKey: true, isComposing: true }), "windows")).toBe(false);
  });
  it("Enter submits, Shift+Enter and IME composition do not", () => {
    expect(shouldSubmit({ key: "Enter", shiftKey: false })).toBe(true);
    expect(shouldSubmit({ key: "Enter", shiftKey: true })).toBe(false);
    expect(shouldSubmit({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmit({ key: "Enter", shiftKey: false, keyCode: 229 })).toBe(false);
    expect(shouldSubmit({ key: "a", shiftKey: false })).toBe(false);
  });
});
