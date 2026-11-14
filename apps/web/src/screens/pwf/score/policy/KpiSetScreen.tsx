import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../../i18n';
import type { ScreenProps } from '../../../../routes/types';
import { useSession } from '../../../../session/SessionContext';
import { StateBoundary } from '../../../../states/StateBoundary';
import { useScreenState } from '../../../../states/useScreenState';
import { SectionCard } from '../../../../ui';
import { useCatalogue, useEffective } from '../../../adm/governance/hooks';
import type { RuleTypeEntry } from '../../../adm/governance/model';
import { FigureInfo, UnverifiedLabel } from '../../components';
import { PATHS, PERMISSIONS, RULE_PERMISSIONS, holds } from '../../model';
import { RuleSavePanel, RuleVersionList } from '../../templates/store';
import { useKpiOperations, useScoreCacheGuard } from '../hooks';
import { SCORE_PATHS } from '../model';
import { SupportNotice } from '../components';
import { directionWord, operationWord, unitOfValueWord } from '../labels';
import { CurvePreview } from './CurvePreview';
import { RuleField, RuleSelect } from './RuleField';
import {
  AGAINST_CHOICES,
  DEFAULT_KPI_SET_CODE,
  KINDS,
  KPI_DEFINITION_TYPE,
  KPI_SET_RULE_TYPE,
  MAX_ITEMS,
  MAX_STEPS,
  OPERATIONS,
  RAG_THRESHOLDS_TYPE,
  UNIT_CHOICES,
  WORKFLOW_TEMPLATE_TYPE,
  addItem,
  addStep,
  blankForm,
  formOf,
  operationOf,
  paramNames,
  paramsOf,
  problemsOf,
  removeItem,
  removeStep,
  updateItem,
  updateScale,
  updateStep,
} from './kpi-set-model';
import type { ItemForm, KpiSetForm, References } from './kpi-set-model';
import { CODE } from './rule-model';
import type { RuleProblems } from './rule-model';
import '../../pwf.css';
import '../../templates/templates.css';
import '../score.css';

const codesOf = (catalogue: readonly RuleTypeEntry[] | undefined, ruleType: string): string[] | undefined => {
  const entry = catalogue?.find((one) => one.ruleType === ruleType);
  return entry === undefined ? undefined : entry.codes.map((code) => code.code);
};

/**
 * PWF-09: the KPI set of a workflow. An item picks an operation of the closed catalogue, the code of the KPI register it is called by, a scale that turns the value into a score (with the curve in front of the author) and a
 * weight; the set only points at the register and at the RAG lines, it never defines a formula (R37). A draft goes into the rule store and a different person approves it.
 */
export default function KpiSetScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <SetContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SetContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const [params, setParams] = useSearchParams();
  useScoreCacheGuard();
  const code = params.get('code') ?? DEFAULT_KPI_SET_CODE;
  const mayRead = holds(permissions, PERMISSIONS.read);
  const writable = mode !== 'READ_ONLY';
  const canStore = writable && (permissions === undefined || permissions.includes(RULE_PERMISSIONS.manage));
  const canApprove = writable && (permissions === undefined || permissions.includes(RULE_PERMISSIONS.approve));
  const codeValid = CODE.test(code);
  const effective = useEffective(KPI_SET_RULE_TYPE, codeValid ? code : undefined, undefined, mayRead && codeValid);
  const catalogue = useCatalogue(mayRead);
  const operations = useKpiOperations(mayRead);
  const [edited, setEdited] = useState<KpiSetForm | undefined>(undefined);
  const [attempted, setAttempted] = useState(false);
  const base = useMemo(() => (effective.data === null || effective.data === undefined ? blankForm() : formOf(effective.data.params)), [effective.data]);
  const form = edited ?? base;
  const references = useMemo<References>(() => ({ kpiCodes: codesOf(catalogue.data, KPI_DEFINITION_TYPE), ragCodes: codesOf(catalogue.data, RAG_THRESHOLDS_TYPE), templateCodes: codesOf(catalogue.data, WORKFLOW_TEMPLATE_TYPE) }), [catalogue.data]);
  const problems = useMemo(() => problemsOf(form, references, operations.data?.items), [form, references, operations.data]);
  const show = attempted || edited !== undefined;
  const state = useScreenState({ isLoading: effective.isLoading, error: effective.error, data: effective.isLoading ? undefined : true, isEmpty: () => false });
  const screenState = !mayRead ? 'denied' : state;
  const set = (next: KpiSetForm): void => setEdited(next);
  const unverified = effective.data?.unverified === true;
  const setCodes = codesOf(catalogue.data, KPI_SET_RULE_TYPE) ?? [];
  const baseNote = effective.data === null || effective.data === undefined ? t('pwfs.kpiset.base.blank') : effective.data.source === 'RULE' ? t('pwfs.kpiset.base.rule', { version: effective.data.version }) : t('pwfs.kpiset.base.default');

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwfs.kpiset.title.text')}</h1>
          <p>{t('pwfs.kpiset.subtitle.text')}</p>
        </div>
        <nav aria-label={t('pwfs.kpiset.links.label')}>
          <Link to={PATHS.editor} data-testid="link-template">
            {t('pwfs.kpiset.template.link')}
          </Link>
        </nav>
      </div>
      <SupportNotice />
      <StateBoundary state={screenState} onRetry={() => void effective.refetch()}>
        {canStore ? null : (
          <p className="callout" role="status" data-testid="read-only">
            {t('pwfs.kpiset.readOnly.text')}
          </p>
        )}
        <SectionCard title={t('pwfs.kpiset.code.title')} status={unverified ? <UnverifiedLabel /> : undefined}>
          <div className="pwf-tpl-row">
            <RuleField
              label={t('pwfs.kpiset.code.label')}
              path="code"
              value={code}
              disabled={false}
              show
              problems={codeValid ? [] : [{ path: 'code', kind: 'pattern' }]}
              suggestions={setCodes}
              onChange={(value) => {
                setParams({ code: value.trim().toUpperCase() });
                setEdited(undefined);
                setAttempted(false);
              }}
            />
            <RuleField label={t('pwfs.kpiset.template.label')} path="template_code" value={form.templateCode} disabled={!canStore} show={show} problems={problems} suggestions={references.templateCodes} hint={t('pwfs.kpiset.template.hint')} onChange={(templateCode) => set({ ...form, templateCode })} />
          </div>
          <p className="adm-kit-sub" data-testid="base-note">
            {baseNote}
          </p>
          <div className="pwf-figure">
            <span>{t('fix9.pwf09.reference.note')}</span>
            <FigureInfo name={t('pwfs.kpiset.title.text')} formula={t('pwfs.kpiset.info.formula')} source={t('pwfs.kpiset.info.source')} asOf={null} version={t('pwfs.kpiset.info.version')} />
          </div>
        </SectionCard>
        <StateBoundary state={effective.isLoading ? 'loading' : 'default'}>
          <SectionCard title={t('pwfs.kpiset.items.title')} status={<span data-testid="item-count">{t('pwfs.kpiset.items.count', { count: form.items.length, max: MAX_ITEMS })}</span>}>
            <ol className="pwf-tpl-rows" data-testid="items">
              {form.items.map((item, index) => (
                <li key={index}>
                  <ItemEditor form={form} index={index} item={item} problems={problems} show={show} disabled={!canStore} references={references} onChange={set} operations={operations.data?.items} />
                </li>
              ))}
            </ol>
            <p className="pwfs-actions">
              <button type="button" className="ui-button ui-button--outline" disabled={!canStore || form.items.length >= MAX_ITEMS} data-action="add-item" onClick={() => set(addItem(form))}>
                {t('pwfs.kpiset.item.add.action')}
              </button>
            </p>
          </SectionCard>
        </StateBoundary>
        {canStore ? <RuleSavePanel ruleType={KPI_SET_RULE_TYPE} code={code} codeValid={codeValid} formOk={problems.length === 0} params={() => paramsOf(form)} onAttempt={() => setAttempted(true)} disabled={false} /> : null}
        {codeValid ? (
          <RuleVersionList
            ruleType={KPI_SET_RULE_TYPE}
            code={code}
            canManage={canStore}
            canApprove={canApprove}
            writable={writable}
            editLink={() => `${SCORE_PATHS.kpiSet}?code=${code}`}
            diffLink={(id, against) => `${PATHS.ruleDiff}?rule=${id}${against === undefined ? '' : `&against=${against}`}`}
          />
        ) : null}
      </StateBoundary>
      <p className="adm-kit-foot" data-testid="footer">
        {t('gova1.footer.reference', { id: route.id, req: route.req ?? '' })}
      </p>
    </section>
  );
}

interface ItemEditorProps {
  form: KpiSetForm;
  index: number;
  item: ItemForm;
  problems: RuleProblems;
  show: boolean;
  disabled: boolean;
  references: References;
  operations: Parameters<typeof operationOf>[0];
  onChange: (form: KpiSetForm) => void;
}

function ItemEditor({ form, index, item, problems, show, disabled, references, operations, onChange }: ItemEditorProps) {
  const { t } = useTranslation();
  const prefix = `items[${index}]`;
  const entry = operationOf(operations, item.operation);
  const takes = paramNames(entry, ['unit', 'against', 'grace_days']);
  const patch = (change: Partial<ItemForm>): void => onChange(updateItem(form, index, change));
  const common = { problems, show, disabled };
  const operationOptions = (operations === undefined ? OPERATIONS.map((code) => ({ code })) : operations).map((one) => ({ value: one.code as ItemForm['operation'], label: operationWord(t, one.code) }));
  return (
    <fieldset className="pwf-tpl-sub" data-item={index}>
      <legend>{t('pwfs.kpiset.item.legend', { number: index + 1 })}</legend>
      <div className="pwf-tpl-row">
        <RuleField label={t('pwfs.kpiset.item.kpi.label')} path={`${prefix}.kpi_code`} value={item.kpiCode} suggestions={references.kpiCodes} hint={t('pwfs.kpiset.item.kpi.hint')} onChange={(kpiCode) => patch({ kpiCode })} {...common} />
        <RuleSelect label={t('fix9.pwf09.operation.label')} path={`${prefix}.operation`} value={item.operation} options={operationOptions} disabled={disabled} onChange={(operation) => patch({ operation })} />
        <RuleField label={t('pwfs.kpiset.item.weight.label')} path={`${prefix}.weight`} value={item.weight} inputMode="numeric" hint={t('pwfs.kpiset.item.weight.hint')} onChange={(weight) => patch({ weight })} {...common} />
        <RuleField label={t('pwfs.kpiset.item.rag.label')} path={`${prefix}.rag_code`} value={item.ragCode} suggestions={references.ragCodes} hint={t('pwfs.kpiset.item.rag.hint')} onChange={(ragCode) => patch({ ragCode })} {...common} />
      </div>
      {entry === undefined ? null : (
        <p className="adm-kit-sub" data-testid={`operation-facts-${index}`}>
          {t('pwfs.kpiset.item.facts.text', { unit: unitOfValueWord(t, entry.unit), direction: directionWord(t, entry.good_direction) })}
        </p>
      )}
      <fieldset className="pwf-tpl-sub" data-testid={`operation-params-${index}`}>
        <legend>{t('fix9.pwf09.params.legend')}</legend>
        {takes.some((name) => name === 'unit' || name === 'against' || name === 'grace_days') ? null : <p className="adm-kit-sub">{t('fix9.pwf09.params.none')}</p>}
        <div className="pwf-tpl-row">
        {takes.includes('unit') ? (
          <RuleSelect
            label={t('pwfs.kpiset.item.unit.label')}
            path={`${prefix}.unit`}
            value={item.unit}
            options={UNIT_CHOICES.map((value) => ({ value, label: value === '' ? t('pwfs.kpiset.item.default.option') : value === 'WORKING' ? t('pwfs.kpiset.item.working.option') : t('pwfs.kpiset.item.calendar.option') }))}
            disabled={disabled}
            onChange={(unit) => patch({ unit })}
          />
        ) : null}
        {takes.includes('against') ? (
          <RuleSelect
            label={t('pwfs.kpiset.item.against.label')}
            path={`${prefix}.against`}
            value={item.against}
            options={AGAINST_CHOICES.map((value) => ({ value, label: value === '' ? t('pwfs.kpiset.item.default.option') : value === 'FIRST_BASELINE' ? t('pwfs.kpiset.item.first.option') : t('pwfs.kpiset.item.current.option') }))}
            disabled={disabled}
            hint={t('pwfs.kpiset.item.against.hint')}
            onChange={(against) => patch({ against })}
          />
        ) : null}
        {takes.includes('grace_days') ? <RuleField label={t('pwfs.kpiset.item.grace.label')} path={`${prefix}.grace`} value={item.grace} inputMode="numeric" onChange={(grace) => patch({ grace })} {...common} /> : null}
        </div>
      </fieldset>
      <fieldset className="pwf-tpl-sub">
        <legend>{t('fix9.pwf09.applies.legend')}</legend>
        <p className="adm-kit-sub">{t('pwfs.kpiset.item.applies.hint')}</p>
        <div className="pwf-tpl-row">
          {KINDS.map((kind) => (
            <label key={kind} className="pwf-field">
              <span>
                <input
                  type="checkbox"
                  checked={item.kinds.includes(kind)}
                  disabled={disabled}
                  data-testid={`field-${prefix}.kind.${kind}`}
                  onChange={(event) => patch({ kinds: event.target.checked ? [...item.kinds, kind] : item.kinds.filter((one) => one !== kind) })}
                />{' '}
                {kind === 'TASK' ? t('pwfs.kpiset.item.kind.task') : t('pwfs.kpiset.item.kind.milestone')}
              </span>
            </label>
          ))}
          <RuleField label={t('pwfs.kpiset.item.phases.label')} path={`${prefix}.phases`} value={item.phases} onChange={(phases) => patch({ phases })} {...common} />
          <RuleField label={t('pwfs.kpiset.item.tasks.label')} path={`${prefix}.tasks`} value={item.tasks} onChange={(tasks) => patch({ tasks })} {...common} />
        </div>
      </fieldset>
      <ScaleEditor form={form} index={index} item={item} problems={problems} show={show} disabled={disabled} onChange={onChange} />
      <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled || form.items.length <= 1} data-action={`remove-item-${index}`} onClick={() => onChange(removeItem(form, index))}>
        {t('pwfs.kpiset.item.remove.action')}
      </button>
    </fieldset>
  );
}

function ScaleEditor({ form, index, item, problems, show, disabled, onChange }: { form: KpiSetForm; index: number; item: ItemForm; problems: RuleProblems; show: boolean; disabled: boolean; onChange: (form: KpiSetForm) => void }) {
  const { t } = useTranslation();
  const prefix = `items[${index}].scale`;
  const scale = item.scale;
  const common = { problems, show, disabled };
  return (
    <fieldset className="pwf-tpl-sub" data-testid={`scale-${index}`}>
      <legend>{t('fix9.pwf09.scale.legend')}</legend>
      <div className="pwf-tpl-row">
        <RuleSelect
          label={t('pwfs.kpiset.scale.kind.label')}
          path={`${prefix}.kind`}
          value={scale.kind}
          options={[
            { value: 'LINEAR', label: t('pwfs.kpiset.scale.linear.option') },
            { value: 'STEPPED', label: t('pwfs.kpiset.scale.stepped.option') },
          ]}
          disabled={disabled}
          hint={t('pwfs.kpiset.scale.kind.hint')}
          onChange={(kind) => onChange(updateScale(form, index, { kind }))}
        />
        {scale.kind === 'LINEAR' ? (
          <>
            <RuleField label={t('pwfs.kpiset.scale.worst.label')} path={`${prefix}.worst`} value={scale.worst} inputMode="decimal" hint={t('pwfs.kpiset.scale.worst.hint')} onChange={(worst) => onChange(updateScale(form, index, { worst }))} {...common} />
            <RuleField label={t('pwfs.kpiset.scale.best.label')} path={`${prefix}.best`} value={scale.best} inputMode="decimal" hint={t('pwfs.kpiset.scale.best.hint')} onChange={(best) => onChange(updateScale(form, index, { best }))} {...common} />
          </>
        ) : (
          <RuleSelect
            label={t('pwfs.kpiset.scale.mode.label')}
            path={`${prefix}.mode`}
            value={scale.mode}
            options={[
              { value: 'AT_MOST', label: t('pwfs.kpiset.scale.atMost.option') },
              { value: 'AT_LEAST', label: t('pwfs.kpiset.scale.atLeast.option') },
            ]}
            disabled={disabled}
            hint={t('pwfs.kpiset.scale.mode.hint')}
            onChange={(mode) => onChange(updateScale(form, index, { mode }))}
          />
        )}
      </div>
      {scale.kind === 'STEPPED' ? (
        <>
          <ol className="pwf-tpl-rows" data-testid={`steps-${index}`}>
            {scale.steps.map((step, at) => (
              <li key={at} className="pwf-tpl-row">
                <RuleField label={t('pwfs.kpiset.scale.bound.label', { number: at + 1 })} path={`${prefix}.steps[${at}].bound`} value={step.bound} inputMode="decimal" onChange={(bound) => onChange(updateStep(form, index, at, { bound }))} {...common} />
                <RuleField label={t('pwfs.kpiset.scale.score.label', { number: at + 1 })} path={`${prefix}.steps[${at}].score`} value={step.score} inputMode="decimal" onChange={(score) => onChange(updateStep(form, index, at, { score }))} {...common} />
                <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled || scale.steps.length <= 1} data-action={`remove-step-${index}-${at}`} onClick={() => onChange(removeStep(form, index, at))}>
                  {t('pwfs.kpiset.scale.removeStep.action')}
                </button>
              </li>
            ))}
          </ol>
          <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={disabled || scale.steps.length >= MAX_STEPS} data-action={`add-step-${index}`} onClick={() => onChange(addStep(form, index))}>
            {t('pwfs.kpiset.scale.addStep.action')}
          </button>
          <RuleField label={t('pwfs.kpiset.scale.otherwise.label')} path={`${prefix}.otherwise`} value={scale.otherwise} inputMode="decimal" hint={t('pwfs.kpiset.scale.otherwise.hint')} onChange={(otherwise) => onChange(updateScale(form, index, { otherwise }))} {...common} />
        </>
      ) : null}
      <h3>{t('pwfs.kpiset.curve.title')}</h3>
      <CurvePreview scale={scale} />
    </fieldset>
  );
}
