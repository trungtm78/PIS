import type { PermitTypeInput } from './pmt-permit-type-store.ts';
import { vietnameseData } from './vietnamese-data.ts';

/** The day the working-assumption catalogue is dated from: a placeholder shared by every type until the original texts are read (CXN-EXE-03). */
export const SEED_EFFECTIVE_FROM = '2026-01-01';

const TEXT = vietnameseData<{ assumption: string; unknownAuthority: string; types: Record<string, { name: string; basis: string }> }>('pmt-permit-type-seed');
const ASSUMPTION = TEXT.assumption;
const UNKNOWN_AUTHORITY = TEXT.unknownAuthority;
/** The Vietnamese name of a type and the text of its legal basis (after the assumption), from the data file. */
const typeText = (code: string): { name: string; basis: string } => TEXT.types[code] ?? { name: code, basis: code };

/**
 * The starting catalogue of PMT 5: eight types of permit that a public investment project may need before a milestone. It is a WORKING
 * ASSUMPTION, not law. The names and the categories come from the design; no period of validity or of processing is given because none can
 * be sourced from the design documents, and the legal basis says in words that the original text has not been read. Every type carries the
 * confirmation id that gates it (`CXN-EXE-03`; `CXN-EXE-02` for the building permit, whose exemptions follow the new construction law), so
 * a screen flags it and a dossier cannot be built on it as if it were confirmed. Confirming a type is publishing its next revision without
 * the reference, with the legal basis read from the original text.
 */
export const PERMIT_TYPE_WORKING_ASSUMPTIONS: readonly PermitTypeInput[] = [
  {
    code: 'ENV_EIA',
    name: typeText('ENV_EIA').name,
    category: 'ENVIRONMENT',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: ${typeText('ENV_EIA').basis}`,
    cxnRef: 'CXN-EXE-03',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
  },
  {
    code: 'ENV_PERMIT',
    name: typeText('ENV_PERMIT').name,
    category: 'ENVIRONMENT',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: ${typeText('ENV_PERMIT').basis}`,
    cxnRef: 'CXN-EXE-03',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
  },
  {
    code: 'DESIGN_APPRAISAL',
    name: typeText('DESIGN_APPRAISAL').name,
    category: 'DESIGN_APPRAISAL',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: ${typeText('DESIGN_APPRAISAL').basis}`,
    cxnRef: 'CXN-EXE-03',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
  },
  {
    code: 'FIRE_DESIGN',
    name: typeText('FIRE_DESIGN').name,
    category: 'FIRE_SAFETY',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: ${typeText('FIRE_DESIGN').basis}`,
    cxnRef: 'CXN-EXE-03',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
  },
  {
    code: 'BUILDING_PERMIT',
    name: typeText('BUILDING_PERMIT').name,
    category: 'CONSTRUCTION_PERMIT',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: ${typeText('BUILDING_PERMIT').basis}`,
    cxnRef: 'CXN-EXE-02',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
    exemptionAllowed: true,
  },
  {
    code: 'LAND_ALLOCATION',
    name: typeText('LAND_ALLOCATION').name,
    category: 'LAND',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: ${typeText('LAND_ALLOCATION').basis}`,
    cxnRef: 'CXN-EXE-03',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
  },
  {
    code: 'TRAFFIC_CONNECTION',
    name: typeText('TRAFFIC_CONNECTION').name,
    category: 'TRAFFIC',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: ${typeText('TRAFFIC_CONNECTION').basis}`,
    cxnRef: 'CXN-EXE-03',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
  },
  {
    code: 'WATER_DISCHARGE',
    name: typeText('WATER_DISCHARGE').name,
    category: 'WATER_RESOURCES',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: ${typeText('WATER_DISCHARGE').basis}`,
    cxnRef: 'CXN-EXE-03',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
  },
];
