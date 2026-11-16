import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { SectionCard } from '../../../ui';
import { useCatalogue } from '../../adm/governance/hooks';
import { KitTable } from '../../adm/KitTable';
import { TEMPLATE_RULE_TYPE, editorLink } from '../model';
import { useTemplateCodes } from '../templates/hooks';
import { stepBandsOf } from './step-bands';
import type { StepBand } from './step-bands';

/** The steps with thresholds of their own, read from the template in force of every code of the library (nothing new is asked of the server). */
export function useStepBands(enabled: boolean): { rows: StepBand[]; loading: boolean; failed: boolean } {
  const catalogue = useCatalogue(enabled);
  const entry = catalogue.data?.find((one) => one.ruleType === TEMPLATE_RULE_TYPE);
  const codes = useMemo(() => (entry?.codes ?? []).map((code) => code.code), [entry]);
  const reads = useTemplateCodes(codes, enabled && entry !== undefined);
  const rows = reads.flatMap((read, index) => {
    const effective = read.data?.effective;
    return effective === null || effective === undefined ? [] : stepBandsOf(codes[index] ?? '', effective.params);
  });
  return { rows, loading: catalogue.isLoading || reads.some((read) => read.isLoading), failed: catalogue.isError || reads.some((read) => read.isError) };
}

const cell = (value: number | null): string => (value === null ? '–' : String(value));

/** "Bước có ngưỡng riêng": read-only, so that an administrator sees every exception the templates make to the policy; they are written on the row of the step in the editor of the process. */
export function StepBands({ rows, loading, failed }: { rows: readonly StepBand[]; loading: boolean; failed: boolean }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('wfxbands.steps.title')} status={<span data-testid="step-count">{t('wfxbands.steps.count', { count: rows.length })}</span>}>
      <div data-testid="step-bands">
        <p className="adm-kit-sub">{t('wfxbands.steps.hint')}</p>
        {failed ? (
          <p className="callout warning" role="status" data-testid="step-bands-failed">
            {t('wfxbands.steps.failed.text')}
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p className="pwf-hint" data-testid="step-bands-empty">
            {loading ? t('wfxbands.steps.loading.text') : t('wfxbands.steps.empty.text')}
          </p>
        ) : (
          <KitTable caption={t('wfxbands.steps.caption')}>
            <thead>
              <tr>
                <th>{t('wfxbands.steps.col.template')}</th>
                <th>{t('wfxbands.steps.col.phase')}</th>
                <th>{t('wfxbands.steps.col.step')}</th>
                <th className="pwf-band-num">{t('wfxbands.col.red.label')}</th>
                <th className="pwf-band-num">{t('wfxbands.col.yellow.label')}</th>
                <th className="pwf-band-num">{t('wfxbands.col.green.label')}</th>
                <th>
                  <span className="ui-sr-only">{t('wfxbands.steps.col.open')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.template}:${index}`} data-template={row.template}>
                  <td>{row.templateName === '' ? row.template : row.templateName}</td>
                  <td>{row.phase}</td>
                  <td>{row.step}</td>
                  <td className="pwf-band-num">{cell(row.red)}</td>
                  <td className="pwf-band-num">{cell(row.yellow)}</td>
                  <td className="pwf-band-num">{cell(row.green)}</td>
                  <td>
                    <Link className="ui-button ui-button--outline ui-button--small" to={editorLink(row.template)} aria-label={t('wfxbands.steps.open.label', { step: row.step })}>
                      {t('wfxbands.steps.open.action')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </KitTable>
        )}
      </div>
    </SectionCard>
  );
}
