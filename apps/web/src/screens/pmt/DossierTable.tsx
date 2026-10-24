import { useTranslation } from '../../i18n';
import { dossierStatusLabel } from './dossier-labels';
import type { DossierLineView } from './dossier-model';
import './pmt.css';

export interface DossierTableProps {
  dossiers: readonly DossierLineView[];
  /** The dossier whose permits are shown below the table. */
  selectedId: string | undefined;
  onSelect: (dossierId: string) => void;
}

const percentOf = (text: string): number => Math.min(100, Math.max(0, Number(text)));

/**
 * PMT-01: the legal dossier of each project with how many of the permit types it must hold are covered, how many permits are valid and
 * how many end soon. A dossier whose types still wait for their legal confirmation says so: a working assumption is never shown as law.
 * The state is a word as well as a bar.
 */
export function DossierTable({ dossiers, selectedId, onSelect }: DossierTableProps) {
  const { t } = useTranslation();
  return (
    <table className="table" aria-label={t('pmt.dossier.table.aria')} data-testid="dossiers">
      <thead>
        <tr>
          <th scope="col">{t('pmt.dossier.project.column')}</th>
          <th scope="col">{t('pmt.dossier.required.column')}</th>
          <th scope="col">{t('pmt.dossier.readiness.column')}</th>
          <th scope="col">{t('pmt.dossier.issued.column')}</th>
          <th scope="col">{t('pmt.dossier.expiring.column')}</th>
          <th scope="col">{t('pmt.dossier.owner.column')}</th>
          <th scope="col">{t('pmt.dossier.status.column')}</th>
          <th scope="col">
            <span className="sr-only">{t('pmt.dossier.actions.column')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {dossiers.map((dossier) => (
          <tr key={dossier.id} data-dossier-id={dossier.id} data-selected={dossier.id === selectedId}>
            <th scope="row">
              {dossier.projectCode}
              <br />
              <span className="sub">{dossier.projectName}</span>
              {dossier.projectComponentCode === null ? null : (
                <>
                  {' '}
                  <span className="pill gray">{t('pmt.dossier.component.text', { code: dossier.projectComponentCode })}</span>
                </>
              )}
            </th>
            <td>
              {t('pmt.dossier.required.text', { satisfied: dossier.satisfiedCount, required: dossier.requiredCount })}
              {dossier.unconfirmedCount === 0 ? null : (
                <>
                  {' '}
                  <span className="pill warn" data-testid="unconfirmed">
                    {t('pmt.dossier.unconfirmed.text', { count: dossier.unconfirmedCount })}
                  </span>
                </>
              )}
            </td>
            <td>
              <span className="pmt-readiness">
                <progress max={100} value={percentOf(dossier.readinessPct)} aria-label={t('pmt.dossier.readiness.aria', { code: dossier.projectCode })} />
                <span>{t('pmt.dossier.readiness.text', { pct: dossier.readinessPct })}</span>
              </span>
            </td>
            <td>{dossier.issuedCount}</td>
            <td>{dossier.expiringCount === 0 ? dossier.expiringCount : <span className="pill warn">{dossier.expiringCount}</span>}</td>
            <td>{dossier.owner?.displayName ?? dossier.ownerUnitName}</td>
            <td>
              <span className={dossier.status === 'COMPLETE' ? 'pill green' : 'pill gray'}>{dossierStatusLabel(t, dossier.status)}</span>
            </td>
            <td className="row-actions">
              <button type="button" aria-pressed={dossier.id === selectedId} onClick={() => onSelect(dossier.id)}>
                {t('pmt.dossier.select.action')}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
