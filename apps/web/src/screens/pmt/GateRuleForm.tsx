import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { usePublishGateRule } from './gate-hooks';
import { gateLabel, gateProblemMessage, requirementLabel } from './gate-labels';
import { EMPTY_GATE_FORM, FIELD_OF_DETAIL, GATE_CODES, REQUIREMENTS, describeGateProblem, toPublishBody, validateGateRule } from './gate-model';
import type { GateCode, GateField, GateRuleForm as GateFormValue, GateRuleView, Requirement } from './gate-model';
import { fieldProblemMessage } from './labels';
import type { FormErrors, TypeGroup } from './model';
import { SectionCard, StickyActions } from '../../ui';

export interface GateRuleFormProps {
  /** The Vietnam date a rule that takes over from another may begin on or after. */
  today: string;
  /** The permit types to ask for, by code: the version that matters now is the one the rule names. */
  types: readonly TypeGroup[];
  /** The rules there are: a form for a gate and a permit type that have one publishes its next revision. */
  rules: readonly GateRuleView[];
}

/**
 * The form that publishes a gate rule (PMT-04). It names the gate, the permit type, what is asked of the permit (valid, valid or exempted, or only
 * filed), the projects the rule applies to, the legal basis and the days it applies from. A rule is never edited in place: the next revision takes
 * over on its first day and ends the one before it the day before. What only the server can judge (an overlap) comes back as a refusal.
 */
export function GateRuleForm({ today, types, rules }: GateRuleFormProps) {
  const { t } = useTranslation();
  const publish = usePublishGateRule();
  const [form, setForm] = useState<GateFormValue>(EMPTY_GATE_FORM);
  const [errors, setErrors] = useState<FormErrors<GateField>>({});
  const [saved, setSaved] = useState(false);
  const refused = publish.isError ? describeGateProblem(publish.error) : undefined;
  const refusedField = refused?.reason === 'validation' && refused.field !== undefined ? FIELD_OF_DETAIL[refused.field] : undefined;
  const chosenType = types.find((group) => group.current.id === form.permitTypeId);
  const takenOver = chosenType !== undefined && rules.some((rule) => rule.gateCode === form.gateCode && rule.permitTypeCode === chosenType.code && rule.status !== 'DRAFT');

  const setField = <Name extends GateField>(field: Name, value: GateFormValue[Name]): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    setSaved(false);
    if (publish.isError) publish.reset();
  };
  const error = (field: GateField): string | undefined => {
    const own = errors[field] ?? (refusedField === field ? 'rejected' : undefined);
    return own === undefined ? undefined : fieldProblemMessage(t, own);
  };

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (publish.isPending) return;
    const found = validateGateRule(form, today, takenOver);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    publish.mutate(toPublishBody(form), {
      onSuccess: () => {
        setForm({ ...EMPTY_GATE_FORM, gateCode: form.gateCode });
        setSaved(true);
      },
    });
  };

  const text = (field: 'milestoneCode' | 'projectGroupKeys' | 'workTypes', id: string, label: string, hint?: string) => (
    <Field id={id} label={label} error={error(field)} {...(hint === undefined ? {} : { hint })}>
      <input id={id} value={form[field]} aria-invalid={error(field) !== undefined} onChange={(event) => setField(field, event.target.value)} />
    </Field>
  );
  const number = (field: 'minInvestment' | 'maxInvestment', id: string, label: string) => (
    <Field id={id} label={label} error={error(field)}>
      <input id={id} inputMode="numeric" value={form[field]} aria-invalid={error(field) !== undefined} onChange={(event) => setField(field, event.target.value)} />
    </Field>
  );
  const date = (field: 'effectiveFrom' | 'effectiveUntil', id: string, label: string, hint?: string) => (
    <Field id={id} label={label} error={error(field)} {...(hint === undefined ? {} : { hint })}>
      <input id={id} type="date" value={form[field]} aria-invalid={error(field) !== undefined} onChange={(event) => setField(field, event.target.value)} />
    </Field>
  );

  return (
    <form onSubmit={save} noValidate aria-label={t('pmt.gate.form.aria')}>
      <SectionCard title={t('pmt.gate.form.title')}>
        <p className="sub">{t('pmt.gate.form.hint')}</p>
        {refused === undefined || refusedField !== undefined ? null : (
          <p className="callout warning" role="alert" data-testid="problem">
            {gateProblemMessage(t, refused)}
          </p>
        )}
        {saved ? (
          <p className="callout" role="status" data-testid="saved">
            {t('pmt.gate.form.saved')}
          </p>
        ) : null}
        <Field id="gate-code" label={t('pmt.gate.form.gate.label')} error={error('gateCode')}>
          <select id="gate-code" value={form.gateCode} onChange={(event) => setField('gateCode', event.target.value as GateCode)}>
            {GATE_CODES.map((code) => (
              <option key={code} value={code}>
                {gateLabel(t, code)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="gate-type" label={t('pmt.gate.form.type.label')} error={error('permitTypeId')}>
          <select id="gate-type" value={form.permitTypeId} aria-invalid={error('permitTypeId') !== undefined} onChange={(event) => setField('permitTypeId', event.target.value)}>
            <option value="">{t('pmt.gate.form.type.placeholder')}</option>
            {types.map((group) => (
              <option key={group.code} value={group.current.id}>
                {group.code} · {group.current.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="gate-requirement" label={t('pmt.gate.form.requirement.label')} error={error('requirement')}>
          <select id="gate-requirement" value={form.requirement} onChange={(event) => setField('requirement', event.target.value as Requirement)}>
            {REQUIREMENTS.map((requirement) => (
              <option key={requirement} value={requirement}>
                {requirementLabel(t, requirement)}
              </option>
            ))}
          </select>
        </Field>
        {text('milestoneCode', 'gate-milestone', t('pmt.gate.form.milestone.label'), t('pmt.gate.form.milestone.hint'))}
        {text('projectGroupKeys', 'gate-groups', t('pmt.gate.form.groups.label'), t('pmt.gate.form.groups.hint'))}
        {text('workTypes', 'gate-works', t('pmt.gate.form.works.label'))}
        {number('minInvestment', 'gate-min', t('pmt.gate.form.min.label'))}
        {number('maxInvestment', 'gate-max', t('pmt.gate.form.max.label'))}
        <Field id="gate-basis" label={t('pmt.gate.form.basis.label')} error={error('legalBasis')} hint={t('pmt.gate.form.basis.hint')}>
          <textarea id="gate-basis" value={form.legalBasis} aria-invalid={error('legalBasis') !== undefined} onChange={(event) => setField('legalBasis', event.target.value)} />
        </Field>
        {date('effectiveFrom', 'gate-from', t('pmt.gate.form.from.label'), takenOver ? t('pmt.gate.form.revision.hint') : undefined)}
        {date('effectiveUntil', 'gate-until', t('pmt.gate.form.until.label'))}
        <StickyActions
          primary={
            <button type="submit" className="ui-button ui-button--primary" disabled={publish.isPending}>
              {publish.isPending ? t('pmt.gate.form.saving') : t('pmt.gate.form.save.action')}
            </button>
          }
        />
      </SectionCard>
    </form>
  );
}
