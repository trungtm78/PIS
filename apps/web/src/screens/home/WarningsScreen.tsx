import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import { ContextBar, DataTable, FilterPanel, StatusPill } from '../../ui';
import type { DataTableColumn, Severity as AlertSeverity, Tone } from '../../ui';
import '../dis/dis.css';
import './home.css';
import { useHomeWarnings } from './warning-hooks';
import { PROFILE_PATH, SEVERITIES, SEVERITY_GLYPH, observedAgainstExpected } from './warning-model';
import type { Severity, WarningItem } from './warning-model';

type T = Translator['t'];

const NONE = '—';
const SEVERITY_TONE: Readonly<Record<Severity, Tone>> = { INFO: 'info', WARNING: 'warning', CRITICAL: 'danger' };
/** The stripe of a row is the one of the alert centre: the severity of the warning says which. */
const ALERT_SEVERITY: Readonly<Record<Severity, AlertSeverity>> = { INFO: 'WATCH', WARNING: 'ACTION', CRITICAL: 'URGENT' };

export function severityLabel(t: T, severity: Severity): string {
  switch (severity) {
    case 'INFO':
      return t('home.warnings.severity.info');
    case 'WARNING':
      return t('home.warnings.severity.warning');
    case 'CRITICAL':
      return t('home.warnings.severity.critical');
  }
}

export function warningStatusLabel(t: T, status: string): string {
  switch (status) {
    case 'OPEN':
      return t('home.warnings.status.open');
    case 'ACKNOWLEDGED':
      return t('home.warnings.status.acknowledged');
    case 'EXPLANATION_REQUESTED':
      return t('home.warnings.status.explanationRequested');
    case 'RESOLVED':
      return t('home.warnings.status.resolved');
    case 'DISMISSED':
      return t('home.warnings.status.dismissed');
    default:
      return status;
  }
}

export function explanationStatusLabel(t: T, status: string): string {
  switch (status) {
    case 'REQUESTED':
      return t('home.explanation.status.requested');
    case 'RESPONDED':
      return t('home.explanation.status.responded');
    case 'ACCEPTED':
      return t('home.explanation.status.accepted');
    case 'RETURNED':
      return t('home.explanation.status.returned');
    case 'OVERDUE':
      return t('home.explanation.status.overdue');
    case 'CANCELLED':
      return t('home.explanation.status.cancelled');
    default:
      return status;
  }
}

/** The severity as a person reads it: an icon and the word, never a colour alone. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  const { t } = useTranslation();
  return (
    <span data-severity={severity}>
      <StatusPill tone={SEVERITY_TONE[severity]} icon={SEVERITY_GLYPH[severity]}>
        {severityLabel(t, severity)}
      </StatusPill>
    </span>
  );
}

/** What was observed against what was expected, in words; nothing is made up for a rule that measured something else. */
export function ObservedText({ item }: { item: WarningItem }) {
  const { t } = useTranslation();
  const pair = observedAgainstExpected(item.observed);
  return <span>{pair === null ? t('home.warnings.observed.none') : t('home.warnings.observed.text', { observed: pair.observed, expected: pair.expected })}</span>;
}

/**
 * HOME-03: the early warnings of the command center (ST-HOME-003, HOME 3 F4): the open warnings of the projects the reader may read, the newest first, narrowed by severity and rule, each with its rule, severity (an icon
 * and a word), project, what was observed against what was expected, the leader in charge and the explanation that was asked for. Read-only: the profile (HOME-06) is where the reader acts.
 */
export default function WarningsScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <WarningsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function WarningsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const tenant = useSession().tenant;
  const [severity, setSeverity] = useState('');
  const [ruleCode, setRuleCode] = useState('');
  const filter = { severity, ruleCode: ruleCode.trim().toUpperCase() };
  const list = useHomeWarnings(filter);
  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data === undefined ? undefined : items });
  const applied = [severity, filter.ruleCode].filter((value) => value !== '').length;
  const clear = (): void => {
    setSeverity('');
    setRuleCode('');
  };
  const columns: DataTableColumn<WarningItem>[] = [
    { key: 'severity', header: t('home.warnings.column.severity'), pinned: true, render: (item) => <SeverityBadge severity={item.severity} /> },
    {
      key: 'rule',
      header: t('home.warnings.column.rule'),
      render: (item) => (
        <>
          <strong>{item.ruleCode}</strong>
          <span className="dis-code">{item.ruleName}</span>
        </>
      ),
    },
    {
      key: 'project',
      header: t('home.warnings.column.project'),
      render: (item) =>
        item.project === null ? (
          NONE
        ) : (
          <>
            <strong>{item.project.code}</strong>
            <span className="dis-code">{item.project.name}</span>
          </>
        ),
    },
    {
      key: 'observed',
      header: t('home.warnings.column.observed'),
      render: (item) => (
        <span data-testid={`observed-${item.id}`}>
          <ObservedText item={item} />
        </span>
      ),
    },
    { key: 'leader', header: t('home.warnings.column.leader'), render: (item) => <span data-testid={`leader-${item.id}`}>{item.leader === null ? t('home.warnings.leader.none') : item.leader.displayName}</span> },
    {
      key: 'explanation',
      header: t('home.warnings.column.explanation'),
      render: (item) => (
        <span data-testid={`explanation-${item.id}`}>
          {item.explanation === null ? t('home.warnings.explanation.none') : `${explanationStatusLabel(t, item.explanation.status)}${item.explanation.isLate ? `, ${t('home.warnings.explanation.late')}` : ''}`}
        </span>
      ),
    },
    {
      key: 'open',
      header: t('w2dis.home.warnings.column.open'),
      render: (item) => (
        <Link to={`${PROFILE_PATH}?warning=${item.id}`} aria-label={t('home.warnings.open.aria', { rule: item.ruleCode, project: item.project?.code ?? '' })}>
          {t('home.warnings.open')}
        </Link>
      ),
    },
  ];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('home.warnings.page.title')}</h1>
          <p>{t('home.warnings.page.subtitle')}</p>
        </div>
      </div>
      <div className="home-stack">
        <ContextBar items={[{ label: t('dis.wr.ctx.scope'), value: tenant?.name ?? t('dis.wr.ctx.scope.all') }, { label: t('w2dis.home.warnings.ctx.shown'), value: String(items.length) }]} />
        <FilterPanel
          applied={applied}
          actions={
            applied === 0 ? undefined : (
              <button type="button" className="ui-button ui-button--outline" onClick={clear}>
                {t('w2dis.home.filter.clear')}
              </button>
            )
          }
        >
          <div className="dis-filters" role="group" aria-label={t('home.warnings.filter.title')}>
            <Field id="warnings-severity" label={t('home.warnings.severity.label')} error={undefined}>
              <select id="warnings-severity" value={severity} onChange={(event) => setSeverity(event.target.value)}>
                <option value="">{t('home.warnings.severity.all')}</option>
                {SEVERITIES.map((option) => (
                  <option key={option} value={option}>
                    {severityLabel(t, option)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="warnings-rule" label={t('home.warnings.rule.label')} error={undefined}>
              <input id="warnings-rule" value={ruleCode} placeholder={t('home.warnings.rule.placeholder')} maxLength={30} onChange={(event) => setRuleCode(event.target.value)} />
            </Field>
          </div>
        </FilterPanel>
        <StateBoundary state={state} onRetry={() => void list.refetch()}>
          <DataTable
            caption={t('home.warnings.page.title')}
            columns={columns}
            rows={items}
            rowKey={(item) => item.id}
            severity={(item) => ALERT_SEVERITY[item.severity]}
            emptyKind={applied === 0 ? 'none' : 'filtered'}
            onClearFilters={clear}
          />
          {list.hasNextPage ? (
            <div className="home-more">
              <button type="button" className="ui-button ui-button--outline" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {t('home.warnings.more')}
              </button>
            </div>
          ) : null}
        </StateBoundary>
      </div>
    </section>
  );
}
