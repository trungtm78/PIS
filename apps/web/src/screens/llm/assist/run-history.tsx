import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DataTable, FilterPanel, SectionCard, StatusPill } from '../../../ui';
import { Field, SectionDenied } from './assist-components';
import { useAssistRuns } from './assist-hooks';
import { completenessLabel, completenessTone, decisionLabel, decisionTone, kindLabel, runStatusLabel, runStatusTone } from './assist-labels';
import { COMPLETENESS, NO_FILTER, PATHS, RUN_KINDS, RUN_STATUSES, failureStatus, stamp } from './assist-model';
import type { AssistRun, RunFilter, RunKind, RunStatus } from './assist-model';

const EXCERPT = 80;
const excerpt = (text: string): string => ([...text].length > EXCERPT ? `${[...text].slice(0, EXCERPT).join('')}…` : text);

/** The questions asked so far, newest first, narrowed by kind and status, each with the way to its own page (LLM-23). The list carries no statements: they are read on the page of the run. */
export function RunHistory() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<RunFilter>(NO_FILTER);
  const query = useAssistRuns(filter);
  const rows: AssistRun[] = (query.data?.pages ?? []).flatMap((page) => page.items);
  const applied = (filter.kind === '' ? 0 : 1) + (filter.status === '' ? 0 : 1);
  const forbidden = failureStatus(query.error) === 403;
  const state = query.isLoading ? 'loading' : query.isError ? 'error' : 'ready';
  return (
    <SectionCard title={t('llm.assist.history.title')}>
      <FilterPanel applied={applied}>
        <Field id="history-kind" label={t('llm.assist.history.filterKind')}>
          <select id="history-kind" value={filter.kind} onChange={(event) => setFilter({ ...filter, kind: event.target.value as RunKind | '' })}>
            <option value="">{t('llm.assist.history.all')}</option>
            {RUN_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kindLabel(t, kind)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="history-status" label={t('llm.assist.history.filterStatus')}>
          <select id="history-status" value={filter.status} onChange={(event) => setFilter({ ...filter, status: event.target.value as RunStatus | '' })}>
            <option value="">{t('llm.assist.history.all')}</option>
            {RUN_STATUSES.map((status) => (
              <option key={status} value={status}>
                {runStatusLabel(t, status)}
              </option>
            ))}
          </select>
        </Field>
      </FilterPanel>
      {forbidden ? (
        <SectionDenied what={t('llm.assist.history.title')} />
      ) : (
        <>
          <DataTable<AssistRun>
            caption={t('llm.assist.history.caption')}
            rows={rows}
            rowKey={(run) => run.id}
            rowAttrs={(run) => ({ 'data-run-id': run.id, 'data-kind': run.kind, 'data-status': run.status })}
            state={state}
            emptyKind={applied > 0 ? 'filtered' : 'none'}
            onClearFilters={() => setFilter(NO_FILTER)}
            onRetry={() => void query.refetch()}
            columns={[
              { key: 'when', header: t('llm.assist.history.column.when'), pinned: true, render: (run) => stamp(run.createdAt) },
              { key: 'kind', header: t('llm.assist.history.column.kind'), render: (run) => kindLabel(t, run.kind) },
              { key: 'question', header: t('llm.assist.history.column.question'), render: (run) => (run.requestText === '' ? t('llm.assist.history.noQuestion') : excerpt(run.requestText)) },
              { key: 'status', header: t('llm.assist.history.column.status'), render: (run) => <StatusPill tone={runStatusTone(run.status)}>{runStatusLabel(t, run.status)}</StatusPill> },
              {
                key: 'completeness',
                header: t('llm.assist.history.column.completeness'),
                render: (run) => (run.status === 'COMPLETED' && (COMPLETENESS as readonly string[]).includes(run.completeness) ? <StatusPill tone={completenessTone(run.completeness)}>{completenessLabel(t, run.completeness)}</StatusPill> : '–'),
              },
              { key: 'statements', header: t('llm.assist.history.column.statements'), align: 'right', render: (run) => run.counts.statements },
              {
                key: 'decision',
                header: t('llm.assist.history.column.decision'),
                render: (run) => (run.decisionStatus === null ? t('llm.assist.history.undecided') : <StatusPill tone={decisionTone(run.decisionStatus)}>{decisionLabel(t, run.decisionStatus)}</StatusPill>),
              },
              {
                key: 'open',
                header: t('llm.assist.history.column.open'),
                render: (run) => (
                  <Link to={`${PATHS.run}?run=${run.id}`} className="ui-button ui-button--outline ui-button--small">
                    {t('llm.assist.history.open')}
                  </Link>
                ),
              },
            ]}
          />
          {query.hasNextPage ? (
            <div className="assist-actions">
              <button type="button" className="ui-button ui-button--outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} data-testid="load-more">
                {t('llm.assist.history.more')}
              </button>
            </div>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}
