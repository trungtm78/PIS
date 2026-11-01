import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { statusLabel as inspectionStatusLabel, resultLabel, typeLabel } from '../../qms/inspection/labels';
import { READ_PERMISSION as INSPECTION_READ } from '../../qms/inspection/model';
import type { InspectionLine } from '../../qms/inspection/model';
import { severityLabel, statusLabel as ncrStatusLabel } from '../../qms/nonconformance/labels';
import { READ_PERMISSION as NCR_READ } from '../../qms/nonconformance/model';
import type { NcrLine } from '../../qms/nonconformance/model';
import { ViewFrame } from './ViewFrame';
import { useQuality, useViewScope } from './hooks';
import { blockingNcrs, ownerLink } from './model';

/**
 * CTR-11: the quality of the work under a contract, read-only (ST-CTR-017, CTR section 7). QMS owns the inspections (QMS-04) and the non-conformances (QMS-07). A critical non-conformance that
 * is not closed stands in the way of the acceptance of the work (FR-CTR-11), so the view says how many there are before it lists them.
 */
export default function QualityViewScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The view belongs to one membership: a switch of tenant or of membership starts it over.
  return <QualityContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function QualityContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const scope = useViewScope([NCR_READ, INSPECTION_READ]);
  const quality = useQuality(scope);
  const contractId = scope.contractId ?? '';
  return (
    <ViewFrame
      route={route}
      title={t('ctr.qualityView.page.title')}
      subtitle={t('ctr.qualityView.page.subtitle')}
      module="QMS"
      scope={scope}
      loaded={quality}
      isEmpty={(data) => data.ncrs.length === 0 && data.inspections.length === 0}
      owners={[
        { id: 'QMS-07', to: ownerLink.nonconformances(contractId) },
        { id: 'QMS-04', to: ownerLink.inspections(contractId) },
      ]}
    >
      {({ data }) => {
        const blocking = blockingNcrs(data.ncrs).length;
        return (
          <>
            <p className={blocking === 0 ? 'callout' : 'callout warning'} role="status" data-testid="blocking">
              {blocking === 0 ? t('ctr.qualityView.blocking.none') : t('ctr.qualityView.blocking.some', { count: blocking })}
            </p>
            <NcrTable rows={data.ncrs} />
            <InspectionTable rows={data.inspections} />
          </>
        );
      }}
    </ViewFrame>
  );
}

function NcrTable({ rows }: { rows: NcrLine[] }) {
  const { t } = useTranslation();
  return (
    <article className="card" aria-label={t('ctr.qualityView.ncr.title')}>
      <h2>{t('ctr.qualityView.ncr.title')}</h2>
      {rows.length === 0 ? (
        <p className="sub" data-testid="no-ncrs">
          {t('ctr.qualityView.ncr.empty')}
        </p>
      ) : (
        <table className="table" data-testid="ncrs">
          <thead>
            <tr>
              <th scope="col">{t('ctr.qualityView.column.no')}</th>
              <th scope="col">{t('ctr.qualityView.column.title')}</th>
              <th scope="col">{t('ctr.qualityView.column.severity')}</th>
              <th scope="col">{t('ctr.qualityView.column.status')}</th>
              <th scope="col">{t('ctr.qualityView.column.due')}</th>
              <th scope="col">{t('ctr.qualityView.column.blocks')}</th>
              <th scope="col">{t('ctr.qualityView.column.owner')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((ncr) => (
              <tr key={ncr.id} data-ncr={ncr.id}>
                <td data-testid="no">{ncr.ncrNo}</td>
                <td>{ncr.title}</td>
                <td data-testid="severity">{severityLabel(t, ncr.severity)}</td>
                <td data-testid="status">{ncrStatusLabel(t, ncr.status)}</td>
                <td data-testid="due">
                  {ncr.dueAt.slice(0, 10)}
                  {ncr.overdue ? ` · ${t('ctr.qualityView.due.overdue')}` : ''}
                </td>
                <td data-testid="blocks">{ncr.blocksAcceptance ? t('ctr.qualityView.blocks.yes') : t('ctr.qualityView.blocks.no')}</td>
                <td>{ncr.actionOwner.displayName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}

function InspectionTable({ rows }: { rows: InspectionLine[] }) {
  const { t } = useTranslation();
  return (
    <article className="card" aria-label={t('ctr.qualityView.inspection.title')}>
      <h2>{t('ctr.qualityView.inspection.title')}</h2>
      {rows.length === 0 ? (
        <p className="sub" data-testid="no-inspections">
          {t('ctr.qualityView.inspection.empty')}
        </p>
      ) : (
        <table className="table" data-testid="inspections">
          <thead>
            <tr>
              <th scope="col">{t('ctr.qualityView.column.no')}</th>
              <th scope="col">{t('ctr.qualityView.column.title')}</th>
              <th scope="col">{t('ctr.qualityView.column.type')}</th>
              <th scope="col">{t('ctr.qualityView.column.requested')}</th>
              <th scope="col">{t('ctr.qualityView.column.status')}</th>
              <th scope="col">{t('ctr.qualityView.column.result')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((inspection) => (
              <tr key={inspection.id} data-inspection={inspection.id}>
                <td data-testid="no">{inspection.inspectionNo}</td>
                <td>{inspection.title}</td>
                <td data-testid="type">{typeLabel(t, inspection.inspectionType)}</td>
                <td data-testid="requested">{inspection.requestedFor.slice(0, 10)}</td>
                <td data-testid="status">{inspectionStatusLabel(t, inspection.status)}</td>
                <td data-testid="result">{inspection.result === null ? '–' : resultLabel(t, inspection.result)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}
