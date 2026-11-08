import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { DataTable, InfoFormula, SectionCard, StatusPill } from '../../ui';
import { useInfoLabels } from '../gov11/gov11-kit';
import { REGISTER_LIMIT, useGovernanceAlerts } from './alert-register';
import type { RegisterAlert } from './alert-register';
import { asOfText } from './model';

type Filter = '' | 'OPEN' | 'ACKNOWLEDGED';

/**
 * The register of the governance alerts that reach the caller across the projects of the scope (PRJ-26, the audit side): a milestone moved as many times as the rule counts, who it went to, and whether somebody took it in.
 * Each row opens the baseline of its project, where the alert is taken in with a note. The read is cut at a hundred rows and says so.
 */
export function GovernanceAlertRegister() {
  const { t } = useTranslation();
  const labels = useInfoLabels();
  const [status, setStatus] = useState<Filter>('');
  const query = useGovernanceAlerts(status);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: (value) => (value as { items: unknown[] }).items.length === 0 });
  const name = t('lookahead.prj.govAlerts.moves');
  return (
    <SectionCard title={t('lookahead.prj.govAlerts.title')}>
      <p className="muted">{t('govb1.alerts.audience')}</p>
      <div className="gov3-form">
        <label>
          {t('lookahead.prj.govAlerts.filter')}
          <select value={status} onChange={(event) => setStatus(event.target.value as Filter)} data-testid="gov-alert-filter">
            <option value="">{t('lookahead.prj.govAlerts.filter.all')}</option>
            <option value="OPEN">{t('govb1.alerts.status.open')}</option>
            <option value="ACKNOWLEDGED">{t('govb1.alerts.status.acknowledged')}</option>
          </select>
        </label>
      </div>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data === undefined ? null : (
          <>
            <DataTable<RegisterAlert>
              caption={t('lookahead.prj.govAlerts.title')}
              rows={data.items}
              rowKey={(row) => row.id}
              state={data.items.length === 0 ? 'empty' : 'ready'}
              columns={[
                { key: 'status', header: t('govb1.alerts.status'), render: (row) => <StatusPill tone={row.status === 'OPEN' ? 'danger' : 'success'}>{row.status === 'OPEN' ? t('govb1.alerts.status.open') : t('govb1.alerts.status.acknowledged')}</StatusPill> },
                {
                  key: 'project',
                  header: t('lookahead.prj.govAlerts.project'),
                  render: (row) => (
                    <Link to={`/prj/prj-26?project=${row.projectId}`} data-testid={`gov-alert-open-${row.id}`}>
                      {row.projectCode}
                    </Link>
                  ),
                },
                { key: 'subject', header: t('govb1.alerts.subject'), render: (row) => (row.subjectKind === 'PROJECT' ? t('govb1.alerts.subject.project', { code: row.projectCode }) : t('govb1.alerts.subject.milestone', { code: row.subjectCode ?? '' })) },
                {
                  key: 'moves',
                  header: name,
                  align: 'right',
                  render: (row) => (
                    <span>
                      {t('govb1.alerts.moves.value', { count: row.moveCount, threshold: row.threshold })}{' '}
                      <InfoFormula
                        name={name}
                        formula={t('lookahead.prj.govAlerts.moves.formula')}
                        source={t('lookahead.prj.govAlerts.moves.source')}
                        asOf={asOfText(data.asOf)}
                        owner={t('lookahead.prj.govAlerts.moves.owner')}
                        version={t('govb1.reapp.rule', { version: row.ruleVersion })}
                        unverified={false}
                        labels={labels(name)}
                      />
                    </span>
                  ),
                },
                { key: 'raised', header: t('govb1.alerts.raised'), render: (row) => asOfText(row.raisedAt) },
              ]}
            />
            {data.items.length >= REGISTER_LIMIT ? (
              <p className="muted" data-testid="gov-alert-cut">
                {t('lookahead.prj.govAlerts.cut', { count: REGISTER_LIMIT })}
              </p>
            ) : null}
          </>
        )}
      </StateBoundary>
    </SectionCard>
  );
}
