import type { ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { KpiTile } from '../../ui';
import type { Tone } from '../../ui';
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

/**
 * A figure of capital as a tile: the amount in billions with the exact dong under it and what else the caller says of it. No amount is "no data" on a neutral tile and is never written as zero.
 * The wrapper carries the key of the card and the test id, so the tile stays one element for whoever looks for it.
 */
export function FundTile({ label, vnd, card, testId, tone, children }: { label: string; vnd: string | null; card?: string; testId?: string; tone?: Tone; children?: ReactNode }) {
  const { t, locale } = useTranslation();
  return (
    <div className="home-fund-tile" data-testid={testId} {...(card === undefined ? {} : { 'data-card': card })}>
      <KpiTile
        label={label}
        value={vnd === null ? t('home.funding.card.none') : t('home.funding.card.amount', { value: billionsText(vnd, locale) })}
        tone={vnd === null ? 'neutral' : (tone ?? 'info')}
        sub={
          vnd === null && children === undefined ? undefined : (
            <>
              {vnd === null ? null : <span className="home-fund-line">{t('home.funding.card.exact', { value: vndText(vnd, locale) })}</span>}
              {children}
            </>
          )
        }
      />
    </div>
  );
}

export const subsetLine = (t: T, vnd: string | null, locale: string): string => (vnd === null ? t('home.funding.subset.none') : t('home.funding.subset.line', { value: billionsText(vnd, locale) }));
