import { loadNumerals } from './common.mjs';

/** Words for a group of up to three digits; `padded` says that a higher group exists (so a zero hundred is spoken). */
function groupWords(value, padded, n) {
  const hundreds = Math.floor(value / 100);
  const tens = Math.floor((value % 100) / 10);
  const units = value % 10;
  const out = [];
  if (hundreds > 0) out.push(n.digits[hundreds], n.hundred);
  else if (padded && (tens > 0 || units > 0)) out.push(n.zero_hundred);
  if (tens === 0) {
    if (units > 0) out.push(hundreds > 0 || padded ? n.zero_tens : '', n.digits[units]);
  } else if (tens === 1) {
    out.push(n.ten);
    if (units === 5) out.push(n.five_after_ten);
    else if (units > 0) out.push(n.digits[units]);
  } else {
    out.push(n.digits[tens], n.tens);
    if (units === 1) out.push(n.one_after_tens);
    else if (units === 4) out.push(n.four_after_tens);
    else if (units === 5) out.push(n.five_after_ten);
    else if (units > 0) out.push(n.digits[units]);
  }
  return out.filter((part) => part !== '');
}

/** An unsigned whole number (digits only) as Vietnamese words. */
export function integerToWords(digits, numerals = loadNumerals(), higherExists = false) {
  if (!/^\d+$/u.test(digits)) throw new Error(`not a whole number: ${digits}`);
  const value = BigInt(digits);
  if (value === 0n) return numerals.digits[0];
  const billion = 1_000_000_000n;
  if (value >= billion) {
    const high = integerToWords((value / billion).toString(), numerals);
    const rest = value % billion;
    const tail = rest === 0n ? '' : ` ${integerToWords(rest.toString(), numerals, true)}`;
    return `${high} ${numerals.groups[3]}${tail}`;
  }
  const number = Number(value);
  const groups = [Math.floor(number / 1_000_000), Math.floor(number / 1000) % 1000, number % 1000];
  const labels = [numerals.groups[2], numerals.groups[1], ''];
  const firstUsed = groups.findIndex((group) => group > 0);
  const words = [];
  groups.forEach((group, index) => {
    if (group === 0) return;
    words.push(...groupWords(group, higherExists || index > firstUsed, numerals));
    if (labels[index] !== '') words.push(labels[index]);
  });
  return words.join(' ');
}

/** A number written with a decimal comma (`72,5`) as words: the digits after the comma are read one by one. */
export function decimalToWords(text, numerals = loadNumerals()) {
  const [whole, fraction] = text.split(',');
  const head = integerToWords(whole.replace(/^0+(?=\d)/u, ''), numerals);
  if (fraction === undefined) return head;
  const tail = [...fraction].map((digit) => numerals.digits[Number(digit)]).join(' ');
  return `${head} ${numerals.decimal_point} ${tail}`;
}

/** Every number of a text as words (a percent sign becomes the word for percent). Digits inside a code such as `BID-24` are left to the phonetic table. */
export function numbersToSpeech(text, numerals = loadNumerals()) {
  return text.replace(/(?<![\p{L}\p{N}.,-])(\d+(?:,\d+)?)(\s?%)?(?![\p{L}\p{N}-])/gu, (_, number, percent) => {
    const words = decimalToWords(number, numerals);
    return percent === undefined ? words : `${words} ${numerals.percent}`;
  });
}
