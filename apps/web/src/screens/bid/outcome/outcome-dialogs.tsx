import { useTranslation } from '../../../i18n';
import { CommandDialog, reasonField } from '../../vnd/shared/vnd-form';
import type { FieldSpec } from '../../vnd/shared/vnd-form';
import { useOutcomeCommand } from './outcome-hooks';
import { decisionLabel, outcomeErrorText } from './outcome-labels';
import { DECISIONS } from './outcome-model';
import type { Decision, OutcomeLine } from './outcome-model';

interface DialogProps {
  onClose: () => void;
  onDone: () => void;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const decisionOf = (value: unknown): Decision => DECISIONS.find((decision) => decision === value) ?? 'REJECTED';

/** One person records what the authority decided on a petition, with the reference of the decision; it counts in no figure until a different person confirms it. */
export function RecordOutcomeDialog({ petitionId, onClose, onDone }: DialogProps & { petitionId?: string | undefined }) {
  const { t } = useTranslation();
  const command = useOutcomeCommand('recordProcurementPetitionOutcome');
  const fields: FieldSpec[] = [
    { name: 'petition_id', label: t('bid34.record.field.petition.label'), kind: 'uuid', required: true, initial: petitionId ?? '', hint: t('bid34.record.field.petition.hint') },
    { name: 'outcome', label: t('bid34.record.field.outcome.label'), kind: 'select', required: true, options: DECISIONS.map((decision) => ({ value: decision, label: decisionLabel(t, decision) })) },
    { name: 'decision_ref', label: t('bid34.record.field.ref.label'), kind: 'text', required: true, min: 3, max: 120, hint: t('bid34.record.field.ref.hint') },
    { name: 'decision_on', label: t('bid34.record.field.day.label'), kind: 'date', required: true },
    { name: 'decision_document_id', label: t('bid34.record.field.document.label'), kind: 'uuid' },
    { name: 'note', label: t('bid34.record.field.note.label'), kind: 'textarea', max: 1000 },
  ];
  return (
    <CommandDialog
      title={t('bid34.record.title.text')}
      context={[]}
      note={<p className="vnd-note">{t('bid34.record.note.text')}</p>}
      confirmLabel={t('bid34.record.confirm.action')}
      fields={fields}
      describeError={outcomeErrorText}
      run={(values) =>
        command.mutateAsync({
          path: { id: text(values.petition_id) },
          body: {
            outcome: decisionOf(values.outcome),
            decision_ref: text(values.decision_ref),
            decision_on: text(values.decision_on),
            ...(text(values.decision_document_id) === '' ? {} : { decision_document_id: text(values.decision_document_id) }),
            ...(text(values.note) === '' ? {} : { note: text(values.note) }),
          },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** The second person confirms (the decision then counts in the dispute figures and cannot change) or returns it with a reason so that it is recorded again. */
export function CheckOutcomeDialog({ line, mode, onClose, onDone }: DialogProps & { line: Pick<OutcomeLine, 'id' | 'version' | 'decision_ref' | 'outcome' | 'package' | 'contractor'>; mode: 'confirm' | 'return' }) {
  const { t } = useTranslation();
  const confirm = useOutcomeCommand('confirmProcurementPetitionOutcome');
  const giveBack = useOutcomeCommand('returnProcurementPetitionOutcome');
  const confirming = mode === 'confirm';
  return (
    <CommandDialog
      title={confirming ? t('bid34.confirm.title.text') : t('bid34.return.title.text')}
      context={[
        { label: t('bid34.context.package'), value: line.package.code },
        { label: t('bid34.context.contractor'), value: line.contractor.legal_name },
        { label: t('bid34.context.outcome'), value: decisionLabel(t, line.outcome) },
        { label: t('bid34.context.ref'), value: line.decision_ref },
      ]}
      note={<p className="vnd-note">{confirming ? t('bid34.confirm.note.text') : t('bid34.return.note.text')}</p>}
      confirmLabel={confirming ? t('bid34.confirm.confirm.action') : t('bid34.return.confirm.action')}
      danger={!confirming}
      fields={confirming ? [] : [reasonField(t, 5, 1000)]}
      describeError={outcomeErrorText}
      run={(values) => (confirming ? confirm.mutateAsync({ path: { id: line.id }, ifMatchVersion: line.version }) : giveBack.mutateAsync({ path: { id: line.id }, ifMatchVersion: line.version, body: { reason: text(values.reason) } }))}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
