import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { HouseholdLine } from '../household/model';
import { itemKindLabel } from '../inventory/labels';
import { useInventory } from '../inventory/hooks';
import { DialogFrame, Field } from '../components';
import type { UnitOption } from '../model';
import { useAddItems, useDraftPlan, useRevisePlan } from './hooks';
import { commandProblemMessage, executorKindLabel, formProblemMessage, planItemKindLabel } from './labels';
import { EMPTY_DRAFT_FORM, EMPTY_ITEM_FORM, EXECUTOR_KINDS, ITEM_KINDS, compensationKindOf, describeProblem, draftBody, formatVnd, itemBody, restsOnInventory, validateDraft, validateItem, validateRevise } from './model';
import type { DraftForm, ItemForm, PlanItem, PlanLine, ReviseForm } from './model';

/** The drafting of a plan for the project that is open: the unit that executes it, who that is, and its code. */
export function DraftDialog({ projectId, units, onClose }: { projectId: string; units: readonly UnitOption[]; onClose(): void }) {
  const { t } = useTranslation();
  const draft = useDraftPlan();
  const [form, setForm] = useState<DraftForm>(EMPTY_DRAFT_FORM);
  const [submitted, setSubmitted] = useState(false);
  const problems = validateDraft(form);
  const error = (field: keyof DraftForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (draft.isPending || Object.keys(problems).length > 0) return;
    draft.mutate(draftBody(projectId, form), { onSuccess: onClose });
  };
  return (
    <DialogFrame
      title={t('lnd.plans.draftDialog.title.text')}
      onClose={onClose}
      refusal={draft.isError ? commandProblemMessage(t, describeProblem(draft.error)) : undefined}
      pending={draft.isPending}
      onSubmit={submit}
    >
      <Field id="plan-code" label={t('lnd.plans.draftDialog.code.label')} error={error('planCode')} hint={t('lnd.plans.draftDialog.code.help')}>
        <input id="plan-code" value={form.planCode} onChange={(event) => setForm({ ...form, planCode: event.target.value })} />
      </Field>
      <Field id="plan-executor-unit" label={t('lnd.plans.draftDialog.unit.label')} error={error('executorUnitId')}>
        <select id="plan-executor-unit" value={form.executorUnitId} onChange={(event) => setForm({ ...form, executorUnitId: event.target.value })}>
          <option value="">{t('lnd.plans.draftDialog.unit.choose')}</option>
          {units.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
      </Field>
      <Field id="plan-executor-kind" label={t('lnd.plans.draftDialog.kind.label')} error={error('executorKind')}>
        <select id="plan-executor-kind" value={form.executorKind} onChange={(event) => setForm({ ...form, executorKind: event.target.value as DraftForm['executorKind'] })}>
          <option value="">{t('lnd.plans.draftDialog.kind.choose')}</option>
          {EXECUTOR_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {executorKindLabel(t, kind)}
            </option>
          ))}
        </select>
      </Field>
    </DialogFrame>
  );
}

interface ItemDialogProps {
  plan: PlanLine;
  households: readonly HouseholdLine[];
  /** The items already in the plan: a record of the inventory is used once. */
  items: readonly PlanItem[];
  onClose(): void;
}

/**
 * One item added to a draft plan. A compensation is counted from a record of the inventory that the household confirmed: the records offered are those, of the kind chosen and not yet in the plan, and the amount is
 * theirs; a support or a resettlement is an amount of a policy with its legal basis.
 */
export function ItemDialog({ plan, households, items, onClose }: ItemDialogProps) {
  const { t } = useTranslation();
  const add = useAddItems();
  const [form, setForm] = useState<ItemForm>(EMPTY_ITEM_FORM);
  const [submitted, setSubmitted] = useState(false);
  const inventory = useInventory(form.householdId === '' ? undefined : form.householdId);
  const problems = validateItem(form);
  const used = new Set(items.map((item) => item.basisInventoryId));
  const offered = (inventory.data ?? []).filter((record) => record.status === 'CONFIRMED' && !used.has(record.id) && compensationKindOf(record.itemKind) === form.itemKind);
  const error = (field: keyof ItemForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (add.isPending || Object.keys(problems).length > 0) return;
    add.mutate({ id: plan.id, version: plan.version, items: [itemBody(form)] }, { onSuccess: onClose });
  };
  const compensation = form.itemKind !== '' && restsOnInventory(form.itemKind);
  return (
    <DialogFrame
      title={t('lnd.plans.itemDialog.title.text', { code: plan.planCode, revision: plan.revision })}
      onClose={onClose}
      refusal={add.isError ? commandProblemMessage(t, describeProblem(add.error)) : undefined}
      pending={add.isPending}
      onSubmit={submit}
    >
      <Field id="item-household" label={t('lnd.plans.itemDialog.household.label')} error={error('householdId')} hint={t('lnd.plans.itemDialog.household.help')}>
        <select id="item-household" value={form.householdId} onChange={(event) => setForm({ ...EMPTY_ITEM_FORM, householdId: event.target.value, legalBasis: form.legalBasis })}>
          <option value="">{t('lnd.plans.itemDialog.household.choose')}</option>
          {households.map((household) => (
            <option key={household.id} value={household.id}>
              {`${household.householdCode} · ${household.headNameMasked}`}
            </option>
          ))}
        </select>
      </Field>
      <Field id="item-kind" label={t('lnd.plans.itemDialog.kind.label')} error={error('itemKind')}>
        <select id="item-kind" value={form.itemKind} onChange={(event) => setForm({ ...form, itemKind: event.target.value as ItemForm['itemKind'], basisInventoryId: '', amountVnd: '' })}>
          <option value="">{t('lnd.plans.itemDialog.kind.choose')}</option>
          {ITEM_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {planItemKindLabel(t, kind)}
            </option>
          ))}
        </select>
      </Field>
      {compensation ? (
        <Field id="item-basis" label={t('lnd.plans.itemDialog.basis.label')} error={error('basisInventoryId')} hint={t('lnd.plans.itemDialog.basis.help')}>
          <select id="item-basis" value={form.basisInventoryId} onChange={(event) => setForm({ ...form, basisInventoryId: event.target.value })}>
            <option value="">{offered.length === 0 ? t('lnd.plans.itemDialog.basis.none') : t('lnd.plans.itemDialog.basis.choose')}</option>
            {offered.map((record) => (
              <option key={record.id} value={record.id}>
                {t('lnd.plans.itemDialog.basis.line', { parcel: record.parcelCode, kind: itemKindLabel(t, record.itemKind), amount: formatVnd(record.amountVnd) })}
              </option>
            ))}
          </select>
        </Field>
      ) : form.itemKind === '' ? null : (
        <Field id="item-amount" label={t('lnd.plans.itemDialog.amount.label')} error={error('amountVnd')} hint={t('lnd.plans.itemDialog.amount.help')}>
          <input id="item-amount" inputMode="numeric" value={form.amountVnd} onChange={(event) => setForm({ ...form, amountVnd: event.target.value })} />
        </Field>
      )}
      <Field id="item-legal-basis" label={t('lnd.plans.itemDialog.legalBasis.label')} error={error('legalBasis')} hint={t('lnd.plans.itemDialog.legalBasis.help')}>
        <input id="item-legal-basis" value={form.legalBasis} onChange={(event) => setForm({ ...form, legalBasis: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}

/** A new revision of a plan that was posted or approved: the reason says why the plan changes; the earlier revision stays as it was. */
export function ReviseDialog({ plan, onClose }: { plan: PlanLine; onClose(): void }) {
  const { t } = useTranslation();
  const revise = useRevisePlan();
  const [form, setForm] = useState<ReviseForm>({ reason: '' });
  const [submitted, setSubmitted] = useState(false);
  const problems = validateRevise(form);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (revise.isPending || Object.keys(problems).length > 0) return;
    revise.mutate({ id: plan.id, version: plan.version, reason: form.reason }, { onSuccess: onClose });
  };
  const problem = problems.reason;
  return (
    <DialogFrame
      title={t('lnd.plans.reviseDialog.title.text', { code: plan.planCode, revision: plan.revision })}
      onClose={onClose}
      refusal={revise.isError ? commandProblemMessage(t, describeProblem(revise.error)) : undefined}
      pending={revise.isPending}
      onSubmit={submit}
    >
      <p data-testid="revise-note">{t('lnd.plans.reviseDialog.note.text', { revision: plan.revision + 1 })}</p>
      <Field id="revise-reason" label={t('lnd.plans.reviseDialog.reason.label')} error={submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined} hint={t('lnd.plans.reviseDialog.reason.help')}>
        <input id="revise-reason" autoComplete="off" value={form.reason} onChange={(event) => setForm({ reason: event.target.value })} />
      </Field>
    </DialogFrame>
  );
}
