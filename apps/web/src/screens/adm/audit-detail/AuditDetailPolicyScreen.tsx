import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { SectionCard, StatusPill } from '../../../ui';
import { KitTable } from '../KitTable';
import { useAuditDetailPolicies, useAuditEventDetail, useSaveAuditDetailPolicy } from './hooks';
import {
  EMPTY_FORM,
  MANAGE_AUDIT_DETAIL_PERMISSION,
  READ_AUDIT_DETAIL_PERMISSION,
  SUGGESTED_CLASSES,
  describeProblem,
  formOf,
  prettyValue,
  toSaveBody,
  validateForm,
} from './model';
import type { DetailView, FormErrors, FormField, PolicyForm, PolicyView } from './model';

const NEVER_EMPTY = (): boolean => false;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ADM-29: whether the audit trail keeps the full before and after values of the business objects of a class (HT.06). Off by default; each class is switched with a reason, a byte cap per row and extra
 * sensitive keys. The sealed audit row carries the SHA-256 of the full values, so the lookup below shows whether the stored values still match the row.
 */
export default function AuditDetailPolicyScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The form and the lookup belong to one tenant: a switch starts the screen over.
  return <AuditDetailPolicyContent key={tenantId ?? 'none'} route={route} />;
}

function AuditDetailPolicyContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const canRead = permissions === undefined || permissions.includes(READ_AUDIT_DETAIL_PERMISSION);
  const mayManage = (permissions === undefined || permissions.includes(MANAGE_AUDIT_DETAIL_PERMISSION)) && mode !== 'READ_ONLY';
  const policies = useAuditDetailPolicies(canRead);
  const queryState = useScreenState({ isLoading: policies.isLoading, error: policies.error, data: policies.data, isEmpty: NEVER_EMPTY });
  const state = canRead ? queryState : 'denied';
  const [editing, setEditing] = useState<PolicyView | undefined>(undefined);
  const [lookup, setLookup] = useState('');
  const detail = useAuditEventDetail(UUID.test(lookup.trim()) ? lookup.trim().toLowerCase() : undefined);
  const list = policies.data ?? [];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.auditDetail.page.title')}</h1>
          <p>{t('adm.auditDetail.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void policies.refetch()}>
        <SectionCard title={t('adm.auditDetail.list.title')}>
          {list.length === 0 ? (
            <p className="muted" data-testid="empty-policies">
              {t('adm.auditDetail.empty.text')}
            </p>
          ) : (
            <KitTable caption={t('adm.auditDetail.list.caption')} testId="policies">
              <thead>
                <tr>
                  <th scope="col">{t('adm.auditDetail.col.class')}</th>
                  <th scope="col">{t('adm.auditDetail.col.state')}</th>
                  <th scope="col">{t('adm.auditDetail.col.maxBytes')}</th>
                  <th scope="col">{t('adm.auditDetail.col.keys')}</th>
                  <th scope="col">{t('adm.auditDetail.col.reason')}</th>
                  <th scope="col">{t('adm.auditDetail.col.version')}</th>
                  {mayManage ? <th scope="col">{t('adm.auditDetail.col.actions')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {list.map((policy) => (
                  <tr key={policy.id} data-resource-type={policy.resourceType} data-enabled={policy.enabled}>
                    <th scope="row">{policy.resourceType}</th>
                    <td>
                      <StatusPill tone={policy.enabled ? 'success' : 'neutral'}>{policy.enabled ? t('adm.auditDetail.state.on') : t('adm.auditDetail.state.off')}</StatusPill>
                    </td>
                    <td>{policy.maxBytes}</td>
                    <td>{policy.sensitiveKeys.length}</td>
                    <td>{policy.reason}</td>
                    <td>{policy.version}</td>
                    {mayManage ? (
                      <td>
                        <button type="button" className="btn" onClick={() => setEditing(policy)}>
                          {t('adm.auditDetail.edit.action')}
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </KitTable>
          )}
        </SectionCard>
        {mayManage ? <PolicyFormCard key={editing?.id ?? 'new'} current={editing} onDone={() => setEditing(undefined)} /> : null}
        <SectionCard title={t('adm.auditDetail.lookup.title')}>
          <div className="field">
            <label htmlFor="audit-detail-lookup">{t('adm.auditDetail.lookup.label')}</label>
            <input id="audit-detail-lookup" value={lookup} onChange={(event) => setLookup(event.target.value)} placeholder="00000000-0000-4000-8000-000000000000" />
            <small className="sub">{t('adm.auditDetail.lookup.hint')}</small>
          </div>
          {UUID.test(lookup.trim()) ? <DetailPanel loading={detail.isLoading} failed={detail.isError} detail={detail.data} /> : null}
        </SectionCard>
      </StateBoundary>
      <p className="prototype-note">{t('adm.auditDetail.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function DetailPanel({ loading, failed, detail }: { loading: boolean; failed: boolean; detail: DetailView | undefined }) {
  const { t } = useTranslation();
  if (loading) return <p aria-busy="true">{t('adm.auditDetail.lookup.loading')}</p>;
  if (failed || detail === undefined) {
    return (
      <p className="callout warning" role="alert" data-testid="detail-missing">
        {t('adm.auditDetail.lookup.missing')}
      </p>
    );
  }
  return (
    <div data-testid="detail" data-matches={detail.matchesSealedRow}>
      <p>
        <StatusPill tone={detail.matchesSealedRow ? 'success' : 'danger'}>{detail.matchesSealedRow ? t('adm.auditDetail.detail.matches') : t('adm.auditDetail.detail.mismatch')}</StatusPill>{' '}
        <span className="sub">
          {t('adm.auditDetail.detail.facts', { type: detail.resourceType, bytes: detail.bytes, redacted: detail.redactedPaths.length })}
          {detail.truncated ? ` ${t('adm.auditDetail.detail.truncated')}` : ''}
        </span>
      </p>
      <p>
        <strong>{t('adm.auditDetail.detail.changed')}</strong> {detail.changedPaths.length === 0 ? t('adm.auditDetail.detail.none') : detail.changedPaths.join(', ')}
      </p>
      <div className="detail-columns">
        <div>
          <h3>{t('adm.auditDetail.detail.before')}</h3>
          <pre data-testid="detail-before">{prettyValue(detail.before)}</pre>
        </div>
        <div>
          <h3>{t('adm.auditDetail.detail.after')}</h3>
          <pre data-testid="detail-after">{prettyValue(detail.after)}</pre>
        </div>
      </div>
    </div>
  );
}

function PolicyFormCard({ current, onDone }: { current: PolicyView | undefined; onDone: () => void }) {
  const { t } = useTranslation();
  const save = useSaveAuditDetailPolicy();
  const [form, setForm] = useState<PolicyForm>(current === undefined ? EMPTY_FORM : formOf(current));
  const [errors, setErrors] = useState<FormErrors>({});
  const [saved, setSaved] = useState(false);
  const refused = save.isError ? describeProblem(save.error) : undefined;

  const change = (patch: Partial<PolicyForm>, field?: FormField): void => {
    setForm((previous) => ({ ...previous, ...patch }));
    if (field !== undefined) setErrors((previous) => ({ ...previous, [field]: undefined }));
    setSaved(false);
    if (save.isError) save.reset();
  };
  const problem = (field: FormField): string | undefined => {
    const found = errors[field];
    return found === undefined ? undefined : t(`adm.auditDetail.problem.${found}`);
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (save.isPending) return;
    const found = validateForm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    save.mutate(toSaveBody(form, current), {
      onSuccess: () => {
        setSaved(true);
        onDone();
      },
    });
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label={t('adm.auditDetail.form.aria')}>
      <h2>{current === undefined ? t('adm.auditDetail.form.titleNew') : t('adm.auditDetail.form.titleEdit', { type: current.resourceType })}</h2>
      <p className="sub">{t('adm.auditDetail.form.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {t(`adm.auditDetail.refused.${refused}`)}
        </p>
      )}
      <div className="field" data-field="resourceType">
        <label htmlFor="audit-detail-class">{t('adm.auditDetail.field.class')}</label>
        <input id="audit-detail-class" list="audit-detail-classes" value={form.resourceType} readOnly={current !== undefined} aria-invalid={errors.resourceType !== undefined} onChange={(event) => change({ resourceType: event.target.value }, 'resourceType')} />
        <datalist id="audit-detail-classes">
          {SUGGESTED_CLASSES.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        {problem('resourceType') === undefined ? null : <small role="alert" className="field-error">{problem('resourceType')}</small>}
      </div>
      <div className="field">
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(event) => change({ enabled: event.target.checked })} /> {t('adm.auditDetail.field.enabled')}
        </label>
      </div>
      <div className="field" data-field="maxBytes">
        <label htmlFor="audit-detail-bytes">{t('adm.auditDetail.field.maxBytes')}</label>
        <input id="audit-detail-bytes" inputMode="numeric" value={form.maxBytes} aria-invalid={errors.maxBytes !== undefined} onChange={(event) => change({ maxBytes: event.target.value }, 'maxBytes')} />
        {problem('maxBytes') === undefined ? null : <small role="alert" className="field-error">{problem('maxBytes')}</small>}
      </div>
      <div className="field" data-field="sensitiveKeys">
        <label htmlFor="audit-detail-keys">{t('adm.auditDetail.field.keys')}</label>
        <textarea id="audit-detail-keys" rows={2} value={form.sensitiveKeys} aria-invalid={errors.sensitiveKeys !== undefined} onChange={(event) => change({ sensitiveKeys: event.target.value }, 'sensitiveKeys')} />
        <small className="sub">{t('adm.auditDetail.field.keysHint')}</small>
        {problem('sensitiveKeys') === undefined ? null : <small role="alert" className="field-error">{problem('sensitiveKeys')}</small>}
      </div>
      <div className="field" data-field="reason">
        <label htmlFor="audit-detail-reason">{t('adm.auditDetail.field.reason')}</label>
        <textarea id="audit-detail-reason" rows={2} value={form.reason} aria-invalid={errors.reason !== undefined} onChange={(event) => change({ reason: event.target.value }, 'reason')} />
        {problem('reason') === undefined ? null : <small role="alert" className="field-error">{problem('reason')}</small>}
      </div>
      <div className="actions">
        <button type="submit" className="btn primary" disabled={save.isPending}>
          {t('adm.auditDetail.form.save')}
        </button>
        {current === undefined ? null : (
          <button type="button" className="btn" onClick={onDone}>
            {t('adm.auditDetail.form.cancel')}
          </button>
        )}
        {saved ? (
          <span role="status" className="sub">
            {t('adm.auditDetail.form.saved')}
          </span>
        ) : null}
      </div>
    </form>
  );
}
