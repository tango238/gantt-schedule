import { t } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import { confirmRestore } from "./versionActions";

/** バージョン表示中の帯。現在の編集画面と区別できるよう色を変える。 */
export function VersionBanner({ scheduleId }: { scheduleId: string }) {
  const viewing = useAppStore((s) => s.viewing);
  const syncPhase = useAppStore((s) => s.syncPhase);
  const exitViewing = useAppStore((s) => s.exitViewing);
  if (viewing === null) return null;
  const canRestore = syncPhase === "live" || syncPhase === "idle";
  return (
    <div className="version-banner" role="status" data-testid="version-banner">
      <span className="version-banner-text">{t("versions.banner", { name: viewing.name })}</span>
      <span className="spacer" />
      <button type="button" onClick={exitViewing} data-testid="version-back">
        {t("versions.backToCurrent")}
      </button>
      <button
        type="button"
        className="primary"
        disabled={!canRestore}
        onClick={() => confirmRestore(scheduleId, { id: viewing.versionId, name: viewing.name })}
        data-testid="version-banner-restore"
      >
        {t("versions.restore")}
      </button>
    </div>
  );
}
