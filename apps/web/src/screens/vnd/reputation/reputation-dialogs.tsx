import { useTranslation } from '../../../i18n';
import { CommandDialog, RowsEditor, reasonField, rowsOf } from '../shared/vnd-form';
import type { FieldSpec, Row } from '../shared/vnd-form';
import { useVendorCommand } from '../shared/vnd-hooks';
import { behaviourLabel } from '../shared/vnd-labels';
import { BEHAVIOURS, isUuid, shareValue, ventureProblems, ventureTotal } from '../shared/vnd-model';
import type { Behaviour, ReputationEvent, Venture, VentureDraftMember } from '../shared/vnd-model';

interface DialogProps {
  onClose: () => void;
  onDone: () => void;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const optional = (name: string, value: unknown): Record<string, string> => (text(value) === '' ? {} : { [name]: text(value) });
const behaviourOf = (value: unknown): Behaviour => BEHAVIOURS.find((code) => code === value) ?? 'OTHER_BY_LAW';

/** Records a bid-conduct event of a contractor (Article 20 of Decree 214/2025). The clock of posting starts now: seven working days by the rule, which is not verified. */
export function RecordEventDialog({ initialContractor, onClose, onDone }: DialogProps & { initialContractor: string }) {
  const { t } = useTranslation();
  const command = useVendorCommand('recordVendorReputationEvent');
  const fields: FieldSpec[] = [
    { name: 'contractor_id', label: t('vnd.reputation.field.contractor.label'), kind: 'uuid', required: true, initial: initialContractor, hint: t('vnd.reputation.field.id.hint') },
    { name: 'behaviour_code', label: t('vnd.reputation.field.behaviour.label'), kind: 'select', required: true, options: BEHAVIOURS.map((code) => ({ value: code, label: behaviourLabel(t, code) })) },
    { name: 'event_on', label: t('vnd.reputation.field.eventOn.label'), kind: 'date', required: true },
    { name: 'description', label: t('vnd.reputation.field.description.label'), kind: 'textarea', required: true, min: 10, max: 2000, hint: t('vnd.field.reason.hint', { count: 10 }) },
    { name: 'package_id', label: t('vnd.reputation.field.package.label'), kind: 'uuid', hint: t('vnd.reputation.field.id.hint') },
    { name: 'contract_id', label: t('vnd.reputation.field.contract.label'), kind: 'uuid', hint: t('vnd.reputation.field.id.hint') },
    { name: 'evidence_document_id', label: t('vnd.reputation.field.evidence.label'), kind: 'uuid', hint: t('vnd.reputation.field.evidence.hint') },
  ];
  return (
    <CommandDialog
      title={t('vnd.reputation.record.title')}
      context={[]}
      note={<p className="vnd-note">{t('vnd.reputation.record.note')}</p>}
      confirmLabel={t('vnd.reputation.record.confirm')}
      fields={fields}
      run={(values) =>
        command.mutateAsync({
          body: {
            contractor_id: text(values.contractor_id),
            behaviour_code: behaviourOf(values.behaviour_code),
            event_on: text(values.event_on),
            description: text(values.description),
            ...optional('package_id', values.package_id),
            ...optional('contract_id', values.contract_id),
            ...optional('evidence_document_id', values.evidence_document_id),
          },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** The receipt of the posting on the national network. Another person than the one who recorded the event posts it; the server refuses the same person (403 SELF_APPROVAL_DENIED). */
export function PostDialog({ event, onClose, onDone }: DialogProps & { event: ReputationEvent }) {
  const { t } = useTranslation();
  const command = useVendorCommand('postVendorReputationEvent');
  return (
    <CommandDialog
      title={t('vnd.reputation.post.title')}
      context={[
        { label: t('vnd.reputation.column.contractor'), value: event.contractor_name },
        { label: t('vnd.reputation.column.behaviour'), value: behaviourLabel(t, event.behaviour_code) },
      ]}
      note={<p className="vnd-note">{t('vnd.reputation.post.note')}</p>}
      confirmLabel={t('vnd.reputation.post.confirm')}
      fields={[{ name: 'receipt', label: t('vnd.reputation.field.receipt.label'), kind: 'text', required: true, min: 3, max: 100, hint: t('vnd.reputation.field.receipt.hint') }]}
      run={(values) => command.mutateAsync({ path: { id: event.id }, ifMatchVersion: event.version, body: { receipt: text(values.receipt) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function RetractDialog({ event, onClose, onDone }: DialogProps & { event: ReputationEvent }) {
  const { t } = useTranslation();
  const command = useVendorCommand('retractVendorReputationEvent');
  return (
    <CommandDialog
      title={t('vnd.reputation.retract.title')}
      context={[
        { label: t('vnd.reputation.column.contractor'), value: event.contractor_name },
        { label: t('vnd.reputation.column.behaviour'), value: behaviourLabel(t, event.behaviour_code) },
      ]}
      note={<p className="vnd-note">{t('vnd.reputation.retract.note')}</p>}
      confirmLabel={t('vnd.reputation.retract.confirm')}
      danger
      fields={[reasonField(t, 20)]}
      run={(values) => command.mutateAsync({ path: { id: event.id }, ifMatchVersion: event.version, body: { reason: text(values.reason) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

// ---- joint ventures ---------------------------------------------------------------------------------------------------------------------------------------------------------

const draftOf = (rows: Row[]): VentureDraftMember[] => rows.map((row) => ({ contractorId: text(row.contractor_id), share: text(row.share_pct), lead: row.lead === true }));

/**
 * A joint venture: a name, two members at least, each by its id with a share of the contribution, exactly one lead, shares that total 100. The total is shown as the rows are typed and the button stays off until the plan adds up;
 * the server checks the same and refuses a plan that does not (422 JOINT_VENTURE_SHARES_INVALID).
 */
export function CreateVentureDialog({ onClose, onDone }: DialogProps) {
  const { t } = useTranslation();
  const command = useVendorCommand('createVendorJointVenture');
  const blank = (): Row => ({ contractor_id: '', share_pct: '', lead: false });
  const fields: FieldSpec[] = [
    { name: 'name', label: t('vnd.ventures.field.name.label'), kind: 'text', required: true, min: 2, max: 300 },
    {
      name: 'members',
      label: t('vnd.ventures.field.members.label'),
      kind: 'custom',
      required: true,
      initial: [blank(), blank()],
      valid: (value) => ventureProblems(draftOf(rowsOf(value))).length === 0,
      render: (value, set) => (
        <RowsEditor
          rows={rowsOf(value)}
          onChange={set}
          blank={blank}
          addLabel={t('vnd.ventures.members.add.action')}
          removeLabel={(index) => t('vnd.ventures.members.remove.label', { row: index + 1 })}
          columns={[
            { name: 'contractor_id', label: t('vnd.ventures.members.column.contractor'), kind: 'text' },
            { name: 'share_pct', label: t('vnd.ventures.members.column.share'), kind: 'text', narrow: true },
            { name: 'lead', label: t('vnd.ventures.members.column.lead'), kind: 'radio' },
          ]}
        />
      ),
    },
    { name: 'agreement_document_id', label: t('vnd.ventures.field.agreement.label'), kind: 'uuid', hint: t('vnd.ventures.field.id.hint') },
    { name: 'package_id', label: t('vnd.ventures.field.package.label'), kind: 'uuid', hint: t('vnd.ventures.field.id.hint') },
    { name: 'starts_on', label: t('vnd.ventures.field.starts.label'), kind: 'date' },
  ];
  return (
    <CommandDialog
      title={t('vnd.ventures.create.title')}
      context={[]}
      note={<p className="vnd-note">{t('vnd.ventures.create.note')}</p>}
      confirmLabel={t('vnd.ventures.create.confirm')}
      fields={fields}
      wide
      extra={(values) => {
        const members = draftOf(rowsOf(values.members));
        const problems = ventureProblems(members);
        const total = ventureTotal(members);
        return (
          <div data-testid="venture-plan">
            <p className="vnd-total" data-ok={problems.length === 0 ? 'true' : 'false'} data-testid="venture-total">
              {t('vnd.ventures.total.text', { total })}
            </p>
            {problems.length > 0 && (
              <ul className="vnd-note" data-testid="venture-problems">
                {problems.includes('MEMBERS') && <li>{members.some((member) => member.contractorId !== '' && !isUuid(member.contractorId)) ? t('vnd.ventures.problem.id.text') : t('vnd.ventures.problem.members.text')}</li>}
                {problems.includes('SHARE') && <li>{t('vnd.ventures.problem.share.text')}</li>}
                {problems.includes('DUPLICATE') && <li>{t('vnd.ventures.problem.duplicate.text')}</li>}
                {problems.includes('LEAD') && <li>{t('vnd.ventures.problem.lead.text')}</li>}
                {problems.includes('TOTAL') && <li>{t('vnd.ventures.problem.total.text')}</li>}
              </ul>
            )}
          </div>
        );
      }}
      run={(values) =>
        command.mutateAsync({
          body: {
            name: text(values.name),
            members: draftOf(rowsOf(values.members)).map((member) => ({ contractor_id: member.contractorId, share_pct: String(shareValue(member.share) / 100), lead: member.lead })),
            ...optional('agreement_document_id', values.agreement_document_id),
            ...optional('package_id', values.package_id),
            ...optional('starts_on', values.starts_on),
          },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function EndVentureDialog({ venture, onClose, onDone }: DialogProps & { venture: Venture }) {
  const { t } = useTranslation();
  const command = useVendorCommand('endVendorJointVenture');
  return (
    <CommandDialog
      title={t('vnd.ventures.end.title')}
      context={[{ label: t('vnd.ventures.column.name'), value: venture.name }]}
      note={<p className="vnd-note">{t('vnd.ventures.end.note')}</p>}
      confirmLabel={t('vnd.ventures.end.confirm')}
      danger
      fields={[reasonField(t, 5)]}
      run={(values) => command.mutateAsync({ path: { id: venture.id }, ifMatchVersion: venture.version, body: { reason: text(values.reason) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
