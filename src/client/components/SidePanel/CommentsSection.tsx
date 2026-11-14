import { useEffect, useState, type KeyboardEvent } from "react";
import { formatCommentTime } from "../../comments/format";
import {
  editComment,
  openTaskComments,
  postComment,
  removeComment,
  setDraft,
  useCommentsStore,
  type CommentError,
} from "../../comments/commentsStore";
import type { Comment } from "../../comments/commentsApi";
import { t } from "../../i18n";
import { idKey } from "../../../shared/model/id";
import { requestConfirm, showToast } from "../uiStore";

export const COMMENT_MAX_CHARS = 4000;
const charCount = (s: string): number => Array.from(s).length;

function errorText(e: CommentError): string {
  return t(`comments.error.${e}`);
}

/** Cmd / Ctrl + Enter で送信 (日本語入力の変換確定の Enter は除く)。 */
const isSubmitKey = (e: KeyboardEvent): boolean => e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing;

/**
 * 右ペインのコメント。作成者・日時は表示のみ (サーバーが決める)。本文は React のテキストとして描画する
 * (HTML として解釈しない。改行は CSS の white-space: pre-wrap で保つ)。切断中・バージョン閲覧中は
 * 親の fieldset (SidePanel) が入力とボタンをまとめて無効にする。
 */
export function CommentsSection({ taskId }: { taskId: string }) {
  const key = idKey(taskId);
  const current = useCommentsStore((s) => s.current);
  const draft = useCommentsStore((s) => s.drafts[key] ?? "");
  const busy = useCommentsStore((s) => s.busy);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    openTaskComments(taskId);
    setEditing(null);
  }, [taskId]);
  useEffect(() => () => openTaskComments(null), []);

  const items = current && current.taskId === key ? current.items : null;
  const trimmed = draft.trim();
  const tooLong = charCount(draft) > COMMENT_MAX_CHARS;
  const canSend = trimmed !== "" && !tooLong && !busy;

  const send = async () => {
    if (!canSend) return;
    const err = await postComment(taskId, draft);
    if (err === null) setDraft(taskId, "");
    else showToast("error", errorText(err));
  };
  const saveEdit = async () => {
    if (!editing) return;
    const text = editing.text;
    if (text.trim() === "" || charCount(text) > COMMENT_MAX_CHARS || busy) return;
    const err = await editComment(taskId, editing.id, text);
    if (err === null) setEditing(null);
    else showToast("error", errorText(err));
  };
  const remove = (c: Comment) =>
    requestConfirm({
      message: t("comments.confirmDelete"),
      confirmLabel: t("dialog.delete"),
      onConfirm: () => {
        void removeComment(taskId, c.id).then((err) => {
          if (err !== null && err !== "notfound") showToast("error", errorText(err));
        });
      },
    });

  return (
    <section className="comments" data-testid="comments" aria-label={t("comments.title")}>
      <h3>
        {t("comments.title")}
        {items !== null && items.length > 0 && <span className="comments-count"> ({items.length})</span>}
      </h3>
      {items === null ? (
        <p className="comments-note">{current?.error ? t("comments.loadFailed") : t("comments.loading")}</p>
      ) : items.length === 0 ? (
        <p className="comments-note" data-testid="comments-empty">
          {t("comments.empty")}
        </p>
      ) : (
        <ul className="comment-list">
          {items.map((c) => (
            <li key={c.id} className="comment" data-testid="comment" data-comment-id={c.id}>
              <div className="comment-head">
                <span className="comment-author" data-testid="comment-author">
                  {c.author.name || t("assignee.unknown")}
                </span>
                <time dateTime={new Date(c.createdAt).toISOString()} data-testid="comment-time">
                  {formatCommentTime(c.createdAt)}
                </time>
                {c.updatedAt !== null && (
                  <span className="comment-edited" title={formatCommentTime(c.updatedAt)} data-testid="comment-edited">
                    {t("comments.edited")}
                  </span>
                )}
              </div>
              {editing?.id === c.id ? (
                <div className="comment-edit">
                  <textarea
                    rows={4}
                    value={editing.text}
                    data-testid="comment-edit-input"
                    autoFocus
                    onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (isSubmitKey(e)) {
                        e.preventDefault();
                        void saveEdit();
                      } else if (e.key === "Escape" && !e.nativeEvent.isComposing) {
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                  />
                  <div className="comment-actions">
                    <button type="button" data-testid="comment-edit-save" disabled={editing.text.trim() === "" || charCount(editing.text) > COMMENT_MAX_CHARS || busy} onClick={() => void saveEdit()}>
                      {t("comments.save")}
                    </button>
                    <button type="button" onClick={() => setEditing(null)}>
                      {t("dialog.cancel")}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="comment-body" data-testid="comment-body">
                    {c.body}
                  </p>
                  {c.mine && (
                    <div className="comment-actions">
                      <button type="button" data-testid="comment-edit" onClick={() => setEditing({ id: c.id, text: c.body })}>
                        {t("comments.edit")}
                      </button>
                      <button type="button" data-testid="comment-delete" onClick={() => remove(c)}>
                        {t("comments.delete")}
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="comment-compose">
        <textarea
          rows={3}
          value={draft}
          placeholder={t("comments.placeholder")}
          aria-label={t("comments.title")}
          data-testid="comment-input"
          onChange={(e) => setDraft(taskId, e.target.value)}
          onKeyDown={(e) => {
            if (isSubmitKey(e)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="comment-compose-row">
          {tooLong && <small className="note invalid-note">{t("comments.tooLong", { max: COMMENT_MAX_CHARS })}</small>}
          <button type="button" className="primary" data-testid="comment-send" disabled={!canSend} onClick={() => void send()}>
            {t("comments.send")}
          </button>
        </div>
      </div>
    </section>
  );
}
