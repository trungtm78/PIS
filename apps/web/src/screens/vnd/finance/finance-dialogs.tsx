import { useTranslation } from '../../../i18n';
import { CommandDialog } from '../shared/vnd-form';
import type { FieldSpec } from '../shared/vnd-form';
import { useVendorCommand } from '../shared/vnd-hooks';
import { camel } from '../shared/vnd-model';
import { wholeAmount } from '../controls/controls-model';
import type { FinancialPeriod } from '../controls/controls-model';

interface DialogProps {
  onClose: () => void;
  onDone: () => void;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const MONEY_FIELDS = ['revenue', 'total_assets', 'current_assets', 'current_liabilities', 'total_debt', 'equity', 'ebit', 'interest_expense'] as const;
const SIGNED = new Set<string>(['equity', 'ebit']);

/** One year of statements as the audited report gives them, in whole dong; the paper it was read from is named (it is needed to verify the year), and a year that already has figures is corrected by a new row. */
export function RecordPeriodDialog({ contractorId, contractorName, onClose, onDone }: DialogProps & { contractorId: string; contractorName: string }) {
  const { t } = useTranslation();
  const command = useVendorCommand('recordVendorFinancialPeriod');
  const fields: FieldSpec[] = [
    { name: 'fiscal_year', label: t('vnd.finance.field.year.label'), kind: 'number', required: true, min: 1990, max: 2200 },
    ...MONEY_FIELDS.map((name): FieldSpec => ({ name, label: t(`vnd.finance.field.${camel(name)}.label`), kind: 'text', required: true, pattern: SIGNED.has(name) ? /^-?\d{1,16}$/ : /^\d{1,16}$/ })),
    { name: 'document_id', label: t('vnd.finance.field.document.label'), kind: 'uuid', hint: t('vnd.finance.field.document.hint') },
  ];
  const amount = (values: Record<string, unknown>, name: string): number => wholeAmount(values[name], SIGNED.has(name)) ?? 0;
  return (
    <CommandDialog
      title={t('vnd.finance.record.title')}
      context={[{ label: t('vnd.finance.context.contractor'), value: contractorName }]}
      note={<p className="vnd-note">{t('vnd.finance.record.note')}</p>}
      confirmLabel={t('vnd.finance.record.confirm')}
      fields={fields}
      blocked={(values) => MONEY_FIELDS.some((name) => wholeAmount(values[name], SIGNED.has(name)) === null) || (wholeAmount(values.current_assets) ?? 0) > (wholeAmount(values.total_assets) ?? 0)}
      run={(values) =>
        command.mutateAsync({
          path: { id: contractorId },
          body: {
            fiscal_year: Number(text(values.fiscal_year)),
            revenue: amount(values, 'revenue'),
            total_assets: amount(values, 'total_assets'),
            current_assets: amount(values, 'current_assets'),
            current_liabilities: amount(values, 'current_liabilities'),
            total_debt: amount(values, 'total_debt'),
            equity: amount(values, 'equity'),
            ebit: amount(values, 'ebit'),
            interest_expense: amount(values, 'interest_expense'),
            ...(text(values.document_id) === '' ? {} : { document_id: text(values.document_id) }),
          },
        })
      }
      onClose={onClose}
      onDone={onDone}
      wide
    />
  );
}

/** The check of a year against the paper, by another person than the one who entered it (the server refuses the same person); a year without a paper cannot be verified. */
export function VerifyPeriodDialog({ period, contractorName, onClose, onDone }: DialogProps & { period: FinancialPeriod; contractorName: string }) {
  const { t } = useTranslation();
  const command = useVendorCommand('verifyVendorFinancialPeriod');
  return (
    <CommandDialog
      title={t('vnd.finance.verify.title')}
      context={[
        { label: t('vnd.finance.context.contractor'), value: contractorName },
        { label: t('vnd.finance.column.year'), value: String(period.fiscal_year) },
      ]}
      note={<p className="vnd-note">{period.document_id === null ? t('vnd.finance.verify.nopaper') : t('vnd.finance.verify.note')}</p>}
      confirmLabel={t('vnd.finance.verify.confirm')}
      fields={[]}
      blocked={() => period.document_id === null}
      run={() => command.mutateAsync({ path: { id: period.id }, ifMatchVersion: period.version })}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
