import { aiEditionPolicy, resetAiEditionPolicy, setAiEditionPolicy } from '@machvon/kernel/src/ai-edition-policy.ts';
import type { AiEditionPolicy } from '@machvon/kernel/src/ai-edition-policy.ts';

/**
 * Where the AI of the enterprise edition runs (eng-review R5, requirement AI.07, HT.01): on a model the customer hosts itself, behind the LiteLLM-style gateway that is deployed on the servers of the customer, with the
 * data and the answers staying there. A provider outside those servers (a hosted model in the country or an international one) is off by default: it is used only under an exception that one person asked for and another
 * approved, for a limited time, with every use logged, and it is activated only after its data location and its no-training attestation are on record. The mechanism (the exception, the attestation, the refusal of a request,
 * the log) is the kernel's and the gateway's; this file is the value the enterprise process starts with. The public edition never loads it and keeps the routing policy of the tenant as it is.
 */
export const ENTERPRISE_AI_POLICY: AiEditionPolicy = Object.freeze({ name: 'customer-servers-only', externalRouting: 'EXCEPTION_REQUIRED', attestationRequired: true });

/** Sets the AI policy of the process to the enterprise one: called once by the API seam of the enterprise edition (a second call changes nothing). */
export function registerEnterpriseAiPolicy(): void {
  setAiEditionPolicy(ENTERPRISE_AI_POLICY);
}

/** Back to the policy of the public edition: for tests, which share one process. */
export const clearEnterpriseAiPolicy = (): void => resetAiEditionPolicy();

/** The policy the process serves now (the kernel's own accessor, for the tests of this package). */
export const currentAiPolicy = (): AiEditionPolicy => aiEditionPolicy();
