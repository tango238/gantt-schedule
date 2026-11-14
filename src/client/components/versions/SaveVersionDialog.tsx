import { useState } from "react";
import { validName } from "../../../shared/name";
import { t } from "../../i18n";
import { saveVersion } from "../../versionsApi";
import { Modal } from "../dialogs/Modal";
import { showToast } from "../uiStore";

const NAME_MAX = 100;

const pad = (n: number) => String(n).padStart(2, "0");
/** 既定のバージョン名: 「2026-11-12 14:03」(ローカル時刻)。 */
export function defaultVersionName(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SaveVersionDialog({
  scheduleId,
  willDelete,
  onClose,
  onSaved,
}: {
  scheduleId: string;
  /** 保存すると削除される最古の手動バージョン名 (上限に達していないなら null)。 */
  willDelete: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(defaultVersionName);
  const [busy, setBusy] = useState(false);
  const valid = validName(name, NAME_MAX);
  const ok = valid !== null && !busy;
  const submit = async () => {
    if (!ok || valid === null) return;
    setBusy(true);
    try {
      await saveVersion(scheduleId, valid);
      showToast("info", t("versions.saved"));
      onSaved();
    } catch {
      showToast("error", t("versions.saveFailed"));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("versions.saveTitle")}
      onCancel={onClose}
      actions={
        <>
          <button type="button" onClick={onClose}>
            {t("dialog.cancel")}
          </button>
          <button type="button" className="primary" disabled={!ok} onClick={() => void submit()} data-testid="version-save-submit">
            {busy ? t("versions.saving") : t("versions.saveSubmit")}
          </button>
        </>
      }
    >
      <label className="field-block">
        <span>{t("versions.nameLabel")}</span>
        <input
          type="text"
          data-autofocus
          data-testid="version-name"
          value={name}
          
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </label>
      {willDelete !== null && (
        <p className="versions-warn" data-testid="version-will-delete">
          {t("versions.saveWillDeleteOldest", { name: willDelete })}
        </p>
      )}
    </Modal>
  );
}
