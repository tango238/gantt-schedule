import { useCallback, useEffect, useState } from "react";
import { t } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import { deleteVersion, listVersions, type VersionItem } from "../../versionsApi";
import { Modal } from "../dialogs/Modal";
import { requestConfirm, showToast } from "../uiStore";
import { SaveVersionDialog } from "./SaveVersionDialog";
import { confirmRestore, viewVersion } from "./versionActions";

/** 手動バージョンの保持件数 (サーバーの VERSION_KEEP と同じ)。 */
export const MANUAL_KEEP = 10;

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** バージョン一覧ダイアログ: 保存・表示・戻す・(手動の) 削除。 */
export function VersionsDialog({ scheduleId, onClose }: { scheduleId: string; onClose: () => void }) {
  // バージョン表示中も一覧は開けるので、readOnly (表示中は常に true) ではなく接続の状態で書き込み可否を決める。
  const readOnly = useAppStore((s) => s.syncPhase !== "live" && s.syncPhase !== "idle");
  const [items, setItems] = useState<VersionItem[] | null>(null);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      setItems(await listVersions(scheduleId));
      setError(false);
    } catch {
      setError(true);
    }
  }, [scheduleId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const view = async (v: VersionItem) => {
    if (await viewVersion(scheduleId, v)) onClose();
  };
  const remove = (v: VersionItem) =>
    requestConfirm({
      message: t("versions.confirmDelete", { name: v.name }),
      confirmLabel: t("versions.delete"),
      onConfirm: () => {
        void deleteVersion(scheduleId, v.id).then(
          () => reload(),
          () => showToast("error", t("versions.deleteFailed")),
        );
      },
    });

  // 手動が上限 (10 件) に達していれば、保存で消える最古の手動バージョン (一覧は新しい順)。
  const manual = (items ?? []).filter((v) => v.kind === "manual");
  const oldestManual = manual.length >= MANUAL_KEEP ? manual[manual.length - 1]!.name : null;

  return (
    <>
      <Modal
        title={t("versions.title")}
        wide
        onCancel={onClose}
        actions={
          <>
            <button type="button" className="primary" disabled={readOnly} onClick={() => setSaving(true)} data-testid="version-save">
              {t("versions.save")}
            </button>
            <button type="button" onClick={onClose} data-testid="versions-close">
              {t("versions.close")}
            </button>
          </>
        }
      >
        <div className="versions-body" data-testid="versions-list">
          {error ? (
            <p className="versions-empty">
              {t("versions.loadError")}{" "}
              <button type="button" onClick={() => void reload()}>
                {t("versions.retry")}
              </button>
            </p>
          ) : items === null ? (
            <p className="versions-empty">{t("versions.loading")}</p>
          ) : items.length === 0 ? (
            <div className="versions-empty">
              <p>{t("versions.empty")}</p>
              <p className="versions-hint">{t("versions.emptyHint")}</p>
            </div>
          ) : (
            <ul className="versions-list">
              {items.map((v) => (
                <li key={v.id} className="version-row" data-testid="version-row" data-kind={v.kind}>
                  <div className="version-main">
                    <span className="version-name" title={v.name}>
                      {v.name}
                    </span>
                    <span className="version-meta">
                      <span className={`version-kind kind-${v.kind}`}>{t(v.kind === "manual" ? "versions.kindManual" : "versions.kindAuto")}</span>
                      <span>{formatDateTime(v.createdAt)}</span>
                      <span>{t("versions.by", { name: v.createdBy.name })}</span>
                    </span>
                  </div>
                  <div className="version-actions">
                    <button type="button" onClick={() => void view(v)} data-testid="version-view">
                      {t("versions.view")}
                    </button>
                    <button type="button" disabled={readOnly} onClick={() => confirmRestore(scheduleId, v, onClose)} data-testid="version-restore">
                      {t("versions.restore")}
                    </button>
                    {v.kind === "manual" && (
                      <button type="button" disabled={readOnly} onClick={() => remove(v)} data-testid="version-delete">
                        {t("versions.delete")}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="versions-hint">{t("versions.autoHint")}</p>
        </div>
      </Modal>
      {saving && (
        <SaveVersionDialog
          scheduleId={scheduleId}
          willDelete={oldestManual}
          onClose={() => setSaving(false)}
          onSaved={() => {
            setSaving(false);
            void reload();
          }}
        />
      )}
    </>
  );
}
