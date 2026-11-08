import { useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, DataTable, SectionCard, StatusPill } from '../../ui';
import { useControlGenerator, useFeedConnection, useFeedRuns, useReload } from './feed-hooks';
import { generatorActionLabel, generatorBlockLabel, generatorEffect, generatorIssueLabel, historyActionLabel, problemText } from './feed-labels';
import {
  GENERATOR_ACTIONS,
  GENERATOR_FIELDS,
  GENERATOR_LIMITS,
  FISCAL_YEAR_RANGE,
  MIN_REASON,
  commandBlock,
  describeProblem,
  generatorBlock,
  generatorBody,
  generatorFormOf,
  isGeneratorEvent,
  numberText,
  validateGenerator,
  vietnamStamp,
} from './feed-model';
import type { Connection, GeneratorAction, GeneratorErrors, GeneratorField, GeneratorForm, GeneratorReceipt, Problem } from './feed-model';
import { DASH, FeedLinks, Figure, ListState, PagingFoot, ProblemNote, StaleNote } from './feed-parts';
import { RunsTable } from './run-components';
import './feed.css';

type T = Translator['t'];

const FIELD_LIMITS: Readonly<Record<GeneratorField, readonly [number, number]>> = {
  seed: GENERATOR_LIMITS.seed,
  fiscalYear: FISCAL_YEAR_RANGE,
  currentMonth: GENERATOR_LIMITS.currentMonth,
  projectCount: GENERATOR_LIMITS.projectCount,
  lateUnits: GENERATOR_LIMITS.lateUnits,
  delayedPct: GENERATOR_LIMITS.delayedPct,
  aheadPct: GENERATOR_LIMITS.aheadPct,
  discrepancies: GENERATOR_LIMITS.discrepancies,
  anchorCount: GENERATOR_LIMITS.anchorCount,
};

const FIELD_ORDER: readonly GeneratorField[] = ['seed', 'fiscalYear', 'currentMonth', 'projectCount', 'lateUnits', 'delayedPct', 'aheadPct', 'discrepancies', 'anchorCount'];

function fieldLabel(t: T, field: GeneratorField): string {
  switch (field) {
    case 'seed':
      return t('feed.generator.field.seed.label');
    case 'fiscalYear':
      return t('feed.generator.field.fiscalYear.label');
    case 'currentMonth':
      return t('feed.generator.field.currentMonth.label');
    case 'projectCount':
      return t('feed.generator.field.projectCount.label');
    case 'lateUnits':
      return t('feed.generator.field.lateUnits.label');
    case 'delayedPct':
      return t('feed.generator.field.delayedPct.label');
    case 'aheadPct':
      return t('feed.generator.field.aheadPct.label');
    case 'discrepancies':
      return t('feed.generator.field.discrepancies.label');
    case 'anchorCount':
      return t('feed.generator.field.anchorCount.label');
  }
}

/**
 * FEED-05, the control of the data generator ("bo sinh du lieu"): a deterministic producer of realistic records that goes through the same layouts, the same dry run and the same apply as a file. The screen shows its state, its seed, the fiscal
 * year and the month it has reached and its parameters, and offers four moves, each with a reason: start, stop, reseed (a new seed, a new epoch) and tick (one month on). The moves are judged by the server again; the history keeps every one.
 */
export default function GeneratorScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form, the dialog and the receipt belong to one membership: a switch of tenant or of membership starts the screen over.
  return <GeneratorContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function GeneratorContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, mode } = useSession();
  const query = useFeedConnection();
  const data = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: data === undefined ? query.error : undefined, data, isEmpty: () => false });
  const refreshFailed = query.isError && data !== undefined;
  const block = data === undefined ? null : commandBlock(data.actions.controlGenerator, mode);
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="feed-head">
        <div>
          <h1 id="screen-title">{t('feed.generator.page.title')}</h1>
          <p>{t('feed.generator.page.subtitle')}</p>
          <FeedLinks current="generator" />
        </div>
      </div>
      <ContextBar items={[{ label: t('feed.generator.context.scope.label'), value: tenant?.name ?? '' }]} {...(data === undefined ? {} : { asOf: vietnamStamp(data.asOf) })} stale={refreshFailed} />
      {refreshFailed && <StaleNote asOf={data.asOf === '' ? null : data.asOf} onRetry={() => void query.refetch()} />}
      {block !== null && (
        <p className="callout" data-testid="readonly-note">
          {block === 'MODE' ? t('feed.common.readonly.mode') : t('feed.common.readonly.right')}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {data !== undefined && (
          <div className="feed-page">
            <StateSection connection={data} />
            <ControlSection connection={data} allowed={block === null} />
            <ProducedSection />
            <MovesSection connection={data} />
          </div>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('feed.common.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The state of the generator: running or stopped, the epoch, the seed, the year and the month it has reached and the parameters it runs with. A generator that never started says so. */
function StateSection({ connection }: { connection: Connection }) {
  const { t, locale } = useTranslation();
  const generator = connection.generator;
  const params = generator.parameters;
  const asOf = vietnamStamp(connection.asOf);
  const figure = (name: string, formula: string) => <Figure name={name} formula={formula} source={t('feed.generator.figure.source')} asOf={asOf} version={t('feed.generator.figure.version', { epoch: generator.epoch })} />;
  const value = (number: number | null, suffix?: string): string => (number === null ? DASH : suffix === undefined ? numberText(number, locale) : `${numberText(number, locale)}${suffix}`);
  const never = params === null;
  return (
    <SectionCard title={t('feed.generator.section.state.title')}>
      <dl className="feed-facts" data-testid="generator-state">
        <div className="feed-fact" data-testid="generator-running">
          <dt>{t('feed.generator.state.label')}</dt>
          <dd>
            {generator.state === 'RUNNING' ? (
              <StatusPill tone="success" icon="▶">
                {t('feed.generator.state.running')}
              </StatusPill>
            ) : (
              <StatusPill tone="neutral" icon="■">
                {t('feed.generator.state.stopped')}
              </StatusPill>
            )}{' '}
            {never && <span>{t('feed.generator.state.never')}</span>}
          </dd>
        </div>
        <div className="feed-fact" data-testid="generator-epoch">
          <dt>{t('feed.generator.epoch.label')}</dt>
          <dd>
            {numberText(generator.epoch, locale)} {figure(t('feed.generator.epoch.label'), t('feed.generator.figure.epoch.formula'))}
          </dd>
        </div>
        <div className="feed-fact" data-testid="generator-month">
          <dt>{t('feed.generator.month.label')}</dt>
          <dd>
            {params === null || params.currentMonth === null || params.fiscalYear === null ? DASH : t('feed.generator.month.value', { month: params.currentMonth, year: params.fiscalYear })} {figure(t('feed.generator.month.label'), t('feed.generator.figure.month.formula'))}
          </dd>
        </div>
        <div className="feed-fact" data-testid="generator-seed">
          <dt>{t('feed.generator.seed.label')}</dt>
          <dd>
            {value(params?.seed ?? null)} {figure(t('feed.generator.seed.label'), t('feed.generator.figure.seed.formula'))}
          </dd>
        </div>
        <div className="feed-fact" data-testid="generator-projects">
          <dt>{t('feed.generator.field.projectCount.label')}</dt>
          <dd>
            {value(params?.projectCount ?? null)} {figure(t('feed.generator.field.projectCount.label'), t('feed.generator.figure.parameter.formula'))}
          </dd>
        </div>
        <div className="feed-fact" data-testid="generator-late">
          <dt>{t('feed.generator.field.lateUnits.label')}</dt>
          <dd>
            {value(params?.lateUnits ?? null)} {figure(t('feed.generator.field.lateUnits.label'), t('feed.generator.figure.parameter.formula'))}
          </dd>
        </div>
        <div className="feed-fact" data-testid="generator-delayed">
          <dt>{t('feed.generator.field.delayedPct.label')}</dt>
          <dd>
            {value(params?.delayedPct ?? null, '%')} {figure(t('feed.generator.field.delayedPct.label'), t('feed.generator.figure.parameter.formula'))}
          </dd>
        </div>
        <div className="feed-fact" data-testid="generator-ahead">
          <dt>{t('feed.generator.field.aheadPct.label')}</dt>
          <dd>
            {value(params?.aheadPct ?? null, '%')} {figure(t('feed.generator.field.aheadPct.label'), t('feed.generator.figure.parameter.formula'))}
          </dd>
        </div>
        <div className="feed-fact" data-testid="generator-discrepancies">
          <dt>{t('feed.generator.field.discrepancies.label')}</dt>
          <dd>
            {value(params?.discrepancies ?? null)} {figure(t('feed.generator.field.discrepancies.label'), t('feed.generator.figure.parameter.formula'))}
          </dd>
        </div>
        <div className="feed-fact" data-testid="generator-anchors">
          <dt>{t('feed.generator.field.anchorCount.label')}</dt>
          <dd>
            {value(params?.anchorCount ?? null)} {figure(t('feed.generator.field.anchorCount.label'), t('feed.generator.figure.parameter.formula'))}
          </dd>
        </div>
      </dl>
      {!connection.enabled && (
        <p className="callout warning" role="status" data-testid="generator-connection-off">
          {t('feed.generator.connectionOff.text')}
        </p>
      )}
    </SectionCard>
  );
}

const STATE_AFTER: Readonly<Record<GeneratorAction, 'RUNNING' | 'STOPPED' | 'SAME'>> = { START: 'RUNNING', STOP: 'STOPPED', RESEED: 'SAME', TICK: 'RUNNING' };

function stateWord(t: T, state: 'RUNNING' | 'STOPPED'): string {
  return state === 'RUNNING' ? t('feed.generator.state.running') : t('feed.generator.state.stopped');
}

/** The form of the parameters and the four moves. A move that the state does not allow is off, and the words say why; a move that is open asks for its reason in a dialog before it is sent. */
function ControlSection({ connection, allowed }: { connection: Connection; allowed: boolean }) {
  const { t, locale } = useTranslation();
  const control = useControlGenerator();
  const reload = useReload();
  const [form, setForm] = useState<GeneratorForm>(() => generatorFormOf(connection.generator.parameters));
  const [errors, setErrors] = useState<GeneratorErrors>({});
  const [pending, setPending] = useState<GeneratorAction | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [receipt, setReceipt] = useState<{ action: GeneratorAction; value: GeneratorReceipt | undefined } | undefined>(undefined);
  const sending = useRef(false);

  const change = (field: GeneratorField, value: string): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors({});
    setProblem(undefined);
  };
  const open = (action: GeneratorAction): void => {
    const found = validateGenerator(action, form);
    setErrors(found);
    setProblem(undefined);
    setReceipt(undefined);
    if (Object.keys(found).length === 0) setPending(action);
  };
  const send = (reason?: string): void => {
    if (pending === undefined || sending.current) return;
    sending.current = true;
    setProblem(undefined);
    const action = pending;
    control.mutate(
      { body: generatorBody(action, { ...form, reason: reason ?? '' }), version: connection.version },
      {
        onSuccess: (value) => {
          sending.current = false;
          setPending(undefined);
          setReceipt({ action, value });
        },
        onError: (failure) => {
          sending.current = false;
          setProblem(describeProblem(failure));
        },
      },
    );
  };
  const stateBefore = connection.generator.state;
  const after = pending === undefined ? 'SAME' : STATE_AFTER[pending];

  return (
    <SectionCard title={t('feed.generator.section.control.title')}>
      <p className="feed-note">{t('feed.generator.control.intro.text')}</p>
      <div className="feed-grid" data-testid="generator-form">
        {FIELD_ORDER.map((field) => {
          const issue = errors[field];
          const id = `feed-generator-${field}`;
          return (
            <div className="field" key={field}>
              <label htmlFor={id}>{fieldLabel(t, field)}</label>
              <input id={id} inputMode="numeric" value={form[field]} disabled={!allowed} aria-invalid={issue !== undefined} autoComplete="off" onChange={(event) => change(field, event.target.value)} />
              <span className="sub">{t('feed.generator.field.range.hint', { min: FIELD_LIMITS[field][0], max: FIELD_LIMITS[field][1] })}</span>
              {issue !== undefined && (
                <span className="feed-error" data-testid={`error-${field}`}>
                  {generatorIssueLabel(t, issue, FIELD_LIMITS[field])}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p className="feed-note">{t('feed.generator.control.fields.note')}</p>
      <div className="feed-actions" data-testid="generator-actions">
        {GENERATOR_ACTIONS.map((action) => {
          const why = generatorBlock(action, connection);
          const disabled = !allowed || why !== null || control.isPending;
          return (
            <button
              key={action}
              type="button"
              className={action === 'STOP' ? 'ui-button ui-button--outline' : 'ui-button ui-button--primary'}
              data-testid={`action-${action.toLowerCase()}`}
              disabled={disabled}
              aria-describedby={allowed && why !== null ? `feed-generator-why-${action}` : undefined}
              onClick={() => open(action)}
            >
              {generatorActionLabel(t, action)}
            </button>
          );
        })}
      </div>
      {allowed &&
        GENERATOR_ACTIONS.map((action) => {
          const why = generatorBlock(action, connection);
          return why === null ? null : (
            <small key={action} className="sub" id={`feed-generator-why-${action}`} data-testid={`why-${action.toLowerCase()}`} data-reason={why}>
              {t('feed.generator.block.line', { action: generatorActionLabel(t, action), why: generatorBlockLabel(t, why) })}
            </small>
          );
        })}
      {problem !== undefined && pending === undefined && <ProblemNote problem={problem} onReload={() => void reload()} />}
      {receipt !== undefined && (
        <div className="callout feed-receipt" role="status" data-testid="generator-receipt">
          <p>{t('feed.generator.receipt.text', { action: generatorActionLabel(t, receipt.action) })}</p>
          {receipt.value !== undefined && (
            <p data-testid="generator-receipt-facts">
              {t('feed.generator.receipt.facts', {
                state: receipt.value.state === 'RUNNING' ? t('feed.generator.state.running') : t('feed.generator.state.stopped'),
                epoch: numberText(receipt.value.epoch, locale),
                month: receipt.value.month === null ? DASH : receipt.value.month,
                written: receipt.value.recordsWritten === null ? DASH : numberText(receipt.value.recordsWritten, locale),
                skipped: receipt.value.recordsSkipped === null ? DASH : numberText(receipt.value.recordsSkipped, locale),
                mappings: numberText(receipt.value.mappingsProposed, locale),
              })}
            </p>
          )}
        </div>
      )}
      {pending !== undefined && (
        <ConfirmDialog
          open
          title={t('feed.generator.dialog.title', { action: generatorActionLabel(t, pending) })}
          context={[
            { label: t('feed.generator.dialog.move.label'), value: generatorActionLabel(t, pending) },
            { label: t('feed.generator.dialog.state.label'), value: after === 'SAME' ? stateWord(t, stateBefore) : t('feed.generator.dialog.state.change', { from: stateWord(t, stateBefore), to: stateWord(t, after) }) },
            { label: t('feed.generator.epoch.label'), value: pending === 'START' || pending === 'RESEED' ? t('feed.generator.dialog.epoch.raised', { from: connection.generator.epoch, to: connection.generator.epoch + 1 }) : String(connection.generator.epoch) },
          ]}
          confirmLabel={generatorActionLabel(t, pending)}
          cancelLabel={t('feed.common.dialog.cancel.action')}
          pending={control.isPending}
          reason={{ label: t('feed.common.dialog.reason.label'), required: true, minLength: MIN_REASON, hint: t('feed.common.dialog.reason.hint', { count: MIN_REASON }) }}
          {...(problem === undefined ? {} : { error: problemText(t, problem) })}
          onCancel={() => {
            sending.current = false;
            setPending(undefined);
            setProblem(undefined);
          }}
          onConfirm={send}
        >
          <p className="feed-note" data-testid="generator-effect">
            {generatorEffect(t, pending)}
          </p>
          {GENERATOR_FIELDS[pending].length > 0 && <p className="feed-note">{t('feed.generator.dialog.fields.note')}</p>}
        </ConfirmDialog>
      )}
    </SectionCard>
  );
}

/** The runs the generator produced, the way every run is listed. */
function ProducedSection() {
  const { t } = useTranslation();
  const filters = useMemo(() => ({ channel: 'GENERATOR' as const }), []);
  const list = useFeedRuns(filters);
  const pages = list.data?.pages;
  const rows = useMemo(() => (pages ?? []).flatMap((page) => page.items), [pages]);
  const state = useScreenState({ isLoading: list.isLoading, error: list.data === undefined ? list.error : undefined, data: list.data, isEmpty: () => rows.length === 0 });
  return (
    <SectionCard title={t('feed.generator.section.produced.title')}>
      <ListState
        state={state}
        onRetry={() => void list.refetch()}
        empty={
          <p className="feed-none" role="status" data-testid="produced-empty">
            {t('feed.generator.produced.empty.text')}
          </p>
        }
      />
      {state === 'default' && (
        <>
          <RunsTable runs={rows} caption={t('feed.generator.produced.caption')} />
          <PagingFoot shown={rows.length} hasMore={list.hasNextPage} loadingMore={list.isFetchingNextPage} failedMore={list.isFetchNextPageError} onMore={() => void list.fetchNextPage()} />
        </>
      )}
    </SectionCard>
  );
}

/** The moves of the generator that the history of the connection keeps: when, which, who, why. */
function MovesSection({ connection }: { connection: Connection }) {
  const { t } = useTranslation();
  const moves = connection.history.filter((entry) => isGeneratorEvent(entry.action));
  return (
    <SectionCard title={t('feed.generator.section.moves.title')}>
      {moves.length === 0 ? (
        <p className="feed-none" data-testid="moves-empty">
          {t('feed.generator.moves.empty.text')}
        </p>
      ) : (
        <DataTable
          caption={t('feed.generator.moves.caption')}
          rows={moves}
          rowKey={(row) => row.id}
          columns={[
            { key: 'at', header: t('feed.generator.moves.column.at'), pinned: true, render: (row) => vietnamStamp(row.occurredAt) },
            { key: 'action', header: t('feed.generator.moves.column.action'), render: (row) => historyActionLabel(t, row.action) },
            { key: 'who', header: t('feed.generator.moves.column.who'), render: (row) => row.actorName ?? t('feed.generator.moves.who.none') },
            { key: 'reason', header: t('feed.generator.moves.column.reason'), render: (row) => row.reason ?? t('feed.generator.moves.reason.none') },
          ]}
        />
      )}
    </SectionCard>
  );
}
