import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../mne/components';
import { useMerges } from '../../mdm/merge/hooks';
import { byLabel, mergeStatusLabel } from '../../mdm/merge/labels';
import type { MergeStatus } from '../../mdm/merge/model';
import { Frame, Gate } from './components';
import { MASTER_READ_PERMISSION, MERGE_HISTORY_PATH, NO_DUPLICATE_FILTER, decisionCounts, duplicateRows, masterTypesOf } from './model';
import type { DuplicateFilter } from './model';

const STATUSES: readonly MergeStatus[] = ['APPLIED', 'REVERTED'];

/**
 * DGV-10: the duplicates of master data that were settled (ST-DGV-010, DGV 3.1): for each, the golden record that was kept, the entry that was merged into it, how the values of the golden record were chosen and what the merge
 * moved. The merges are MDM's and so is the merge and its undoing; this only reads them, and a candidate that has not been merged is not read here because MDM does not list suspected duplicates.
 */
export default function DuplicatesScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenant = useSession().tenant;
  // What is filtered belongs to one member of one tenant: a switch starts the screen over.
  return (
    <Frame key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} title={t('dgv.governance.dup.page.title')} subtitle={t('dgv.governance.dup.page.subtitle')}>
      <Gate permission={MASTER_READ_PERMISSION} name="duplicates">
        <Duplicates />
      </Gate>
    </Frame>
  );
}

function Duplicates() {
  const { t } = useTranslation();
  const merges = useMerges();
  const [filter, setFilter] = useState<DuplicateFilter>(NO_DUPLICATE_FILTER);
  const state = useScreenState({ isLoading: merges.isLoading, error: merges.error, data: merges.data });
  const rows = duplicateRows(merges.data ?? [], filter);
  const set = <K extends keyof DuplicateFilter>(field: K, value: DuplicateFilter[K]): void => setFilter((previous) => ({ ...previous, [field]: value }));
  return (
    <StateBoundary state={state} onRetry={() => void merges.refetch()}>
      <p className="sub" data-testid="duplicates-note">
        {t('dgv.governance.dup.candidates.note')}
      </p>
      <div className="card">
        <div className="mne-filters">
          <Field id="dup-words" label={t('dgv.governance.dup.filter.search')} error={undefined}>
            <input id="dup-words" value={filter.words} maxLength={80} onChange={(event) => set('words', event.target.value)} />
          </Field>
          <Field id="dup-status" label={t('dgv.governance.dup.filter.status')} error={undefined}>
            <select id="dup-status" value={filter.status} onChange={(event) => set('status', event.target.value as '' | MergeStatus)}>
              <option value="">{t('dgv.governance.filter.all')}</option>
              {STATUSES.map((status) => (
                <option key={status} value={status}>
                  {mergeStatusLabel(t, status)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="dup-type" label={t('dgv.governance.dup.filter.type')} error={undefined}>
            <select id="dup-type" value={filter.masterType} onChange={(event) => set('masterType', event.target.value)}>
              <option value="">{t('dgv.governance.filter.all')}</option>
              {masterTypesOf(merges.data ?? []).map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="sub">
          <Link to={MERGE_HISTORY_PATH}>{t('dgv.governance.dup.history.link')}</Link>
        </p>
      </div>
      <div className="tablewrap">
        <table className="table" data-testid="duplicates-table" aria-label={t('dgv.governance.dup.table.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('dgv.governance.dup.column.candidate')}</th>
              <th scope="col">{t('dgv.governance.dup.column.golden')}</th>
              <th scope="col">{t('dgv.governance.dup.column.chosen')}</th>
              <th scope="col">{t('dgv.governance.dup.column.impact')}</th>
              <th scope="col">{t('dgv.governance.dup.column.status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((merge) => {
              const counts = decisionCounts(merge);
              return (
                <tr key={merge.id} data-merge-id={merge.id} data-status={merge.status}>
                  <td>
                    <strong>{merge.mergedKey}</strong> {merge.mergedLabel === null ? null : <span className="sub">{merge.mergedLabel}</span>}
                    <br />
                    <span className="sub">{merge.masterType}</span>
                  </td>
                  <td>{merge.survivorKey}</td>
                  <td data-testid="dup-chosen">
                    {t('dgv.governance.dup.chosen.text', { rule: counts.rule, override: counts.override, other: counts.other })}
                    {merge.decisions.some((decision) => decision.by === 'OVERRIDE') ? <span className="sub"> · {byLabel(t, 'OVERRIDE')}</span> : null}
                  </td>
                  <td>{t('dgv.governance.dup.impact.text', { count: merge.repointed })}</td>
                  <td>
                    {mergeStatusLabel(t, merge.status)}
                    <br />
                    <span className="sub">{merge.revertedAt === null ? merge.appliedAt.slice(0, 10) : t('dgv.governance.dup.reverted.text', { day: merge.revertedAt.slice(0, 10) })}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? <p data-testid="duplicates-none">{t('dgv.governance.dup.none.notice')}</p> : null}
    </StateBoundary>
  );
}
