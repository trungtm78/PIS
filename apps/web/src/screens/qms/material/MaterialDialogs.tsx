import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { Field } from '../../ctr/components';
import { CommandFrame } from '../CommandFrame';
import { useRecordResult, useRegisterTest } from './hooks';
import { formProblemMessage, problemMessage, resultLabel } from './labels';
import { RESULTS, describeProblem, emptyRegister, emptyResult, registerBody, resultBody, validateRegister, validateResult, vietnamToday } from './model';
import type { ContractOption, FormProblem, MaterialTest, RegisterForm, ResultForm } from './model';

function useShown<Form extends object>(problems: Partial<Record<keyof Form, FormProblem>>, submitted: boolean) {
  const { t } = useTranslation();
  return (field: keyof Form): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
}

/** Registering a sample against a contract being performed: the code the sample is known by, what it is, the laboratory, the standard it is tested against and the day it was taken. */
export function RegisterDialog({ contracts, initialContractId, onClose }: { contracts: readonly ContractOption[]; initialContractId: string; onClose(): void }) {
  const { t } = useTranslation();
  const register = useRegisterTest();
  const today = vietnamToday();
  const [form, setForm] = useState<RegisterForm>(emptyRegister(contracts.some((contract) => contract.id === initialContractId) ? initialContractId : '', today));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateRegister(
    form,
    contracts.map((contract) => contract.id),
    today,
  );
  const shown = useShown<RegisterForm>(problems, submitted);
  const set = (patch: Partial<RegisterForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (register.isPending || Object.keys(problems).length > 0) return;
    register.mutate(registerBody(form), { onSuccess: onClose });
  };
  const words = { close: t('qms.material.dialog.close'), cancel: t('qms.material.dialog.cancel'), pending: t('qms.material.dialog.pending') };
  return (
    <CommandFrame
      title={t('qms.material.register.title')}
      refusal={register.isError ? problemMessage(t, describeProblem(register.error)) : undefined}
      pending={register.isPending}
      submitLabel={t('qms.material.register.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      <Field id="material-contract" label={t('qms.material.field.contract')} error={shown('contractId')}>
        <select id="material-contract" value={form.contractId} onChange={(event) => set({ contractId: event.target.value })}>
          <option value="">{t('qms.material.field.contract.choose')}</option>
          {contracts.map((contract) => (
            <option key={contract.id} value={contract.id}>
              {`${contract.code} · ${contract.title ?? ''}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="material-sample" label={t('qms.material.field.sample')} error={shown('sampleCode')}>
        <input id="material-sample" autoComplete="off" value={form.sampleCode} onChange={(event) => set({ sampleCode: event.target.value })} />
      </Field>
      <Field id="material-kind" label={t('qms.material.field.kind')} error={shown('materialKind')}>
        <input id="material-kind" autoComplete="off" value={form.materialKind} onChange={(event) => set({ materialKind: event.target.value })} />
      </Field>
      <Field id="material-lab" label={t('qms.material.field.lab')} error={shown('labName')}>
        <input id="material-lab" autoComplete="off" value={form.labName} onChange={(event) => set({ labName: event.target.value })} />
      </Field>
      <Field id="material-standard" label={t('qms.material.field.standard')} error={shown('standardRef')}>
        <input id="material-standard" autoComplete="off" value={form.standardRef} onChange={(event) => set({ standardRef: event.target.value })} />
      </Field>
      <Field id="material-sampled" label={t('qms.material.field.sampled')} error={shown('sampledOn')}>
        <input id="material-sampled" type="date" value={form.sampledOn} onChange={(event) => set({ sampledOn: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}

/** Recording the result of the laboratory, once: pass or fail, the day, the values it reported and its report. A failed result raises a non-conformance by itself, and the dialog says so. */
export function ResultDialog({ test, onClose }: { test: MaterialTest; onClose(): void }) {
  const { t } = useTranslation();
  const record = useRecordResult();
  const today = vietnamToday();
  const [form, setForm] = useState<ResultForm>(emptyResult(today));
  const [submitted, setSubmitted] = useState(false);
  const problems = validateResult(form, test, today);
  const shown = useShown<ResultForm>(problems, submitted);
  const set = (patch: Partial<ResultForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (record.isPending || Object.keys(problems).length > 0) return;
    record.mutate({ id: test.id, version: test.version, body: resultBody(form) }, { onSuccess: onClose });
  };
  const words = { close: t('qms.material.dialog.close'), cancel: t('qms.material.dialog.cancel'), pending: t('qms.material.dialog.pending') };
  return (
    <CommandFrame
      title={t('qms.material.result.title', { sample: test.sampleCode })}
      refusal={record.isError ? problemMessage(t, describeProblem(record.error)) : undefined}
      pending={record.isPending}
      submitLabel={t('qms.material.result.submit')}
      words={words}
      onSubmit={send}
      onClose={onClose}
    >
      {form.result === 'FAIL' ? (
        <p className="callout warning" role="note" data-testid="fail-notice">
          {t('qms.material.result.failNotice')}
        </p>
      ) : null}
      <Field id="material-result" label={t('qms.material.field.result')} error={shown('result')}>
        <select id="material-result" value={form.result} onChange={(event) => set({ result: event.target.value })}>
          <option value="">{t('qms.material.field.result.choose')}</option>
          {RESULTS.map((result) => (
            <option key={result} value={result}>
              {resultLabel(t, result)}
            </option>
          ))}
        </select>
      </Field>
      <Field id="material-tested" label={t('qms.material.field.tested')} error={shown('testedOn')} hint={t('qms.material.field.tested.hint', { day: test.sampledOn })}>
        <input id="material-tested" type="date" value={form.testedOn} onChange={(event) => set({ testedOn: event.target.value })} />
      </Field>
      <Field id="material-values" label={t('qms.material.field.values')} error={shown('values')} hint={t('qms.material.field.values.hint')}>
        <textarea id="material-values" rows={4} value={form.values} onChange={(event) => set({ values: event.target.value })} />
      </Field>
      <Field id="material-report" label={t('qms.material.field.report')} error={shown('reportId')} hint={t('qms.material.field.report.hint')}>
        <input id="material-report" autoComplete="off" value={form.reportId} onChange={(event) => set({ reportId: event.target.value })} />
      </Field>
    </CommandFrame>
  );
}
