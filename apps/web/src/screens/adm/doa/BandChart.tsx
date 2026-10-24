import { useTranslation } from '../../../i18n';
import { bandRows, formatVnd } from './engine';
import type { DoaRuleInput } from './engine';

export interface BandChartProps {
  rules: readonly DoaRuleInput[];
  unitLabel: (unitId: string) => string;
  roleLabel: (roleId: string) => string;
}

/**
 * The amount bands of each document type and unit, lowest first. A gap between two bands, before the first one or after the last is a
 * segment of its own, and a band that overlaps the one before it says so, so a matrix that cannot be submitted is seen before it is
 * (ADM-15). The segments are in order, not to scale: thresholds run from millions to billions.
 */
export function BandChart({ rules, unitLabel, roleLabel }: BandChartProps) {
  const { t, locale } = useTranslation();
  const rows = bandRows(rules);
  if (rows.length === 0) return <p className="muted">{t('adm.doa.chart.empty')}</p>;
  const amount = (value: string | null): string => (value === null ? t('adm.doa.chart.noEnd') : formatVnd(value, locale));
  return (
    <ul className="doa-chart" aria-label={t('adm.doa.chart.title')}>
      {rows.map((row) => (
        <li key={`${row.documentType}/${row.unitId}`} className="doa-row" data-document-type={row.documentType} data-unit-id={row.unitId}>
          <span className="doa-row-head">{t('adm.doa.chart.row', { documentType: row.documentType, unit: unitLabel(row.unitId) })}</span>
          <ol className="doa-bar">
            {row.segments.map((segment) => {
              const range = t('adm.doa.chart.range', { from: amount(segment.from), to: amount(segment.to) });
              return (
                <li key={`${segment.kind}-${segment.from}-${segment.index ?? 'gap'}`} className={`doa-seg ${segment.kind}${segment.overlaps ? ' overlap' : ''}`} data-kind={segment.kind} data-overlap={segment.overlaps}>
                  {segment.kind === 'gap' ? (
                    <>
                      <strong>{t('adm.doa.chart.gap')}</strong> {range}
                    </>
                  ) : (
                    <>
                      {segment.overlaps ? <strong>{t('adm.doa.chart.overlap')} </strong> : null}
                      {range}
                      <br />
                      <span className="doa-role">{roleLabel(rules[segment.index ?? 0]?.approver_role_id ?? '')}</span>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        </li>
      ))}
    </ul>
  );
}
