import { useTranslation } from '../../i18n';
import { useApproveCriteria } from './criteria-hooks';
import { criteriaProblemMessage, criteriaStatusLabel, criterionKindLabel } from './criteria-labels';
import { describeProblem } from './criteria-model';
import type { CriteriaStatus, CriteriaVersion } from './criteria-model';
import './bid.css';

const STATUS_TONE: Readonly<Record<CriteriaStatus, string>> = { DRAFT: 'warning', APPROVED: 'ok', SUPERSEDED: '' };

/** The state of a version in words: a state is never told by colour alone. */
export function CriteriaStatusBadge({ status }: { status: CriteriaStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`bid-badge ${STATUS_TONE[status]}`.trim()} data-testid="criteria-status" data-status={status}>
      {criteriaStatusLabel(t, status)}
    </span>
  );
}

export interface CriteriaVersionsProps {
  versions: readonly CriteriaVersion[];
  shown: CriteriaVersion | undefined;
  onShow: (id: string) => void;
  mayApprove: boolean;
}

/**
 * The versions of the criteria of a package, the newest first, and the criteria of the one shown with the sum of its weights (BID-04). A draft
 * can be approved by someone other than its maker; approval locks it, and the server says who may not (ST-BID-003).
 */
export function CriteriaVersions({ versions, shown, onShow, mayApprove }: CriteriaVersionsProps) {
  const { t } = useTranslation();
  if (versions.length === 0) {
    return (
      <p className="callout" role="status" data-testid="no-versions">
        {t('bid.criteria.versions.empty.text')}
      </p>
    );
  }
  return (
    <>
      <table className="table" data-testid="versions">
        <caption className="sub">{t('bid.criteria.versions.title')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('bid.criteria.versions.column.revision')}</th>
            <th scope="col">{t('bid.criteria.versions.column.status')}</th>
            <th scope="col">{t('bid.criteria.versions.column.weights')}</th>
            <th scope="col">{t('bid.criteria.versions.column.approved')}</th>
            <th scope="col">
              <span className="sr-only">{t('bid.criteria.versions.column.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {versions.map((version) => (
            <tr key={version.id} data-version-id={version.id} data-selected={version.id === shown?.id}>
              <th scope="row">{t('bid.criteria.revision.text', { revision: version.revision })}</th>
              <td>
                <CriteriaStatusBadge status={version.status} />
              </td>
              <td className="num">{version.weightsSum === null ? t('bid.criteria.weights.none.text') : version.weightsSum}</td>
              <td>{version.approvedAt ?? ''}</td>
              <td className="row-actions">
                {version.id === shown?.id ? null : (
                  <button type="button" onClick={() => onShow(version.id)}>
                    {t('bid.criteria.version.show.action', { revision: version.revision })}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown === undefined ? null : <VersionDetail key={shown.id} shown={shown} mayApprove={mayApprove} />}
    </>
  );
}

/** The criteria of one version; keyed by the version, so the answer to an approval never lingers on another version. */
function VersionDetail({ shown, mayApprove }: { shown: CriteriaVersion; mayApprove: boolean }) {
  const { t } = useTranslation();
  const approve = useApproveCriteria();
  const refused = approve.isError ? describeProblem(approve.error) : undefined;
  return (
    <div data-testid="version-detail" data-version-id={shown.id}>
      <h2>{t('bid.criteria.detail.title', { revision: shown.revision })}</h2>
      {shown.legalBasis === null ? null : <p className="sub">{t('bid.criteria.detail.basis.text', { basis: shown.legalBasis })}</p>}
      <table className="table" data-testid="criteria">
        <thead>
          <tr>
            <th scope="col">{t('bid.criteria.detail.column.code')}</th>
            <th scope="col">{t('bid.criteria.detail.column.name')}</th>
            <th scope="col">{t('bid.criteria.detail.column.kind')}</th>
            <th scope="col">{t('bid.criteria.detail.column.weight')}</th>
            <th scope="col">{t('bid.criteria.detail.column.scale')}</th>
            <th scope="col">{t('bid.criteria.detail.column.threshold')}</th>
            <th scope="col">{t('bid.criteria.detail.column.mandatory')}</th>
            <th scope="col">{t('bid.criteria.detail.column.evidence')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.criteria.map((criterion) => (
            <tr key={criterion.code} data-criterion-code={criterion.code}>
              <th scope="row">
                <code>{criterion.code}</code>
              </th>
              <td>{criterion.name}</td>
              <td>{criterionKindLabel(t, criterion.kind)}</td>
              <td className="num">{criterion.weight ?? ''}</td>
              <td className="num">{criterion.maxScore ?? ''}</td>
              <td className="num">{criterion.threshold ?? ''}</td>
              <td>{criterion.mandatory ? t('bid.criteria.mandatory.yes.text') : t('bid.criteria.mandatory.no.text')}</td>
              <td>{criterion.requiredEvidence.join('; ')}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3}>
              {t('bid.criteria.weights.sum.label')}
            </th>
            <td className="num" data-testid="weights-sum">
              {shown.weightsSum === null ? t('bid.criteria.weights.none.text') : shown.weightsSum}
            </td>
            <td colSpan={4} />
          </tr>
        </tfoot>
      </table>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="approve-refusal" data-reason={refused.reason}>
          {criteriaProblemMessage(t, refused)}
        </p>
      )}
      {approve.isSuccess ? (
        <p className="callout" role="status" data-testid="approved">
          {t('bid.criteria.approve.done.notice')}
        </p>
      ) : null}
      {mayApprove && shown.status === 'DRAFT' ? (
        <div className="formfooter">
          <button type="button" className="primary" disabled={approve.isPending} onClick={() => approve.mutate({ id: shown.id, version: shown.version })}>
            {approve.isPending ? t('bid.criteria.approve.pending') : t('bid.criteria.approve.action')}
          </button>
          <small className="sub">{t('bid.criteria.approve.hint')}</small>
        </div>
      ) : null}
    </div>
  );
}
