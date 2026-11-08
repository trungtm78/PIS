import { useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import { ConfirmDialog } from '../../ui';
import { useReload, useResolve } from './feed-hooks';
import { differenceFieldLabel, problemText, resolutionEffect, resolutionIssueLabel, resolutionLabel } from './feed-labels';
import { EMPTY_RESOLUTION, MAX_EVIDENCE, RESOLUTION_KINDS, RESOLUTION_MIN_REASON, amountText, describeProblem, percentText, resolutionBody, resolutionKindOf, validateResolution, vietnamToday } from './feed-model';
import type { Difference, Problem, ResolutionErrors, ResolutionField, ResolutionForm } from './feed-model';
import { DASH } from './feed-parts';
import './feed.css';

export interface ResolveDialogProps {
  difference: Difference;
  onClose: () => void;
  /** Called after the resolution was made, with the sentence of the receipt. */
  onDone: (receipt: string) => void;
}

const SERVER_FIELD: Readonly<Record<string, ResolutionField>> = { kind: 'kind', reason: 'reason', evidence_ref: 'evidenceRef', review_on: 'reviewOn' };

/**
 * Settles one difference with one of four moves: accept the feed, keep ours, dispute (needs a reference to the evidence) or waive (needs a day to review again, inside one year). A reason is always needed, longer for a dispute and a waiver.
 * The person who made the figures does not settle the item; the server judges it again and the refusal is said in place.
 */
export function ResolveDialog({ difference, onClose, onDone }: ResolveDialogProps) {
  const { t, locale } = useTranslation();
  const resolve = useResolve();
  const reload = useReload();
  const [form, setForm] = useState<ResolutionForm>(EMPTY_RESOLUTION);
  const [errors, setErrors] = useState<ResolutionErrors>({});
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const sending = useRef(false);
  const kind = form.kind;
  const minReason = kind === '' ? 10 : RESOLUTION_MIN_REASON[kind];

  const change = <K extends keyof ResolutionForm>(key: K, value: ResolutionForm[K]): void => {
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors({});
    setProblem(undefined);
  };
  const named = (field: ResolutionField): string | undefined => {
    const own = errors[field];
    if (own !== undefined) return own === 'required' && field === 'kind' ? t('feed.diff.issue.kind') : resolutionIssueLabel(t, own, minReason);
    return problem?.kind === 'validation' && problem.field !== undefined && SERVER_FIELD[problem.field] === field ? problemText(t, problem) : undefined;
  };
  const otherProblem = problem !== undefined && !(problem.kind === 'validation' && problem.field !== undefined && SERVER_FIELD[problem.field] !== undefined) ? problemText(t, problem) : undefined;
  const error = Object.keys(errors).length > 0 ? t('feed.diff.invalid.summary') : otherProblem;
  const reasonError = named('reason');

  const confirm = (reason?: string): void => {
    if (sending.current) return;
    const next: ResolutionForm = { ...form, reason: reason ?? '' };
    setForm(next);
    const found = validateResolution(next, vietnamToday());
    setErrors(found);
    setProblem(undefined);
    const body = resolutionBody(next);
    if (Object.keys(found).length > 0 || body === undefined) return;
    sending.current = true;
    resolve.mutate(
      { id: difference.id, version: difference.version, body },
      {
        onSuccess: () => {
          sending.current = false;
          onDone(t('feed.diff.success.resolved', { code: difference.feedProjectCode, how: resolutionLabel(t, body.kind) }));
          onClose();
        },
        onError: (failure) => {
          sending.current = false;
          setProblem(describeProblem(failure));
        },
      },
    );
  };

  const kindMessage = named('kind');
  const evidenceMessage = named('evidenceRef');
  const reviewMessage = named('reviewOn');
  return (
    <ConfirmDialog
      open
      title={t('feed.diff.resolve.title')}
      context={[
        { label: t('feed.diff.column.project'), value: difference.ourCode === null ? difference.feedProjectCode : `${difference.feedProjectCode} → ${difference.ourCode}` },
        { label: t('feed.diff.column.field'), value: `${differenceFieldLabel(t, difference.field)} · ${difference.fiscalYear}` },
        { label: t('feed.diff.column.feed'), value: amountText(difference.feedValue, locale) },
        { label: t('feed.diff.column.ours'), value: difference.ourValue === null ? t('feed.diff.cell.missingOurs') : amountText(difference.ourValue, locale) },
        { label: t('feed.diff.column.delta'), value: difference.delta === null ? DASH : `${amountText(difference.delta, locale)}${difference.deltaPct === null ? '' : ` (${percentText(difference.deltaPct, locale)})`}` },
      ]}
      confirmLabel={t('feed.diff.resolve.confirm.action')}
      cancelLabel={t('feed.common.dialog.cancel.action')}
      pending={resolve.isPending}
      reason={{ label: t('feed.diff.resolve.reason.label'), required: true, minLength: minReason, hint: t('feed.diff.resolve.reason.hint', { count: minReason }) }}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={confirm}
    >
      <div className="feed-form">
        <p className="feed-note">{t('feed.diff.resolve.maker.note')}</p>
        <div className="field">
          <label htmlFor="feed-resolve-kind">{t('feed.diff.resolve.kind.label')}</label>
          <select id="feed-resolve-kind" value={kind} aria-invalid={kindMessage !== undefined} onChange={(event) => change('kind', resolutionKindOf(event.target.value) ?? '')}>
            <option value="">{t('feed.diff.resolve.kind.choose')}</option>
            {RESOLUTION_KINDS.map((one) => (
              <option key={one} value={one}>
                {resolutionLabel(t, one)}
              </option>
            ))}
          </select>
          {kindMessage !== undefined && <span className="feed-error">{kindMessage}</span>}
        </div>
        {kind !== '' && (
          <p className="feed-note" data-testid="resolve-effect">
            {resolutionEffect(t, kind)}
          </p>
        )}
        {kind === 'DISPUTE' && (
          <div className="field">
            <label htmlFor="feed-resolve-evidence">{t('feed.diff.resolve.evidence.label')}</label>
            <input id="feed-resolve-evidence" value={form.evidenceRef} maxLength={MAX_EVIDENCE + 20} aria-invalid={evidenceMessage !== undefined} autoComplete="off" onChange={(event) => change('evidenceRef', event.target.value)} />
            <span className="sub">{t('feed.diff.resolve.evidence.hint')}</span>
            {evidenceMessage !== undefined && <span className="feed-error">{evidenceMessage}</span>}
          </div>
        )}
        {kind === 'WAIVE' && (
          <div className="field">
            <label htmlFor="feed-resolve-review">{t('feed.diff.resolve.review.label')}</label>
            <input id="feed-resolve-review" type="date" value={form.reviewOn} aria-invalid={reviewMessage !== undefined} onChange={(event) => change('reviewOn', event.target.value)} />
            <span className="sub">{t('feed.diff.resolve.review.hint')}</span>
            {reviewMessage !== undefined && <span className="feed-error">{reviewMessage}</span>}
          </div>
        )}
        {reasonError !== undefined && <span className="feed-error">{reasonError}</span>}
        {problem?.kind === 'versionConflict' && (
          <button
            type="button"
            className="ui-button ui-button--outline ui-button--small"
            onClick={() => {
              void reload();
              onClose();
            }}
          >
            {t('feed.common.problem.reload.action')}
          </button>
        )}
      </div>
    </ConfirmDialog>
  );
}
