import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import { Field } from './components';
import { useProjectOptions } from './dossier-commands';
import { gateLabel } from './gate-labels';
import { GATE_CODES } from './gate-model';
import type { GateCode } from './gate-model';
import type { TypeGroup } from './model';
import { useGrantWaiver } from './waiver-hooks';
import { waiverFieldMessage, waiverProblemMessage } from './waiver-labels';
import { EMPTY_WAIVER_FORM, FIELD_OF_DETAIL, WAIVER_MAX_DAYS, describeWaiverProblem, grantBody, hasErrors, latestWaiverDay, validateWaiver } from './waiver-model';
import type { WaiverErrors, WaiverField, WaiverForm as WaiverFormValue } from './waiver-model';

export interface WaiverGrantFormProps {
  /** The Vietnam date the last day is judged against. */
  today: string;
  /** The permit types to ask for, by code: the version that matters now is the one the waiver names. */
  types: readonly TypeGroup[];
}

/**
 * The form that grants a waiver (PMT-06). It names the project, the gate and the permit type the gate may do without, the reason, the decision document the
 * waiver rests on and the last day, which is at most the longest a waiver may last from today. Who asked for it and who approves are not typed: the server
 * judges them from the record, and says so when the one who signs is one of the people who asked.
 */
export function WaiverGrantForm({ today, types }: WaiverGrantFormProps) {
  const { t } = useTranslation();
  const projects = useProjectOptions();
  const grant = useGrantWaiver();
  const [form, setForm] = useState<WaiverFormValue>(EMPTY_WAIVER_FORM);
  const [errors, setErrors] = useState<WaiverErrors>({});
  const [granted, setGranted] = useState(false);
  const latest = latestWaiverDay(today);
  const refused = grant.isError ? describeWaiverProblem(grant.error) : undefined;
  const refusedField = refused?.reason === 'validation' && refused.field !== undefined ? FIELD_OF_DETAIL[refused.field] : undefined;

  const setField = <Name extends WaiverField>(field: Name, value: WaiverFormValue[Name]): void => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    setGranted(false);
    if (grant.isError) grant.reset();
  };
  const message = (field: WaiverField): string | undefined => {
    const problem = errors[field];
    if (problem !== undefined) return waiverFieldMessage(t, problem, latest);
    return refusedField === field ? t('pmt.waiver.field.rejected.error') : undefined;
  };

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (grant.isPending) return;
    const found = validateWaiver(form, today);
    setErrors(found);
    if (hasErrors(found)) return;
    grant.mutate(grantBody(form), {
      onSuccess: () => {
        setForm({ ...EMPTY_WAIVER_FORM, gateCode: form.gateCode });
        setGranted(true);
      },
    });
  };

  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('pmt.waiver.form.aria')}>
      <h2>{t('pmt.waiver.form.title')}</h2>
      <p className="sub">{t('pmt.waiver.form.hint', { days: WAIVER_MAX_DAYS })}</p>
      {refused === undefined || refusedField !== undefined ? null : (
        <p className="callout warning" role="alert" data-testid="problem" data-reason={refused.reason}>
          {waiverProblemMessage(t, refused)}
        </p>
      )}
      {granted ? (
        <p className="callout" role="status" data-testid="granted">
          {t('pmt.waiver.form.granted.notice')}
        </p>
      ) : null}
      <Field id="waiver-project" label={t('pmt.waiver.form.project.label')} error={message('projectId')}>
        <select id="waiver-project" value={form.projectId} aria-invalid={message('projectId') !== undefined} onChange={(event) => setField('projectId', event.target.value)}>
          <option value="">{t('pmt.waiver.form.project.placeholder')}</option>
          {(projects.data ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.code} · {project.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="waiver-gate" label={t('pmt.waiver.form.gate.label')} error={message('gateCode')}>
        <select id="waiver-gate" value={form.gateCode} onChange={(event) => setField('gateCode', event.target.value as GateCode)}>
          {GATE_CODES.map((code) => (
            <option key={code} value={code}>
              {gateLabel(t, code)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="waiver-type" label={t('pmt.waiver.form.type.label')} error={message('permitTypeId')}>
        <select id="waiver-type" value={form.permitTypeId} aria-invalid={message('permitTypeId') !== undefined} onChange={(event) => setField('permitTypeId', event.target.value)}>
          <option value="">{t('pmt.waiver.form.type.placeholder')}</option>
          {types.map((group) => (
            <option key={group.code} value={group.current.id}>
              {group.code} · {group.current.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="waiver-reason" label={t('pmt.waiver.form.reason.label')} error={message('reason')} hint={t('pmt.waiver.form.reason.hint')}>
        <textarea id="waiver-reason" rows={3} value={form.reason} aria-invalid={message('reason') !== undefined} onChange={(event) => setField('reason', event.target.value)} />
      </Field>
      <Field id="waiver-document" label={t('pmt.waiver.form.document.label')} error={message('documentVersionId')} hint={t('pmt.waiver.form.document.hint')}>
        <input id="waiver-document" value={form.documentVersionId} aria-invalid={message('documentVersionId') !== undefined} onChange={(event) => setField('documentVersionId', event.target.value)} />
      </Field>
      <Field id="waiver-until" label={t('pmt.waiver.form.until.label')} error={message('validUntil')} hint={t('pmt.waiver.form.until.hint', { days: WAIVER_MAX_DAYS, latest })}>
        <input id="waiver-until" type="date" min={today} max={latest} value={form.validUntil} aria-invalid={message('validUntil') !== undefined} onChange={(event) => setField('validUntil', event.target.value)} />
      </Field>
      <div className="formfooter">
        <button type="submit" className="button primary" disabled={grant.isPending}>
          {grant.isPending ? t('pmt.waiver.form.saving') : t('pmt.waiver.form.save.action')}
        </button>
      </div>
    </form>
  );
}
