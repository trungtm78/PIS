import { describe, expect, it } from 'vitest';
import { groupedText } from './overview-sections';

describe('groupedText: the digits of a sum of dong, grouped only when the edition asks', () => {
  it('groups by thousands in the format of the language', () => {
    expect(groupedText('543330000000', 'vi', true)).toBe('543.330.000.000');
    expect(groupedText('543330000000', 'en', true)).toBe('543,330,000,000');
    expect(groupedText('1234', 'vi', true)).toBe('1.234');
  });

  it('leaves the text as it came for the public edition, for a short number and for a text that is not a whole number', () => {
    expect(groupedText('543330000000', 'vi', false)).toBe('543330000000');
    expect(groupedText('999', 'vi', true)).toBe('999');
    expect(groupedText('543,5', 'vi', true)).toBe('543,5');
    expect(groupedText('—', 'vi', true)).toBe('—');
  });
});
