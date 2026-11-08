import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import type { WebRoute } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { useCreateRetentionDraft, usePublishRetention } from './retention/hooks';
import { basisLabel, endActionLabel, findingMessage, holdKindLabel, holdScopeLabel, kindLabel, problemMessage, problemOfDraft, statusLabel, statusTone } from './retention/labels';
import {
  APPROVE_RETENTION_PERMISSION,
  BUSINESS_CLASSES,
  EMPTY_DRAFT,
  MANAGE_RETENTION_PERMISSION,
  MAX_YEARS,
  MIN_YEARS,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  RETENTION_BASES,
  TECHNICAL_CLASSES,
  describeProblem,
  draftBody,
  endActionsFor,
  inRegisterOrder,
  recordKindOf,
  validateDraft,
} from './retention/model';
import type { DraftErrors, DraftField, DraftValues, HoldView, PolicyView, ReviewItemView } from './retention/model';
import { instantText } from './audit/SealBanner';
import { SectionCard, StatusPill } from '../../ui';
import { KitTable } from './KitTable';
import { MANAGE_HOLD_PERMISSION, PlaceHoldForm, ReleaseHoldForm } from './retention/HoldActions';
import './adm-kit.css';
import './retention/retention.css';

const SHORT_ID = 8;

export interface RetentionWorkspaceProps {
  route: WebRoute;
  /** Every version of every record class, as the register reads return them. */
  policies: readonly PolicyView[];
  /** The records of business classes whose period has run out and that wait for a decision. */
  review: readonly ReviewItemView[];
  /** The legal holds of the tenant; the active ones override every rule below. */
  holds: readonly HoldView[];
}

interface FieldProps {
  id: string;
  label: string;
  error: string | undefined;
  hint?: string;
  children: ReactNode;
}

function Field({ id, label, error, hint, children }: FieldProps) {
  return (
    <div className="field" data-field={id}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint === undefined ? null : <small className="sub">{hint}</small>}
      {error === undefined ? null : (
        <small role="alert" className="field-error" id={`${id}-error`}>
          {error}
        </small>
      )}
    </div>
  );
}

function PeriodText({ policy }: { policy: PolicyView }) {
  const { t } = useTranslation();
  return <>{policy.retentionYears === null ? t('adm.retention.period.permanent') : t('adm.retention.period.years', { count: policy.retentionYears })}</>;
}

/**
 * ADM-12: the retention rules of the tenant, the legal holds that override them and the records that wait for a decision (ST-ADM-017).
 * A rule is drafted by one person and published by another; a rule for a business class can only send a record to review or to
 * transfer, never to a job that deletes it. The periods are working assumptions until the legal owner confirms CXN-RET-01 to 03.
 */
export function RetentionWorkspace({ route, policies, review, holds }: RetentionWorkspaceProps) {
  const tenantId = useSession().tenant?.id;
  // Everything the screen holds (the form, the open publication) belongs to one tenant: a switch starts it over.
  return <WorkspaceContent key={tenantId ?? 'none'} route={route} policies={policies} review={review} holds={holds} />;
}

function WorkspaceContent({ route, policies, review, holds }: RetentionWorkspaceProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const canManage = (permissions === undefined || permissions.includes(MANAGE_RETENTION_PERMISSION)) && !frozen;
  const canApprove = (permissions === undefined || permissions.includes(APPROVE_RETENTION_PERMISSION)) && !frozen;
  const create = useCreateRetentionDraft();
  const publish = usePublishRetention();
  const register = useMemo(() => inRegisterOrder(policies), [policies]);
  const canHold = (permissions === undefined || permissions.includes(MANAGE_HOLD_PERMISSION)) && !frozen;
  const [placing, setPlacing] = useState(false);
  const [releasing, setReleasing] = useState<string | undefined>(undefined);
  const activeHolds = useMemo(() => holds.filter((hold) => hold.status === 'Active'), [holds]);
  const [values, setValues] = useState<DraftValues>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saved, setSaved] = useState(false);
  const [publishing, setPublishing] = useState<string | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const createProblem = create.isError ? describeProblem(create.error) : undefined;
  const publishProblem = publish.isError ? describeProblem(publish.error) : undefined;
  const kind = recordKindOf(values.recordClass.trim());
  const allowedActions = endActionsFor(values.recordClass.trim());
  const target = register.find((policy) => policy.id === publishing);

  const set = <K extends DraftField>(field: K, value: DraftValues[K]): void => {
    setValues((current) => ({ ...current, [field]: value }));
    setSaved(false);
  };
  const setClass = (recordClass: string): void => {
    // The end action follows the class: a business record is reviewed or transferred, technical data is purged.
    const actions = endActionsFor(recordClass.trim());
    setValues((current) => ({
      ...current,
      recordClass,
      endAction: actions.includes(current.endAction) ? current.endAction : (actions[0] ?? current.endAction),
      retentionBasis: recordKindOf(recordClass.trim()) === 'TECHNICAL' && current.retentionBasis !== 'PERMANENT' ? 'FROM_CREATED' : current.retentionBasis,
    }));
    setSaved(false);
  };

  const saveDraft = (event: FormEvent): void => {
    event.preventDefault();
    const found = validateDraft(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(draftBody(values), { onSuccess: () => setSaved(true) });
  };

  const confirmPublish = (event: FormEvent): void => {
    event.preventDefault();
    if (target === undefined) return;
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
      setReasonError(true);
      return;
    }
    publish.mutate(
      { id: target.id, version: target.version, reason: trimmed },
      {
        onSuccess: () => {
          setPublishing(undefined);
          setReason('');
        },
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="adm-retention">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.retention.page.title')}</h1>
          <p>{t('adm.retention.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout warning" role="note" data-testid="placeholder-note">
        {t('adm.retention.placeholder.note')}
      </p>
      <div className="two">
        <div>
          <SectionCard title={t('adm.retention.policy.title')}>
            {register.length === 0 ? <p className="muted">{t('adm.retention.policy.empty')}</p> : null}
            {publishProblem === undefined ? null : (
              <p className="callout warning" role="alert" data-testid="publish-problem">
                {problemMessage(t, publishProblem)}
              </p>
            )}
            {register.length === 0 ? null : (
              <KitTable caption={t('w2adm.retention.table.policies')}>
                  <thead>
                    <tr>
                      <th>{t('adm.retention.col.class')}</th>
                      <th>{t('adm.retention.col.basis')}</th>
                      <th>{t('adm.retention.col.period')}</th>
                      <th>{t('adm.retention.col.endAction')}</th>
                      <th>{t('adm.retention.col.legalBasis')}</th>
                      <th>{t('adm.retention.col.effective')}</th>
                      <th>{t('adm.retention.col.status')}</th>
                      <th>
                        {t('adm.retention.col.actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {register.map((policy) => (
                      <tr key={policy.id} data-policy-id={policy.id} data-status={policy.status} data-class={policy.recordClass}>
                        <td>
                          <strong>{policy.recordClass}</strong>
                          <div className="sub">
                            {kindLabel(t, recordKindOf(policy.recordClass))} · {t('adm.retention.revision.text', { revision: policy.revision })}
                          </div>
                        </td>
                        <td>{basisLabel(t, policy.retentionBasis)}</td>
                        <td>
                          <PeriodText policy={policy} />
                        </td>
                        <td>{endActionLabel(t, policy.endAction)}</td>
                        <td>{policy.legalBasisRef}</td>
                        <td>{policy.effectiveFrom}</td>
                        <td>
                          <StatusPill tone={statusTone(policy.status)}>{statusLabel(t, policy.status)}</StatusPill>
                        </td>
                        <td className="row-actions">
                          {policy.status !== 'Draft' || !canApprove ? null : policy.createdBy === tenant?.membershipId ? (
                            <span className="sub" data-testid="own-draft">
                              {t('adm.retention.publish.own.hint')}
                            </span>
                          ) : (
                            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => (setPublishing(policy.id), setReason(''), setReasonError(false))}>
                              {t('adm.retention.publish.action')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </KitTable>
            )}
            {target === undefined ? null : (
              <form className="publish-panel" onSubmit={confirmPublish} aria-label={t('adm.retention.publish.title')} data-testid="publish-panel">
                <h3>{t('adm.retention.publish.title')}</h3>
                <p>
                  <strong>{target.recordClass}</strong> · {basisLabel(t, target.retentionBasis)} · <PeriodText policy={target} /> · {endActionLabel(t, target.endAction)}
                </p>
                <Field id="publish-reason" label={t('adm.retention.publish.reason.label')} error={reasonError ? t('adm.retention.publish.reason.error') : undefined}>
                  <textarea id="publish-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
                </Field>
                <div className="adm-kit-actions">
                  <button type="submit" className="ui-button ui-button--primary" disabled={publish.isPending}>
                    {t('adm.retention.publish.confirm.action')}
                  </button>
                  <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setPublishing(undefined)}>
                    {t('adm.retention.publish.cancel.action')}
                  </button>
                </div>
              </form>
            )}
          </SectionCard>

          <SectionCard title={t('adm.retention.hold.title')}>
            <div data-testid="holds">
            <p className="sub">{t('adm.retention.hold.hint')}</p>
            {canHold && !placing ? (
              <button type="button" className="primary" data-testid="place-hold" onClick={() => setPlacing(true)}>
                {t('adm.retention.hold.place.open')}
              </button>
            ) : null}
            {placing ? <PlaceHoldForm onClose={() => setPlacing(false)} /> : null}
            {activeHolds.length === 0 ? <p className="muted">{t('adm.retention.hold.empty')}</p> : null}
            {activeHolds.length === 0 ? null : (
              <KitTable caption={t('w2adm.retention.table.holds')}>
                  <thead>
                    <tr>
                      <th>{t('adm.retention.hold.col.kind')}</th>
                      <th>{t('adm.retention.hold.col.scope')}</th>
                      <th>{t('adm.retention.hold.col.since')}</th>
                      <th>{t('adm.retention.hold.col.authority')}</th>
                      <th>{t('adm.retention.hold.col.reason')}</th>
                      {canHold ? (
                        <th>
                          <span className="sr-only">{t('adm.retention.hold.col.actions')}</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {activeHolds.map((hold) => (
                      <tr key={hold.id} data-hold-id={hold.id}>
                        <td>{holdKindLabel(t, hold.holdKind)}</td>
                        <td>
                          {holdScopeLabel(t, hold.scopeKind)}
                          {hold.scopeKind === 'TENANT' ? null : <span className="sub"> ({hold.scopeCount})</span>}
                        </td>
                        <td>{instantText(locale, hold.effectiveAt)}</td>
                        <td>{hold.authorityReference}</td>
                        <td>{hold.reason}</td>
                        {canHold ? (
                          <td>
                            <button type="button" data-testid={`release-${hold.id}`} onClick={() => setReleasing(hold.id)}>
                              {t('adm.retention.hold.release.open')}
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </KitTable>
            )}
            {releasing === undefined ? null : activeHolds.filter((hold) => hold.id === releasing).map((hold) => <ReleaseHoldForm key={hold.id} hold={hold} onClose={() => setReleasing(undefined)} />)}
            </div>
          </SectionCard>

          <SectionCard title={t('adm.retention.review.title')}>
            <div data-testid="review">
            <p className="sub">{t('adm.retention.review.hint')}</p>
            {review.length === 0 ? <p className="muted">{t('adm.retention.review.empty')}</p> : null}
            {review.length === 0 ? null : (
              <KitTable caption={t('w2adm.retention.table.review')}>
                  <thead>
                    <tr>
                      <th>{t('adm.retention.review.col.class')}</th>
                      <th>{t('adm.retention.review.col.resource')}</th>
                      <th>{t('adm.retention.review.col.basis')}</th>
                      <th>{t('adm.retention.review.col.due')}</th>
                      <th>{t('adm.retention.review.col.action')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {review.map((item) => (
                      <tr key={item.id} data-review-id={item.id}>
                        <td>{item.recordClass}</td>
                        <td title={item.resourceId}>
                          {item.resourceType} <span className="sub">{item.resourceId.slice(0, SHORT_ID)}</span>
                        </td>
                        <td>{item.basisDate}</td>
                        <td>{item.dueOn}</td>
                        <td>{endActionLabel(t, item.endAction)}</td>
                      </tr>
                    ))}
                  </tbody>
                </KitTable>
            )}
            </div>
          </SectionCard>
        </div>

        {canManage ? (
          <aside aria-label={t('adm.retention.draft.title')}>
          <SectionCard title={t('adm.retention.draft.title')}>
            <p className="sub">{t('adm.retention.draft.hint')}</p>
            <form onSubmit={saveDraft} noValidate>
              <Field id="draft-class" label={t('adm.retention.draft.class.label')} error={errors.recordClass === undefined ? undefined : problemOfDraft(t, errors.recordClass)}>
                <select id="draft-class" value={values.recordClass} aria-invalid={errors.recordClass !== undefined} onChange={(event) => setClass(event.target.value)}>
                  <option value="">{t('adm.retention.draft.class.choose')}</option>
                  <optgroup label={t('adm.retention.kind.business')}>
                    {BUSINESS_CLASSES.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={t('adm.retention.kind.technical')}>
                    {TECHNICAL_CLASSES.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </Field>
              <Field id="draft-basis" label={t('adm.retention.draft.basis.label')} error={errors.retentionBasis === undefined ? undefined : problemOfDraft(t, errors.retentionBasis)}>
                <select id="draft-basis" value={values.retentionBasis} onChange={(event) => set('retentionBasis', event.target.value as DraftValues['retentionBasis'])}>
                  {RETENTION_BASES.filter((basis) => kind !== 'TECHNICAL' || basis === 'FROM_CREATED' || basis === 'PERMANENT').map((basis) => (
                    <option key={basis} value={basis}>
                      {basisLabel(t, basis)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                id="draft-years"
                label={t('adm.retention.draft.years.label')}
                hint={t('adm.retention.draft.years.hint', { min: MIN_YEARS, max: MAX_YEARS })}
                error={errors.retentionYears === undefined ? undefined : problemOfDraft(t, errors.retentionYears)}
              >
                <input id="draft-years" inputMode="numeric" value={values.retentionYears} aria-invalid={errors.retentionYears !== undefined} onChange={(event) => set('retentionYears', event.target.value)} />
              </Field>
              <Field id="draft-action" label={t('adm.retention.draft.endAction.label')} error={errors.endAction === undefined ? undefined : problemOfDraft(t, errors.endAction)}>
                <select id="draft-action" value={values.endAction} onChange={(event) => set('endAction', event.target.value as DraftValues['endAction'])}>
                  {allowedActions.map((action) => (
                    <option key={action} value={action}>
                      {endActionLabel(t, action)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="draft-legal" label={t('adm.retention.draft.legalBasis.label')} error={errors.legalBasisRef === undefined ? undefined : problemOfDraft(t, errors.legalBasisRef)}>
                <input id="draft-legal" value={values.legalBasisRef} aria-invalid={errors.legalBasisRef !== undefined} onChange={(event) => set('legalBasisRef', event.target.value)} />
              </Field>
              <Field id="draft-effective" label={t('adm.retention.draft.effective.label')} error={errors.effectiveFrom === undefined ? undefined : problemOfDraft(t, errors.effectiveFrom)}>
                <input id="draft-effective" type="date" value={values.effectiveFrom} aria-invalid={errors.effectiveFrom !== undefined} onChange={(event) => set('effectiveFrom', event.target.value)} />
              </Field>
              {createProblem === undefined ? null : (
                <div className="callout warning" role="alert" data-testid="draft-problem">
                  <p>{problemMessage(t, createProblem)}</p>
                  {createProblem.findings.length === 0 ? null : (
                    <ul>
                      {createProblem.findings.map((finding, index) => (
                        <li key={`${finding.field}-${finding.code}-${index}`}>{findingMessage(t, finding.code)}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {saved ? (
                <p className="callout" role="status" data-testid="draft-saved">
                  {t('adm.retention.draft.saved.text')}
                </p>
              ) : null}
              <div className="adm-kit-actions">
                <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending}>
                  {t('adm.retention.draft.submit.action')}
                </button>
              </div>
            </form>
          </SectionCard>
          </aside>
        ) : null}
      </div>
      <p className="prototype-note">{t('adm.retention.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
