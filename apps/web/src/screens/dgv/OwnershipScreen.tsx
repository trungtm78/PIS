import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from './components';
import { NO_FILTER, useAssignOwnership, useCatalog, useMembers, useRegisterDataset } from './hooks';
import { classificationLabel, fieldProblemMessage, freshnessLabel, problemMessage, statusLabel } from './labels';
import { CATALOG_MANAGE_PERMISSION, CLASSIFICATION_LIST, EMPTY_REGISTER_FORM, MEMBER_READ_PERMISSION, describeProblem, registerBody, validateOwnership, validateRegister } from './model';
import type { Classification, DatasetView, FormErrors, MemberOption, OwnershipField, OwnershipForm, RegisterField, RegisterForm } from './model';

const NEVER_EMPTY = (): boolean => false;

/**
 * DGV-03: who owns and who stewards each dataset. A critical dataset has an owner who is not its steward; a registration starts a dataset
 * in DRAFT and a change of the pair is made for a stated reason against the version that was read (ST-DGV-001, DGV 3.1 F1).
 */
export default function OwnershipScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The filters, the forms and the open panels belong to one tenant: a switch starts the screen over.
  return <OwnershipContent key={tenantId ?? 'none'} route={route} />;
}

function OwnershipContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const mayManage = holds(CATALOG_MANAGE_PERMISSION) && mode !== 'READ_ONLY';
  const datasets = useCatalog(NO_FILTER);
  const members = useMembers(mayManage && holds(MEMBER_READ_PERMISSION));
  const state = useScreenState({ isLoading: datasets.isLoading, error: datasets.error, data: datasets.data, isEmpty: NEVER_EMPTY });
  const [domain, setDomain] = useState('');
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const all = datasets.data ?? [];
  const domains = [...new Set(all.map((row) => row.domain))].sort();
  const rows = all.filter((row) => domain === '' || row.domain === domain);
  const people = members.data ?? [];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.owners.page.title')}</h1>
          <p>{t('dgv.owners.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void datasets.refetch()}>
        <div className="card">
          <div className="dgv-filters">
            <Field id="owners-domain" label={t('dgv.owners.filter.domain.label')} error={undefined}>
              <select id="owners-domain" value={domain} onChange={(event) => setDomain(event.target.value)}>
                <option value="">{t('dgv.owners.filter.all.option')}</option>
                {domains.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {rows.length === 0 ? (
            <p className="muted" data-testid="empty-owners">
              {domain === '' ? t('dgv.owners.empty.text') : t('dgv.owners.noMatch.text')}
            </p>
          ) : (
            <table className="table" aria-label={t('dgv.owners.table.aria')}>
              <thead>
                <tr>
                  <th>{t('dgv.owners.domain.column')}</th>
                  <th>{t('dgv.owners.dataset.column')}</th>
                  <th>{t('dgv.owners.owner.column')}</th>
                  <th>{t('dgv.owners.steward.column')}</th>
                  <th>{t('dgv.owners.sla.column')}</th>
                  <th>{t('dgv.owners.critical.column')}</th>
                  <th>{t('dgv.owners.status.column')}</th>
                  <th>
                    <span className="sr-only">{t('dgv.owners.actions.column')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <DatasetRow key={row.id} row={row} mayChange={mayManage && row.status !== 'RETIRED'} open={editing === row.id} onToggle={() => setEditing(editing === row.id ? undefined : row.id)} people={people} />
                ))}
              </tbody>
            </table>
          )}
          <p className="sub" data-testid="count">
            {t('dgv.owners.count.text', { count: rows.length })}
          </p>
        </div>
        {mayManage ? <RegisterDataset people={people} membersFailed={members.isError} membersReadable={holds(MEMBER_READ_PERMISSION)} /> : null}
      </StateBoundary>
      <p className="prototype-note">{t('dgv.owners.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function DatasetRow({ row, mayChange, open, onToggle, people }: { row: DatasetView; mayChange: boolean; open: boolean; onToggle: () => void; people: MemberOption[] }) {
  const { t } = useTranslation();
  return (
    <>
      <tr data-dataset-id={row.id} data-dataset-code={row.datasetCode} data-critical={row.isCritical}>
        <td>{row.domain}</td>
        <td>
          {row.title}
          <code className="dgv-code">{row.datasetCode}</code>
          <span className="sub">{classificationLabel(t, row.classification)}</span>
        </td>
        <td>{row.ownerName ?? t('dgv.owners.person.unknown')}</td>
        <td>{row.stewardName ?? t('dgv.owners.person.unknown')}</td>
        <td>{freshnessLabel(t, row.freshnessSloSeconds)}</td>
        <td>
          <span className={row.isCritical ? 'pill warn' : 'pill gray'}>{row.isCritical ? t('dgv.owners.critical.yes') : t('dgv.owners.critical.no')}</span>
        </td>
        <td>{statusLabel(t, row.status)}</td>
        <td className="row-actions">
          {mayChange ? (
            <button type="button" onClick={onToggle} aria-expanded={open}>
              {t('dgv.owners.change.action')}
            </button>
          ) : null}
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={8}>
            <ChangeOwnership row={row} people={people} onDone={onToggle} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function MemberSelect({ id, label, value, people, error, onChange }: { id: string; label: string; value: string; people: MemberOption[]; error: string | undefined; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <Field id={id} label={label} error={error}>
      <select id={id} value={value} aria-invalid={error !== undefined} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('dgv.owners.member.placeholder')}</option>
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function ChangeOwnership({ row, people, onDone }: { row: DatasetView; people: MemberOption[]; onDone: () => void }) {
  const { t } = useTranslation();
  const assign = useAssignOwnership();
  const [form, setForm] = useState<OwnershipForm>({ ownerId: row.ownerId, stewardId: row.stewardId, reason: '' });
  const [errors, setErrors] = useState<FormErrors<OwnershipField>>({});
  const refused = assign.isError ? describeProblem(assign.error) : undefined;
  const error = (field: OwnershipField): string | undefined => {
    const own = errors[field];
    return own === undefined ? undefined : fieldProblemMessage(t, own);
  };
  const setField = (field: OwnershipField, value: string): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
  };

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (assign.isPending) return;
    const found = validateOwnership(form, row.isCritical);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    assign.mutate({ id: row.id, version: row.version, ownerId: form.ownerId, stewardId: form.stewardId, reason: form.reason.trim() }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={send} noValidate aria-label={t('dgv.owners.change.title', { code: row.datasetCode })}>
      <h3>{t('dgv.owners.change.title', { code: row.datasetCode })}</h3>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {problemMessage(t, refused)}
        </p>
      )}
      <div className="formgrid">
        <MemberSelect id={`owner-${row.id}`} label={t('dgv.owners.change.owner.label')} value={form.ownerId} people={people} error={error('ownerId')} onChange={(value) => setField('ownerId', value)} />
        <MemberSelect id={`steward-${row.id}`} label={t('dgv.owners.change.steward.label')} value={form.stewardId} people={people} error={error('stewardId')} onChange={(value) => setField('stewardId', value)} />
      </div>
      <Field id={`reason-${row.id}`} label={t('dgv.owners.change.reason.label')} error={error('reason')}>
        <textarea id={`reason-${row.id}`} rows={2} value={form.reason} aria-invalid={error('reason') !== undefined} onChange={(event) => setField('reason', event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="button" onClick={onDone}>
          {t('dgv.owners.change.cancel.action')}
        </button>
        <button type="submit" className="primary" disabled={assign.isPending}>
          {t('dgv.owners.change.confirm.action')}
        </button>
      </div>
    </form>
  );
}

function RegisterDataset({ people, membersFailed, membersReadable }: { people: MemberOption[]; membersFailed: boolean; membersReadable: boolean }) {
  const { t } = useTranslation();
  const register = useRegisterDataset();
  const [form, setForm] = useState<RegisterForm>(EMPTY_REGISTER_FORM);
  const [errors, setErrors] = useState<FormErrors<RegisterField>>({});
  const [saved, setSaved] = useState(false);
  const refused = register.isError ? describeProblem(register.error) : undefined;
  const listed = membersReadable && !membersFailed;

  const setField = <Name extends RegisterField>(field: Name, value: RegisterForm[Name]): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    setSaved(false);
  };
  const error = (field: RegisterField): string | undefined => {
    const own = errors[field];
    return own === undefined ? undefined : fieldProblemMessage(t, own);
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (register.isPending) return;
    const found = validateRegister(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    register.mutate(registerBody(form), {
      onSuccess: () => {
        setForm(EMPTY_REGISTER_FORM);
        setSaved(true);
      },
    });
  };

  const text = (field: 'datasetCode' | 'title' | 'domain' | 'grain' | 'producerModule', id: string, label: string) => (
    <Field id={id} label={label} error={error(field)}>
      <input id={id} value={form[field]} aria-invalid={error(field) !== undefined} onChange={(event) => setField(field, event.target.value)} />
    </Field>
  );

  return (
    <form className="card" onSubmit={save} noValidate aria-label={t('dgv.owners.register.title')}>
      <h2>{t('dgv.owners.register.title')}</h2>
      {listed ? null : (
        <p className="callout warning" role="alert" data-testid="members-unavailable">
          {t('dgv.owners.members.unavailable')}
        </p>
      )}
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {problemMessage(t, refused)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="dataset-saved">
          {t('dgv.owners.register.saved.notice')}
        </p>
      ) : null}
      <div className="formgrid">
        {text('datasetCode', 'register-code', t('dgv.owners.register.code.label'))}
        {text('title', 'register-name', t('dgv.owners.register.name.label'))}
        {text('domain', 'register-domain', t('dgv.owners.register.domain.label'))}
        {text('grain', 'register-grain', t('dgv.owners.register.grain.label'))}
        {text('producerModule', 'register-module', t('dgv.owners.register.module.label'))}
        <Field id="register-classification" label={t('dgv.owners.register.classification.label')} error={undefined}>
          <select id="register-classification" value={form.classification} onChange={(event) => setField('classification', event.target.value as Classification)}>
            {CLASSIFICATION_LIST.map((classification) => (
              <option key={classification} value={classification}>
                {classificationLabel(t, classification)}
              </option>
            ))}
          </select>
        </Field>
        <MemberSelect id="register-owner" label={t('dgv.owners.register.owner.label')} value={form.ownerId} people={people} error={error('ownerId')} onChange={(value) => setField('ownerId', value)} />
        <MemberSelect id="register-steward" label={t('dgv.owners.register.steward.label')} value={form.stewardId} people={people} error={error('stewardId')} onChange={(value) => setField('stewardId', value)} />
        <Field id="register-freshness" label={t('dgv.owners.register.freshness.label')} error={error('freshnessHours')}>
          <input id="register-freshness" inputMode="numeric" value={form.freshnessHours} aria-invalid={error('freshnessHours') !== undefined} onChange={(event) => setField('freshnessHours', event.target.value)} />
        </Field>
        <Field id="register-critical" label={t('dgv.owners.register.critical.label')} error={undefined} hint={t('dgv.owners.register.critical.hint')}>
          <input id="register-critical" type="checkbox" checked={form.isCritical} onChange={(event) => setField('isCritical', event.target.checked)} />
        </Field>
      </div>
      <div className="formfooter">
        <span className="sub">{t('dgv.owners.register.hint.text')}</span>
        <button type="submit" className="primary" disabled={register.isPending || !listed}>
          {t('dgv.owners.register.save.action')}
        </button>
      </div>
    </form>
  );
}
