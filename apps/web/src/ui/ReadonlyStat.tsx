import { toneClass } from './types';
import type { Tone } from './types';

export interface ReadonlyStatProps {
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
}

/** A figure the user reads but does not edit: it sits on a tinted well in a form, next to the controls. */
export function ReadonlyStat({ label, value, sub, tone }: ReadonlyStatProps) {
  return (
    <div className={`ui-stat ${toneClass(tone)}`} role="group" aria-label={label}>
      <span className="ui-stat__label">{label}</span>
      <span className="ui-stat__value">{value}</span>
      {sub !== undefined && <span className="ui-stat__sub">{sub}</span>}
    </div>
  );
}
