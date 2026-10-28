import { useTranslation } from '../../../i18n';
import { effectLabel, methodLabel, resolutionLabel, roleLabel, statusLabel, weatherLabel } from './labels';
import { DIARY_ROLES, otherContent, pendingConflicts } from './model';
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

/** Everything that a content says, field by field: the work, the weather, the workforce, the notes and whatever else it holds. A copy is shown whole before anyone takes it or sets it aside. */
export function ContentFacts({ content, prefix }: { content: Record<string, unknown>; prefix: string }) {
  const { t } = useTranslation();
  const summary = typeof content.summary === 'string' ? content.summary : '';
  const notes = typeof content.notes === 'string' ? content.notes : '';
  return (
    <>
      <dl className="qms-facts">
        <dt>{t('qms.diary.field.summary')}</dt>
        <dd data-testid={`${prefix}-summary`}>{summary === '' ? t('qms.diary.none') : summary}</dd>
        <dt>{t('qms.diary.field.weather')}</dt>
        <dd data-testid={`${prefix}-weather`}>{typeof content.weather_code === 'string' ? weatherLabel(t, content.weather_code) : t('qms.diary.none')}</dd>
        <dt>{t('qms.diary.field.workforce')}</dt>
        <dd data-testid={`${prefix}-workforce`}>{typeof content.workforce_count === 'number' ? content.workforce_count : t('qms.diary.none')}</dd>
        {notes === '' ? null : (
          <>
            <dt>{t('qms.diary.field.notes')}</dt>
            <dd data-testid={`${prefix}-notes`}>{notes}</dd>
          </>
        )}
      </dl>
      <OtherContent content={content} />
    </>
  );
}

/** The copies that devices left for the diary, with what each said and, for the ones that were settled, how and why: nothing a device wrote is dropped without a trace. */
export function ConflictPanel({ line }: { line: DiaryLine }) {
  const { t, locale } = useTranslation();
  if (line.conflicts.length === 0) return null;
  const moment = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso));
  const waiting = pendingConflicts(line).length;
  return (
    <section data-testid="conflicts" aria-label={t('qms.diary.conflicts.title')}>
      <h2>{t('qms.diary.conflicts.title')}</h2>
      <p className="sub">{t('qms.diary.conflicts.hint')}</p>
      <ul className="qms-actions">
        {line.conflicts.map((copy) => (
          <li key={copy.id} data-conflict={copy.id} data-state={copy.state}>
            <strong>{copy.diaryNo}</strong> · {copy.author} · {moment(copy.createdAt)}
            {copy.deviceId === null ? null : <span className="sub"> · {t('qms.diary.conflicts.device', { device: copy.deviceId })}</span>}{' '}
            <span className={copy.state === 'RESOLVED' ? 'qms-badge ok' : 'qms-badge warning'} data-testid="conflict-state">
              {copy.state === 'RESOLVED' ? t('qms.diary.conflicts.resolved') : t('qms.diary.conflicts.pending')}
            </span>
            <ContentFacts content={copy.content} prefix="conflict" />
            {copy.resolution === null ? null : (
              <p className="sub" data-testid="conflict-resolution">
                {t('qms.diary.conflicts.how', { resolution: resolutionLabel(t, copy.resolution) })} — {copy.note}
              </p>
            )}
          </li>
        ))}
      </ul>
      {waiting === 0 ? null : (
        <p className="qms-badge warning" data-testid="conflicts-waiting" role="status">
          {t('qms.diary.conflicts.count', { count: waiting })}
        </p>
      )}
    </section>
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
