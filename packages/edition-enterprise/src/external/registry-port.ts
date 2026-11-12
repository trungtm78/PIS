import { DomainError } from '@machvon/kernel';
import { EXTERNAL_ADAPTER_STATUS, externalAcceptance, isDay, isKey, isLine, pageOf, pageRequestOf } from './external-rules.ts';
import type { ExternalAcceptance, Page } from './external-rules.ts';

/**
 * The port to the registry of documents (van thu) of the customer (MD.02, TH.03, PX-07): the legal documents of an investment project, found by their symbol or listed by day. The customer has not specified the system, so
 * the layout is a WORKING ASSUMPTION and a document read through it is PENDING-EXTERNAL; until then a person attaches the file to the dossier of the project (DOC-01), which is what the project file does today.
 * A real adapter implements `DocumentRegistryPort` and passes `test/support/port-contract.ts`.
 */

export const REGISTRY_LAYOUT = 'VAN-THU-WORKING-ASSUMPTION-2026.1';
export const REGISTRY_DIRECTIONS = ['INCOMING', 'OUTGOING'] as const;
export type RegistryDirection = (typeof REGISTRY_DIRECTIONS)[number];

/** One document as the registry names it. The type is a code of the legal-document catalogue of the edition (ENT_LEGAL_DOC_TYPE) when the registry can say it, else null and a person classifies it. */
export interface RegistryDocument {
  registryNumber: string;
  symbol: string;
  direction: RegistryDirection;
  title: string;
  issuer: string;
  issuedOn: string;
  docTypeCode: string | null;
  projectCode: string | null;
  fileName: string | null;
  /** SHA-256 of the file, so the copy attached to the dossier can be shown to be the registered one. */
  fileSha256: string | null;
}

export interface RegistryQuery {
  issuedFrom?: string | undefined;
  issuedTo?: string | undefined;
  direction?: RegistryDirection | undefined;
  projectCode?: string | undefined;
  after?: string | undefined;
  limit?: number | undefined;
}

export interface RegistryPage extends Page<RegistryDocument> {
  layout: string;
  acceptance: ExternalAcceptance;
  workingAssumption: boolean;
}

export interface DocumentRegistryPort {
  readonly adapterStatus: typeof EXTERNAL_ADAPTER_STATUS;
  readonly layoutVersion: string;
  /** The document with this symbol, or null when the registry holds none. */
  findBySymbol(symbol: string): Promise<RegistryDocument | null>;
  listDocuments(query: RegistryQuery): Promise<RegistryPage>;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const DOC_TYPE = /^[A-Z][A-Z0-9_]{1,39}$/u;

export function registryDocumentProblems(document: RegistryDocument): string[] {
  const problems: string[] = [];
  if (!isKey(document.registryNumber)) problems.push('registry_number');
  if (!isLine(document.symbol, 100)) problems.push('symbol');
  if (!(REGISTRY_DIRECTIONS as readonly string[]).includes(document.direction)) problems.push('direction');
  if (!isLine(document.title, 500)) problems.push('title');
  if (!isLine(document.issuer, 200)) problems.push('issuer');
  if (!isDay(document.issuedOn)) problems.push('issued_on');
  if (document.docTypeCode !== null && !DOC_TYPE.test(document.docTypeCode)) problems.push('doc_type_code');
  if (document.projectCode !== null && !isKey(document.projectCode)) problems.push('project_code');
  if ((document.fileName === null) !== (document.fileSha256 === null)) problems.push('file_sha256');
  else if (document.fileName !== null && (!isLine(document.fileName, 200) || document.fileSha256 === null || !SHA256.test(document.fileSha256))) problems.push('file_sha256');
  return problems;
}

export function registryQueryOf(query: RegistryQuery): { issuedFrom: string | undefined; issuedTo: string | undefined; direction: RegistryDirection | undefined; projectCode: string | undefined; after: string | undefined; limit: number } {
  const page = pageRequestOf({ after: query.after, limit: query.limit });
  const fail = (field: string): never => {
    throw new DomainError('VALIDATION_FAILED', 422, field);
  };
  if (query.issuedFrom !== undefined && !isDay(query.issuedFrom)) fail('issued_from');
  if (query.issuedTo !== undefined && !isDay(query.issuedTo)) fail('issued_to');
  if (query.issuedFrom !== undefined && query.issuedTo !== undefined && query.issuedFrom > query.issuedTo) fail('issued_to');
  if (query.direction !== undefined && !(REGISTRY_DIRECTIONS as readonly string[]).includes(query.direction)) fail('direction');
  if (query.projectCode !== undefined && !isKey(query.projectCode)) fail('project_code');
  return { issuedFrom: query.issuedFrom, issuedTo: query.issuedTo, direction: query.direction, projectCode: query.projectCode, ...page };
}

/** The fake adapter: serves a fixed list from memory, refuses a document that breaks the layout when it is built, and says it is a working assumption in every page. */
export class FakeDocumentRegistryPort implements DocumentRegistryPort {
  readonly adapterStatus = EXTERNAL_ADAPTER_STATUS;
  readonly layoutVersion = REGISTRY_LAYOUT;
  private readonly documents: readonly RegistryDocument[];

  constructor(documents: readonly RegistryDocument[]) {
    for (const document of documents) {
      const problems = registryDocumentProblems(document);
      if (problems.length > 0) throw new DomainError('VALIDATION_FAILED', 422, problems[0] as string);
    }
    if (new Set(documents.map((document) => document.registryNumber)).size !== documents.length) throw new DomainError('VALIDATION_FAILED', 422, 'registry_number');
    this.documents = [...documents].sort((left, right) => (left.registryNumber < right.registryNumber ? -1 : left.registryNumber > right.registryNumber ? 1 : 0));
  }

  findBySymbol(symbol: string): Promise<RegistryDocument | null> {
    if (!isLine(symbol, 100)) throw new DomainError('VALIDATION_FAILED', 422, 'symbol');
    return Promise.resolve(this.documents.find((document) => document.symbol === symbol) ?? null);
  }

  listDocuments(query: RegistryQuery): Promise<RegistryPage> {
    const asked = registryQueryOf(query);
    const matching = this.documents.filter(
      (document) =>
        (asked.issuedFrom === undefined || document.issuedOn >= asked.issuedFrom) &&
        (asked.issuedTo === undefined || document.issuedOn <= asked.issuedTo) &&
        (asked.direction === undefined || document.direction === asked.direction) &&
        (asked.projectCode === undefined || document.projectCode === asked.projectCode),
    );
    const page = pageOf(matching, (document) => document.registryNumber, asked);
    return Promise.resolve({ ...page, layout: this.layoutVersion, acceptance: externalAcceptance(this.layoutVersion), workingAssumption: true });
  }
}
