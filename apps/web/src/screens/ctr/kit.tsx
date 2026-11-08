import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { ContextBar } from '../../ui';
import type { Tone } from '../../ui';

/** `HH:mm dd/MM/yyyy` in Vietnam time for the moment a read finished; the empty text when there is none. */
export function momentText(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(milliseconds));
  const part = (type: string): string => parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('hour')}:${part('minute')} ${part('day')}/${part('month')}/${part('year')}`;
}

/** The sum of whole amounts kept as text (the server's money is never a float); an amount that is not whole is left out of the sum. */
export function sumAmounts(values: readonly string[]): string {
  return values.reduce((total, value) => (/^-?\d+$/.test(value) ? total + BigInt(value) : total), 0n).toString();
}

export interface ScopeBarProps {
  /** The conditions of the page after the scope (a contract, a period, a closing date), already translated. */
  extra?: { label: string; value: string }[];
  /** When the figures were read (milliseconds); the bar says "Updated …". */
  updatedAt?: number;
  /** The last read failed and the figures are the ones kept from the read before. */
  stale?: boolean;
  /** The page shows money: the chip "Unit: Dong" is shown. */
  money?: boolean;
}

/** The ContextBar of the list and ledger pages of PAY, CTR and BID: the scope of the signed-in member, the conditions of the page, the unit of the money and how fresh the numbers are. */
export function ScopeBar({ extra = [], updatedAt, stale = false, money = false }: ScopeBarProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const asOf = updatedAt === undefined ? '' : momentText(updatedAt);
  return (
    <ContextBar
      items={[
        {
          label: t('w2pay.ctx.scope'),
          value: tenant?.name ?? t('w2pay.ctx.scope.all'),
        },
        ...extra,
      ]}
      stale={stale}
      {...(money ? { unit: t('w2pay.ctx.unit') } : {})}
      {...(asOf === '' ? {} : { asOf })}
    />
  );
}

/** The tone of a state word: the unfinished is neutral, what waits on someone is info, what is done is success, what was sent back is a warning and what was undone is danger. */
export type StateGroup = 'draft' | 'waiting' | 'done' | 'returned' | 'undone';
export const TONE_OF: Readonly<Record<StateGroup, Tone>> = {
  draft: 'neutral',
  waiting: 'info',
  done: 'success',
  returned: 'warning',
  undone: 'danger',
};
