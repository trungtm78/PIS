import { useTranslation } from '../../../i18n';
import { effectLabel, methodLabel, roleLabel, statusLabel, weatherLabel } from './labels';
import { DIARY_ROLES, otherContent } from './model';
import type { DiaryLine } from './model';
import '../qms.css';

/** The three signatures in the order they are made, each as signed (by whom, how and what it is worth) or still to come; a signature over other content is shown as void. */
export function SignatureChain({ line }: { line: DiaryLine }) {
  const { t, locale } = useTranslation();
  const moment = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso));
  return (
    <ul className="qms-signers" data-testid="signers">
      {DIARY_ROLES.map((role) => {
        const signature = line.signatures.find((candidate) => candidate.role === role);
        return (
          <li key={role} data-role={role} data-signed={signature === undefined ? 'no' : signature.valid ? 'yes' : 'void'}>
            <strong>{roleLabel(t, role)}</strong>{' '}
            {signature === undefined ? (
              <span className="sub">{t('qms.diary.signature.missing')}</span>
            ) : (
              <span>
                {signature.signerName} · {methodLabel(t, signature.method)} · {moment(signature.signedAt)}
                {signature.certSerial === null ? null : <span data-testid="cert-serial"> · {t('qms.diary.signature.serial', { serial: signature.certSerial })}</span>}
                <small className="sub" data-testid="effect">
                  {' '}
                  · {effectLabel(t, signature.legalEffect)}
                </small>
                {signature.valid ? null : <span className="qms-badge warning"> {t('qms.diary.signature.void')}</span>}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The note on the value of an in-app signature: until the business confirms it (the CXN) the diary says that it is not settled, and an in-app signature is never called a digital one. */
export function LegalNote({ line }: { line: DiaryLine }) {
  const { t } = useTranslation();
  if (!line.signatureValue.awaitingConfirmation) return null;
  return (
    <p className="qms-badge warning" data-testid="legal-note" role="status">
      {t('qms.diary.legal.unconfirmed', { cxn: line.signatureValue.cxn })}
    </p>
  );
}

/** The rest of the content, field by field as it is kept: what is signed is all of it, so all of it is on the screen before anyone signs. */
export function OtherContent({ content }: { content: Record<string, unknown> }) {
  const { t } = useTranslation();
  const rest = otherContent(content);
  if (Object.keys(rest).length === 0) return null;
  return (
    <div data-testid="other-content">
      <h3>{t('qms.diary.field.other')}</h3>
      <pre className="qms-other">{JSON.stringify(rest, null, 2)}</pre>
    </div>
  );
}

/** What the diary says, read only: the summary, the weather, the workforce, the notes, the remark of the supervisor, the note of the owner and, for a correction, why. */
export function DiaryContent({ line }: { line: DiaryLine }) {
  const { t } = useTranslation();
  const summary = typeof line.content.summary === 'string' ? line.content.summary : '';
  const notes = typeof line.content.notes === 'string' ? line.content.notes : '';
  return (
    <>
      <dl className="qms-facts" data-testid="diary-content">
        <dt>{t('qms.diary.field.summary')}</dt>
        <dd data-testid="content-summary">{summary === '' ? t('qms.diary.none') : summary}</dd>
        <dt>{t('qms.diary.field.weather')}</dt>
        <dd data-testid="content-weather">{line.weatherCode === null ? t('qms.diary.none') : weatherLabel(t, line.weatherCode)}</dd>
        <dt>{t('qms.diary.field.workforce')}</dt>
        <dd data-testid="content-workforce">{line.workforceCount === null ? t('qms.diary.none') : line.workforceCount}</dd>
        {notes === '' ? null : (
          <>
            <dt>{t('qms.diary.field.notes')}</dt>
            <dd data-testid="content-notes">{notes}</dd>
          </>
        )}
        {line.supervisorRemark === null ? null : (
          <>
            <dt>{t('qms.diary.field.remark')}</dt>
            <dd data-testid="supervisor-remark">{line.supervisorRemark}</dd>
          </>
        )}
        {line.ownerNote === null ? null : (
          <>
            <dt>{t('qms.diary.field.ownerNote')}</dt>
            <dd data-testid="owner-note">{line.ownerNote}</dd>
          </>
        )}
        {line.correctionReason === null ? null : (
          <>
            <dt>{t('qms.diary.field.correctionReason')}</dt>
            <dd data-testid="correction-reason">{line.correctionReason}</dd>
          </>
        )}
        {line.lockReason === null ? null : (
          <>
            <dt>{t('qms.diary.field.lockReason')}</dt>
            <dd data-testid="lock-reason">{line.lockReason}</dd>
          </>
        )}
      </dl>
      <OtherContent content={line.content} />
    </>
  );
}

/** The line that names a diary wherever it is shown: the number, the contract, the day and the status. */
export function DiaryTitle({ line }: { line: DiaryLine }) {
  const { t } = useTranslation();
  return (
    <p data-testid="diary-title">
      <strong>{line.diaryNo}</strong> · {line.contract.code} · {line.recordDate} · <span data-testid="diary-status">{statusLabel(t, line.status)}</span>
      {line.correctionOfId === null ? null : <span className="qms-badge"> {t('qms.diary.correction.badge')}</span>}
    </p>
  );
}
