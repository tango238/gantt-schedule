import { t } from "../../i18n";
import { applyProposal, discardProposal } from "../../ai/aiActions";
import type { Proposal } from "../../ai/aiStore";
import { formatCounts, type Diff, type FieldChange } from "../../ai/plan";
import { useState } from "react";
import { useAiStore } from "../../ai/aiStore";
import { useAppStore } from "../../store/appStore";

const NOTES_PREVIEW = 80;

function AddedDetail({ a }: { a: Diff["added"][number] }) {
  const [open, setOpen] = useState(false);
  const parts: string[] = [];
  if (a.status) parts.push(`${t("ai.field.status")} ${a.status}`);
  if (a.hours !== undefined) parts.push(`${t("ai.field.hours")} ${a.hours}h`);
  if (a.resources) parts.push(`${t("ai.field.resources")} ${a.resources.join(", ")}`);
  if (a.colorLabel) parts.push(`${t("ai.field.colorLabel")} ${a.colorLabel}`);
  const long = a.notes !== undefined && a.notes.length > NOTES_PREVIEW;
  if (parts.length === 0 && a.notes === undefined) return null;
  return (
    <div className="ai-added-detail">
      {parts.length > 0 && <span className="ai-range">{parts.join(" / ")}</span>}
      {a.notes !== undefined && (
        <div className="ai-range ai-notes" data-testid="ai-added-notes">
          {t("ai.field.notes")}: {long && !open ? `${a.notes.slice(0, NOTES_PREVIEW)}…` : a.notes}{" "}
          {long && (
            <button type="button" className="ai-link" onClick={() => setOpen(!open)}>
              {open ? t("ai.diff.fold") : t("ai.diff.more")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const dateRange = (s?: string, e?: string): string => (s && e ? (s === e ? s : `${s} – ${e}`) : (s ?? e ?? ""));

function Changes({ list }: { list: FieldChange[] }) {
  return (
    <ul className="ai-changes">
      {list.map((c, i) => (
        <li key={i}>
          <span className="ai-field">{c.label}</span>
          <span className="ai-before">{c.before}</span>
          <span aria-hidden="true"> → </span>
          <span className="ai-after">{c.after}</span>
        </li>
      ))}
    </ul>
  );
}

export function DiffView({ diff }: { diff: Diff }) {
  const hasOther =
    diff.dependencies.length + diff.resources.length + diff.colorLabels.length + diff.project.length + diff.calendar.length > 0 ||
    diff.reordered ||
    diff.other;
  return (
    <div className="ai-diff">
      {diff.added.length > 0 && (
        <section data-testid="ai-diff-added">
          <h4>{t("ai.diff.added", { count: diff.added.length })}</h4>
          <ul>
            {diff.added.map((a) => (
              <li key={a.id} className="ai-added">
                <span className="ai-mark">+</span> {a.isCategory && <span className="ai-tag">{t("ai.diff.categoryTag")}</span>}{a.isMilestone && <span className="ai-tag">{t("ai.diff.milestoneTag")}</span>}{a.name}
                {dateRange(a.start, a.end) && <span className="ai-range"> ({dateRange(a.start, a.end)})</span>}
                {a.parentName && <span className="ai-range"> {t("ai.diff.under", { name: a.parentName })}</span>}
                <AddedDetail a={a} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {diff.changed.length > 0 && (
        <section data-testid="ai-diff-changed">
          <h4>{t("ai.diff.changed", { count: diff.changed.length })}</h4>
          <ul>
            {diff.changed.map((c) => (
              <li key={c.id}>
                {c.isCategory && <span className="ai-tag">{t("ai.diff.categoryTag")}</span>}{c.isMilestone && <span className="ai-tag">{t("ai.diff.milestoneTag")}</span>}<span className="ai-name">{c.name}</span>
                <Changes list={c.changes} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {diff.deleted.length > 0 && (
        <section data-testid="ai-diff-deleted">
          <h4>{t("ai.diff.deleted", { count: diff.deleted.length })}</h4>
          <ul>
            {diff.deleted.map((d) => (
              <li key={d.id} className="ai-deleted">
                <span className="ai-mark">−</span> {d.isCategory && <span className="ai-tag">{t("ai.diff.categoryTag")}</span>}{d.isMilestone && <span className="ai-tag">{t("ai.diff.milestoneTag")}</span>}{d.name}
              </li>
            ))}
          </ul>
        </section>
      )}
      {hasOther && (
        <section data-testid="ai-diff-other">
          <h4>{t("ai.diff.other")}</h4>
          <ul>
            {diff.reordered && <li>{t("ai.diff.reordered")}</li>}
            {diff.dependencies.map((d, i) => (
              <li key={`d${i}`}>
                {t(`ai.diff.dep.${d.kind}`, { succ: d.succName, pred: d.predName })}
              </li>
            ))}
            {diff.resources.map((r, i) => (
              <li key={`r${i}`}>
                {t(`ai.diff.resource.${r.kind}`, { name: r.name })}
                {r.detail && <span className="ai-range"> ({r.detail})</span>}
              </li>
            ))}
            {diff.colorLabels.map((r, i) => (
              <li key={`c${i}`}>
                {t(`ai.diff.colorLabel.${r.kind}`, { name: r.name })}
                {r.detail && <span className="ai-range"> ({r.detail})</span>}
              </li>
            ))}
            {diff.project.map((c, i) => (
              <li key={`p${i}`}>
                <span className="ai-field">{c.label}</span>
                <span className="ai-before">{c.before}</span> <span aria-hidden="true">→</span> <span className="ai-after">{c.after}</span>
              </li>
            ))}
            {diff.calendar.map((c, i) => (
              <li key={`k${i}`}>
                <span className="ai-field">{t("ai.field.calendar")}・{c.label}</span>
                <span className="ai-before">{c.before}</span> <span aria-hidden="true">→</span> <span className="ai-after">{c.after}</span>
              </li>
            ))}
            {diff.other && <li>{t("ai.diff.otherFields")}</li>}
          </ul>
        </section>
      )}
    </div>
  );
}

export function ProposalCard({ id, proposal }: { id: number; proposal: Proposal }) {
  const readOnly = useAppStore((s) => s.readOnly);
  // 応答待ち・検証中・適用中は適用できない (別の変更案が届くと置き換えられるため)。
  const busy = useAiStore((s) => s.status !== "idle");
  const { state } = proposal;
  return (
    <div className={`ai-card ai-card-${state}`} data-testid="ai-proposal" data-state={state}>
      <div className="ai-card-head">
        <strong>{t("ai.proposal.title")}</strong>
        <span className="ai-summary" data-testid="ai-proposal-summary">
          {formatCounts(proposal.diff)}
        </span>
      </div>
      {state !== "pending" && state !== "applying" && (
        <div className={`ai-result ai-result-${state}`} role="status" data-testid="ai-proposal-result">
          {t(`ai.state.${state}`)}
          {proposal.detail && <span className="ai-meta"> {proposal.detail}</span>}
        </div>
      )}
      {proposal.notice && state === "pending" && (
        <div className="ai-notice-line" role="status" data-testid="ai-proposal-notice">
          {proposal.notice}
        </div>
      )}
      <DiffView diff={proposal.diff} />
      {state === "pending" && (
        <div className="ai-card-actions">
          <button type="button" className="primary" disabled={readOnly || busy} onClick={() => void applyProposal(id)} data-testid="ai-apply">
            {t("ai.apply.button")}
          </button>
          <button type="button" onClick={() => discardProposal(id)} data-testid="ai-discard">
            {t("ai.discard")}
          </button>
          {readOnly && <span className="ai-meta">{t("ai.readOnlyNotice")}</span>}
        </div>
      )}
      {state === "applying" && <div className="ai-meta">{t("ai.apply.applying")}</div>}
    </div>
  );
}
