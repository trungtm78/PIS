import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { useTranslation } from '../../../i18n';
import { InfoFormula, SectionCard, StatusPill } from '../../../ui';
import { useInfoLabels } from '../../gov11/gov11-kit';
import { useScopeKey } from '../hooks';
import { timerLabel } from '../labels';
import { TIMER_CODES } from '../model';
import type { TimerCode } from '../model';

const WINDOWS = ['7', '14', '30', '60'] as const;
const PAGE = 50;

interface DeadlineLine {
  id: string;
  projectId: string;
  subjectLabel: string;
  timerCode: TimerCode | null;
  dueOn: string;
  remainingDays: number;
  status: 'RUNNING' | 'BREACHED';
  legalBasis: string | null;
  awaitingConfirmation: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The deadlines as the API writes them; a row without an identifier or a due day is dropped, a status that is not known is read as running (never as breached by guess). */
export function toDeadlines(raw: unknown): { lines: DeadlineLine[]; hasMore: boolean; asOf: string } | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return undefined;
  return {
    asOf: str(raw.as_of),
    hasMore: typeof raw.next_cursor === 'string',
    lines: raw.items.flatMap((item): DeadlineLine[] => {
      if (!isRecord(item) || str(item.id) === '' || !/^\d{4}-\d{2}-\d{2}$/.test(str(item.due_on))) return [];
      const code = (TIMER_CODES as readonly string[]).includes(str(item.timer_code)) ? (str(item.timer_code) as TimerCode) : null;
      return [
        {
          id: str(item.id),
          projectId: str(item.project_id),
          subjectLabel: str(item.subject_label),
          timerCode: code,
          dueOn: str(item.due_on),
          remainingDays: typeof item.remaining_days === 'number' ? item.remaining_days : 0,
          status: item.status === 'BREACHED' ? 'BREACHED' : 'RUNNING',
          legalBasis: str(item.legal_basis) === '' ? null : str(item.legal_basis),
          awaitingConfirmation: item.awaiting_confirmation === true,
        },
      ];
    }),
  };
}

function useUpcoming(withinDays: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'upcoming-deadlines', withinDays],
    queryFn: async () => {
      const parsed = toDeadlines(await client.read('listUpcomingLandDeadlines' as never, { query: { within_days: withinDays, limit: String(PAGE) } } as never));
      if (parsed === undefined) throw new Error('UPCOMING_DEADLINES_UNUSABLE');
      return parsed;
    },
    enabled: key[1] !== undefined,
    retry: false,
  });
}

const dayText = (day: string): string => day.split('-').reverse().join('/');

/**
 * The land-clearance deadlines of all the projects in the scope that are about to fall due or fell due not long ago (LND-01, `listUpcomingLandDeadlines`): the notice, the posting, the payment and the complaint clocks with the
 * days that are left. A legal number that nobody confirmed yet says so. A deadline opens its project.
 */
export function UpcomingDeadlines({ onOpenProject }: { onOpenProject: (projectId: string) => void }) {
  const { t } = useTranslation();
  const labels = useInfoLabels();
  const [within, setWithin] = useState<string>('30');
  const query = useUpcoming(within);
  const name = t('lookahead.prj.landDeadlines.left');
  return (
    <SectionCard title={t('lookahead.prj.landDeadlines.title')}>
      <div className="field">
        <label htmlFor="deadline-window">{t('lookahead.prj.landDeadlines.window')}</label>
        <select id="deadline-window" value={within} onChange={(event) => setWithin(event.target.value)} data-testid="deadline-window">
          {WINDOWS.map((days) => (
            <option key={days} value={days}>
              {t('lookahead.prj.landDeadlines.days', { days })}
            </option>
          ))}
        </select>
      </div>
      {query.isLoading ? (
        <p role="status" aria-busy="true" data-testid="deadlines-loading">
          {t('lookahead.prj.landDeadlines.loading')}
        </p>
      ) : query.isError || query.data === undefined ? (
        <p role="alert" data-testid="deadlines-error">
          {t('lookahead.prj.landDeadlines.error')}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void query.refetch()}>
            {t('lookahead.prj.landDeadlines.retry')}
          </button>
        </p>
      ) : query.data.lines.length === 0 ? (
        <p className="callout" role="status" data-testid="deadlines-empty">
          {t('lookahead.prj.landDeadlines.empty', { days: within })}
        </p>
      ) : (
        <>
          <table className="table" data-testid="deadlines-table">
            <caption>{t('lookahead.prj.landDeadlines.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('lookahead.prj.landDeadlines.subject')}</th>
                <th scope="col">{t('lookahead.prj.landDeadlines.timer')}</th>
                <th scope="col">{t('lookahead.prj.landDeadlines.due')}</th>
                <th scope="col">{name}</th>
                <th scope="col">{t('lookahead.prj.landDeadlines.status')}</th>
                <th scope="col">
                  <span className="ui-sr-only">{t('lookahead.prj.landDeadlines.open')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {query.data.lines.map((line) => (
                <tr key={line.id} data-testid={`deadline-${line.id}`}>
                  <th scope="row">{line.subjectLabel}</th>
                  <td>{line.timerCode === null ? '–' : timerLabel(t, line.timerCode)}</td>
                  <td>{dayText(line.dueOn)}</td>
                  <td>
                    <span data-testid={`deadline-left-${line.id}`}>{line.remainingDays}</span>{' '}
                    <InfoFormula
                      name={name}
                      formula={t('lookahead.prj.landDeadlines.formula')}
                      source={line.legalBasis ?? t('lookahead.prj.landDeadlines.source')}
                      asOf={dayText(query.data.asOf.slice(0, 10))}
                      owner={t('lookahead.prj.landDeadlines.owner')}
                      version={t('lookahead.prj.landDeadlines.version')}
                      unverified={line.awaitingConfirmation}
                      labels={labels(name)}
                    />
                  </td>
                  <td>
                    <StatusPill tone={line.status === 'BREACHED' ? 'danger' : 'warning'}>{line.status === 'BREACHED' ? t('lookahead.prj.landDeadlines.status.breached') : t('lookahead.prj.landDeadlines.status.running')}</StatusPill>
                  </td>
                  <td>
                    <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`deadline-open-${line.id}`} aria-label={t('lookahead.prj.landDeadlines.openFor', { subject: line.subjectLabel })} onClick={() => onOpenProject(line.projectId)}>
                      {t('lookahead.prj.landDeadlines.open')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {query.data.hasMore ? (
            <p className="muted" data-testid="deadlines-more">
              {t('lookahead.prj.landDeadlines.more', { count: PAGE })}
            </p>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}
