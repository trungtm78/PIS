import { ApiError } from '@machvon/api-client';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, SectionCard, StatusPill } from '../../ui';
import '../dis/dis.css';
import { vietnamToday } from '../mne/model';
import './home.css';
import { RagBandBadge, bandLabel } from './gov-components';
import { useRagCommands, useRagReading } from './gov-hooks';
import { OVERRIDE_PERMISSION, OVERRIDE_REASON_MAX, OVERRIDE_REASON_MIN, RAG_BANDS, SCORE_PERMISSION, describeRag, isRefused, reasonOk } from './gov-model';
import type { OverrideBand, RagReading, RagUnit } from './gov-model';
import { RagUnitCard, numberText } from './rag-components';
import { SNAPSHOT_SCREEN_PATH, STALE_AFTER_DAYS, isStale } from './model';
import { dayText } from './overview-model';

const COMMAND_CENTER_PATH = '/home/home-09';

type Pending = { kind: 'override'; unit: RagUnit; band: OverrideBand; until: string } | { kind: 'withdraw'; unit: RagUnit };
type DialogError = 'reason' | 'gone' | 'failed';

/**
 * HOME-11: "Màu xanh vàng đỏ có giải thích" (G3-2). The colour of a unit is judged by rules; each unit says why (the one to three factors that moved it, each value against its line), how much of the data was there, the week
 * before and the trend of the weeks. A unit with too little data is "chưa đủ dữ liệu", never green and never 0. A person who may can put a colour over the rules' own for at most 90 days, with a reason; the rules' colour stays
 * beside it. Red comes first.
 */
export default function RagScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <RagContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function RagContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const unitId = params.get('unit') ?? '';
  const { permissions, mode } = useSession();
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const frozen = mode === 'READ_ONLY';
  const query = useRagReading(unitId);
  const commands = useRagCommands();
  const reading = query.data;
  const problem = query.error === null ? undefined : describeRag(query.error);
  const noSnapshot = problem === 'noSnapshot' && reading === undefined;
  const today = vietnamToday();
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [dialogError, setDialogError] = useState<DialogError | undefined>(undefined);
  const [refused, setRefused] = useState(false);
  const [scored, setScored] = useState<string | undefined>(undefined);
  const canOverride = !frozen && holds(OVERRIDE_PERMISSION);
  const canScore = !frozen && holds(SCORE_PERMISSION);
  const state = useScreenState({ isLoading: query.isLoading, error: noSnapshot ? undefined : reading === undefined ? query.error : undefined, data: noSnapshot ? undefined : reading, isEmpty: (data) => (data as RagReading).units.length === 0 });
  const stale = reading !== undefined && isStale({ freshness: 'FRESH', asOfDate: reading.asOfDate }, today);
  const busy = commands.override.isPending || commands.withdraw.isPending;

  const close = (): void => {
    if (busy) return;
    setPending(undefined);
    setDialogError(undefined);
    commands.override.reset();
    commands.withdraw.reset();
  };
  const failed = (error: unknown): void => {
    if (isRefused(error)) {
      // The server refused the right: it is said as a refusal, not as a failure to try again.
      setRefused(true);
      setPending(undefined);
      setDialogError(undefined);
      return;
    }
    setDialogError(error instanceof ApiError && error.code === 'RESOURCE_NOT_FOUND' && pending?.kind === 'withdraw' ? 'gone' : 'failed');
  };
  const confirm = (reason?: string): void => {
    if (pending === undefined || busy) return;
    const text = reason ?? '';
    if (!reasonOk(text)) {
      setDialogError('reason');
      return;
    }
    setDialogError(undefined);
    setRefused(false);
    const onSuccess = (): void => {
      setPending(undefined);
    };
    if (pending.kind === 'override') commands.override.mutate({ unitId: pending.unit.unitId, band: pending.band, until: pending.until, reason: text }, { onSuccess, onError: failed });
    else commands.withdraw.mutate({ unitId: pending.unit.unitId, reason: text }, { onSuccess, onError: failed });
  };
  const runScore = (): void => {
    setScored(undefined);
    setRefused(false);
    commands.score.mutate(undefined, {
      onSuccess: (answer) => setScored(String((answer as { status?: unknown }).status ?? '')),
      onError: (error) => {
        if (isRefused(error)) setRefused(true);
      },
    });
  };

  const scopeValue = unitId === '' ? t('home.filter.unit.all') : (reading?.units[0]?.name ?? '—');
  const contextItems = [
    { label: t('home.ov.context.scope'), value: scopeValue },
    { label: t('govc.home.rag.context.week'), value: reading === undefined ? '—' : dayText(reading.weekStart) },
    { label: t('home.ov.context.closing'), value: reading === undefined ? '—' : dayText(reading.asOfDate) },
  ];
  const label = pending === undefined ? '' : pending.unit.code === '' ? pending.unit.name : `${pending.unit.code} ${pending.unit.name}`.trim();
  const dialogContext =
    pending === undefined
      ? []
      : [
          { label: t('govc.home.rag.dialog.unit'), value: label },
          { label: t('govc.home.rag.override.rules'), value: bandLabel(t, pending.unit.ruleBand) },
          ...(pending.kind === 'override'
            ? [
                { label: t('govc.home.rag.override.shown'), value: bandLabel(t, pending.band) },
                { label: t('govc.home.rag.override.until'), value: dayText(pending.until) },
              ]
            : pending.unit.override === null
              ? []
              : [
                  { label: t('govc.home.rag.override.shown'), value: bandLabel(t, pending.unit.override.band) },
                  { label: t('govc.home.rag.override.until'), value: dayText(pending.unit.override.until) },
                ]),
          ...(dialogError === undefined ? [] : [{ label: t('govc.home.rag.dialog.problem'), value: dialogError === 'reason' ? t('govc.home.rag.dialog.reasonError', { min: OVERRIDE_REASON_MIN, max: OVERRIDE_REASON_MAX }) : dialogError === 'gone' ? t('govc.home.rag.dialog.gone') : t('govc.home.rag.dialog.failed') }]),
        ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('govc.home.rag.page.title')}</h1>
          <p>{t('govc.home.rag.page.subtitle')}</p>
        </div>
      </div>
      <div className="home-context">
        <ContextBar items={contextItems} unit={t('govc.home.rag.context.unit')} stale={stale} />
      </div>
      {refused ? (
        <div className="card statecard" role="alert" data-testid="rag-refused">
          <p>{t('govc.home.rag.denied.action')}</p>
        </div>
      ) : null}
      {noSnapshot ? (
        <div className="card statecard" role="status" data-testid="home-empty">
          <h2>{t('home.empty.title')}</h2>
          <p className="muted">{t('home.empty.body')}</p>
          <Link to={SNAPSHOT_SCREEN_PATH}>{t('home.empty.link')}</Link>
        </div>
      ) : null}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {reading === undefined || noSnapshot ? null : (
          <div className="home-stack">
            {query.isError ? (
              <p role="alert" className="home-notice" data-testid="rag-stale">
                {t('govc.home.changes.stale')}{' '}
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void query.refetch()}>
                  {t('ui.common.retry')}
                </button>
              </p>
            ) : null}
            {stale ? (
              <p role="status" className="home-notice" data-testid="rag-old">
                <StatusPill tone="warning">{t('govc.home.rag.old', { days: STALE_AFTER_DAYS })}</StatusPill>
              </p>
            ) : null}
            <SectionCard
              title={t('govc.home.rag.model.title')}
              status={reading.model.unverified ? <StatusPill tone="warning">{t('govc.home.rag.model.unverified')}</StatusPill> : undefined}
              actions={
                canScore ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={commands.score.isPending} onClick={runScore}>
                    {commands.score.isPending ? t('govc.home.rag.score.pending') : t('govc.home.rag.score.action')}
                  </button>
                ) : undefined
              }
            >
              <p className="home-note" data-testid="rag-model">
                {reading.model.scoreGreen === null || reading.model.scoreAmber === null ? t('govc.home.rag.model.noLines') : t('govc.home.rag.model.lines', { green: numberText(reading.model.scoreGreen, 'vi'), amber: numberText(reading.model.scoreAmber, 'vi') })}
                {reading.model.minCoveragePct === null ? '' : ` ${t('govc.home.rag.model.coverage', { min: numberText(reading.model.minCoveragePct, 'vi') })}`}
              </p>
              <ul className="home-rag-summary" data-testid="rag-summary" aria-label={t('govc.home.rag.summary.aria')}>
                {RAG_BANDS.map((band) => (
                  <li key={band} data-band={band}>
                    <RagBandBadge band={band} />
                    <strong data-testid={`rag-count-${band}`}>{reading.summary[band]}</strong>
                  </li>
                ))}
              </ul>
              <p className="home-note" role="status" aria-live="polite" data-testid="rag-score-status">
                {commands.score.isError && !isRefused(commands.score.error) ? (
                  <span role="alert">
                    {t('govc.home.rag.score.error')}
                  </span>
                ) : scored === undefined ? (
                  ''
                ) : scored === 'ALREADY_SCORED' ? (
                  t('govc.home.rag.score.already')
                ) : (
                  t('govc.home.rag.score.done')
                )}
              </p>
            </SectionCard>
            <div className="home-rag-list" data-testid="rag-units">
              {reading.units.map((unit) => (
                <RagUnitCard
                  key={unit.unitId}
                  unit={unit}
                  today={today}
                  minCoverage={reading.model.minCoveragePct}
                  canOverride={canOverride}
                  onOverride={(chosen, band, until) => {
                    setDialogError(undefined);
                    setPending({ kind: 'override', unit: chosen, band, until });
                  }}
                  onWithdraw={(chosen) => {
                    setDialogError(undefined);
                    setPending({ kind: 'withdraw', unit: chosen });
                  }}
                />
              ))}
            </div>
            <p>
              <Link to={COMMAND_CENTER_PATH}>{t('govc.home.rag.back')}</Link>
            </p>
          </div>
        )}
      </StateBoundary>
      <ConfirmDialog
        open={pending !== undefined}
        title={pending?.kind === 'withdraw' ? t('govc.home.rag.dialog.withdrawTitle') : t('govc.home.rag.dialog.overrideTitle')}
        context={dialogContext}
        confirmLabel={pending?.kind === 'withdraw' ? t('govc.home.rag.dialog.withdrawConfirm') : t('govc.home.rag.dialog.overrideConfirm')}
        cancelLabel={t('govc.home.rag.form.cancel')}
        reason={{ label: t('govc.home.rag.dialog.reason', { min: OVERRIDE_REASON_MIN, max: OVERRIDE_REASON_MAX }), required: true }}
        pending={busy}
        onConfirm={confirm}
        onCancel={close}
      />
    </section>
  );
}
