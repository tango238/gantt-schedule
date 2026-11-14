import { useLayoutEffect, useRef, useState } from "react";
import { useAiStore } from "../../ai/aiStore";
import {
  MAX_KEY_LENGTH,
  MODEL_ID_PATTERN,
  MODEL_OPTIONS,
  PROVIDER_LABELS,
  type AiSettings,
} from "../../ai/settings";
import { PROVIDER_IDS, type ProviderId } from "../../ai/types";
import { t } from "../../i18n";
import { Modal } from "../dialogs/Modal";
import { showToast } from "../uiStore";

const CUSTOM = "__custom__";

export function AiSettingsHost() {
  const open = useAiStore((s) => s.settingsOpen);
  return open ? <AiSettingsDialog /> : null;
}

function AiSettingsDialog() {
  const saved = useAiStore((s) => s.settings);
  const close = useAiStore((s) => s.closeSettings);
  const update = useAiStore((s) => s.updateSettings);
  const [draft, setDraft] = useState<AiSettings>(() => structuredClone(saved));
  const [show, setShow] = useState(false);
  // API キー欄は非制御 (state に毎回載せない)。値は属性ではなくプロパティで入れる (DOM の value 属性にキーを出さない)。
  const keyRef = useRef<HTMLInputElement>(null);
  const p = draft.provider;
  const model = draft.models[p];
  const known = MODEL_OPTIONS[p].some((m) => m.id === model);
  const [custom, setCustom] = useState<Record<ProviderId, boolean>>(() => ({
    anthropic: !MODEL_OPTIONS.anthropic.some((m) => m.id === saved.models.anthropic),
    openai: !MODEL_OPTIONS.openai.some((m) => m.id === saved.models.openai),
    gemini: !MODEL_OPTIONS.gemini.some((m) => m.id === saved.models.gemini),
  }));
  const isCustom = custom[p] || !known;
  const modelValid = MODEL_ID_PATTERN.test(model);
  const [keyLen, setKeyLen] = useState(draft.keys[p].length);
  const keyValid = keyLen <= MAX_KEY_LENGTH;

  useLayoutEffect(() => {
    if (keyRef.current) keyRef.current.value = draft.keys[p];
    setKeyLen(draft.keys[p].length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p]);
  /** 入力欄の現在値を draft に反映した設定を返す。 */
  const withKey = (d: AiSettings): AiSettings => ({ ...d, keys: { ...d.keys, [d.provider]: (keyRef.current?.value ?? d.keys[d.provider]).trim() } });
  const clearKey = () => {
    if (keyRef.current) keyRef.current.value = "";
    setDraft({ ...draft, keys: { ...draft.keys, [p]: "" } });
  };

  const setModel = (v: string) => setDraft({ ...draft, models: { ...draft.models, [p]: v.trim() } });

  const submit = () => {
    if (!modelValid || !keyValid) return;
    if (!update(withKey(draft))) showToast("error", t("ai.settingsDialog.saveFailed"));
    close();
  };

  return (
    <Modal
      title={t("ai.settingsDialog.title")}
      onCancel={close}
      closeOnBackdrop={false}
      actions={
        <>
          <button type="button" onClick={close}>
            {t("dialog.cancel")}
          </button>
          <button type="button" className="primary" disabled={!modelValid || !keyValid} onClick={submit} data-testid="ai-settings-save">
            {t("ai.settingsDialog.save")}
          </button>
        </>
      }
    >
      <div className="ai-settings">
        <p className="ai-privacy" data-testid="ai-privacy">
          {t("ai.settingsDialog.privacy")}
        </p>
        <p className="ai-privacy" data-testid="ai-privacy-persist">
          {t("ai.settingsDialog.persist")}
        </p>
        <label className="field-block">
          <span>{t("ai.settingsDialog.provider")}</span>
          <select data-testid="ai-provider" value={p} onChange={(e) => setDraft({ ...withKey(draft), provider: e.target.value as ProviderId })}>
            {PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {PROVIDER_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <label className="field-block">
          <span>{t("ai.settingsDialog.apiKey")}</span>
          <span className="ai-key-row">
            <input
              ref={keyRef}
              type={show ? "text" : "password"}
              data-testid="ai-key"
              autoComplete="new-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={t("ai.settingsDialog.keyPlaceholder")}
              onChange={(e) => setKeyLen(e.target.value.length)}
            />
            <button type="button" onClick={() => setShow(!show)} aria-pressed={show} data-testid="ai-key-toggle">
              {show ? t("ai.settingsDialog.hide") : t("ai.settingsDialog.show")}
            </button>
            <button type="button" onClick={() => { clearKey(); setKeyLen(0); }} data-testid="ai-key-clear">
              {t("ai.settingsDialog.deleteKey")}
            </button>
          </span>
        </label>
        <label className="field-block">
          <span>{t("ai.settingsDialog.model")}</span>
          <select
            data-testid="ai-model-select"
            value={isCustom ? CUSTOM : model}
            onChange={(e) => {
              if (e.target.value === CUSTOM) setCustom({ ...custom, [p]: true });
              else {
                setCustom({ ...custom, [p]: false });
                setModel(e.target.value);
              }
            }}
          >
            {MODEL_OPTIONS[p].map((m, i) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {i === 0 ? t("ai.settingsDialog.defaultSuffix") : ""}
              </option>
            ))}
            <option value={CUSTOM}>{t("ai.settingsDialog.customModel")}</option>
          </select>
        </label>
        {isCustom && (
          <label className="field-block">
            <span>{t("ai.settingsDialog.modelId")}</span>
            <input
              type="text"
              data-testid="ai-model-custom"
              spellCheck={false}
              value={model}
              aria-invalid={!modelValid}
              onChange={(e) => setModel(e.target.value)}
            />
            {!modelValid && <span className="ai-invalid">{t("ai.settingsDialog.modelInvalid")}</span>}
          </label>
        )}
      </div>
    </Modal>
  );
}
