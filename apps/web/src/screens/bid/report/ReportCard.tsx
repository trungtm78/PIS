import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { findingStatusLabel } from '../analysis/labels';
import { useMoment } from '../analysis/hooks';
import { riskLabel, riskTone } from '../compare/labels';
import { formProblemMessage, notCoveredLabel, problemMessage, stageLabel, standingLabel, statusLabel, statusTone } from './labels';
import { MAX_DISSENT, MIN_DISSENT, describeProblem, stageOf, unreviewedCount, validateDissent } from './model';
import type { Report } from './model';
import './report.css';
import '../bid.css';

export interface ReportCardProps {
  report: Report;
  /** The caller is offered the signature: the draft waits for them, nothing changed since, the right is held and the session is not read-only. */
  signable: boolean;
  /** The dissent typed for this report. */
  dissent: string;
  /** The signature on this report is being sent: what was typed is what is sent, so the field does not change meanwhile. */
  pending: boolean;
  /** The signature on another report is being sent: one signature goes at a time, so its refusal is never taken for another report's. */
  busy: boolean;
  /** The refusal of the last attempt on this report, when there was one. */
  refusal: unknown;
  onDissent(value: string): void;
  onSign(): void;
}

/**
 * One report of BID-13: the stage of the minutes (the signatures, DOC, issued), what the experts decided criterion by criterion with the weighted score of each proposal (no ranking, no winner), the conclusion, who
 * signed and who is still awaited, and the dissent in the words of the members. The member signs here, with a dissent if they hold one.
 */
export function ReportCard({ report, signable, dissent, pending, busy, refusal, onDissent, onSign }: ReportCardProps) {
  const { t } = useTranslation();
  const moment = useMoment();
  const fieldId = useId();
  const [submitted, setSubmitted] = useState(false);
  const problem = validateDissent(dissent);
  const stage = stageOf(report);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (pending || busy || problem !== undefined) return;
    onSign();
  };
  const { summary } = report;
  return (
    <article className="card bid-report" data-report={report.id} data-status={report.status} aria-label={t('bid.report.card.aria', { code: report.package.code, at: moment(report.createdAt) })}>
      <header className="bid-report-head">
        <strong data-testid="created">{t('bid.report.card.created', { name: report.createdBy.displayName, at: moment(report.createdAt) })}</strong>
        <span className={`bid-badge ${statusTone(report.status)}`} data-testid="status">
          {statusLabel(t, report.status)}
        </span>
      </header>
      <p className="sub" data-testid="stage">
        {stageLabel(t, stage)}
        {report.documentStatus === null ? null : <span data-testid="doc-state"> · {t('bid.report.doc.state', { state: report.documentStatus })}</span>}
      </p>
      {report.stale ? (
        <p className="callout warning" role="note" data-testid="stale">
          {t('bid.report.stale.notice')}
        </p>
      ) : null}
      {report.recalledAt === null ? null : (
        <p className="callout warning" role="note" data-testid="recalled">
          {t('bid.report.recalled.notice', { at: moment(report.recalledAt) })}
        </p>
      )}
      {report.reportDocumentId === null ? null : (
        <p data-testid="document">
          {t('bid.report.document.label')} <code data-testid="document-id">{report.reportDocumentId}</code>
          {report.issuedAt === null ? null : <small className="sub"> · {t('bid.report.document.issuedAt', { at: moment(report.issuedAt) })}</small>}
        </p>
      )}

      <h3>{t('bid.report.proposals.title')}</h3>
      <div className="bid-report-scroll">
        <table data-testid="summary" aria-label={t('bid.report.proposals.caption')}>
          <thead>
            <tr>
              <th scope="col">{t('bid.report.table.criterion')}</th>
              {summary.proposals.map((proposal) => (
                <th scope="col" key={proposal.proposalId} data-testid="proposal-head">
                  {proposal.contractor.name}
                  <br />
                  <small className="sub" data-testid="weighted-score">
                    {proposal.weightedScore === null ? t('bid.report.table.noScore') : t('bid.report.table.weighted', { score: proposal.weightedScore })}
                  </small>
                  {proposal.mandatoryNotMet === 0 ? null : (
                    <small className="sub" data-testid="mandatory-not-met">
                      {' · '}
                      {t('bid.report.table.mandatoryNotMet', { count: proposal.mandatoryNotMet })}
                    </small>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.rows.map((row) => (
              <tr key={row.criterion.code} data-criterion={row.criterion.code}>
                <th scope="row">
                  {row.criterion.name} <small className="sub">{row.criterion.code}</small>
                  {row.criterion.mandatory ? <small className="sub"> · {t('bid.report.table.mandatory')}</small> : null}
                </th>
                {row.cells.map((cell) => (
                  <td key={cell.proposalId} data-risk={cell.risk} data-testid="cell">
                    {cell.decided === null ? (
                      <span className="bid-badge" data-testid="undecided">
                        {t('bid.report.table.undecided')}
                      </span>
                    ) : (
                      <>
                        <span data-testid="decided-status">{findingStatusLabel(t, cell.decided.status)}</span>
                        {cell.decided.score === null ? null : <span data-testid="decided-score"> · {t('bid.report.table.score', { score: cell.decided.score })}</span>}
                        <br />
                        <span className={`bid-badge ${riskTone(cell.risk)}`} data-testid="risk">
                          {riskLabel(t, cell.risk)}
                        </span>
                      </>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {summary.notCovered.length === 0 ? null : (
        <div data-testid="not-covered">
          <h3>{t('bid.report.notCovered.title')}</h3>
          <ul className="bid-report-list">
            {summary.notCovered.map((entry) => (
              <li key={entry.proposalId}>
                {entry.contractorName}: {notCoveredLabel(t, entry.reason)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="sub" data-testid="award-note">
        {t('bid.report.award.note')}
      </p>

      <h3>{t('bid.report.conclusion.title')}</h3>
      <blockquote className="bid-quote bid-report-conclusion" data-testid="conclusion">
        {summary.conclusion}
      </blockquote>

      <h3>{t('bid.report.signatures.title')}</h3>
      {report.signedOffBy.length === 0 ? (
        <p className="sub" data-testid="no-signatures">
          {t('bid.report.signatures.none')}
        </p>
      ) : (
        <ul className="bid-report-list" data-testid="signatures">
          {report.signedOffBy.map((signature) => (
            <li key={signature.membershipId} data-member={signature.membershipId}>
              {signature.displayName}
              {signature.signedAt === null ? null : <small className="sub"> · {moment(signature.signedAt)}</small>}
              {signature.withDissent ? (
                <span className="bid-badge warning" data-testid="with-dissent">
                  {t('bid.report.signatures.withDissent')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {report.awaiting.length === 0 ? null : (
        <div data-testid="awaiting">
          <h3>{t('bid.report.awaiting.title')}</h3>
          <ul className="bid-report-list">
            {report.awaiting.map((member) => (
              <li key={member.membershipId} data-member={member.membershipId}>
                {member.displayName} <small className="sub">· {standingLabel(t, member.standing)}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.dissentingOpinions.length === 0 ? null : (
        <div data-testid="dissents">
          <h3>{t('bid.report.dissent.title')}</h3>
          {report.dissentingOpinions.map((opinion) => (
            <blockquote key={`${opinion.membershipId}:${opinion.recordedAt}`} className="bid-quote bid-report-conclusion" data-member={opinion.membershipId}>
              <strong>{opinion.displayName}</strong> <small className="sub">{moment(opinion.recordedAt)}</small>
              <br />
              {opinion.text}
            </blockquote>
          ))}
        </div>
      )}

      {/* A refusal can be the very reason the form is gone (the report went stale, another member completed it), so it is not part of the form. */}
      {refusal === undefined || refusal === null ? null : (
        <p className="callout warning" role="alert" data-testid="refusal">
          {problemMessage(t, describeProblem(refusal), unreviewedCount(refusal))}
        </p>
      )}
      {!signable ? null : (
        <form onSubmit={submit} noValidate data-testid="sign-form">
          <div className="field">
            <label htmlFor={fieldId}>{t('bid.report.sign.dissent.label')}</label>
            <textarea id={fieldId} rows={4} readOnly={pending} disabled={busy} value={dissent} onChange={(event) => onDissent(event.target.value)} />
            <small className="sub">{t('bid.report.sign.dissent.hint', { min: MIN_DISSENT, max: MAX_DISSENT })}</small>
            {submitted && problem !== undefined ? (
              <small role="alert" className="field-error">
                {formProblemMessage(t, problem)}
              </small>
            ) : null}
          </div>
          <div className="formfooter">
            <button type="submit" className="primary" disabled={pending || busy}>
              {pending ? t('bid.report.sign.pending') : t('bid.report.sign.submit')}
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
