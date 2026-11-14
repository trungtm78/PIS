import { useTranslation } from '../../../i18n';
import { StatusPill } from '../../../ui';
import { dayText } from '../model';
import { docKindWord, legalStateWord } from './labels';
import { isLapsed, legalIcon, legalTone } from './model';
import type { LegalBasis } from './model';
import './process.css';

export interface LegalBasisListProps {
  basis: readonly LegalBasis[];
  /** What the list is the legal ground of (the name of a step or of a task): the accessible name of the list. */
  of: string;
  testId?: string;
  /** Where the ground at an index comes from (the task, its step, or both), already translated: shown as a small note. */
  origin?: (index: number) => string;
}

/**
 * The legal grounds of a step or of a task (R45): the document as the shared catalogue names it (kind, number, title, issuer, days of effect), the article the template cites, whether a legal officer confirmed the citation, and
 * whether the document may still be cited today. A document that lapsed or was replaced is said in words and with the code of what replaced it; the colour is never the only cue.
 */
export function LegalBasisList({ basis, of, testId, origin }: LegalBasisListProps) {
  const { t } = useTranslation();
  if (basis.length === 0) {
    return (
      <p className="pwf-hint" data-testid={testId === undefined ? undefined : `${testId}-empty`}>
        {t('pwf.process.legal.none.text')}
      </p>
    );
  }
  return (
    <ul className="pwf-legal" aria-label={t('pwf.process.legal.list.label', { of })} data-testid={testId}>
      {basis.map((one, index) => (
        <li key={`${one.document_code}|${one.article ?? ''}`} data-document={one.document_code} data-state={one.state}>
          <div className="pwf-legal__head">
            <strong>{one.number === null ? one.document_code : `${docKindWord(t, one.doc_kind)} ${one.number}`}</strong>
            <StatusPill tone={legalTone(one.state)} icon={legalIcon(one.state)}>
              {legalStateWord(t, one.state)}
            </StatusPill>
            <StatusPill tone={one.verification === 'VERIFIED' && one.document_verification === 'VERIFIED' ? 'success' : 'warning'} icon={one.verification === 'VERIFIED' && one.document_verification === 'VERIFIED' ? '✓' : '⚠'}>
              {one.verification === 'VERIFIED' && one.document_verification === 'VERIFIED' ? t('pwf.process.legal.verified.word') : t('pwf.process.legal.unverified.word')}
            </StatusPill>
            {origin === undefined ? null : <span className="pwf-hint">{origin(index)}</span>}
          </div>
          {one.title === null ? null : <div>{one.title}</div>}
          <dl className="pwf-legal__facts">
            <dt>{t('pwf.process.legal.article.label')}</dt>
            <dd>{one.article ?? t('pwf.process.legal.article.pending')}</dd>
            {one.issuer === null ? null : (
              <>
                <dt>{t('pwf.process.legal.issuer.label')}</dt>
                <dd>{one.issuer}</dd>
              </>
            )}
            {one.effective_from === null ? null : (
              <>
                <dt>{t('pwf.process.legal.effect.label')}</dt>
                <dd>{one.effective_to === null ? t('pwf.process.legal.effect.open', { from: dayText(one.effective_from) }) : t('pwf.process.legal.effect.closed', { from: dayText(one.effective_from), to: dayText(one.effective_to) })}</dd>
              </>
            )}
          </dl>
          {isLapsed(one.state) ? (
            <p className="callout warning pwf-notice" role="status">
              {one.superseded_by === null ? t('pwf.process.legal.lapsed.text') : t('pwf.process.legal.replaced.text', { code: one.superseded_by_number ?? one.superseded_by })}
            </p>
          ) : null}
          {one.state === 'UNKNOWN' ? (
            <p className="callout warning pwf-notice" role="status">
              {t('pwf.process.legal.missing.text', { code: one.document_code })}
            </p>
          ) : null}
          {one.note === null ? null : <p className="pwf-hint">{one.note}</p>}
          {one.url === null ? null : (
            <p>
              <a href={one.url} target="_blank" rel="noreferrer noopener">
                {t('pwf.process.legal.source.link')}
              </a>
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
