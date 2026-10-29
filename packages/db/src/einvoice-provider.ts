/**
 * The port to the provider of e-invoices (ST-SAS-011, SAS.md 3.7): the platform hands the provider an invoice with a reference key (the id of the invoice) and gets back the
 * number, the template and series, the code of the tax authority and the code to look it up with. The provider must answer the same key with the same invoice and never
 * issue a second one [CXN-INV-03]; the platform leans on that when it asks again after an answer that never came. The real adapter stays PROPOSED until a contract with a
 * provider exists (D05/D06); the MOCK adapter below honours the contract of the reference key and is what the platform runs on until then.
 */

export interface EInvoiceIssueLine {
  kind: string;
  description: string;
  amountVnd: string;
  vatCategory: string;
  vatVnd: string;
}

export interface EInvoiceIssueRequest {
  /** The id of the invoice: the same key is the same invoice. */
  referenceKey: string;
  invoiceCode: string;
  periodStart: string;
  periodEnd: string;
  issueDate: string;
  buyer: { code: string; name: string };
  lines: EInvoiceIssueLine[];
  subtotalVnd: string;
  vatVnd: string;
  totalVnd: string;
}

export interface EInvoiceIssued {
  providerRef: string;
  templateCode: string;
  series: string;
  number: string;
  taxAuthorityCode: string;
  lookupCode: string;
}

export interface EInvoiceProviderPort {
  readonly name: string;
  /** Issues the invoice, or returns the one already issued for this reference key. Throws EInvoiceProviderUnavailable when the provider cannot answer now. */
  issue(request: EInvoiceIssueRequest): Promise<EInvoiceIssued>;
}

/** The provider did not answer (a 503, a timeout): the attempt is worth making again. */
export class EInvoiceProviderUnavailable extends Error {
  constructor(message = 'the e-invoice provider is unavailable') {
    super(message);
    this.name = 'EInvoiceProviderUnavailable';
  }
}

/** The injection token of the port. */
export const EINVOICE_PROVIDER = Symbol('EINVOICE_PROVIDER');

/**
 * The MOCK adapter: the number is worked out from the reference key, so the same key gets back the same invoice and no second one in any process and after any restart (the real provider keeps this
 * contract with its own series), and different keys get different numbers, and `failNext(n)` makes the
 * next n attempts fail the way a provider that answers 503 does (the failure of an attempt issues nothing).
 */
export class MockEInvoiceProvider implements EInvoiceProviderPort {
  readonly name = 'MOCK';
  /** How many times the provider was asked, failed attempts included. */
  calls = 0;
  private failures = 0;
  private readonly issued = new Map<string, EInvoiceIssued>();

  failNext(count: number): void {
    this.failures = count;
  }

  /** The invoices that exist at the provider: one per reference key, however many times it was asked. */
  get issuedCount(): number {
    return this.issued.size;
  }

  async issue(request: EInvoiceIssueRequest): Promise<EInvoiceIssued> {
    this.calls += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new EInvoiceProviderUnavailable('mock: 503');
    }
    const known = this.issued.get(request.referenceKey);
    if (known !== undefined) return known;
    const created: EInvoiceIssued = {
      providerRef: `MOCK-${request.referenceKey}`,
      templateCode: '1',
      series: 'C26TMV',
      number: numberOf(request.referenceKey),
      taxAuthorityCode: `CQT${request.referenceKey.replaceAll('-', '').slice(0, 20).toUpperCase()}`,
      lookupCode: request.referenceKey.replaceAll('-', '').slice(0, 12).toUpperCase(),
    };
    this.issued.set(request.referenceKey, created);
    return created;
  }
}

/** The whole key without its dashes: the same key is always the same number, in every process, and two keys never share one. */
export function numberOf(referenceKey: string): string {
  return referenceKey.replaceAll('-', '').toUpperCase();
}

let shared: MockEInvoiceProvider | undefined;

/** The one MOCK provider of the process, which the commands and the worker both use; the real provider replaces it at the binding. */
export function sharedMockEInvoiceProvider(): MockEInvoiceProvider {
  shared ??= new MockEInvoiceProvider();
  return shared;
}
