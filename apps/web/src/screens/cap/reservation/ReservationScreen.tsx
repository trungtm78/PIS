import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { Translator } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../prj/components';
import '../../prj/prj.css';
import { formatVnd } from '../ledger/model';
import { useCreateReservation, useReleaseReservation, useReservations } from './hooks';
import { EMPTY_CREATE, MANAGE_PERMISSION, PURPOSES, STATUSES, countdownOf, createBody, describeCreate, describeRelease, holds, validReason, validateCreate } from './model';
import type { CreateField, CreateForm, CreateProblem, FormProblem, Purpose, ReleaseProblem, ReservationView, Status } from './model';

type T = Translator['t'];
const NONE = '—';

function purposeText(t: T, purpose: Purpose): string {
  switch (purpose) {
    case 'CONTRACT_PENDING':
      return t('cap.reservation.purpose.contract');
    case 'ADVANCE_PENDING':
      return t('cap.reservation.purpose.advance');
    case 'LAND_CLEARANCE':
      return t('cap.reservation.purpose.land');
    case 'OTHER':
      return t('cap.reservation.purpose.other');
  }
}

function statusText(t: T, status: Status): string {
  switch (status) {
    case 'ACTIVE':
      return t('cap.reservation.status.active');
    case 'CONSUMED':
      return t('cap.reservation.status.consumed');
    case 'RELEASED':
      return t('cap.reservation.status.released');
    case 'EXPIRED':
      return t('cap.reservation.status.expired');
  }
}

function createProblemText(t: T, problem: CreateProblem, figures: { consumption: string | undefined; warn: string | undefined; block: string | undefined }): string {
  const pct = { consumption: figures.consumption ?? NONE, warn: figures.warn ?? NONE, block: figures.block ?? NONE };
  switch (problem) {
    case 'warn':
      return t('cap.reservation.problem.warn', pct);
    case 'blocked':
      return t('cap.reservation.problem.blocked', pct);
    case 'yearLocked':
      return t('cap.reservation.problem.yearLocked');
    case 'scopeDenied':
      return t('cap.reservation.problem.scopeDenied');
    case 'notFound':
      return t('cap.reservation.problem.notFound');
    case 'validation':
      return t('cap.reservation.problem.validation');
    case 'general':
      return t('cap.reservation.problem.general');
  }
}

function releaseProblemText(t: T, problem: ReleaseProblem): string {
  switch (problem) {
    case 'notActive':
      return t('cap.reservation.release.problem.notActive');
    case 'stale':
      return t('cap.reservation.release.problem.stale');
    case 'scopeDenied':
      return t('cap.reservation.release.problem.scopeDenied');
    case 'notFound':
      return t('cap.reservation.release.problem.notFound');
    case 'validation':
      return t('cap.reservation.release.problem.validation');
    case 'general':
      return t('cap.reservation.release.problem.general');
  }
}

const fieldText = (t: T, problem: FormProblem | undefined): string | undefined =>
  problem === undefined ? undefined : problem === 'required' ? t('cap.reservation.field.required.error') : t('cap.reservation.field.invalid.error');

/**
 * CAP-18: the earmark of capital (ST-CAP-011, CAP 3.1 F4, BR-CAP-06). An investor reserves part of a line for a purpose until a day; the list shows each reservation with its amount, what is left of its time (days, then hours, then
 * over) and its status in words. A reservation that would take the line to the warning threshold is refused until the investor accepts the warning, and one that would take it above the block threshold is refused whatever they accept.
 * An active reservation is released with a reason; the job returns the capital of the ones that run out. The server judges every command again.
 */
export default function ReservationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list and the forms belong to one membership: a switch of tenant or person starts the screen over.
  return <ReservationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ReservationContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [status, setStatus] = useState<Status | ''>('');
  const list = useReservations(status);
  const items = (list.data?.pages ?? []).flatMap((page) => page.items);
  const state = useScreenState({ isLoading: list.isLoading, error: list.error, data: list.data === undefined ? undefined : items, isEmpty: () => items.length === 0 });
  const manage = holds(permissions, MANAGE_PERMISSION, mode);
  const money = (amount: string): string => t('cap.reservation.value.amount', { amount: formatVnd(amount, locale) });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.reservation.page.title')}</h1>
          <p>{t('cap.reservation.page.subtitle')}</p>
        </div>
      </div>
      {manage ? <CreatePanel /> : null}
      <div className="prj-filters">
        <label htmlFor="reservation-status">{t('cap.reservation.filter.status.label')}</label>
        <select id="reservation-status" value={status} onChange={(event) => setStatus(event.target.value as Status | '')}>
          <option value="">{NONE}</option>
          {STATUSES.map((known) => (
            <option key={known} value={known}>
              {statusText(t, known)}
            </option>
          ))}
        </select>
      </div>
      <StateBoundary state={state} onRetry={() => void list.refetch()}>
        <div className="tablewrap">
          <table className="table" aria-label={t('cap.reservation.list.aria')} data-testid="reservations">
            <thead>
              <tr>
                <th scope="col">{t('cap.reservation.col.project')}</th>
                <th scope="col">{t('cap.reservation.col.purpose')}</th>
                <th scope="col">{t('cap.reservation.col.amount')}</th>
                <th scope="col">{t('cap.reservation.col.expires')}</th>
                <th scope="col">{t('cap.reservation.col.status')}</th>
                <th scope="col">
                  <span className="sr-only">{t('cap.reservation.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <ReservationRow key={item.id} item={item} manage={manage} money={money} />
              ))}
            </tbody>
          </table>
        </div>
        {list.hasNextPage ? (
          <p>
            <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('cap.reservation.more.action')}
            </button>
          </p>
        ) : null}
      </StateBoundary>
      <p className="prototype-note">{t('cap.reservation.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function ReservationRow({ item, manage, money }: { item: ReservationView; manage: boolean; money(amount: string): string }) {
  const { t } = useTranslation();
  const [releasing, setReleasing] = useState(false);
  const left = countdownOf(item.expiresAt);
  return (
    <>
      <tr data-reservation={item.id} data-status={item.status}>
        <td>
          {item.project === null ? NONE : `${item.project.code} ${item.project.name}`}
          <span className="prj-code">{t('cap.reservation.row.year', { year: item.planYear })}</span>
        </td>
        <td>{purposeText(t, item.purpose)}</td>
        <td>{money(item.amountVnd)}</td>
        <td>
          {item.expiresAt}
          {item.status !== 'ACTIVE' ? null : (
            <span className="prj-code" data-testid="countdown">
              {left.kind === 'days' ? t('cap.reservation.countdown.days', { count: left.count }) : left.kind === 'hours' ? t('cap.reservation.countdown.hours', { count: left.count }) : t('cap.reservation.countdown.over')}
            </span>
          )}
        </td>
        <td>
          <span className={`pill ${item.status === 'ACTIVE' ? 'green' : 'gray'}`}>{statusText(t, item.status)}</span>
          {item.releaseReason === null ? null : <span className="prj-code">{item.releaseReason}</span>}
        </td>
        <td>
          {manage && item.status === 'ACTIVE' ? (
            <button type="button" aria-pressed={releasing} onClick={() => setReleasing(!releasing)}>
              {t('cap.reservation.release.action')}
            </button>
          ) : null}
        </td>
      </tr>
      {releasing ? (
        <tr data-release-of={item.id}>
          <td colSpan={6}>
            <ReleasePanel item={item} onDone={() => setReleasing(false)} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ReleasePanel({ item, onDone }: { item: ReservationView; onDone(): void }) {
  const { t } = useTranslation();
  const send = useReleaseReservation();
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const refusal = send.isError ? describeRelease(send.error) : undefined;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const ok = validReason(reason);
    setInvalid(!ok);
    if (!ok || send.isPending) return;
    send.mutate({ id: item.id, version: item.version, reason }, { onSuccess: onDone });
  };
  return (
    <form onSubmit={submit} noValidate aria-label={t('cap.reservation.release.title')}>
      <h3>{t('cap.reservation.release.title')}</h3>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="release-refusal">
          {releaseProblemText(t, refusal)}
        </p>
      )}
      <Field id={`release-reason-${item.id}`} label={t('cap.reservation.release.reason.label')} error={invalid ? t('cap.reservation.release.reason.error') : undefined} hint={t('cap.reservation.release.reason.hint')}>
        <textarea id={`release-reason-${item.id}`} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('cap.reservation.release.submit.action')}
        </button>
        <button type="button" onClick={onDone}>
          {t('cap.reservation.cancel.action')}
        </button>
      </div>
    </form>
  );
}

function CreatePanel() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const send = useCreateReservation();
  const [form, setForm] = useState<CreateForm>(() => ({ ...EMPTY_CREATE, lineId: params.get('line') ?? '' }));
  const [problems, setProblems] = useState<Partial<Record<CreateField, FormProblem>>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [saved, setSaved] = useState(false);
  const refusal = send.isError ? describeCreate(send.error) : undefined;
  // A change of the form is a new request: what was accepted for the old one is not accepted for it.
  const set = (patch: Partial<CreateForm>): void => {
    setForm((value) => ({ ...value, ...patch }));
    setAcknowledged(false);
    setSaved(false);
    send.reset();
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateCreate(form);
    setProblems(found);
    if (Object.keys(found).length > 0 || send.isPending) return;
    send.mutate(createBody(form, acknowledged), {
      onSuccess: () => {
        setForm({ ...EMPTY_CREATE, lineId: form.lineId });
        setAcknowledged(false);
        setSaved(true);
      },
    });
  };
  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('cap.reservation.form.title')}>
      <h2>{t('cap.reservation.form.title')}</h2>
      {refusal === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="create-refusal">
          {createProblemText(t, refusal.problem, { consumption: refusal.consumptionPct, warn: refusal.warnPct, block: refusal.blockPct })}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="create-saved">
          {t('cap.reservation.form.saved')}
        </p>
      ) : null}
      <fieldset disabled={send.isPending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <Field id="reservation-line" label={t('cap.reservation.field.line.label')} error={fieldText(t, problems.lineId)} hint={t('cap.reservation.field.line.hint')}>
        <input id="reservation-line" type="text" value={form.lineId} onChange={(event) => set({ lineId: event.target.value })} />
      </Field>
      <Field id="reservation-amount" label={t('cap.reservation.field.amount.label')} error={fieldText(t, problems.amount)} hint={t('cap.reservation.field.amount.hint')}>
        <input id="reservation-amount" type="text" inputMode="numeric" value={form.amount} onChange={(event) => set({ amount: event.target.value })} />
      </Field>
      <Field id="reservation-purpose" label={t('cap.reservation.field.purpose.label')} error={undefined}>
        <select id="reservation-purpose" value={form.purpose} onChange={(event) => set({ purpose: event.target.value as Purpose })}>
          {PURPOSES.map((known) => (
            <option key={known} value={known}>
              {purposeText(t, known)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="reservation-expires" label={t('cap.reservation.field.expires.label')} error={fieldText(t, problems.expiresOn)} hint={t('cap.reservation.field.expires.hint')}>
        <input id="reservation-expires" type="date" value={form.expiresOn} onChange={(event) => set({ expiresOn: event.target.value })} />
      </Field>
      <Field id="reservation-reference-kind" label={t('cap.reservation.field.referenceKind.label')} error={fieldText(t, problems.referenceKind)} hint={t('cap.reservation.field.reference.hint')}>
        <input id="reservation-reference-kind" type="text" value={form.referenceKind} onChange={(event) => set({ referenceKind: event.target.value })} />
      </Field>
      <Field id="reservation-reference-id" label={t('cap.reservation.field.referenceId.label')} error={fieldText(t, problems.referenceId)}>
        <input id="reservation-reference-id" type="text" value={form.referenceId} onChange={(event) => set({ referenceId: event.target.value })} />
      </Field>
      </fieldset>
      {refusal?.problem === 'warn' ? (
        <label className="check" htmlFor="reservation-ack">
          <input id="reservation-ack" type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          {t('cap.reservation.field.ack.label')}
        </label>
      ) : null}
      <div className="formfooter">
        <button type="submit" className="primary" disabled={send.isPending}>
          {t('cap.reservation.form.submit.action')}
        </button>
      </div>
    </form>
  );
}
