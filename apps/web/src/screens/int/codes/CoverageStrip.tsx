import { useTranslation } from '../../../i18n';
import { SectionCard } from '../../../ui';
import type { ProjectCodePage } from '../int-model';

type Coverage = NonNullable<ProjectCodePage['coverage']>[number];

/**
 * How far the codes of each system reach over the projects (ENT-3e, R25): the mapped projects, those that still go under their own code while the direct match is the fallback of this version, the proposals
 * that wait for a second person and the codes that are, as text, the code of another project. The numbers are what the server counted on the day of the page; the strip shows them and decides nothing.
 */
export function CoverageStrip({ coverage }: { coverage: readonly Coverage[] | undefined }) {
  const { t } = useTranslation();
  // A system with no project to cover says nothing; the strip is absent until there is something to read.
  const rows = (coverage ?? []).filter((row) => row.projects > 0);
  if (rows.length === 0) return null;
  return (
    <SectionCard title={t('int.codes.coverage.title')}>
      <ul className="int-coverage" aria-label={t('int.codes.coverage.title')} data-testid="coverage">
        {rows.map((row) => (
          <li key={row.source_system} data-system={row.source_system} data-complete={row.mapped === row.projects ? 'true' : 'false'}>
            <strong>{row.source_system}</strong>
            <span data-testid="coverage-mapped">{t('int.codes.coverage.mapped', { mapped: row.mapped, projects: row.projects })}</span>
            {row.direct_only > 0 && <span data-testid="coverage-direct">{t('int.codes.coverage.direct', { count: row.direct_only })}</span>}
            {row.unmapped > 0 && <span data-testid="coverage-unmapped">{t('int.codes.coverage.unmapped', { count: row.unmapped })}</span>}
            {row.proposed > 0 && <span data-testid="coverage-proposed">{t('int.codes.coverage.proposed', { count: row.proposed })}</span>}
            {row.shadows > 0 && (
              <span className="callout" role="status" data-testid="coverage-shadows">
                {t('int.codes.coverage.shadows', { count: row.shadows })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
