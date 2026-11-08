import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, FilterPanel, InfoFormula, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { Tone } from '../../../ui';
import { useFigures, useRegister } from '../shared/vnd-hooks';
import { infoLabels, profileFieldLabel, verificationLabel } from '../shared/vnd-labels';
import { PATHS, VERIFICATIONS, dayText, numberText, percentText, verificationTone } from '../shared/vnd-model';
import type { Figures, Policy, RegisterLine } from '../shared/vnd-model';
import { CoverageBar, CountInfo, CursorPager, PolicyInfo, Screen, ScreenFooter, ScreenHead, StaleNotice, UnverifiedPill } from '../shared/vnd-ui';

const PAGE_SIZE = 20;

interface Filters {
  q: string;
  verification: string;
  coverage: string;
  restricted: boolean;
  hasOpenCase: boolean;
}

const NO_FILTERS: Filters = { q: '', verification: '', coverage: '', restricted: false, hasOpenCase: false };
const applied = (filters: Filters): number => [filters.q.trim() !== '', filters.verification !== '', filters.coverage !== '', filters.restricted, filters.hasOpenCase].filter(Boolean).length;

/**
 * VND-01, the register of contractors: who they are, how complete their profile is by the rule `VENDOR_PROFILE`, whether a restriction or an open case stands against them, whether they have an account to be paid on and
 * certificates that run out. The strip on top is the indicators of the register; every number has its "i" and every threshold of the law says it is not verified.
 */
export default function RegisterScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <RegisterContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RegisterContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const page = cursors.length - 1;
  const query = useRegister({ ...filters, cursor: cursors[page], limit: PAGE_SIZE });
  const figures = useFigures();
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const refreshFailed = query.isError && data !== undefined;

  const apply = (event: FormEvent): void => {
    event.preventDefault();
    setCursors([undefined]);
    setFilters(draft);
  };
  const clear = (): void => {
    setDraft(NO_FILTERS);
    setFilters(NO_FILTERS);
    setCursors([undefined]);
  };

  return (
    <Screen route={route}>
      <ScreenHead title={t('vnd.register.page.title')} subtitle={t('vnd.register.page.subtitle')} asOf={data?.as_of} stale={refreshFailed} />
      {refreshFailed && <StaleNotice onRetry={() => void query.refetch()} />}
      <FigureStrip figures={figures.data} loading={figures.isLoading} failed={figures.isError} onRetry={() => void figures.refetch()} />
      <FilterPanel applied={applied(filters)} {...(data === undefined ? {} : { updatedAt: dayText(data.as_of) })}>
        <form className="vnd-filters" onSubmit={apply} aria-label={t('vnd.register.filters.label')}>
          <label>
            {t('vnd.register.filter.q.label')}
            <input type="search" value={draft.q} onChange={(event) => setDraft({ ...draft, q: event.target.value })} />
          </label>
          <label>
            {t('vnd.register.filter.verification.label')}
            <select value={draft.verification} onChange={(event) => setDraft({ ...draft, verification: event.target.value })}>
              <option value="">{t('vnd.register.filter.any.option')}</option>
              {VERIFICATIONS.map((status) => (
                <option key={status} value={status}>
                  {verificationLabel(t, status)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('vnd.register.filter.coverage.label')}
            <select value={draft.coverage} onChange={(event) => setDraft({ ...draft, coverage: event.target.value })}>
              <option value="">{t('vnd.register.filter.any.option')}</option>
              <option value="COMPLETE">{t('vnd.register.filter.complete.option')}</option>
              <option value="INCOMPLETE">{t('vnd.register.filter.incomplete.option')}</option>
            </select>
          </label>
          <label className="vnd-filter-check">
            <input type="checkbox" checked={draft.restricted} onChange={(event) => setDraft({ ...draft, restricted: event.target.checked })} />
            {t('vnd.register.filter.restricted.label')}
          </label>
          <label className="vnd-filter-check">
            <input type="checkbox" checked={draft.hasOpenCase} onChange={(event) => setDraft({ ...draft, hasOpenCase: event.target.checked })} />
            {t('vnd.register.filter.openCase.label')}
          </label>
          <span className="vnd-row">
            <button type="submit" className="ui-button ui-button--primary">
              {t('vnd.register.filter.apply.action')}
            </button>
            <button type="button" className="ui-button ui-button--outline" onClick={clear}>
              {t('vnd.register.filter.clear.action')}
            </button>
          </span>
        </form>
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <SectionCard title={t('vnd.register.section.list.title')} status={data.profile_policy.unverified ? <UnverifiedPill /> : undefined}>
            <Legend asOf={data.as_of} policy={data.profile_policy} />
            <DataTable<RegisterLine>
              caption={t('vnd.register.table.caption')}
              rows={data.items}
              rowKey={(row) => row.contractor_id}
              rowAttrs={(row) => ({ 'data-contractor-id': row.contractor_id })}
              state={data.items.length === 0 ? 'empty' : 'ready'}
              emptyKind={applied(filters) > 0 ? 'filtered' : 'none'}
              onClearFilters={clear}
              columns={[
                {
                  key: 'name',
                  header: t('vnd.register.column.name'),
                  pinned: true,
                  render: (row) => (
                    <span className="vnd-stack">
                      <Link to={PATHS.profile(row.contractor_id)}>{row.legal_name}</Link>
                      <span className="vnd-days">{t('vnd.register.taxCode.text', { code: row.tax_identifier })}</span>
                    </span>
                  ),
                },
                { key: 'status', header: t('vnd.register.column.status'), render: (row) => <StatusPill tone={verificationTone(row.verification_status)}>{verificationLabel(t, row.verification_status)}</StatusPill> },
                {
                  key: 'coverage',
                  header: t('vnd.register.column.coverage'),
                  render: (row) => (
                    <span className="vnd-stack">
                      <span className="vnd-row">
                        <CoverageBar coverage={row.coverage} label={t('vnd.register.coverage.label', { name: row.legal_name })} />
                        <PolicyInfo name={t('vnd.register.figure.coverage.name')} policy={data.profile_policy} />
                      </span>
                      {row.coverage.missing.length > 0 && <span className="vnd-days">{t('vnd.register.missing.text', { fields: row.coverage.missing.map((field) => profileFieldLabel(t, field)).join(', ') })}</span>}
                    </span>
                  ),
                },
                {
                  key: 'flags',
                  header: t('vnd.register.column.flags'),
                  render: (row) => (
                    <span className="vnd-badges">
                      {row.restricted && (
                        <StatusPill tone="danger" icon="⛔">
                          {t('vnd.register.badge.restricted')}
                        </StatusPill>
                      )}
                      {row.open_cases > 0 && (
                        <Link to={`${PATHS.cases}?contractor=${row.contractor_id}`}>
                          <StatusPill tone="warning" icon="⚠">
                            {t('vnd.register.badge.cases', { count: numberText(row.open_cases, locale) })}
                          </StatusPill>
                        </Link>
                      )}
                      <Link to={PATHS.payee(row.contractor_id)}>
                        <StatusPill tone={row.active_accounts > 0 ? 'neutral' : 'warning'}>{t('vnd.register.badge.accounts', { count: numberText(row.active_accounts, locale) })}</StatusPill>
                      </Link>
                      {row.qualifications_expiring > 0 && (
                        <Link to={PATHS.certificates(row.contractor_id)}>
                          <StatusPill tone="warning" icon="◔">
                            {t('vnd.register.badge.expiring', { count: numberText(row.qualifications_expiring, locale) })}
                          </StatusPill>
                        </Link>
                      )}
                    </span>
                  ),
                },
                { key: 'review', header: t('vnd.register.column.review'), render: (row) => (row.next_review_due === null ? t('vnd.register.review.none') : dayText(row.next_review_due)) },
              ]}
            />
            <CursorPager page={page} hasNext={data.next_cursor !== null} onPrev={() => setCursors((current) => current.slice(0, -1))} onNext={() => data.next_cursor !== null && setCursors((current) => [...current, data.next_cursor ?? undefined])} />
          </SectionCard>
        )}
      </StateBoundary>
      <ScreenFooter route={route} />
    </Screen>
  );
}

/** The "i" of every number in the table: the coverage by the rule of the profile, and the three counts of a line. */
function Legend({ asOf, policy }: { asOf: string; policy: Policy }) {
  const { t } = useTranslation();
  return (
    <ul className="vnd-legend" data-testid="register-legend">
      <li>
        <span>{t('vnd.register.legend.coverage.text')}</span> <PolicyInfo name={t('vnd.register.figure.coverage.name')} policy={policy} />
      </li>
      <li>
        <span>{t('vnd.register.legend.cases.text')}</span>{' '}
        <CountInfo name={t('vnd.register.figure.cases.name')} formula={t('vnd.register.figure.cases.formula')} source={t('vnd.register.figure.cases.source')} asOf={asOf} />
      </li>
      <li>
        <span>{t('vnd.register.legend.accounts.text')}</span>{' '}
        <CountInfo name={t('vnd.register.figure.accounts.name')} formula={t('vnd.register.figure.accounts.formula')} source={t('vnd.register.figure.accounts.source')} asOf={asOf} />
      </li>
      <li>
        <span>{t('vnd.register.legend.expiring.text')}</span>{' '}
        <CountInfo name={t('vnd.register.figure.expiring.name')} formula={t('vnd.register.figure.expiring.formula')} source={t('vnd.register.figure.expiring.source')} asOf={asOf} unverified />
      </li>
    </ul>
  );
}

// ---- the indicators of the register ------------------------------------------------------------------------------------------------------------------------------------

type IndicatorKey = 'coverage' | 'debarment' | 'reputation' | 'payee';
const MATCH: Readonly<Record<IndicatorKey, RegExp>> = { coverage: /COVERAGE|PROFILE/i, debarment: /DEBAR|RESTRICT/i, reputation: /REPUTATION|POSTING/i, payee: /PAYEE|BANK|ACCOUNT/i };

interface Definition {
  name: string;
  formula: string;
  source: string;
  version: string;
  unverified: boolean;
}

/** The definition the server gave for an indicator (found by its code), else the screen's own words, which are flagged unverified: nobody confirmed them. */
function useDefinition(kind: IndicatorKey, figures: Figures | undefined): Definition | undefined {
  const { t } = useTranslation();
  if (figures === undefined) return undefined;
  const found = figures.indicators.find((indicator) => MATCH[kind].test(indicator.code));
  const words =
    kind === 'coverage'
      ? { name: t('vnd.register.indicator.coverage.name'), formula: t('vnd.register.indicator.coverage.formula'), source: t('vnd.register.indicator.coverage.source') }
      : kind === 'debarment'
        ? { name: t('vnd.register.indicator.debarment.name'), formula: t('vnd.register.indicator.debarment.formula'), source: t('vnd.register.indicator.debarment.source') }
        : kind === 'reputation'
          ? { name: t('vnd.register.indicator.reputation.name'), formula: t('vnd.register.indicator.reputation.formula'), source: t('vnd.register.indicator.reputation.source') }
          : { name: t('vnd.register.indicator.payee.name'), formula: t('vnd.register.indicator.payee.formula'), source: t('vnd.register.indicator.payee.source') };
  return { name: found?.name ?? words.name, formula: found?.formula ?? words.formula, source: found?.source ?? words.source, version: found?.code ?? t('vnd.info.noVersion.text'), unverified: found?.unverified ?? true };
}

function Info({ definition, asOf }: { definition: Definition; asOf: string }) {
  const { t } = useTranslation();
  return (
    <InfoFormula
      name={definition.name}
      formula={definition.formula}
      source={definition.source}
      asOf={dayText(asOf)}
      owner={t('vnd.info.owner.text')}
      version={definition.version}
      unverified={definition.unverified}
      labels={infoLabels(t, definition.name)}
    />
  );
}

interface TileProps {
  kind: IndicatorKey;
  figures: Figures | undefined;
  label: string;
  value: string;
  sub: string;
  tone: Tone;
  state: 'ready' | 'loading' | 'error';
  onRetry: () => void;
}

/** One tile of the strip: the number, one line that explains it, the "i" with the definition and the flag when the definition is a starting value. */
function Tile({ kind, figures, label, value, sub, tone, state, onRetry }: TileProps) {
  const definition = useDefinition(kind, figures);
  return (
    <KpiTile
      label={label}
      value={value}
      tone={tone}
      state={state}
      onRetry={onRetry}
      sub={
        definition === undefined || figures === undefined ? undefined : (
          <span className="vnd-row" data-testid={`figure-${kind}`}>
            <span>{sub}</span>
            <Info definition={definition} asOf={figures.as_of} />
            {definition.unverified && <UnverifiedPill />}
          </span>
        )
      }
    />
  );
}

function FigureStrip({ figures, loading, failed, onRetry }: { figures: Figures | undefined; loading: boolean; failed: boolean; onRetry: () => void }) {
  const { t, locale } = useTranslation();
  const state = figures !== undefined ? 'ready' : loading || !failed ? 'loading' : 'error';
  const f = figures;
  return (
    <KpiStrip label={t('vnd.register.figures.label')}>
      <Tile
        kind="coverage"
        figures={f}
        label={t('vnd.register.indicator.coverage.name')}
        value={f === undefined ? '' : percentText(f.profile_coverage.pct, locale)}
        sub={f === undefined ? '' : t('vnd.register.indicator.coverage.sub', { complete: f.profile_coverage.complete, total: f.profile_coverage.total })}
        tone={f !== undefined && f.profile_coverage.pct !== null && f.profile_coverage.pct < 50 ? 'warning' : 'default'}
        state={state}
        onRetry={onRetry}
      />
      <Tile
        kind="debarment"
        figures={f}
        label={t('vnd.register.indicator.debarment.name')}
        value={f === undefined ? '' : percentText(f.debarment.in_time_pct, locale)}
        sub={f === undefined ? '' : t('vnd.register.indicator.debarment.sub', { open: f.debarment.open, overdue: f.debarment.overdue_open })}
        tone={f !== undefined && f.debarment.overdue_open > 0 ? 'danger' : 'default'}
        state={state}
        onRetry={onRetry}
      />
      <Tile
        kind="reputation"
        figures={f}
        label={t('vnd.register.indicator.reputation.name')}
        value={f === undefined ? '' : percentText(f.reputation.in_time_pct, locale)}
        sub={f === undefined ? '' : t('vnd.register.indicator.reputation.sub', { open: f.reputation.open, overdue: f.reputation.overdue_open })}
        tone={f !== undefined && f.reputation.overdue_open > 0 ? 'danger' : 'default'}
        state={state}
        onRetry={onRetry}
      />
      <Tile
        kind="payee"
        figures={f}
        label={t('vnd.register.indicator.payee.name')}
        value={f === undefined ? '' : numberText(f.payee.changes_requested, locale)}
        sub={f === undefined ? '' : t('vnd.register.indicator.payee.sub', { callback: f.payee.changes_with_callback, waiting: f.payee.accounts_waiting, shared: f.payee.shared_accounts })}
        tone={f !== undefined && f.payee.shared_accounts > 0 ? 'warning' : 'default'}
        state={state}
        onRetry={onRetry}
      />
    </KpiStrip>
  );
}
