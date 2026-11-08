import { useTranslation } from '../../../i18n';
import { CommandDialog, reasonField } from '../shared/vnd-form';
import type { FieldSpec } from '../shared/vnd-form';
import { useVendorCommand } from '../shared/vnd-hooks';
import { DECISIONS, INTEREST_KINDS, decisionLabel, findingKindLabel, interestKindLabel, wholeAmount } from './controls-model';
import type { Decision, IndependenceFinding, InterestKind, PackageControls, PersonInterest } from './controls-model';

interface DialogProps {
  onClose: () => void;
  onDone: () => void;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const optional = (name: string, value: unknown): Record<string, string> => (text(value) === '' ? {} : { [name]: text(value) });
const kindOf = (value: unknown): InterestKind => INTEREST_KINDS.find((kind) => kind === value) ?? 'ADVISORY';
const ids = (value: string): string[] =>
  value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The panel and the staff are typed as lists of membership ids (one per line or separated by commas): the screen of the members is where a person looks them up. */
export function RunCheckDialog({ packageId, packageLabel, onClose, onDone }: DialogProps & { packageId: string; packageLabel: string }) {
  const { t } = useTranslation();
  const command = useVendorCommand('runVendorIndependenceCheck');
  const listOk = (value: unknown): boolean => typeof value === 'string' && ids(value).every((item) => UUID.test(item)) && ids(value).length <= 100;
  const fields: FieldSpec[] = [
    { name: 'panel', label: t('vnd.controls.run.panel.label'), kind: 'textarea', hint: t('vnd.controls.run.panel.hint'), max: 4000 },
    { name: 'staff', label: t('vnd.controls.run.staff.label'), kind: 'textarea', hint: t('vnd.controls.run.staff.hint'), max: 4000 },
    { name: 'owner_tax_code', label: t('vnd.controls.run.owner.label'), kind: 'text', hint: t('vnd.controls.run.owner.hint'), min: 10, max: 20 },
  ];
  return (
    <CommandDialog
      title={t('vnd.controls.run.title')}
      context={[{ label: t('vnd.controls.context.package'), value: packageLabel }]}
      note={<p className="vnd-note">{t('vnd.controls.run.note')}</p>}
      confirmLabel={t('vnd.controls.run.confirm')}
      fields={fields}
      blocked={(values) => !listOk(values.panel) || !listOk(values.staff)}
      run={(values) =>
        command.mutateAsync({
          path: { id: packageId },
          body: { panel_membership_ids: ids(text(values.panel)), staff_membership_ids: ids(text(values.staff)), ...optional('owner_tax_code', values.owner_tax_code) },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** The decisions that fit the finding are the only ones offered; the reason is at least 20 characters and the person who decides is not the one who ran the check (the server holds both). */
export function DecideDialog({ finding, onClose, onDone }: DialogProps & { finding: IndependenceFinding }) {
  const { t } = useTranslation();
  const command = useVendorCommand('decideVendorIndependenceFinding');
  const allowed = DECISIONS.filter((decision) => finding.allowed_decisions.includes(decision));
  const fields: FieldSpec[] = [
    { name: 'decision', label: t('vnd.controls.decide.decision.label'), kind: 'select', required: true, options: allowed.map((decision) => ({ value: decision, label: decisionLabel(t, decision) })) },
    reasonField(t, 20, 2000),
  ];
  return (
    <CommandDialog
      title={t('vnd.controls.decide.title')}
      context={[{ label: t('vnd.controls.decide.finding.label'), value: findingKindLabel(t, finding.kind) }]}
      note={<p className="vnd-note">{t('vnd.controls.decide.note')}</p>}
      confirmLabel={t('vnd.controls.decide.confirm')}
      fields={fields}
      run={(values) => {
        const decision: Decision = DECISIONS.find((item) => item === values.decision) ?? 'CLEARED';
        return command.mutateAsync({ path: { id: finding.id }, ifMatchVersion: finding.version, body: { decision, reason: text(values.reason) } });
      }}
      onClose={onClose}
      onDone={onDone}
      danger
    />
  );
}

export function DeclareInterestDialog({ onClose, onDone }: DialogProps) {
  const { t } = useTranslation();
  const command = useVendorCommand('declareVendorPersonInterest');
  const fields: FieldSpec[] = [
    { name: 'kind', label: t('vnd.controls.interest.kind.label'), kind: 'select', required: true, options: INTEREST_KINDS.map((kind) => ({ value: kind, label: interestKindLabel(t, kind) })) },
    { name: 'related_name', label: t('vnd.controls.interest.relative.label'), kind: 'text', min: 2, max: 300, visible: (values) => values.kind === 'RELATIVE', required: true },
    { name: 'related_identity_number', label: t('vnd.controls.interest.identity.label'), kind: 'text', min: 5, max: 40, hint: t('vnd.controls.interest.identity.hint'), visible: (values) => values.kind === 'RELATIVE' },
    { name: 'relation', label: t('vnd.controls.interest.relation.label'), kind: 'text', min: 2, max: 100, visible: (values) => values.kind === 'RELATIVE' },
    { name: 'contractor_id', label: t('vnd.controls.interest.contractor.label'), kind: 'uuid', hint: t('vnd.controls.interest.contractor.hint'), visible: (values) => values.kind !== 'RELATIVE' },
    { name: 'tax_code', label: t('vnd.controls.interest.tax.label'), kind: 'text', min: 10, max: 20, visible: (values) => values.kind !== 'RELATIVE' },
    { name: 'share_pct', label: t('vnd.controls.interest.share.label'), kind: 'text', pattern: /^\d{1,3}(\.\d{1,2})?$/, visible: (values) => values.kind === 'SHAREHOLDING', required: true },
    { name: 'since_on', label: t('vnd.controls.interest.since.label'), kind: 'date' },
    { name: 'ended_on', label: t('vnd.controls.interest.ended.label'), kind: 'date', hint: t('vnd.controls.interest.ended.hint'), visible: (values) => values.kind === 'FORMER_EMPLOYMENT' },
    { name: 'document_id', label: t('vnd.controls.interest.document.label'), kind: 'uuid' },
  ];
  return (
    <CommandDialog
      title={t('vnd.controls.interest.title')}
      context={[]}
      note={<p className="vnd-note">{t('vnd.controls.interest.note')}</p>}
      confirmLabel={t('vnd.controls.interest.confirm')}
      fields={fields}
      blocked={(values) => values.kind !== 'RELATIVE' && text(values.contractor_id) === '' && text(values.tax_code) === ''}
      run={(values) => {
        const kind = kindOf(values.kind);
        return command.mutateAsync({
          body: {
            kind,
            ...(kind === 'RELATIVE' ? { ...optional('related_name', values.related_name), ...optional('related_identity_number', values.related_identity_number), ...optional('relation', values.relation) } : { ...optional('contractor_id', values.contractor_id), ...optional('tax_code', values.tax_code) }),
            ...(kind === 'SHAREHOLDING' ? optional('share_pct', values.share_pct) : {}),
            ...optional('since_on', values.since_on),
            ...(kind === 'FORMER_EMPLOYMENT' ? optional('ended_on', values.ended_on) : {}),
            ...optional('document_id', values.document_id),
          },
        });
      }}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

export function EndInterestDialog({ interest, onClose, onDone }: DialogProps & { interest: PersonInterest }) {
  const { t } = useTranslation();
  const command = useVendorCommand('endVendorPersonInterest');
  const fields: FieldSpec[] = [reasonField(t, 5, 500), { name: 'ended_on', label: t('vnd.controls.interest.ended.label'), kind: 'date' }];
  return (
    <CommandDialog
      title={t('vnd.controls.interest.end.title')}
      context={[{ label: t('vnd.controls.interest.kind.label'), value: interestKindLabel(t, interest.kind) }]}
      confirmLabel={t('vnd.controls.interest.end.confirm')}
      fields={fields}
      run={(values) => command.mutateAsync({ path: { id: interest.id }, ifMatchVersion: interest.version, body: { reason: text(values.reason), ...optional('ended_on', values.ended_on) } })}
      onClose={onClose}
      onDone={onDone}
      danger
    />
  );
}

/** What the package asks of its bidders: the base amount of the bid security, the last day the bids are valid, the estimated value and the months of the work. Empty means "not set". */
export function ControlsDialog({ controls, onClose, onDone }: DialogProps & { controls: PackageControls }) {
  const { t } = useTranslation();
  const command = useVendorCommand('setVendorPackageControls');
  const amountOk = (value: unknown): boolean => text(value) === '' || wholeAmount(value) !== null;
  const fields: FieldSpec[] = [
    { name: 'security_base_amount', label: t('vnd.controls.package.security.label'), kind: 'text', hint: t('vnd.controls.package.security.hint'), initial: controls.security_base_amount === null ? '' : String(controls.security_base_amount) },
    { name: 'bid_valid_until', label: t('vnd.controls.package.valid.label'), kind: 'date', initial: controls.bid_valid_until ?? '' },
    { name: 'estimated_value', label: t('vnd.controls.package.value.label'), kind: 'text', hint: t('vnd.controls.package.value.hint'), initial: controls.estimated_value === null ? '' : String(controls.estimated_value) },
    { name: 'duration_months', label: t('vnd.controls.package.months.label'), kind: 'number', min: 1, max: 600, initial: controls.duration_months === null ? '' : String(controls.duration_months) },
  ];
  return (
    <CommandDialog
      title={t('vnd.controls.package.title')}
      context={[{ label: t('vnd.controls.context.budget'), value: String(controls.budget_vnd) }]}
      confirmLabel={t('vnd.controls.package.confirm')}
      fields={fields}
      blocked={(values) => !amountOk(values.security_base_amount) || !amountOk(values.estimated_value)}
      run={(values) => {
        const months = text(values.duration_months);
        return command.mutateAsync({
          path: { id: controls.package_id },
          ifMatchVersion: controls.version,
          body: {
            security_base_amount: wholeAmount(values.security_base_amount),
            bid_valid_until: text(values.bid_valid_until) === '' ? null : text(values.bid_valid_until),
            estimated_value: wholeAmount(values.estimated_value),
            duration_months: months === '' ? null : Number(months),
          },
        });
      }}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
