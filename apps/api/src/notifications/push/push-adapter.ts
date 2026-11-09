import { DomainError, TIMESTAMPED_HMAC_SHA256, assertLockScreenSafe, classifierOf } from '@machvon/kernel';
import type { AdapterStatus, ChannelAdapter, ChannelLookupResult, ChannelSendRequest, ChannelSendResult, ParsedChannelCallback, ProviderSignatureScheme, PushTarget } from '@machvon/kernel';
import type { PushProviderPort } from './ports';

/** The most devices one member is written to in one send: a member with more than this has registered a crowd, not a phone and a tablet. */
const MAX_TARGETS = 10;

/**
 * The adapter of a push channel (PUSH_FCM or PUSH_APNS) over its provider port (ST-NOT-007). The engine gives it the devices of the recipient with the tokens read from the vault for this call; it sends one message to
 * each, classifies what the providers answered in the words of the engine, and says which devices the provider no longer knows so that they are revoked. What it sends is a neutral sentence and an opaque link, judged
 * again here (the last look before the lock screen), or a silent data message that carries no text at all.
 *
 *  - some device accepted: the send is accepted (the message id is the first one), the dead tokens are told;
 *  - none accepted and a failure can be tried again (an outage, a quota): RETRYABLE, nothing is revoked;
 *  - a call to one device that throws does not take the others with it: it is counted only when nothing else decided the send, and then the send is UNKNOWN (the request may have gone out);
 *  - none accepted and every failure is for good: PERMANENT with the code of the first, and the devices whose token the provider refused are told as dead.
 * Delivery receipts do not come back for a push (the provider tells nothing more than "accepted"), so the status stays ProviderAccepted and nothing here marks a notification read.
 */
/** The code of a provider in the form the engine keeps (`BadDeviceToken` -> `BAD_DEVICE_TOKEN`, `UNREGISTERED` as it is). */
export function errorCodeOf(code: string): string {
  const words = code.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[A-Z]/.test(words) ? words.slice(0, 60) : 'PROVIDER_ERROR';
}

export class PushChannelAdapter implements ChannelAdapter {
  readonly paid = false;
  readonly signature: ProviderSignatureScheme = TIMESTAMPED_HMAC_SHA256;

  constructor(
    readonly provider: string,
    readonly channel: 'PUSH_FCM' | 'PUSH_APNS',
    private readonly port: PushProviderPort,
    readonly status: AdapterStatus = 'MOCK',
  ) {}

  async send(request: ChannelSendRequest): Promise<ChannelSendResult> {
    const targets = (request.targets ?? []).slice(0, MAX_TARGETS);
    if (targets.length === 0) return { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: 'NO_DEVICE' };
    const silent = request.silent !== undefined;
    if (!silent) {
      try {
        assertLockScreenSafe(request.text, request.deepLink);
      } catch (error) {
        return { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: error instanceof DomainError ? 'LOCKSCREEN_UNSAFE' : 'SEND_PREPARATION_FAILED' };
      }
    }
    const classify = classifierOf(this.channel);
    const accepted: string[] = [];
    const dead: string[] = [];
    let first: { code: string; failureClass: 'RETRYABLE' | 'PERMANENT'; retryAfterSeconds?: number } | undefined;
    let retryable: { code: string; retryAfterSeconds?: number } | undefined;
    let unanswered = false;
    for (const target of targets) {
      let answer: Awaited<ReturnType<PushProviderPort['send']>>;
      try {
        answer = await this.port.send({
          token: target.token,
          ...(silent ? {} : { body: request.text }),
          data: silent ? { kind: 'refresh', what: (request.silent as { what: string }).what } : { deep_link: request.deepLink ?? '' },
          silent,
          idempotencyKey: `${request.idempotencyKey}:${target.deviceId}`,
          deviceId: target.deviceId,
          ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
          ...(request.priority === undefined ? {} : { priority: request.priority }),
        });
      } catch {
        // The call to this device may have gone out: what the other devices answered still stands, and the rest are still tried.
        unanswered = true;
        continue;
      }
      if (answer.ok) {
        accepted.push(answer.messageId);
        continue;
      }
      const classified = classify(answer.code);
      // The pause the push service asked for wins over the default of the class, within an hour (a service that asks for a day is asked again in an hour).
      const failure = answer.retryAfterSeconds !== undefined && classified.failureClass === 'RETRYABLE' ? { ...classified, retryAfterSeconds: Math.min(3600, Math.max(1, Math.ceil(answer.retryAfterSeconds))) } : classified;
      if (failure.revoke) dead.push(target.deviceId);
      first ??= { code: errorCodeOf(answer.code), failureClass: failure.failureClass, ...(failure.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: failure.retryAfterSeconds }) };
      if (failure.failureClass === 'RETRYABLE') retryable ??= { code: errorCodeOf(answer.code), ...(failure.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: failure.retryAfterSeconds }) };
    }
    if (accepted.length > 0) return { kind: 'ACCEPTED', providerMessageId: accepted[0] as string, ...(dead.length === 0 ? {} : { deadTargets: dead }) };
    // A call that may have gone out comes before a retry: repeating the send could write twice to that device.
    if (unanswered) return { kind: 'UNKNOWN', errorCode: 'ADAPTER_ERROR' };
    if (retryable !== undefined) return { kind: 'FAILED', failureClass: 'RETRYABLE', errorCode: retryable.code, ...(retryable.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: retryable.retryAfterSeconds }), ...(dead.length === 0 ? {} : { deadTargets: dead }) };
    return { kind: 'FAILED', failureClass: 'PERMANENT', errorCode: first?.code ?? 'UNKNOWN', ...(dead.length === 0 ? {} : { deadTargets: dead }) };
  }

  /** A push provider keeps no record of a request by its idempotency key that the application could ask about. */
  async lookup(): Promise<ChannelLookupResult> {
    return { kind: 'UNDETERMINED' };
  }

  /** No webhook comes back for a push. */
  parseCallback(): ParsedChannelCallback | undefined {
    return undefined;
  }
}

export type { PushTarget };
