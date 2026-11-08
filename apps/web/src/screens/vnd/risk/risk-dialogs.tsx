import { useTranslation } from '../../../i18n';
import { CommandDialog } from '../shared/vnd-form';
import type { FieldSpec } from '../shared/vnd-form';
import { useVendorCommand } from '../shared/vnd-hooks';
import { tierLabel } from './risk-labels';
import type { PerformanceLine, PublicationKind, RiskAssessment } from './risk-model';
import { PUBLICATION_KINDS } from './risk-model';
import { publicationKindLabel } from './risk-labels';

interface DialogProps {
  onClose: () => void;
  onDone: () => void;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const kindOf = (value: unknown): PublicationKind => PUBLICATION_KINDS.find((one) => one === value) ?? 'INITIAL';

/** Asks the system to compute the grade of a contractor from what the controls found and to keep it as a proposal; nothing is written on the contractor until somebody confirms it. */
export function AssessDialog({ contractorId, contractorName, onClose, onDone }: DialogProps & { contractorId: string; contractorName: string }) {
  const { t } = useTranslation();
  const command = useVendorCommand('assessVendorRisk');
  return (
    <CommandDialog
      title={t('vnd.risk.assess.title')}
      context={[{ label: t('vnd.risk.column.contractor'), value: contractorName }]}
      note={<p className="vnd-note">{t('vnd.risk.assess.note')}</p>}
      confirmLabel={t('vnd.risk.assess.confirm')}
      fields={[]}
      run={() => command.mutateAsync({ path: { id: contractorId } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** Confirms or rejects a grade that waits. A grade that needs a dual check is confirmed by a person other than the assessor (the server refuses the same person); a rejection needs a reason. */
export function DecideDialog({ assessment, onClose, onDone }: DialogProps & { assessment: RiskAssessment }) {
  const { t } = useTranslation();
  const command = useVendorCommand('decideVendorRiskGrade');
  const fields: FieldSpec[] = [
    {
      name: 'decision',
      label: t('vnd.risk.decide.decision.label'),
      kind: 'select',
      required: true,
      initial: 'CONFIRM',
      options: [
        { value: 'CONFIRM', label: t('vnd.risk.decide.option.confirm') },
        { value: 'REJECT', label: t('vnd.risk.decide.option.reject') },
      ],
    },
    {
      name: 'reason',
      label: t('vnd.risk.decide.reason.label'),
      kind: 'textarea',
      max: 2000,
      hint: t('vnd.field.reason.hint', { count: 20 }),
      required: false,
    },
  ];
  return (
    <CommandDialog
      title={t('vnd.risk.decide.title')}
      context={[
        { label: t('vnd.risk.column.contractor'), value: assessment.contractor_name },
        { label: t('vnd.risk.column.tier'), value: `${tierLabel(t, assessment.tier)} (${assessment.score})` },
      ]}
      note={assessment.dual_check ? <p className="vnd-note">{t('vnd.risk.decide.dual.note')}</p> : undefined}
      confirmLabel={t('vnd.risk.decide.confirm')}
      fields={fields}
      blocked={(values) => values.decision === 'REJECT' && text(values.reason).length < 20}
      run={(values) =>
        command.mutateAsync({
          path: { id: assessment.id },
          ifMatchVersion: assessment.version,
          body: { decision: values.decision === 'REJECT' ? 'REJECT' : 'CONFIRM', ...(text(values.reason) === '' ? {} : { reason: text(values.reason) }) },
        })
      }
      onClose={onClose}
      onDone={onDone}
    />
  );
}

/** The receipt of the publication of a rating on the national system: the kind (first posting or an update) and the reference the network gave. Another person than the one who adopted the rating posts it. */
export function PostPublicationDialog({ line, onClose, onDone }: DialogProps & { line: PerformanceLine }) {
  const { t } = useTranslation();
  const command = useVendorCommand('postVendorPerformance');
  const fields: FieldSpec[] = [
    {
      name: 'kind',
      label: t('vnd.performance.post.kind.label'),
      kind: 'select',
      required: true,
      initial: line.publication === null ? 'INITIAL' : 'UPDATE_AFTER_WARRANTY',
      options: PUBLICATION_KINDS.filter((kind) => (line.publication === null ? kind === 'INITIAL' : kind !== 'INITIAL')).map((kind) => ({ value: kind, label: publicationKindLabel(t, kind) })),
    },
    { name: 'receipt', label: t('vnd.performance.post.receipt.label'), kind: 'text', required: true, min: 3, max: 100, hint: t('vnd.performance.post.receipt.hint') },
  ];
  return (
    <CommandDialog
      title={t('vnd.performance.post.title')}
      context={[
        { label: t('vnd.performance.column.contract'), value: line.contract_code },
        { label: t('vnd.performance.column.contractor'), value: line.contractor_name },
      ]}
      note={<p className="vnd-note">{t('vnd.performance.post.note')}</p>}
      confirmLabel={t('vnd.performance.post.confirm')}
      fields={fields}
      run={(values) => command.mutateAsync({ path: { id: line.proposal_id }, body: { kind: kindOf(values.kind), receipt: text(values.receipt) } })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
