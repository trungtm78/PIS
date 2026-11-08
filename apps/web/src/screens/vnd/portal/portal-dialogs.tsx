import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import { CommandDialog, RowsEditor, reasonField, rowsOf } from '../shared/vnd-form';
import type { FieldSpec, Row } from '../shared/vnd-form';
import { useScopeKey } from '../shared/vnd-hooks';
import { gradeLabel, kindLabel } from '../shared/vnd-labels';
import { CERTIFICATE_KINDS, GRADES, failureCode, isDay, vietnamStamp } from '../shared/vnd-model';
import type { CertificateKind, Grade } from '../shared/vnd-model';
import { attachmentField } from './portal2-files';
import { useContractorChoices, usePortalCommand } from './portal-hooks';
import { actionStatusLabel, portalErrorText, requestKindLabel, subjectTypeLabel, triggerKindLabel } from './portal-labels';
import { REQUEST_KINDS, SUBJECT_TYPES, TRIGGER_KINDS } from './portal-model';
import type { PlanActionLine, PlanLine, PortalAction, PortalHome, PortalPlan, PortalRequest, RequestKind, StaffRequest, SubjectType } from './portal-model';

interface DialogProps {
  onClose: () => void;
  onDone: () => void;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const optional = (name: string, value: unknown): Record<string, string> => (text(value) === '' ? {} : { [name]: text(value) });
const kindOf = (value: unknown): CertificateKind => CERTIFICATE_KINDS.find((kind) => kind === value) ?? 'OTHER';
const gradeOf = (value: unknown): Grade | undefined => GRADES.find((grade) => grade === value);
const requestKindOf = (value: unknown): RequestKind => REQUEST_KINDS.find((kind) => kind === value) ?? 'OTHER';
const subjectOf = (value: unknown): SubjectType | undefined => SUBJECT_TYPES.find((subject) => subject === value);
const triggerOf = (value: unknown): (typeof TRIGGER_KINDS)[number] => TRIGGER_KINDS.find((kind) => kind === value) ?? 'MANUAL';

// ---- the contractor side -----------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The answer to a request. It is allowed after the time limit as well: it is kept and marked late, never refused. */
export function AnswerRequestDialog({ request, onClose, onDone }: DialogProps & { request: Pick<PortalRequest, 'id' | 'title' | 'version' | 'clock' | 'due_at'> }) {
  const { t } = useTranslation();
  const command = usePortalCommand('respondPortalRequest');
  const late = request.clock === 'OVERDUE';
  const fields: FieldSpec[] = [
    { name: 'text', label: t('vnp.answer.field.text.label'), kind: 'textarea', required: true, min: 1, max: 4000 },
    attachmentField(t, 'document_id', t('vnp.answer.field.document.label'), 'REQUEST_RESPONSE'),
  ];
  return (
    <CommandDialog
      title={t('vnp.answer.title.text')}
      context={[{ label: t('vnp.answer.context.request'), value: request.title }]}
      note={late ? <p className="vnd-note portal-late" data-testid="late-note">{t('vnp.answer.late.note')}</p> : <p className="vnd-note">{t('vnp.answer.note.text')}</p>}
      confirmLabel={t('vnp.answer.confirm.action')}
      fields={fields}
      describeError={portalErrorText}
      run={(values) => command.mutateAsync({ path: { id: request.id }, ifMatchVersion: request.version, body: { text: text(values.text), ...optional('document_id', values.document_id) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** The yearly confirmation of the profile with the declaration of integrity. The version of the text shown is sent with the confirmation: when the rule changed meanwhile the server refuses it and the text is read again. */
export function ReconfirmDialog({ home, onClose, onDone }: DialogProps & { home: PortalHome }) {
  const { t } = useTranslation();
  const command = usePortalCommand('confirmPortalReconfirmation');
  const queryClient = useQueryClient();
  const scope = useScopeKey();
  const declaration = home.reconfirmation;
  const fields: FieldSpec[] = [
    { name: 'accepted', label: t('vnp.reconfirm.field.accepted.label'), kind: 'checkbox' },
    { name: 'changes_note', label: t('vnp.reconfirm.field.changes.label'), kind: 'textarea', max: 2000, hint: t('vnp.reconfirm.field.changes.hint') },
  ];
  return (
    <CommandDialog
      title={t('vnp.reconfirm.title.text')}
      context={[
        { label: t('vnp.reconfirm.context.contractor'), value: home.profile.legal_name },
        { label: t('vnp.reconfirm.context.version'), value: declaration.declaration_version },
      ]}
      note={
        <div>
          <p className="vnd-note">{t('vnp.reconfirm.note.text')}</p>
          <p className="portal-declaration" data-testid="declaration-text">
            {declaration.declaration_text}
          </p>
        </div>
      }
      confirmLabel={t('vnp.reconfirm.confirm.action')}
      fields={fields}
      blocked={(values) => values.accepted !== true}
      describeError={portalErrorText}
      run={async (values) => {
        try {
          return await command.mutateAsync({ body: { declaration_version: declaration.declaration_version, accepted: true, ...optional('changes_note', values.changes_note) } });
        } catch (error) {
          if (failureCode(error) === 'RECONFIRMATION_DECLARATION_STALE') await queryClient.invalidateQueries({ queryKey: scope });
          throw error;
        }
      }}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** A certificate put on file by the contractor: it waits for a second person to check it against the original, and until then it satisfies no requirement. */
export function SubmitCertificateDialog({ requestId, onClose, onDone }: DialogProps & { requestId?: string | undefined }) {
  const { t } = useTranslation();
  const command = usePortalCommand('submitPortalQualification');
  const fields: FieldSpec[] = [
    { name: 'kind', label: t('vnd.certs.field.kind.label'), kind: 'select', required: true, options: CERTIFICATE_KINDS.map((kind) => ({ value: kind, label: kindLabel(t, kind) })) },
    { name: 'certificate_no', label: t('vnd.certs.field.number.label'), kind: 'text', required: true, min: 1, max: 100 },
    { name: 'grade', label: t('vnd.certs.field.grade.label'), kind: 'select', options: GRADES.map((grade) => ({ value: grade, label: gradeLabel(t, grade) })) },
    { name: 'scope', label: t('vnd.certs.field.scope.label'), kind: 'textarea', max: 500 },
    { name: 'issuer', label: t('vnd.certs.field.issuer.label'), kind: 'text', required: true, min: 2, max: 300 },
    { name: 'issued_on', label: t('vnd.certs.field.issued.label'), kind: 'date', required: true },
    { name: 'expires_on', label: t('vnd.certs.field.expires.label'), kind: 'date', hint: t('vnd.certs.field.expires.hint') },
    attachmentField(t, 'document_id', t('vnd.certs.field.document.label'), 'CERTIFICATE'),
  ];
  return (
    <CommandDialog
      title={t('vnp.certificate.add.title')}
      context={[]}
      note={<p className="vnd-note">{t('vnp.certificate.add.note')}</p>}
      confirmLabel={t('vnp.certificate.add.confirm')}
      fields={fields}
      describeError={portalErrorText}
      run={(values) => {
        const grade = gradeOf(values.grade);
        return command.mutateAsync({
          body: {
            kind: kindOf(values.kind),
            certificate_no: text(values.certificate_no),
            ...(grade === undefined ? {} : { grade }),
            ...optional('scope', values.scope),
            issuer: text(values.issuer),
            issued_on: text(values.issued_on),
            ...optional('expires_on', values.expires_on),
            ...optional('document_id', values.document_id),
            ...(requestId === undefined ? {} : { request_id: requestId }),
          },
        });
      }}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** The contractor agrees to the plan: the commitment is its own. */
export function AgreePlanDialog({ plan, onClose, onDone }: DialogProps & { plan: Pick<PortalPlan, 'id' | 'title' | 'version'> }) {
  const { t } = useTranslation();
  const command = usePortalCommand('agreePortalRemediationPlan');
  return (
    <CommandDialog
      title={t('vnp.plan.agree.title')}
      context={[{ label: t('vnp.plan.context.plan'), value: plan.title }]}
      note={<p className="vnd-note">{t('vnp.plan.agree.note')}</p>}
      confirmLabel={t('vnp.plan.agree.confirm')}
      fields={[]}
      describeError={portalErrorText}
      run={() => command.mutateAsync({ path: { id: plan.id }, ifMatchVersion: plan.version })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function ActionDoneDialog({ action, onClose, onDone }: DialogProps & { action: Pick<PortalAction, 'id' | 'description' | 'version'> }) {
  const { t } = useTranslation();
  const command = usePortalCommand('markPortalRemediationActionDone');
  const fields: FieldSpec[] = [
    { name: 'note', label: t('vnp.plan.done.field.label'), kind: 'textarea', required: true, min: 1, max: 2000 },
    attachmentField(t, 'document_id', t('vnp.answer.field.document.label'), 'REMEDIATION_EVIDENCE'),
  ];
  return (
    <CommandDialog
      title={t('vnp.plan.done.title')}
      context={[{ label: t('vnp.plan.context.action'), value: action.description }]}
      note={<p className="vnd-note">{t('vnp.plan.done.note')}</p>}
      confirmLabel={t('vnp.plan.done.confirm')}
      fields={fields}
      describeError={portalErrorText}
      run={(values) => command.mutateAsync({ path: { id: action.id }, ifMatchVersion: action.version, body: { note: text(values.note), ...optional('document_id', values.document_id) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

// ---- the staff side -----------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Chooses a contractor of the register by its name or tax code: a search and the list it gives. */
function ContractorPicker({ value, set, id }: { value: string; set: (value: string) => void; id: string }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const choices = useContractorChoices(query, true);
  const items = choices.data?.items ?? [];
  return (
    <div className="vnd-stack">
      <input type="text" aria-label={t('vnp.picker.search.label')} value={query} onChange={(event) => setQuery(event.target.value)} />
      <select id={id} aria-labelledby={`${id}-label`} value={value} onChange={(event) => set(event.target.value)}>
        <option value="" />
        {items.map((item) => (
          <option key={item.contractor_id} value={item.contractor_id}>
            {`${item.legal_name} (${item.tax_identifier})`}
          </option>
        ))}
      </select>
      {choices.isError && <span className="vnd-days">{t('vnp.picker.failed.text')}</span>}
    </div>
  );
}

export const contractorField = (t: ReturnType<typeof useTranslation>['t'], initial: string): FieldSpec => ({
  name: 'contractor_id',
  label: t('vnp.picker.field.label'),
  kind: 'custom',
  required: true,
  initial,
  valid: (value) => typeof value === 'string' && value !== '',
  render: (value, set, id) => <ContractorPicker value={typeof value === 'string' ? value : ''} set={set} id={id} />,
});

export function CreateRequestDialog({ contractorId, onClose, onDone }: DialogProps & { contractorId?: string | undefined }) {
  const { t } = useTranslation();
  const command = usePortalCommand('createVendorPortalRequest');
  const fields: FieldSpec[] = [
    contractorField(t, contractorId ?? ''),
    { name: 'kind', label: t('vnp.create.field.kind.label'), kind: 'select', required: true, options: REQUEST_KINDS.map((kind) => ({ value: kind, label: requestKindLabel(t, kind) })) },
    { name: 'title', label: t('vnp.create.field.title.label'), kind: 'text', required: true, min: 3, max: 200 },
    { name: 'body', label: t('vnp.create.field.body.label'), kind: 'textarea', max: 4000 },
    { name: 'subject_type', label: t('vnp.create.field.subject.label'), kind: 'select', options: SUBJECT_TYPES.map((subject) => ({ value: subject, label: subjectTypeLabel(t, subject) })) },
    { name: 'subject_id', label: t('vnp.create.field.subjectId.label'), kind: 'uuid', visible: (values) => text(values.subject_type) !== '' },
    { name: 'due_on', label: t('vnp.create.field.due.label'), kind: 'date', hint: t('vnp.create.field.due.hint') },
  ];
  return (
    <CommandDialog
      title={t('vnp.create.title.text')}
      context={[]}
      note={<p className="vnd-note">{t('vnp.create.note.text')}</p>}
      confirmLabel={t('vnp.create.confirm.action')}
      fields={fields}
      describeError={portalErrorText}
      run={(values) => {
        const subject = subjectOf(values.subject_type);
        return command.mutateAsync({
          path: { id: text(values.contractor_id) },
          body: {
            kind: requestKindOf(values.kind),
            title: text(values.title),
            ...optional('body', values.body),
            ...(subject === undefined ? {} : { subject_type: subject, ...optional('subject_id', values.subject_id) }),
            ...optional('due_on', values.due_on),
          },
        });
      }}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function AcceptRequestDialog({ request, onClose, onDone }: DialogProps & { request: Pick<StaffRequest, 'id' | 'title' | 'contractor_name' | 'version'> }) {
  const { t } = useTranslation();
  const command = usePortalCommand('acceptVendorPortalRequest');
  return (
    <CommandDialog
      title={t('vnp.accept.title.text')}
      context={[
        { label: t('vnp.manage.context.contractor'), value: request.contractor_name },
        { label: t('vnp.answer.context.request'), value: request.title },
      ]}
      note={<p className="vnd-note">{t('vnp.accept.note.text')}</p>}
      confirmLabel={t('vnp.accept.confirm.action')}
      fields={[]}
      describeError={portalErrorText}
      run={() => command.mutateAsync({ path: { id: request.id }, ifMatchVersion: request.version })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function ReturnRequestDialog({ request, mode, onClose, onDone }: DialogProps & { request: Pick<StaffRequest, 'id' | 'title' | 'contractor_name' | 'version'>; mode: 'return' | 'cancel' }) {
  const { t } = useTranslation();
  const giveBack = usePortalCommand('returnVendorPortalRequest');
  const cancel = usePortalCommand('cancelVendorPortalRequest');
  const returning = mode === 'return';
  return (
    <CommandDialog
      title={returning ? t('vnp.return.title.text') : t('vnp.cancel.title.text')}
      context={[
        { label: t('vnp.manage.context.contractor'), value: request.contractor_name },
        { label: t('vnp.answer.context.request'), value: request.title },
      ]}
      note={<p className="vnd-note">{returning ? t('vnp.return.note.text') : t('vnp.cancel.note.text')}</p>}
      confirmLabel={returning ? t('vnp.return.confirm.action') : t('vnp.cancel.confirm.action')}
      danger={!returning}
      fields={[reasonField(t, 5)]}
      describeError={portalErrorText}
      run={(values) => (returning ? giveBack : cancel).mutateAsync({ path: { id: request.id }, ifMatchVersion: request.version, body: { reason: text(values.reason) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** A plan of remediation with its actions: each action has a description and a due day. */
export function CreatePlanDialog({ contractorId, onClose, onDone }: DialogProps & { contractorId?: string | undefined }) {
  const { t } = useTranslation();
  const command = usePortalCommand('createVendorRemediationPlan');
  const initial: Row[] = [{ description: '', due_on: '' }];
  const fields: FieldSpec[] = [
    contractorField(t, contractorId ?? ''),
    { name: 'title', label: t('vnp.create.field.title.label'), kind: 'text', required: true, min: 3, max: 200 },
    { name: 'objective', label: t('vnp.planCreate.field.objective.label'), kind: 'textarea', required: true, min: 10, max: 2000 },
    { name: 'trigger_kind', label: t('vnp.planCreate.field.trigger.label'), kind: 'select', required: true, options: TRIGGER_KINDS.map((kind) => ({ value: kind, label: triggerKindLabel(t, kind) })) },
    { name: 'contract_id', label: t('vnp.planCreate.field.contract.label'), kind: 'uuid' },
    {
      name: 'actions',
      label: t('vnp.planCreate.field.actions.label'),
      kind: 'custom',
      initial,
      valid: (value) => rowsOf(value).length > 0 && rowsOf(value).every((row) => text(row.description).length >= 5 && isDay(text(row.due_on))),
      render: (value, set) => (
        <RowsEditor
          rows={rowsOf(value)}
          onChange={set}
          blank={() => ({ description: '', due_on: '' })}
          addLabel={t('vnp.planCreate.actions.add.action')}
          removeLabel={(index) => t('vnp.planCreate.actions.remove.label', { row: index + 1 })}
          columns={[
            { name: 'description', label: t('vnp.planCreate.actions.column.description'), kind: 'text' },
            { name: 'due_on', label: t('vnp.planCreate.actions.column.due'), kind: 'text' },
          ]}
        />
      ),
    },
  ];
  return (
    <CommandDialog
      title={t('vnp.planCreate.title.text')}
      context={[]}
      note={<p className="vnd-note">{t('vnp.planCreate.note.text')}</p>}
      confirmLabel={t('vnp.planCreate.confirm.action')}
      fields={fields}
      wide
      describeError={portalErrorText}
      run={(values) =>
        command.mutateAsync({
          path: { id: text(values.contractor_id) },
          body: {
            title: text(values.title),
            objective: text(values.objective),
            trigger_kind: triggerOf(values.trigger_kind),
            ...optional('contract_id', values.contract_id),
            actions: rowsOf(values.actions).map((row) => ({ description: text(row.description), due_on: text(row.due_on) })),
          },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** A step of a plan that needs no field: start it, or complete it (every action verified). */
export function PlanStepDialog({ plan, step, onClose, onDone }: DialogProps & { plan: Pick<PlanLine, 'id' | 'title' | 'version'>; step: 'start' | 'complete' }) {
  const { t } = useTranslation();
  const start = usePortalCommand('startVendorRemediationPlan');
  const complete = usePortalCommand('completeVendorRemediationPlan');
  const starting = step === 'start';
  return (
    <CommandDialog
      title={starting ? t('vnp.planStart.title.text') : t('vnp.planComplete.title.text')}
      context={[{ label: t('vnp.plan.context.plan'), value: plan.title }]}
      note={<p className="vnd-note">{starting ? t('vnp.planStart.note.text') : t('vnp.planComplete.note.text')}</p>}
      confirmLabel={starting ? t('vnp.planStart.confirm.action') : t('vnp.planComplete.confirm.action')}
      fields={[]}
      describeError={portalErrorText}
      run={() => (starting ? start : complete).mutateAsync({ path: { id: plan.id }, ifMatchVersion: plan.version })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function VerifyActionDialog({ action, onClose, onDone }: DialogProps & { action: Pick<PlanActionLine, 'id' | 'description' | 'version' | 'status'> }) {
  const { t } = useTranslation();
  const command = usePortalCommand('verifyVendorRemediationAction');
  const fields: FieldSpec[] = [
    {
      name: 'outcome',
      label: t('vnp.verify.field.outcome.label'),
      kind: 'select',
      required: true,
      options: [
        { value: 'VERIFIED', label: t('vnp.verify.outcome.verified.name') },
        { value: 'REOPEN', label: t('vnp.verify.outcome.reopen.name') },
      ],
    },
    { name: 'note', label: t('vnp.verify.field.note.label'), kind: 'textarea', max: 2000, required: true, min: 1 },
  ];
  return (
    <CommandDialog
      title={t('vnp.verify.title.text')}
      context={[
        { label: t('vnp.plan.context.action'), value: action.description },
        { label: t('vnp.verify.context.status'), value: actionStatusLabel(t, action.status) },
      ]}
      note={<p className="vnd-note">{t('vnp.verify.note.text')}</p>}
      confirmLabel={t('vnp.verify.confirm.action')}
      fields={fields}
      describeError={portalErrorText}
      run={(values) => command.mutateAsync({ path: { id: action.id }, ifMatchVersion: action.version, body: { outcome: values.outcome === 'REOPEN' ? 'REOPEN' : 'VERIFIED', note: text(values.note) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function ClosePlanDialog({ plan, onClose, onDone }: DialogProps & { plan: Pick<PlanLine, 'id' | 'title' | 'version'> }) {
  const { t } = useTranslation();
  const command = usePortalCommand('closeVendorRemediationPlan');
  const fields: FieldSpec[] = [
    {
      name: 'outcome',
      label: t('vnp.close.field.outcome.label'),
      kind: 'select',
      required: true,
      options: [
        { value: 'FAILED', label: t('vnp.close.outcome.failed.name') },
        { value: 'CANCELLED', label: t('vnp.close.outcome.cancelled.name') },
      ],
    },
    reasonField(t, 5),
  ];
  return (
    <CommandDialog
      title={t('vnp.close.title.text')}
      context={[{ label: t('vnp.plan.context.plan'), value: plan.title }]}
      note={<p className="vnd-note">{t('vnp.close.note.text')}</p>}
      confirmLabel={t('vnp.close.confirm.action')}
      danger
      fields={fields}
      describeError={portalErrorText}
      run={(values) => command.mutateAsync({ path: { id: plan.id }, ifMatchVersion: plan.version, body: { outcome: values.outcome === 'CANCELLED' ? 'CANCELLED' : 'FAILED', reason: text(values.reason) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** The time of a receipt line, in the words of the screen. */
export const receiptTime = (): string => vietnamStamp(new Date().toISOString());
