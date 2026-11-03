import { consentAllows, consentPurposeOf, consentRequirement, isQuietHoursChannel, preferenceChannelOf, quietHoursAt, eventCategoryOf } from '@machvon/kernel';
import { ContactConsentStore } from './contact-consent-store.ts';
import type { LockedNotification } from './delivery-store.ts';
import { NotificationPreferenceStore } from './notification-preference-store.ts';
import type { TenantTx } from './tenant-database.ts';

/** Why a send is not made. The codes are stored on the suppressed attempt and shown to the operator (NOT-11, NOT-12). */
export type SuppressionReason = 'NO_CONSENT' | 'CONSENT_WITHDRAWN' | 'PREFERENCE_OFF';

/** The error code a send that is held for quiet hours carries until it is taken up. */
export const QUIET_HOURS_CODE = 'QUIET_HOURS';

export type GateDecision =
  /** The send may go. `quietHoursOverride`: it falls in the quiet hours of the person and goes because the workflow marks it urgent (it is audited). */
  | { kind: 'PROCEED'; quietHoursOverride?: true; quietEndsAt?: Date }
  | { kind: 'SUPPRESS'; reason: SuppressionReason }
  /** Not before the quiet hours of the person end. */
  | { kind: 'DEFER'; until: Date };

type Subject = Pick<LockedNotification, 'recipientId' | 'purpose' | 'sourceEventType' | 'priority' | 'workflowVersionId'>;

/**
 * The last word before a message is written to a person (ST-NOT-003, NOT 3.1 step 5 and 6): the person's preference for the channel, their consent
 * where the decision table asks for one (BR-NOT-07), and their quiet hours (BR-NOT-08). It runs in the transaction that takes the send up, under the
 * lock of the notification, so a consent withdrawn before that transaction can never be sent on, and a send never starts on a stale answer. An urgent
 * message may break the quiet hours only when the workflow that raised it says so; it never breaks a preference or a consent.
 */
export class DeliveryGate {
  private readonly preferences: NotificationPreferenceStore;
  private readonly consents: ContactConsentStore;

  constructor(preferences = new NotificationPreferenceStore(), consents = new ContactConsentStore()) {
    this.preferences = preferences;
    this.consents = consents;
  }

  async decide(tx: TenantTx, notification: Subject, channel: string, now: Date): Promise<GateDecision> {
    const kind = preferenceChannelOf(channel);
    if (kind !== undefined && kind !== 'IN_APP' && !(await this.preferences.channelEnabled(tx, notification.recipientId, eventCategoryOf(notification.sourceEventType), kind))) {
      return { kind: 'SUPPRESS', reason: 'PREFERENCE_OFF' };
    }
    const refusal = await this.consentRefusal(tx, notification, kind);
    if (refusal !== undefined) return { kind: 'SUPPRESS', reason: refusal };
    if (!isQuietHoursChannel(channel)) return { kind: 'PROCEED' };
    const hours = await this.preferences.quietHoursOf(tx, notification.recipientId);
    const verdict = hours === undefined ? { quiet: false } : quietHoursAt(now, hours);
    if (!verdict.quiet || verdict.endsAt === undefined) return { kind: 'PROCEED' };
    if (notification.priority === 'CRITICAL' && (await this.overrides(tx, notification.workflowVersionId))) return { kind: 'PROCEED', quietHoursOverride: true, quietEndsAt: verdict.endsAt };
    return { kind: 'DEFER', until: verdict.endsAt };
  }

  /**
   * BR-NOT-07: the latest consent of the person for the channel and the purpose of the message, where the table asks for one. Why it refuses: the person
   * withdrew a consent they had given (CONSENT_WITHDRAWN), or never gave one that covers the message (NO_CONSENT).
   */
  private async consentRefusal(tx: TenantTx, notification: Subject, channel: ReturnType<typeof preferenceChannelOf>): Promise<'NO_CONSENT' | 'CONSENT_WITHDRAWN' | undefined> {
    const requirement = consentRequirement(channel, notification.purpose);
    if (requirement === 'NONE') return undefined;
    const purpose = consentPurposeOf(notification.purpose);
    if (channel === undefined || purpose === undefined) return 'NO_CONSENT';
    const latest = await this.consents.latest(tx, notification.recipientId, channel, purpose);
    if (consentAllows(requirement, latest)) return undefined;
    return latest?.status === 'Withdrawn' ? 'CONSENT_WITHDRAWN' : 'NO_CONSENT';
  }

  /** Whether the workflow that raised the message lets it break the quiet hours (NOT 3.4 `quiet_hours_override`; the definition accepts it for CRITICAL only). */
  private async overrides(tx: TenantTx, workflowVersionId: string): Promise<boolean> {
    const [row] = await tx.query<{ override: boolean }>("select coalesce(definition_json ->> 'quietHoursOverride' = 'true', false) as override from machvon.workflow_version where id = $1::uuid", [workflowVersionId]);
    return row?.override === true;
  }
}
