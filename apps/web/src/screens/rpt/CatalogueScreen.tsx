import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useEdition } from '../../editions/EditionContext';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { holds } from '../../session/holds';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, StatusPill } from '../../ui';
import type { DataTableColumn, Tone } from '../../ui';
import { DemoBadge, needsReason, refusalText } from './components';
import { useCatalogue, useGenerate } from './hooks';
import { GENERATE_PERMISSION, REASON_MIN, defaultPeriod, indexLimit, kindWord, periodBody, statusWord, vietnamDateTime } from './model';
import type { Entry, Generated, PeriodInput } from './model';
import './rpt.css';

const statusTone = (status: Entry['status']): Tone => (status === 'READY' ? 'success' : status === 'DEMO' ? 'danger' : 'warning');

interface DialogProps {
  entry: Entry;
  onClose: () => void;
  onDone: (result: Generated) => void;
}

/** The period and, when a copy of the same period was issued with other figures, the reason: the server says which it wants. */
function GenerateDialog({ entry, onClose, onDone }: DialogProps) {
  const { t } = useTranslation();
  const generate = useGenerate();
  const [period, setPeriod] = useState<PeriodInput>(() => defaultPeriod(entry.period_kind, new Date()));
  const [reasonAsked, setReasonAsked] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const body = periodBody(period);
  const limit = indexLimit(entry.period_kind);
  const set = (change: Partial<PeriodInput>): void => {
    setError(undefined);
    setPeriod({ ...period, ...change });
  };
  return (
    <ConfirmDialog
      open
      title={t('rpt.cat.dialog.title', { code: entry.code })}
      context={[
        { label: t('rpt.cat.dialog.form'), value: entry.name },
        { label: t('rpt.cat.dialog.kind'), value: t(`rpt.common.kind.${kindWord(entry.period_kind)}`) },
      ]}
      confirmLabel={t('rpt.cat.dialog.confirm')}
      cancelLabel={t('rpt.cat.dialog.cancel')}
      pending={generate.isPending}
      {...(reasonAsked ? { reason: { label: t('rpt.cat.dialog.reason.label'), required: true, minLength: REASON_MIN, hint: t('rpt.cat.dialog.reason.hint', { min: REASON_MIN }) } } : {})}
      {...(error === undefined ? {} : { error })}
      onCancel={onClose}
      onConfirm={(reason) => {
        if (body === undefined) {
          setError(t('rpt.cat.dialog.period.invalid'));
          return;
        }
        generate.mutate(
          { layoutCode: entry.code, period: body, reason: reason === undefined || reason.trim() === '' ? undefined : reason.trim() },
          {
            onSuccess: (result) => onDone(result),
            onError: (failure) => {
              if (needsReason(failure)) setReasonAsked(true);
              setError(refusalText(t, failure));
            },
          },
        );
      }}
    >
      <div className="rpt-period" data-testid="period-fields">
        <label>
          {t('rpt.cat.dialog.year')}
          <input type="text" inputMode="numeric" maxLength={4} value={period.year} data-testid="period-year" onChange={(event) => set({ year: event.target.value })} />
        </label>
        {limit > 0 ? (
          <label>
            {t(`rpt.cat.dialog.index.${kindWord(entry.period_kind)}`)}
            <input type="text" inputMode="numeric" maxLength={2} value={period.index} data-testid="period-index" onChange={(event) => set({ index: event.target.value })} />
          </label>
        ) : null}
        {entry.period_kind === 'AS_OF' ? (
          <label>
            {t('rpt.cat.dialog.day')}
            <input type="date" value={period.day} data-testid="period-day" onChange={(event) => set({ day: event.target.value })} />
          </label>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}

/**
 * RPT-01, the catalogue of the report forms of the edition and the place a report is generated from (RPT-1 part 2): which forms this edition has, whether each is a form the system designed (DEMO) or one the receiver
 * confirmed, the receiver, the kind of period and where its figures come from; a form that can be issued has a button that asks for the period and makes the draft. A DEMO form carries its mark here too, and is not offered
 * while demo forms are off (R18).
 */
export default function CatalogueScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <CatalogueContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CatalogueContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  const navigate = useNavigate();
  // The catalogue is the one of the running edition: its enterprise build never labels a form it offers as public.
  const running = useEdition().manifest.edition;
  const query = useCatalogue();
  const [chosen, setChosen] = useState<Entry | undefined>(undefined);
  const [result, setResult] = useState<{ entry: Entry; generated: Generated } | undefined>(undefined);
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: (value) => (value as { items: unknown[] }).items.length === 0 });
  const refreshFailed = query.isError && data !== undefined;
  const hasDemo = data?.items.some((entry) => entry.status === 'DEMO') ?? false;

  const columns: DataTableColumn<Entry>[] = [
    {
      key: 'form',
      header: t('scr2.rpt.cat.col.form'),
      pinned: true,
      render: (entry) => (
        <>
          <strong data-testid={`form-${entry.code}`}>{entry.code}</strong>
          <div>{entry.name}</div>
          {entry.status === 'DEMO' && entry.demo_mark !== null ? <DemoBadge mark={entry.demo_mark} /> : null}
        </>
      ),
    },
    { key: 'version', header: t('rpt.cat.col.version'), render: (entry) => entry.version },
    { key: 'edition', header: t('rpt.cat.col.edition'), render: (entry) => t(`rpt.common.edition.${running === 'enterprise' ? 'enterprise' : entry.edition}`) },
    { key: 'status', header: t('scr2.rpt.cat.col.status'), render: (entry) => <StatusPill tone={statusTone(entry.status)}>{t(`rpt.common.status.${statusWord(entry.status)}`)}</StatusPill> },
    { key: 'official', header: t('rpt.cat.col.official'), render: (entry) => t(`rpt.common.official.${statusWord(entry.official)}`) },
    { key: 'receiver', header: t('rpt.cat.col.receiver'), render: (entry) => entry.receiver },
    { key: 'kind', header: t('rpt.cat.col.kind'), render: (entry) => t(`rpt.common.kind.${kindWord(entry.period_kind)}`) },
    { key: 'source', header: t('rpt.cat.col.source'), render: (entry) => t(`rpt.common.source.${entry.data_source.toLowerCase()}`) },
    { key: 'issuable', header: t('scr2.rpt.cat.col.issuable'), render: (entry) => <span data-testid={`issuable-${entry.code}`}>{entry.issuable ? t('scr2.rpt.cat.issuable.yes') : t('scr2.rpt.cat.issuable.no')}</span> },
    {
      key: 'action',
      header: t('scr2.rpt.cat.col.action'),
      render: (entry) => {
        if (data?.can_generate !== true || !holds(permissions, GENERATE_PERMISSION)) return <span className="rpt-muted">{t('rpt.cat.action.noRight')}</span>;
        if (!entry.issuable) return <span className="rpt-muted" data-testid={`blocked-${entry.code}`}>{t('rpt.cat.action.demoOff')}</span>;
        return (
          <button type="button" className="ui-button ui-button--primary ui-button--small" data-testid={`generate-${entry.code}`} onClick={() => setChosen(entry)}>
            {t('rpt.cat.action.generate')}
          </button>
        );
      },
    },
  ];

  const open = (generated: Generated): void => {
    const target = generated.outcome === 'DUPLICATE' ? generated.issue_id : generated.draft_id;
    if (target === null) return;
    void navigate(generated.outcome === 'DUPLICATE' ? `/rpt/rpt-03?issue=${target}` : `/rpt/rpt-02?draft=${target}`);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('rpt.cat.page.title')}</h1>
          <p>{t('rpt.cat.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('rpt.cat.context.scope'), value: tenant?.name ?? '–' },
          { label: t('rpt.cat.context.demo'), value: data === undefined ? '–' : data.demo_mode ? t('rpt.cat.context.demo.on') : t('rpt.cat.context.demo.off') },
        ]}
        {...(data === undefined ? {} : { asOf: vietnamDateTime(data.as_of) })}
        stale={refreshFailed}
      />
      {hasDemo ? (
        <p className="callout" role="note" data-testid="demo-note">
          {data?.demo_mode === true ? t('rpt.cat.demo.on.text') : t('rpt.cat.demo.off.text')}
        </p>
      ) : null}
      {result === undefined ? null : (
        <p className="callout rpt-receipt" role="status" data-testid="generate-receipt">
          {result.generated.outcome === 'CREATED' ? t('rpt.cat.receipt.created', { code: result.entry.code }) : null}
          {result.generated.outcome === 'EXISTING' ? t('rpt.cat.receipt.existing', { code: result.entry.code }) : null}
          {result.generated.outcome === 'DUPLICATE' ? t('rpt.cat.receipt.duplicate', { code: result.entry.code, revision: result.generated.revision }) : null}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid="receipt-open" onClick={() => open(result.generated)}>
            {result.generated.outcome === 'DUPLICATE' ? t('rpt.cat.receipt.openIssue') : t('rpt.cat.receipt.openDraft')}
          </button>
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && <DataTable caption={t('rpt.cat.table.caption')} columns={columns} rows={data.items} rowKey={(entry) => entry.code} />}
      </StateBoundary>
      {chosen === undefined ? null : (
        <GenerateDialog
          entry={chosen}
          onClose={() => setChosen(undefined)}
          onDone={(generated) => {
            setResult({ entry: chosen, generated });
            setChosen(undefined);
          }}
        />
      )}
      <p className="prototype-note">{t('rpt.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
