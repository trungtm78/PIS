import { useTranslation } from '../../../i18n';
import { formatVnd } from '../conclusion/model';
import { percentText } from './model';
import type { Rate } from './model';

/** A rate in words: the percentage when there is one (and "not applicable" when nothing was recommended, never 0%), with its numerator and its denominator (BR-AUD-04). */
export function RateText({ rate, testId }: { rate: Rate; testId: string }) {
  const { t, locale } = useTranslation();
  const percent = percentText(rate, locale);
  return (
    <span data-testid={testId}>
      <strong>{percent ?? t('aud.recovery.rate.na')}</strong> <span className="sub">{t('aud.recovery.rate.parts', { numerator: formatVnd(rate.numerator), denominator: formatVnd(rate.denominator) })}</span>
    </span>
  );
}
