import { useTranslation } from '../../i18n';
import { clockAndDay } from './format';
import './alerts.css';

export interface EscalationTrailProps {
  /** The level the item has reached (1 is the first escalation). */
  level: number;
  /** How many levels the chain has. */
  of: number;
  /** The people (or roles) the item goes through, in order; the one at `level` is the one who holds it now. */
  chain: string[];
  /** When the next level is reached, or null at the last level. */
  nextAt: string | null;
}

/** Where an item that was not handled stands on its way up: "Escalated to level 2/3", the chain, and when the next level is reached. */
export function EscalationTrail({ level, of, chain, nextAt }: EscalationTrailProps) {
  const { t } = useTranslation();
  const total = Math.max(of, level, 1);
  const next = nextAt === null ? '' : clockAndDay(nextAt);
  return (
    <div className="mv-alert-trail" role="group" aria-label={t('alerts.escalation.label')}>
      <span className="mv-alert-trail__steps" aria-hidden="true">
        {Array.from({ length: total }, (_unused, index) => (
          <span key={index} className="mv-alert-trail__step" data-reached={index < level ? 'true' : 'false'} />
        ))}
      </span>
      <span className="mv-alert-trail__text">
        <strong>{t('alerts.escalation.level', { level, of: total })}</strong>
        {chain.length === 0 ? null : <span>{` · ${t('alerts.escalation.chain', { chain: chain.join(' → ') })}`}</span>}
        {next === '' ? null : <span>{` · ${t('alerts.escalation.next', { time: next })}`}</span>}
      </span>
    </div>
  );
}
