import type { ReactNode } from 'react';
import { toneClass } from './types';
import type { Tone } from './types';

export interface StatusPillProps {
  tone: Tone;
  children: ReactNode;
  icon?: ReactNode;
}

/** A state shown as text on a tinted pill; the icon is only a second cue, the text is always there. */
export function StatusPill({ tone, children, icon }: StatusPillProps) {
  return (
    <span className={`ui-pill ${toneClass(tone)}`}>
      {icon !== undefined && (
        <span className="ui-pill__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span>{children}</span>
    </span>
  );
}
