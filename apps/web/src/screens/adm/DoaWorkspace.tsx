import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import type { WebRoute } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { AuditLine, DataTable, MakerCheckerBadge, SectionCard, StatusPill, StickyActions } from '../../ui';
import type { DataTableColumn } from '../../ui';
import { BandChart } from './doa/BandChart';
import { resolveDoa, unitPathsOf } from './doa/engine';
import type { DoaMatrixRecord } from './doa/engine';
import { useCreateMatrixDraft, useDecideMatrix, useSubmitMatrix, useUpdateMatrixDraft } from './doa/hooks';
import type { DecisionKind, RoleOption } from './doa/hooks';
import { fieldMessage, findingMessage, previewFailureMessage, problemMessage, statusLabel, statusTone } from './doa/labels';
import {
  APPROVE_DOA_PERMISSION,
  LEVELS,
  MANAGE_DOA_PERMISSION,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  bandProblems,
  describeProblem,
  emptyValues,
  hasErrors,
  inputsOf,
  matrixBody,
  newRule,
  validateForm,
  valuesOfMatrix,
} from './doa/model';
import type { DoaMatrixView, DoaValues, HeaderErrors, RuleErrors, RuleValue } from './doa/model';
import type { OrgUnit } from './org-tree/types';
import './adm-kit.css';
import './doa/doa.css';

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

const shortId = (id: string): string => id.slice(0, 8);
const VIETNAM_ZONE = 'Asia/Ho_Chi_Minh';
/** Today in Vietnam, as the first day a new matrix would start. */
const todayInVietnam = (): string => new Date().toLocaleDateString('en-CA', { timeZone: VIETNAM_ZONE });

type Panel = { id: string; kind: 'submit' | DecisionKind };

export interface DoaWorkspaceProps {
  route: WebRoute;
  /** The versions of the matrix with their rules, as the version reads return them. */
  matrices: readonly DoaMatrixView[];
  /** The organisation units rules can name. */
  units: readonly OrgUnit[];
  /** The roles that can approve. */
  roles: readonly RoleOption[];
}

/**
 * ADM-15: the delegation-of-authority matrix (ST-ADM-011). A draft is written as a table of bands (a kind of document, a unit, an
 * amount range, who approves through how many levels) with the bands drawn beside it, so a gap or an overlap is seen before the
 * matrix is submitted; a second person approves it and it becomes the matrix in force from its first day. The preview says who
 * approves a document under the matrix in view, so a misconfiguration is seen before it blocks a file.
 */
export function DoaWorkspace(props: DoaWorkspaceProps) {
  const tenantId = useSession().tenant?.id;
  // Everything the screen holds (the form, the open panel, the reason) belongs to one tenant: a switch starts it over.
  return <WorkspaceContent key={tenantId ?? 'none'} {...props} />;
}

function WorkspaceContent({ route, matrices, units, roles }: DoaWorkspaceProps) {
  const { t } = useTranslation();
  const { permissions, tenant, mode } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const canManage = (permissions === undefined || permissions.includes(MANAGE_DOA_PERMISSION)) && !frozen;
  const canApprove = (permissions === undefined || permissions.includes(APPROVE_DOA_PERMISSION)) && !frozen;
  const create = useCreateMatrixDraft();
  const update = useUpdateMatrixDraft();
  const submit = useSubmitMatrix();
  const decide = useDecideMatrix();
  const register = useMemo(() => [...matrices].sort((a, b) => b.revision - a.revision), [matrices]);
  const [values, setValues] = useState<DoaValues>(() => ({ ...emptyValues(), effectiveFrom: todayInVietnam() }));
  const [editing, setEditing] = useState<{ id: string; version: number } | undefined>(undefined);
  const [errors, setErrors] = useState<{ header: HeaderErrors; rows: RuleErrors }>({ header: {}, rows: [] });
  const [viewing, setViewing] = useState<string | undefined>(undefined);
  const [panel, setPanel] = useState<Panel | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const [saved, setSaved] = useState<string | undefined>(undefined);
  const [previewInput, setPreviewInput] = useState({ documentType: '', unitId: '', amount: '' });
  const inView = register.find((matrix) => matrix.id === viewing) ?? register.find((matrix) => matrix.status === 'Published') ?? register[0];
  const paths = useMemo(() => unitPathsOf(units), [units]);
  const unitLabel = (unitId: string): string => {
    const unit = units.find((entry) => entry.id === unitId);
    return unit === undefined ? unitId : `${unit.code} · ${unit.name}`;
  };
  const roleLabel = (roleId: string): string => roles.find((role) => role.id === roleId)?.code ?? roleId;
  const usableUnits = useMemo(() => units.filter((unit) => unit.status === 'Active' || unit.status === 'Planned'), [units]);
  const rules = useMemo(() => inputsOf(values), [values]);
  const problems = useMemo(() => bandProblems(values), [values]);
  const body = matrixBody(values);
  const unchanged = saved !== undefined && saved === JSON.stringify(body);
  const writeProblem = create.isError ? describeProblem(create.error) : update.isError ? describeProblem(update.error) : undefined;
  const rowProblem = submit.isError ? describeProblem(submit.error) : decide.isError ? describeProblem(decide.error) : undefined;
  const busy = create.isPending || update.isPending;

  const edit = (change: (current: DoaValues) => DoaValues): void => {
    setValues(change);
    setErrors({ header: {}, rows: [] });
  };
  const setRule = (key: number, changes: Partial<RuleValue>): void =>
    edit((current) => ({ ...current, rules: current.rules.map((rule) => (rule.key === key ? { ...rule, ...changes } : rule)) }));
  const addRule = (): void =>
    edit((current) => {
      const last = current.rules[current.rules.length - 1];
      // The next band continues the last one: same document type and unit, starting where it ends.
      return { ...current, rules: [...current.rules, last === undefined ? newRule() : newRule({ documentType: last.documentType, unitId: last.unitId, roleId: last.roleId, min: last.max.trim() === '' ? '' : last.max.trim() })] };
    });
  const removeRule = (key: number): void => edit((current) => ({ ...current, rules: current.rules.filter((rule) => rule.key !== key) }));

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || !canManage || unchanged) return;
    const found = validateForm(values);
    setErrors(found);
    if (hasErrors(found) || problems.draft.length > 0) return;
    const onSuccess = (): void => setSaved(JSON.stringify(body));
    if (editing === undefined) create.mutate(body, { onSuccess });
    // An update raises the version by one: the next save of the same draft carries it.
    else update.mutate({ id: editing.id, version: editing.version, body }, { onSuccess: () => { onSuccess(); setEditing({ id: editing.id, version: editing.version + 1 }); } });
  };

  const startFrom = (matrix: DoaMatrixView, inPlace: boolean): void => {
    setValues(valuesOfMatrix(matrix));
    setEditing(inPlace ? { id: matrix.id, version: matrix.version } : undefined);
    setErrors({ header: {}, rows: [] });
    setSaved(undefined);
  };

  const openPanel = (next: Panel): void => {
    setPanel(next);
    setReason('');
    setReasonError(false);
  };

  const confirmPanel = (event: FormEvent, matrix: DoaMatrixView): void => {
    event.preventDefault();
    if (panel === undefined || submit.isPending || decide.isPending) return;
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN_LENGTH || trimmed.length > REASON_MAX_LENGTH) {
      setReasonError(true);
      return;
    }
    const input = { id: matrix.id, version: matrix.version, reason: trimmed };
    const done = { onSuccess: () => setPanel(undefined) };
    if (panel.kind === 'submit') submit.mutate(input, done);
    else decide.mutate({ ...input, decision: panel.kind }, done);
  };

  const record: DoaMatrixRecord | undefined = inView === undefined ? undefined : { id: inView.id, status: 'Published', effectiveFrom: '0000-01-01', effectiveUntil: null, rules: inView.rules };
  const documentTypes = [...new Set((inView?.rules ?? []).map((rule) => rule.document_type))];
  const previewType = previewInput.documentType === '' ? (documentTypes[0] ?? '') : previewInput.documentType;
  const previewUnit = previewInput.unitId === '' ? (usableUnits[0]?.id ?? '') : previewInput.unitId;
  const preview =
    record === undefined || previewType === '' || previewUnit === ''
      ? undefined
      : resolveDoa([record], paths, { documentType: previewType, amountVnd: previewInput.amount.trim() === '' ? null : previewInput.amount.trim(), unitId: previewUnit, businessDate: todayInVietnam() });

  const header = (field: keyof HeaderErrors): string | undefined => {
    const own = errors.header[field];
    return own === undefined ? undefined : fieldMessage(t, own);
  };
  const rowError = (index: number, field: 'documentType' | 'unitId' | 'roleId'): string | undefined => {
    const own = errors.rows[index]?.[field];
    return own === undefined ? undefined : fieldMessage(t, own);
  };

  const periodOf = (matrix: DoaMatrixView): string =>
    matrix.effectiveUntil === null ? t('adm.doa.period.open', { from: matrix.effectiveFrom }) : t('adm.doa.period.closed', { from: matrix.effectiveFrom, until: matrix.effectiveUntil });
  const small = 'ui-button ui-button--outline ui-button--small';
  const columns: DataTableColumn<DoaMatrixView>[] = [
    {
      key: 'revision',
      header: t('adm.doa.col.revision'),
      pinned: true,
      render: (matrix) => (
        <span data-matrix-id={matrix.id} data-status={matrix.status} aria-current={inView?.id === matrix.id ? 'true' : undefined}>
          #{matrix.revision}
        </span>
      ),
    },
    { key: 'status', header: t('adm.doa.col.status'), render: (matrix) => <StatusPill tone={statusTone(matrix.status)}>{statusLabel(t, matrix.status)}</StatusPill> },
    { key: 'period', header: t('adm.doa.col.period'), render: periodOf },
    { key: 'basis', header: t('adm.doa.col.basis'), render: (matrix) => matrix.legalBasis },
    { key: 'rules', header: t('adm.doa.col.rules'), align: 'right', render: (matrix) => matrix.rules.length },
    {
      key: 'actions',
      header: t('adm.doa.col.actions'),
      render: (matrix) => {
        const ownWork = matrix.createdBy === tenant?.membershipId || matrix.lastEditedBy === tenant?.membershipId;
        return (
          <div className="row-actions">
            <button type="button" className={small} onClick={() => setViewing(matrix.id)}>
              {t('adm.doa.view.action')}
            </button>
            {canManage && matrix.status === 'Draft' ? (
              <button type="button" className={small} onClick={() => startFrom(matrix, true)}>
                {t('adm.doa.edit.action')}
              </button>
            ) : null}
            {canManage ? (
              <button type="button" className={small} onClick={() => startFrom(matrix, false)}>
                {t('adm.doa.copy.action')}
              </button>
            ) : null}
            {canManage && matrix.status === 'Draft' ? (
              <button type="button" className={small} onClick={() => openPanel({ id: matrix.id, kind: 'submit' })}>
                {t('adm.doa.submit.action')}
              </button>
            ) : null}
            {canApprove && matrix.status === 'PendingApproval' ? (
              <>
                <button type="button" className={small} disabled={ownWork} title={ownWork ? t('adm.doa.approve.selfApproval.hint') : undefined} onClick={() => openPanel({ id: matrix.id, kind: 'approve' })}>
                  {t('adm.doa.approve.action')}
                </button>
                <button type="button" className={small} onClick={() => openPanel({ id: matrix.id, kind: 'return' })}>
                  {t('adm.doa.return.action')}
                </button>
                <button type="button" className={small} onClick={() => openPanel({ id: matrix.id, kind: 'reject' })}>
                  {t('adm.doa.reject.action')}
                </button>
              </>
            ) : null}
            {panel?.id === matrix.id && (panel.kind === 'submit' ? canManage : canApprove) ? (
              <form onSubmit={(event) => confirmPanel(event, matrix)} noValidate aria-label={t('adm.doa.panel.title')}>
                <Field id={`panel-reason-${matrix.id}`} label={t('adm.doa.panel.reason.label')} error={reasonError ? t('adm.doa.field.required') : undefined}>
                  <input
                    id={`panel-reason-${matrix.id}`}
                    value={reason}
                    aria-invalid={reasonError}
                    onChange={(event) => {
                      setReason(event.target.value);
                      setReasonError(false);
                    }}
                  />
                </Field>
                <div className="row-actions">
                  <button type="submit" className="ui-button ui-button--primary ui-button--small" disabled={submit.isPending || decide.isPending}>
                    {t('adm.doa.panel.confirm.action')}
                  </button>
                  <button type="button" className={small} onClick={() => setPanel(undefined)}>
                    {t('adm.doa.panel.cancel.action')}
                  </button>
                </div>
              </form>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('adm.doa.page.title')}</h1>
          <p>{t('adm.doa.page.lead')}</p>
        </div>
      </div>
      <div className="adm-doa">
        <SectionCard title={editing === undefined ? t('adm.doa.form.title') : t('adm.doa.form.editing.title')}>
          <div data-testid="editor">
          {!canManage ? (
            <p className="callout warning" role="status">
              {frozen ? t('adm.doa.frozen.notice') : t('adm.doa.readOnly.notice')}
            </p>
          ) : null}
          {saved !== undefined && unchanged ? (
            <p className="callout" role="status">
              {t('adm.doa.draft.accepted.notice')}
            </p>
          ) : null}
          {writeProblem === undefined ? null : (
            <div className="callout warning" role="alert">
              <p>{problemMessage(t, writeProblem)}</p>
              {writeProblem.findings.length === 0 ? null : (
                <ul>
                  {writeProblem.findings.map((finding, index) => (
                    <li key={index}>{findingMessage(t, finding)}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <form onSubmit={save} noValidate aria-label={t('adm.doa.form.title')}>
            <h3>{t('adm.doa.rules.title')}</h3>
            {header('rules') === undefined ? null : (
              <small role="alert" className="field-error">
                {header('rules')}
              </small>
            )}
            <div className="adm-kit-scroll" role="region" aria-label={t('adm.doa.rules.title')} tabIndex={0}>
            <table className="table doa-rules" data-testid="rule-rows">
              <thead>
                <tr>
                  <th>{t('adm.doa.rule.documentType.label')}</th>
                  <th>{t('adm.doa.rule.appliedUnit.label')}</th>
                  <th>{t('adm.doa.rule.subtree.label')}</th>
                  <th>{t('adm.doa.rule.min.label')}</th>
                  <th>{t('adm.doa.rule.max.label')}</th>
                  <th>{t('adm.doa.rule.role.label')}</th>
                  <th>{t('adm.doa.rule.approvalLevels.label')}</th>
                  <th>{t('adm.doa.rule.distinct.label')}</th>
                  <th>
                    <span className="sr-only">{t('adm.doa.col.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {values.rules.map((rule, index) => (
                  <tr key={rule.key} data-rule-row={index + 1}>
                    <td>
                      <input aria-label={t('adm.doa.rule.documentType.row', { row: index + 1 })} value={rule.documentType} disabled={!canManage} aria-invalid={rowError(index, 'documentType') !== undefined} onChange={(event) => setRule(rule.key, { documentType: event.target.value })} />
                      {rowError(index, 'documentType') === undefined ? null : <small role="alert" className="field-error">{rowError(index, 'documentType')}</small>}
                    </td>
                    <td>
                      <select aria-label={t('adm.doa.rule.unit.row', { row: index + 1 })} value={rule.unitId} disabled={!canManage} aria-invalid={rowError(index, 'unitId') !== undefined} onChange={(event) => setRule(rule.key, { unitId: event.target.value })}>
                        <option value="">{t('adm.doa.rule.unit.placeholder')}</option>
                        {usableUnits.map((unit) => (
                          <option key={unit.id} value={unit.id}>
                            {unitLabel(unit.id)}
                          </option>
                        ))}
                      </select>
                      {rowError(index, 'unitId') === undefined ? null : <small role="alert" className="field-error">{rowError(index, 'unitId')}</small>}
                    </td>
                    <td>
                      <input type="checkbox" aria-label={t('adm.doa.rule.subtree.row', { row: index + 1 })} checked={rule.includeSubtree} disabled={!canManage} onChange={(event) => setRule(rule.key, { includeSubtree: event.target.checked })} />
                    </td>
                    <td>
                      <input inputMode="numeric" aria-label={t('adm.doa.rule.min.row', { row: index + 1 })} value={rule.min} disabled={!canManage} onChange={(event) => setRule(rule.key, { min: event.target.value })} />
                    </td>
                    <td>
                      <input inputMode="numeric" aria-label={t('adm.doa.rule.max.row', { row: index + 1 })} placeholder={t('adm.doa.chart.noEnd')} value={rule.max} disabled={!canManage} onChange={(event) => setRule(rule.key, { max: event.target.value })} />
                    </td>
                    <td>
                      <select aria-label={t('adm.doa.rule.role.row', { row: index + 1 })} value={rule.roleId} disabled={!canManage} aria-invalid={rowError(index, 'roleId') !== undefined} onChange={(event) => setRule(rule.key, { roleId: event.target.value })}>
                        <option value="">{t('adm.doa.rule.role.placeholder')}</option>
                        {roles.map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.code}
                          </option>
                        ))}
                      </select>
                      {rowError(index, 'roleId') === undefined ? null : <small role="alert" className="field-error">{rowError(index, 'roleId')}</small>}
                    </td>
                    <td>
                      <select aria-label={t('adm.doa.rule.levels.row', { row: index + 1 })} value={rule.levels} disabled={!canManage} onChange={(event) => setRule(rule.key, { levels: Number(event.target.value) })}>
                        {LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input type="checkbox" aria-label={t('adm.doa.rule.distinct.row', { row: index + 1 })} checked={rule.distinct} disabled={!canManage} onChange={(event) => setRule(rule.key, { distinct: event.target.checked })} />
                    </td>
                    <td className="row-actions">
                      {canManage ? (
                        <button type="button" className="ui-button ui-button--outline ui-button--small" aria-label={t('adm.doa.rule.remove.row', { row: index + 1 })} onClick={() => removeRule(rule.key)}>
                          {t('adm.doa.rule.remove.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {canManage ? (
              <button type="button" className="ui-button ui-button--outline" onClick={addRule}>
                {t('adm.doa.rules.add.action')}
              </button>
            ) : null}
            {/* The period and the basis of the matrix come after its bands, in the order of the catalogue (ADM-15). */}
            <div className="formgrid">
              <Field id="doa-from" label={t('adm.doa.effectiveFrom.label')} error={header('effectiveFrom')}>
                <input id="doa-from" type="date" value={values.effectiveFrom} disabled={!canManage} aria-invalid={header('effectiveFrom') !== undefined} onChange={(event) => { const { value } = event.target; edit((current) => ({ ...current, effectiveFrom: value })); }} />
              </Field>
              <Field id="doa-until" label={t('adm.doa.effectiveUntil.label')} error={header('effectiveUntil')} hint={t('adm.doa.effectiveUntil.hint')}>
                <input id="doa-until" type="date" value={values.effectiveUntil} disabled={!canManage} aria-invalid={header('effectiveUntil') !== undefined} onChange={(event) => { const { value } = event.target; edit((current) => ({ ...current, effectiveUntil: value })); }} />
              </Field>
            </div>
            <Field id="doa-basis" label={t('adm.doa.basis.label')} error={header('legalBasis')}>
              <input id="doa-basis" value={values.legalBasis} disabled={!canManage} aria-invalid={header('legalBasis') !== undefined} onChange={(event) => { const { value } = event.target; edit((current) => ({ ...current, legalBasis: value })); }} />
            </Field>
            <h3>{t('adm.doa.chart.title')}</h3>
            <BandChart rules={rules} unitLabel={unitLabel} roleLabel={roleLabel} />
            <div data-testid="blockers" aria-live="polite">
              {problems.submit.length === 0 ? (
                <p className="callout" role="status">
                  {t('adm.doa.blockers.none')}
                </p>
              ) : (
                <div className="callout warning">
                  <p>{t('adm.doa.blockers.title')}</p>
                  <ul>
                    {problems.submit.map((finding, index) => (
                      <li key={index} data-code={finding.code}>
                        {findingMessage(t, finding)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <p className="adm-kit-sub">{t('adm.doa.form.hint')}</p>
            {canManage ? (
              <StickyActions
                primary={
                  <button type="submit" className="ui-button ui-button--primary" disabled={busy || unchanged}>
                    {editing === undefined ? t('adm.doa.draft.save.action') : t('adm.doa.draft.update.action')}
                  </button>
                }
              />
            ) : null}
          </form>
          </div>
        </SectionCard>
        <SectionCard title={t('adm.doa.versions.title')}>
          <div data-testid="versions" className="adm-kit-stack">
          {register.length === 0 ? <p className="muted">{t('adm.doa.versions.empty')}</p> : null}
          {rowProblem === undefined ? null : (
            <div className="callout warning" role="alert">
              <p>{problemMessage(t, rowProblem)}</p>
              {rowProblem.findings.length === 0 ? null : (
                <ul>
                  {rowProblem.findings.map((finding, index) => (
                    <li key={index}>{findingMessage(t, finding)}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {submit.isSuccess ? (
            <p className="callout" role="status">
              {t('adm.doa.submit.accepted.notice')}
            </p>
          ) : null}
          {decide.isSuccess ? (
            <p className="callout" role="status">
              {t('adm.doa.decision.accepted.notice')}
            </p>
          ) : null}
          {register.length === 0 ? null : <DataTable caption={t('w2adm.doa.table.caption')} columns={columns} rows={[...register]} rowKey={(matrix) => matrix.id} rowAttrs={(matrix) => ({ 'data-matrix-id': matrix.id, 'data-status': matrix.status, 'aria-current': inView?.id === matrix.id ? 'true' : undefined })} />}
          {inView === undefined ? null : (
            <div data-testid="matrix-in-view" data-matrix-id={inView.id}>
              <h3>{t('adm.doa.inView.title', { revision: inView.revision })}</h3>
              <AuditLine
                items={[
                  { label: t('adm.doa.col.revision'), value: `#${inView.revision}` },
                  { label: t('adm.doa.col.period'), value: periodOf(inView) },
                  ...(inView.publishedAt === null ? [] : [{ label: t('w2adm.doa.audit.publishedAt'), value: inView.publishedAt.slice(0, 10) }]),
                ]}
              />
              <MakerCheckerBadge maker={shortId(inView.createdBy)} checker={inView.approvedBy === null ? null : shortId(inView.approvedBy)} />
              <BandChart rules={inView.rules} unitLabel={unitLabel} roleLabel={roleLabel} />
              <h4>{t('adm.doa.preview.title')}</h4>
              <div className="formgrid" data-testid="preview">
                <Field id="preview-type" label={t('adm.doa.preview.documentType.label')} error={undefined}>
                  <select id="preview-type" value={previewType} onChange={(event) => setPreviewInput((current) => ({ ...current, documentType: event.target.value }))}>
                    {documentTypes.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id="preview-unit" label={t('adm.doa.preview.unit.label')} error={undefined}>
                  <select id="preview-unit" value={previewUnit} onChange={(event) => setPreviewInput((current) => ({ ...current, unitId: event.target.value }))}>
                    {usableUnits.map((unit) => (
                      <option key={unit.id} value={unit.id}>
                        {unitLabel(unit.id)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id="preview-amount" label={t('adm.doa.preview.amount.label')} error={undefined} hint={t('adm.doa.preview.amount.hint')}>
                  <input id="preview-amount" inputMode="numeric" value={previewInput.amount} onChange={(event) => setPreviewInput((current) => ({ ...current, amount: event.target.value }))} />
                </Field>
              </div>
              {preview === undefined ? (
                <p className="muted">{t('adm.doa.preview.empty')}</p>
              ) : preview.ok ? (
                <p className="callout" role="status" data-testid="preview-result">
                  {t('adm.doa.preview.result', {
                    role: roleLabel(preview.resolution.approverRoleId),
                    levels: preview.resolution.approvalLevels,
                    unit: unitLabel(preview.resolution.ruleUnitId),
                  })}{' '}
                  {preview.resolution.requiresDistinctApprovers ? t('adm.doa.preview.distinct.yes') : t('adm.doa.preview.distinct.no')}
                </p>
              ) : (
                <p className="callout warning" role="status" data-testid="preview-result">
                  {previewFailureMessage(t, preview.failure)}
                </p>
              )}
            </div>
          )}
          </div>
        </SectionCard>
      </div>
      <p className="prototype-note">{t('adm.doa.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
