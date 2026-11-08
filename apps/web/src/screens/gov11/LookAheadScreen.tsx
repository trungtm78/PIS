import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StatusPill } from '../../ui';
import { Figure, Frame, PickId, UUID_PATTERN, UnverifiedNote, asList, asRecord, dayLabel, num, refusalCode, text, useGovCommand, useGovRead } from './gov11-kit';
import type { RuleReading } from './gov11-kit';
import { ConstraintFormBox, PlanCreateForm } from './LookAheadForms';
import { defaultWeekStart, vietnamDay } from './lookahead-form';

const WRITE_PERMISSION = 'look_ahead.write';
type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
const TONE: Readonly<Record<string, Tone>> = { READY: 'success', CONSTRAINED: 'warning', NOT_READY: 'danger', DONE: 'success', NOT_DONE: 'danger' };
const BAND_TONE: Readonly<Record<string, Tone>> = { ON_TARGET: 'success', BELOW_TARGET: 'warning', ALERT: 'danger', NO_DATA: 'neutral' };

/**
 * PRJ-30, the look-ahead plan of a project (G1-19): the work of the next 2 to 6 weeks, what has to be ready before each item starts, and what was done at the end of the week with the standard reason when it was not
 * (PPC). A plan is published once; constraints are cleared once; an outcome is recorded once. The window and the thresholds are the rule LOOK_AHEAD_POLICY (not confirmed).
 */
export default function LookAheadScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [search, setSearch] = useSearchParams();
  const raw = search.get('id') ?? '';
  const id = UUID_PATTERN.test(raw) ? raw : undefined;
  const [created, setCreated] = useState(false);
  const planRaw = search.get('plan') ?? '';
  const planId = UUID_PATTERN.test(planRaw) ? planRaw : undefined;
  const query = useGovRead('prj', 'getLookAhead', id === undefined ? undefined : { path: { id }, ...(planId === undefined ? {} : { query: { plan_id: planId } }) }, id !== undefined);
  if (id === undefined) return <PickId route={route} title={t('gov11.lookAhead.title')} subtitle={t('gov11.lookAhead.subtitle')} raw={raw} onPick={(picked) => setSearch({ id: picked })} />;
  return (
    <Frame
      route={route}
      title={t('gov11.lookAhead.title')}
      subtitle={t('gov11.lookAhead.subtitle')}
      scope={[
        { label: t('gov11.common.scope'), value: tenant?.name ?? '–' },
        { label: t('gov11.lookAhead.project'), value: text(asRecord(query.data?.project).code) },
      ]}
      query={query}
      notice={
        <>
          <UnverifiedNote rules={[asRecord(query.data?.rule) as unknown as RuleReading]} />
          {created && (
            <p className="callout" role="status" data-testid="created-receipt">
              {t('gov11.lookAhead.form.created')}
            </p>
          )}
        </>
      }
    >
      {(data) => <Plan data={data} projectId={id} onOpen={(opened) => setSearch(opened === undefined ? { id } : { id, plan: opened })} onCreated={(planId) => { setCreated(true); setSearch(planId === '' ? { id } : { id, plan: planId }); }} />}
    </Frame>
  );
}

interface PlanProps {
  data: Record<string, unknown>;
  projectId: string;
  onOpen: (planId?: string) => void;
  onCreated: (planId: string) => void;
}

/** The button that opens the creation form, and the form: a plan is made by a person who may write the look-ahead (the server decides again). */
function NewPlan({ data, projectId, onCreated, onOpen, first }: { data: Record<string, unknown>; projectId: string; onCreated: (planId: string) => void; onOpen: (planId?: string) => void; first: boolean }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const [open, setOpen] = useState(false);
  if (permissions !== undefined && !permissions.includes(WRITE_PERMISSION)) return <p data-testid="no-create">{t('gov11.lookAhead.form.noRight')}</p>;
  const today = vietnamDay(data.as_of) ?? '';
  const existing = asList(data.history).map((week) => text(week.week_start, ''));
  return (
    <div className="gov11-grid">
      {!open && (
        <div className="gov11-row">
          <button type="button" className={`ui-button ${first ? 'ui-button--primary' : 'ui-button--outline'}`} onClick={() => setOpen(true)} data-testid="new-plan">
            {first ? t('gov11.lookAhead.empty.create') : t('gov11.lookAhead.form.open')}
          </button>
        </div>
      )}
      {open && (
        <PlanCreateForm
          projectId={projectId}
          rule={asRecord(data.rule) as unknown as RuleReading}
          asOf={dayLabel(today)}
          existingWeeks={existing}
          defaultWeekStart={defaultWeekStart(today, existing)}
          onCancel={() => setOpen(false)}
          onOpenPlan={(planId) => {
            setOpen(false);
            onOpen(planId);
          }}
          onDone={(planId) => {
            setOpen(false);
            onCreated(planId);
          }}
        />
      )}
    </div>
  );
}

function Plan(props: PlanProps) {
  const { t } = useTranslation();
  if (props.data.plan === null) {
    return (
      <div className="gov11-grid" data-testid="no-plan">
        <section aria-labelledby="empty-title">
          <h2 id="empty-title">{t('gov11.lookAhead.empty.title')}</h2>
          <p>{t('gov11.lookAhead.empty.body')}</p>
          {props.data.overdue === true && (
            <p className="callout" role="status" data-testid="overdue-note">
              {t('gov11.lookAhead.overdue')}
            </p>
          )}
        </section>
        <NewPlan data={props.data} projectId={props.projectId} onCreated={props.onCreated} onOpen={props.onOpen} first />
      </div>
    );
  }
  return <PlanBoard {...props} />;
}

function PlanBoard({ data, projectId, onOpen, onCreated }: PlanProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const mayWrite = permissions === undefined || permissions.includes(WRITE_PERMISSION);
  const [raising, setRaising] = useState<string | undefined>(undefined);
  const rule = asRecord(data.rule) as unknown as RuleReading;
  const plan = asRecord(data.plan);
  const ppc = asRecord(plan.ppc);
  const items = asList(plan.items);
  const history = asList(data.history);
  const outcome = useGovCommand('recordLookAheadOutcome');
  const clear = useGovCommand('clearLookAheadConstraint');
  const publish = useGovCommand('publishLookAheadPlan');
  const [recording, setRecording] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState('WEATHER');
  const [receipt, setReceipt] = useState<string | undefined>(undefined);
  const asOf = dayLabel(plan.week_start);
  const params = asRecord(rule.params);
  const reasons = Array.isArray(params.variance_reasons) ? (params.variance_reasons as string[]) : ['OTHER'];
  const stateLabel = (state: string): string => {
    switch (state) {
      case 'READY':
        return t('gov11.lookAhead.state.ready');
      case 'CONSTRAINED':
        return t('gov11.lookAhead.state.constrained');
      case 'NOT_READY':
        return t('gov11.lookAhead.state.notReady');
      case 'DONE':
        return t('gov11.lookAhead.state.done');
      default:
        return t('gov11.lookAhead.state.notDone');
    }
  };
  const bandLabel = (band: string): string => (band === 'ON_TARGET' ? t('gov11.lookAhead.band.onTarget') : band === 'BELOW_TARGET' ? t('gov11.lookAhead.band.below') : band === 'ALERT' ? t('gov11.lookAhead.band.alert') : t('gov11.lookAhead.band.noData'));
  const done = (what: string): void => setReceipt(what);
  const failure = [outcome, clear, publish].find((command) => command.isError);
  return (
    <div className="gov11-grid">
      {data.overdue === true && (
        <p className="callout" role="status" data-testid="overdue-note">
          {t('gov11.lookAhead.overdue')}
        </p>
      )}
      {receipt !== undefined && (
        <p className="callout" role="status" data-testid="receipt">
          {t('gov11.lookAhead.receipt', { what: receipt })}
        </p>
      )}
      {failure !== undefined && (
        <p role="alert" data-testid="command-error">
          {refusalCode(failure.error) === 'VERSION_CONFLICT' ? t('gov11.lookAhead.error.conflict') : refusalCode(failure.error) === 'LOOK_AHEAD_STATE_INVALID' ? t('gov11.lookAhead.error.state') : t('gov11.lookAhead.error.other')}
        </p>
      )}
      <div className="gov11-row">
        <Figure label={t('gov11.lookAhead.ppc')} value={ppc.pct === null ? '–' : `${text(ppc.pct)}%`} tone={BAND_TONE[text(ppc.band, 'NO_DATA')] ?? 'neutral'} sub={bandLabel(text(ppc.band, 'NO_DATA'))} rule={rule} fallbackFormula={t('gov11.lookAhead.ppc.formula')} owner={t('gov11.lookAhead.owner')} asOf={asOf} />
        <Figure label={t('gov11.lookAhead.window')} value={t('gov11.lookAhead.weeks', { weeks: text(plan.horizon_weeks) })} sub={`${dayLabel(plan.week_start)} – ${dayLabel(plan.window_end)}`} rule={rule} fallbackFormula={t('gov11.lookAhead.window.formula')} owner={t('gov11.lookAhead.owner')} asOf={asOf} />
        <Figure label={t('gov11.lookAhead.committed')} value={`${text(num(ppc.done))} / ${text(num(ppc.committed))}`} rule={rule} fallbackFormula={t('gov11.lookAhead.committed.formula')} owner={t('gov11.lookAhead.owner')} asOf={asOf} />
      </div>
      <div className="gov11-row">
        <StatusPill tone={plan.status === 'PUBLISHED' ? 'success' : 'neutral'}>{plan.status === 'PUBLISHED' ? t('gov11.lookAhead.published') : t('gov11.lookAhead.draft')}</StatusPill>
        {plan.status === 'DRAFT' && (
          <button
            type="button"
            className="ui-button ui-button--primary"
            disabled={publish.isPending}
            data-testid="publish"
            onClick={() => publish.mutate({ path: { id: text(plan.id) }, version: num(plan.version) }, { onSuccess: () => done(t('gov11.lookAhead.what.published')) })}
          >
            {publish.isPending ? t('gov11.common.sending') : t('gov11.lookAhead.publish')}
          </button>
        )}
      </div>
      <NewPlan data={data} projectId={projectId} onCreated={onCreated} onOpen={onOpen} first={false} />
      <div className="gov11-scroll">
        <table className="gov11-table" data-testid="items-table">
          <caption>{t('gov11.lookAhead.caption', { week: dayLabel(plan.week_start) })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('gov11.lookAhead.col.item')}</th>
              <th scope="col">{t('gov11.lookAhead.col.when')}</th>
              <th scope="col">{t('gov11.lookAhead.col.responsible')}</th>
              <th scope="col">{t('gov11.lookAhead.col.constraints')}</th>
              <th scope="col">{t('gov11.lookAhead.col.state')}</th>
              <th scope="col">{t('gov11.lookAhead.col.outcome')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const constraints = asList(item.constraints);
              const open = constraints.filter((constraint) => constraint.status === 'OPEN');
              const state = text(item.state);
              return (
                <tr key={text(item.id)} data-testid={`item-${text(item.sequence)}`}>
                  <th scope="row">{text(item.description)}</th>
                  <td>{`${dayLabel(item.planned_start)} – ${dayLabel(item.planned_finish)}`}</td>
                  <td>{text(item.responsible)}</td>
                  <td>
                    {constraints.length === 0 ? (
                      t('gov11.lookAhead.noConstraints')
                    ) : (
                      <ul>
                        {constraints.map((constraint) => (
                          <li key={text(constraint.id)}>
                            {`${text(constraint.kind)}: ${text(constraint.description)}`}
                            {constraint.status === 'OPEN' ? (
                              <button
                                type="button"
                                className="ui-button ui-button--outline"
                                disabled={clear.isPending}
                                data-testid={`clear-${text(constraint.id)}`}
                                onClick={() => clear.mutate({ path: { id: text(constraint.id) }, version: num(constraint.version) }, { onSuccess: () => done(t('gov11.lookAhead.what.cleared')) })}
                              >
                                {t('gov11.lookAhead.clear')}
                              </button>
                            ) : (
                              ` (${t('gov11.lookAhead.cleared')})`
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {open.length > 0 && <span className="gov11-open">{t('gov11.lookAhead.open', { count: open.length })}</span>}
                    {item.outcome === 'PLANNED' && mayWrite && raising !== text(item.id) && (
                      <button type="button" className="ui-button ui-button--outline" data-testid={`raise-${text(item.sequence)}`} onClick={() => setRaising(text(item.id))}>
                        {t('gov11.lookAhead.constraint.open')}
                      </button>
                    )}
                    {raising === text(item.id) && (
                      <ConstraintFormBox
                        itemId={text(item.id)}
                        itemStart={text(item.planned_start, '')}
                        rule={rule}
                        onCancel={() => setRaising(undefined)}
                        onDone={() => {
                          setRaising(undefined);
                          done(t('gov11.lookAhead.what.raised'));
                        }}
                      />
                    )}
                  </td>
                  <td>
                    <StatusPill tone={TONE[state] ?? 'neutral'}>{stateLabel(state)}</StatusPill>
                  </td>
                  <td>
                    {item.outcome !== 'PLANNED' ? (
                      item.outcome === 'NOT_DONE' ? (
                        t('gov11.lookAhead.notDoneBecause', { reason: text(item.variance_reason_code) })
                      ) : (
                        t('gov11.lookAhead.doneLine')
                      )
                    ) : plan.status !== 'PUBLISHED' ? (
                      '–'
                    ) : recording === text(item.id) ? (
                      <form
                        className="gov11-row"
                        onSubmit={(event: FormEvent) => {
                          event.preventDefault();
                          outcome.mutate({ path: { id: text(item.id) }, body: { outcome: 'NOT_DONE', reason_code: reason }, version: num(item.version) }, { onSuccess: () => { setRecording(undefined); done(t('gov11.lookAhead.what.recorded')); } });
                        }}
                      >
                        <label>
                          {t('gov11.lookAhead.reason')}
                          <select value={reason} onChange={(event) => setReason(event.target.value)} data-testid="reason">
                            {reasons.map((code) => (
                              <option key={code} value={code}>
                                {code}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button type="submit" className="ui-button ui-button--primary" disabled={outcome.isPending}>
                          {outcome.isPending ? t('gov11.common.sending') : t('gov11.lookAhead.recordNotDone')}
                        </button>
                        <button type="button" className="ui-button ui-button--outline" onClick={() => setRecording(undefined)}>
                          {t('gov11.common.cancel')}
                        </button>
                      </form>
                    ) : (
                      <div className="gov11-row">
                        <button type="button" className="ui-button ui-button--primary" disabled={outcome.isPending} data-testid={`done-${text(item.sequence)}`} onClick={() => outcome.mutate({ path: { id: text(item.id) }, body: { outcome: 'DONE' }, version: num(item.version) }, { onSuccess: () => done(t('gov11.lookAhead.what.recorded')) })}>
                          {t('gov11.lookAhead.recordDone')}
                        </button>
                        <button type="button" className="ui-button ui-button--outline" data-testid={`notdone-${text(item.sequence)}`} onClick={() => setRecording(text(item.id))}>
                          {t('gov11.lookAhead.recordNotDone')}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <section aria-labelledby="history-title" data-testid="history">
        <h2 id="history-title">{t('gov11.lookAhead.history')}</h2>
        <ul>
          {history.map((week) => {
            const weekPpc = asRecord(week.ppc);
            return (
              <li key={text(week.id)}>
                {t('gov11.lookAhead.historyLine', { week: dayLabel(week.week_start), pct: weekPpc.pct === null ? '–' : `${text(weekPpc.pct)}%`, band: bandLabel(text(weekPpc.band, 'NO_DATA')) })}
                {text(week.id) !== text(plan.id) && (
                  <button type="button" className="ui-button ui-button--outline ui-button--small" data-testid={`open-${text(week.id)}`} onClick={() => onOpen(text(week.id))}>
                    {t('gov11.lookAhead.history.open')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
