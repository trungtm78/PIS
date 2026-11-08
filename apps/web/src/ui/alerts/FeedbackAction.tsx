import { ApiError } from '@machvon/api-client';
import { useId, useState } from 'react';
import { useTranslation } from '../../i18n';
import { feedbackReasonLabel } from '../../screens/gov10/parts';
import { useReportAlertWrong } from '../../screens/gov10/hooks';
import { FEEDBACK_REASONS } from '../../screens/gov10/model';
import { ConfirmDialog } from '../ConfirmDialog';
import type { AlertItem } from './types';
import './alerts.css';

const NOTE_MIN = 5;

/**
 * "This alert is wrong" (G2-9): a button on an item of the alert centre that opens a short form (a reason from the list, and words when the reason is "other") and reports it to the owner of the alert type. It never hides
 * or silences the item: after the report the item stays exactly where it was and shows that it was reported. The server refuses a second open report of the same person about the same item, and the answer is said here.
 */
export function FeedbackAction({ item }: { item: Pick<AlertItem, 'source' | 'id' | 'title'> }) {
  const { t } = useTranslation();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reported, setReported] = useState(false);
  const report = useReportAlertWrong();
  const already = report.error instanceof ApiError && report.error.code === 'ALERT_FEEDBACK_ALREADY_REPORTED';
  const refusal = report.error === null ? undefined : already ? t('gov10.feedback.report.already') : report.error instanceof ApiError && report.error.status === 404 ? t('gov10.feedback.report.gone') : t('gov10.feedback.report.failed');
  if (reported || already) return <span className="mv-alert-note" data-testid="alert-reported">{t('gov10.feedback.report.reported')}</span>;
  return (
    <>
      <button
        type="button"
        className="mv-alert-button"
        aria-haspopup="dialog"
        onClick={() => {
          report.reset();
          setReason('');
          setOpen(true);
        }}
      >
        {t('gov10.feedback.report.button')}
      </button>
      {open ? (
        <ConfirmDialog
          open
          title={t('gov10.feedback.report.title')}
          context={[{ label: t('gov10.feedback.report.item'), value: item.title }]}
          confirmLabel={t('gov10.feedback.report.send')}
          cancelLabel={t('gov10.cancel')}
          pending={report.isPending}
          onCancel={() => setOpen(false)}
          onConfirm={(note) => {
            if (reason === '') return;
            report.mutate({ source: item.source, sourceId: item.id, reason, ...(note === undefined || note.trim() === '' ? {} : { note: note.trim() }) }, { onSuccess: () => { setReported(true); setOpen(false); } });
          }}
          reason={{ label: t('gov10.feedback.report.note'), required: reason === 'OTHER', minLength: reason === 'OTHER' ? NOTE_MIN : 0, hint: t('gov10.feedback.report.hint') }}
          {...(refusal === undefined || already ? {} : { error: refusal })}
        >
          <label htmlFor={reasonId} className="gov10-field">
            <span>{t('gov10.feedback.report.reason')}</span>
            <select id={reasonId} value={reason} onChange={(event) => setReason(event.target.value)}>
              <option value="">{t('gov10.feedback.report.choose')}</option>
              {FEEDBACK_REASONS.map((entry) => (
                <option key={entry} value={entry}>
                  {feedbackReasonLabel(t, entry)}
                </option>
              ))}
            </select>
          </label>
          <p>{t('gov10.feedback.report.notHidden')}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
