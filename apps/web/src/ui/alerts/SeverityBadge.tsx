import type { Severity } from './types';
import './alerts.css';

export interface SeverityBadgeProps {
  severity: Severity;
  /** Already translated: the badge never relies on colour alone, it always says the level in words and draws an icon. */
  label: string;
}

function SeverityIcon({ severity }: { severity: Severity }) {
  if (severity === 'URGENT') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 1.5 15 14H1z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M8 6v4M8 11.6v.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (severity === 'ACTION') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M5.2 8.2 7.3 10.3 11 5.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" />
    </svg>
  );
}

/** The level of an item: urgent (danger), needs action (warning), watch (info); icon + text + colour. */
export function SeverityBadge({ severity, label }: SeverityBadgeProps) {
  return (
    <span className="mv-alert-badge" data-severity={severity}>
      <SeverityIcon severity={severity} />
      <span>{label}</span>
    </span>
  );
}

export { SeverityIcon };
