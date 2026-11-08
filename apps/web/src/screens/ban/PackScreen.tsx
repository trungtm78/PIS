import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, SectionCard } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { clockText } from '../home/overview-model';
import { StatePill, needsReason, refusalText as reportRefusalText } from '../rpt/components';
import { useDrafts, useGenerate, useIssues, useStep } from '../rpt/hooks';
import { vietnamDateTime } from '../rpt/model';
import type { Draft, Issue, Period } from '../rpt/model';
import { DimensionTabs, ProvinceCard } from './dashboard-parts';
import { EmptyReason, FeedNotice, FigureTile, Guarded, PartError, PolicyNotice } from './components';
import { usePack } from './hooks';
import { PACK_LAYOUT, PERMISSION, dayText, dimensionOf, draftPath, isDay, issuePath, may, toFigures, vietnamDay } from './model';
import type { Dimension, Pack } from './model';

type Action = 'check' | 'approve' | 'issue';
type Generated = { outcome: 'CREATED' | 'EXISTING' | 'DUPLICATE'; draft_id: string | null; issue_id: string | null; revision: number };

const nextAction = (draft: Draft): Action | undefined => (draft.state === 'DRAFT' && draft.can_check ? 'check' : draft.state === 'CHECKED' && draft.can_approve ? 'approve' : draft.state === 'APPROVED' && draft.can_issue ? 'issue' : undefined);

/** What the pack is made of, section by section, with how many rows each has: the same read as the screens, so a number of the file is a number of the screen. */
function SectionsList({ pack }: { pack: Pack }) {
  const { t } = useTranslation();
  const items = [
    t('ban.pack.section.figures', { count: pack.figures.length }),
    t('ban.pack.section.province'),
    t('ban.pack.section.sector', { count: pack.by_sector.length }),
    t('ban.pack.section.district', { count: pack.by_district.length }),
    t('ban.pack.section.investor', { count: pack.by_investor.length }),
    t('ban.pack.section.fundSource', { count: pack.by_fund_source.length }),
    t('ban.pack.section.attention', { count: pack.attention.length }),
    t('ban.pack.section.directives', { units: pack.directives.units.length, open: pack.directives.totals.open, overdue: pack.directives.totals.overdue }),
  ];
  return (
    <ol className="ban-sections" data-testid="pack-sections">
      {items.map((text, index) => (
        <li key={index}>{text}</li>
      ))}
    </ol>
  );
}

/** One part of the screen read on its own (drafts, issued copies): a lack of the right, a failure with a retry, and a list that is empty each say their own words. */
function Part({ query, empty, emptyText, deniedText, source, children }: { query: { isLoading: boolean; error: unknown; data: unknown; refetch: () => unknown }; empty: boolean; emptyText: string; deniedText: string; source: string; children: ReactNode }) {
  const { t } = useTranslation();
  const state = useScreenState({ isLoading: query.isLoading, error: query.data === undefined ? query.error : undefined, data: query.data, isEmpty: () => false });
  if (state === 'loading') return <div role="status" aria-busy="true" aria-label={t('states.loading.label')} className="skeleton" />;
  if (state === 'denied') return <EmptyReason text={deniedText} testId="part-denied" />;
  if (state === 'error' || state === 'offline' || state === 'signedOut') return <PartError source={source} onRetry={() => void query.refetch()} />;
  if (empty) return <EmptyReason text={emptyText} testId="part-empty" />;
  return <>{children}</>;
}

function GenerateCard({ day }: { day: string }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const generate = useGenerate();
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [receipt, setReceipt] = useState<Generated | undefined>(undefined);
  const allowed = may(permissions, PERMISSION.generate);
  const valid = isDay(day);
  const send = (): void => {
    if (!valid) {
      setError(t('ban.pack.generate.day.error'));
      return;
    }
    if (asking && reason.trim().length < 10) {
      setError(t('ban.pack.generate.reason.error'));
      return;
    }
    setError(undefined);
    const period: Period = { kind: 'AS_OF', year: Number(day.slice(0, 4)), day };
    generate.mutate(
      { layoutCode: PACK_LAYOUT, period, reason: asking ? reason.trim() : undefined },
      {
        onSuccess: (result) => {
          setReceipt(result as Generated);
          setAsking(false);
        },
        onError: (failure) => {
          setError(reportRefusalText(t, failure));
          if (needsReason(failure)) setAsking(true);
        },
      },
    );
  };
  return (
    <SectionCard title={t('ban.pack.generate.title')}>
      <p>{t('ban.pack.generate.text', { day: valid ? dayText(day) : '–' })}</p>
      {allowed ? (
        <>
          {asking ? (
            <label className="ban-form" htmlFor="ban-pack-reason">
              <span>{t('ban.pack.generate.reason.label')}</span>
              <textarea id="ban-pack-reason" rows={2} value={reason} data-testid="pack-reason" onChange={(event) => setReason(event.target.value)} />
            </label>
          ) : null}
          {error === undefined ? null : (
            <p className="ban-error" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="ui-button ui-button--primary" disabled={generate.isPending} data-testid="pack-generate" onClick={send}>
            {generate.isPending ? t('ban.pack.generate.sending') : t('ban.pack.generate.action')}
          </button>
        </>
      ) : (
        <p className="ban-muted" data-testid="pack-no-right">
          {t('ban.pack.generate.noRight')}
        </p>
      )}
      {receipt === undefined ? null : (
        <p className="callout" role="status" data-testid="pack-receipt">
          {receipt.outcome === 'DUPLICATE' ? t('ban.pack.receipt.duplicate', { revision: receipt.revision }) : receipt.outcome === 'EXISTING' ? t('ban.pack.receipt.existing', { revision: receipt.revision }) : t('ban.pack.receipt.created', { revision: receipt.revision })}{' '}
          {receipt.draft_id !== null ? <Link to={draftPath(receipt.draft_id)}>{t('ban.pack.receipt.openDraft')}</Link> : receipt.issue_id !== null ? <Link to={issuePath(receipt.issue_id)}>{t('ban.pack.receipt.openIssue')}</Link> : null}
        </p>
      )}
    </SectionCard>
  );
}

function DraftsCard() {
  const { t } = useTranslation();
  const query = useDrafts(PACK_LAYOUT);
  const step = useStep();
  const [acting, setActing] = useState<{ draft: Draft; action: Action } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const rows = ((query.data as { items?: Draft[] } | undefined)?.items ?? []) as Draft[];
  const columns: DataTableColumn<Draft>[] = [
    { key: 'period', header: t('ban.pack.col.period'), pinned: true, render: (draft) => <strong>{dayText(draft.period_code)}</strong> },
    { key: 'state', header: t('ban.pack.col.state'), render: (draft) => <StatePill state={draft.state} /> },
    { key: 'prepared', header: t('ban.pack.col.preparer'), render: (draft) => draft.prepared_by_name ?? '–' },
    { key: 'checked', header: t('ban.pack.col.checker'), render: (draft) => draft.checked_by_name ?? '–' },
    { key: 'approved', header: t('ban.pack.col.approver'), render: (draft) => draft.approved_by_name ?? '–' },
    { key: 'when', header: t('ban.pack.col.when'), render: (draft) => vietnamDateTime(draft.created_at) },
    {
      key: 'next',
      header: t('ban.pack.col.next'),
      render: (draft) => {
        const action = nextAction(draft);
        return (
          <div className="ban-actions">
            {action === undefined ? (
              <span className="ban-muted">{draft.state === 'ISSUED' ? t('ban.pack.wait.issued') : draft.state === 'DRAFT' ? t('ban.pack.wait.check') : draft.state === 'CHECKED' ? t('ban.pack.wait.approve') : t('ban.pack.wait.issue')}</span>
            ) : (
              <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid={`step-${action}-${draft.id}`} onClick={() => { setError(undefined); setActing({ draft, action }); }}>
                {action === 'check' ? t('ban.pack.act.check') : action === 'approve' ? t('ban.pack.act.approve') : t('ban.pack.act.issue')}
              </button>
            )}
            <Link className="ui-button ui-button--outline ui-button--small" to={draftPath(draft.id)}>
              {t('ban.pack.link.draft')}
            </Link>
          </div>
        );
      },
    },
  ];
  return (
    <SectionCard title={t('ban.pack.drafts.title')}>
      <div data-testid="pack-drafts">
        <Part query={query} empty={rows.length === 0} emptyText={t('ban.pack.drafts.empty.text')} deniedText={t('ban.pack.drafts.denied.text')} source={t('ban.pack.drafts.source')}>
          <DataTable caption={t('ban.pack.drafts.caption')} columns={columns} rows={rows} rowKey={(draft) => draft.id} />
        </Part>
      </div>
      {acting === undefined ? null : (
        <ConfirmDialog
          open
          title={acting.action === 'check' ? t('ban.pack.confirm.check.title') : acting.action === 'approve' ? t('ban.pack.confirm.approve.title') : t('ban.pack.confirm.issue.title')}
          context={[{ label: t('ban.pack.col.period'), value: dayText(acting.draft.period_code) }]}
          confirmLabel={acting.action === 'check' ? t('ban.pack.act.check') : acting.action === 'approve' ? t('ban.pack.act.approve') : t('ban.pack.act.issue')}
          cancelLabel={t('ban.att.dialog.cancel')}
          pending={step.isPending}
          {...(error === undefined ? {} : { error })}
          onCancel={() => setActing(undefined)}
          onConfirm={() =>
            step.mutate({ id: acting.draft.id, version: acting.draft.version, action: acting.action }, { onSuccess: () => setActing(undefined), onError: (failure) => setError(reportRefusalText(t, failure)) })
          }
        >
          <p>{acting.action === 'check' ? t('ban.pack.confirm.check.text') : acting.action === 'approve' ? t('ban.pack.confirm.approve.text') : t('ban.pack.confirm.issue.text')}</p>
        </ConfirmDialog>
      )}
    </SectionCard>
  );
}

function IssuesCard() {
  const { t } = useTranslation();
  const query = useIssues({ layoutCode: PACK_LAYOUT, headsOnly: false, demo: undefined });
  const rows = ((query.data as { items?: Issue[] } | undefined)?.items ?? []) as Issue[];
  const columns: DataTableColumn<Issue>[] = [
    { key: 'period', header: t('ban.pack.col.period'), pinned: true, render: (issue) => <strong>{dayText(issue.period_code)}</strong> },
    { key: 'revision', header: t('ban.pack.col.revision'), align: 'right', render: (issue) => issue.revision },
    { key: 'current', header: t('ban.pack.col.current'), render: (issue) => (issue.is_current ? t('ban.pack.current.yes') : t('ban.pack.current.no')) },
    { key: 'issuer', header: t('ban.pack.col.issuer'), render: (issue) => issue.issued_by_name ?? '–' },
    { key: 'when', header: t('ban.pack.col.issuedAt'), render: (issue) => vietnamDateTime(issue.issued_at) },
    {
      key: 'open',
      header: t('ban.pack.col.open'),
      render: (issue) => (
        <Link className="ui-button ui-button--outline ui-button--small" to={issuePath(issue.id)}>
          {t('ban.pack.link.issue')}
        </Link>
      ),
    },
  ];
  return (
    <SectionCard title={t('ban.pack.issues.title')}>
      <div data-testid="pack-issues">
        <Part query={query} empty={rows.length === 0} emptyText={t('ban.pack.issues.empty.text')} deniedText={t('ban.pack.issues.denied.text')} source={t('ban.pack.issues.source')}>
          <DataTable caption={t('ban.pack.issues.caption')} columns={columns} rows={rows} rowKey={(issue) => issue.id} />
        </Part>
      </div>
    </SectionCard>
  );
}

/**
 * BAN-03, the pack of the meeting: what the file will hold, section by section, read through the same service as the screens; the form `BAN-MEETING-PACK` of the report engine makes the Word and Excel files; three different
 * people prepare, check and approve; the drafts and the copies already issued are listed with the way on to RPT-02 and RPT-03. A figure with no value is an empty cell in the file and "no data" here, never 0.
 */
export default function PackScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  return (
    <Guarded route={route} permission={PERMISSION.read} title={t('ban.pack.page.title')} subtitle={t('ban.pack.page.subtitle')}>
      <PackContent />
    </Guarded>
  );
}

function PackContent() {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [params, setParams] = useSearchParams();
  const asOf = isDay(params.get('as_of') ?? '') ? (params.get('as_of') as string) : '';
  const [typed, setTyped] = useState(asOf === '' ? vietnamDay() : asOf);
  const [dimension, setDimension] = useState<Dimension>(dimensionOf(null));
  const query = usePack(asOf);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const day = data?.as_of ?? (asOf === '' ? vietnamDay() : asOf);
  return (
    <>
      <ContextBar
        items={[
          { label: t('ban.dash.context.scope'), value: tenant?.name ?? '–' },
          { label: t('ban.dash.context.asOf'), value: data === undefined ? '–' : dayText(data.as_of) },
          { label: t('ban.pack.context.form'), value: data === undefined ? PACK_LAYOUT : `${data.layout_code} ${data.layout_version}` },
        ]}
        unit={t('ban.dash.unit.vnd')}
        {...(query.dataUpdatedAt > 0 ? { asOf: clockText(query.dataUpdatedAt) } : {})}
        stale={query.isError && data !== undefined}
      />
      <form
        className="ban-audit-filters"
        aria-label={t('ban.pack.day.aria')}
        onSubmit={(event) => {
          event.preventDefault();
          setParams(isDay(typed) ? new URLSearchParams({ as_of: typed }) : new URLSearchParams());
        }}
      >
        <label htmlFor="ban-pack-day">
          <span>{t('ban.pack.day.label')}</span>
          <input id="ban-pack-day" type="date" max={vietnamDay()} value={typed} data-testid="pack-day" onChange={(event) => setTyped(event.target.value)} />
        </label>
        <button type="submit" className="ui-button ui-button--outline">
          {t('ban.pack.day.apply')}
        </button>
      </form>
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data === undefined ? null : (
          <>
            <PolicyNotice policy={data.policy} />
            <FeedNotice feed={data.feed} />
            <SectionCard title={t('ban.pack.sections.title')}>
              <SectionsList pack={data} />
            </SectionCard>
            <section className="ban-figures" aria-label={t('ban.dash.figures.aria')} data-testid="pack-figures">
              {toFigures(data.figures).map((tile) => (
                <FigureTile key={tile.metricCode} tile={tile} />
              ))}
            </section>
            <ProvinceCard row={data.province} />
            <DimensionTabs workspace={data} dimension={dimension} filtered={false} onChoose={setDimension} />
          </>
        )}
      </StateBoundary>
      <GenerateCard day={day} />
      <DraftsCard />
      <IssuesCard />
    </>
  );
}
