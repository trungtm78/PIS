import { useTranslation } from '../../i18n';
import { useRecords } from './hooks';
import type { ChangeView } from './model';
import { successionKindLabel } from './succession-labels';
import { toProposedSuccession } from './succession-model';

/** What a SUCCESSION change request proposes, for the reviewer: the kind, the date, the legal basis and the entries that take over with their shares. */
export function SuccessionProposal({ change }: { change: ChangeView }) {
  const { t } = useTranslation();
  const records = useRecords(change.masterType);
  const proposed = toProposedSuccession(change.proposed);
  if (proposed === undefined) return <p className="callout warning">{t('mdm.approval.succession.unreadable.error')}</p>;
  const keyOf = (id: string): string => records.data?.find((record) => record.id === id)?.businessKey ?? id;
  return (
    <table className="table" data-testid="proposal" data-proposal="succession">
      <thead>
        <tr>
          <th>{t('mdm.approval.proposal.col.field')}</th>
          <th>{t('mdm.approval.proposal.col.after')}</th>
        </tr>
      </thead>
      <tbody>
        <tr data-field="kind">
          <th scope="row">{t('mdm.approval.succession.kind.text')}</th>
          <td>
            {proposed.kind} · {successionKindLabel(t, proposed.kind)}
          </td>
        </tr>
        <tr data-field="effectiveDate">
          <th scope="row">{t('mdm.approval.succession.effective.text')}</th>
          <td>{proposed.effectiveDate}</td>
        </tr>
        <tr data-field="legalBasis">
          <th scope="row">{t('mdm.approval.succession.basis.text')}</th>
          <td>{proposed.legalBasis}</td>
        </tr>
        <tr data-field="successors">
          <th scope="row">{t('mdm.approval.succession.successors.text')}</th>
          <td>
            {proposed.edges.map((edge) => (
              <div key={edge.successorRecordId} data-successor={edge.successorRecordId}>
                <code>{keyOf(edge.successorRecordId)}</code>
                {edge.sharePct === null ? null : <span className="sub"> {t('mdm.succession.share.text', { share: edge.sharePct })}</span>}
              </div>
            ))}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
