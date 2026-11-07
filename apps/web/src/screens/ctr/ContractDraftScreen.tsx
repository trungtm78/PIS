import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { boqLink } from './boq-model';
import { BackLink, Fact, Field, StatusBadge } from './components';
import { guaranteesLink } from './guarantee-model';
import { useCancelContract, useContract, useContractorOptions, useCreateContract, useProjectOptions, useReviseContract } from './hooks';
import { advanceLabel, fieldProblemMessage, problemMessage, revisionStatusLabel, statusText, typeLabel } from './labels';
import {
  ADVANCE_CATEGORIES,
  CONTRACT_TYPES,
  CREATE_PERMISSION,
  EMPTY_FORM,
  LIST_PATH,
  UPDATE_PERMISSION,
  amountText,
  createBody,
  describeProblem,
  draftLink,
  formOf,
  partiesLink,
  workspaceLink,
  reviseBody,
  validateForm,
} from './model';
import type { ContractField, ContractForm, ContractView, FieldProblem, Option, ProblemView } from './model';
import './ctr.css';
import { SectionCard, StickyActions } from '../../ui';

const NEVER_EMPTY = (): boolean => false;
const DRAFT_STATES: readonly string[] = ['DRAFT', 'IN_REVIEW'];

type Errors = Partial<Record<ContractField, FieldProblem>>;

/** CTR-02: a contract is drafted under an awarded package below the price of the package, and the draft is revised or cancelled until it goes to review. */
export default function ContractDraftScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form, the options and the draft belong to one membership: a switch starts the screen over.
  return <ContractDraftContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ContractDraftContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const contractId = params.get('id') ?? undefined;
  const contract = useContract(contractId);
  const state = useScreenState({ isLoading: contract.isLoading, error: contract.error, data: contractId === undefined ? undefined : (contract.data ?? undefined), isEmpty: NEVER_EMPTY });
  const missing = contractId !== undefined && contract.isSuccess && contract.data === null;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={LIST_PATH}>{t('ctr.back.list.link')}</BackLink>
      {contractId === undefined ? (
        <CreateDraft />
      ) : missing ? (
        <>
          <div className="heading">
            <h1 id="screen-title">{t('ctr.draft.page.title')}</h1>
          </div>
          <p className="callout warning" role="status" data-testid="no-contract">
            {t('ctr.draft.noContract.notice')}
          </p>
        </>
      ) : (
        <StateBoundary state={state} onRetry={() => void contract.refetch()}>
          {contract.data === undefined || contract.data === null ? null : <DraftView key={contract.data.version} contract={contract.data} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('ctr.draft.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function ProblemNotice({ problem }: { problem: ProblemView | undefined }) {
  const { t, locale } = useTranslation();
  if (problem === undefined) return null;
  return (
    <p className="callout warning" role="alert" data-testid="problem">
      {problemMessage(t, problem, (amount) => amountText(amount, locale))}
    </p>
  );
}

function OptionSelect({ id, value, options, disabled, onChange }: { id: string; value: string; options: readonly Option[]; disabled: boolean; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">{t('ctr.form.choose.option')}</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

interface FieldsProps {
  mode: 'create' | 'revise';
  form: ContractForm;
  errors: Errors;
  ceiling: string | undefined;
  onChange: (field: ContractField, value: string | boolean) => void;
  projects: readonly Option[];
  contractors: readonly Option[];
  disabled: boolean;
}

/** The fields of the draft: the whole contract when it is created, the allowlist of the terms when it is revised. */
function DraftFields({ mode, form, errors, ceiling, onChange, projects, contractors, disabled }: FieldsProps) {
  const { t, locale } = useTranslation();
  const error = (field: ContractField): string | undefined => {
    const problem = errors[field];
    return problem === undefined ? undefined : fieldProblemMessage(t, problem, ceiling === undefined ? undefined : amountText(ceiling, locale));
  };
  const text = (field: ContractField, id: string, label: string, extra: { hint?: string; numeric?: boolean; type?: string } = {}) => (
    <Field id={id} label={label} error={error(field)} {...(extra.hint === undefined ? {} : { hint: extra.hint })}>
      <input
        id={id}
        type={extra.type ?? 'text'}
        {...(extra.numeric === true ? { inputMode: 'numeric' as const } : {})}
        value={String(form[field])}
        aria-invalid={error(field) !== undefined}
        onChange={(event) => onChange(field, event.target.value)}
      />
    </Field>
  );
  return (
    <fieldset disabled={disabled} className="formgrid">
      {mode === 'create' ? (
        <>
          <Field id="contract-projectId" label={t('ctr.form.project.label')} error={error('projectId')}>
            <OptionSelect id="contract-projectId" value={form.projectId} options={projects} disabled={disabled} onChange={(value) => onChange('projectId', value)} />
          </Field>
          {text('packageId', 'contract-packageId', t('ctr.form.package.label'), { hint: t('ctr.form.package.hint') })}
          <Field id="contract-contractorId" label={t('ctr.form.contractor.label')} error={error('contractorId')} hint={t('ctr.form.contractor.hint')}>
            <OptionSelect id="contract-contractorId" value={form.contractorId} options={contractors} disabled={disabled} onChange={(value) => onChange('contractorId', value)} />
          </Field>
          {text('code', 'contract-code', t('ctr.form.code.label'), { hint: t('ctr.form.code.hint') })}
        </>
      ) : null}
      {text('title', 'contract-title', t('ctr.form.title.label'))}
      {mode === 'create' ? (
        <>
          <Field id="contract-type" label={t('ctr.form.type.label')} error={undefined}>
            <select id="contract-type" value={form.type} onChange={(event) => onChange('type', event.target.value)}>
              {CONTRACT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {typeLabel(t, type)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="contract-advanceCategory" label={t('ctr.form.advance.label')} error={undefined}>
            <select id="contract-advanceCategory" value={form.advanceCategory} onChange={(event) => onChange('advanceCategory', event.target.value)}>
              {ADVANCE_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {advanceLabel(t, category)}
                </option>
              ))}
            </select>
          </Field>
          <label className="check">
            <input type="checkbox" checked={form.isJointVenture} onChange={(event) => onChange('isJointVenture', event.target.checked)} />
            {t('ctr.form.venture.label')}
          </label>
        </>
      ) : null}
      <label className="check">
        <input type="checkbox" checked={form.requiresQualityAcceptance} onChange={(event) => onChange('requiresQualityAcceptance', event.target.checked)} />
        {t('ctr.form.quality.label')}
      </label>
      {text('contractValue', 'contract-contractValue', t('ctr.form.value.label'), { numeric: true, hint: t('ctr.form.value.hint') })}
      {text('estimateCeiling', 'contract-estimateCeiling', t('ctr.form.ceiling.label'), { numeric: true, hint: t('ctr.form.ceiling.hint') })}
      {text('completionDue', 'contract-completionDue', t('ctr.form.due.label'), { type: 'date' })}
      {text('documentVersionId', 'contract-documentVersionId', t('ctr.form.document.label'), { hint: t('ctr.form.document.hint') })}
    </fieldset>
  );
}

function RulesPanel() {
  const { t } = useTranslation();
  return (
    <aside className="card" aria-label={t('ctr.draft.rules.title')}>
      <h2>{t('ctr.draft.rules.title')}</h2>
      <dl className="ctr-facts">
        <dt>{t('ctr.draft.rules.ceiling.label')}</dt>
        <dd>{t('ctr.draft.rules.ceiling.text')}</dd>
        <dt>{t('ctr.draft.rules.plan.label')}</dt>
        <dd>{t('ctr.draft.rules.plan.text')}</dd>
        <dt>{t('ctr.draft.rules.contractor.label')}</dt>
        <dd>{t('ctr.draft.rules.contractor.text')}</dd>
        <dt>{t('ctr.draft.rules.venture.label')}</dt>
        <dd>{t('ctr.draft.rules.venture.text')}</dd>
      </dl>
    </aside>
  );
}

function useAccess(): { canCreate: boolean; canUpdate: boolean; frozen: boolean } {
  const { permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  return {
    canCreate: (permissions === undefined || permissions.includes(CREATE_PERMISSION)) && !frozen,
    canUpdate: (permissions === undefined || permissions.includes(UPDATE_PERMISSION)) && !frozen,
    frozen,
  };
}

/** The form that drafts a contract; once it exists the person is offered the draft and, for a joint venture, the members. */
function CreateDraft() {
  const { t } = useTranslation();
  const { canCreate, frozen } = useAccess();
  const projects = useProjectOptions();
  const contractors = useContractorOptions();
  const create = useCreateContract();
  const [params] = useSearchParams();
  const [form, setForm] = useState<ContractForm>({ ...EMPTY_FORM, projectId: params.get('project') ?? '', packageId: params.get('package') ?? '' });
  const [errors, setErrors] = useState<Errors>({});
  const [created, setCreated] = useState<{ id: string; venture: boolean } | undefined>(undefined);
  const problem = create.isError ? describeProblem(create.error) : undefined;

  const setField = (field: ContractField, value: string | boolean): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending || !canCreate || created !== undefined) return;
    const found = validateForm(form, 'create');
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(createBody(form), { onSuccess: (result) => setCreated({ id: result.resource_id ?? '', venture: form.isJointVenture }) });
  };

  return (
    <>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.draft.create.title')}</h1>
          <p>{t('ctr.draft.create.subtitle')}</p>
        </div>
      </div>
      <div className="ctr-grid">
        <form className="card" onSubmit={save} noValidate aria-label={t('ctr.draft.form.title')}>
          <h2>{t('ctr.draft.form.title')}</h2>
          {!canCreate ? (
            <p className="callout warning" role="status">
              {frozen ? t('ctr.readOnly.frozen.notice') : t('ctr.readOnly.denied.notice')}
            </p>
          ) : null}
          <ProblemNotice problem={problem} />
          <DraftFields
            mode="create"
            form={form}
            errors={errors}
            ceiling={undefined}
            onChange={setField}
            projects={projects.data ?? []}
            contractors={contractors.data ?? []}
            disabled={!canCreate || created !== undefined}
          />
          <StickyActions
            primary={
              <button type="submit" className="ui-button ui-button--primary" disabled={!canCreate || create.isPending || created !== undefined}>
                {create.isPending ? t('ctr.draft.create.pending') : t('ctr.draft.create.action')}
              </button>
            }
            secondary={[
              <Link key="cancel" className="ui-button ui-button--outline" to={LIST_PATH}>
                {t('ctr.draft.cancel.link')}
              </Link>,
            ]}
          />
        </form>
        <div>
          <RulesPanel />
          {created === undefined ? null : (
            <div className="card" data-testid="created">
              <h2>{t('ctr.draft.done.title')}</h2>
              <p role="status">{t('ctr.draft.done.text')}</p>
              <p className="ctr-row-actions">
                <Link className="button primary" to={draftLink(created.id)}>
                  {t('ctr.draft.done.open')}
                </Link>
                {created.venture ? (
                  <Link className="button" to={partiesLink(created.id)}>
                    {t('ctr.draft.done.parties')}
                  </Link>
                ) : null}
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** A draft that exists: its terms to revise while it is a draft, what cannot change, its revisions and its history. */
function DraftView({ contract }: { contract: ContractView }) {
  const { t, locale } = useTranslation();
  const { canUpdate, frozen } = useAccess();
  const revise = useReviseContract();
  const cancel = useCancelContract();
  const [form, setForm] = useState<ContractForm>(() => formOf(contract));
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState<'saved' | 'unchanged' | 'cancelled' | undefined>(undefined);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const editable = contract.status === 'DRAFT' && canUpdate;
  const cancellable = DRAFT_STATES.includes(contract.status) && canUpdate;
  const problem = revise.isError ? describeProblem(revise.error) : cancel.isError ? describeProblem(cancel.error) : undefined;
  const ceiling = contract.estimateCeilingVnd ?? undefined;

  const setField = (field: ContractField, value: string | boolean): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setNotice(undefined);
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (revise.isPending || !editable) return;
    const found = validateForm(form, 'revise', ceiling);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body = reviseBody(contract, form);
    if (Object.keys(body).length === 0) {
      setNotice('unchanged');
      return;
    }
    revise.mutate({ id: contract.id, version: contract.version, body }, { onSuccess: () => setNotice('saved') });
  };

  const confirmCancel = (event: FormEvent): void => {
    event.preventDefault();
    if (cancel.isPending || !cancellable) return;
    if (reason.trim() === '') {
      setReasonMissing(true);
      return;
    }
    cancel.mutate({ id: contract.id, version: contract.version, reason: reason.trim() }, { onSuccess: () => setNotice('cancelled') });
  };

  return (
    <>
      <div className="heading">
        <div>
          <h1 id="screen-title">
            {contract.code} · {contract.title ?? ''}
          </h1>
          <p>
            <StatusBadge status={contract.status} />
          </p>
        </div>
        <div className="ctr-row-actions">
          {contract.isJointVenture ? (
            <Link className="button" to={partiesLink(contract.id)}>
              {t('ctr.draft.parties.action')}
            </Link>
          ) : null}
          <Link className="button" to={boqLink(contract.id)}>
            {t('ctr.draft.boq.action')}
          </Link>
          <Link className="button" to={guaranteesLink(contract.id)}>
            {t('ctr.draft.guarantees.action')}
          </Link>
          <Link className="button" to={workspaceLink(contract.id)}>
            {t('ctr.draft.workspace.action')}
          </Link>
        </div>
      </div>
      <div className="ctr-grid">
        <div>
          <form className="card" onSubmit={save} noValidate aria-label={t('ctr.draft.terms.title')}>
            <h2>{t('ctr.draft.terms.title')}</h2>
            {!editable ? (
              <p className="callout" role="status" data-testid="read-only">
                {frozen ? t('ctr.readOnly.frozen.notice') : contract.status === 'DRAFT' ? t('ctr.readOnly.denied.notice') : t('ctr.draft.notDraft.notice')}
              </p>
            ) : null}
            <ProblemNotice problem={problem} />
            {notice === undefined ? null : (
              <p className="callout" role="status" data-testid="notice">
                {notice === 'saved' ? t('ctr.draft.saved.notice') : notice === 'cancelled' ? t('ctr.draft.cancelled.notice') : t('ctr.draft.unchanged.notice')}
              </p>
            )}
            <DraftFields mode="revise" form={form} errors={errors} ceiling={ceiling} onChange={setField} projects={[]} contractors={[]} disabled={!editable} />
            <StickyActions
              primary={
                <button type="submit" className="ui-button ui-button--primary" disabled={!editable || revise.isPending}>
                  {revise.isPending ? t('ctr.draft.save.pending') : t('ctr.draft.save.action')}
                </button>
              }
              secondary={[
                <Link key="cancel" className="ui-button ui-button--outline" to={LIST_PATH}>
                  {t('ctr.draft.cancel.link')}
                </Link>,
              ]}
            />
          </form>
          {cancellable ? (
            <div className="card">
              <h2>{t('ctr.draft.cancel.title')}</h2>
              <p className="sub">{t('ctr.draft.cancel.hint')}</p>
              {cancelling ? (
                <form onSubmit={confirmCancel} noValidate aria-label={t('ctr.draft.cancel.title')}>
                  <Field id="contract-cancelReason" label={t('ctr.draft.cancel.reason.label')} error={reasonMissing ? t('ctr.field.required.error') : undefined}>
                    <textarea
                      id="contract-cancelReason"
                      value={reason}
                      aria-invalid={reasonMissing}
                      onChange={(event) => {
                        setReason(event.target.value);
                        setReasonMissing(false);
                      }}
                    />
                  </Field>
                  <p className="ctr-row-actions">
                    <button type="submit" className="button primary" disabled={cancel.isPending}>
                      {cancel.isPending ? t('ctr.draft.cancel.pending') : t('ctr.draft.cancel.confirm')}
                    </button>
                    <button type="button" className="button" onClick={() => setCancelling(false)}>
                      {t('ctr.draft.cancel.back')}
                    </button>
                  </p>
                </form>
              ) : (
                <button type="button" className="button" onClick={() => setCancelling(true)}>
                  {t('ctr.draft.cancel.open')}
                </button>
              )}
            </div>
          ) : null}
        </div>
        <div>
          <SectionCard title={t('ctr.draft.facts.title')}>
            <dl className="ctr-facts" data-testid="facts">
              <Fact label={t('ctr.draft.fact.project')}>{`${contract.projectCode} · ${contract.projectName}`}</Fact>
              <Fact label={t('ctr.draft.fact.contractor')}>{contract.contractorName ?? contract.contractorId}</Fact>
              <Fact label={t('ctr.draft.fact.package')}>
                <code>{contract.packageId}</code>
              </Fact>
              <Fact label={t('ctr.draft.fact.type')}>{typeLabel(t, contract.type)}</Fact>
              <Fact label={t('ctr.draft.fact.advance')}>{advanceLabel(t, contract.advanceCategory)}</Fact>
              <Fact label={t('ctr.draft.fact.venture')}>{contract.isJointVenture ? t('ctr.draft.fact.yes') : t('ctr.draft.fact.no')}</Fact>
              <Fact label={t('ctr.draft.fact.value')}>{t('ctr.value.amount', { amount: amountText(contract.contractValueVnd, locale) })}</Fact>
              {ceiling === undefined ? null : <Fact label={t('ctr.draft.fact.ceiling')}>{t('ctr.value.amount', { amount: amountText(ceiling, locale) })}</Fact>}
              {contract.statusReason === null ? null : <Fact label={t('ctr.draft.fact.reason')}>{contract.statusReason}</Fact>}
            </dl>
          </SectionCard>
          <SectionCard title={t('ctr.draft.revisions.title')}>
            <table className="table" data-testid="revisions">
              <thead>
                <tr>
                  <th scope="col">{t('ctr.draft.revisions.column.revision')}</th>
                  <th scope="col">{t('ctr.draft.revisions.column.status')}</th>
                  <th scope="col">{t('ctr.draft.revisions.column.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {contract.revisions.map((revision) => (
                  <tr key={revision.id}>
                    <th scope="row">{revision.revision}</th>
                    <td>{revisionStatusLabel(t, revision.status)}</td>
                    <td className="ctr-amount">{t('ctr.value.amount', { amount: amountText(revision.amountVnd, locale) })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SectionCard>
          {contract.statusChanges.length === 0 ? null : (
            <SectionCard title={t('ctr.draft.history.title')}>
              <ul data-testid="history">
                {contract.statusChanges.map((change) => (
                  <li key={change.id}>{t('ctr.draft.history.entry', { from: statusText(t, change.fromStatus), to: statusText(t, change.toStatus), date: change.effectiveOn, reason: change.reason })}</li>
                ))}
              </ul>
            </SectionCard>
          )}
          <RulesPanel />
        </div>
      </div>
    </>
  );
}
