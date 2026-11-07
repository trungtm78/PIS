import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { DataTable, SectionCard, StatusPill, StickyActions } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { useUnits } from '../adm/members/hooks';
import { useMasterOptions } from './hooks';
import { useCreatePolicy, usePolicies, usePreview, usePublishPolicy } from './avc/hooks';
import { countedLabel, fieldProblemMessage, objectLabel, periodText, problemMessage, scopeKindLabel, scopeText, statusLabel } from './avc/labels';
import {
  APPROVE_PERMISSION,
  CONTROL_OBJECTS,
  EMPTY_FORM,
  MANAGE_PERMISSION,
  MAX_LEGAL_BASIS,
  PROJECT_GROUPS,
  READ_PERMISSION,
  READ_UNITS_PERMISSION,
  SCOPE_KINDS,
  barsOf,
  createBody,
  describeProblem,
  formOfRevision,
  mayPublish,
  validateForm,
} from './avc/model';
import type { ControlObject, FieldProblem, FormField, PolicyForm, PolicyRow, ScopeKind } from './avc/model';
import './cap.css';
import './avc/avc.css';

type Context = 'create' | 'publish';
interface Notice {
  kind: Context;
  code: string;
  revision: number;
}

/**
 * CAP-17: the availability control policy. The policy administrator drafts the thresholds of a scope (warn at most block, block at most 100) over lines or appropriations under
 * a legal basis, another person publishes it, and every spending command is judged by the policy in force. The two thresholds are drawn as bars with their percentages and
 * said in words; the preview counts the lines in WARN and BLOCK that the policy would put now.
 */
export default function AvcPolicyScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form, the choice for the preview and the notices belong to one membership: a switch starts the screen over.
  return <AvcContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function AvcContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant, permissions, mode } = useSession();
  const frozen = mode === 'READ_ONLY';
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const canManage = holds(MANAGE_PERMISSION) && !frozen;
  const canApprove = holds(APPROVE_PERMISSION) && !frozen;
  const policies = usePolicies();
  // The names of the units are read by whoever may read units; someone who may not sees the unit by its id and cannot pick one for a new policy.
  const units = useUnits(holds(READ_UNITS_PERMISSION));
  const funds = useMasterOptions(['FUND_SOURCE'], canManage);
  const create = useCreatePolicy();
  const publish = usePublishPolicy();
  const [form, setForm] = useState<PolicyForm>(EMPTY_FORM);
  const [attempted, setAttempted] = useState(false);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [context, setContext] = useState<Context>('create');

  const rows = policies.data ?? [];
  const previewId = chosen ?? rows[0]?.id;
  const preview = usePreview(previewId, holds(READ_PERMISSION));
  const problems = validateForm(form);
  const shownProblems = attempted ? problems : {};
  const bars = barsOf(form.warnPct, form.blockPct);
  const failure = context === 'create' ? create : publish;
  const problem = failure.isError ? describeProblem(failure.error) : undefined;
  const unitNames = useMemo(() => new Map((units.data ?? []).map((unit) => [unit.id, unit.name])), [units.data]);
  const state = useScreenState({
    isLoading: policies.isLoading,
    error: policies.error,
    data: policies.isLoading ? undefined : rows,
  });
  const chosenPolicy = rows.find((row) => row.id === previewId);
  const columns: DataTableColumn<PolicyRow>[] = [
    {
      key: 'code',
      header: t('cap.avc.col.code'),
      pinned: true,
      render: (row) => (
        <span data-policy-id={row.id} data-status={row.status}>
          {t('cap.avc.row.code', {
            code: row.policyCode,
            revision: row.revision,
          })}
        </span>
      ),
    },
    {
      key: 'scope',
      header: t('cap.avc.col.scope'),
      render: (row) => scopeText(t, row, (id) => unitNames.get(id)),
    },
    {
      key: 'object',
      header: t('cap.avc.col.object'),
      render: (row) => objectLabel(t, row.controlObject),
    },
    {
      key: 'thresholds',
      header: t('cap.avc.col.thresholds'),
      render: (row) => (
        <>
          <span>
            {t('cap.avc.thresholds.text', {
              warn: row.warnPct,
              block: row.blockPct,
            })}
          </span>
          <small className="sub">{row.includeReservations ? t('cap.avc.reservations.counted') : t('cap.avc.reservations.apart')}</small>
        </>
      ),
    },
    {
      key: 'period',
      header: t('cap.avc.col.period'),
      render: (row) => periodText(t, row),
    },
    {
      key: 'status',
      header: t('cap.avc.col.status'),
      render: (row) => <StatusPill tone={row.status === 'PUBLISHED' ? 'success' : 'warning'}>{statusLabel(t, row.status)}</StatusPill>,
    },
    {
      key: 'actions',
      header: t('cap.avc.col.actions'),
      render: (row) => (
        <span className="cap-actions">
          <button type="button" className="ui-button ui-button--outline ui-button--small" aria-pressed={previewId === row.id} onClick={() => setChosen(row.id)}>
            {t('cap.avc.row.preview.action')}
          </button>
          {canManage ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => revise(row)}>
              {t('cap.avc.row.revise.action')}
            </button>
          ) : null}
          {mayPublish(row, tenant?.membershipId, canApprove) ? (
            <button type="button" className="ui-button ui-button--primary ui-button--small" disabled={publish.isPending} onClick={() => publishRow(row)}>
              {t('cap.avc.row.publish.action')}
            </button>
          ) : null}
        </span>
      ),
    },
  ];

  const change = <K extends keyof PolicyForm>(field: K, value: PolicyForm[K]): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setNotice(undefined);
  };
  const changeScope = (kind: ScopeKind): void =>
    setForm((current) => ({
      ...current,
      scopeKind: kind,
      scopeRefId: '',
      scopeValue: '',
    }));

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending || !canManage) return;
    if (Object.keys(problems).length > 0) {
      setAttempted(true);
      return;
    }
    setContext('create');
    create.mutate(createBody(form), {
      onSuccess: (done) => {
        const body = done as { revision?: number; policy_code?: string };
        setNotice({
          kind: 'create',
          code: body.policy_code ?? form.policyCode.trim(),
          revision: body.revision ?? 1,
        });
        setForm(EMPTY_FORM);
        setAttempted(false);
      },
    });
  };

  const publishRow = (row: PolicyRow): void => {
    if (publish.isPending || !canApprove) return;
    setContext('publish');
    publish.mutate(
      { id: row.id, version: row.version },
      {
        onSuccess: () =>
          setNotice({
            kind: 'publish',
            code: row.policyCode,
            revision: row.revision,
          }),
      },
    );
  };

  const revise = (row: PolicyRow): void => {
    setForm(formOfRevision(row));
    setAttempted(false);
    setNotice(undefined);
    create.reset();
  };

  const fieldProblem = (field: FormField): FieldProblem | undefined => shownProblems[field];
  const errorOf = (field: FormField): string | undefined => {
    const found = fieldProblem(field);
    return found === undefined ? undefined : fieldProblemMessage(t, found);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="cap-avc">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.avc.page.title')}</h1>
          <p>{t('cap.avc.page.subtitle')}</p>
        </div>
      </div>
      <div className="avc-grid">
        <SectionCard title={t('cap.avc.policies.title')}>
          <StateBoundary state={state} onRetry={() => void policies.refetch()}>
            <DataTable caption={t('cap.avc.policies.title')} columns={columns} rows={rows} rowKey={(row) => row.id} rowAttrs={(row) => ({ 'data-policy-id': row.id, 'data-status': row.status })} />
          </StateBoundary>
          {notice === undefined ? null : (
            <p className="callout" role="status">
              {notice.kind === 'create'
                ? t('cap.avc.done.created', {
                    code: notice.code,
                    revision: notice.revision,
                  })
                : t('cap.avc.done.published', {
                    code: notice.code,
                    revision: notice.revision,
                  })}
            </p>
          )}
          {problem === undefined ? null : (
            <div className="callout warning" role="alert">
              <p>{problemMessage(t, problem.reason)}</p>
            </div>
          )}

          {canManage ? (
            <form onSubmit={submit} noValidate aria-label={t('cap.avc.form.aria')} className="avc-form">
              <h3>{t('cap.avc.form.title')}</h3>
              <div className="formgrid">
                <div className="field">
                  <label htmlFor="avc-code">{t('cap.avc.form.code.label')}</label>
                  <input id="avc-code" value={form.policyCode} aria-invalid={fieldProblem('policyCode') !== undefined} onChange={(event) => change('policyCode', event.target.value)} />
                  <small className="sub">{t('cap.avc.form.code.hint')}</small>
                  {errorOf('policyCode') === undefined ? null : (
                    <small role="alert" className="field-error">
                      {errorOf('policyCode')}
                    </small>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="avc-scope-kind">{t('cap.avc.form.scopeKind.label')}</label>
                  <select id="avc-scope-kind" value={form.scopeKind} onChange={(event) => changeScope(event.target.value as ScopeKind)}>
                    {SCOPE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {scopeKindLabel(t, kind)}
                      </option>
                    ))}
                  </select>
                </div>
                {form.scopeKind === 'UNIT' ? (
                  <div className="field">
                    <label htmlFor="avc-scope-unit">{t('cap.avc.form.scopeUnit.label')}</label>
                    <select id="avc-scope-unit" value={form.scopeRefId} aria-invalid={fieldProblem('scope') !== undefined} onChange={(event) => change('scopeRefId', event.target.value)}>
                      <option value="">{t('cap.avc.form.choose.option')}</option>
                      {(units.data ?? []).map((unit) => (
                        <option key={unit.id} value={unit.id}>
                          {unit.name}
                        </option>
                      ))}
                    </select>
                    {errorOf('scope') === undefined ? null : (
                      <small role="alert" className="field-error">
                        {errorOf('scope')}
                      </small>
                    )}
                  </div>
                ) : null}
                {form.scopeKind === 'FUND_SOURCE' ? (
                  <div className="field">
                    <label htmlFor="avc-scope-fund">{t('cap.avc.form.scopeFund.label')}</label>
                    <select id="avc-scope-fund" value={form.scopeValue} aria-invalid={fieldProblem('scope') !== undefined} onChange={(event) => change('scopeValue', event.target.value)}>
                      <option value="">{t('cap.avc.form.choose.option')}</option>
                      {(funds.data ?? []).map((fund) => (
                        <option key={fund.versionId} value={fund.businessKey}>
                          {fund.label}
                        </option>
                      ))}
                    </select>
                    {errorOf('scope') === undefined ? null : (
                      <small role="alert" className="field-error">
                        {errorOf('scope')}
                      </small>
                    )}
                  </div>
                ) : null}
                {form.scopeKind === 'PROJECT_GROUP' ? (
                  <div className="field">
                    <label htmlFor="avc-scope-group">{t('cap.avc.form.scopeGroup.label')}</label>
                    <select id="avc-scope-group" value={form.scopeValue} aria-invalid={fieldProblem('scope') !== undefined} onChange={(event) => change('scopeValue', event.target.value)}>
                      <option value="">{t('cap.avc.form.choose.option')}</option>
                      {PROJECT_GROUPS.map((group) => (
                        <option key={group} value={group}>
                          {group}
                        </option>
                      ))}
                    </select>
                    {errorOf('scope') === undefined ? null : (
                      <small role="alert" className="field-error">
                        {errorOf('scope')}
                      </small>
                    )}
                  </div>
                ) : null}
                <div className="field">
                  <label htmlFor="avc-object">{t('cap.avc.form.object.label')}</label>
                  <select id="avc-object" value={form.controlObject} onChange={(event) => change('controlObject', event.target.value as ControlObject)}>
                    {CONTROL_OBJECTS.map((object) => (
                      <option key={object} value={object}>
                        {objectLabel(t, object)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="avc-warn">{t('cap.avc.form.warn.label')}</label>
                  <input id="avc-warn" inputMode="decimal" value={form.warnPct} aria-invalid={fieldProblem('warnPct') !== undefined} onChange={(event) => change('warnPct', event.target.value)} />
                  {errorOf('warnPct') === undefined ? null : (
                    <small role="alert" className="field-error">
                      {errorOf('warnPct')}
                    </small>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="avc-block">{t('cap.avc.form.block.label')}</label>
                  <input id="avc-block" inputMode="decimal" value={form.blockPct} aria-invalid={fieldProblem('blockPct') !== undefined} onChange={(event) => change('blockPct', event.target.value)} />
                  {errorOf('blockPct') === undefined ? null : (
                    <small role="alert" className="field-error">
                      {errorOf('blockPct')}
                    </small>
                  )}
                </div>
              </div>
              <div className="avc-bars" data-testid="avc-bars">
                <div
                  className="avc-bar"
                  role="img"
                  aria-label={t('cap.avc.bars.aria', {
                    warn: form.warnPct,
                    block: form.blockPct,
                  })}
                >
                  <span className="avc-zone avc-ok" style={{ width: `${bars.warn}%` }} />
                  <span className="avc-zone avc-warn" style={{ width: `${Math.max(0, bars.block - bars.warn)}%` }} />
                  <span className="avc-zone avc-block" style={{ width: `${Math.max(0, 100 - bars.block)}%` }} />
                </div>
                <ul className="avc-legend">
                  <li>{t('cap.avc.bars.ok', { warn: form.warnPct })}</li>
                  <li>
                    {t('cap.avc.bars.warn', {
                      warn: form.warnPct,
                      block: form.blockPct,
                    })}
                  </li>
                  <li>{t('cap.avc.bars.block', { block: form.blockPct })}</li>
                </ul>
              </div>
              <div className="check">
                <input id="avc-reservations" type="checkbox" checked={form.includeReservations} onChange={(event) => change('includeReservations', event.target.checked)} />
                <label htmlFor="avc-reservations">{t('cap.avc.form.reservations.label')}</label>
              </div>
              <div className="formgrid">
                <div className="field">
                  <label htmlFor="avc-basis">{t('cap.avc.form.basis.label')}</label>
                  <textarea
                    id="avc-basis"
                    rows={2}
                    maxLength={MAX_LEGAL_BASIS}
                    value={form.legalBasis}
                    aria-invalid={fieldProblem('legalBasis') !== undefined}
                    onChange={(event) => change('legalBasis', event.target.value)}
                  />
                  {errorOf('legalBasis') === undefined ? null : (
                    <small role="alert" className="field-error">
                      {errorOf('legalBasis')}
                    </small>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="avc-from">{t('cap.avc.form.from.label')}</label>
                  <input id="avc-from" type="date" value={form.effectiveFrom} aria-invalid={fieldProblem('effectiveFrom') !== undefined} onChange={(event) => change('effectiveFrom', event.target.value)} />
                  {errorOf('effectiveFrom') === undefined ? null : (
                    <small role="alert" className="field-error">
                      {errorOf('effectiveFrom')}
                    </small>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="avc-until">{t('cap.avc.form.until.label')}</label>
                  <input id="avc-until" type="date" value={form.effectiveUntil} aria-invalid={fieldProblem('effectiveUntil') !== undefined} onChange={(event) => change('effectiveUntil', event.target.value)} />
                  {errorOf('effectiveUntil') === undefined ? null : (
                    <small role="alert" className="field-error">
                      {errorOf('effectiveUntil')}
                    </small>
                  )}
                </div>
              </div>
              <StickyActions
                primary={
                  <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending}>
                    {t('cap.avc.form.submit.action')}
                  </button>
                }
                secondary={[
                  <button key="reset" type="button" className="ui-button ui-button--outline" onClick={() => setForm(EMPTY_FORM)}>
                    {t('cap.avc.form.reset.action')}
                  </button>,
                ]}
              />
            </form>
          ) : (
            <p className="callout warning" role="status">
              {frozen ? t('cap.avc.frozen.notice') : t('cap.avc.form.denied')}
            </p>
          )}
        </SectionCard>

        <SectionCard title={t('cap.avc.preview.title')}>
          <p className="callout">{t('cap.avc.preview.rule')}</p>
          {chosenPolicy === undefined ? (
            <p className="sub">{t('cap.avc.preview.none')}</p>
          ) : (
            <div data-testid="preview" data-policy-id={chosenPolicy.id}>
              <label htmlFor="avc-preview-policy">{t('cap.avc.preview.select.label')}</label>
              <select id="avc-preview-policy" value={chosenPolicy.id} onChange={(event) => setChosen(event.target.value)}>
                {rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {t('cap.avc.row.code', {
                      code: row.policyCode,
                      revision: row.revision,
                    })}{' '}
                    ({statusLabel(t, row.status)})
                  </option>
                ))}
              </select>
              {preview.isLoading ? (
                <p className="sub" role="status">
                  {t('cap.avc.preview.loading')}
                </p>
              ) : preview.isError ? (
                <p className="callout warning" role="status">
                  {t('cap.avc.preview.denied')}
                </p>
              ) : preview.data === undefined ? null : (
                <ul className="avc-counts">
                  <li data-state="total">
                    {t('cap.avc.preview.total', {
                      count: preview.data.total,
                      counted: countedLabel(t, preview.data.controlObject),
                    })}
                  </li>
                  <li data-state="ok">{t('cap.avc.preview.ok', { count: preview.data.ok })}</li>
                  <li data-state="warn">{t('cap.avc.preview.warn', { count: preview.data.warn })}</li>
                  <li data-state="block">{t('cap.avc.preview.block', { count: preview.data.block })}</li>
                </ul>
              )}
            </div>
          )}
        </SectionCard>
      </div>
      <p className="prototype-note">{t('cap.avc.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
