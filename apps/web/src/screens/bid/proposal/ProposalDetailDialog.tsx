import { useId } from 'react';
import { useTranslation } from '../../../i18n';
import { NavigationDialog } from '../../../shell/NavigationDialog';
import { formatVnd } from '../plan-model';
import { partLabel, statusLabel } from './labels';
import { momentText, sizeText } from './model';
import type { Proposal } from './model';
import '../bid.css';

/** The multiplication sign on the close button of a dialog. */
const CLOSE_GLYPH = '\u00d7';

export interface ProposalDetailDialogProps {
  proposal: Proposal;
  onClose(): void;
}

/**
 * A proposal in full (BID-05): who handed it in and when, the price and the files by part, with what each file is. The files themselves are not served here: the evidence of the
 * analysis opens them, each time under the access rules of the proposal.
 */
export function ProposalDetailDialog({ proposal, onClose }: ProposalDetailDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <NavigationDialog className="catalog command-mode" onClose={onClose}>
      <section className="command-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="proposal-detail">
        <div className="command-titlebar">
          <strong id={titleId}>{t('bid.proposals.detail.title', { name: proposal.contractorName })}</strong>
          <button type="button" className="icon-button" aria-label={t('bid.proposals.detail.close')} onClick={onClose}>
            {CLOSE_GLYPH}
          </button>
        </div>
        <div className="bid-dialog-body">
          <dl className="bid-facts">
            <dt>{t('bid.proposals.column.revision')}</dt>
            <dd>{t('bid.proposals.revision.text', { revision: proposal.revision })}</dd>
            <dt>{t('bid.proposals.column.state')}</dt>
            <dd>{statusLabel(t, proposal.status)}</dd>
            <dt>{t('bid.proposals.column.received')}</dt>
            <dd>{momentText(proposal.submittedAt)}</dd>
            <dt>{t('bid.proposals.column.price')}</dt>
            <dd data-testid="detail-price">{proposal.bidPriceVnd === null ? t('bid.proposals.price.none') : formatVnd(proposal.bidPriceVnd)}</dd>
          </dl>
          <h3>{t('bid.proposals.files.title')}</h3>
          <ul className="bid-documents" data-testid="detail-files">
            {proposal.documents.map((file) => (
              <li key={file.id} data-part={file.part}>
                <strong>{file.title}</strong>
                <span>{` ${partLabel(t, file.part)} · ${t('bid.proposals.detail.pages', { pages: file.pageCount })} · ${sizeText(file.sizeBytes)}`}</span>
              </li>
            ))}
          </ul>
          <div className="formfooter">
            <button type="button" className="primary" onClick={onClose}>
              {t('bid.proposals.detail.close')}
            </button>
          </div>
        </div>
      </section>
    </NavigationDialog>
  );
}
