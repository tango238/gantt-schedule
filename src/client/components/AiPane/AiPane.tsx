import { useEffect, useState } from "react";
import { resetConversation } from "../../ai/aiActions";
import { useAiStore } from "../../ai/aiStore";
import { activeConfig, PROVIDER_LABELS } from "../../ai/settings";
import { clampPaneHeight, maxPaneHeight } from "../../ai/paneSize";
import { PaneResizer } from "../PaneResizer";
import { t } from "../../i18n";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

export function AiPane() {
  const open = useAiStore((s) => s.open);
  const height = useAiStore((s) => s.height);
  const status = useAiStore((s) => s.status);
  const messages = useAiStore((s) => s.messages);
  const settings = useAiStore((s) => s.settings);
  const setHeight = useAiStore((s) => s.setHeight);
  const commitHeight = useAiStore((s) => s.commitHeight);
  const setOpen = useAiStore((s) => s.setOpen);
  const openSettings = useAiStore((s) => s.openSettings);
  const cfg = activeConfig(settings);
  // ウィンドウが小さくなったときは表示だけ収める。保存値 (height) は、ユーザーが操作するまで書き換えない。
  const [winH, setWinH] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setWinH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const shown = clampPaneHeight(height, winH);

  if (!open) return null;

  return (
    <section className="ai-pane" style={{ height: shown }} aria-label={t("ai.title")} aria-busy={status !== "idle"} data-testid="ai-pane">
      <PaneResizer
        height={shown}
        max={maxPaneHeight(winH)}
        label={t("ai.resize")}
        testId="ai-resize"
        onChange={setHeight}
        onCommit={commitHeight}
      />
      <div className="ai-header">
        <span className="ai-title">{t("ai.title")}</span>
        {cfg && (
          <span className="ai-model" title={t("ai.modelInUse")} data-testid="ai-model">
            {PROVIDER_LABELS[cfg.provider]} / {cfg.model}
          </span>
        )}
        <span className="ai-spacer" />
        <button type="button" onClick={resetConversation} disabled={messages.length === 0 && status === "idle"} data-testid="ai-new">
          {t("ai.newSession")}
        </button>
        <button type="button" onClick={openSettings} data-testid="ai-settings">
          {t("ai.settings")}
        </button>
        <button type="button" onClick={() => setOpen(false)} aria-label={t("ai.close")} title={t("ai.close")} data-testid="ai-close">
          ×
        </button>
      </div>
      {cfg === null ? (
        <div className="ai-nokey" data-testid="ai-nokey">
          <p>{t("ai.noKey")}</p>
          <button type="button" className="primary" onClick={openSettings} data-testid="ai-nokey-settings">
            {t("ai.openSettings")}
          </button>
        </div>
      ) : (
        <>
          <MessageList messages={messages} thinking={status === "thinking" ? t("ai.thinking") : status === "validating" ? t("ai.validating") : status === "applying" ? t("ai.apply.applying") : null} />
          <Composer />
        </>
      )}
    </section>
  );
}
