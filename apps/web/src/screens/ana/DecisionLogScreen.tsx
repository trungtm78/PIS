import { ApiError } from '@machvon/api-client';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { translator, useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ConfirmDialog, ContextBar, SectionCard, StatusPill } from '../../ui';
import type { Tone } from '../../ui';
import { codeKey, dayText } from './common';
import { UnverifiedNote } from './components';
import { useDecision, useDecisionCommands, useDecisions } from './decision-hooks';
import type { DecisionFilters } from './decision-hooks';
import { DECISION_PERMISSION, OUTCOMES, SUBJECT_KINDS } from './decision-model';
import type { DecisionDetail, DecisionItem, DecisionPolicy, FollowUpState, Outcome, SubjectKind } from './decision-model';

type T = Translator['t'];
const COMMAND_CENTER_PATH = '/home/home-09';

/** The words of a kind of decision: the platform's own kinds have a translation; a kind a tenant added is written as its code. */
export const kindLabel = (t: T, kind: string): string => (translator.has(`ana.decision.kind.${codeKey(kind)}`) ? t(`ana.decision.kind.${codeKey(kind)}`) : kind);

export function subjectLabel(t: T, item: Pick<DecisionItem, 'subjectKind' | 'metricCode' | 'title' | 'source' | 'sourceId' | 'unitName'>): string {
  if (item.subjectKind === 'KPI_TILE') return t('ana.decision.subject.tile', { code: item.metricCode ?? '', unit: item.unitName ?? t('ana.decision.subject.wholeScope') });
  if (item.subjectKind === 'URGENT_ALERT') return t('ana.decision.subject.alert', { source: item.source ?? '', id: item.sourceId ?? '' });
  return item.title ?? '';
}

const STATE_TONE: Record<FollowUpState, Tone> = { NONE: 'neutral', OPEN: 'neutral', DUE_SOON: 'warning', OVERDUE: 'danger', RESOLVED: 'success', SUPERSEDED: 'neutral' };

function stateLabel(t: T, state: FollowUpState): string {
  switch (state) {
    case 'NONE':
      return t('ana.decision.followUp.none');
    case 'OPEN':
      return t('ana.decision.followUp.open');
    case 'DUE_SOON':
      return t('ana.decision.followUp.dueSoon');
    case 'OVERDUE':
      return t('ana.decision.followUp.overdue');
    case 'RESOLVED':
      return t('ana.decision.followUp.resolved');
    case 'SUPERSEDED':
      return t('ana.decision.followUp.superseded');
  }
}

function outcomeLabel(t: T, outcome: Outcome): string {
  switch (outcome) {
    case 'RESOLVED':
      return t('ana.decision.outcome.resolved');
    case 'STILL_OPEN':
      return t('ana.decision.outcome.stillOpen');
    case 'SUPERSEDED':
      return t('ana.decision.outcome.superseded');
  }
}

function subjectKindLabel(t: T, kind: SubjectKind): string {
  switch (kind) {
    case 'KPI_TILE':
      return t('ana.decision.kindOfSubject.tile');
    case 'URGENT_ALERT':
      return t('ana.decision.kindOfSubject.alert');
    case 'FREE':
      return t('ana.decision.kindOfSubject.free');
  }
}

/** The word for a refusal of a command: the code the server gave, never its details. */
function problemLabel(t: T, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return t('ana.decision.problem.denied');
    if (error.code === 'METRIC_UNAVAILABLE') return t('ana.decision.problem.metricUnavailable');
    if (error.code === 'WORK_ITEM_GONE') return t('ana.decision.problem.alertGone');
    if (error.code === 'ANALYTICS_DECISION_SUPERSEDED') return t('ana.decision.problem.superseded');
    if (error.status === 422) return t('ana.decision.problem.invalid');
  }
  return t('ana.decision.problem.failed');
}

interface Draft {
  kind: SubjectKind;
  metricCode: string;
  unitId: string;
  source: string;
  sourceId: string;
  title: string;
}

const draftFrom = (params: URLSearchParams): Draft | undefined => {
  const record = params.get('record');
  if (record === 'KPI_TILE') return { kind: 'KPI_TILE', metricCode: params.get('metric') ?? '', unitId: params.get('unit') ?? '', source: '', sourceId: '', title: '' };
  if (record === 'URGENT_ALERT') return { kind: 'URGENT_ALERT', metricCode: '', unitId: '', source: params.get('source') ?? '', sourceId: params.get('source_id') ?? '', title: '' };
  if (record === 'FREE') return { kind: 'FREE', metricCode: '', unitId: '', source: '', sourceId: '', title: '' };
  return undefined;
};

/**
 * BI-22: the decision log of the leader (G3-6). Each line is a decision about a figure of HOME-03, an urgent alert or a subject, with the reason, the follow-up and the figures as they were at that moment, kept with a
 * digest. Nothing is edited: what happened afterwards is a line of outcome. Opened from a tile or an urgent alert with the record dialog ready; a decision is read back beside today's figure and the difference.
 */
export default function DecisionLogScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <DecisionLogContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function DecisionLogContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const { permissions, mode } = useSession();
  const canRecord = mode !== 'READ_ONLY' && (permissions === undefined || permissions.includes(DECISION_PERMISSION));
  const [filters, setFilters] = useState<DecisionFilters>({ subjectKind: '', openFollowUp: false, cursor: '' });
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState<Draft | undefined>(() => draftFrom(params));
  const query = useDecisions(filters);
  const page = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: page === undefined ? query.error : undefined, data: page, isEmpty: (data) => (data as { items: unknown[] }).items.length === 0 && filters.subjectKind === '' && !filters.openFollowUp });
  const commands = useDecisionCommands();
  const [notice, setNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    // The link of a tile or an alert opens the dialog once; closing it clears the link so a reload does not open it again.
    if (draft === undefined && params.get('record') !== null) setParams({}, { replace: true });
  }, [draft, params, setParams]);

  const contextItems = [
    { label: t('ana.decision.context.asOf'), value: dayText(page?.asOf ?? null) },
    { label: t('ana.decision.context.count'), value: page === undefined ? '—' : String(page.items.length) },
  ];
  const columns = page?.items ?? [];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ana.decision.page.title')}</h1>
          <p>{t('ana.decision.page.subtitle')}</p>
        </div>
        {canRecord ? (
          <button type="button" className="ui-button" onClick={() => setDraft({ kind: 'FREE', metricCode: '', unitId: '', source: '', sourceId: '', title: '' })} data-testid="decision-new">
            {t('ana.decision.new')}
          </button>
        ) : null}
      </div>
      <ContextBar items={contextItems} unit={t('ana.decision.context.unit')} />
      <div className="ana-controls" role="group" aria-label={t('ana.decision.filters.aria')}>
        <label>
          {t('ana.decision.filters.subject')}
          <select value={filters.subjectKind} onChange={(event) => setFilters({ ...filters, subjectKind: (SUBJECT_KINDS.find((kind) => kind === event.target.value) ?? '') as DecisionFilters['subjectKind'], cursor: '' })} data-testid="decision-filter-subject">
            <option value="">{t('ana.decision.filters.all')}</option>
            {SUBJECT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {subjectKindLabel(t, kind)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={filters.openFollowUp} onChange={(event) => setFilters({ ...filters, openFollowUp: event.target.checked, cursor: '' })} data-testid="decision-filter-open" /> {t('ana.decision.filters.open')}
        </label>
      </div>
      {notice === undefined ? null : (
        <p role="status" className="ana-na" data-testid="decision-notice">
          {notice}
        </p>
      )}
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {page === undefined ? null : (
          <div className="ana-stack">
            <UnverifiedNote unverified={page.policy.unverified} />
            {columns.length === 0 ? (
              <p role="status" data-testid="decision-none">
                {t('ana.decision.filtered.none')}
              </p>
            ) : (
              <div className="tablewrap">
                <table className="ana-table" aria-label={t('ana.decision.table.aria')} data-testid="decision-table">
                  <caption className="sr-only">{t('ana.decision.table.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('ana.decision.col.when')}</th>
                      <th scope="col">{t('ana.decision.col.subject')}</th>
                      <th scope="col">{t('ana.decision.col.kind')}</th>
                      <th scope="col">{t('ana.decision.col.figure')}</th>
                      <th scope="col">{t('ana.decision.col.followUp')}</th>
                      <th scope="col">{t('ana.decision.col.by')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('ana.decision.col.open')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {columns.map((item) => (
                      <tr key={item.id} data-testid="decision-row" data-id={item.id} aria-selected={selected === item.id}>
                        <td>{dayText(item.decidedAt.slice(0, 10))}</td>
                        <td>{subjectLabel(t, item)}</td>
                        <td>{kindLabel(t, item.kind)}</td>
                        <td className="num">{item.headlineValue ?? (item.headlineReason === null ? '—' : t('ana.common.na'))}</td>
                        <td>
                          <StatusPill tone={STATE_TONE[item.followUpState]}>{stateLabel(t, item.followUpState)}</StatusPill> {item.followUpDue === null ? '' : dayText(item.followUpDue)}
                        </td>
                        <td>{item.decidedBy.name === '' ? item.decidedBy.id : item.decidedBy.name}</td>
                        <td>
                          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setSelected(item.id)} data-testid={`decision-open-${item.id}`}>
                            {t('ana.decision.open')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {page.nextCursor === null && filters.cursor === '' ? null : (
              <p className="ana-controls">
                {filters.cursor === '' ? null : (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setFilters({ ...filters, cursor: '' })}>
                    {t('ana.decision.page.first')}
                  </button>
                )}
                {page.nextCursor === null ? null : (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setFilters({ ...filters, cursor: page.nextCursor as string })} data-testid="decision-next">
                    {t('ana.decision.page.next')}
                  </button>
                )}
              </p>
            )}
            {selected === '' ? null : <DecisionDetailPanel id={selected} policy={page.policy} others={columns} canRecord={canRecord} commands={commands} onClose={() => setSelected('')} onNotice={setNotice} />}
            <p>
              <Link to={COMMAND_CENTER_PATH}>{t('ana.decision.back')}</Link>
            </p>
          </div>
        )}
      </StateBoundary>
      <RecordDialog
        draft={draft}
        policy={page?.policy}
        commands={commands}
        onClose={() => {
          setDraft(undefined);
          commands.record.reset();
        }}
        onDone={(id) => {
          setDraft(undefined);
          setSelected(id);
          setNotice(t('ana.decision.recorded'));
        }}
      />
    </section>
  );
}

type Commands = ReturnType<typeof useDecisionCommands>;

function RecordDialog({ draft, policy, commands, onClose, onDone }: { draft: Draft | undefined; policy: DecisionPolicy | undefined; commands: Commands; onClose: () => void; onDone: (id: string) => void }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState('');
  const [due, setDue] = useState('');
  const [title, setTitle] = useState('');
  const busy = commands.record.isPending;
  useEffect(() => {
    setKind(policy?.kinds[0] ?? '');
    setDue('');
    setTitle(draft?.title ?? '');
  }, [draft, policy]);
  if (draft === undefined || policy === undefined) return null;
  const label = draft.kind === 'KPI_TILE' ? t('ana.decision.subject.tile', { code: draft.metricCode, unit: draft.unitId === '' ? t('ana.decision.subject.wholeScope') : draft.unitId }) : draft.kind === 'URGENT_ALERT' ? t('ana.decision.subject.alert', { source: draft.source, id: draft.sourceId }) : title;
  const confirm = (reason?: string): void => {
    if (busy) return;
    commands.record.mutate(
      { subject: { kind: draft.kind, metricCode: draft.metricCode === '' ? undefined : draft.metricCode, unitId: draft.unitId, source: draft.source === '' ? undefined : draft.source, sourceId: draft.sourceId === '' ? undefined : draft.sourceId, title: draft.kind === 'FREE' ? title : undefined }, kind, reason: (reason ?? '').trim(), followUpDue: due, followUpOwnerId: '' },
      { onSuccess: (answer) => onDone(String((answer as { resource_id?: unknown }).resource_id ?? '')) },
    );
  };
  return (
    <ConfirmDialog
      open
      title={t('ana.decision.dialog.title')}
      context={[
        { label: t('ana.decision.col.subject'), value: label === '' ? '—' : label },
        { label: t('ana.decision.dialog.frozen'), value: t('ana.decision.dialog.frozenBody') },
      ]}
      confirmLabel={t('ana.decision.dialog.confirm')}
      cancelLabel={t('ana.decision.dialog.cancel')}
      reason={{ label: t('ana.decision.dialog.reason', { min: policy.reasonMin, max: policy.reasonMax }), required: true, minLength: policy.reasonMin }}
      pending={busy}
      {...(commands.record.isError ? { error: problemLabel(t, commands.record.error) } : {})}
      onConfirm={confirm}
      onCancel={() => {
        if (!busy) onClose();
      }}
    >
      {draft.kind === 'FREE' ? (
        <label className="ana-field">
          {t('ana.decision.dialog.subject')}
          <input type="text" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} data-testid="decision-title" />
        </label>
      ) : null}
      <label className="ana-field">
        {t('ana.decision.dialog.kind')}
        <select value={kind} onChange={(event) => setKind(event.target.value)} data-testid="decision-kind">
          {policy.kinds.map((one) => (
            <option key={one} value={one}>
              {kindLabel(t, one)}
            </option>
          ))}
        </select>
      </label>
      <label className="ana-field">
        {t('ana.decision.dialog.followUp', { days: policy.followUpMaxDays })}
        <input type="date" value={due} onChange={(event) => setDue(event.target.value)} data-testid="decision-due" />
      </label>
    </ConfirmDialog>
  );
}

function DecisionDetailPanel({ id, policy, others, canRecord, commands, onClose, onNotice }: { id: string; policy: DecisionPolicy; others: readonly DecisionItem[]; canRecord: boolean; commands: Commands; onClose: () => void; onNotice: (text: string | undefined) => void }) {
  const { t } = useTranslation();
  const query = useDecision(id);
  const detail: DecisionDetail | undefined = query.data;
  const [outcome, setOutcome] = useState<Outcome>('STILL_OPEN');
  const [note, setNote] = useState('');
  const [replacement, setReplacement] = useState('');
  const closed = detail?.latestOutcome === 'SUPERSEDED';
  const noteOk = note.trim().length >= policy.outcomeNoteMin && (outcome !== 'SUPERSEDED' || replacement !== '');
  const send = (): void => {
    if (detail === undefined || !noteOk || commands.outcome.isPending) return;
    commands.outcome.mutate(
      { id: detail.id, outcome, note: note.trim(), supersededBy: replacement },
      {
        onSuccess: () => {
          setNote('');
          onNotice(t('ana.decision.outcome.recorded'));
        },
      },
    );
  };
  return (
    <SectionCard title={t('ana.decision.detail.title')} actions={<button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClose}>{t('ana.decision.detail.close')}</button>}>
      {query.isLoading ? <p role="status">{t('ana.decision.detail.loading')}</p> : null}
      {query.isError ? (
        <p role="alert" data-testid="decision-detail-error">
          {t('ana.decision.detail.error')}
        </p>
      ) : null}
      {detail === undefined ? null : (
        <div className="ana-stack" data-testid="decision-detail">
          <p>
            <strong>{subjectLabel(t, detail)}</strong> {kindLabel(t, detail.kind)}
          </p>
          <p data-testid="decision-reason">{detail.reason}</p>
          <p className="ana-caveat" data-testid="decision-digest">
            {detail.digestOk ? t('ana.decision.digest.ok', { digest: detail.figuresSha256.slice(0, 12) }) : t('ana.decision.digest.bad')}
          </p>
          {detail.subjectKind === 'KPI_TILE' ? (
            <ul className="ana-tiles" data-testid="decision-compare">
              <li className="ana-tile">
                <span className="ana-tile__label">{t('ana.decision.compare.then', { day: dayText(detail.asOfDate) })}</span>
                <strong className="ana-tile__value">{detail.frozenFigure?.displayValue ?? t('ana.common.na')}</strong>
              </li>
              <li className="ana-tile">
                <span className="ana-tile__label">{t('ana.decision.compare.now', { day: dayText(detail.current?.asOfDate ?? null) })}</span>
                <strong className="ana-tile__value">{detail.current === null ? t('ana.common.na') : (detail.current.displayValue ?? t('ana.common.na'))}</strong>
              </li>
              <li className="ana-tile">
                <span className="ana-tile__label">{t('ana.decision.compare.delta')}</span>
                <strong className="ana-tile__value" data-testid="decision-delta">
                  {detail.comparison?.delta ?? t('ana.common.na')}
                </strong>
                {detail.comparison?.nullReason === null || detail.comparison === null ? null : <span className="ana-tile__note">{compareReason(t, detail.comparison.nullReason)}</span>}
              </li>
            </ul>
          ) : null}
          {detail.frozenAlert === null ? null : (
            <p data-testid="decision-alert">
              {t('ana.decision.alert.frozen', { title: detail.frozenAlert.title, severity: detail.frozenAlert.severity, status: detail.frozenAlert.status })} {detail.current?.state === 'GONE' ? t('ana.decision.alert.gone') : ''}
            </p>
          )}
          {detail.frozenTiles.length === 0 ? null : (
            <details>
              <summary>{t('ana.decision.tiles.summary', { count: detail.frozenTiles.length })}</summary>
              <ul data-testid="decision-tiles">
                {detail.frozenTiles.map((tile) => (
                  <li key={tile.metricCode}>
                    {tile.metricCode}: {tile.displayValue ?? t('ana.common.na')}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <h3>{t('ana.decision.outcomes.title')}</h3>
          {detail.outcomes.length === 0 ? (
            <p className="muted">{t('ana.decision.outcomes.none')}</p>
          ) : (
            <ol data-testid="decision-outcomes">
              {detail.outcomes.map((line) => (
                <li key={line.id}>
                  <StatusPill tone={line.outcome === 'RESOLVED' ? 'success' : 'neutral'}>{outcomeLabel(t, line.outcome)}</StatusPill> {dayText(line.at.slice(0, 10))} {line.actor.name}: {line.note}
                </li>
              ))}
            </ol>
          )}
          {canRecord && !closed ? (
            <div className="ana-controls" role="group" aria-label={t('ana.decision.outcome.form')}>
              <label>
                {t('ana.decision.outcome.label')}
                <select value={outcome} onChange={(event) => setOutcome(OUTCOMES.find((one) => one === event.target.value) ?? 'STILL_OPEN')} data-testid="outcome-kind">
                  {OUTCOMES.map((one) => (
                    <option key={one} value={one}>
                      {outcomeLabel(t, one)}
                    </option>
                  ))}
                </select>
              </label>
              {outcome === 'SUPERSEDED' ? (
                <label>
                  {t('ana.decision.outcome.replacement')}
                  <select value={replacement} onChange={(event) => setReplacement(event.target.value)} data-testid="outcome-replacement">
                    <option value="">{t('ana.decision.outcome.choose')}</option>
                    {others
                      .filter((other) => other.id !== detail.id)
                      .map((other) => (
                        <option key={other.id} value={other.id}>
                          {subjectLabel(t, other)} {dayText(other.decidedAt.slice(0, 10))}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}
              <label>
                {t('ana.decision.outcome.note', { min: policy.outcomeNoteMin })}
                <input type="text" value={note} onChange={(event) => setNote(event.target.value)} data-testid="outcome-note" />
              </label>
              <button type="button" className="ui-button" disabled={!noteOk || commands.outcome.isPending} onClick={send} data-testid="outcome-send">
                {t('ana.decision.outcome.send')}
              </button>
              {commands.outcome.isError ? (
                <span role="alert" data-testid="outcome-error">
                  {problemLabel(t, commands.outcome.error)}
                </span>
              ) : null}
            </div>
          ) : null}
          {closed ? <p className="muted">{t('ana.decision.outcome.closed')}</p> : null}
        </div>
      )}
    </SectionCard>
  );
}

function compareReason(t: T, reason: string): string {
  switch (reason) {
    case 'NO_VALUE_THEN':
      return t('ana.decision.compare.noThen');
    case 'NO_VALUE_NOW':
      return t('ana.decision.compare.noNow');
    default:
      return t('ana.decision.compare.notReadable');
  }
}
