import { useTranslation } from '../../../i18n';
import { CommandDialog, reasonField } from '../shared/vnd-form';
import type { FieldSpec, Values } from '../shared/vnd-form';
import { useVendorCommand } from '../shared/vnd-hooks';
import { groupLabel, moveLabel, scopeLabel, triggerLabel } from '../shared/vnd-labels';
import { SCOPES, TRIGGER_KINDS, VIOLATION_GROUPS, banRange, paramNumber, periodsOf, resourceId } from '../shared/vnd-model';
import type { CaseDetail, CaseLine, CaseMoveCode, Scope, TriggerKind } from '../shared/vnd-model';
import { Empty } from '../shared/vnd-ui';

interface DialogProps {
  onClose: () => void;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

function groupOptions(t: ReturnType<typeof useTranslation>['t']): FieldSpec['options'] {
  return VIOLATION_GROUPS.map((group) => ({ value: group, label: groupLabel(t, group) }));
}

const optionalId = (name: string, value: unknown): Record<string, string> => (text(value) === '' ? {} : { [name]: text(value) });

// ---- opening a case -------------------------------------------------------------------------------------------------------------------------------------------------------

/** A case is opened from a proposal; the clock of the decision starts when it is received. The contractor is chosen by its id (the register links here with the id filled in). */
export function OpenCaseDialog({ initialContractor, onClose, onDone }: DialogProps & { initialContractor: string; onDone: (caseId: string | undefined) => void }) {
  const { t } = useTranslation();
  const command = useVendorCommand('openVendorRestrictionCase');
  const fields: FieldSpec[] = [
    {
      name: 'subject_kind',
      label: t('vnd.cases.field.subject.label'),
      kind: 'select',
      required: true,
      initial: 'CONTRACTOR',
      options: [
        { value: 'CONTRACTOR', label: t('vnd.subject.contractor.name') },
        { value: 'JOINT_VENTURE', label: t('vnd.subject.jointVenture.name') },
      ],
    },
    { name: 'contractor_id', label: t('vnd.cases.field.contractor.label'), kind: 'uuid', required: true, initial: initialContractor, visible: (values) => values.subject_kind !== 'JOINT_VENTURE', hint: t('vnd.cases.field.id.hint') },
    { name: 'joint_venture_id', label: t('vnd.cases.field.venture.label'), kind: 'uuid', required: true, visible: (values) => values.subject_kind === 'JOINT_VENTURE', hint: t('vnd.cases.field.id.hint') },
    { name: 'trigger_kind', label: t('vnd.cases.field.trigger.label'), kind: 'select', required: true, initial: 'INVESTOR_PROPOSAL', options: TRIGGER_KINDS.map((kind) => ({ value: kind, label: triggerLabel(t, kind) })) },
    { name: 'trigger_ref', label: t('vnd.cases.field.triggerRef.label'), kind: 'text', max: 200 },
    { name: 'violation_groups', label: t('vnd.cases.field.groups.label'), kind: 'checks', required: true, options: groupOptions(t) },
    { name: 'violation_summary', label: t('vnd.cases.field.summary.label'), kind: 'textarea', required: true, min: 20, max: 2000, hint: t('vnd.cases.field.summary.hint', { count: 20 }) },
    { name: 'violation_on', label: t('vnd.cases.field.violationOn.label'), kind: 'date', required: true },
    { name: 'proposal_document_id', label: t('vnd.cases.field.proposal.label'), kind: 'uuid', hint: t('vnd.cases.field.id.hint') },
  ];
  const triggerOf = (value: unknown): TriggerKind => TRIGGER_KINDS.find((kind) => kind === value) ?? 'INVESTOR_PROPOSAL';
  return (
    <CommandDialog
      title={t('vnd.cases.open.title')}
      context={[]}
      note={<p className="vnd-note">{t('vnd.cases.open.note')}</p>}
      confirmLabel={t('vnd.cases.open.confirm')}
      fields={fields}
      wide
      run={(values) => {
        const venture = values.subject_kind === 'JOINT_VENTURE';
        return command.mutateAsync({
          body: {
            subject_kind: venture ? 'JOINT_VENTURE' : 'CONTRACTOR',
            ...(venture ? { joint_venture_id: text(values.joint_venture_id) } : { contractor_id: text(values.contractor_id) }),
            trigger_kind: triggerOf(values.trigger_kind),
            ...(text(values.trigger_ref) === '' ? {} : { trigger_ref: text(values.trigger_ref) }),
            violation_groups: list(values.violation_groups),
            violation_summary: text(values.violation_summary),
            violation_on: text(values.violation_on),
            ...optionalId('proposal_document_id', values.proposal_document_id),
          },
        });
      }}
      onClose={onClose}
      onDone={(result) => onDone(resourceId(result))}
    />
  );
}

/** A case opened from a restriction record of the national network that BID-24 imported: the record is named by its id, the rest is the same proposal. */
export function OpenFromEgpDialog({ onClose, onDone }: DialogProps & { onDone: (caseId: string | undefined) => void }) {
  const { t } = useTranslation();
  const command = useVendorCommand('openVendorRestrictionCaseFromEgpRecord');
  const fields: FieldSpec[] = [
    { name: 'egp_record_id', label: t('vnd.cases.field.egpRecord.label'), kind: 'uuid', required: true, hint: t('vnd.cases.field.egpRecord.hint') },
    { name: 'violation_groups', label: t('vnd.cases.field.groups.label'), kind: 'checks', required: true, options: groupOptions(t) },
    { name: 'violation_summary', label: t('vnd.cases.field.summaryOptional.label'), kind: 'textarea', min: 20, max: 2000, hint: t('vnd.cases.field.summary.hint', { count: 20 }) },
    { name: 'proposal_document_id', label: t('vnd.cases.field.proposal.label'), kind: 'uuid', hint: t('vnd.cases.field.id.hint') },
  ];
  return (
    <CommandDialog
      title={t('vnd.cases.egp.title')}
      context={[]}
      note={<p className="vnd-note">{t('vnd.cases.egp.note')}</p>}
      confirmLabel={t('vnd.cases.egp.confirm')}
      fields={fields}
      run={(values) =>
        command.mutateAsync({
          body: {
            egp_record_id: text(values.egp_record_id),
            violation_groups: list(values.violation_groups),
            ...(text(values.violation_summary) === '' ? {} : { violation_summary: text(values.violation_summary) }),
            ...optionalId('proposal_document_id', values.proposal_document_id),
          },
        })
      }
      onClose={onClose}
      onDone={(result) => onDone(resourceId(result))}
    />
  );
}

// ---- the steps of a case ---------------------------------------------------------------------------------------------------------------------------------------------

/** One move of a case: send the notice, record the response, close the window without a response, or withdraw the proposal. Each says what the move does and what it needs. */
export function AdvanceDialog({ line, move, onClose, onDone }: DialogProps & { line: CaseLine; move: CaseMoveCode; onDone: () => void }) {
  const { t } = useTranslation();
  const command = useVendorCommand('advanceVendorRestrictionCase');
  const fields: FieldSpec[] =
    move === 'SEND_NOTICE'
      ? [
          { name: 'notice_document_id', label: t('vnd.cases.field.notice.label'), kind: 'uuid', hint: t('vnd.cases.field.id.hint') },
          { name: 'summary', label: t('vnd.cases.field.noteOptional.label'), kind: 'textarea', min: 5, max: 2000 },
        ]
      : move === 'RECORD_RESPONSE'
        ? [
            { name: 'summary', label: t('vnd.cases.field.response.label'), kind: 'textarea', required: true, min: 5, max: 2000, hint: t('vnd.field.reason.hint', { count: 5 }) },
            { name: 'response_document_id', label: t('vnd.cases.field.responseDocument.label'), kind: 'uuid', hint: t('vnd.cases.field.id.hint') },
          ]
        : [reasonField(t, 10)];
  return (
    <CommandDialog
      title={moveLabel(t, move)}
      context={[
        { label: t('vnd.cases.fact.no.label'), value: line.case_no },
        { label: t('vnd.cases.fact.subject.label'), value: line.subject_name },
      ]}
      note={<p className="vnd-note">{move === 'WITHDRAW' ? t('vnd.cases.advance.withdraw.note') : move === 'CLOSE_NO_RESPONSE' ? t('vnd.cases.advance.close.note') : move === 'SEND_NOTICE' ? t('vnd.cases.advance.notice.note') : t('vnd.cases.advance.response.note')}</p>}
      confirmLabel={moveLabel(t, move)}
      danger={move === 'WITHDRAW'}
      fields={fields}
      run={(values) =>
        command.mutateAsync({
          path: { id: line.id },
          ifMatchVersion: line.version,
          body: {
            move,
            ...optionalId('notice_document_id', values.notice_document_id),
            ...optionalId('response_document_id', values.response_document_id),
            ...optionalId('summary', values.summary),
            ...optionalId('reason', values.reason),
          },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}

// ---- the decision -------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The decision of the authority: a ban (its reach, its months inside the range the violation groups allow, its first day and the document of the decision) or a dismissal, with the reason. A joint venture names the members that
 * are culpable, or none for all. The proposer cannot decide: the server says so (403 SELF_APPROVAL_DENIED) and the dialog repeats the refusal.
 */
export function DecideDialog({ detail, onClose, onDone }: DialogProps & { detail: CaseDetail; onDone: () => void }) {
  const { t } = useTranslation();
  const command = useVendorCommand('decideVendorRestrictionCase');
  const line = detail.case;
  const range = banRange(line.violation_groups, periodsOf(detail.periods), paramNumber(detail.policy, 'cumulative_max_months'));
  const ban = (values: Values): boolean => values.decision === 'BAN';
  const fields: FieldSpec[] = [
    {
      name: 'decision',
      label: t('vnd.cases.field.decision.label'),
      kind: 'select',
      required: true,
      options: [
        { value: 'BAN', label: t('vnd.cases.decision.ban.name') },
        { value: 'DISMISS', label: t('vnd.cases.decision.dismiss.name') },
      ],
    },
    { name: 'scope', label: t('vnd.cases.field.scope.label'), kind: 'select', required: true, visible: ban, options: SCOPES.map((scope) => ({ value: scope, label: scopeLabel(t, scope) })), hint: t('vnd.cases.field.scope.hint') },
    {
      name: 'ban_months',
      label: t('vnd.cases.field.months.label'),
      kind: 'number',
      required: true,
      visible: ban,
      min: range?.min ?? 1,
      max: range?.max ?? 600,
      hint: range === null ? t('vnd.cases.field.monthsPlain.hint') : t('vnd.cases.field.months.hint', { min: range.min, max: range.max }),
    },
    { name: 'effective_from', label: t('vnd.cases.field.effectiveFrom.label'), kind: 'date', required: true, visible: ban },
    { name: 'decision_document_id', label: t('vnd.cases.field.decisionDocument.label'), kind: 'uuid', required: true, visible: ban, hint: t('vnd.cases.field.id.hint') },
    {
      name: 'culpable_member_ids',
      label: t('vnd.cases.field.culpable.label'),
      kind: 'checks',
      visible: (values) => ban(values) && line.subject_kind === 'JOINT_VENTURE',
      options: detail.members.map((member) => ({ value: member.contractor_id, label: member.contractor_name })),
      hint: t('vnd.cases.field.culpable.hint'),
    },
    reasonField(t, 10),
  ];
  return (
    <CommandDialog
      title={t('vnd.cases.decide.title')}
      context={[
        { label: t('vnd.cases.fact.no.label'), value: line.case_no },
        { label: t('vnd.cases.fact.subject.label'), value: line.subject_name },
      ]}
      note={<p className="vnd-note">{t('vnd.cases.decide.note')}</p>}
      confirmLabel={t('vnd.cases.decide.confirm')}
      danger
      wide
      fields={fields}
      extra={(values) => (ban(values) && line.subject_kind === 'JOINT_VENTURE' && detail.members.length === 0 ? <Empty text={t('vnd.cases.members.empty.text')} /> : null)}
      run={(values) =>
        command.mutateAsync({
          path: { id: line.id },
          ifMatchVersion: line.version,
          body: ban(values)
            ? {
                decision: 'BAN',
                reason: text(values.reason),
                scope: SCOPES.find((scope): scope is Scope => scope === values.scope) ?? 'TENANT',
                ban_months: Number(text(values.ban_months)),
                effective_from: text(values.effective_from),
                decision_document_id: text(values.decision_document_id),
                ...(list(values.culpable_member_ids).length === 0 ? {} : { culpable_member_ids: list(values.culpable_member_ids) }),
              }
            : { decision: 'DISMISS', reason: text(values.reason) },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** The decision put into effect: the restriction is written for every member reached. It is a command of its own so that it can be done by the one who holds the right, after the decision. */
export function EffectDialog({ line, members, onClose, onDone }: DialogProps & { line: CaseLine; members: number; onDone: () => void }) {
  const { t } = useTranslation();
  const command = useVendorCommand('putVendorRestrictionIntoEffect');
  return (
    <CommandDialog
      title={t('vnd.cases.effect.title')}
      context={[
        { label: t('vnd.cases.fact.no.label'), value: line.case_no },
        { label: t('vnd.cases.fact.subject.label'), value: line.subject_name },
        { label: t('vnd.cases.members.title'), value: String(members) },
      ]}
      note={<p className="vnd-note">{t('vnd.cases.effect.note')}</p>}
      confirmLabel={t('vnd.cases.effect.confirm')}
      danger
      fields={[]}
      run={() => command.mutateAsync({ path: { id: line.id }, ifMatchVersion: line.version })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function LiftDialog({ line, onClose, onDone }: DialogProps & { line: CaseLine; onDone: () => void }) {
  const { t } = useTranslation();
  const command = useVendorCommand('liftVendorRestrictionCase');
  return (
    <CommandDialog
      title={t('vnd.cases.lift.title')}
      context={[
        { label: t('vnd.cases.fact.no.label'), value: line.case_no },
        { label: t('vnd.cases.fact.subject.label'), value: line.subject_name },
      ]}
      note={<p className="vnd-note">{t('vnd.cases.lift.note')}</p>}
      confirmLabel={t('vnd.cases.lift.confirm')}
      danger
      fields={[reasonField(t, 10), { name: 'document_id', label: t('vnd.cases.field.liftDocument.label'), kind: 'uuid', hint: t('vnd.cases.field.id.hint') }]}
      run={(values) => command.mutateAsync({ path: { id: line.id }, ifMatchVersion: line.version, body: { reason: text(values.reason), ...optionalId('document_id', values.document_id) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
