import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, FilterPanel, SectionCard, StatusPill } from '../../../ui';
import { useFindings } from '../../pay/integrity/hooks';
import { codeLabel, figureLabel, outcomeLabel } from '../../pay/integrity/labels';
import { FINDING_CODES, dayText, figuresOf, requestLink, vnd } from '../../pay/integrity/model';
import type { FindingLine } from '../../pay/integrity/model';
import '../../pay/integrity/integrity.css';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * AUD-12: the findings of the payment integrity checks, for internal audit (G4-2). One row for each thing a run found, never changed after (append-only), with the rule version that decided and whether an exception covered it. A
 * block (an invariant: duplicate claim, above the plan line, the contract price or the accepted value) is told apart from a signal (a price or a quantity the diary does not bear out): the first stopped the money, the second only
 * asked the approver to look. Filtered by code, kind, contract and day; the list comes a page at a time from the server and says when there are more.
 */
export default function IntegrityFindingsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <FindingsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function FindingsContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant } = useSession();
  const [code, setCode] = useState('');
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<string | undefined>(undefined);
  // A day that is half typed is not sent: the filter waits for a whole date.
  const filter = { code: code || undefined, kind: kind || undefined, from: DAY.test(from) ? from : undefined, to: DAY.test(to) ? to : undefined };
  const findings = useFindings(filter);
  const rows: FindingLine[] = findings.data?.pages.flatMap((page) => page.items) ?? [];
  const state = useScreenState({ isLoading: findings.isLoading, error: findings.error, data: findings.data === undefined ? undefined : rows, isEmpty: (data) => (data as unknown[]).length === 0 });
  const applied = [code, kind, DAY.test(from) ? from : '', DAY.test(to) ? to : ''].filter((value) => value !== '').length;
  const clear = (): void => {
    setCode('');
    setKind('');
    setFrom('');
    setTo('');
  };
  const asOf = findings.data?.pages[0]?.asOf;
  const blocks = rows.filter((row) => row.kind === 'INVARIANT').length;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govd.integrity.audit.title')}</h1>
          <p>{t('govd.integrity.audit.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={[{ label: t('govd.integrity.ctx.scope'), value: tenant?.name ?? t('govd.integrity.ctx.all') }]} unit={t('govd.integrity.unit')} {...(asOf ? { asOf: dayText(asOf) } : {})} />
      <FilterPanel applied={applied}>
        <label>
          {t('govd.integrity.audit.filter.code')}
          <select value={code} onChange={(event) => setCode(event.target.value)} data-testid="code-filter">
            <option value="">{t('govd.integrity.audit.filter.all')}</option>
            {FINDING_CODES.map((one) => (
              <option key={one} value={one}>
                {codeLabel(t, one)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('govd.integrity.audit.filter.kind')}
          <select value={kind} onChange={(event) => setKind(event.target.value)} data-testid="kind-filter">
            <option value="">{t('govd.integrity.audit.filter.all')}</option>
            <option value="INVARIANT">{t('govd.integrity.finding.block')}</option>
            <option value="SIGNAL">{t('govd.integrity.finding.signal')}</option>
          </select>
        </label>
        <label>
          {t('govd.integrity.audit.filter.from')}
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} data-testid="from" />
        </label>
        <label>
          {t('govd.integrity.audit.filter.to')}
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} data-testid="to" />
        </label>
      </FilterPanel>
      <SectionCard title={t('govd.integrity.audit.list')} unit={t('govd.integrity.unit')} status={state === 'default' ? <StatusPill tone={blocks > 0 ? 'danger' : 'neutral'}>{t('govd.integrity.audit.blocks', { count: blocks })}</StatusPill> : undefined}>
        <StateBoundary state={state} onRetry={() => void findings.refetch()}>
          <DataTable
            caption={t('govd.integrity.audit.list')}
            rows={rows}
            rowKey={(row) => row.id}
            emptyKind={applied === 0 ? 'none' : 'filtered'}
            onClearFilters={clear}
            columns={[
              { key: 'day', header: t('govd.integrity.audit.col.day'), render: (row) => dayText(row.createdAt) },
              {
                key: 'code',
                header: t('govd.integrity.audit.col.code'),
                render: (row) => (
                  <button type="button" className="ui-button ui-button--outline" aria-expanded={open === row.id} onClick={() => setOpen(open === row.id ? undefined : row.id)} data-finding={row.id}>
                    {codeLabel(t, row.code)}
                  </button>
                ),
              },
              { key: 'kind', header: t('govd.integrity.audit.col.kind'), render: (row) => <StatusPill tone={row.excused ? 'success' : row.kind === 'INVARIANT' ? 'danger' : 'warning'}>{row.excused ? t('govd.integrity.finding.excused') : row.kind === 'INVARIANT' ? t('govd.integrity.finding.block') : t('govd.integrity.finding.signal')}</StatusPill> },
              { key: 'request', header: t('govd.integrity.audit.col.request'), render: (row) => <Link to={requestLink(row.paymentRequestId)}>{row.requestNo ?? row.paymentRequestId.slice(0, 8)}</Link> },
              { key: 'contract', header: t('govd.integrity.audit.col.contract'), render: (row) => row.contractCode },
              { key: 'project', header: t('govd.integrity.audit.col.project'), render: (row) => row.projectCode },
              { key: 'outcome', header: t('govd.integrity.audit.col.outcome'), render: (row) => outcomeLabel(t, row.outcome) },
              { key: 'rule', header: t('govd.integrity.audit.col.rule'), align: 'right', render: (row) => (row.ruleVersion === 0 ? t('govd.integrity.rule.builtin') : t('govd.integrity.rule.version', { version: row.ruleVersion })) },
            ]}
          />
          {open === undefined ? null : (
            <div className="callout" data-testid="detail">
              {(() => {
                const row = rows.find((one) => one.id === open);
                if (row === undefined) return null;
                const figures = figuresOf(row);
                return (
                  <dl className="integrity-figures">
                    {figures.map((figure) => (
                      <div key={figure.key} style={{ display: 'contents' }}>
                        <dt>{figureLabel(t, figure.key)}</dt>
                        <dd>{figure.money ? vnd(figure.value, locale) : figure.value}</dd>
                      </div>
                    ))}
                  </dl>
                );
              })()}
            </div>
          )}
          {findings.hasNextPage ? (
            <p>
              <button type="button" className="ui-button ui-button--outline" disabled={findings.isFetchingNextPage} onClick={() => void findings.fetchNextPage()} data-testid="more">
                {t('govd.integrity.audit.more')}
              </button>
            </p>
          ) : null}
        </StateBoundary>
      </SectionCard>
      <p className="prototype-note">{t('govd.integrity.audit.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
