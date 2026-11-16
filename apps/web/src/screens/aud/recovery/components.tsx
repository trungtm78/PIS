import { useTranslation } from '../../../i18n';
import { compactMoney, fullMoney } from '../../../i18n/money';
import { formatVnd } from '../conclusion/model';
import { percentText } from './model';
import type { Rate } from './model';

/** A rate in words: the percentage when there is one (and "not applicable" when nothing was recommended, never 0%), with its numerator and its denominator (BR-AUD-04). */
export function RateText({ rate, testId, money = false }: { rate: Rate; testId: string; money?: boolean }) {
  const { t, locale } = useTranslation();
  const percent = percentText(rate, locale);
  return (
    <span data-testid={testId}>
      <strong>{percent ?? t('aud.recovery.rate.na')}</strong> <span className="sub" title={money ? `${fullMoney(rate.numerator, locale)} / ${fullMoney(rate.denominator, locale)}` : undefined}>
        {t('aud.recovery.rate.parts', { numerator: money ? compactMoney(rate.numerator, { locale }) : formatVnd(rate.numerator), denominator: money ? compactMoney(rate.denominator, { locale }) : formatVnd(rate.denominator) })}
      </span>
    </span>
  );
}
