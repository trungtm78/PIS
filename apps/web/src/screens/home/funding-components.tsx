import type { ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { Field } from '../mne/components';
import { vndText } from '../cap/model';
import { billionsText } from './funding-model';

type T = Translator['t'];

/** The year the screen shows, chosen among the years that have capital published; the address keeps it, so the detail opens on the same year. */
export function YearField({ years, year, onChange }: { years: readonly number[]; year: number | undefined; onChange(year: number): void }) {
  const { t } = useTranslation();
  const options = year !== undefined && !years.includes(year) ? [year, ...years] : years;
  return (
    <Field id="funding-year" label={t('home.funding.year.label')} error={undefined}>
      <select id="funding-year" value={year === undefined ? '' : String(year)} onChange={(event) => onChange(Number(event.target.value))}>
        {options.map((option) => (
          <option key={option} value={String(option)}>
            {option}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** An amount in billions, with the exact dong beside it; no amount is "no data" and is never written as zero. */
export function Amount({ vnd, testId }: { vnd: string | null; testId?: string }): ReactNode {
  const { t, locale } = useTranslation();
  if (vnd === null) {
    return (
      <span className="sub" data-testid={testId}>
        {t('home.funding.card.none')}
      </span>
    );
  }
  return (
    <span data-testid={testId}>
      <strong>{t('home.funding.card.amount', { value: billionsText(vnd, locale) })}</strong> <span className="sub">{t('home.funding.card.exact', { value: vndText(vnd, locale) })}</span>
    </span>
  );
}

export const subsetLine = (t: T, vnd: string | null, locale: string): string => (vnd === null ? t('home.funding.subset.none') : t('home.funding.subset.line', { value: billionsText(vnd, locale) }));
