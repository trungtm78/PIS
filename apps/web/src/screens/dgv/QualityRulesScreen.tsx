import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from './components';
import { NO_FILTER, useCatalog } from './hooks';
import { useApproveRule, useCreateRule, useQualityRules } from './quality-hooks';
import { actionLabel, comparatorLabel, dimensionLabel, operatorLabel, qualityProblemMessage, ruleProblemMessage, ruleStatusLabel, severityLabel } from './quality-labels';
import {
  ACTIONS,
  COMPARATORS,
  EMPTY_RULE_FORM,
  OPERATORS_BY_DIMENSION,
  QUALITY_APPROVE_PERMISSION,
  QUALITY_MANAGE_PERMISSION,
  RULE_READ_PERMISSION,
  SEVERITIES,
  WRITABLE_DIMENSIONS,
  buildRuleBody,
  describeQualityProblem,
  expressionSummary,
  validateRule,
  withDimension,
} from './quality-model';
import type { Comparator, Operator, RuleErrors, RuleField, RuleForm, RuleTextField, RuleView, Severity, WritableDimension } from './quality-model';
import './dgv-kit.css';

const NEVER_EMPTY = (): boolean => false;
const DATASET_PARAM = 'dataset';

/**
 * DGV-06: the quality rules of a dataset. A steward writes a rule in the operators the dimension allows, with a threshold and an action
 * on failure; another person approves it, and the rule version never changes after that (ST-DGV-002, DGV 3.3 F3). The server judges every
 * rule again: an expression it does not allow, or a threshold it cannot judge, is refused with a reason shown here.
 */
export default function QualityRulesScreen({ route }: ScreenProps) {
  const tenantId = useSession().tenant?.id;
  // The chosen dataset and the open form belong to one tenant: a switch starts the screen over.
  return <RulesContent key={tenantId ?? 'none'} route={route} />;
}

function RulesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const writable = mode !== 'READ_ONLY';
  const [params, setParams] = useSearchParams();
  const datasetId = params.get(DATASET_PARAM) ?? undefined;
  const catalog = useCatalog(NO_FILTER);
  const readable = holds(RULE_READ_PERMISSION);
  const rules = useQualityRules(datasetId, readable);
  const state = useScreenState({ isLoading: rules.isLoading, error: rules.error, data: rules.data, isEmpty: NEVER_EMPTY });
  const datasets = catalog.data ?? [];
  const chosen = datasets.find((item) => item.id === datasetId);
  const mayManage = holds(QUALITY_MANAGE_PERMISSION) && writable;
  const mayApprove = holds(QUALITY_APPROVE_PERMISSION) && writable;
  const choose = (id: string): void => setParams(id === '' ? {} : { [DATASET_PARAM]: id });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.rules.page.title')}</h1>
          <p>{t('dgv.rules.page.subtitle')}</p>
        </div>
      </div>
      <div className="card">
        <Field id="rules-dataset" label={t('dgv.rules.dataset.label')} error={undefined}>
          <select id="rules-dataset" value={datasetId ?? ''} onChange={(event) => choose(event.target.value)}>
            <option value="">{t('dgv.rules.dataset.placeholder')}</option>
            {datasets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} ({item.datasetCode})
              </option>
            ))}
          </select>
        </Field>
      </div>
      {datasetId === undefined ? (
        <p className="muted" data-testid="choose-dataset">
          {t('dgv.rules.choose.text')}
        </p>
      ) : !readable ? (
        <p className="callout warning" role="alert" data-testid="rules-unreadable">
          {t('dgv.rules.unreadable.text')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void rules.refetch()}>
          <RuleList rules={rules.data ?? []} mayApprove={mayApprove} me={tenant?.membershipId} />
          {mayManage ? <CreateRule contractId={chosen?.workingContractId ?? null} /> : null}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('dgv.rules.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function RuleList({ rules, mayApprove, me }: { rules: RuleView[]; mayApprove: boolean; me: string | undefined }) {
  const { t } = useTranslation();
  return (
    <div className="card">
      <h2>{t('dgv.rules.list.title')}</h2>
      {rules.length === 0 ? (
        <p className="muted" data-testid="empty-rules">
          {t('dgv.rules.empty.text')}
        </p>
      ) : (
        <table className="table" aria-label={t('dgv.rules.table.aria')}>
          <thead>
            <tr>
              <th>{t('dgv.rules.code.column')}</th>
              <th>{t('dgv.rules.dimension.column')}</th>
              <th>{t('dgv.rules.field.column')}</th>
              <th>{t('dgv.rules.expression.column')}</th>
              <th>{t('dgv.rules.threshold.column')}</th>
              <th>{t('dgv.rules.action.column')}</th>
              <th>{t('dgv.rules.weight.column')}</th>
              <th>{t('dgv.rules.status.column')}</th>
              <th>{t('dgv.rules.people.column')}</th>
              <th>
                <span className="sr-only">{t('dgv.rules.actions.column')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <RuleLine key={rule.id} rule={rule} mayApprove={mayApprove} own={me !== undefined && rule.createdBy === me} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RuleLine({ rule, mayApprove, own }: { rule: RuleView; mayApprove: boolean; own: boolean }) {
  const { t } = useTranslation();
  const approve = useApproveRule();
  const refused = approve.isError ? describeQualityProblem(approve.error) : undefined;
  const unknown = t('dgv.rules.person.unknown');
  return (
    <>
      <tr data-rule-id={rule.id} data-rule-code={rule.code} data-status={rule.status}>
        <td>
          {rule.code}
          <span className="sub">{t('dgv.score.rule.revision', { revision: rule.revision })}</span>
        </td>
        <td>{dimensionLabel(t, rule.dimension)}</td>
        <td>{rule.fieldPath ?? ''}</td>
        <td>
          <code>{expressionSummary(rule.expression)}</code>
        </td>
        <td>
          {t('dgv.score.rule.percent', { value: rule.minPassRate })}
          {rule.warnPassRate === null ? null : <span className="sub">{t('dgv.rules.threshold.warn', { value: rule.warnPassRate })}</span>}
        </td>
        <td>
          {actionLabel(t, rule.action)}
          <span className="sub">{severityLabel(t, rule.severity)}</span>
        </td>
        <td>{rule.weight}</td>
        <td>{ruleStatusLabel(t, rule.status)}</td>
        <td>
          {rule.createdByName ?? unknown}
          {rule.approvedByName === null ? null : <span className="sub">{t('dgv.rules.approvedBy.text', { name: rule.approvedByName })}</span>}
        </td>
        <td className="row-actions">
          {rule.status === 'DRAFT' && mayApprove && !own ? (
            <button type="button" className="ui-button ui-button--primary" disabled={approve.isPending} onClick={() => approve.mutate({ id: rule.id, version: rule.version })}>
              {t('dgv.rules.approve.action')}
            </button>
          ) : null}
          {rule.status === 'DRAFT' && mayApprove && own ? <span className="sub">{t('dgv.rules.approve.own.hint')}</span> : null}
        </td>
      </tr>
      {refused === undefined ? null : (
        <tr>
          <td colSpan={10}>
            <p className="callout warning" role="alert">
              {qualityProblemMessage(t, refused)}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

function CreateRule({ contractId }: { contractId: string | null }) {
  const { t } = useTranslation();
  const create = useCreateRule();
  const [form, setForm] = useState<RuleForm>(EMPTY_RULE_FORM);
  const [errors, setErrors] = useState<RuleErrors>({});
  const [saved, setSaved] = useState(false);
  const refused = create.isError ? describeQualityProblem(create.error) : undefined;
  const operators = OPERATORS_BY_DIMENSION[form.dimension];

  const setField = <Name extends RuleField>(field: Name, value: RuleForm[Name]): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    setSaved(false);
  };
  const error = (field: RuleField): string | undefined => {
    const own = errors[field];
    return own === undefined ? undefined : ruleProblemMessage(t, own);
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending || contractId === null) return;
    const found = validateRule(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(buildRuleBody(contractId, form), {
      onSuccess: () => {
        setForm(EMPTY_RULE_FORM);
        setSaved(true);
      },
    });
  };

  const text = (field: RuleTextField, id: string, label: string, hint?: string) => (
    <Field id={id} label={label} error={error(field)} {...(hint === undefined ? {} : { hint })}>
      <input id={id} value={form[field]} aria-invalid={error(field) !== undefined} onChange={(event) => setField(field, event.target.value)} />
    </Field>
  );
  const comparator = (
    <Field id="rule-comparator" label={t('dgv.rules.form.comparator.label')} error={undefined}>
      <select id="rule-comparator" value={form.comparator} onChange={(event) => setField('comparator', event.target.value as Comparator)}>
        {COMPARATORS.map((item) => (
          <option key={item} value={item}>
            {comparatorLabel(t, item)}
          </option>
        ))}
      </select>
    </Field>
  );
  const operator: Operator = form.operator;

  return (
    <form className="card" onSubmit={save} noValidate aria-label={t('dgv.rules.form.title')}>
      <h2>{t('dgv.rules.form.title')}</h2>
      {contractId === null ? (
        <p className="callout" role="status" data-testid="no-contract">
          {t('dgv.rules.form.noContract.text')}
        </p>
      ) : null}
      {refused === undefined ? null : (
        <p className="callout warning" role="alert">
          {qualityProblemMessage(t, refused)}
        </p>
      )}
      {saved ? (
        <p className="callout" role="status" data-testid="rule-saved">
          {t('dgv.rules.form.saved.notice')}
        </p>
      ) : null}
      <div className="formgrid">
        {text('code', 'rule-code', t('dgv.rules.form.code.label'))}
        <Field id="rule-dimension" label={t('dgv.rules.form.dimension.label')} error={undefined}>
          <select id="rule-dimension" value={form.dimension} onChange={(event) => setForm(withDimension(form, event.target.value as WritableDimension))}>
            {WRITABLE_DIMENSIONS.map((dimension) => (
              <option key={dimension} value={dimension}>
                {dimensionLabel(t, dimension)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="rule-operator" label={t('dgv.rules.form.operator.label')} error={undefined}>
          <select id="rule-operator" value={form.operator} onChange={(event) => setField('operator', event.target.value as Operator)}>
            {operators.map((item) => (
              <option key={item} value={item}>
                {operatorLabel(t, item)}
              </option>
            ))}
          </select>
        </Field>
        {operator === 'snapshot_age_within' ? null : text('field', 'rule-field', operator === 'unique' ? t('dgv.rules.form.fields.label') : t('dgv.rules.form.field.label'), operator === 'unique' ? t('dgv.rules.form.fields.hint') : undefined)}
        {operator === 'compare_fields' ? text('otherField', 'rule-other-field', t('dgv.rules.form.otherField.label')) : null}
        {operator === 'compare' || operator === 'compare_fields' ? comparator : null}
        {operator === 'compare' ? text('value', 'rule-value', t('dgv.rules.form.value.label')) : null}
        {operator === 'between' ? text('min', 'rule-min', t('dgv.rules.form.min.label')) : null}
        {operator === 'between' ? text('max', 'rule-max', t('dgv.rules.form.max.label')) : null}
        {operator === 'in' ? text('values', 'rule-values', t('dgv.rules.form.values.label'), t('dgv.rules.form.values.hint')) : null}
        {operator === 'snapshot_age_within' ? text('seconds', 'rule-seconds', t('dgv.rules.form.seconds.label')) : null}
        {text('minRate', 'rule-min-rate', t('dgv.rules.form.minRate.label'), form.dimension === 'INTEGRITY' ? t('dgv.rules.form.minRate.integrity') : undefined)}
        {text('warnRate', 'rule-warn-rate', t('dgv.rules.form.warnRate.label'), t('dgv.rules.form.warnRate.hint'))}
        <Field id="rule-severity" label={t('dgv.rules.form.severity.label')} error={undefined}>
          <select id="rule-severity" value={form.severity} onChange={(event) => setField('severity', event.target.value as Severity)}>
            {SEVERITIES.map((item) => (
              <option key={item} value={item}>
                {severityLabel(t, item)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="rule-action" label={t('dgv.rules.form.action.label')} error={undefined}>
          <select id="rule-action" value={form.action} onChange={(event) => setField('action', event.target.value as RuleForm['action'])}>
            {ACTIONS.filter((item) => form.dimension !== 'INTEGRITY' || item !== 'WARN').map((item) => (
              <option key={item} value={item}>
                {actionLabel(t, item)}
              </option>
            ))}
          </select>
        </Field>
        {text('weight', 'rule-weight', t('dgv.rules.form.weight.label'), t('dgv.rules.form.weight.hint'))}
      </div>
      <div className="formfooter">
        <span className="sub">{t('dgv.rules.form.hint.text')}</span>
        <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending || contractId === null}>
          {t('dgv.rules.form.save.action')}
        </button>
      </div>
    </form>
  );
}
