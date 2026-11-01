import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useQueue } from '../../mdm/hooks';
import { changeKindLabel, changeStatusLabel } from '../../mdm/labels';
import { Field } from '../../mne/components';
import { Frame, Gate } from './components';
import { APPROVAL_STATUSES, MASTER_APPROVAL_PATH, MASTER_READ_PERMISSION, changesOf, differences, valueText } from './model';
import type { ApprovalStatus } from './model';

/**
 * DGV-12: the changes of critical data and their approval (ST-DGV-010, DGV 3.1): for each change, what it moves (the value before and the value proposed), the ground it gives, who decided it and where it stands. A change is
 * decided by someone other than who proposed it, in MDM, which owns the data; this only reads them and writes nothing of its own.
 */
export default function ChangeApprovalScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenant = useSession().tenant;
  // What is chosen belongs to one member of one tenant: a switch starts the screen over.
  return (
    <Frame key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} title={t('dgv.governance.chg.page.title')} subtitle={t('dgv.governance.chg.page.subtitle')}>
      <Gate permission={MASTER_READ_PERMISSION} name="changes">
        <Changes />
      </Gate>
    </Frame>
  );
}

function Changes() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ApprovalStatus>('IN_REVIEW');
  const [masterType, setMasterType] = useState('');
  const queue = useQueue(status);
  const state = useScreenState({ isLoading: queue.isLoading, error: queue.error, data: queue.data });
  const types = [...new Set((queue.data ?? []).map((change) => change.masterType))].sort();
  const rows = changesOf(queue.data ?? [], masterType);
  return (
    <>
      <div className="card">
        <div className="mne-filters">
          <Field id="chg-status" label={t('dgv.governance.chg.filter.status')} error={undefined}>
            <select id="chg-status" value={status} onChange={(event) => setStatus(event.target.value as ApprovalStatus)}>
              {APPROVAL_STATUSES.map((entry) => (
                <option key={entry} value={entry}>
                  {changeStatusLabel(t, entry)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="chg-type" label={t('dgv.governance.chg.filter.type')} error={undefined}>
            <select id="chg-type" value={masterType} onChange={(event) => setMasterType(event.target.value)}>
              <option value="">{t('dgv.governance.filter.all')}</option>
              {types.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="sub">
          <Link to={MASTER_APPROVAL_PATH}>{t('dgv.governance.chg.queue.link')}</Link>
        </p>
      </div>
      <StateBoundary state={state} onRetry={() => void queue.refetch()}>
        <div className="tablewrap">
          <table className="table" data-testid="changes-table" aria-label={t('dgv.governance.chg.table.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('dgv.governance.chg.column.subject')}</th>
                <th scope="col">{t('dgv.governance.chg.column.before')}</th>
                <th scope="col">{t('dgv.governance.chg.column.after')}</th>
                <th scope="col">{t('dgv.governance.chg.column.ground')}</th>
                <th scope="col">{t('dgv.governance.chg.column.approver')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((change) => {
                const moved = differences(change);
                return (
                  <tr key={change.id} data-change-id={change.id} data-status={change.status}>
                    <td>
                      <strong>{valueText(change.businessKey)}</strong> <span className="sub">{change.masterType}</span>
                      <br />
                      <span className="sub">
                        {changeKindLabel(t, change.changeKind)} · {t('dgv.governance.chg.effective.text', { day: change.effectiveFrom })}
                      </span>
                    </td>
                    <td data-testid="change-before">
                      {moved.length === 0 ? (
                        '—'
                      ) : (
                        <ul>
                          {moved.map((entry) => (
                            <li key={entry.attribute}>
                              {entry.attribute}: {entry.before}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td data-testid="change-after">
                      {moved.length === 0 ? (
                        '—'
                      ) : (
                        <ul>
                          {moved.map((entry) => (
                            <li key={entry.attribute}>
                              {entry.attribute}: {entry.after}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td>
                      {valueText(change.reason === '' ? null : change.reason)}
                      {change.decisionDocumentId === null ? null : <span className="sub"> · {t('dgv.governance.chg.document.text', { id: change.decisionDocumentId.slice(0, 8) })}</span>}
                    </td>
                    <td>{change.reviewedBy === null ? t('dgv.governance.chg.approver.none') : change.reviewedBy.slice(0, 8)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length === 0 ? <p data-testid="changes-none">{t('dgv.governance.chg.none.notice')}</p> : null}
      </StateBoundary>
    </>
  );
}
