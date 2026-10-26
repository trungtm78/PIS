import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { digitsOf, formatVnd } from './money';

/**
 * An amount of dong typed as a person writes it. While it is typed it is left alone; when the field is left, an amount is written with a dot between the thousands and anything that is not an
 * amount is left as it was, for the form to refuse in words.
 */
export function MoneyInput({ id, value, disabled, invalid, onChange, label }: { id: string; value: string; disabled?: boolean; invalid?: boolean; onChange(value: string): void; label: string }) {
  const [focused, setFocused] = useState(false);
  const digits = digitsOf(value);
  const shown = !focused && digits !== undefined ? formatVnd(digits) : value;
  return (
    <input
      id={id}
      aria-label={label}
      aria-invalid={invalid === true ? true : undefined}
      aria-describedby={invalid === true ? `${id}-error` : undefined}
      inputMode="numeric"
      autoComplete="off"
      className="num"
      disabled={disabled === true}
      value={shown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
    />
  );
}
