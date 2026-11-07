import { useTranslation } from '../i18n';

export interface AuditLineProps {
  items: { label: string; value: string }[];
}

/** The audit line of a record: who created it and when, who changed it last. */
export function AuditLine({ items }: AuditLineProps) {
  const { t } = useTranslation();
  return (
    <ul className="ui-audit" aria-label={t('ui.auditLine.label')}>
      {items.map((item) => (
        <li className="ui-audit__item" key={item.label}>
          <span className="ui-audit__label">{item.label}</span> <span className="ui-audit__value">{item.value}</span>
        </li>
      ))}
    </ul>
  );
}
