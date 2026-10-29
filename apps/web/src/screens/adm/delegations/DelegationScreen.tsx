import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../dgv/components';
import { CommandFrame } from '../../qms/CommandFrame';
import { useUnits } from '../members/hooks';
import { useCreateDelegation, useDelegates, useDelegations, useRevokeDelegation } from './hooks';
import { defectLabel, endReasonLabel, formProblemMessage, problemMessage, scopeKindLabel, statusLabel, statusTone } from './labels';
import { CREATE_PERMISSION, MAX_DAYS, READ_PERMISSION, REASON_MIN, SCOPE_KINDS, barShare, daysOf, describeProblem, emptyForm, formProblems, latestEnd, offeredPermissions, readDefects, toBody } from './model';
import type { DelegationView, Form, FormProblem } from './model';
import './delegations.css';

/**
 * ADM-04: the delegations of approval authority (ST-ADM-014, ADM 3.5). A leader delegates the business permissions they hold, over a unit or a unit and the ones below it, to another member for at most 90 days; the bar
 * beside the dates shows how much of the 90 days the window takes and the field refuses a later end. The tab "given" lists what the person delegated, "received" what was delegated to them; the delegator takes a delegation back
 * with a reason. What the delegator may pass on is judged by the server, which says why it refuses.
 */
export default function DelegationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <DelegationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function TimeBar({ from, until, label }: { from: string; until: string; label: string }) {
  const days = daysOf(from, until);
  return (
    <div className="delegation-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={MAX_DAYS} aria-valuenow={Math.min(days, MAX_DAYS)} data-days={days}>
      <div className="delegation-bar-fill" style={{ width: `${barShare(from, until) * 100}%` }} />
    </div>
  );
}

function DelegationContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [tab, setTab] = useState<'given' | 'received'>('given');
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<DelegationView | undefined>(undefined);
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const mayCreate = (permissions === undefined || permissions.includes(CREATE_PERMISSION)) && mode !== 'READ_ONLY';
  const delegations = useDelegations(tab, mayRead);
  const units = useUnits(mayRead);
  const queryState = useScreenState({ isLoading: delegations.isLoading, error: delegations.error, data: delegations.data });
  const state = mayRead ? queryState : 'denied';
  const list = delegations.data ?? [];
  const unitName = (id: string): string => units.data?.find((unit) => unit.id === id)?.name ?? id.slice(0, 8);
  const moment = (iso: string): string => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(iso));

  return (
    <section className="adm-delegation" data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.delegation.title')}</h1>
          <p>{t('adm.delegation.subtitle')}</p>
        </div>
        {mayCreate ? (
          <button type="button" className="primary" data-action="new" onClick={() => setCreating(true)}>
            {t('adm.delegation.new.action')}
          </button>
        ) : null}
      </div>
      <div className="card">
        <div role="tablist" aria-label={t('adm.delegation.tabs')}>
          <button type="button" role="tab" aria-selected={tab === 'given'} data-tab="given" onClick={() => setTab('given')}>
            {t('adm.delegation.tab.given')}
          </button>{' '}
          <button type="button" role="tab" aria-selected={tab === 'received'} data-tab="received" onClick={() => setTab('received')}>
            {t('adm.delegation.tab.received')}
          </button>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void delegations.refetch()}>
        <div className="card">
          <table className="table" data-testid="delegations">
            <thead>
              <tr>
                <th scope="col">{tab === 'given' ? t('adm.delegation.column.delegate') : t('adm.delegation.column.delegator')}</th>
                <th scope="col">{t('adm.delegation.column.permissions')}</th>
                <th scope="col">{t('adm.delegation.column.scope')}</th>
                <th scope="col">{t('adm.delegation.column.window')}</th>
                <th scope="col">{t('adm.delegation.column.reason')}</th>
                <th scope="col">{t('adm.delegation.column.status')}</th>
                <th scope="col">
                  <span className="sr-only">{t('adm.delegation.column.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id} data-delegation={row.id} data-status={row.status}>
                  <td>{tab === 'given' ? row.delegateName : row.delegatorName}</td>
                  <td>{row.permissions.join(', ')}</td>
                  <td>
                    {scopeKindLabel(t, row.scopeKind)}: {row.scopeRefIds.map(unitName).join(', ')}
                  </td>
                  <td>
                    {moment(row.validFrom)} – {moment(row.validUntil)}
                    <TimeBar from={row.validFrom} until={row.validUntil} label={t('adm.delegation.bar.label')} />
                  </td>
                  <td>{row.status === 'Revoked' && row.revokeReason !== null ? row.revokeReason : row.reason}</td>
                  <td>
                    <span className={`pill ${statusTone(row.status)}`} data-testid="status">
                      {statusLabel(t, row.status)}
                    </span>
                    {row.endReason === null ? null : <span className="sub"> {endReasonLabel(t, row.endReason)}</span>}
                  </td>
                  <td>
                    {row.mayRevoke && mode !== 'READ_ONLY' ? (
                      <button type="button" data-action="revoke" onClick={() => setRevoking(row)}>
                        {t('adm.delegation.revoke.action')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateBoundary>
      {creating ? <CreateDialog onClose={() => setCreating(false)} /> : null}
      {revoking === undefined ? null : <RevokeDialog delegation={revoking} onClose={() => setRevoking(undefined)} />}
    </section>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const create = useCreateDelegation();
  const members = useDelegates(true);
  const units = useUnits(true);
  const [now] = useState(() => new Date());
  const [form, setForm] = useState<Form>(() => emptyForm(now));
  const [submitted, setSubmitted] = useState(false);
  const problems = formProblems(form, new Date());
  const has = (problem: FormProblem): boolean => submitted && problems.includes(problem);
  const defects = create.isError ? readDefects(create.error) : [];
  const offered = offeredPermissions(permissions);
  const set = (patch: Partial<Form>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (create.isPending || problems.length > 0) return;
    create.mutate(toBody(form), { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('adm.delegation.new.title')}
      refusal={create.isError ? problemMessage(t, describeProblem(create.error)) : undefined}
      pending={create.isPending}
      submitLabel={t('adm.delegation.new.submit')}
      words={{ close: t('adm.delegation.dialog.close'), cancel: t('adm.delegation.dialog.cancel'), pending: t('adm.delegation.dialog.pending') }}
      onSubmit={send}
      onClose={onClose}
    >
      {members.isError || units.isError ? (
        <p className="callout warning" role="alert" data-testid="lookup-failed">
          {t('adm.delegation.form.lookupFailed')}
        </p>
      ) : null}
      {defects.length === 0 ? null : (
        <ul className="callout warning" role="alert" data-testid="defects">
          {defects.map((defect) => (
            <li key={`${defect.field}:${defect.code}`} data-field={defect.field}>
              <code>{defect.field}</code> {defectLabel(t, defect.code)}
            </li>
          ))}
        </ul>
      )}
      <fieldset disabled={create.isPending}>
        <Field id="delegation-delegate" label={t('adm.delegation.form.delegate')} error={has('delegateRequired') ? formProblemMessage(t, 'delegateRequired') : undefined}>
          <select id="delegation-delegate" value={form.delegateId} onChange={(event) => set({ delegateId: event.target.value })}>
            <option value="">{t('adm.delegation.form.choose')}</option>
            {(members.data ?? []).map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </Field>
        <fieldset>
          <legend>{t('adm.delegation.form.permissions')}</legend>
          {offered.map((permission) => (
            <label key={permission} className="delegation-permission">
              <input type="checkbox" value={permission} checked={form.permissions.includes(permission)} onChange={(event) => set({ permissions: event.target.checked ? [...form.permissions, permission] : form.permissions.filter((entry) => entry !== permission) })} /> {permission}
            </label>
          ))}
          {has('permissionsRequired') ? <p className="field-error">{formProblemMessage(t, 'permissionsRequired')}</p> : null}
          <p className="sub">{t('adm.delegation.form.permissions.note')}</p>
        </fieldset>
        <Field id="delegation-scope-kind" error={undefined} label={t('adm.delegation.form.scopeKind')}>
          <select id="delegation-scope-kind" value={form.scopeKind} onChange={(event) => set({ scopeKind: event.target.value as Form['scopeKind'] })}>
            {SCOPE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {scopeKindLabel(t, kind)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="delegation-unit" label={t('adm.delegation.form.unit')} error={has('unitRequired') ? formProblemMessage(t, 'unitRequired') : undefined}>
          <select id="delegation-unit" value={form.unitId} onChange={(event) => set({ unitId: event.target.value })}>
            <option value="">{t('adm.delegation.form.choose')}</option>
            {(units.data ?? []).map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="delegation-from" error={undefined} label={t('adm.delegation.form.from')}>
          <input id="delegation-from" type="datetime-local" value={form.validFrom} onChange={(event) => set({ validFrom: event.target.value })} />
        </Field>
        <Field id="delegation-until" label={t('adm.delegation.form.until')} error={has('datesInvalid') ? formProblemMessage(t, 'datesInvalid') : has('tooLong') ? formProblemMessage(t, 'tooLong') : has('inThePast') ? formProblemMessage(t, 'inThePast') : undefined}>
          <input id="delegation-until" type="datetime-local" value={form.validUntil} max={latestEnd(form.validFrom)} onChange={(event) => set({ validUntil: event.target.value })} />
        </Field>
        <TimeBar from={form.validFrom} until={form.validUntil} label={t('adm.delegation.bar.label')} />
        <p className="sub" data-testid="bar-note">
          {t('adm.delegation.bar.note', { days: daysOf(form.validFrom, form.validUntil), max: 90 })}
        </p>
        <Field id="delegation-reason" label={t('adm.delegation.form.reason')} error={has('reasonShort') ? formProblemMessage(t, 'reasonShort') : undefined}>
          <textarea id="delegation-reason" value={form.reason} maxLength={2000} onChange={(event) => set({ reason: event.target.value })} />
        </Field>
        <Field id="delegation-basis" error={undefined} label={t('adm.delegation.form.basis')}>
          <input id="delegation-basis" value={form.legalBasis} onChange={(event) => set({ legalBasis: event.target.value })} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}

function RevokeDialog({ delegation, onClose }: { delegation: DelegationView; onClose: () => void }) {
  const { t } = useTranslation();
  const revoke = useRevokeDelegation();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const tooShort = reason.trim().length < REASON_MIN;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (revoke.isPending || tooShort) return;
    revoke.mutate({ id: delegation.id, version: delegation.version, reason: reason.trim() }, { onSuccess: onClose });
  };
  return (
    <CommandFrame
      title={t('adm.delegation.revoke.title')}
      refusal={revoke.isError ? problemMessage(t, describeProblem(revoke.error)) : undefined}
      pending={revoke.isPending}
      submitLabel={t('adm.delegation.revoke.submit')}
      words={{ close: t('adm.delegation.dialog.close'), cancel: t('adm.delegation.dialog.cancel'), pending: t('adm.delegation.dialog.pending') }}
      onSubmit={send}
      onClose={onClose}
    >
      <fieldset disabled={revoke.isPending}>
        <p>{t('adm.delegation.revoke.text', { name: delegation.delegateName === '' ? t('adm.delegation.none') : delegation.delegateName })}</p>
        <Field id="revoke-reason" label={t('adm.delegation.revoke.reason')} error={submitted && tooShort ? t('adm.delegation.problem.reason') : undefined}>
          <textarea id="revoke-reason" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </fieldset>
    </CommandFrame>
  );
}
