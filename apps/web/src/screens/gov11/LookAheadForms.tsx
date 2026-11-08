import { ApiError } from '@machvon/api-client';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { Info, asRecord, dayLabel, refusalCode, text, useGovCommand } from './gov11-kit';
import type { RuleReading } from './gov11-kit';
import { MAX_ITEMS, blankRow, constraintBody, constraintProblems, dueAfterStart, limitsOf, noProblems, planBody, planProblems, rowsFromText, windowEndOf } from './lookahead-form';
import type { ConstraintError, ConstraintForm, ItemFieldError, ItemRow, LookAheadLimits, PlanFieldError, PlanForm } from './lookahead-form';

type ItemErrors = Partial<Record<'description' | 'plannedStart' | 'plannedFinish' | 'responsible', ItemFieldError>>;

const MEMBERS_OPERATION = 'get_resources_membership';

/** The members of the tenant a constraint can be given to, read only when the form is open; a member without a name is dropped. */
function useMembers(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Array<{ id: string; label: string }>>({
    queryKey: ['gov11', 'members', tenant?.id, tenant?.membershipId],
    queryFn: async () => {
      const rows = (await client.readAll(MEMBERS_OPERATION as 'get_resources_project')) as unknown[];
      return rows
        .map((row) => asRecord(row))
        .flatMap((row) => (typeof row.id === 'string' && typeof row.display_name === 'string' && row.display_name !== '' ? [{ id: row.id, label: row.display_name }] : []))
        .sort((a, b) => a.label.localeCompare(b.label, 'vi'));
    },
    enabled: enabled && tenant?.id !== undefined,
    retry: false,
    staleTime: 60_000,
  });
}

export interface PlanCreateFormProps {
  projectId: string;
  rule: RuleReading;
  /** The day the figures of the rule are read on, as the person reads it. */
  asOf: string;
  /** The weeks that already have a plan: a second plan for the same week is refused by the server and said here first. */
  existingWeeks: readonly string[];
  /** The Monday the form starts on. */
  defaultWeekStart: string;
  onDone: (planId: string) => void;
  /** Opens the plan the server says already covers the week. */
  onOpenPlan: (planId: string) => void;
  onCancel: () => void;
}

/**
 * The form that creates the draft look-ahead plan of a project (G1-19): the Monday it starts on, the number of weeks within the rule, and the items of work with the days they start and finish and who does them. It is checked here
 * with the rules of the server and sent once; a refusal keeps what was typed. The draft is published in a separate step, so what is sent can be read again before it counts.
 */
export function PlanCreateForm({ projectId, rule, asOf, existingWeeks, defaultWeekStart, onDone, onOpenPlan, onCancel }: PlanCreateFormProps) {
  const { t } = useTranslation();
  const limits: LookAheadLimits = limitsOf(rule.params);
  const create = useGovCommand('createLookAheadPlan');
  const keys = useRef(2);
  const [form, setForm] = useState<PlanForm>({ weekStart: defaultWeekStart, horizonWeeks: String(limits.defaultWeeks), items: [blankRow(1, defaultWeekStart)] });
  const [pasted, setPasted] = useState('');
  const [tried, setTried] = useState(false);
  const problems = planProblems(form, limits);
  const exists = existingWeeks.includes(form.weekStart);
  const weeks = Number(form.horizonWeeks);
  const windowShown = problems.plan.weekStart === undefined && problems.plan.horizon === undefined && form.weekStart !== '' ? `${dayLabel(form.weekStart)} – ${dayLabel(windowEndOf(form.weekStart, weeks))}` : '–';
  const planError = (code: PlanFieldError | undefined): string | undefined => {
    switch (code) {
      case 'weekStartInvalid':
        return t('gov11.lookAhead.form.error.weekInvalid');
      case 'weekStartNotMonday':
        return t('gov11.lookAhead.form.error.weekMonday');
      case 'horizonOutside':
        return t('gov11.lookAhead.form.error.horizon', { min: limits.minWeeks, max: limits.maxWeeks });
      case 'itemsNone':
        return t('gov11.lookAhead.form.error.itemsNone');
      case 'itemsTooMany':
        return t('gov11.lookAhead.form.error.itemsMany', { max: MAX_ITEMS });
      default:
        return undefined;
    }
  };
  const itemError = (code: ItemFieldError | undefined): string | undefined => {
    switch (code) {
      case 'descriptionShort':
        return t('gov11.lookAhead.form.error.descShort');
      case 'descriptionLong':
        return t('gov11.lookAhead.form.error.descLong');
      case 'startInvalid':
        return t('gov11.lookAhead.form.error.startInvalid');
      case 'finishInvalid':
        return t('gov11.lookAhead.form.error.finishInvalid');
      case 'finishBeforeStart':
        return t('gov11.lookAhead.form.error.finishBefore');
      case 'startOutsideWindow':
        return t('gov11.lookAhead.form.error.startOutside');
      case 'responsibleLong':
        return t('gov11.lookAhead.form.error.responsibleLong');
      default:
        return undefined;
    }
  };
  const setRow = (key: number, change: Partial<ItemRow>): void => setForm((current) => ({ ...current, items: current.items.map((row) => (row.key === key ? { ...row, ...change } : row)) }));
  const addRows = (rows: ItemRow[]): void => setForm((current) => ({ ...current, items: [...current.items, ...rows] }));
  const nextKey = (): number => keys.current++;
  const refusal = refusalCode(create.error);
  const existingPlan = create.error instanceof ApiError && typeof create.error.extensions.plan_id === 'string' ? create.error.extensions.plan_id : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTried(true);
    if (!noProblems(problems) || exists) return;
    create.mutate({ path: { id: projectId }, body: planBody(form) }, { onSuccess: (result) => onDone(text(asRecord(result).resource_id, '')) });
  };
  const shown = (code: PlanFieldError | undefined): string | undefined => (tried ? planError(code) : undefined);
  return (
    <form className="gov11-form gov11-lookahead-form" onSubmit={submit} noValidate aria-labelledby="lookahead-form-title" data-testid="plan-form">
      <h2 id="lookahead-form-title">{t('gov11.lookAhead.form.title')}</h2>
      <p>{t('gov11.lookAhead.form.maker')}</p>
      {rule.unverified && <p className="callout">{t('gov11.lookAhead.form.unverified', { min: limits.minWeeks, max: limits.maxWeeks })}</p>}
      <div className="gov11-row">
        <label>
          {t('gov11.lookAhead.form.weekStart')}
          <input type="date" value={form.weekStart} onChange={(event) => setForm({ ...form, weekStart: event.target.value })} data-testid="week-start" aria-invalid={shown(problems.plan.weekStart) !== undefined || (tried && exists)} aria-describedby="week-start-error" />
        </label>
        <label>
          {t('gov11.lookAhead.form.horizon')}
          <select value={form.horizonWeeks} onChange={(event) => setForm({ ...form, horizonWeeks: event.target.value })} data-testid="horizon" aria-invalid={shown(problems.plan.horizon) !== undefined}>
            {Array.from({ length: limits.maxWeeks - limits.minWeeks + 1 }, (_, index) => limits.minWeeks + index).map((count) => (
              <option key={count} value={String(count)}>
                {t('gov11.lookAhead.weeks', { weeks: count })}
              </option>
            ))}
          </select>
        </label>
        <Info name={t('gov11.lookAhead.window')} rule={rule} fallbackFormula={t('gov11.lookAhead.window.formula')} owner={t('gov11.lookAhead.owner')} asOf={asOf} />
      </div>
      <p id="week-start-error" role={tried ? 'alert' : undefined} data-testid="week-error">
        {shown(problems.plan.weekStart) ?? shown(problems.plan.horizon) ?? (exists ? t('gov11.lookAhead.form.error.weekExists', { week: dayLabel(form.weekStart) }) : undefined)}
      </p>
      <p data-testid="window-preview">{t('gov11.lookAhead.form.preview', { window: windowShown, count: form.items.length })}</p>
      <div className="gov11-scroll">
        <table className="gov11-table" data-testid="item-rows">
          <caption>{t('gov11.lookAhead.form.items')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('gov11.lookAhead.col.item')}</th>
              <th scope="col">{t('gov11.lookAhead.form.start')}</th>
              <th scope="col">{t('gov11.lookAhead.form.finish')}</th>
              <th scope="col">{t('gov11.lookAhead.col.responsible')}</th>
              <th scope="col">
                <span className="ui-sr-only">{t('gov11.lookAhead.form.remove')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {form.items.map((row, index) => {
              const found: ItemErrors = tried ? (problems.items.get(row.key) ?? {}) : {};
              const label = (what: string): string => t('gov11.lookAhead.form.rowLabel', { n: index + 1, what });
              return (
                <tr key={row.key} data-testid={`row-${index + 1}`}>
                  <td>
                    <input value={row.description} maxLength={600} onChange={(event) => setRow(row.key, { description: event.target.value })} aria-label={label(t('gov11.lookAhead.col.item'))} aria-invalid={found.description !== undefined} data-testid={`desc-${index + 1}`} />
                    {found.description !== undefined && <span role="alert">{itemError(found.description)}</span>}
                  </td>
                  <td>
                    <input type="date" value={row.plannedStart} onChange={(event) => setRow(row.key, { plannedStart: event.target.value })} aria-label={label(t('gov11.lookAhead.form.start'))} aria-invalid={found.plannedStart !== undefined} data-testid={`start-${index + 1}`} />
                    {found.plannedStart !== undefined && <span role="alert">{itemError(found.plannedStart)}</span>}
                  </td>
                  <td>
                    <input type="date" value={row.plannedFinish} onChange={(event) => setRow(row.key, { plannedFinish: event.target.value })} aria-label={label(t('gov11.lookAhead.form.finish'))} aria-invalid={found.plannedFinish !== undefined} data-testid={`finish-${index + 1}`} />
                    {found.plannedFinish !== undefined && <span role="alert">{itemError(found.plannedFinish)}</span>}
                  </td>
                  <td>
                    <input value={row.responsible} onChange={(event) => setRow(row.key, { responsible: event.target.value })} aria-label={label(t('gov11.lookAhead.col.responsible'))} aria-invalid={found.responsible !== undefined} data-testid={`resp-${index + 1}`} />
                    {found.responsible !== undefined && <span role="alert">{itemError(found.responsible)}</span>}
                  </td>
                  <td>
                    <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setForm({ ...form, items: form.items.filter((one) => one.key !== row.key) })} data-testid={`remove-${index + 1}`} aria-label={label(t('gov11.lookAhead.form.remove'))}>
                      {t('gov11.lookAhead.form.remove')}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {shown(problems.plan.items) !== undefined && (
        <p role="alert" data-testid="items-error">
          {shown(problems.plan.items)}
        </p>
      )}
      <div className="gov11-row">
        <button type="button" className="ui-button ui-button--outline" onClick={() => addRows([blankRow(nextKey(), form.weekStart)])} disabled={form.items.length >= MAX_ITEMS} data-testid="add-row">
          {t('gov11.lookAhead.form.addRow')}
        </button>
      </div>
      <details>
        <summary>{t('gov11.lookAhead.form.paste')}</summary>
        <label>
          {t('gov11.lookAhead.form.pasteHelp')}
          <textarea rows={4} value={pasted} onChange={(event) => setPasted(event.target.value)} data-testid="paste-box" />
        </label>
        <button
          type="button"
          className="ui-button ui-button--outline"
          disabled={pasted.trim() === ''}
          data-testid="paste-add"
          onClick={() => {
            const rows = rowsFromText(pasted, keys.current);
            keys.current += rows.length;
            addRows(rows);
            setPasted('');
          }}
        >
          {t('gov11.lookAhead.form.pasteAdd')}
        </button>
      </details>
      {tried && !noProblems(problems) && (
        <p role="alert" data-testid="form-summary">
          {t('gov11.lookAhead.form.summary', { count: problems.items.size + Object.keys(problems.plan).length })}
        </p>
      )}
      {create.isError && (
        <p role="alert" data-testid="create-error">
          {refusal === 'LOOK_AHEAD_PLAN_EXISTS' ? t('gov11.lookAhead.form.refused.exists') : refusal === 'LOOK_AHEAD_WINDOW_INVALID' ? t('gov11.lookAhead.form.refused.window') : refusal === 'VALIDATION_FAILED' ? t('gov11.lookAhead.form.refused.validation') : refusal === 'SCOPE_DENIED' ? t('gov11.lookAhead.form.refused.scope') : t('gov11.lookAhead.error.other')}
        </p>
      )}
      {refusal === 'LOOK_AHEAD_PLAN_EXISTS' && existingPlan !== undefined && (
        <button type="button" className="ui-button ui-button--outline" onClick={() => onOpenPlan(existingPlan)} data-testid="open-existing">
          {t('gov11.lookAhead.form.refused.openExisting')}
        </button>
      )}
      <div className="gov11-row">
        <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending} data-testid="create-plan">
          {create.isPending ? t('gov11.common.sending') : t('gov11.lookAhead.form.create')}
        </button>
        <button type="button" className="ui-button ui-button--outline" onClick={onCancel} data-testid="cancel-plan">
          {t('gov11.common.cancel')}
        </button>
      </div>
    </form>
  );
}

export interface ConstraintFormProps {
  itemId: string;
  itemStart: string;
  rule: RuleReading;
  onDone: () => void;
  onCancel: () => void;
}

/** The form that raises a constraint on an item of work that is not recorded yet: the kind of the rule, what has to be ready, who clears it and by when. */
export function ConstraintFormBox({ itemId, itemStart, rule, onDone, onCancel }: ConstraintFormProps) {
  const { t } = useTranslation();
  const limits = limitsOf(rule.params);
  const raise = useGovCommand('raiseLookAheadConstraint');
  const members = useMembers(true);
  const [form, setForm] = useState<ConstraintForm>({ kind: limits.constraintKinds[0] ?? 'OTHER', description: '', ownerMembershipId: '', dueOn: '' });
  const [tried, setTried] = useState(false);
  const found = constraintProblems(form, limits);
  const message = (code: ConstraintError | undefined): string | undefined => {
    switch (code) {
      case 'kindInvalid':
        return t('gov11.lookAhead.constraint.error.kind');
      case 'descriptionShort':
        return t('gov11.lookAhead.constraint.error.descShort');
      case 'descriptionLong':
        return t('gov11.lookAhead.constraint.error.descLong');
      case 'dueInvalid':
        return t('gov11.lookAhead.constraint.error.due');
      default:
        return undefined;
    }
  };
  const refusal = refusalCode(raise.error);
  return (
    <form
      className="gov11-form"
      noValidate
      data-testid="constraint-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        setTried(true);
        if (Object.keys(found).length > 0) return;
        raise.mutate({ path: { id: itemId }, body: constraintBody(form) }, { onSuccess: onDone });
      }}
    >
      <label>
        {t('gov11.lookAhead.constraint.kind')}
        <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })} data-testid="constraint-kind">
          {limits.constraintKinds.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('gov11.lookAhead.constraint.description')}
        <input value={form.description} maxLength={600} onChange={(event) => setForm({ ...form, description: event.target.value })} aria-invalid={tried && found.description !== undefined} data-testid="constraint-description" />
      </label>
      {tried && found.description !== undefined && <p role="alert">{message(found.description)}</p>}
      <label>
        {t('gov11.lookAhead.constraint.owner')}
        <select value={form.ownerMembershipId} onChange={(event) => setForm({ ...form, ownerMembershipId: event.target.value })} disabled={members.isLoading} data-testid="constraint-owner">
          <option value="">{members.isLoading ? t('gov11.lookAhead.constraint.owner.loading') : t('gov11.lookAhead.constraint.owner.none')}</option>
          {(members.data ?? []).map((member) => (
            <option key={member.id} value={member.id}>
              {member.label}
            </option>
          ))}
        </select>
      </label>
      {members.isError && (
        <p role="status" data-testid="members-error">
          {t('gov11.lookAhead.constraint.owner.error')}{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void members.refetch()}>
            {t('gov11.common.retry')}
          </button>
        </p>
      )}
      <label>
        {t('gov11.lookAhead.constraint.due')}
        <input type="date" value={form.dueOn} onChange={(event) => setForm({ ...form, dueOn: event.target.value })} aria-invalid={tried && found.dueOn !== undefined} data-testid="constraint-due" />
      </label>
      {tried && found.dueOn !== undefined && <p role="alert">{message(found.dueOn)}</p>}
      {found.dueOn === undefined && form.dueOn !== '' && dueAfterStart(form.dueOn, itemStart) && (
        <p role="status" data-testid="due-late">
          {t('gov11.lookAhead.constraint.dueLate', { start: dayLabel(itemStart) })}
        </p>
      )}
      {raise.isError && (
        <p role="alert" data-testid="raise-error">
          {refusal === 'LOOK_AHEAD_STATE_INVALID' ? t('gov11.lookAhead.error.state') : refusal === 'VALIDATION_FAILED' ? t('gov11.lookAhead.form.refused.validation') : t('gov11.lookAhead.error.other')}
        </p>
      )}
      <div className="gov11-row">
        <button type="submit" className="ui-button ui-button--primary" disabled={raise.isPending} data-testid="raise-constraint">
          {raise.isPending ? t('gov11.common.sending') : t('gov11.lookAhead.constraint.raise')}
        </button>
        <button type="button" className="ui-button ui-button--outline" onClick={onCancel}>
          {t('gov11.common.cancel')}
        </button>
      </div>
    </form>
  );
}
