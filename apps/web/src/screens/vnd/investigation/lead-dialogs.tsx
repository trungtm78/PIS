import { useTranslation } from '../../../i18n';
import { CommandDialog, reasonField } from '../shared/vnd-form';
import type { FieldSpec, Values } from '../shared/vnd-form';
import { useVendorCommand } from './investigation-hooks';
import { leadKindLabel } from './investigation-labels';
import type { LeadLine } from './investigation-model';

export type LeadMove = 'take' | 'proposeDismissal' | 'confirmDismissal' | 'rejectDismissal' | 'confirmSignal' | 'refer';

const WITH_REASON: readonly LeadMove[] = ['proposeDismissal', 'rejectDismissal', 'confirmSignal', 'refer'];
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

interface Props {
  move: LeadMove;
  lead: LeadLine;
  onClose: () => void;
  onDone: () => void;
}

/**
 * One move of the review of a lead (G4-3 manner). Taking and confirming a dismissal ask nothing; a dismissal is proposed with a reason and confirmed by a DIFFERENT auditor (the server refuses the same person with 403
 * SELF_APPROVAL_DENIED and the dialog says so); a signal is confirmed as right, or the lead is referred, each with a reason. The version the person saw goes with the command: a changed lead asks for a reload.
 */
export function LeadMoveDialog({ move, lead, onClose, onDone }: Props) {
  const { t } = useTranslation();
  const take = useVendorCommand('takeVendorLead');
  const propose = useVendorCommand('proposeVendorLeadDismissal');
  const confirmDismissal = useVendorCommand('confirmVendorLeadDismissal');
  const reject = useVendorCommand('rejectVendorLeadDismissal');
  const confirmSignal = useVendorCommand('confirmVendorLeadSignal');
  const refer = useVendorCommand('referVendorLead');
  const fields: FieldSpec[] = WITH_REASON.includes(move) ? [reasonField(t, 5)] : [];
  const base = { path: { id: lead.id }, ifMatchVersion: lead.version };
  const run = (values: Values): Promise<unknown> => {
    switch (move) {
      case 'take':
        return take.mutateAsync(base);
      case 'confirmDismissal':
        return confirmDismissal.mutateAsync(base);
      case 'proposeDismissal':
        return propose.mutateAsync({ ...base, body: { reason: text(values.reason) } });
      case 'rejectDismissal':
        return reject.mutateAsync({ ...base, body: { reason: text(values.reason) } });
      case 'confirmSignal':
        return confirmSignal.mutateAsync({ ...base, body: { reason: text(values.reason) } });
      case 'refer':
        return refer.mutateAsync({ ...base, body: { reason: text(values.reason) } });
    }
  };
  return (
    <CommandDialog
      title={t(`vnd3.leadMove.${move}.title`)}
      context={[
        { label: t('vnd3.lead.field.kind.label'), value: leadKindLabel(t, lead.kind) },
        { label: t('vnd3.lead.field.contractors.label'), value: lead.contractor_names.join(', ') },
      ]}
      note={<p className="vnd-note">{t(`vnd3.leadMove.${move}.note`)}</p>}
      confirmLabel={t(`vnd3.leadMove.${move}.confirm`)}
      danger={move === 'refer' || move === 'confirmDismissal'}
      fields={fields}
      run={run}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
