import type { FieldSpec, RuleParams, RuleRegistry } from './governance-rules.ts';
import { PWF_PROCESS_TEXT as T } from './messages/pwf-process-texts.ts';

/**
 * The shared catalogue of legal documents (PWF-4, R45): one rule code per document (a law, a decree, a circular, a decision), versioned and approved through the governance store like every rule (the one who approves is never the one
 * who wrote it). A step or a task of a workflow template cites a document by its code and names the article; nothing of the document is copied into the template. The catalogue says when the document takes effect, when it stops, and
 * which document replaced it, so one change here (a decree is replaced) is told to every template and every running project that cites it: `legalDocumentState` is what the screens and the alert read.
 *
 * The built-in entries are the documents the writers of the default templates know of on `AS_OF`; every one is `UNVERIFIED` until the legal officer of the agency confirms its number, its days and what replaced it.
 */

export const LEGAL_DOCUMENT_RULE_TYPE = 'LEGAL_DOCUMENT';

export const LEGAL_DOCUMENT_KINDS = ['LAW', 'RESOLUTION', 'DECREE', 'DECISION', 'CIRCULAR', 'DIRECTIVE', 'OTHER'] as const;
export type LegalDocumentKind = (typeof LEGAL_DOCUMENT_KINDS)[number];

export const LEGAL_DOCUMENT_STATES = ['NOT_YET_IN_FORCE', 'IN_FORCE', 'EXPIRED', 'SUPERSEDED'] as const;
export type LegalDocumentState = (typeof LEGAL_DOCUMENT_STATES)[number];

export interface LegalDocument {
  code: string;
  kind: LegalDocumentKind;
  /** The number and symbol as printed on the document ("58/2024/QH15"). */
  number: string;
  title: string;
  issuer: string;
  issuedOn: string | null;
  effectiveFrom: string;
  /** The first day the document is no longer in force; null while it has no end. */
  effectiveTo: string | null;
  /** The code of the document of this catalogue that replaced it. */
  supersededBy: string | null;
  verification: 'VERIFIED' | 'UNVERIFIED';
  /** The copy of the document in the document store of the tenant, when it keeps one. */
  documentId: string | null;
  url: string | null;
  note: string | null;
}

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const CODE = '^[A-Z][A-Z0-9_]{1,63}$';

export const LEGAL_DOCUMENT_SCHEMA: Readonly<Record<string, FieldSpec>> = {
  doc_kind: { kind: 'enum', values: LEGAL_DOCUMENT_KINDS },
  number: { kind: 'text', max: 60 },
  title: { kind: 'text', max: 400 },
  issuer: { kind: 'text', max: 160 },
  issued_on: { kind: 'date', optional: true },
  effective_from: { kind: 'date' },
  effective_to: { kind: 'date', optional: true },
  superseded_by: { kind: 'text', max: 64, pattern: CODE, optional: true },
  verification: { kind: 'enum', values: ['VERIFIED', 'UNVERIFIED'] },
  document_id: { kind: 'text', max: 36, pattern: UUID, optional: true },
  url: { kind: 'text', max: 300, pattern: '^https://[^\\s]+$', optional: true },
  note: { kind: 'text', max: 500, optional: true },
};

/** What the closed schema cannot say: a document stops after it starts, and is issued no later than it starts to count. */
export function legalDocumentDefect(params: Record<string, unknown>): string | undefined {
  const from = params.effective_from;
  const to = params.effective_to;
  if (typeof from === 'string' && typeof to === 'string' && to <= from) return 'effective_to';
  return undefined;
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Reads the params of a `LEGAL_DOCUMENT` rule (as the governance store keeps them, already judged by the schema). */
export function legalDocumentOf(code: string, params: RuleParams): LegalDocument {
  return {
    code,
    kind: params.doc_kind as LegalDocumentKind,
    number: String(params.number),
    title: String(params.title),
    issuer: String(params.issuer),
    issuedOn: textOrNull(params.issued_on),
    effectiveFrom: String(params.effective_from),
    effectiveTo: textOrNull(params.effective_to),
    supersededBy: textOrNull(params.superseded_by),
    verification: params.verification === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED',
    documentId: textOrNull(params.document_id),
    url: textOrNull(params.url),
    note: textOrNull(params.note),
  };
}

/**
 * Whether a document may be cited on the day `today` (`YYYY-MM-DD`): not yet in force before its first day; replaced once another document of the catalogue stands in its place and its last day (when it has one) is past;
 * expired once its last day is past with nothing named in its place; in force otherwise.
 */
export function legalDocumentState(document: Pick<LegalDocument, 'effectiveFrom' | 'effectiveTo' | 'supersededBy'>, today: string): LegalDocumentState {
  if (today < document.effectiveFrom) return 'NOT_YET_IN_FORCE';
  const ended = document.effectiveTo !== null && today >= document.effectiveTo;
  if (document.supersededBy !== null && (ended || document.effectiveTo === null)) return 'SUPERSEDED';
  if (ended) return 'EXPIRED';
  return 'IN_FORCE';
}

/** A document that must not be cited any more: the alert and the warning of the screens. */
export const isLapsed = (state: LegalDocumentState): boolean => state === 'EXPIRED' || state === 'SUPERSEDED';

const AS_OF = '2026-11-14';
/** The first review day of the built-in alert type (the day the other alert types of the workflow are reviewed on). */
const ALERT_FIRST_REVIEW_ON = '2027-05-08';

interface Entry {
  kind: LegalDocumentKind;
  number: string;
  title: string;
  issuer: string;
  from: string;
  to?: string;
  supersededBy?: string;
}

const entry = (one: Entry): RuleParams => ({
  doc_kind: one.kind,
  number: one.number,
  title: one.title,
  issuer: one.issuer,
  effective_from: one.from,
  ...(one.to === undefined ? {} : { effective_to: one.to }),
  ...(one.supersededBy === undefined ? {} : { superseded_by: one.supersededBy }),
  verification: 'UNVERIFIED',
  note: T.need_pilot,
});

/** The documents the default templates of the public edition cite. Days of effect are the ones the writers know of; none is confirmed (`UNVERIFIED`). */
export const PUBLIC_LEGAL_DOCUMENTS: Readonly<Record<string, RuleParams>> = {
  LAW_58_2024_QH15: entry({ kind: 'LAW', number: '58/2024/QH15', title: T.law_public_investment, issuer: T.issuer_assembly, from: '2025-01-01' }),
  DECREE_85_2025_ND_CP: entry({ kind: 'DECREE', number: '85/2025/NĐ-CP', title: T.decree_public_investment, issuer: T.issuer_government, from: '2025-04-08' }),
  LAW_22_2023_QH15: entry({ kind: 'LAW', number: '22/2023/QH15', title: T.law_bidding, issuer: T.issuer_assembly, from: '2024-01-01' }),
  DECREE_24_2024_ND_CP: entry({ kind: 'DECREE', number: '24/2024/NĐ-CP', title: T.decree_bidding_old, issuer: T.issuer_government, from: '2024-02-27', to: '2025-08-04', supersededBy: 'DECREE_214_2025_ND_CP' }),
  DECREE_214_2025_ND_CP: entry({ kind: 'DECREE', number: '214/2025/NĐ-CP', title: T.decree_bidding, issuer: T.issuer_government, from: '2025-08-04' }),
  LAW_50_2014_QH13: entry({ kind: 'LAW', number: '50/2014/QH13', title: T.law_construction, issuer: T.issuer_assembly, from: '2015-01-01' }),
  DECREE_175_2024_ND_CP: entry({ kind: 'DECREE', number: '175/2024/NĐ-CP', title: T.decree_construction, issuer: T.issuer_government, from: '2024-12-30' }),
  DECREE_06_2021_ND_CP: entry({ kind: 'DECREE', number: '06/2021/NĐ-CP', title: T.decree_quality, issuer: T.issuer_government, from: '2021-01-26' }),
  DECREE_99_2021_ND_CP: entry({ kind: 'DECREE', number: '99/2021/NĐ-CP', title: T.decree_settlement, issuer: T.issuer_government, from: '2022-01-01' }),
  LAW_15_2017_QH14: entry({ kind: 'LAW', number: '15/2017/QH14', title: T.law_public_assets, issuer: T.issuer_assembly, from: '2018-01-01' }),
};

/** The alert type of a legal ground that lapsed (R45): who answers, what they do, what happens if they do not. */
export const LEGAL_BASIS_ALERT_CODE = 'PWF_LEGAL_BASIS_LAPSED';

/** Registers the catalogue `LEGAL_DOCUMENT` with the documents of the public edition, and the alert type of a lapsed legal ground under `ALERT_TYPE`. Called by the registry of governance-rules.ts. */
export function registerLegalDocumentRules(registry: RuleRegistry): void {
  registry.registerRuleType({
    type: LEGAL_DOCUMENT_RULE_TYPE,
    ownerModule: 'PWF',
    modules: ['PWF', 'PRJ', 'DOC', 'ADM'],
    formula: T.catalogue_formula,
    source: T.catalogue_source,
    asOf: AS_OF,
    legalStatus: 'UNVERIFIED',
    schema: LEGAL_DOCUMENT_SCHEMA,
    refine: legalDocumentDefect,
    codePattern: CODE,
    defaults: Object.fromEntries(Object.entries(PUBLIC_LEGAL_DOCUMENTS).map(([code, params]) => [code, { params }])),
  });
  registry.registerRuleDefaults('ALERT_TYPE', {
    [LEGAL_BASIS_ALERT_CODE]: {
      params: {
        source: 'LEGAL_BASIS',
        owner: 'PROJECT_MANAGER',
        expected_action: T.basis_action,
        consequence: T.basis_consequence,
        response_hours: 120,
        default_severity: 'WATCH',
        reason_to_exist: T.basis_why,
        review_on: ALERT_FIRST_REVIEW_ON,
        enabled: true,
      },
      source: T.alert_source,
      asOf: AS_OF,
      legalStatus: 'VERIFIED',
    },
  });
}
