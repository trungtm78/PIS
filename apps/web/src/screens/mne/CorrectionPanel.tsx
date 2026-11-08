import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { useFrozenSnapshots } from '../dis/rates/hooks';
import { Field } from './components';
import { useCorrectReport } from './hooks';
import { reportProblemMessage } from './labels';
import { describeReportProblem } from './report-model';
import { CORRECTION_MAX, CORRECTION_MIN, correctionBody, correctionProblem, mayCorrect, resourceIdOf } from './report-create-model';
import type { ReportView } from './types';

interface Props {
  report: ReportView;
  /** Opens the revision that was made. */
  onCorrected: (reportId: string) => void;
}

/**
 * The correction of an issued report (MNE-10, correctMneReport): a new revision with the reason, optionally filled again from another frozen snapshot. The revision it replaces is kept as it was issued; the new one is
 * a draft that goes through review and approval and is issued again through DOC, so the person who corrects does not approve their own correction.
 */
export function CorrectionPanel({ report, onCorrected }: Props) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const correct = useCorrectReport();
  const snapshots = useFrozenSnapshots();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [snapshotId, setSnapshotId] = useState('');
  const [tried, setTried] = useState(false);
  const allowed = mayCorrect(report, permissions, mode === 'READ_ONLY');
  if (!allowed) {
    return report.status === 'ISSUED' || report.status === 'EXPORTED' || report.status === 'SUBMITTED_EXTERNAL' ? (
      <p className="sub" data-testid="correct-denied">
        {t('mne.correct.denied')}
      </p>
    ) : null;
  }
  const problem = tried ? correctionProblem(reason) : undefined;
  const failure = correct.isError ? describeReportProblem(correct.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTried(true);
    if (correctionProblem(reason) !== undefined) return;
    correct.mutate({ id: report.id, version: report.version, body: correctionBody(reason, snapshotId) }, { onSuccess: (answer) => onCorrected(resourceIdOf(answer)) });
  };
  if (!open) {
    return (
      <div className="mne-actions">
        <button type="button" className="ui-button ui-button--outline" onClick={() => setOpen(true)} data-testid="correct-open">
          {t('mne.correct.open')}
        </button>
      </div>
    );
  }
  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="correct-title" data-testid="correct-form">
      <h2 id="correct-title">{t('mne.correct.title', { revision: report.revision })}</h2>
      <p className="sub">{t('mne.correct.help')}</p>
      <Field id="correct-reason" label={t('mne.correct.reason.label')} hint={t('mne.correct.reason.hint', { min: CORRECTION_MIN, max: CORRECTION_MAX })} error={problem === undefined ? undefined : problem === 'short' ? t('mne.correct.error.short', { min: CORRECTION_MIN }) : t('mne.correct.error.long', { max: CORRECTION_MAX })}>
        <textarea id="correct-reason" rows={4} value={reason} onChange={(event) => setReason(event.target.value)} aria-invalid={problem !== undefined} />
      </Field>
      <Field id="correct-snapshot" label={t('mne.correct.snapshot.label')} hint={t('mne.correct.snapshot.hint')} error={undefined}>
        <select id="correct-snapshot" value={snapshotId} onChange={(event) => setSnapshotId(event.target.value)} disabled={snapshots.isLoading}>
          <option value="">{t('mne.correct.snapshot.keep')}</option>
          {(snapshots.data ?? []).map((one) => (
            <option key={one.id} value={one.id}>
              {t('mne.report.snapshot.option', { date: one.asOfDate })}
            </option>
          ))}
        </select>
      </Field>
      {failure === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="correct-problem">
          {reportProblemMessage(t, failure, (key) => key)}
        </p>
      )}
      <div className="mne-actions">
        <button type="submit" className="ui-button ui-button--primary" disabled={correct.isPending} data-testid="correct-submit">
          {correct.isPending ? t('mne.report.action.working') : t('mne.correct.submit')}
        </button>
        <button type="button" className="ui-button ui-button--outline" onClick={() => setOpen(false)} data-testid="correct-cancel">
          {t('mne.create.cancel')}
        </button>
      </div>
    </form>
  );
}
