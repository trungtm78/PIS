import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, SectionCard, StatusPill } from '../../ui';
import type { Tone } from '../../ui';
import { dayText } from './common';
import { AnaFigureInfo, NaNote, UnverifiedNote } from './components';
import { useFreshness, useScorecard } from './trust-hooks';
import { LINEAGE_PATH } from './trust-model';
import type { DatasetFreshness, Dimension, FreshnessStatus, ScoreBand, ScoreRow } from './trust-model';

type T = Translator['t'];
const COMMAND_CENTER_PATH = '/home/home-09';

const STATUS_TONE: Record<FreshnessStatus, Tone> = { FRESH: 'success', DUE: 'warning', STALE: 'danger', NO_DATA: 'neutral' };
const BAND_TONE: Record<ScoreBand, Tone> = { GOOD: 'success', FAIR: 'warning', POOR: 'danger' };

export function statusLabel(t: T, status: FreshnessStatus): string {
  switch (status) {
    case 'FRESH':
      return t('ana.trust.status.fresh');
    case 'DUE':
      return t('ana.trust.status.due');
    case 'STALE':
      return t('ana.trust.status.stale');
    case 'NO_DATA':
      return t('ana.trust.status.noData');
  }
}

function bandLabel(t: T, band: ScoreBand): string {
  switch (band) {
    case 'GOOD':
      return t('ana.trust.band.good');
    case 'FAIR':
      return t('ana.trust.band.fair');
    case 'POOR':
      return t('ana.trust.band.poor');
  }
}

function dimensionLabel(t: T, code: string): string {
  switch (code) {
    case 'FRESHNESS':
      return t('ana.trust.dim.freshness');
    case 'QUALITY':
      return t('ana.trust.dim.quality');
    case 'CERTIFICATION':
      return t('ana.trust.dim.certification');
    case 'COMPLETENESS':
      return t('ana.trust.dim.completeness');
    case 'COVERAGE':
      return t('ana.trust.dim.coverage');
    case 'TIMELINESS':
      return t('ana.trust.dim.timeliness');
    default:
      return code;
  }
}

/** Why a score is missing, in words (never 0 and never good). */
export function trustReason(t: T, reason: string): string {
  switch (reason) {
    case 'NEVER_BUILT':
      return t('ana.trust.na.neverBuilt');
    case 'NOT_ASSESSED':
      return t('ana.trust.na.notAssessed');
    case 'NO_CERTIFICATION':
      return t('ana.trust.na.noCertification');
    case 'NO_PROJECTS':
      return t('ana.trust.na.noProjects');
    case 'NOT_SCORED':
      return t('ana.trust.na.notScored');
    case 'NOT_READABLE':
      return t('ana.trust.na.notReadable');
    case 'TOO_FEW_DIMENSIONS':
      return t('ana.trust.na.tooFew');
    default:
      return t('ana.trust.na.other');
  }
}

function DimensionCells({ row }: { row: ScoreRow }) {
  const { t } = useTranslation();
  return (
    <>
      {row.dimensions.map((dimension: Dimension) => (
        <td key={dimension.code} className="num" data-testid={`dim-${dimension.code}`}>
          {dimension.score === null ? (
            <span title={dimension.nullReason === null ? undefined : trustReason(t, dimension.nullReason)}>
              {t('ana.common.na')}
              <span className="sr-only"> {dimension.nullReason === null ? '' : trustReason(t, dimension.nullReason)}</span>
            </span>
          ) : (
            dimension.score
          )}
        </td>
      ))}
    </>
  );
}

function CompositeCell({ row }: { row: ScoreRow }) {
  const { t } = useTranslation();
  return (
    <td className="num" data-testid="composite">
      {row.composite === null ? (
        <>
          {t('ana.common.na')} <span className="sr-only">{row.nullReason === null ? '' : trustReason(t, row.nullReason)}</span>
        </>
      ) : (
        <>
          {row.composite} {row.band === null ? null : <StatusPill tone={BAND_TONE[row.band]}>{bandLabel(t, row.band)}</StatusPill>}
        </>
      )}
    </td>
  );
}

function FreshnessTable({ datasets }: { datasets: readonly DatasetFreshness[] }) {
  const { t } = useTranslation();
  return (
    <div className="tablewrap">
      <table className="ana-table" aria-label={t('ana.trust.fresh.aria')} data-testid="freshness-table">
        <caption className="sr-only">{t('ana.trust.fresh.caption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('ana.trust.fresh.dataset')}</th>
            <th scope="col">{t('ana.trust.fresh.module')}</th>
            <th scope="col">{t('ana.trust.fresh.status')}</th>
            <th scope="col" className="num">
              {t('ana.trust.fresh.age')}
            </th>
            <th scope="col" className="num">
              {t('ana.trust.fresh.sla')}
            </th>
            <th scope="col">{t('ana.trust.fresh.quality')}</th>
            <th scope="col">{t('ana.trust.fresh.certification')}</th>
          </tr>
        </thead>
        <tbody>
          {datasets.map((one) => (
            <tr key={one.code} data-testid="freshness-row" data-status={one.status}>
              <th scope="row">
                {one.code} <span className="muted">{one.title}</span>
              </th>
              <td>{one.module}</td>
              <td>
                <StatusPill tone={STATUS_TONE[one.status]}>{statusLabel(t, one.status)}</StatusPill>
                {one.status === 'STALE' && one.overdueHours !== null ? <span className="ana-caveat"> {t('ana.trust.fresh.overdue', { hours: one.overdueHours })}</span> : null}
                {one.status === 'NO_DATA' && one.nullReason !== null ? <span className="ana-caveat"> {trustReason(t, one.nullReason)}</span> : null}
              </td>
              <td className="num">{one.ageHours === null ? t('ana.common.na') : t('ana.trust.fresh.hours', { hours: one.ageHours })}</td>
              <td className="num">{t('ana.trust.fresh.hours', { hours: one.slaHours })}</td>
              <td>{one.qualityBadge ?? t('ana.common.na')}</td>
              <td>{one.certification ?? t('ana.common.na')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * BI-23: freshness and the quality scorecard (G3-7). Each dataset against its SLA ("stale data" appears by itself), then the scorecard of the modules and of the units the reader may read: every score is 0 to 100
 * or N/A with its reason, a composite stands on at least the minimum number of signals, and the weights and lines are a governance rule that says when it is not confirmed.
 */
export default function TrustScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <TrustContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function TrustContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const freshness = useFreshness();
  const card = useScorecard();
  const loading = freshness.isLoading || card.isLoading;
  const failed = freshness.data === undefined && freshness.error !== null ? freshness.error : card.data === undefined && card.error !== null ? card.error : undefined;
  const state = useScreenState({ isLoading: loading, error: failed ?? undefined, data: freshness.data, isEmpty: (data) => (data as { datasets: unknown[] }).datasets.length === 0 });
  const stale = freshness.data !== undefined && freshness.data.staleCount > 0;
  const contextItems = [
    { label: t('ana.trust.context.asOf'), value: dayText(freshness.data?.asOf.slice(0, 10) ?? null) },
    { label: t('ana.trust.context.stale'), value: freshness.data === undefined ? '—' : String(freshness.data.staleCount) },
    { label: t('ana.trust.context.noData'), value: freshness.data === undefined ? '—' : String(freshness.data.noDataCount) },
  ];
  const data = freshness.data;
  const score = card.data;
  const moduleDims = score?.modules[0]?.dimensions ?? [];
  const unitDims = score?.units[0]?.dimensions ?? [];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ana.trust.page.title')}</h1>
          <p>{t('ana.trust.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={contextItems} unit={t('ana.trust.context.unit')} stale={stale} asOf={t('ana.trust.context.staleHint')} />
      <StateBoundary state={state} onRetry={() => void Promise.all([freshness.refetch(), card.refetch()])}>
        {data === undefined ? null : (
          <div className="ana-stack">
            {stale ? (
              <p role="alert" data-testid="trust-stale">
                <StatusPill tone="danger">{t('ana.trust.banner.pill')}</StatusPill> {t('ana.trust.banner.body', { count: data.staleCount })}
              </p>
            ) : null}
            <UnverifiedNote unverified={data.datasets.some((one) => one.unverified)} />
            <SectionCard title={t('ana.trust.fresh.title')} status={<AnaFigureInfo name={t('ana.trust.fresh.title')} info={data.info} />}>
              <FreshnessTable datasets={data.datasets} />
            </SectionCard>
            {card.isError ? (
              <p role="alert" data-testid="scorecard-error">
                {t('ana.trust.scorecard.error')}
              </p>
            ) : null}
            {score === undefined ? null : (
              <>
                <SectionCard title={t('ana.trust.module.title')} status={<AnaFigureInfo name={t('ana.trust.module.title')} info={score.moduleInfo} />}>
                  <div className="tablewrap">
                    <table className="ana-table" aria-label={t('ana.trust.module.aria')} data-testid="module-table">
                      <caption className="sr-only">{t('ana.trust.module.caption')}</caption>
                      <thead>
                        <tr>
                          <th scope="col">{t('ana.trust.module.module')}</th>
                          {moduleDims.map((dimension) => (
                            <th key={dimension.code} scope="col" className="num">
                              {dimensionLabel(t, dimension.code)} ({dimension.weight})
                            </th>
                          ))}
                          <th scope="col" className="num">
                            {t('ana.trust.composite')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {score.modules.map((one) => (
                          <tr key={one.module} data-testid="module-row" data-module={one.module}>
                            <th scope="row">{one.module}</th>
                            <DimensionCells row={one} />
                            <CompositeCell row={one} />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </SectionCard>
                <SectionCard title={t('ana.trust.unit.title')} status={<AnaFigureInfo name={t('ana.trust.unit.title')} info={score.unitInfo} asOf={score.unitAsOfDate} />}>
                  {score.units.length === 0 ? (
                    <NaNote reason="NO_SNAPSHOT" label={() => t('ana.trust.unit.none')} />
                  ) : (
                    <div className="tablewrap">
                      <table className="ana-table" aria-label={t('ana.trust.unit.aria')} data-testid="unit-table">
                        <caption className="sr-only">{t('ana.trust.unit.caption')}</caption>
                        <thead>
                          <tr>
                            <th scope="col">{t('ana.trust.unit.unit')}</th>
                            {unitDims.map((dimension) => (
                              <th key={dimension.code} scope="col" className="num">
                                {dimensionLabel(t, dimension.code)} ({dimension.weight})
                              </th>
                            ))}
                            <th scope="col" className="num">
                              {t('ana.trust.composite')}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {score.units.map((one) => (
                            <tr key={one.unitId} data-testid="unit-row" data-unit={one.unitId}>
                              <th scope="row">{one.code === '' ? one.name : `${one.code} ${one.name}`}</th>
                              <DimensionCells row={one} />
                              <CompositeCell row={one} />
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </SectionCard>
              </>
            )}
            <p className="ana-links">
              <Link to={LINEAGE_PATH}>{t('ana.trust.link.lineage')}</Link>
              <Link to={COMMAND_CENTER_PATH}>{t('ana.trust.link.back')}</Link>
            </p>
          </div>
        )}
      </StateBoundary>
    </section>
  );
}
