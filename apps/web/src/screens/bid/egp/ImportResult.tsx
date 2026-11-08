import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { AcceptanceBadge, RowErrorsTable } from './import-components';
import { kindLabel } from './import-labels';
import { PATH_MAPPING, shortHash } from './import-model';
import type { Applied } from './import-model';
import './import.css';

/**
 * What an apply did: the counts of the rows, the mappings it proposed (a person approves them on BID-23), the restrictions it wrote, the differences it opened for a person, and the rows it refused with the line, the reason and the field.
 * A refused apply (IMPORT_HAS_ERRORS) has the same shape: nothing was taken, and the errors say why.
 */
export function ImportResult({ applied }: { applied: Applied }) {
  const { t, locale } = useTranslation();
  const facts: Array<{ key: string; label: string; value: number }> = [
    { key: 'total', label: t('egp.import.result.total.label'), value: applied.counts.total },
    { key: 'applied', label: t('egp.import.result.applied.label'), value: applied.counts.applied },
    { key: 'duplicate', label: t('egp.import.result.duplicate.label'), value: applied.counts.duplicate },
    { key: 'conflict', label: t('egp.import.result.conflict.label'), value: applied.counts.conflict },
    { key: 'quarantined', label: t('egp.import.result.quarantined.label'), value: applied.counts.quarantined },
    { key: 'differences', label: t('egp.import.result.differences.label'), value: applied.counts.differencesOpened },
    { key: 'mappings', label: t('egp.import.result.mappings.label'), value: applied.mappingsProposed },
    { key: 'restrictions', label: t('egp.import.result.restrictions.label'), value: applied.restrictionsWritten },
  ];
  return (
    <div data-testid="import-result" data-refused={applied.refused ? 'true' : 'false'}>
      {applied.refused ? (
        <p className="callout warning" role="status" data-testid="import-refused">
          {t('egp.import.result.refused')}
        </p>
      ) : (
        <p className="callout" role="status" data-testid="import-applied">
          {t('egp.import.result.done')}
        </p>
      )}
      <p className="egpi-facts">
        <span>{t('egp.import.preview.mode', { mode: t('egp.import.mode.apply') })}</span>
        {applied.kind === null ? null : <span>{t('egp.import.preview.kind', { kind: kindLabel(t, applied.kind) })}</span>}
        {applied.layoutVersion === '' ? null : <span>{t('egp.import.preview.layout', { version: applied.layoutVersion })}</span>}
        {applied.fileSha256 === '' ? null : <span>{t('egp.import.result.hash', { hash: shortHash(applied.fileSha256) })}</span>}
        {applied.layoutVersion === '' ? null : <AcceptanceBadge acceptance={applied.acceptance} />}
      </p>
      <dl className="egpi-counts" data-testid="import-counts">
        {facts.map((fact) => (
          <div key={fact.key} data-fact={fact.key}>
            <dt>{fact.label}</dt>
            <dd>{fact.value.toLocaleString(locale)}</dd>
          </div>
        ))}
      </dl>
      {applied.mappingsProposed > 0 ? (
        <p data-testid="mappings-link">
          <Link to={PATH_MAPPING}>{t('egp.import.result.mappings.link', { count: applied.mappingsProposed })}</Link>
        </p>
      ) : null}
      {applied.errors.length > 0 ? <RowErrorsTable errors={applied.errors} caption={t('egp.import.errors.caption')} truncated={applied.errorsTruncated} testId="import-errors" /> : null}
    </div>
  );
}
