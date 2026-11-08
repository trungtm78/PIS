import { ApiError } from '@machvon/api-client';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { translator, useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, SectionCard, StatusPill } from '../../ui';
import { commaText, dayText, vndText } from './common';
import { AnaFigureInfo, NaNote, UnverifiedNote } from './components';
import { useMultiRanking, useRankingCommands } from './ranking-hooks';
import { ANNOTATE_PERMISSION, COMPLAIN_PERMISSION, NOTES_PATH, RANKING_PATH } from './ranking-model';
import type { MetricCode, MetricView, Quadrant, RankingReading, UnitRank } from './ranking-model';

type T = Translator['t'];

export function metricLabel(t: T, code: MetricCode): string {
  switch (code) {
    case 'RATE':
      return t('ana.rank.metric.rate');
    case 'PHYSICAL':
      return t('ana.rank.metric.physical');
    case 'COMPLETENESS':
      return t('ana.rank.metric.completeness');
    case 'EXPLANATIONS':
      return t('ana.rank.metric.explanations');
    case 'WARNINGS':
      return t('ana.rank.metric.warnings');
  }
}

export function quadrantLabel(t: T, quadrant: Quadrant): string {
  switch (quadrant) {
    case 'FAST_BOTH':
      return t('ana.rank.pair.fastBoth');
    case 'MONEY_AHEAD_OF_WORK':
      return t('ana.rank.pair.moneyAhead');
    case 'WORK_AHEAD_OF_MONEY':
      return t('ana.rank.pair.workAhead');
    case 'SLOW_BOTH':
      return t('ana.rank.pair.slowBoth');
  }
}

/** Why a figure is missing, in words (never 0): the reasons of the metrics and of the composite. */
export function rankReason(t: T, reason: string): string {
  switch (reason) {
    case 'NO_FIGURE':
      return t('ana.rank.na.noFigure');
    case 'NO_PLAN':
      return t('ana.rank.na.noPlan');
    case 'NO_PROJECTS':
      return t('ana.rank.na.noProjects');
    case 'NOT_READABLE':
      return t('ana.rank.na.notReadable');
    case 'NO_PHYSICAL_PROGRESS':
      return t('ana.rank.na.noPhysical');
    case 'TOO_FEW_METRICS':
      return t('ana.rank.na.tooFew');
    case 'NO_SNAPSHOT':
      return t('ana.rank.na.noSnapshot');
    case 'NOT_CERTIFIED':
      return t('ana.rank.na.notCertified');
    default:
      return t('ana.rank.na.other');
  }
}

/** The words of a reason of an annotation: the platform's own reasons are translated, one a tenant added is written as its code. */
export const annotationReasonLabel = (t: T, code: string): string => (translator.has(`ana.rank.reason.${code}`) ? t(`ana.rank.reason.${code}`) : code);

function valueText(t: T, metric: MetricView): string {
  if (metric.value === null) return t('ana.common.na');
  const text = commaText(String(metric.value));
  return metric.code === 'EXPLANATIONS' || metric.code === 'WARNINGS' ? t('ana.rank.value.perProject', { value: text }) : t('ana.rank.value.percent', { value: text });
}

type Dialog = { kind: 'annotate'; unit: UnitRank } | { kind: 'complain'; unit: UnitRank; metric: MetricCode };

function problemText(t: T, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return t('ana.rank.problem.denied');
    if (error.status === 422) return t('ana.rank.problem.invalid');
  }
  return t('ana.rank.problem.failed');
}

/**
 * BI-25: the ranking on several measures (G3-8). Units are compared among units of a similar size; each measure shows its value and its score or why it is missing; a note that a different person approved says a unit is held back
 * by something outside its control; a figure under complaint is marked; and the rate of disbursement stands beside the physical progress. The ranking by one rate (HOME-04) is unchanged.
 */
export default function MultiRankingScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <MultiRankingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function MultiRankingContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const holds = (permission: string): boolean => mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(permission));
  const query = useMultiRanking();
  const reading: RankingReading | undefined = query.data;
  const commands = useRankingCommands();
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const state = useScreenState({ isLoading: query.isLoading, error: reading === undefined ? query.error : undefined, data: reading, isEmpty: (data) => (data as RankingReading).nullReason === 'NO_SNAPSHOT' });
  const contextItems = [
    { label: t('ana.rank.context.asOf'), value: dayText(reading?.asOfDate ?? null) },
    { label: t('ana.rank.context.units'), value: reading === undefined ? '—' : String(reading.units.length) },
  ];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ana.rank.page.title')}</h1>
          <p>{t('ana.rank.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={contextItems} unit={t('ana.rank.context.unit')} />
      {notice === undefined ? null : (
        <p role="status" className="ana-na" data-testid="rank-notice">
          {notice}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {reading === undefined ? null : (
          <div className="ana-stack">
            <UnverifiedNote unverified={reading.model.unverified} />
            {reading.certificationGate === null ? null : (
              <div className="card statecard" role="status" data-testid="rank-gated">
                <h2>{t('ana.rank.gated.title')}</h2>
                <NaNote reason="NOT_CERTIFIED" label={(reason) => rankReason(t, reason)} />
              </div>
            )}
            <SectionCard title={t('ana.rank.model.title')} status={<AnaFigureInfo name={t('ana.rank.model.title')} info={reading.info} asOf={reading.asOfDate} />}>
              <ul className="ana-chips" data-testid="rank-model">
                {reading.model.metrics.map((metric) => (
                  <li key={metric.code}>
                    {metricLabel(t, metric.code)}: {t('ana.rank.model.weight', { weight: metric.weight })}
                  </li>
                ))}
              </ul>
              <p className="ana-caveat">{t('ana.rank.model.caveat', { min: reading.model.minMetrics })}</p>
              <p className="ana-caveat">{reading.model.annotationEffect === 'EXCLUDE_METRIC' ? t('ana.rank.model.effectExclude') : t('ana.rank.model.effectShow')}</p>
            </SectionCard>
            {reading.bands.map((band) => {
              const units = reading.units.filter((unit) => unit.band === band.code);
              if (units.length === 0) return null;
              return (
                <SectionCard key={band.code} title={t('ana.rank.band.title', { band: band.code, plan: vndText(band.minPlanVnd) })} status={band.thin ? <StatusPill tone="warning">{t('ana.rank.band.thin', { count: band.units })}</StatusPill> : undefined}>
                  <div className="tablewrap">
                    <table className="ana-table" aria-label={t('ana.rank.table.aria', { band: band.code })} data-testid={`rank-band-${band.code}`}>
                      <caption className="sr-only">{t('ana.rank.table.caption')}</caption>
                      <thead>
                        <tr>
                          <th scope="col" className="num">
                            {t('ana.rank.col.rank')}
                          </th>
                          <th scope="col">{t('ana.rank.col.unit')}</th>
                          <th scope="col" className="num">
                            {t('ana.rank.col.composite')}
                          </th>
                          {reading.model.metrics.map((metric) => (
                            <th key={metric.code} scope="col" className="num">
                              {metricLabel(t, metric.code)}
                            </th>
                          ))}
                          <th scope="col">{t('ana.rank.col.pair')}</th>
                          <th scope="col">
                            <span className="sr-only">{t('ana.rank.col.actions')}</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {units.map((unit) => (
                          <UnitRow key={unit.unitId} unit={unit} metrics={reading.model.metrics.map((metric) => metric.code)} canAnnotate={holds(ANNOTATE_PERMISSION)} canComplain={holds(COMPLAIN_PERMISSION)} onAnnotate={() => setDialog({ kind: 'annotate', unit })} onComplain={(metric) => setDialog({ kind: 'complain', unit, metric })} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </SectionCard>
              );
            })}
            <p className="ana-links">
              <Link to={NOTES_PATH}>{t('ana.rank.link.notes')}</Link>
              <Link to={RANKING_PATH}>{t('ana.rank.link.rate')}</Link>
            </p>
          </div>
        )}
      </StateBoundary>
      <ActionDialog
        dialog={dialog}
        reading={reading}
        commands={commands}
        onClose={() => {
          setDialog(undefined);
          commands.propose.reset();
          commands.file.reset();
        }}
        onDone={(text) => {
          setDialog(undefined);
          setNotice(text);
        }}
      />
    </section>
  );
}

function UnitRow({ unit, metrics, canAnnotate, canComplain, onAnnotate, onComplain }: { unit: UnitRank; metrics: readonly MetricCode[]; canAnnotate: boolean; canComplain: boolean; onAnnotate: () => void; onComplain: (metric: MetricCode) => void }) {
  const { t } = useTranslation();
  const byCode = new Map(unit.metrics.map((metric) => [metric.code, metric]));
  return (
    <tr data-testid="rank-row" data-unit={unit.unitId}>
      <td className="num" data-testid="rank-position">
        {unit.rank === null ? t('ana.common.na') : unit.rank}
      </td>
      <th scope="row">
        {unit.code === '' ? unit.name : `${unit.code} ${unit.name}`}
        {unit.annotation === null ? null : (
          <span className="ana-caveat" data-testid="rank-annotation">
            {' '}
            <StatusPill tone="neutral">{t('ana.rank.annotation.badge')}</StatusPill> {annotationReasonLabel(t, unit.annotation.reasonCode)} {t('ana.rank.annotation.until', { day: dayText(unit.annotation.validTo) })}
          </span>
        )}
      </th>
      <td className="num" data-testid="rank-composite">
        {unit.composite === null ? (
          <>
            {t('ana.common.na')} <span className="sr-only">{unit.nullReason === null ? '' : rankReason(t, unit.nullReason)}</span>
          </>
        ) : (
          commaText(String(unit.composite))
        )}
        {unit.bandThin ? <span className="ana-caveat"> {t('ana.rank.thin.mark')}</span> : null}
      </td>
      {metrics.map((code) => {
        const metric = byCode.get(code);
        if (metric === undefined) return <td key={code} className="num" />;
        return (
          <td key={code} className="num" data-testid={`rank-metric-${code}`}>
            {valueText(t, metric)}
            {metric.score === null ? null : <span className="ana-caveat"> {t('ana.rank.score', { score: commaText(String(metric.score)) })}</span>}
            {metric.value === null && metric.nullReason !== null ? <span className="ana-caveat"> {rankReason(t, metric.nullReason)}</span> : null}
            {metric.excluded === null ? null : <span className="ana-caveat"> {t('ana.rank.excluded')}</span>}
            {metric.underComplaint ? (
              <span className="ana-caveat" data-testid={`rank-disputed-${code}`}>
                {' '}
                <StatusPill tone="warning">{t('ana.rank.disputed')}</StatusPill>
              </span>
            ) : null}
            {canComplain && metric.value !== null ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => onComplain(code)} data-testid={`rank-complain-${unit.unitId}-${code}`} aria-label={t('ana.rank.complain.aria', { metric: metricLabel(t, code), unit: unit.code })}>
                {t('ana.rank.complain.open')}
              </button>
            ) : null}
          </td>
        );
      })}
      <td data-testid="rank-pair">
        {unit.pair.quadrant === null ? (
          <>
            {t('ana.common.na')} <span className="ana-caveat">{unit.pair.nullReason === null ? '' : rankReason(t, unit.pair.nullReason)}</span>
          </>
        ) : (
          <>
            {quadrantLabel(t, unit.pair.quadrant)}{' '}
            <span className="ana-caveat">
              {t('ana.rank.pair.numbers', { rate: commaText(String(unit.pair.ratePct)), physical: commaText(String(unit.pair.physicalPct)) })}
            </span>
          </>
        )}
      </td>
      <td>
        {canAnnotate ? (
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onAnnotate} data-testid={`rank-annotate-${unit.unitId}`} aria-label={t('ana.rank.annotate.aria', { unit: unit.code })}>
            {t('ana.rank.annotate.open')}
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function ActionDialog({ dialog, reading, commands, onClose, onDone }: { dialog: Dialog | undefined; reading: RankingReading | undefined; commands: ReturnType<typeof useRankingCommands>; onClose: () => void; onDone: (text: string) => void }) {
  const { t } = useTranslation();
  const [reasonCode, setReasonCode] = useState('');
  const [metrics, setMetrics] = useState<MetricCode[]>([]);
  const [until, setUntil] = useState('');
  const [asOf, setAsOf] = useState('');
  const [claimed, setClaimed] = useState('');
  useEffect(() => {
    setReasonCode(reading?.model.annotationReasons[0] ?? '');
    setMetrics(dialog?.kind === 'complain' ? [dialog.metric] : (reading?.model.metrics.map((metric) => metric.code).slice(0, 1) ?? []));
    setUntil('');
    setAsOf(reading?.asOfDate ?? '');
    setClaimed('');
  }, [dialog, reading]);
  if (dialog === undefined || reading === undefined) return null;
  const label = dialog.unit.code === '' ? dialog.unit.name : `${dialog.unit.code} ${dialog.unit.name}`;
  const busy = commands.propose.isPending || commands.file.isPending;
  const annotate = dialog.kind === 'annotate';
  const error = annotate ? commands.propose.error : commands.file.error;
  const failed = annotate ? commands.propose.isError : commands.file.isError;
  const confirm = (reason?: string): void => {
    if (busy) return;
    const text = (reason ?? '').trim();
    if (dialog.kind === 'annotate') commands.propose.mutate({ unitId: dialog.unit.unitId, reasonCode, metricCodes: metrics, evidence: text, validTo: until }, { onSuccess: () => onDone(t('ana.rank.annotate.done')) });
    else commands.file.mutate({ unitId: dialog.unit.unitId, metricCode: dialog.metric, asOfDate: asOf, claim: text, claimedValue: claimed }, { onSuccess: () => onDone(t('ana.rank.complain.done')) });
  };
  return (
    <ConfirmDialog
      open
      title={annotate ? t('ana.rank.annotate.title') : t('ana.rank.complain.title')}
      context={[
        { label: t('ana.rank.col.unit'), value: label },
        ...(dialog.kind === 'complain' ? [{ label: t('ana.rank.complain.metric'), value: metricLabel(t, dialog.metric) }] : []),
      ]}
      confirmLabel={annotate ? t('ana.rank.annotate.confirm') : t('ana.rank.complain.confirm')}
      cancelLabel={t('ana.rank.dialog.cancel')}
      reason={{ label: annotate ? t('ana.rank.annotate.evidence') : t('ana.rank.complain.claim'), required: true, minLength: 10 }}
      pending={busy}
      {...(failed ? { error: problemText(t, error) } : {})}
      onConfirm={confirm}
      onCancel={() => {
        if (!busy) onClose();
      }}
    >
      {annotate ? (
        <>
          <label className="ana-field">
            {t('ana.rank.annotate.reason')}
            <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} data-testid="annotate-reason">
              {reading.model.annotationReasons.map((code) => (
                <option key={code} value={code}>
                  {annotationReasonLabel(t, code)}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="ana-field">
            <legend>{t('ana.rank.annotate.metrics')}</legend>
            {reading.model.metrics.map((metric) => (
              <label key={metric.code}>
                <input type="checkbox" checked={metrics.includes(metric.code)} onChange={(event) => setMetrics(event.target.checked ? [...metrics, metric.code] : metrics.filter((code) => code !== metric.code))} data-testid={`annotate-metric-${metric.code}`} /> {metricLabel(t, metric.code)}
              </label>
            ))}
          </fieldset>
          <label className="ana-field">
            {t('ana.rank.annotate.validTo', { days: reading.model.annotationMaxDays })}
            <input type="date" value={until} onChange={(event) => setUntil(event.target.value)} data-testid="annotate-until" />
          </label>
          <p className="ana-caveat">{t('ana.rank.annotate.maker')}</p>
        </>
      ) : (
        <>
          <label className="ana-field">
            {t('ana.rank.complain.asOf')}
            <input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} data-testid="complain-as-of" />
          </label>
          <label className="ana-field">
            {t('ana.rank.complain.claimed')}
            <input type="text" inputMode="decimal" value={claimed} onChange={(event) => setClaimed(event.target.value)} data-testid="complain-claimed" />
          </label>
        </>
      )}
    </ConfirmDialog>
  );
}
