import { isProductionEnvironment } from '@machvon/kernel';
import type { BillingPaymentMethod } from '@machvon/kernel';

/** Injection token of the registry of the providers whose callbacks the control plane takes (payments and e-invoices). */
export const WEBHOOK_PROVIDERS = Symbol('WEBHOOK_PROVIDERS');

export interface WebhookProvider {
  /** The name in the address (`/webhooks/payments/{provider}`) and the provider of the inbox row and of the payment. */
  name: string;
  kind: 'payment' | 'einvoice';
  /** What kind of payment it brings (payment providers). */
  method?: BillingPaymentMethod;
  /** The name the e-invoice adapter has on the invoices it issued (e-invoice providers). */
  adapterName?: string;
  /** The reference of the vault holding the signing keys; the platform's own, not a tenant's. */
  secretRef: string;
  /** The honest status of the adapter behind it: until D06 there is no real provider, so only MOCK exists, and not in production. */
  status: 'MOCK';
}

/**
 * The providers of the control plane by name. A provider that is not here is unknown (404), as is every provider in production until a contract with a real one exists (D05/D06): the MOCK ones are
 * registered only where `MACHVON_ENVIRONMENT` names an environment that is not production.
 */
export class WebhookProviderRegistry {
  private readonly byName = new Map<string, WebhookProvider>();

  constructor(providers: readonly WebhookProvider[]) {
    for (const provider of providers) {
      if (this.byName.has(provider.name)) throw new Error(`provider ${provider.name} is registered twice`);
      this.byName.set(provider.name, provider);
    }
  }

  of(kind: WebhookProvider['kind'], name: string): WebhookProvider | undefined {
    const found = this.byName.get(name);
    return found !== undefined && found.kind === kind ? found : undefined;
  }

  all(kind?: WebhookProvider['kind']): WebhookProvider[] {
    return [...this.byName.values()].filter((provider) => kind === undefined || provider.kind === kind);
  }
}

export function defaultWebhookProviders(environment: string | undefined): WebhookProviderRegistry {
  if (isProductionEnvironment(environment)) return new WebhookProviderRegistry([]);
  return new WebhookProviderRegistry([
    { name: 'mock-bank', kind: 'payment', method: 'BANK_TRANSFER', secretRef: 'secret://platform/webhooks/mock-bank', status: 'MOCK' },
    { name: 'mock-gateway', kind: 'payment', method: 'GATEWAY', secretRef: 'secret://platform/webhooks/mock-gateway', status: 'MOCK' },
    { name: 'mock-einvoice', kind: 'einvoice', adapterName: 'MOCK', secretRef: 'secret://platform/webhooks/mock-einvoice', status: 'MOCK' },
  ]);
}
