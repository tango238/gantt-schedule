import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import type { AiMessage } from "../../ai/aiStore";
import { ProposalCard } from "./ProposalCard";

/** active の間、経過秒数を返す (終わると 0 に戻る)。 */
function useElapsed(active: boolean): number {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!active) {
      setSec(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setSec(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [active]);
  return sec;
}

/** 会話。AI の出力はすべてテキストノードとして描画する (HTML としては解釈しない)。 */
export function MessageList({ messages, thinking }: { messages: AiMessage[]; thinking: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const elapsed = useElapsed(thinking !== null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 新しい項目が表示領域より高い (変更案など) ときは、末尾ではなくその項目の先頭に合わせる。
    const last = el.lastElementChild;
    if (last && last.getBoundingClientRect().height > el.clientHeight - 16) {
      el.scrollTop += last.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, thinking]);
  return (
    <div className="ai-messages" ref={ref} data-testid="ai-messages" aria-live="polite">
      {messages.map((m) => {
        switch (m.kind) {
          case "user":
            return (
              <div key={m.id} className="ai-bubble ai-user" data-testid="ai-msg-user">
                {m.text}
              </div>
            );
          case "assistant":
            return (
              <div key={m.id} className="ai-turn">
                {m.text !== "" && (
                  <div className="ai-bubble ai-assistant" data-testid="ai-msg-assistant">
                    {m.text}
                  </div>
                )}
                {m.proposal && <ProposalCard id={m.id} proposal={m.proposal} />}
              </div>
            );
          case "error":
            return (
              <div key={m.id} className="ai-error" role="alert" data-testid="ai-error">
                {m.text}
              </div>
            );
          case "notice":
            return (
              <div key={m.id} className="ai-notice" data-testid="ai-notice">
                {m.text}
              </div>
            );
        }
      })}
      {thinking && (
        <div className="ai-thinking" data-testid="ai-thinking">
          <span className="ai-spinner" aria-hidden="true" /> {thinking}
          {elapsed >= 3 && <span className="ai-meta"> ({t("ai.elapsed", { seconds: elapsed })})</span>}
        </div>
      )}
    </div>
  );
}
