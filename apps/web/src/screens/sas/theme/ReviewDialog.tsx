import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { useRequestReview, usePublishTheme } from './hooks';
import type { ReviewIntent } from './hooks';
import { describeProblem, fieldLabel, issueMessage, problemMessage } from './labels';
import type { ProblemView } from './labels';
import { PreviewFrame } from './PreviewFrame';
import type { PreviewMode } from './preview';
import { themeIssues } from './rules';
import type { ThemeConfig, ThemeVersion } from './types';

/** The multiplication sign on the close button. */
const CLOSE_GLYPH = '\u00d7';
const MIN_REASON_LENGTH = 10;

/** What the review is of: the saved draft, or an old version to restore. */
export type ReviewTarget = { kind: 'draft'; draftRevision: number } | { kind: 'restore'; sourceVersion: number };

export interface ReviewDialogProps {
  tenantId: string;
  tenantName: string;
  /** The published version the candidate is compared with and based on. */
  baseVersion: number;
  target: ReviewTarget;
  onClose(): void;
  /** Called once the version is published, with the version the server answered. */
  onPublished(version: ThemeVersion): void;
  /** The review or the publish found the screen out of date (VERSION_CONFLICT): the screen reloads what it holds. */
  onStale(): void;
}

// A logo is shown as a fact (there is one or there is none), never as an id.
function valueText(t: ReturnType<typeof useTranslation>['t'], field: string, value: string | null): string {
  if (field === 'logoAssetId') return value === null ? t('sas.theme.review.logo.none') : t('sas.theme.review.logo.some');
  return value === null || value === '' ? t('sas.theme.review.value.empty') : value;
}

/**
 * The review before anything is published (BR-SAS-17): what changes against the published version, whether the theme
 * passes the checks, the page as it will look, and a confirmation the person has to tick. A restore asks for its reason
 * first. The review token lives in this component only, and a publish uses it once.
 */
export function ReviewDialog({ tenantId, tenantName, baseVersion, target, onClose, onPublished, onStale }: ReviewDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const request = useRequestReview();
  const publish = usePublishTheme();
  const started = useRef(false);
  const [reason, setReason] = useState('');
  const [reasonTooShort, setReasonTooShort] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [mode, setMode] = useState<PreviewMode>('web');
  const restoring = target.kind === 'restore';
  const { mutate: askReview } = request;

  const ask = (intent: ReviewIntent): void => {
    setConfirmed(false);
    askReview({ tenantId, baseVersion, intent });
  };

  // A draft is reviewed as soon as the dialog opens (the reference keeps a second render from asking twice).
  useEffect(() => {
    if (started.current || target.kind !== 'draft') return;
    started.current = true;
    askReview({ tenantId, baseVersion, intent: { kind: 'draft', draftRevision: target.draftRevision } });
  }, [askReview, tenantId, baseVersion, target]);

  const submitReason = (event: FormEvent): void => {
    event.preventDefault();
    if (target.kind !== 'restore' || request.isPending) return;
    if (reason.trim().length < MIN_REASON_LENGTH) {
      setReasonTooShort(true);
      return;
    }
    setReasonTooShort(false);
    ask({ kind: 'restore', sourceVersion: target.sourceVersion, reason: reason.trim() });
  };

  const reviewed = request.data;
  const issues = reviewed === undefined ? [] : themeIssues(reviewed.candidate);
  const failure: ProblemView | undefined = request.isError ? describeProblem(request.error) : publish.isError ? describeProblem(publish.error) : undefined;
  const confirm = (): void => {
    if (reviewed === undefined || !confirmed || issues.length > 0 || publish.isPending) return;
    publish.mutate({ tenantId, token: reviewed.reviewToken, baseVersion: reviewed.baseVersion }, { onSuccess: onPublished });
  };

  const heading = restoring ? t('sas.theme.review.restore.title', { version: target.sourceVersion }) : t('sas.theme.review.draft.title');
  const needsReason = restoring && reviewed === undefined && !request.isPending;
  const again = failure?.kind === 'reviewInvalid';

  return (
    <NavigationDialog className="theme-review-overlay" onClose={onClose}>
      <section className="theme-review-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="theme-review-header">
          <div>
            <h2 id={titleId}>{heading}</h2>
            <p className="theme-help">{t('sas.theme.review.scope.text', { tenant: tenantName, version: baseVersion })}</p>
          </div>
          <button type="button" aria-label={t('sas.theme.review.close.label')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>

        {needsReason ? (
          <form className="theme-review-reason" onSubmit={submitReason} noValidate>
            <label htmlFor="theme-restore-reason">{t('sas.theme.review.reason.label')}</label>
            <textarea id="theme-restore-reason" value={reason} aria-invalid={reasonTooShort} onChange={(event) => setReason(event.target.value)} />
            {reasonTooShort ? (
              <small role="alert" className="field-error">
                {t('sas.theme.review.reason.tooShort')}
              </small>
            ) : null}
            <div className="theme-review-footer">
              <button type="button" onClick={onClose}>
                {t('sas.theme.review.back.action')}
              </button>
              <button type="submit" className="primary">
                {t('sas.theme.review.request.action')}
              </button>
            </div>
          </form>
        ) : null}

        {request.isPending ? (
          <p role="status" aria-busy="true">
            {t('sas.theme.review.loading.text')}
          </p>
        ) : null}

        {reviewed === undefined ? null : (
          <div className="theme-review-layout">
            <div>
              <h3>{t('sas.theme.review.changes.title', { count: reviewed.changes.length })}</h3>
              {reviewed.changes.length === 0 ? (
                <p>{t('sas.theme.review.changes.none')}</p>
              ) : (
                <table className="theme-diff">
                  <thead>
                    <tr>
                      <th>{t('sas.theme.review.col.field')}</th>
                      <th>{t('sas.theme.review.col.before')}</th>
                      <th>{t('sas.theme.review.col.after')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reviewed.changes.map((change) => (
                      <tr key={change.field} data-field={change.field}>
                        <td>{fieldLabel(t, change.field)}</td>
                        <td>{valueText(t, change.field, change.before)}</td>
                        <td>{valueText(t, change.field, change.after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className={`theme-validation${issues.length === 0 ? '' : ' invalid'}`}>
                {issues.length === 0 ? (
                  t('sas.theme.review.valid.text')
                ) : (
                  <ul>
                    {issues.map((issue, index) => (
                      <li key={`${issue.kind}-${issue.token ?? ''}-${index}`}>{issueMessage(t, issue)}</li>
                    ))}
                  </ul>
                )}
              </div>
              <p className="theme-help">{t('sas.theme.review.note.text')}</p>
            </div>
            <div>
              <label htmlFor="theme-review-mode">{t('sas.theme.review.preview.label')}</label>
              <select id="theme-review-mode" value={mode} onChange={(event) => setMode(event.target.value === 'phone' ? 'phone' : 'web')}>
                <option value="web">{t('sas.theme.preview.platform.web')}</option>
                <option value="phone">{t('sas.theme.preview.platform.phone')}</option>
              </select>
              <PreviewFrame config={reviewed.candidate as ThemeConfig} mode={mode} title={t('sas.theme.review.preview.title')} />
            </div>
          </div>
        )}

        {failure === undefined ? null : (
          <div className="callout warning" role="alert" data-problem={failure.kind}>
            <p>{problemMessage(t, failure.kind)}</p>
            {failure.issues.length === 0 ? null : (
              <ul>
                {failure.issues.map((issue, index) => (
                  <li key={`${issue.kind}-${issue.token ?? ''}-${index}`}>{issueMessage(t, issue)}</li>
                ))}
              </ul>
            )}
            {failure.kind === 'conflict' ? (
              <button type="button" onClick={onStale}>
                {t('sas.theme.error.reload.action')}
              </button>
            ) : null}
            {again ? (
              <button
                type="button"
                onClick={() => {
                  publish.reset();
                  request.reset();
                  if (target.kind === 'draft') ask({ kind: 'draft', draftRevision: target.draftRevision });
                }}
              >
                {t('sas.theme.error.reviewAgain.action')}
              </button>
            ) : null}
          </div>
        )}

        {reviewed === undefined ? null : (
          <div className="theme-review-footer">
            <label>
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              {t('sas.theme.review.confirm.label')}
            </label>
            <div className="actions">
              <button type="button" onClick={onClose}>
                {t('sas.theme.review.back.action')}
              </button>
              <button type="button" className="primary" disabled={!confirmed || issues.length > 0 || publish.isPending} onClick={confirm}>
                {restoring ? t('sas.theme.review.restore.confirm') : t('sas.theme.review.apply.confirm')}
              </button>
            </div>
          </div>
        )}
      </section>
    </NavigationDialog>
  );
}
