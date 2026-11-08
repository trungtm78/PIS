import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { SectionCard, StatusPill } from '../../ui';
import type { Tone } from '../../ui';
import { formatVnd } from '../dis/report/money';
import { useExportFigures, useHomeChanges, useRagReading } from './gov-hooks';
import { RAG_PATH, changePathOf, describeChanges, describeRag, downloadFile, isRefused, magnitudeOf } from './gov-model';
import type { ChangeLine, RagBand } from './gov-model';
import { SNAPSHOT_SCREEN_PATH } from './model';
import { dayText } from './overview-model';

type T = Translator['t'];

/** The grey lines of a part that is still being read: never a number, never 0. */
export function ReadingSkeleton({ testId }: { testId: string }) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" aria-label={t('states.loading.label')} data-testid={testId}>
      <div className="skeleton" />
      <div className="skeleton" />
      <div className="skeleton" />
    </div>
  );
}

/** A part that could not be read: it names itself and retries in place; it is never an empty part and never "nothing changed". */
export function PartError({ source, onRetry, testId }: { source: string; onRetry: () => void; testId: string }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="home-source-error" data-testid={testId}>
      <p>{t('home.ov.source.error', { source })}</p>
      <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
        {t('ui.common.retry')}
      </button>
    </div>
  );
}

// ---- "Changes since last week" ---------------------------------------------------------------------------------------------------------------------

/** One line as a sentence from the templates of the screen: its numbers are the ones of the server, the direction picks the words. */
export function changeSentence(t: T, line: ChangeLine): string {
  const p = line.params;
  const up = line.direction === 'UP';
  const delta = magnitudeOf(p.delta);
  switch (line.kind) {
    case 'UNITS_TO_RED':
      return t('govc.home.changes.unitsToRed', { count: p.count ?? '' });
    case 'UNITS_RECOVERED':
      return t('govc.home.changes.unitsRecovered', { count: p.count ?? '' });
    case 'RATE_CHANGE':
      return t(up ? 'govc.home.changes.rate.up' : 'govc.home.changes.rate.down', { from: p.from ?? '', to: p.to ?? '', delta });
    case 'WARNINGS_DELTA':
      return t(up ? 'govc.home.changes.warnings.up' : 'govc.home.changes.warnings.down', { from: p.from ?? '', to: p.to ?? '', delta });
    case 'OVERDUE_DELTA':
      return t(up ? 'govc.home.changes.overdue.up' : 'govc.home.changes.overdue.down', { from: p.from ?? '', to: p.to ?? '', delta });
    case 'NO_DATA_DELTA':
      return t(up ? 'govc.home.changes.noData.up' : 'govc.home.changes.noData.down', { from: p.from ?? '', to: p.to ?? '', delta });
    case 'DISBURSED_WEEK':
      return t(up ? 'govc.home.changes.disbursed.up' : 'govc.home.changes.disbursed.down', { amount: formatVnd(magnitudeOf(p.amount_vnd)) });
  }
}

function changeLinkLabel(t: T, link: ChangeLine['link']): string {
  switch (link) {
    case 'DRILL':
      return t('govc.home.changes.link.drill');
    case 'RAG':
      return t('govc.home.changes.link.rag');
    case 'WARNINGS':
      return t('govc.home.changes.link.warnings');
    case 'MY_WORK':
      return t('govc.home.changes.link.myWork');
    case 'RANKING':
      return t('govc.home.changes.link.ranking');
  }
}

/**
 * "Changes since last week" (G3-4): at most five sentences the server made by rules, each with its numbers and ONE link to where it can be checked. A failed reading is an error to retry, never "no change"; a week with no week
 * before says so; a week where nothing moved says so.
 */
export function ChangesCard({ snapshotId, unitId }: { snapshotId: string; unitId: string }) {
  const { t } = useTranslation();
  const query = useHomeChanges(snapshotId, unitId);
  const problem = query.error === null ? undefined : describeChanges(query.error);
  const changes = query.data;
  const body = (() => {
    if (query.isLoading) return <ReadingSkeleton testId="changes-loading" />;
    if (changes === undefined) {
      if (problem === 'denied')
        return (
          <p role="alert" data-testid="changes-denied">
            {t('govc.home.changes.denied')}
          </p>
        );
      if (problem === 'noSnapshot')
        return (
          <p role="status" data-testid="changes-no-snapshot">
            {t('govc.home.changes.noSnapshot')} <Link to={SNAPSHOT_SCREEN_PATH}>{t('home.empty.link')}</Link>
          </p>
        );
      return <PartError source={t('govc.home.changes.source')} onRetry={() => void query.refetch()} testId="changes-error" />;
    }
    return (
      <>
        {changes.previousWeekStart === '' ? null : (
          <p className="home-note" data-testid="changes-range">
            {t('govc.home.changes.range', { week: dayText(changes.weekStart), previous: dayText(changes.previousWeekStart) })}
          </p>
        )}
        {query.isError ? (
          <p role="alert" className="home-note" data-testid="changes-stale">
            {t('govc.home.changes.stale')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void query.refetch()}>
              {t('ui.common.retry')}
            </button>
          </p>
        ) : null}
        {changes.reason === 'NO_PREVIOUS_WEEK' ? (
          <p role="status" data-testid="changes-no-previous">
            {t('govc.home.changes.noPrevious')}
          </p>
        ) : changes.lines.length === 0 ? (
          <p role="status" data-testid="changes-none">
            {t('govc.home.changes.none')}
          </p>
        ) : (
          <ul className="home-changes" data-testid="changes-lines">
            {changes.lines.map((line, index) => {
              const path = changePathOf(line);
              return (
                <li key={`${line.kind}:${index}`} data-kind={line.kind} data-direction={line.direction}>
                  <span className="home-changes__arrow" aria-hidden="true">
                    {line.direction === 'UP' ? '▲' : '▼'}
                  </span>
                  <span className="home-changes__text">{changeSentence(t, line)}</span>
                  {path === undefined ? null : (
                    <Link className="home-changes__link" to={path} data-link={line.link}>
                      {changeLinkLabel(t, line.link)}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  })();
  return (
    <div data-testid="home-changes">
      <SectionCard title={t('govc.home.changes.title')}>{body}</SectionCard>
    </div>
  );
}

// ---- the colours -----------------------------------------------------------------------------------------------------------------------------------

const BAND_TONE: Record<RagBand, Tone> = { RED: 'danger', AMBER: 'warning', GREEN: 'success', NO_DATA: 'neutral' };
/** A shape for each colour, so that the colour is never the only cue. */
const BAND_ICON: Record<RagBand, string> = { RED: '▲', AMBER: '◆', GREEN: '●', NO_DATA: '○' };

export function bandLabel(t: T, band: RagBand): string {
  switch (band) {
    case 'RED':
      return t('govc.home.band.red');
    case 'AMBER':
      return t('govc.home.band.amber');
    case 'GREEN':
      return t('govc.home.band.green');
    case 'NO_DATA':
      return t('govc.home.band.noData');
  }
}

/** A colour as text and a shape (and the tint): never the colour alone. A unit without enough data is "not enough data", not green. */
export function RagBandBadge({ band }: { band: RagBand }) {
  const { t } = useTranslation();
  return (
    <span data-band={band} data-testid={`band-${band}`}>
      <StatusPill tone={BAND_TONE[band]} icon={BAND_ICON[band]}>
        {bandLabel(t, band)}
      </StatusPill>
    </span>
  );
}

const SUMMARY_ORDER: readonly RagBand[] = ['RED', 'AMBER', 'GREEN', 'NO_DATA'];

/** The colours of the units in four counts, with the way to the screen that explains them. */
export function RagSummaryCard({ snapshotId, unitId }: { snapshotId: string; unitId: string }) {
  const { t } = useTranslation();
  const query = useRagReading(unitId, snapshotId);
  const problem = query.error === null ? undefined : describeRag(query.error);
  const reading = query.data;
  const path = unitId === '' ? RAG_PATH : `${RAG_PATH}?${new URLSearchParams({ unit: unitId }).toString()}`;
  const body = (() => {
    if (query.isLoading) return <ReadingSkeleton testId="rag-loading" />;
    if (reading === undefined) {
      if (problem === 'denied')
        return (
          <p role="alert" data-testid="rag-denied">
            {t('govc.home.rag.denied.read')}
          </p>
        );
      if (problem === 'noSnapshot')
        return (
          <p role="status" data-testid="rag-no-snapshot">
            {t('govc.home.changes.noSnapshot')}
          </p>
        );
      return <PartError source={t('govc.home.rag.source')} onRetry={() => void query.refetch()} testId="rag-error" />;
    }
    return (
      <>
        {query.isError ? (
          <p role="alert" className="home-note" data-testid="rag-stale">
            {t('govc.home.changes.stale')}
          </p>
        ) : null}
        <ul className="home-rag-summary" data-testid="rag-summary" aria-label={t('govc.home.rag.summary.aria')}>
          {SUMMARY_ORDER.map((band) => (
            <li key={band} data-band={band}>
              <RagBandBadge band={band} />
              <strong data-testid={`rag-count-${band}`}>{reading.summary[band]}</strong>
            </li>
          ))}
        </ul>
        <p>
          <Link to={path}>{t('govc.home.rag.summary.link')}</Link>
        </p>
      </>
    );
  })();
  return (
    <div data-testid="home-rag-summary">
      <SectionCard title={t('govc.home.rag.summary.title')}>{body}</SectionCard>
    </div>
  );
}

// ---- the file of the figures -----------------------------------------------------------------------------------------------------------------------

/** "Export Excel/CSV": the same figures, with the same text as the screen, as a file the page hands to the browser (a Blob; nothing is kept on a server). */
export function ExportActions({ snapshotId, unitId }: { snapshotId: string; unitId: string }) {
  const { t } = useTranslation();
  const exporter = useExportFigures();
  const [saved, setSaved] = useState<{ name: string; rows: number } | 'unsupported' | undefined>(undefined);
  const refused = exporter.isError && isRefused(exporter.error);
  const run = (format: 'CSV' | 'XLSX' | 'DOCX'): void => {
    setSaved(undefined);
    exporter.mutate(
      { format, snapshotId, unitId },
      {
        onSuccess: (file) => setSaved(downloadFile(file) ? { name: file.fileName, rows: file.rows } : 'unsupported'),
      },
    );
  };
  return (
    <div className="home-export" data-testid="home-export">
      <div className="home-actions" role="group" aria-label={t('govc.home.export.group')}>
        <button type="button" className="ui-button ui-button--outline" disabled={exporter.isPending} onClick={() => run('XLSX')}>
          {t('govc.home.export.xlsx')}
        </button>
        <button type="button" className="ui-button ui-button--outline" disabled={exporter.isPending} onClick={() => run('CSV')}>
          {t('govc.home.export.csv')}
        </button>
        <button type="button" className="ui-button ui-button--outline" disabled={exporter.isPending} onClick={() => run('DOCX')}>
          {t('govc.home.export.docx')}
        </button>
      </div>
      <p className="home-note" role="status" aria-live="polite" data-testid="export-status">
        {exporter.isPending ? t('govc.home.export.pending') : saved === undefined ? '' : saved === 'unsupported' ? t('govc.home.export.unsupported') : t('govc.home.export.done', { name: saved.name, rows: saved.rows })}
      </p>
      {exporter.isError ? (
        <p role="alert" data-testid="export-error">
          {refused ? t('govc.home.export.denied') : t('govc.home.export.error')}
        </p>
      ) : null}
    </div>
  );
}
