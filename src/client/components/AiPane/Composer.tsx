import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cancel, send } from "../../ai/aiActions";
import { useAiStore } from "../../ai/aiStore";
import { t } from "../../i18n";
import { useAppStore } from "../../store/appStore";

/** Enter で送信・Shift+Enter で改行。IME 変換中の Enter は送信しない。 */
export function shouldSubmit(e: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
}

export function Composer() {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const status = useAiStore((s) => s.status);
  const focusTick = useAiStore((s) => s.focusTick);
  const readOnly = useAppStore((s) => s.readOnly);
  const hasDoc = useAppStore((s) => s.doc !== null);
  const busy = status !== "idle";
  const canSend = hasDoc && !readOnly && !busy && text.trim() !== "";

  useEffect(() => {
    if (focusTick > 0) ref.current?.focus();
  }, [focusTick]);

  const submit = () => {
    if (!canSend) return;
    const v = text;
    setText("");
    if (ref.current) ref.current.style.height = "";
    void send(v);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSubmit({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (status === "thinking") cancel();
      else ref.current?.blur();
    }
  };

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
  };

  return (
    <div className="ai-composer">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={readOnly}
        data-testid="ai-input"
        aria-label={t("ai.composerLabel")}
        placeholder={readOnly ? t("ai.readOnlyNotice") : t("ai.placeholder")}
        onChange={(e) => {
          setText(e.target.value);
          grow(e.target);
        }}
        onKeyDown={onKeyDown}
      />
      {status === "thinking" || status === "validating" ? (
        <button type="button" onClick={cancel} disabled={status === "validating"} data-testid="ai-stop">
          {t("ai.stop")}
        </button>
      ) : (
        <button type="button" className="primary" onClick={submit} disabled={!canSend} data-testid="ai-send">
          {t("ai.send")}
        </button>
      )}
    </div>
  );
}
