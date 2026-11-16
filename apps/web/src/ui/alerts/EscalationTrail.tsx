import { useTranslation } from '../../i18n';
import { systemRoleLabel } from '../../shell/account-role';
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

const ROLE_CODE = /(?<![\p{L}\p{N}_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?![\p{L}\p{N}_])/gu;

/**
 * A step of the chain as the server wrote it ("Đơn vị chuyên môn, vai trò AUDITOR") with the code of a system role replaced by its words in the role catalogue of the shell; a code the
 * catalogue does not hold (a role of the organisation, an abbreviation) stays as it came.
 */
export const roleWords = (t: ReturnType<typeof useTranslation>['t'], step: string): string => step.replace(ROLE_CODE, (code) => systemRoleLabel(t, code) ?? code);

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
        {chain.length === 0 ? null : <span>{` · ${t('alerts.escalation.chain', { chain: chain.map((step) => roleWords(t, step)).join(' → ') })}`}</span>}
        {next === '' ? null : <span>{` · ${t('alerts.escalation.next', { time: next })}`}</span>}
      </span>
    </div>
  );
}
