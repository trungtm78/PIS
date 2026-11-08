import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, SectionCard, StatusPill } from '../../../ui';
import { dayText } from '../../gov3/model';
import { RISK_REGISTER_LIMIT, useRiskAlertRegister } from './alert-register';
import type { RiskRegisterAlert } from './alert-register';
import { RuleInfo, UnverifiedPill } from './components';
import { alertStatusText, alertTypeText, kindText } from './labels';
import type { AlertStatus, Policy } from './model';

type Filter = '' | AlertStatus;

/**
 * The register of the risk alerts across the projects of the scope (PRJ-28): a score that went up across the line of the rule, the score before and after, the line it crossed, the version of the rule, and whether
 * somebody took it in. Each row opens the project, where the alert is taken in with a note. The read is cut at a hundred rows and says so.
 */
export function RiskAlertRegister({ policy, asOf }: { policy: Policy; asOf: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Filter>('');
  const query = useRiskAlertRegister(status);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: (value) => (value as { items: unknown[] }).items.length === 0 });
  return (
    <SectionCard title={t('lookahead.prj.riskAlerts.title')} status={<RuleInfo policy={policy} asOf={asOf} name={t('lookahead.prj.riskAlerts.title')} />}>
      <p className="muted">{t('lookahead.prj.riskAlerts.hint')}</p>
      <label>
        {t('lookahead.prj.riskAlerts.filter')}
        <select value={status} onChange={(event) => setStatus(event.target.value as Filter)} data-testid="risk-alert-filter">
          <option value="">{t('lookahead.prj.riskAlerts.filter.all')}</option>
          <option value="OPEN">{t('mr1.risk.alert.status.open')}</option>
          <option value="ACKNOWLEDGED">{t('mr1.risk.alert.status.acknowledged')}</option>
          <option value="RESOLVED">{t('mr1.risk.alert.status.resolved')}</option>
        </select>
      </label>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data === undefined ? null : (
          <>
            <DataTable<RiskRegisterAlert>
              caption={t('lookahead.prj.riskAlerts.title')}
              rows={data.items}
              rowKey={(row) => row.id}
              rowAttrs={(row) => ({ 'data-alert': row.id, 'data-status': row.status })}
              state={data.items.length === 0 ? 'empty' : 'ready'}
              columns={[
                { key: 'status', header: t('mr1.risk.alerts.status'), render: (row) => <StatusPill tone={row.status === 'OPEN' ? 'danger' : row.status === 'ACKNOWLEDGED' ? 'info' : 'success'}>{alertStatusText(t, row.status)}</StatusPill> },
                {
                  key: 'project',
                  header: t('mr1.risk.col.project'),
                  render: (row) => (
                    <Link to={{ search: `?id=${row.projectId}` }} data-testid={`risk-alert-open-${row.id}`}>
                      {row.projectCode}
                    </Link>
                  ),
                },
                { key: 'type', header: t('mr1.risk.alerts.type'), render: (row) => alertTypeText(t, row.type) },
                { key: 'subject', header: t('mr1.risk.alerts.subject'), render: (row) => (row.kind === null ? t('mr1.risk.kind.register') : kindText(t, row.kind)) },
                {
                  key: 'score',
                  header: t('mr1.risk.alerts.score'),
                  align: 'right',
                  render: (row) => (
                    <span>
                      {row.type === 'RISK_SCORE_JUMP' && row.priorScore !== null ? t('mr1.risk.alerts.jump', { prior: row.priorScore, score: row.score, threshold: row.threshold }) : t('mr1.risk.alerts.critical', { score: row.score, threshold: row.threshold })}{' '}
                      <RuleInfo policy={policy} asOf={data.asOf === '' ? asOf : data.asOf} name={t('mr1.risk.alerts.score')} />
                    </span>
                  ),
                },
                { key: 'raised', header: t('mr1.risk.alerts.raised'), render: (row) => `${dayText(row.raisedOn)} · ${t('mr1.risk.rule.version', { version: row.ruleVersion })}` },
                { key: 'rule', header: t('mr1.risk.col.rule'), render: (row) => <UnverifiedPill unverified={row.ruleUnverified} /> },
              ]}
            />
            {data.items.length >= RISK_REGISTER_LIMIT ? (
              <p className="muted" data-testid="risk-alert-cut">
                {t('lookahead.prj.riskAlerts.cut', { count: RISK_REGISTER_LIMIT })}
              </p>
            ) : null}
          </>
        )}
      </StateBoundary>
    </SectionCard>
  );
}
