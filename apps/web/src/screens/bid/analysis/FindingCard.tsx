import { useTranslation } from '../../../i18n';
import { confidenceLabel, evidenceKindLabel, findingStatusLabel } from './labels';
import type { Evidence, Finding } from './model';
import './analysis.css';
import '../bid.css';

/** One citation under a finding: where it points, the words quoted or the figure computed, and whether the words were found on the page. */
function EvidenceLine({ evidence }: { evidence: Evidence }) {
  const { t } = useTranslation();
  return (
    <li className="bid-evidence" data-evidence={evidence.id} data-verified={evidence.verified ? 'true' : 'false'}>
      <p className="bid-evidence-head">
        <strong>{evidenceKindLabel(t, evidence.kind)}</strong>
        {evidence.documentVersionId === null ? null : (
          <span data-testid="document" title={evidence.documentVersionId}>
            {t('bid.analysis.evidence.document', { id: evidence.documentVersionId.slice(0, 8) })}
          </span>
        )}
        {evidence.pageIndex === null ? null : <span data-testid="page">{t('bid.analysis.evidence.page', { page: evidence.pageIndex + 1 })}</span>}
        <span className={evidence.verified ? 'bid-badge ok' : 'bid-badge danger'} data-testid="verified">
          {evidence.verified ? t('bid.analysis.evidence.verified') : t('bid.analysis.evidence.notFound')}
        </span>
      </p>
      {evidence.quote === null ? null : (
        <blockquote className="bid-quote" data-testid="quote">
          {evidence.quote}
        </blockquote>
      )}
      {evidence.figure === null ? null : (
        <p data-testid="figure">{evidence.figure.total === null ? t('bid.analysis.evidence.figure', { id: evidence.figure.id }) : t('bid.analysis.evidence.figureTotal', { id: evidence.figure.id, total: evidence.figure.total })}</p>
      )}
    </li>
  );
}

/**
 * A finding of the AI with the evidence under it (BID-09). It is always labelled as a proposal of the AI that an expert has to review; its signal is a kind of signal and never a probability of being right
 * (BR-BID-08); a finding that claimed without a citation found on its page was taken back to NEEDS_REVIEW and carries the flag of the missing source (BR-BID-07). There is nothing here that accepts it: the review is the expert's.
 */
export function FindingCard({ finding }: { finding: Finding }) {
  const { t } = useTranslation();
  return (
    <article className="card bid-finding" data-finding={finding.id} data-status={finding.status} aria-label={t('bid.analysis.finding.aria', { criterion: finding.criterionId })}>
      <header className="bid-ocr-head">
        <h3>{t('bid.analysis.finding.heading', { criterion: finding.criterionId })}</h3>
        <span className={finding.status === 'SUPPORTED' ? 'bid-badge ok' : finding.status === 'CONTRADICTED' ? 'bid-badge danger' : 'bid-badge warning'} data-testid="finding-status">
          {findingStatusLabel(t, finding.status)}
        </span>
        <span className="bid-badge" data-testid="ai-label">
          {t('bid.analysis.finding.aiLabel')}
        </span>
        {finding.missingSource ? (
          <span className="bid-badge danger" data-testid="missing-source">
            {t('bid.analysis.finding.missingSource')}
          </span>
        ) : null}
      </header>
      <p data-testid="finding-text">{finding.finding}</p>
      <p className="sub">
        <span data-testid="confidence">{t('bid.analysis.finding.signal', { signal: confidenceLabel(t, finding.confidenceType) })}</span>
        {' · '}
        <span data-testid="evidence-count">{t('bid.analysis.finding.evidenceCount', { count: finding.evidenceCount })}</span>
      </p>
      {finding.evidence.length === 0 ? (
        <p className="sub" data-testid="no-evidence">
          {t('bid.analysis.finding.noEvidence')}
        </p>
      ) : (
        <ul className="bid-evidence-list" aria-label={t('bid.analysis.evidence.aria', { criterion: finding.criterionId })}>
          {finding.evidence.map((evidence) => (
            <EvidenceLine key={evidence.id} evidence={evidence} />
          ))}
        </ul>
      )}
    </article>
  );
}
