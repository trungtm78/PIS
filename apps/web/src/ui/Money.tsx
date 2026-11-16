import { useTranslation } from '../i18n';
import { NO_MONEY, compactMoney, fullMoney, moneyInUnit, moneyParts } from '../i18n/money';
import type { MoneyOptions, MoneyValue } from '../i18n/money';

export interface MoneyProps extends Omit<MoneyOptions, 'locale'> {
  /** Whole dong as a decimal string (or a bigint); null, undefined and an empty text are "no amount". */
  value: MoneyValue;
  /** The column or the card already declares the unit ("ĐVT: tỷ đồng"): write the figure alone, in the unit given by `unit`. */
  bare?: boolean;
  /** What stands where there is no amount; a dash when left out. */
  none?: string;
  'data-testid'?: string;
}

/**
 * An amount of money read at a glance: the short form of `i18n/money.ts` ("1,23 tỷ đồng"), with the exact amount in whole dong one hover away
 * (`title`) and read out by a screen reader after the short form. An amount written in whole dong with its unit carries no second reading.
 */
export function Money({ value, bare = false, none = NO_MONEY, 'data-testid': testId, ...options }: MoneyProps) {
  const { locale } = useTranslation();
  const parts = moneyParts(value, { ...options, locale });
  if (parts === null) {
    const text = value === null || value === undefined || (typeof value === 'string' && value.trim() === '') ? none : String(value);
    return (
      <span className="ui-money" data-testid={testId}>
        {text}
      </span>
    );
  }
  const full = fullMoney(value, locale, options.signed === true);
  const shown = bare && options.unit !== undefined ? moneyInUnit(value, options.unit, { ...options, locale }) : compactMoney(value, { ...options, locale });
  const saysItAll = parts.unit === 'dong' && !bare;
  return (
    <span className="ui-money" title={full} data-testid={testId}>
      {shown}
      {!saysItAll && <span className="ui-sr-only"> ({full})</span>}
    </span>
  );
}
