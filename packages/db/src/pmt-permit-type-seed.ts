import type { PermitTypeInput } from './pmt-permit-type-store.ts';

/** The day the working-assumption catalogue is dated from: a placeholder shared by every type until the original texts are read (CXN-EXE-03). */
export const SEED_EFFECTIVE_FROM = '2026-01-01';

const ASSUMPTION = 'Giả định làm việc, chưa đối chiếu văn bản gốc';
const UNKNOWN_AUTHORITY = 'Cơ quan có thẩm quyền theo quy định (chưa xác nhận)';

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
    name: 'Báo cáo đánh giá tác động môi trường (quyết định phê duyệt)',
    category: 'ENVIRONMENT',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: Luật Bảo vệ môi trường 2020 (đánh giá tác động môi trường) [CXN-EXE-03]`,
    cxnRef: 'CXN-EXE-03',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
  },
  {
    code: 'ENV_PERMIT',
    name: 'Giấy phép môi trường',
    category: 'ENVIRONMENT',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: Luật Bảo vệ môi trường 2020 (giấy phép môi trường) [CXN-EXE-03]`,
    cxnRef: 'CXN-EXE-03',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
  },
  {
    code: 'DESIGN_APPRAISAL',
    name: 'Thẩm định thiết kế và dự án',
    category: 'DESIGN_APPRAISAL',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: Luật Xây dựng 135/2025 và nghị định hướng dẫn thẩm định dự án, thiết kế [CXN-EXE-03]`,
    cxnRef: 'CXN-EXE-03',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
  },
  {
    code: 'FIRE_DESIGN',
    name: 'Thẩm duyệt thiết kế phòng cháy chữa cháy',
    category: 'FIRE_SAFETY',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: pháp luật về phòng cháy và chữa cháy, văn bản cụ thể chưa xác định [CXN-EXE-03]`,
    cxnRef: 'CXN-EXE-03',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
  },
  {
    code: 'BUILDING_PERMIT',
    name: 'Giấy phép xây dựng',
    category: 'CONSTRUCTION_PERMIT',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: Luật Xây dựng 135/2025 (giấy phép xây dựng và các trường hợp được miễn) [CXN-EXE-02]`,
    cxnRef: 'CXN-EXE-02',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
    exemptionAllowed: true,
  },
  {
    code: 'LAND_ALLOCATION',
    name: 'Quyết định giao đất hoặc cho thuê đất',
    category: 'LAND',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: căn cứ pháp lý chưa được xác định trong tài liệu thiết kế [CXN-EXE-03]`,
    cxnRef: 'CXN-EXE-03',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
  },
  {
    code: 'TRAFFIC_CONNECTION',
    name: 'Thỏa thuận đấu nối giao thông',
    category: 'TRAFFIC',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: căn cứ pháp lý chưa được xác định trong tài liệu thiết kế [CXN-EXE-03]`,
    cxnRef: 'CXN-EXE-03',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
  },
  {
    code: 'WATER_DISCHARGE',
    name: 'Giấy phép xả nước thải vào nguồn nước',
    category: 'WATER_RESOURCES',
    authorityText: UNKNOWN_AUTHORITY,
    legalBasis: `${ASSUMPTION}: căn cứ pháp lý chưa được xác định trong tài liệu thiết kế [CXN-EXE-03]`,
    cxnRef: 'CXN-EXE-03',
    effectiveFrom: SEED_EFFECTIVE_FROM,
    appliesToRule: {},
  },
];
