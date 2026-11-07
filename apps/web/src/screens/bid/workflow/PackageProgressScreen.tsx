import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { AuditLine, ContextBar, DayStrip, MakerCheckerBadge, SectionCard, Stepper, StatusPill, Timeline } from '../../../ui';
import type { DayStripBar, StepperStep } from '../../../ui';
import { PATHS } from './components';
import { useDetail, useTimeline } from './hooks';
import type { TimelineFilter } from './hooks';
import { blockerLabel, countdownText, exceptionKindLabel, exceptionStatusLabel, evidenceKindLabel, itemStatusLabel, methodLabel, milestoneLabel, statusLabel, toTimelineGroups, whereLine } from './labels';
import type { Names } from './labels';
import { billions, fullDay, shortDay, vietnamDay, vietnamTime } from './model';
import type { DetailDto, EntryDto, WorkflowDto } from './model';
import { PackageDialogs } from './PackageDialogs';
import type { PackageDialog } from './PackageDialogs';
import './workflow.css';

type Tab = 'progress' | 'checklist' | 'documents' | 'related';

/**
 * BID-29, "Tiến trình gói thầu" (PRC-1): ONE package — which step it is at, since when and how far past the standard, who holds it, what blocks it, the checklist of the step with its evidence, every change of state day by day,
 * and the shortcuts to the records that belong to it. The commands (advance, return, hold, assign, ask for an exception, cancel) are offered only when the server says the caller may.
 */
export default function PackageProgressScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <PackageProgressContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

const csvCell = (value: string): string => {
  // A cell that starts like a formula is written as text: a file opened in a spreadsheet must not run what a person typed.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

function download(name: string, text: string): void {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function stepperOf(t: ReturnType<typeof useTranslation>['t'], workflow: WorkflowDto): StepperStep[] {
  const current = workflow.progress.current_order;
  const days = new Map(workflow.timeline.summary.map((row) => [row.step_code, row]));
  const reached = new Set(workflow.history.map((visit) => visit.step_code));
  return workflow.steps.map((step): StepperStep => {
    const summary = days.get(step.code);
    const base = { code: step.code, label: step.name, plannedDays: step.standard_working_days, ...(summary === undefined ? {} : { actualDays: summary.days }) };
    if (workflow.status === 'COMPLETED') return { ...base, status: 'done' };
    if (workflow.status === 'CANCELLED') return { ...base, status: reached.has(step.code) ? 'done' : 'upcoming' };
    if (current === null || step.order > current) return { ...base, status: 'upcoming' };
    if (step.order < current) return { ...base, status: 'done' };
    if (workflow.status === 'ON_HOLD') return { ...base, status: 'hold', current: true, ...(workflow.hold_reason === null ? {} : { note: workflow.hold_reason }) };
    if (workflow.late) return { ...base, status: 'late', current: true, lateDays: summary?.days_over ?? 0 };
    return { ...base, status: 'current' };
  });
  void t;
}

function PackageProgressContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant, mode } = useSession();
  const [search] = useSearchParams();
  const packageId = search.get('package') ?? '';
  const node = search.get('node');
  const detail = useDetail(packageId);
  const [tab, setTab] = useState<Tab>('progress');
  const [filter, setFilter] = useState<TimelineFilter>({});
  const [dialog, setDialog] = useState<PackageDialog | undefined>(undefined);
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const timeline = useTimeline(packageId, filter, tab === 'progress');
  const state = useScreenState({ isLoading: detail.isLoading && packageId !== '', error: detail.data === undefined ? detail.error : undefined, data: detail.data, isEmpty: () => false });
  const data: DetailDto | undefined = detail.data;
  const workflow = data?.workflow ?? null;
  const readOnly = mode === 'READ_ONLY';
  const actions = data?.actions ?? {};

  const stepNames = useMemo(() => new Map((workflow?.steps ?? []).map((step) => [step.code, step.name])), [workflow]);
  const names: Names = { step: (code) => (code === null ? undefined : stepNames.get(code)) };
  const groups = useMemo(() => (timeline.data === undefined ? [] : toTimelineGroups(t, timeline.data, names)), [timeline.data, t, stepNames]); // eslint-disable-line react-hooks/exhaustive-deps
  const allEntries: EntryDto[] = useMemo(() => (workflow?.timeline.days ?? []).flatMap((day) => day.entries), [workflow]);
  const actors = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of allEntries) if (entry.actor !== null) seen.set(entry.actor.id, entry.actor.name ?? entry.actor.id);
    return [...seen.entries()];
  }, [allEntries]);

  const today = data === undefined ? '' : vietnamDay(data.as_of);
  const asOf = data === undefined ? undefined : `${fullDay(today)} ${vietnamTime(data.as_of)}`;
  const current = workflow?.timeline.summary.find((row) => row.current === true) ?? workflow?.timeline.summary.find((row) => row.step_code === workflow.step?.code);
  const changes30 = allEntries.filter((entry) => entry.state_change && entry.day >= new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10)).length;
  const done = (kind: PackageDialog['kind'], step?: string): void => {
    const time = vietnamTime(new Date().toISOString());
    setReceipt(kind === 'advance' ? t('prc1.receipt.advance.text', { step: step ?? t('prc1.receipt.end.text'), time }) : t('prc1.receipt.done.text', { time }));
  };

  const exportCsv = (): void => {
    const rows = (timeline.data?.days ?? []).flatMap((day) => day.entries.map((entry) => [entry.day, vietnamTime(entry.at), entry.kind, names.step(entry.from_step) ?? '', names.step(entry.to_step) ?? '', entry.actor?.name ?? '', entry.spent_working_days === null ? (entry.spent_calendar_days === null ? '' : String(entry.spent_calendar_days)) : String(entry.spent_working_days), entry.reason ?? '']));
    const head = [t('prc1.export.day.label'), t('prc1.export.time.label'), t('prc1.export.kind.label'), t('prc1.export.from.label'), t('prc1.export.to.label'), t('prc1.export.actor.label'), t('prc1.export.days.label'), t('prc1.export.reason.label')];
    download(`tien-trinh-${data?.package.code ?? 'goi-thau'}.csv`, [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n'));
  };

  const bars: DayStripBar[] = (timeline.data?.gantt ?? workflow?.timeline.gantt ?? []).map((bar) => ({
    code: bar.step_code,
    label: stepNames.get(bar.step_code) ?? bar.step_code,
    planned: bar.planned === null ? null : { from: bar.planned.start_on, to: bar.planned.end_on },
    actual: bar.actual === null ? null : { from: bar.actual.start_on, to: bar.actual.end_on, open: bar.actual.open },
  }));
  const timelineState = timeline.isLoading ? 'loading' : timeline.isError ? 'error' : groups.length === 0 ? 'empty' : 'ready';
  const filtered = filter.from !== undefined || filter.to !== undefined || filter.actor_id !== undefined || filter.only_state_changes === true;
  const documents = allEntries.flatMap((entry) => entry.evidence.filter((one) => one.document_id !== null).map((one) => ({ entry, one })));
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'progress', label: t('prc1.package.tab.progress') },
    { id: 'checklist', label: t('prc1.package.tab.checklist') },
    { id: 'documents', label: t('prc1.package.tab.documents') },
    { id: 'related', label: t('prc1.package.tab.related') },
  ];
  const may = (flag: boolean | undefined): boolean => flag === true && !readOnly;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <p className="bid-back-link">
        <Link to={node === null ? PATHS.tree : `${PATHS.tree}?node=${encodeURIComponent(node)}`}>{t('prc1.package.back.link')}</Link>
      </p>
      {packageId === '' ? (
        <>
          <div className="heading"><div><h1 id="screen-title">{t('prc1.package.page.title')}</h1></div></div>
          <p className="callout" role="status" data-testid="choose-package">{t('prc1.package.choose.text')} <Link to={PATHS.tree}>{t('prc1.package.choose.link')}</Link></p>
        </>
      ) : (
        <StateBoundary state={state === 'default' ? 'default' : state} onRetry={() => void detail.refetch()}>
          {data !== undefined && (
            <>
              <div className="heading">
                <div>
                  <h1 id="screen-title">{t('prc1.package.heading.title', { code: data.package.code })}</h1>
                  <p>{data.package.title ?? ''}</p>
                </div>
                <div className="actions prc1-actions">
                  {may(actions.start) && <button type="button" className="primary" onClick={() => setDialog({ kind: 'start' })}>{t('prc1.action.start.action')}</button>}
                  {may(actions.advance) && <button type="button" className="primary" onClick={() => setDialog({ kind: 'advance' })}>{t('prc1.action.advance.action')}</button>}
                  {may(actions.return) && <button type="button" onClick={() => setDialog({ kind: 'return' })}>{t('prc1.action.return.action')}</button>}
                  {may(actions.hold) && <button type="button" onClick={() => setDialog({ kind: 'hold' })}>{t('prc1.action.hold.action')}</button>}
                  {may(actions.resume) && <button type="button" onClick={() => setDialog({ kind: 'resume' })}>{t('prc1.action.resume.action')}</button>}
                  {may(actions.assign_owner) && <button type="button" onClick={() => setDialog({ kind: 'owner' })}>{workflow?.owner === null || workflow === null ? t('prc1.action.assign.action') : t('prc1.action.reassign.action')}</button>}
                  {may(actions.request_exception) && <button type="button" onClick={() => setDialog({ kind: 'exception' })}>{t('prc1.action.exception.action')}</button>}
                  {may(actions.cancel) && <button type="button" className="danger" onClick={() => setDialog({ kind: 'cancel' })}>{t('prc1.action.cancel.action')}</button>}
                </div>
              </div>
              <ContextBar
                items={[
                  { label: t('prc1.package.project.label'), value: `${data.project.code} · ${data.project.name}` },
                  { label: t('prc1.package.value.label'), value: `${billions(data.package.value_vnd, locale)} ${t('prc1.unit.billion.name')}` },
                  { label: t('prc1.package.method.label'), value: methodLabel(t, data.package.method) },
                  { label: t('prc1.package.owner.label'), value: workflow?.owner?.name ?? t('prc1.column.noOwner.text') },
                ]}
                asOf={asOf}
                stale={detail.isError}
                unit={t('prc1.unit.billion.name')}
              />
              {workflow !== null && (
                <AuditLine
                  items={[
                    { label: t('prc1.audit.started.label'), value: fullDay(vietnamDay(workflow.started_at)) },
                    { label: t('prc1.audit.activity.label'), value: fullDay(workflow.last_activity_on) },
                    { label: t('prc1.audit.definition.label'), value: workflow.definition.rule_version === 0 ? t('prc1.audit.definition.default') : t('prc1.audit.definition.rule', { version: workflow.definition.rule_version }) },
                  ]}
                />
              )}
              {receipt !== undefined && <p className="callout prc1-receipt" role="status">{receipt}</p>}
              {workflow === null ? (
                <SectionCard title={t('prc1.package.notStarted.title')}>
                  <p>{t('prc1.package.notStarted.text')}</p>
                  <ol className="prc1-list">{(data.definition_steps ?? []).map((step) => <li key={step.code}>{t('prc1.package.notStarted.step', { name: step.name, days: step.standard_working_days })}</li>)}</ol>
                  {data.startable === false && <p className="sub">{t('prc1.package.notStartable.text')}</p>}
                </SectionCard>
              ) : (
                <>
                  <SectionCard title={t('prc1.package.stepper.title')} status={<StatusPill tone={workflow.status === 'ON_HOLD' ? 'neutral' : workflow.status === 'CANCELLED' ? 'danger' : workflow.status === 'COMPLETED' ? 'success' : 'info'}>{statusLabel(t, workflow.status)}</StatusPill>}>
                    <Stepper steps={stepperOf(t, workflow)} label={t('prc1.package.stepper.label')} />
                    <p className="prc1-where" data-testid="where">
                      {whereLine(t, { stepName: workflow.step?.name ?? null, days: workflow.days_in_step === null ? null : (workflow.days_in_step.working_days ?? workflow.days_in_step.calendar_days), over: current?.days_over ?? 0, owner: workflow.owner?.name ?? null })}
                      {workflow.status === 'IN_PROGRESS' || workflow.status === 'ON_HOLD' ? <> · {countdownText(t, workflow.countdown)}</> : null}
                    </p>
                    {(workflow.status === 'IN_PROGRESS' || workflow.status === 'ON_HOLD') && workflow.blockers.length > 0 && (
                      <div className="callout prc1-blockers" role="status" data-testid="blockers">
                        <strong>{t('prc1.blockers.title')}</strong>
                        <ul className="prc1-list">{workflow.blockers.map((blocker) => <li key={blocker.reason}>{blockerLabel(t, blocker)}</li>)}</ul>
                        <div className="prc1-blockers__actions">
                          {workflow.blockers.some((one) => one.reason === 'REQUIRED_ITEMS_OPEN' || one.reason === 'EVIDENCE_MISSING') && <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setTab('checklist')}>{t('prc1.blockers.checklist.action')}</button>}
                          {workflow.blockers.some((one) => one.reason === 'NO_OWNER') && may(actions.assign_owner) && <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setDialog({ kind: 'owner' })}>{t('prc1.action.assign.action')}</button>}
                          {workflow.status === 'ON_HOLD' && may(actions.resume) && <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setDialog({ kind: 'resume' })}>{t('prc1.action.resume.action')}</button>}
                        </div>
                      </div>
                    )}
                    {workflow.status === 'CANCELLED' && workflow.end_reason !== null && <p className="callout" role="status">{t('prc1.package.cancelled.text', { reason: workflow.end_reason })}</p>}
                  </SectionCard>
                  <div className="prc1-tabs" role="tablist" aria-label={t('prc1.package.tabs.label')}>
                    {tabs.map((one) => (
                      <button key={one.id} type="button" role="tab" id={`prc1-p-${one.id}`} aria-selected={tab === one.id} aria-controls={`prc1-ptab-${one.id}`} tabIndex={tab === one.id ? 0 : -1} className={`prc1-tabs__tab${tab === one.id ? ' is-active' : ''}`} onClick={() => setTab(one.id)}>{one.label}</button>
                    ))}
                  </div>
                  <div role="tabpanel" id={`prc1-ptab-${tab}`} aria-labelledby={`prc1-p-${tab}`}>
                    {tab === 'progress' && (
                      <div className="prc1-progress">
                        <p className="prc1-summary" data-testid="summary">
                          {current === undefined ? t('prc1.summary.none.text') : t('prc1.summary.line.text', { days: current.days, step: workflow.step?.name ?? stepNames.get(current.step_code) ?? current.step_code, over: current.days_over, changes: changes30 })}
                        </p>
                        <DayStrip
                          from={vietnamDay(workflow.started_at)}
                          to={today}
                          today={today}
                          changes={workflow.timeline.days.map((day) => day.day)}
                          deadlines={workflow.history.flatMap((visit) => (visit.due_on === null ? [] : [visit.due_on]))}
                          selectedDay={filter.from !== undefined && filter.from === filter.to ? filter.from : undefined}
                          onSelectDay={(day) => setFilter((value) => (value.from === day && value.to === day ? { ...value, from: undefined, to: undefined } : { ...value, from: day, to: day }))}
                          bars={bars}
                        />
                        <div className="prc1-timeline-filters">
                          <div className="field">
                            <label htmlFor="prc1-t-from">{t('prc1.filter.from.label')}</label>
                            <input id="prc1-t-from" type="date" value={filter.from ?? ''} onChange={(event) => setFilter((value) => ({ ...value, from: event.target.value === '' ? undefined : event.target.value }))} />
                          </div>
                          <div className="field">
                            <label htmlFor="prc1-t-to">{t('prc1.filter.to.label')}</label>
                            <input id="prc1-t-to" type="date" value={filter.to ?? ''} onChange={(event) => setFilter((value) => ({ ...value, to: event.target.value === '' ? undefined : event.target.value }))} />
                          </div>
                          <div className="field">
                            <label htmlFor="prc1-t-actor">{t('prc1.timeline.actor.label')}</label>
                            <select id="prc1-t-actor" value={filter.actor_id ?? ''} onChange={(event) => setFilter((value) => ({ ...value, actor_id: event.target.value === '' ? undefined : event.target.value }))}>
                              <option value="">{t('prc1.filter.all.text')}</option>
                              {actors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                            </select>
                          </div>
                          <label className="checkbox"><input type="checkbox" checked={filter.only_state_changes === true} onChange={(event) => setFilter((value) => ({ ...value, only_state_changes: event.target.checked ? true : undefined }))} /> {t('prc1.timeline.only.label')}</label>
                          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={exportCsv} disabled={timelineState !== 'ready'}>{t('prc1.timeline.export.action')}</button>
                        </div>
                        <Timeline
                          caption={t('prc1.timeline.caption.text')}
                          groups={groups}
                          today={today}
                          waitingLabel={workflow.step?.name ?? undefined}
                          state={timelineState}
                          emptyKind={filtered ? 'filtered' : 'none'}
                          onRetry={() => void timeline.refetch()}
                          onOrder={(order) => setFilter((value) => ({ ...value, order: order === 'asc' ? 'oldest' : 'newest' }))}
                          order={filter.order === 'oldest' ? 'asc' : 'desc'}
                        />
                      </div>
                    )}
                    {tab === 'checklist' && (
                      <div className="prc1-checklist">
                        <ul className="prc1-items" aria-label={t('prc1.checklist.label')}>
                          {workflow.checklist.length === 0 && <li className="sub">{t('prc1.checklist.none.text')}</li>}
                          {workflow.checklist.map((item) => (
                            <li key={item.id} className={`prc1-item is-${item.status.toLowerCase()}`} data-item={item.code}>
                              <div className="prc1-item__main">
                                <strong>{item.name}</strong>
                                <StatusPill tone={item.required ? 'warning' : 'neutral'}>{item.required ? t('prc1.item.required.name') : t('prc1.item.optional.name')}</StatusPill>
                                <StatusPill tone={item.status === 'DONE' ? 'success' : item.status === 'WAIVED' ? 'neutral' : 'info'}>{itemStatusLabel(t, item.status)}</StatusPill>
                              </div>
                              <div className="prc1-item__meta sub">
                                {item.due_on !== null && <span>{t('prc1.item.due.text', { day: shortDay(item.due_on) })}</span>}
                                <span>{item.owner === null ? t('prc1.column.noOwner.text') : (item.owner.name ?? '')}</span>
                                {item.completed_via === 'MILESTONE' && <span>{t('prc1.item.viaMilestone.text', { milestone: item.milestone_kind === null ? '' : milestoneLabel(t, item.milestone_kind) })}</span>}
                                {item.completed_by !== null && <span>{t('prc1.item.doneBy.text', { name: item.completed_by.name ?? '' })}</span>}
                              </div>
                              {item.evidence.length > 0 && (
                                <ul className="prc1-evidence">{item.evidence.map((one, index) => <li key={`${one.kind}:${index}`} className="ui-timeline__chip">{one.milestone_kind === null ? evidenceKindLabel(t, one.kind) : milestoneLabel(t, one.milestone_kind)}</li>)}</ul>
                              )}
                              {item.status === 'OPEN' && (
                                <div className="prc1-item__actions">
                                  {may(actions.work) && <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={() => setDialog({ kind: 'complete', item })}>{t('prc1.item.complete.action')}</button>}
                                  {may(actions.assign_owner) && <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setDialog({ kind: 'assignItem', item })}>{t('prc1.item.assign.action')}</button>}
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                        <SectionCard title={t('prc1.exceptions.title')}>
                          {workflow.exceptions.length === 0 ? (
                            <p className="sub">{t('prc1.exceptions.none.text')}</p>
                          ) : (
                            <ul className="prc1-items">
                              {workflow.exceptions.map((one) => (
                                <li key={one.id} className="prc1-item" data-exception={one.id}>
                                  <div className="prc1-item__main">
                                    <strong>{exceptionKindLabel(t, one.kind)}</strong>
                                    <StatusPill tone={one.status === 'APPROVED' || one.status === 'USED' ? 'success' : one.status === 'REJECTED' ? 'danger' : 'warning'}>{exceptionStatusLabel(t, one.status)}</StatusPill>
                                  </div>
                                  <p>{one.reason}</p>
                                  <MakerCheckerBadge maker={one.requested_by.name ?? ''} checker={one.decided_by?.name ?? null} />
                                  {one.status === 'REQUESTED' && may(actions.decide_exception) && one.requested_by.id !== tenant?.membershipId && (
                                    <div className="prc1-item__actions">
                                      <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={() => setDialog({ kind: 'decide', exception: one, decision: 'APPROVE' })}>{t('prc1.exceptions.approve.action')}</button>
                                      <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setDialog({ kind: 'decide', exception: one, decision: 'REJECT' })}>{t('prc1.exceptions.reject.action')}</button>
                                    </div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </SectionCard>
                      </div>
                    )}
                    {tab === 'documents' && (
                      <SectionCard title={t('prc1.documents.title')}>
                        {documents.length === 0 ? (
                          <p className="sub" data-testid="no-documents">{t('prc1.documents.none.text')}</p>
                        ) : (
                          <ul className="prc1-items">
                            {documents.map(({ entry, one }) => (
                              <li key={`${entry.id}:${one.document_id}`} className="prc1-item">
                                <a href={`/d/${one.document_id}`}>{evidenceKindLabel(t, one.kind)}</a>
                                <span className="sub">{t('prc1.documents.row.text', { step: stepNames.get(entry.from_step ?? '') ?? entry.from_step ?? '', day: shortDay(entry.day) })}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </SectionCard>
                    )}
                    {tab === 'related' && (
                      <SectionCard title={t('prc1.related.title')}>
                        <ul className="prc1-items">
                          <li className="prc1-item">
                            <Link to={`/bid/bid-17?package=${data.package.id}`}>{t('prc1.related.milestones.link')}</Link>
                            <span className="sub">{workflow.links.milestones.filter((one) => one.actual_at !== null).map((one) => `${milestoneLabel(t, one.kind)} (${one.source === 'IMPORT' ? t('prc1.related.import.text') : t('prc1.related.manual.text')})`).join('; ') || t('prc1.related.milestones.none')}</span>
                          </li>
                          <li className="prc1-item">
                            <Link to="/bid/bid-19">{t('prc1.related.network.link')}</Link>
                          </li>
                          <li className="prc1-item">
                            <Link to={`/bid/bid-20?package=${data.package.id}`}>{t('prc1.related.petitions.link')}</Link>
                            <span className="sub">{t('prc1.related.petitions.text', { total: workflow.links.petitions.total, open: workflow.links.petitions.open })}</span>
                          </li>
                          <li className="prc1-item">
                            <Link to="/bid/bid-18">{t('prc1.related.result.link')}</Link>
                            <span className="sub">{workflow.links.result === null ? t('prc1.related.result.none') : workflow.links.result.status}</span>
                          </li>
                          <li className="prc1-item">
                            <span>{t('prc1.related.contract.label')}</span>
                            <span className="sub">{workflow.links.contract === null ? t('prc1.related.contract.none') : `${workflow.links.contract.code} · ${workflow.links.contract.status}`}</span>
                          </li>
                        </ul>
                      </SectionCard>
                    )}
                  </div>
                </>
              )}
              <PackageDialogs detail={data} dialog={dialog} onClose={() => setDialog(undefined)} onDone={(info) => done(info.kind, info.step)} onReload={() => void detail.refetch()} />
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('prc1.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
