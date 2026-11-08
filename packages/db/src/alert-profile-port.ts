import type { LadderChannel, SuppressionReason } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

/** What the notification profile of a person says about one rung of the ladder at one moment. */
export type ProfileDecision =
  /** The rung may be sent. */
  | { kind: 'ALLOW' }
  /** The rung is not sent, and the ladder goes on to the next one: the person does not take this channel, or the day's cap for it is used. */
  | { kind: 'SUPPRESS'; reason: Extract<SuppressionReason, 'PROFILE' | 'DAILY_CAP' | 'NO_CONTACT' | 'QUIET_HOURS'> }
  /** The rung waits until the given moment (the end of the quiet hours, for example): the ladder does not move on and does not send meanwhile. */
  | { kind: 'DEFER'; until: Date };

export interface ProfileQuestion {
  recipient: string;
  channel: LadderChannel;
  severity: 'URGENT' | 'ACTION' | 'WATCH';
  /** The alert has been overdue for the person to take it up (the case in which an urgent alert may break the quiet hours). */
  overdueToClaim: boolean;
  now: Date;
}

/**
 * The small port through which the ladder reads the notification profile of a person (quiet hours with the exception of an urgent alert past its claim time, the daily cap of pushes, the channels they take). The profiles
 * are another lane's work (GOV-9a, roadmap G2-5): until it plugs in an implementation, the permissive default lets every rung go and leaves the decisions to the delivery engine, which applies the preferences, the consent
 * and the quiet hours of the person when each send is taken up. A port that fails does not stop an urgent alert: the job treats a failure as ALLOW and says so in its result.
 */
export interface AlertProfilePort {
  decide(tx: TenantTx, question: ProfileQuestion): Promise<ProfileDecision>;
}

/** The default: every rung is allowed. */
export class PermissiveAlertProfile implements AlertProfilePort {
  async decide(): Promise<ProfileDecision> {
    return { kind: 'ALLOW' };
  }
}
