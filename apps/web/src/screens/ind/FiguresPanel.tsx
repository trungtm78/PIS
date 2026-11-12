import { useId, useState } from 'react';
import { useTranslation } from '../../i18n';
import { useScreenState } from '../../states/useScreenState';
import { useSession } from '../../session/SessionContext';
import { DataTable, SectionCard } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { ProblemNote, StateNote, ViolationList } from './ind-components';
import { useDictionary, useEnterFigures, useFigureHistory, useFigures } from './ind-hooks';
import { unitLabel } from './ind-labels';
import { DASH, NO_FILTER, UUID, describeProblem, holds, lineFault, vietnamDateTime } from './ind-model';
import type { EntryLine, EntryResult, Figure, FigureList, Problem } from './ind-model';
import './ind.css';

const blankLine = (indicatorCode: string): EntryLine => ({ indicatorCode, value: '', reason: '' });

function FigureTable({ figures, caption, onHistory, testId }: { figures: Figure[]; caption: string; onHistory?: (figure: Figure) => void; testId: string }) {
  const { t } = useTranslation();
  const columns: Array<DataTableColumn<Figure>> = [
    { key: 'indicator', header: t('ind.fig.column.indicator'), pinned: true, render: (row) => row.indicatorCode },
    { key: 'value', header: t('ind.fig.column.value'), align: 'right', render: (row) => `${row.value} ${unitLabel(t, row.unit)}` },
    { key: 'revision', header: t('ind.fig.column.revision'), align: 'right', render: (row) => `v${row.revision}` },
    { key: 'source', header: t('ind.fig.column.source'), render: (row) => (row.source === 'IMPORT' ? t('ind.fig.source.import', { mapping: row.mappingCode ?? '', version: row.mappingVersion ?? 0, line: row.importLine ?? 0 }) : t('ind.fig.source.entry')) },
    { key: 'who', header: t('ind.fig.column.who'), render: (row) => row.enteredByName ?? DASH },
    { key: 'when', header: t('ind.fig.column.when'), render: (row) => vietnamDateTime(row.enteredAt) },
    { key: 'reason', header: t('ind.fig.column.reason'), render: (row) => row.reason ?? DASH },
    ...(onHistory === undefined
      ? []
      : [
          {
            key: 'history',
            header: t('ind.fig.column.history'),
            render: (row: Figure) => (
              <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('ind.fig.history.label', { code: row.indicatorCode })} onClick={() => onHistory(row)}>
                {t('ind.fig.history.action')}
              </button>
            ),
          },
        ]),
  ];
  return (
    <div data-testid={testId}>
      <DataTable caption={caption} columns={columns} rows={figures} rowKey={(row) => row.id} rowAttrs={(row) => ({ 'data-indicator': row.indicatorCode, 'data-revision': String(row.revision) })} />
    </div>
  );
}

/**
 * The figures of the dictionary, typed by hand (IND-01): name a project and a period, see the figures in force, and enter new ones. The entry rules the tenant approved judge the numbers on the server; a rule that
 * blocks is shown with the words its maker wrote, a warning is shown beside the saved figures. A figure is never edited: a different number is the next revision and needs its reason.
 */
export function FiguresPanel({ initial }: { initial: string | undefined }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const ids = useId();
  const enterable = useDictionary({ ...NO_FILTER, enterableOnly: true });
  const enter = useEnterFigures();
  const [projectId, setProjectId] = useState('');
  const [periodId, setPeriodId] = useState('');
  const [named, setNamed] = useState<{ projectId: string; periodId: string } | undefined>(undefined);
  const [lines, setLines] = useState<EntryLine[]>([blankLine(initial ?? '')]);
  const [result, setResult] = useState<EntryResult | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [history, setHistory] = useState<string | undefined>(undefined);

  const figures = useFigures(named?.projectId, named?.periodId);
  const past = useFigureHistory(history === undefined || named === undefined ? undefined : { ...named, indicatorCode: history });
  const figuresState = useScreenState({ isLoading: figures.isLoading, error: figures.data === undefined ? figures.error : undefined, data: figures.data ?? null, isEmpty: (data) => data !== null && (data as FigureList).items.length === 0 });
  const pastState = useScreenState({ isLoading: past.isLoading, error: past.data === undefined ? past.error : undefined, data: past.data ?? null, isEmpty: (data) => data !== null && (data as FigureList).items.length === 0 });

  const idsValid = UUID.test(projectId.trim()) && UUID.test(periodId.trim());
  const mayEnter = mode !== 'READ_ONLY' && holds(permissions, 'ind.entry');
  const held = new Map((figures.data?.items ?? []).map((figure) => [figure.indicatorCode, figure]));
  const needsReason = (line: EntryLine): boolean => {
    const current = held.get(line.indicatorCode);
    return current !== undefined && current.value !== line.value.trim();
  };
  const lineProblem = (line: EntryLine): 'indicator' | 'value' | 'duplicate' | 'reason' | undefined => lineFault(line, lines) ?? (needsReason(line) && line.reason.trim().length < 5 ? 'reason' : undefined);
  const ready = idsValid && named !== undefined && named.projectId === projectId.trim() && named.periodId === periodId.trim() && lines.length > 0 && lines.every((line) => lineProblem(line) === undefined);

  const change = (index: number, patch: Partial<EntryLine>): void => {
    setLines((current) => current.map((line, at) => (at === index ? { ...line, ...patch } : line)));
    setResult(undefined);
    setProblem(undefined);
  };
  const load = (): void => {
    if (!idsValid) return;
    setNamed({ projectId: projectId.trim(), periodId: periodId.trim() });
    setHistory(undefined);
    setResult(undefined);
    setProblem(undefined);
  };
  const send = (): void => {
    if (!ready || named === undefined || enter.isPending) return;
    setProblem(undefined);
    enter.mutate(
      { ...named, lines },
      {
        onSuccess: (done) => {
          if (done === undefined) setProblem({ kind: 'general', code: '', detail: '', missing: [], violations: [] });
          else {
            setResult(done);
            setLines([blankLine('')]);
          }
        },
        onError: (error) => setProblem(describeProblem(error)),
      },
    );
  };

  const indicators = enterable.data?.items ?? [];
  return (
    <SectionCard title={t('ind.fig.panel.title')}>
      <p className="sub">{t('ind.fig.panel.note')}</p>
      <div className="ind-form">
        <div className="field">
          <label htmlFor={`${ids}-project`}>{t('ind.fig.project.label')}</label>
          <input id={`${ids}-project`} type="text" value={projectId} aria-invalid={projectId.trim() !== '' && !UUID.test(projectId.trim())} aria-describedby={projectId.trim() !== '' && !UUID.test(projectId.trim()) ? `${ids}-project-error` : undefined} onChange={(event) => setProjectId(event.target.value)} />
          {projectId.trim() !== '' && !UUID.test(projectId.trim()) ? (
            <small className="sub" role="alert" id={`${ids}-project-error`} data-testid="project-invalid">
              {t('ind.fig.project.invalid')}
            </small>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor={`${ids}-period`}>{t('ind.fig.period.label')}</label>
          <input id={`${ids}-period`} type="text" value={periodId} aria-invalid={periodId.trim() !== '' && !UUID.test(periodId.trim())} aria-describedby={periodId.trim() !== '' && !UUID.test(periodId.trim()) ? `${ids}-period-error` : undefined} onChange={(event) => setPeriodId(event.target.value)} />
          {periodId.trim() !== '' && !UUID.test(periodId.trim()) ? (
            <small className="sub" role="alert" id={`${ids}-period-error`} data-testid="period-invalid">
              {t('ind.fig.period.invalid')}
            </small>
          ) : null}
        </div>
        <div className="ind-actions">
          <button type="button" className="ui-button ui-button--outline" disabled={!idsValid} onClick={load}>
            {t('ind.fig.load.action')}
          </button>
        </div>
      </div>

      {named === undefined ? null : (
        <>
          <StateNote
            state={figuresState}
            name="figures"
            texts={{ loading: t('ind.fig.state.loading'), denied: t('ind.fig.state.denied'), error: t('ind.fig.state.error') }}
            onRetry={() => void figures.refetch()}
          />
          {figuresState === 'empty' ? (
            <p className="callout" role="status" data-testid="figures-empty">
              {t('ind.fig.state.empty')}
            </p>
          ) : null}
          {figuresState === 'default' && figures.data !== undefined ? <FigureTable figures={figures.data.items} caption={t('ind.fig.table.caption')} onHistory={(figure) => setHistory(figure.indicatorCode)} testId="figures-table" /> : null}
          {history === undefined ? null : (
            <div data-testid="figure-history" role="group" aria-label={t('ind.fig.history.title', { code: history })}>
              <h3>{t('ind.fig.history.title', { code: history })}</h3>
              <StateNote state={pastState} name="history" texts={{ loading: t('ind.fig.history.loading'), denied: t('ind.fig.state.denied'), error: t('ind.fig.history.error') }} onRetry={() => void past.refetch()} />
              {pastState === 'default' && past.data !== undefined ? <FigureTable figures={past.data.items} caption={t('ind.fig.history.caption')} testId="history-table" /> : null}
            </div>
          )}
        </>
      )}

      {mode === 'READ_ONLY' ? (
        <p className="callout" role="status" data-testid="entry-readonly">
          {t('ind.fig.entry.readOnly')}
        </p>
      ) : !mayEnter ? (
        <p className="callout" role="status" data-testid="entry-noauthority">
          {t('ind.fig.entry.noAuthority')}
        </p>
      ) : (
        <form
          className="ind-form"
          aria-label={t('ind.fig.entry.title')}
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <h3>{t('ind.fig.entry.title')}</h3>
          {lines.map((line, index) => {
            const fault = line.indicatorCode === '' && line.value === '' ? undefined : lineProblem(line);
            const rowKey = `${ids}-line-${index}`;
            const errorId = `${rowKey}-error`;
            return (
              <fieldset className="ind-line" key={rowKey} data-testid="entry-line" data-fault={fault}>
                <legend>{t('ind.fig.line.legend', { n: index + 1 })}</legend>
                <div className="field">
                  <label htmlFor={`${rowKey}-indicator`}>{t('ind.fig.line.indicator')}</label>
                  <select id={`${rowKey}-indicator`} value={line.indicatorCode} disabled={enter.isPending} aria-invalid={fault === 'duplicate'} aria-describedby={fault === 'duplicate' ? errorId : undefined} onChange={(event) => change(index, { indicatorCode: event.target.value })}>
                    <option value="">{t('ind.fig.line.choose')}</option>
                    {indicators.map((one) => (
                      <option key={one.code} value={one.code}>
                        {one.name} ({one.code})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`${rowKey}-value`}>{t('ind.fig.line.value')}</label>
                  <input id={`${rowKey}-value`} type="text" inputMode="decimal" value={line.value} disabled={enter.isPending} aria-invalid={fault === 'value'} aria-describedby={fault === 'value' ? errorId : undefined} onChange={(event) => change(index, { value: event.target.value })} />
                </div>
                {needsReason(line) ? (
                  <div className="field">
                    <label htmlFor={`${rowKey}-reason`}>{t('ind.fig.line.reason')}</label>
                    <input id={`${rowKey}-reason`} type="text" value={line.reason} disabled={enter.isPending} aria-invalid={fault === 'reason'} aria-describedby={fault === 'reason' ? errorId : undefined} onChange={(event) => change(index, { reason: event.target.value })} />
                  </div>
                ) : null}
                {fault === 'value' ? (
                  <small className="sub" role="alert" id={errorId}>
                    {t('ind.fig.fault.value')}
                  </small>
                ) : null}
                {fault === 'duplicate' ? (
                  <small className="sub" role="alert" id={errorId}>
                    {t('ind.fig.fault.duplicate')}
                  </small>
                ) : null}
                {fault === 'reason' ? (
                  <small className="sub" role="alert" id={errorId}>
                    {t('ind.fig.fault.reason')}
                  </small>
                ) : null}
                {lines.length > 1 ? (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setLines((current) => current.filter((_, at) => at !== index))}>
                    {t('ind.fig.line.remove')}
                  </button>
                ) : null}
              </fieldset>
            );
          })}
          <div className="ind-actions">
            <button type="button" className="ui-button ui-button--outline" disabled={lines.length >= 60} onClick={() => setLines((current) => [...current, blankLine('')])}>
              {t('ind.fig.line.add')}
            </button>
            <button type="submit" className="ui-button ui-button--primary" disabled={!ready || enter.isPending}>
              {enter.isPending ? t('ind.fig.entry.pending') : t('ind.fig.entry.action')}
            </button>
          </div>
          {named === undefined ? (
            <small className="sub" data-testid="entry-needs-load">
              {t('ind.fig.entry.needsLoad')}
            </small>
          ) : null}
        </form>
      )}
      {problem === undefined ? null : <ProblemNote problem={problem} />}
      {result === undefined ? null : (
        <div className="callout" role="status" data-testid="entry-result">
          <p>{t('ind.fig.result.summary', { created: result.created, revised: result.revised, unchanged: result.unchanged })}</p>
          {result.warnings.length > 0 ? (
            <>
              <p>{t('ind.fig.result.warnings')}</p>
              <ViolationList violations={result.warnings} testId="entry-warnings" />
            </>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
