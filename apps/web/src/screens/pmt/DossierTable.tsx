import { useTranslation } from '../../i18n';
import { DataTable } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { Pill } from './components';
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
  const columns: DataTableColumn<DossierLineView>[] = [
    {
      key: 'project',
      header: t('pmt.dossier.project.column'),
      pinned: true,
      render: (dossier) => (
        <span data-dossier-id={dossier.id} data-selected={dossier.id === selectedId}>
          {dossier.projectCode}
          <br />
          <span className="sub">{dossier.projectName}</span>
          {dossier.projectComponentCode === null ? null : (
            <>
              {' '}
              <Pill tone="gray">{t('pmt.dossier.component.text', { code: dossier.projectComponentCode })}</Pill>
            </>
          )}
        </span>
      ),
    },
    {
      key: 'required',
      header: t('pmt.dossier.required.column'),
      render: (dossier) => (
        <>
          {t('pmt.dossier.required.text', { satisfied: dossier.satisfiedCount, required: dossier.requiredCount })}
          {dossier.unconfirmedCount === 0 ? null : (
            <>
              {' '}
              <Pill tone="warn" data-testid="unconfirmed">
                {t('pmt.dossier.unconfirmed.text', { count: dossier.unconfirmedCount })}
              </Pill>
            </>
          )}
        </>
      ),
    },
    {
      key: 'readiness',
      header: t('pmt.dossier.readiness.column'),
      render: (dossier) => (
        <span className="pmt-readiness">
          <progress max={100} value={percentOf(dossier.readinessPct)} aria-label={t('pmt.dossier.readiness.aria', { code: dossier.projectCode })} />
          <span>{t('pmt.dossier.readiness.text', { pct: dossier.readinessPct })}</span>
        </span>
      ),
    },
    { key: 'issued', header: t('pmt.dossier.issued.column'), align: 'right', render: (dossier) => dossier.issuedCount },
    {
      key: 'expiring',
      header: t('pmt.dossier.expiring.column'),
      align: 'right',
      render: (dossier) => (dossier.expiringCount === 0 ? dossier.expiringCount : <Pill tone="warn">{dossier.expiringCount}</Pill>),
    },
    { key: 'owner', header: t('pmt.dossier.owner.column'), render: (dossier) => dossier.owner?.displayName ?? dossier.ownerUnitName },
    {
      key: 'status',
      header: t('pmt.dossier.status.column'),
      render: (dossier) => <Pill tone={dossier.status === 'COMPLETE' ? 'green' : 'gray'}>{dossierStatusLabel(t, dossier.status)}</Pill>,
    },
    {
      key: 'actions',
      header: t('pmt.dossier.actions.column'),
      render: (dossier) => (
        <button type="button" className="ui-button ui-button--outline ui-button--small" aria-pressed={dossier.id === selectedId} onClick={() => onSelect(dossier.id)}>
          {t('pmt.dossier.select.action')}
        </button>
      ),
    },
  ];
  return (
    <div data-testid="dossiers">
      <DataTable caption={t('pmt.dossier.table.aria')} columns={columns} rows={[...dossiers]} rowKey={(dossier) => dossier.id} />
    </div>
  );
}
