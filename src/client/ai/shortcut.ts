import { useEffect } from "react";
import { detectPlatform, type KeyInput } from "../components/keymap";
import { useAiStore } from "./aiStore";

/** AI ペインの開閉: Mod+/ (Mac は ⌘/、Windows は Ctrl+/)。主要ブラウザの標準ショートカットと衝突しない。 */
export function isAiToggleKey(e: KeyInput, platform: "mac" | "windows"): boolean {
  if (e.isComposing || e.keyCode === 229) return false;
  const mod = platform === "mac" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.altKey && !e.shiftKey && e.key === "/";
}

export function useAiShortcut(): void {
  useEffect(() => {
    const platform = detectPlatform();
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;
      if (!isAiToggleKey(e, platform)) return;
      e.preventDefault();
      useAiStore.getState().toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
