const AMOUNT_DIGITS = 24;

/** A whole amount of dong in the way it is read, with a dot between the thousands. */
export const formatVnd = (amount: string): string => (amount.startsWith('-') ? `-${formatVnd(amount.slice(1))}` : amount.replace(/\B(?=(\d{3})+(?!\d))/g, '.'));

/** The digits of an amount typed with or without separators ("1.250.000.000", "1,250,000,000", "1 250 000 000"); anything else, a sign and a fraction included, is not an amount. */
export function digitsOf(typed: string): string | undefined {
  const compact = typed.trim().replace(/[.,\s]/g, '');
  if (!/^[0-9]+$/.test(compact) || compact.length > AMOUNT_DIGITS) return undefined;
  return BigInt(compact).toString();
}
