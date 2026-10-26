/** Names of the fixture tenants in Design/MACHVON_Design/03_Engineering/test_fixtures.json. */
export type TenantName = 'TNT-A' | 'TNT-B';

export const TENANT_NAMES: readonly TenantName[] = ['TNT-A', 'TNT-B'];

// The fixture tenants are names, not UUIDs, so fixed UUIDs stand in for them.
export const TENANT_IDS: Readonly<Record<TenantName, string>> = {
  'TNT-A': '00000000-0000-4000-8000-00000000000a',
  'TNT-B': '00000000-0000-4000-8000-00000000000b',
};

export interface UnitFixture {
  id: string;
  code: string;
  name: string;
}

/** Synthetic organization units; the names are distinctive so a leak is easy to recognise. */
export const UNIT_FIXTURES: Readonly<Record<TenantName, readonly UnitFixture[]>> = {
  'TNT-A': [
    { id: '00000000-0000-4000-a001-000000000001', code: 'A-HQ', name: 'Sở Tài chính Alpha Đà Nẵng' },
    { id: '00000000-0000-4000-a001-000000000002', code: 'A-OPS', name: 'Phòng Vận hành Alpha' },
    { id: '00000000-0000-4000-a001-000000000003', code: 'A-AUD', name: 'Ban Kiểm toán Alpha' },
  ],
  'TNT-B': [
    { id: '00000000-0000-4000-b002-000000000001', code: 'B-HQ', name: 'Văn phòng Bí mật Beta Huế' },
    { id: '00000000-0000-4000-b002-000000000002', code: 'B-OPS', name: 'Phòng Dự án Beta' },
  ],
};

export interface RoleFixture {
  id: string;
  code: string;
  name: string;
}

/** Custom roles with distinctive names: the TNT-A role gives the test principal full rights, the TNT-B role must never show. */
export const ROLE_FIXTURES: Readonly<Record<TenantName, RoleFixture>> = {
  'TNT-A': { id: '00000000-0000-4000-a003-000000000001', code: 'ALPHA_ISOLATION_FULL', name: 'Vai trò Toàn quyền Alpha' },
  'TNT-B': { id: '00000000-0000-4000-b003-000000000001', code: 'BETA_SECRET_ROLE', name: 'Vai trò Bí mật Beta' },
};

/** The grant of the fixture role to the test membership in each tenant. */
export const GRANT_FIXTURES: Readonly<Record<TenantName, { id: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a004-000000000001' },
  'TNT-B': { id: '00000000-0000-4000-b004-000000000001' },
};

/** A second person with a membership in each tenant, with distinctive personal data that must never cross the boundary. */
export const MEMBERSHIP_FIXTURES: Readonly<Record<TenantName, { id: string; userId: string; displayName: string; email: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a007-000000000001', userId: '00000000-0000-4000-a008-000000000001', displayName: 'Nguyễn Alpha Công khai', email: 'alpha.member@example.test' },
  'TNT-B': { id: '00000000-0000-4000-b007-000000000001', userId: '00000000-0000-4000-b008-000000000001', displayName: 'Trần Beta Bí mật', email: 'beta.secret@example.test' },
};

/** The notification of the test membership in each tenant (an in-app notification about a project, with its workflow). */
export const NOTIFICATION_FIXTURES: Readonly<Record<TenantName, { id: string; workflowId: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a005-000000000001', workflowId: '00000000-0000-4000-a006-000000000001' },
  'TNT-B': { id: '00000000-0000-4000-b005-000000000001', workflowId: '00000000-0000-4000-b006-000000000001' },
};

/** A Granted SMS consent of the test membership of each tenant (the consent history is personal data: its id must not reach another tenant). */
export const CONSENT_FIXTURES: Readonly<Record<TenantName, { id: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0a5-000000000001' },
  'TNT-B': { id: '00000000-0000-4000-b0a5-000000000001' },
};

/** An Active tenant-wide legal hold of each tenant (tenant administration data; the authority reference is confidential). */
export const LEGAL_HOLD_FIXTURES: Readonly<Record<TenantName, { id: string; authorityReference: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a009-000000000001', authorityReference: 'ALPHA-HOLD-REF-0001' },
  'TNT-B': { id: '00000000-0000-4000-b009-000000000001', authorityReference: 'BETA-SECRET-HOLD-REF-0001' },
};

/** A master record in force, its version and an open (draft) change request of each tenant; the business key and the label are distinctive. */
export const MASTER_FIXTURES: Readonly<Record<TenantName, { recordId: string; versionId: string; changeId: string; businessKey: string; label: string }>> = {
  'TNT-A': { recordId: '00000000-0000-4000-a010-000000000001', versionId: '00000000-0000-4000-a010-000000000002', changeId: '00000000-0000-4000-a010-000000000003', businessKey: 'ALPHA-SECTOR-0001', label: 'Alpha sector label' },
  'TNT-B': { recordId: '00000000-0000-4000-b010-000000000001', versionId: '00000000-0000-4000-b010-000000000002', changeId: '00000000-0000-4000-b010-000000000003', businessKey: 'BETA-SECTOR-0001', label: 'Beta sector label' },
};

/** A bulk import batch of each tenant, waiting for its review (the file hash and the object key are distinctive). */
export const MASTER_IMPORT_FIXTURES: Readonly<Record<TenantName, { id: string; fileSha256: string; fileObjectKey: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a011-000000000001', fileSha256: 'a3'.repeat(32), fileObjectKey: 'tenants/00000000-0000-4000-8000-00000000000a/import/alpha-catalogue-0001' },
  'TNT-B': { id: '00000000-0000-4000-b011-000000000001', fileSha256: 'b4'.repeat(32), fileObjectKey: 'tenants/00000000-0000-4000-8000-00000000000b/import/beta-catalogue-0001' },
};

/** An ACTIVE crosswalk and an integration cursor of each tenant (the external code, the connector scope and the last file hash are distinctive). */
export const CROSSWALK_FIXTURES: Readonly<Record<TenantName, { crosswalkId: string; externalCode: string; cursorId: string; sourceScope: string; fileSha256: string }>> = {
  'TNT-A': { crosswalkId: '00000000-0000-4000-a012-000000000001', externalCode: 'ALPHA-TREASURY-CODE-0001', cursorId: '00000000-0000-4000-a012-000000000002', sourceScope: 'ALPHA-SCOPE-0001', fileSha256: 'a5'.repeat(32) },
  'TNT-B': { crosswalkId: '00000000-0000-4000-b012-000000000001', externalCode: 'BETA-TREASURY-CODE-0001', cursorId: '00000000-0000-4000-b012-000000000002', sourceScope: 'BETA-SCOPE-0001', fileSha256: 'b6'.repeat(32) },
};

/** A glossary term in review of each tenant (its code and its wording are distinctive; tenant data). */
export const GLOSSARY_FIXTURES: Readonly<Record<TenantName, { termId: string; termCode: string; definition: string }>> = {
  'TNT-A': { termId: '00000000-0000-4000-a013-000000000001', termCode: 'ALPHA_ISOLATION_TERM', definition: 'Alpha tenant definition of the isolation glossary term.' },
  'TNT-B': { termId: '00000000-0000-4000-b013-000000000001', termCode: 'BETA_ISOLATION_TERM', definition: 'Beta tenant definition of the isolation glossary term.' },
};

/** A CONCEPT project of each tenant (its code and its name are distinctive; tenant data). */
export const PROJECT_FIXTURES: Readonly<Record<TenantName, { id: string; code: string; name: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0c1-000000000001', code: 'ALPHA-PROJECT-0001', name: 'Alpha tenant isolation project' },
  'TNT-B': { id: '00000000-0000-4000-b0c1-000000000001', code: 'BETA-PROJECT-0001', name: 'Beta tenant isolation project' },
};

/** A SUBMITTED appraisal sheet of the CONCEPT project of each tenant (the decision on it is addressed to the sheet; tenant data). */
export const APPRAISAL_FIXTURES: Readonly<Record<TenantName, { id: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0c4-000000000001' },
  'TNT-B': { id: '00000000-0000-4000-b0c4-000000000001' },
};

/** A SURVEYED land parcel of the project of each tenant (its code is distinctive; a parcel carries no owner, so there is no person in it). */
export const PARCEL_FIXTURES: Readonly<Record<TenantName, { id: string; code: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0b2-000000000001', code: 'ALPHA-PARCEL-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0b2-000000000001', code: 'BETA-PARCEL-0001' },
};

/** A household affected by a land recovery in the project of each tenant (its code is distinctive; the personal data of it is sealed, and the name shown is masked). */
export const HOUSEHOLD_FIXTURES: Readonly<Record<TenantName, { id: string; code: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0b8-000000000001', code: 'HH-A90001' },
  'TNT-B': { id: '00000000-0000-4000-b0b8-000000000001', code: 'HH-B90001' },
};

/** An inventory record of the household of each tenant (counted at a distinctive price decision; what is counted at a household is tenant data). */
export const INVENTORY_FIXTURES: Readonly<Record<TenantName, { id: string; linkId: string; priceDecision: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0b9-000000000001', linkId: '00000000-0000-4000-a0b9-000000000002', priceDecision: 'ALPHA-QD-GIA-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0b9-000000000001', linkId: '00000000-0000-4000-b0b9-000000000002', priceDecision: 'BETA-QD-GIA-0001' },
};

/** An audit engagement of each tenant (its code and title are distinctive: the data of an engagement are CONFIDENTIAL and belong to the tenant). */
export const ENGAGEMENT_FIXTURES: Readonly<Record<TenantName, { id: string; scopeItemId: string; code: string; title: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0ea-000000000001', scopeItemId: '00000000-0000-4000-a0eb-000000000001', code: 'AUD-ISO-ALPHA', title: 'Alpha audit of the investment in the bridge' },
  'TNT-B': { id: '00000000-0000-4000-b0ea-000000000001', scopeItemId: '00000000-0000-4000-b0eb-000000000001', code: 'AUD-ISO-BETA', title: 'Beta inspection of the investment in the road' },
};

/** The conclusion of the engagement of each tenant with a finding and a recommendation (what an authority wrote is CONFIDENTIAL and belongs to the tenant: the words are distinctive). */
export const CONCLUSION_FIXTURES: Readonly<
  Record<
    TenantName,
    { id: string; findingId: string; recommendationId: string; actionId: string; linkId: string; linkSourceId: string; reportId: string; reportSha256: string; summary: string; findingCode: string; findingWords: string; recCode: string; recWords: string; actionCode: string; actionWords: string }
  >
> = {
  'TNT-A': {
    id: '00000000-0000-4000-a0ec-000000000001',
    findingId: '00000000-0000-4000-a0ed-000000000001',
    recommendationId: '00000000-0000-4000-a0ee-000000000001',
    actionId: '00000000-0000-4000-a0ef-000000000001',
    linkId: '00000000-0000-4000-a0f0-000000000001',
    linkSourceId: '00000000-0000-4000-a0f1-000000000001',
    reportId: '00000000-0000-4000-a0f2-000000000001',
    reportSha256: 'a0f2'.repeat(16),
    summary: 'Alpha audit found payments far above the approved volumes',
    findingCode: 'AUD-F-ALPHA',
    findingWords: 'Alpha finding of a payment above the accepted volume',
    recCode: 'AUD-R-ALPHA',
    recWords: 'Alpha recommendation to recover the excess payment',
    actionCode: 'AUD-A-ALPHA',
    actionWords: 'Alpha action to repay the excess to the budget',
  },
  'TNT-B': {
    id: '00000000-0000-4000-b0ec-000000000001',
    findingId: '00000000-0000-4000-b0ed-000000000001',
    recommendationId: '00000000-0000-4000-b0ee-000000000001',
    actionId: '00000000-0000-4000-b0ef-000000000001',
    linkId: '00000000-0000-4000-b0f0-000000000001',
    linkSourceId: '00000000-0000-4000-b0f1-000000000001',
    reportId: '00000000-0000-4000-b0f2-000000000001',
    reportSha256: 'b0f2'.repeat(16),
    summary: 'Beta inspection found invoices without supporting records',
    findingCode: 'AUD-F-BETA',
    findingWords: 'Beta finding of invoices without records of the work',
    recCode: 'AUD-R-BETA',
    recWords: 'Beta recommendation to correct the process of invoicing',
    actionCode: 'AUD-A-BETA',
    actionWords: 'Beta action to rewrite the invoicing procedure',
  },
};

/** A complaint of the household of each tenant (its words are distinctive: what a complainant says is personal data of the tenant). */
export const COMPLAINT_FIXTURES: Readonly<Record<TenantName, { id: string; number: string; words: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0bc-000000000001', number: 'LC-000901', words: 'Alpha complainant says the price is far too low' },
  'TNT-B': { id: '00000000-0000-4000-b0bc-000000000001', number: 'LC-000902', words: 'Beta complainant says the area is wrong' },
};

/** A payment of the approved plan of compensation of each tenant (the plan of PLAN_COMP_FIXTURES, in the end of its way to being paid). */
export const PAYMENT_COMP_FIXTURES: Readonly<Record<TenantName, { id: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0bb-000000000001' },
  'TNT-B': { id: '00000000-0000-4000-b0bb-000000000001' },
};

/** A draft plan of compensation of the project of each tenant, with one item of the household (the code is distinctive; the amounts of a household are tenant data). */
export const PLAN_COMP_FIXTURES: Readonly<Record<TenantName, { id: string; itemId: string; code: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0ba-000000000001', itemId: '00000000-0000-4000-a0ba-000000000002', code: 'ALPHA-PLAN-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0ba-000000000001', itemId: '00000000-0000-4000-b0ba-000000000002', code: 'BETA-PLAN-0001' },
};

/** The ACTIVE deputy-leader assignment of the isolation project of each tenant and an ACTIVE task force (the code and the name are distinctive; who answers for a project is tenant data). */
export const ACCOUNTABILITY_FIXTURES: Readonly<Record<TenantName, { assignmentId: string; taskForceId: string; taskForceCode: string; taskForceName: string }>> = {
  'TNT-A': { assignmentId: '00000000-0000-4000-a0b3-000000000001', taskForceId: '00000000-0000-4000-a0b3-000000000002', taskForceCode: 'ALPHA-TF-0001', taskForceName: 'Alpha tenant disbursement task force 0001' },
  'TNT-B': { assignmentId: '00000000-0000-4000-b0b3-000000000001', taskForceId: '00000000-0000-4000-b0b3-000000000002', taskForceCode: 'BETA-TF-0001', taskForceName: 'Beta tenant disbursement task force 0001' },
};

/** A handover section of the project of each tenant (its code is distinctive; tenant data). */
export const SECTION_FIXTURES: Readonly<Record<TenantName, { id: string; code: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0b3-000000000001', code: 'ALPHA-SECTION-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0b3-000000000001', code: 'BETA-SECTION-0001' },
};

/** A package of the isolation project of each tenant, with a milestone and the link to its code on the national bidding network (the code is distinctive; tenant data). */
export const PACKAGE_FIXTURES: Readonly<Record<TenantName, { id: string; code: string; milestoneId: string; linkId: string; externalCode: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0b9-000000000001', code: 'ALPHA-PACKAGE-0001', milestoneId: '00000000-0000-4000-a0b9-000000000002', linkId: '00000000-0000-4000-a0b9-000000000003', externalCode: 'ALPHA-TBMT-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0b9-000000000001', code: 'BETA-PACKAGE-0001', milestoneId: '00000000-0000-4000-b0b9-000000000002', linkId: '00000000-0000-4000-b0b9-000000000003', externalCode: 'BETA-TBMT-0001' },
};

/** A sealed proposal of the contractor of each tenant on its package, and a declaration of conflict of interest about it (the price and the words of the relation are distinctive; tenant confidential data). */
export const PROPOSAL_FIXTURES: Readonly<Record<TenantName, { id: string; declarationId: string; bidPrice: string; relation: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0ba-000000000001', declarationId: '00000000-0000-4000-a0ba-000000000002', bidPrice: '7771000001', relation: 'ALPHA-CONFLICT-RELATION-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0ba-000000000001', declarationId: '00000000-0000-4000-b0ba-000000000002', bidPrice: '7772000001', relation: 'BETA-CONFLICT-RELATION-0001' },
};

/** A result of the selection of the contractor of each tenant on its package: submitted, with an award price of its own (the price is distinctive; tenant confidential data). */
export const RESULT_FIXTURES: Readonly<Record<TenantName, { id: string; awardPrice: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0bb-000000000001', awardPrice: '8881000001' },
  'TNT-B': { id: '00000000-0000-4000-b0bb-000000000001', awardPrice: '8882000001' },
};

/** An inspection of the draft contract of each tenant (the title is distinctive; tenant data). */
export const INSPECTION_FIXTURES: Readonly<Record<TenantName, { id: string; title: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0ca-000000000001', title: 'ALPHA-INSPECTION-TITLE-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0ca-000000000001', title: 'BETA-INSPECTION-TITLE-0001' },
};

/** A handover of the draft contract of each tenant with one punch item (the number and the description are distinctive; tenant data). */
export const HANDOVER_FIXTURES: Readonly<Record<TenantName, { id: string; itemId: string; handoverNo: string; itemDescription: string; assetId: string; assetCode: string; warrantyId: string; warrantyScope: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0d3-000000000001', itemId: '00000000-0000-4000-a0d3-000000000002', handoverNo: 'ALPHA-HANDOVER-NO-0001', itemDescription: 'ALPHA-PUNCH-ITEM-0001', assetId: '00000000-0000-4000-a0d3-000000000003', assetCode: 'ALPHA-ASSET-CODE-0001', warrantyId: '00000000-0000-4000-a0d3-000000000004', warrantyScope: 'ALPHA-WARRANTY-SCOPE-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0d3-000000000001', itemId: '00000000-0000-4000-b0d3-000000000002', handoverNo: 'BETA-HANDOVER-NO-0001', itemDescription: 'BETA-PUNCH-ITEM-0001', assetId: '00000000-0000-4000-b0d3-000000000003', assetCode: 'BETA-ASSET-CODE-0001', warrantyId: '00000000-0000-4000-b0d3-000000000004', warrantyScope: 'BETA-WARRANTY-SCOPE-0001' },
};

/** A non-conformance of the draft contract of each tenant with one corrective action (the title and the description of the action are distinctive; tenant data). */
export const NONCONFORMANCE_FIXTURES: Readonly<Record<TenantName, { id: string; actionId: string; title: string; actionDescription: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0d2-000000000001', actionId: '00000000-0000-4000-a0d2-000000000002', title: 'ALPHA-NCR-TITLE-0001', actionDescription: 'ALPHA-NCR-ACTION-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0d2-000000000001', actionId: '00000000-0000-4000-b0d2-000000000002', title: 'BETA-NCR-TITLE-0001', actionDescription: 'BETA-NCR-ACTION-0001' },
};

/** An acceptance of work of the draft contract of each tenant (the number is distinctive; tenant financial data). */
export const WORK_ACCEPTANCE_FIXTURES: Readonly<Record<TenantName, { id: string; acceptanceNo: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0cc-000000000001', acceptanceNo: 'ALPHA-WORK-ACCEPTANCE-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0cc-000000000001', acceptanceNo: 'BETA-WORK-ACCEPTANCE-0001' },
};

/** A payment request of the draft contract of each tenant, for an approved acceptance (the number is distinctive; tenant financial data). */
export const PAYMENT_FIXTURES: Readonly<Record<TenantName, { id: string; acceptanceId: string; requestNo: string; holdId: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0ce-000000000001', acceptanceId: '00000000-0000-4000-a0ce-000000000002', requestNo: 'ALPHA-PAYMENT-REQUEST-0001', holdId: '00000000-0000-4000-a0ce-000000000003' },
  'TNT-B': { id: '00000000-0000-4000-b0ce-000000000001', acceptanceId: '00000000-0000-4000-b0ce-000000000002', requestNo: 'BETA-PAYMENT-REQUEST-0001', holdId: '00000000-0000-4000-b0ce-000000000003' },
};

/** An advance of the contract of each tenant (cancelled, so it needs no guarantee of a contract in force) and the member it was to be paid to. */
export const ADVANCE_FIXTURES: Readonly<Record<TenantName, { id: string; partyId: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0cf-000000000001', partyId: '00000000-0000-4000-a0cf-000000000002' },
  'TNT-B': { id: '00000000-0000-4000-b0cf-000000000001', partyId: '00000000-0000-4000-b0cf-000000000002' },
};

/** An item of difference of the project of each tenant, open and with a distinctive note (tenant financial data). */
export const RECONCILIATION_FIXTURES: Readonly<Record<TenantName, { id: string; note: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0d0-000000000001', note: 'ALPHA-RECONCILIATION-NOTE-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0d0-000000000001', note: 'BETA-RECONCILIATION-NOTE-0001' },
};

/** A settlement of the project of each tenant, in DRAFT and with a distinctive note (tenant financial data). */
export const SETTLEMENT_FIXTURES: Readonly<Record<TenantName, { id: string; note: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0d1-000000000001', note: 'ALPHA-SETTLEMENT-NOTE-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0d1-000000000001', note: 'BETA-SETTLEMENT-NOTE-0001' },
};

/** The cumulative ledger of the work acceptance of each tenant, with one entry (the reason is distinctive; tenant financial data). */
export const LEDGER_FIXTURES: Readonly<Record<TenantName, { id: string; entryId: string; entryReason: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0cd-000000000001', entryId: '00000000-0000-4000-a0cd-000000000002', entryReason: 'ALPHA-LEDGER-ENTRY-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0cd-000000000001', entryId: '00000000-0000-4000-b0cd-000000000002', entryReason: 'BETA-LEDGER-ENTRY-0001' },
};

/** Quality acceptance minutes of the inspection of each tenant (the record number is distinctive; tenant data). */
export const ACCEPTANCE_FIXTURES: Readonly<Record<TenantName, { id: string; recordNo: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0cb-000000000001', recordNo: 'ALPHA-ACCEPTANCE-NO-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0cb-000000000001', recordNo: 'BETA-ACCEPTANCE-NO-0001' },
};

/** A petition of the contractor of each tenant on its package, received and waiting for an answer. */
export const PETITION_FIXTURES: Readonly<Record<TenantName, { id: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0bc-000000000001' },
  'TNT-B': { id: '00000000-0000-4000-b0bc-000000000001' },
};

/** A stage of land clearance reported by an external unit, in the section of each tenant (its note is distinctive; tenant data). */
export const STAGE_FIXTURES: Readonly<Record<TenantName, { id: string; note: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0b8-000000000001', note: 'ALPHA-STAGE-BLOCKER-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0b8-000000000001', note: 'BETA-STAGE-BLOCKER-0001' },
};

/** An UNVERIFIED contractor of each tenant (its tax id and its name are distinctive; the tax id is personal data when the contractor is a sole trader). */
export const CONTRACTOR_FIXTURES: Readonly<Record<TenantName, { id: string; taxIdentifier: string; legalName: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0c2-000000000001', taxIdentifier: '0111111111', legalName: 'Alpha tenant isolation contractor' },
  'TNT-B': { id: '00000000-0000-4000-b0c2-000000000001', taxIdentifier: '0122222222', legalName: 'Beta tenant isolation contractor' },
};

/** A DRAFT contract of each tenant under an awarded package, with its first revision (the code and the title are distinctive; tenant financial data). */
export const CONTRACT_FIXTURES: Readonly<Record<TenantName, { id: string; revisionId: string; packageId: string; code: string; title: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0c3-000000000001', revisionId: '00000000-0000-4000-a0c3-000000000002', packageId: '00000000-0000-4000-a0c3-000000000003', code: 'ALPHA-CONTRACT-0001', title: 'Alpha tenant isolation contract' },
  'TNT-B': { id: '00000000-0000-4000-b0c3-000000000001', revisionId: '00000000-0000-4000-b0c3-000000000002', packageId: '00000000-0000-4000-b0c3-000000000003', code: 'BETA-CONTRACT-0001', title: 'Beta tenant isolation contract' },
};

/** The tiers of the chain of changes of the project of each tenant and a change event of its draft contract (the reason is distinctive; tenant financial data). */
export const CHANGE_FIXTURES: Readonly<Record<TenantName, { configId: string; id: string; reason: string }>> = {
  'TNT-A': { configId: '00000000-0000-4000-a0c8-000000000001', id: '00000000-0000-4000-a0c8-000000000002', reason: 'ALPHA-CHANGE-REASON-0001' },
  'TNT-B': { configId: '00000000-0000-4000-b0c8-000000000001', id: '00000000-0000-4000-b0c8-000000000002', reason: 'BETA-CHANGE-REASON-0001' },
};

/** A measurement of the BOQ line of each tenant (the number of the record is distinctive; tenant financial data). */
export const MEASUREMENT_FIXTURES: Readonly<Record<TenantName, { id: string; referenceNo: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0c9-000000000001', referenceNo: 'ALPHA-MEASUREMENT-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0c9-000000000001', referenceNo: 'BETA-MEASUREMENT-0001' },
};

/**
 * A BOQ line of each tenant under that draft revision with its stable item, and two guarantees of the contract (a PENDING_VERIFICATION one and an
 * ACTIVE one), each with a distinctive key, wording, number and issuer (tenant financial data).
 */
export const BOQ_FIXTURES: Readonly<Record<TenantName, { itemId: string; lineId: string; businessKey: string; description: string }>> = {
  'TNT-A': { itemId: '00000000-0000-4000-a0c4-000000000001', lineId: '00000000-0000-4000-a0c4-000000000002', businessKey: 'ALPHA-BOQ-0001', description: 'Alpha tenant isolation BOQ item' },
  'TNT-B': { itemId: '00000000-0000-4000-b0c4-000000000001', lineId: '00000000-0000-4000-b0c4-000000000002', businessKey: 'BETA-BOQ-0001', description: 'Beta tenant isolation BOQ item' },
};

export const GUARANTEE_FIXTURES: Readonly<Record<TenantName, { id: string; activeId: string; guaranteeNo: string; activeGuaranteeNo: string; issuer: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0c5-000000000001', activeId: '00000000-0000-4000-a0c5-000000000002', guaranteeNo: 'ALPHA-GUARANTEE-0001', activeGuaranteeNo: 'ALPHA-GUARANTEE-0002', issuer: 'Alpha isolation issuer bank' },
  'TNT-B': { id: '00000000-0000-4000-b0c5-000000000001', activeId: '00000000-0000-4000-b0c5-000000000002', guaranteeNo: 'BETA-GUARANTEE-0001', activeGuaranteeNo: 'BETA-GUARANTEE-0002', issuer: 'Beta isolation issuer bank' },
};

/** A DRAFT procurement plan of the project of each tenant with one package on the line of capital (the title and the package code are distinctive; tenant financial data). */
export const PROCUREMENT_PLAN_FIXTURES: Readonly<Record<TenantName, { id: string; packageId: string; title: string; packageCode: string; packageTitle: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0c6-000000000001', packageId: '00000000-0000-4000-a0c6-000000000002', title: 'Alpha tenant isolation procurement plan', packageCode: 'ALPHA-PKG-0001', packageTitle: 'Alpha tenant isolation package' },
  'TNT-B': { id: '00000000-0000-4000-b0c6-000000000001', packageId: '00000000-0000-4000-b0c6-000000000002', title: 'Beta tenant isolation procurement plan', packageCode: 'BETA-PKG-0001', packageTitle: 'Beta tenant isolation package' },
};

/** The criteria of the package of that plan: a version in force (revision 1) and a draft after it (revision 2); the name of the criterion and the legal basis are distinctive (tenant procurement rules). */
export const CRITERIA_FIXTURES: Readonly<Record<TenantName, { approvedId: string; draftId: string; criterionName: string; legalBasis: string }>> = {
  'TNT-A': { approvedId: '00000000-0000-4000-a0c7-000000000001', draftId: '00000000-0000-4000-a0c7-000000000002', criterionName: 'Alpha tenant isolation criterion', legalBasis: 'Alpha tenant isolation criteria basis' },
  'TNT-B': { approvedId: '00000000-0000-4000-b0c7-000000000001', draftId: '00000000-0000-4000-b0c7-000000000002', criterionName: 'Beta tenant isolation criterion', legalBasis: 'Beta tenant isolation criteria basis' },
};

/** A dataset of the catalogue of each tenant (its code and its title are distinctive; tenant data). */
export const DATASET_FIXTURES: Readonly<Record<TenantName, { id: string; datasetCode: string; title: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0d1-000000000001', datasetCode: 'ALPHA-DATASET-0001', title: 'Alpha tenant isolation dataset' },
  'TNT-B': { id: '00000000-0000-4000-b0d1-000000000001', datasetCode: 'BETA-DATASET-0001', title: 'Beta tenant isolation dataset' },
};

/** A working contract of the dataset above, a DRAFT quality rule of it and a finished quality run (their codes are distinctive; tenant configuration and results). */
export const QUALITY_FIXTURES: Readonly<Record<TenantName, { contractId: string; ruleId: string; ruleCode: string; runId: string }>> = {
  'TNT-A': { contractId: '00000000-0000-4000-a0d2-000000000001', ruleId: '00000000-0000-4000-a0d2-000000000002', ruleCode: 'ALPHA-QUALITY-RULE-0001', runId: '00000000-0000-4000-a0d2-000000000003' },
  'TNT-B': { contractId: '00000000-0000-4000-b0d2-000000000001', ruleId: '00000000-0000-4000-b0d2-000000000002', ruleCode: 'BETA-QUALITY-RULE-0001', runId: '00000000-0000-4000-b0d2-000000000003' },
};

/** An ACTIVE SLA policy of each tenant (its code is distinctive; tenant configuration). */
export const SLA_POLICY_FIXTURES: Readonly<Record<TenantName, { id: string; code: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0e1-000000000001', code: 'ALPHA-SLA-POLICY-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0e1-000000000001', code: 'BETA-SLA-POLICY-0001' },
};

/** An OPEN issue of each tenant under that policy (its code and its title are distinctive; tenant data, and its description names no one). */
export const ISSUE_FIXTURES: Readonly<Record<TenantName, { id: string; code: string; title: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0e2-000000000001', code: 'VM-2026-770001', title: 'Alpha tenant isolation issue 0001' },
  'TNT-B': { id: '00000000-0000-4000-b0e2-000000000001', code: 'VM-2026-770002', title: 'Beta tenant isolation issue 0001' },
};

/** An open escalation to the unit of the isolation issue of each tenant (ST-ISS-004; the escalation names ids and a reason code, no text). */
export const ESCALATION_FIXTURES: Readonly<Record<TenantName, { id: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0e3-000000000001' },
  'TNT-B': { id: '00000000-0000-4000-b0e3-000000000001' },
};

/** A Treasury statement import of each tenant with the transaction it created (the file hash and the voucher number are distinctive; tenant financial data). */
export const TREASURY_FIXTURES: Readonly<Record<TenantName, { importId: string; fileSha256: string; transactionId: string; documentNo: string; externalId: string }>> = {
  'TNT-A': { importId: '00000000-0000-4000-a0aa-000000000001', fileSha256: 'a7'.repeat(32), transactionId: '00000000-0000-4000-a0aa-000000000002', documentNo: 'ALPHA-VOUCHER-0001', externalId: 'KBNN_FILE|ALPHA-VOUCHER-0001|2026-10-15|ALPHA-PROJECT' },
  'TNT-B': { importId: '00000000-0000-4000-b0aa-000000000001', fileSha256: 'b8'.repeat(32), transactionId: '00000000-0000-4000-b0aa-000000000002', documentNo: 'BETA-VOUCHER-0001', externalId: 'KBNN_FILE|BETA-VOUCHER-0001|2026-10-15|BETA-PROJECT' },
};

/** A live subscription of each tenant (the contract reference is distinctive; tenant commercial data). */
export const SUBSCRIPTION_FIXTURES: Readonly<Record<TenantName, { id: string; contractRef: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0ac-000000000001', contractRef: 'ALPHA-PROCUREMENT-CONTRACT-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0ac-000000000001', contractRef: 'BETA-PROCUREMENT-CONTRACT-0001' },
};

/** A usage event of each tenant (the key and the source are distinctive; tenant usage data, the record a tenant is billed from). */
export const USAGE_FIXTURES: Readonly<Record<TenantName, { id: string; externalKey: string; sourceReference: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0ab-000000000001', externalKey: 'alpha-usage-event-0001', sourceReference: 'alpha-campaign-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0ab-000000000001', externalKey: 'beta-usage-event-0001', sourceReference: 'beta-campaign-0001' },
};

/** A PUBLISHED permit type version of each tenant, still waiting for its legal confirmation (the code and the legal basis are distinctive; tenant legal data). */
export const PERMIT_TYPE_FIXTURES: Readonly<Record<TenantName, { id: string; code: string; legalBasis: string; gateRuleId: string; gateBasis: string }>> = {
  'TNT-A': {
    id: '00000000-0000-4000-a0f1-000000000001',
    code: 'ALPHA_PERMIT_0001',
    legalBasis: 'Alpha tenant permit regulation 0001',
    gateRuleId: '00000000-0000-4000-a0f1-000000000002',
    gateBasis: 'Alpha tenant gate regulation 0001',
  },
  'TNT-B': {
    id: '00000000-0000-4000-b0f1-000000000001',
    code: 'BETA_PERMIT_0001',
    legalBasis: 'Beta tenant permit regulation 0001',
    gateRuleId: '00000000-0000-4000-b0f1-000000000002',
    gateBasis: 'Beta tenant gate regulation 0001',
  },
};

/** A support ticket of the isolation member in each tenant (the subject is distinctive; tenant data of a person). */
export const TICKET_FIXTURES: Readonly<Record<TenantName, { id: string; code: string; subject: string; description: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0f3-000000000001', code: 'SUP-2026-900001', subject: 'Alpha tenant isolation support ticket', description: 'Alpha tenant isolation ticket description' },
  'TNT-B': { id: '00000000-0000-4000-b0f3-000000000001', code: 'SUP-2026-900002', subject: 'Beta tenant isolation support ticket', description: 'Beta tenant isolation ticket description' },
};

/** An ACTIVE waiver of the HANDOVER gate of the isolation project of each tenant (the reason is distinctive; tenant legal decision). */
export const WAIVER_FIXTURES: Readonly<Record<TenantName, { id: string; reason: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0f2-000000000001', reason: 'Alpha tenant isolation waiver reason' },
  'TNT-B': { id: '00000000-0000-4000-b0f2-000000000001', reason: 'Beta tenant isolation waiver reason' },
};

/** The permit dossier of the isolation project of each tenant and a permit in appraisal in it (the authority is distinctive; tenant legal file). */
export const PERMIT_FIXTURES: Readonly<Record<TenantName, { dossierId: string; permitId: string; authority: string; expiredId: string; expiredNo: string }>> = {
  'TNT-A': {
    dossierId: '00000000-0000-4000-a0f3-000000000001',
    permitId: '00000000-0000-4000-a0f3-000000000002',
    authority: 'Alpha tenant permit authority 0001',
    expiredId: '00000000-0000-4000-a0f3-000000000003',
    expiredNo: 'ALPHA-EXPIRED-GP-0001',
  },
  'TNT-B': {
    dossierId: '00000000-0000-4000-b0f3-000000000001',
    permitId: '00000000-0000-4000-b0f3-000000000002',
    authority: 'Beta tenant permit authority 0001',
    expiredId: '00000000-0000-4000-b0f3-000000000003',
    expiredNo: 'BETA-EXPIRED-GP-0001',
  },
};

/** An OPEN reporting period of each tenant, past its deadline (the code is distinctive; the calendar of reporting is tenant configuration). */
export const PERIOD_FIXTURES: Readonly<Record<TenantName, { id: string; code: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0b5-000000000001', code: 'ALPHA-PERIOD-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0b5-000000000001', code: 'BETA-PERIOD-0001' },
};

/** The reporting calendar each period of the fixtures is bound to: a period is judged late by the version it was generated from, so a send needs that version to exist. */
export const PERIOD_CALENDAR_FIXTURES: Readonly<Record<TenantName, { recordId: string; versionId: string }>> = {
  'TNT-A': { recordId: '00000000-0000-4000-a0b5-000000000002', versionId: '00000000-0000-4000-a0b5-000000000003' },
  'TNT-B': { recordId: '00000000-0000-4000-b0b5-000000000002', versionId: '00000000-0000-4000-b0b5-000000000003' },
};

/** A LOCKED reporting period of each tenant and a request to reopen it that waits for a decision (the reason of the request is distinctive: it is internal to the tenant). */
export const REOPEN_FIXTURES: Readonly<Record<TenantName, { periodId: string; periodCode: string; id: string; reason: string }>> = {
  'TNT-A': { periodId: '00000000-0000-4000-a0b6-000000000001', periodCode: 'ALPHA-PERIOD-0002', id: '00000000-0000-4000-a0b7-000000000001', reason: 'Alpha tenant request to reopen the locked period 0001' },
  'TNT-B': { periodId: '00000000-0000-4000-b0b6-000000000001', periodCode: 'BETA-PERIOD-0002', id: '00000000-0000-4000-b0b7-000000000001', reason: 'Beta tenant request to reopen the locked period 0001' },
};

/** A DRAFT weekly report of the project of each tenant in its open period (the hash of the content is distinctive: the figures of a report are internal to the tenant). */
export const REPORT_FIXTURES: Readonly<Record<TenantName, { id: string; lineId: string; payloadHash: string; cumulativeVnd: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0fb-000000000001', lineId: '00000000-0000-4000-a0fb-000000000002', payloadHash: 'a0fb'.repeat(16), cumulativeVnd: '7300001' },
  'TNT-B': { id: '00000000-0000-4000-b0fb-000000000001', lineId: '00000000-0000-4000-b0fb-000000000002', payloadHash: 'b0fb'.repeat(16), cumulativeVnd: '9100002' },
};

/** A bulk import of weekly reports of each tenant that has errors (a dry run: it is read, and it cannot be applied), on the period of the fixtures (its file hash is distinctive: what a tenant imports is internal to it). */
export const REPORT_IMPORT_FIXTURES: Readonly<Record<TenantName, { id: string; fileSha256: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0fe-000000000001', fileSha256: 'a0fe'.repeat(16) },
  'TNT-B': { id: '00000000-0000-4000-b0fe-000000000001', fileSha256: 'b0fe'.repeat(16) },
};

/** A DRAFT appropriation of each tenant (its issuing authority is distinctive; the amount of capital assigned to a tenant is confidential). */
export const APPROPRIATION_FIXTURES: Readonly<Record<TenantName, { id: string; issuingAuthority: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0f2-000000000001', issuingAuthority: 'Alpha tenant assigning authority 0001' },
  'TNT-B': { id: '00000000-0000-4000-b0f2-000000000001', issuingAuthority: 'Beta tenant assigning authority 0001' },
};

/**
 * A DRAFT capital plan of each tenant with one line of its project on its appropriation (the code is distinctive: the plan of a tenant is internal
 * to it), and a plan of another code that is PUBLISHED, which is the one that can be read as of a date and revised.
 */
export const CAPITAL_PLAN_FIXTURES: Readonly<Record<TenantName, { id: string; planCode: string; versionId: string; lineId: string; publishedId: string; publishedCode: string }>> = {
  'TNT-A': {
    id: '00000000-0000-4000-a0f8-000000000001',
    planCode: 'ALPHA-CAPITAL-PLAN-0001',
    versionId: '00000000-0000-4000-a0f8-000000000002',
    lineId: '00000000-0000-4000-a0f8-000000000003',
    publishedId: '00000000-0000-4000-a0f8-000000000004',
    publishedCode: 'ALPHA-CAPITAL-PLAN-0002',
  },
  'TNT-B': {
    id: '00000000-0000-4000-b0f8-000000000001',
    planCode: 'BETA-CAPITAL-PLAN-0001',
    versionId: '00000000-0000-4000-b0f8-000000000002',
    lineId: '00000000-0000-4000-b0f8-000000000003',
    publishedId: '00000000-0000-4000-b0f8-000000000004',
    publishedCode: 'BETA-CAPITAL-PLAN-0002',
  },
};

/** A forecast of each tenant's project for a month of 2026 (the assumption is distinctive: the schedule of a tenant is internal to it). */
export const SCHEDULE_FIXTURES: Readonly<Record<TenantName, { id: string; assumption: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0fa-000000000001', assumption: 'Alpha forecast assumption 0001' },
  'TNT-B': { id: '00000000-0000-4000-b0fa-000000000001', assumption: 'Beta forecast assumption 0001' },
};

/** A published template revision of each tenant, waiting for its legal confirmation (the code and the legal basis are distinctive). */
export const TEMPLATE_FIXTURES: Readonly<Record<TenantName, { id: string; templateCode: string; legalBasis: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a013-000000000001', templateCode: 'ALPHA-TEMPLATE-0001', legalBasis: 'Alpha decree 0001/2026 on the shape of the alpha form' },
  'TNT-B': { id: '00000000-0000-4000-b013-000000000001', templateCode: 'BETA-TEMPLATE-0001', legalBasis: 'Beta circular 0001/2026 on the shape of the beta form' },
};

/** A published report form, an obligation rule of it and the obligation (report shell) generated from them, per tenant (the codes and the legal text are distinctive). */
export const MNE_FIXTURES: Readonly<Record<TenantName, { formId: string; formCode: string; formLegalBasis: string; ruleId: string; ruleCode: string; ruleRecipient: string; reportId: string }>> = {
  'TNT-A': {
    formId: '00000000-0000-4000-a0d6-000000000001',
    formCode: 'ALPHA-FORM-0001',
    formLegalBasis: 'Alpha circular 0001/2026 on the alpha monitoring form',
    ruleId: '00000000-0000-4000-a0d6-000000000002',
    ruleCode: 'ALPHA-RULE-0001',
    ruleRecipient: 'Alpha recipient agency 0001',
    reportId: '00000000-0000-4000-a0d6-000000000003',
  },
  'TNT-B': {
    formId: '00000000-0000-4000-b0d6-000000000001',
    formCode: 'BETA-FORM-0001',
    formLegalBasis: 'Beta circular 0001/2026 on the beta monitoring form',
    ruleId: '00000000-0000-4000-b0d6-000000000002',
    ruleCode: 'BETA-RULE-0001',
    ruleRecipient: 'Beta recipient agency 0001',
    reportId: '00000000-0000-4000-b0d6-000000000003',
  },
};

/** An Active signing certificate of each tenant (its fingerprint and serial are distinctive; tenant administration data). */
export const CERTIFICATE_FIXTURES: Readonly<Record<TenantName, { id: string; fingerprint: string; serial: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a00e-000000000001', fingerprint: 'a1'.repeat(32), serial: 'ALPHA0C0E71F' },
  'TNT-B': { id: '00000000-0000-4000-b00e-000000000001', fingerprint: 'b2'.repeat(32), serial: 'BETA00C0E71F' },
};

/** A security policy draft of each tenant (the allowlist address is distinctive). */
export const POLICY_FIXTURES: Readonly<Record<TenantName, { id: string; address: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a00f-000000000001', address: '198.51.100.11' },
  'TNT-B': { id: '00000000-0000-4000-b00f-000000000001', address: '203.0.113.222' },
};

/** A working calendar draft of each tenant (the calendar code and the legal basis are distinctive; PUBLIC data of the tenant, still tenant-bound). */
export const WORK_CALENDAR_FIXTURES: Readonly<Record<TenantName, { id: string; calendarCode: string; legalBasis: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0c1-000000000001', calendarCode: 'ALPHA-CAL-0001', legalBasis: 'Alpha tenant calendar notice 0001' },
  'TNT-B': { id: '00000000-0000-4000-b0c1-000000000001', calendarCode: 'BETA-CAL-0001', legalBasis: 'Beta tenant calendar notice 0001' },
};

/** An availability control policy draft of each tenant (the code and the legal basis are distinctive). */
export const AVC_POLICY_FIXTURES: Readonly<Record<TenantName, { id: string; policyCode: string; legalBasis: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0c3-000000000001', policyCode: 'ALPHA-AVC-0001', legalBasis: 'Alpha capital control resolution 0001/2026' },
  'TNT-B': { id: '00000000-0000-4000-b0c3-000000000001', policyCode: 'BETA-AVC-0001', legalBasis: 'Beta capital control resolution 0001/2026' },
};

/** A request to carry capital over to the next year of each tenant, on the line of its capital plan (the justification is distinctive). */
export const EXTENSION_FIXTURES: Readonly<Record<TenantName, { id: string; justification: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0d9-000000000001', justification: 'Alpha carry-over justification 0001 for the isolation suite' },
  'TNT-B': { id: '00000000-0000-4000-b0d9-000000000001', justification: 'Beta carry-over justification 0001 for the isolation suite' },
};

/** A soft-closed fiscal year of each tenant (the reason of the closing is distinctive). */
export const FISCAL_YEAR_FIXTURES: Readonly<Record<TenantName, { year: number; reason: string }>> = {
  'TNT-A': { year: 2012, reason: 'Alpha year-close note 0001 for the isolation suite' },
  'TNT-B': { year: 2013, reason: 'Beta year-close note 0001 for the isolation suite' },
};

/** A delegation-of-authority matrix draft of each tenant (the legal basis and the document type of its rule are distinctive). */
export const DOA_FIXTURES: Readonly<Record<TenantName, { id: string; legalBasis: string; documentType: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0c2-000000000001', legalBasis: 'Alpha tenant approval regulation 0001', documentType: 'ALPHA-DOC-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0c2-000000000001', legalBasis: 'Beta tenant approval regulation 0001', documentType: 'BETA-DOC-0001' },
};

/** A retention policy draft of each tenant (the record class and the legal basis are distinctive; tenant administration data). */
export const RETENTION_FIXTURES: Readonly<Record<TenantName, { id: string; reviewId: string; recordClass: string; legalBasis: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0a2-000000000001', reviewId: '00000000-0000-4000-a0a2-000000000002', recordClass: 'alpha_isolation_dossier', legalBasis: 'Alpha archives circular 0001/2026' },
  'TNT-B': { id: '00000000-0000-4000-b0a2-000000000001', reviewId: '00000000-0000-4000-b0a2-000000000002', recordClass: 'beta_isolation_dossier', legalBasis: 'Beta archives circular 0001/2026' },
};

/** A failed delivery attempt of the notification fixture of each tenant, with the channel account and template it names (the provider message id is the provider's reference and must not reach another tenant). */
export const DELIVERY_ATTEMPT_FIXTURES: Readonly<Record<TenantName, { id: string; accountId: string; templateId: string; providerMessageId: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0a4-000000000001', accountId: '00000000-0000-4000-a0a4-000000000002', templateId: '00000000-0000-4000-a0a4-000000000003', providerMessageId: 'alpha-provider-message-0001' },
  'TNT-B': { id: '00000000-0000-4000-b0a4-000000000001', accountId: '00000000-0000-4000-b0a4-000000000002', templateId: '00000000-0000-4000-b0a4-000000000003', providerMessageId: 'beta-provider-message-0001' },
};

/** A draft integration connector and a failed inbox event of each tenant (the code, the endpoint and the event key are distinctive; the payload reference must never be shown). */
export const INTEGRATION_FIXTURES: Readonly<Record<TenantName, { connectorId: string; connectorCode: string; endpoint: string; eventId: string; eventKey: string; payloadReference: string }>> = {
  'TNT-A': {
    connectorId: '00000000-0000-4000-a0a3-000000000001',
    connectorCode: 'alpha-treasury-file',
    endpoint: 'https://alpha-treasury.example.invalid/outbox',
    eventId: '00000000-0000-4000-a0a3-000000000002',
    eventKey: 'alpha-event-key-0001',
    payloadReference: 'tenants/00000000-0000-4000-8000-00000000000a/webhook/alpha-secret-payload-0001',
  },
  'TNT-B': {
    connectorId: '00000000-0000-4000-b0a3-000000000001',
    connectorCode: 'beta-treasury-file',
    endpoint: 'https://beta-treasury.example.invalid/outbox',
    eventId: '00000000-0000-4000-b0a3-000000000002',
    eventKey: 'beta-event-key-0001',
    payloadReference: 'tenants/00000000-0000-4000-8000-00000000000b/webhook/beta-secret-payload-0001',
  },
};

/** A number register and a stored document version of each tenant (the register code and the object key are distinctive). */
export const DOCUMENT_FIXTURES: Readonly<
  Record<TenantName, { registerId: string; registerCode: string; documentId: string; versionId: string; objectKey: string; layoutProfileId: string; outgoingId: string; sessionId: string; distributionId: string }>
> = {
  'TNT-A': {
    registerId: '00000000-0000-4000-a00b-000000000001',
    registerCode: 'ALPHA-REGISTER-0001',
    documentId: '00000000-0000-4000-a00c-000000000001',
    versionId: '00000000-0000-4000-a00d-000000000001',
    objectKey: 'tenants/00000000-0000-4000-8000-00000000000a/documents/alpha-isolation-fixture.pdf',
    layoutProfileId: '00000000-0000-4000-a011-000000000001',
    outgoingId: '00000000-0000-4000-a012-000000000001',
    sessionId: '00000000-0000-4000-a013-000000000001',
    distributionId: '00000000-0000-4000-a014-000000000001',
  },
  'TNT-B': {
    registerId: '00000000-0000-4000-b00b-000000000001',
    registerCode: 'BETA-SECRET-REGISTER-0001',
    documentId: '00000000-0000-4000-b00c-000000000001',
    versionId: '00000000-0000-4000-b00d-000000000001',
    objectKey: 'tenants/00000000-0000-4000-8000-00000000000b/documents/beta-secret-isolation-fixture.pdf',
    layoutProfileId: '00000000-0000-4000-b011-000000000001',
    outgoingId: '00000000-0000-4000-b012-000000000001',
    sessionId: '00000000-0000-4000-b013-000000000001',
    distributionId: '00000000-0000-4000-b014-000000000001',
  },
};

/** An audit event of each tenant (planted by the seed; the trail itself is append-only). */
export const AUDIT_EVENT_FIXTURES: Readonly<Record<TenantName, { id: string; action: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a00a-000000000001', action: 'isolation.alpha.fixture' },
  'TNT-B': { id: '00000000-0000-4000-b00a-000000000001', action: 'isolation.beta.secret.fixture' },
};

/** The outcome of one request of a TNT-A user against a TNT-B object, of any operation and method. */
export interface ForeignAttempt {
  operation: string;
  status: number;
  body: string;
  /** The statuses that count as a safe answer: 404 unless the tenant plane has no business there at all (a control-plane operation: 403, or 404 where it is not registered). */
  expectedStatuses?: readonly number[];
  /** The answer must be an empty page (200 with an empty `items` list): an attempt that is refused and yields nothing. */
  mustBeEmpty?: boolean;
}

/**
 * One way of reading another tenant's data (API, database, later search, file, export, sync).
 * `readAs` makes the user of tenant `user` request the first organization unit of tenant `target`.
 * `listAs`, when present, lists every organization unit the user can see.
 */
export interface IsolationChannel {
  name: string;
  /**
   * What a safe answer to the foreign read looks like: `not-found` (the default) is 404; `empty` is for channels with no
   * single object to be missing (search, export): 200 with an empty `items` list, which must not differ in any way that
   * shows the hidden match.
   */
  foreignReadOutcome?: 'not-found' | 'empty';
  seed(tenant: TenantName): Promise<void>;
  readAs(user: 'TNT-A', target: 'TNT-B'): Promise<{ status: number; body: string }>;
  listAs?(user: 'TNT-A'): Promise<{ status: number; body: string }>;
  /**
   * Every id-bearing operation beyond the unit read (reads of other resources and all commands) aimed by `user`
   * at a TNT-B object it can name. Each must answer 404 and leave TNT-B untouched.
   */
  foreignAttempts?(user: 'TNT-A'): Promise<ForeignAttempt[]>;
}

export interface IsolationSuiteInput {
  channels: readonly IsolationChannel[];
  /** Implemented operations with a path parameter (see enumerateIdBearingOperations). */
  idBearingOperations: readonly string[];
  /** Operations that have a registered foreign-id case. */
  foreignIdCases: ReadonlySet<string>;
  /** A fingerprint of everything the suite seeded for a tenant; foreign attempts must not change TNT-B's. */
  snapshot?: (tenant: TenantName) => Promise<string>;
}

export interface IsolationReport {
  ok: boolean;
  /** Human-readable violations; they name the channel and the kind of data, never the data. */
  leaks: string[];
  /** Implemented id-bearing operations without a registered foreign-id case. */
  uncoveredOperations: string[];
}

/** Everything that identifies a tenant's data in a response body, grouped by kind. */
function markersOf(tenant: TenantName): Array<{ kind: string; value: string }> {
  const markers = [
    { kind: 'tenant id', value: TENANT_IDS[tenant] },
    { kind: 'role id', value: ROLE_FIXTURES[tenant].id },
    { kind: 'role code', value: ROLE_FIXTURES[tenant].code },
    { kind: 'role name', value: ROLE_FIXTURES[tenant].name },
    { kind: 'grant id', value: GRANT_FIXTURES[tenant].id },
    { kind: 'notification id', value: NOTIFICATION_FIXTURES[tenant].id },
    { kind: 'consent id', value: CONSENT_FIXTURES[tenant].id },
    { kind: 'delivery attempt id', value: DELIVERY_ATTEMPT_FIXTURES[tenant].id },
    { kind: 'delivery provider message id', value: DELIVERY_ATTEMPT_FIXTURES[tenant].providerMessageId },
    { kind: 'legal hold id', value: LEGAL_HOLD_FIXTURES[tenant].id },
    { kind: 'certificate id', value: CERTIFICATE_FIXTURES[tenant].id },
    { kind: 'certificate fingerprint', value: CERTIFICATE_FIXTURES[tenant].fingerprint },
    { kind: 'certificate serial', value: CERTIFICATE_FIXTURES[tenant].serial },
    { kind: 'security policy id', value: POLICY_FIXTURES[tenant].id },
    { kind: 'master record id', value: MASTER_FIXTURES[tenant].recordId },
    { kind: 'master version id', value: MASTER_FIXTURES[tenant].versionId },
    { kind: 'master change request id', value: MASTER_FIXTURES[tenant].changeId },
    { kind: 'master business key', value: MASTER_FIXTURES[tenant].businessKey },
    { kind: 'master label', value: MASTER_FIXTURES[tenant].label },
    { kind: 'master import id', value: MASTER_IMPORT_FIXTURES[tenant].id },
    { kind: 'master import file hash', value: MASTER_IMPORT_FIXTURES[tenant].fileSha256 },
    { kind: 'master import object key', value: MASTER_IMPORT_FIXTURES[tenant].fileObjectKey },
    { kind: 'crosswalk id', value: CROSSWALK_FIXTURES[tenant].crosswalkId },
    { kind: 'crosswalk external code', value: CROSSWALK_FIXTURES[tenant].externalCode },
    { kind: 'integration cursor id', value: CROSSWALK_FIXTURES[tenant].cursorId },
    { kind: 'integration cursor scope', value: CROSSWALK_FIXTURES[tenant].sourceScope },
    { kind: 'integration cursor file hash', value: CROSSWALK_FIXTURES[tenant].fileSha256 },
    { kind: 'treasury import id', value: TREASURY_FIXTURES[tenant].importId },
    { kind: 'treasury import file hash', value: TREASURY_FIXTURES[tenant].fileSha256 },
    { kind: 'treasury transaction id', value: TREASURY_FIXTURES[tenant].transactionId },
    { kind: 'treasury voucher number', value: TREASURY_FIXTURES[tenant].documentNo },
    { kind: 'subscription id', value: SUBSCRIPTION_FIXTURES[tenant].id },
    { kind: 'subscription contract reference', value: SUBSCRIPTION_FIXTURES[tenant].contractRef },
    { kind: 'usage event id', value: USAGE_FIXTURES[tenant].id },
    { kind: 'usage event key', value: USAGE_FIXTURES[tenant].externalKey },
    { kind: 'usage event source', value: USAGE_FIXTURES[tenant].sourceReference },
    { kind: 'template id', value: TEMPLATE_FIXTURES[tenant].id },
    { kind: 'template code', value: TEMPLATE_FIXTURES[tenant].templateCode },
    { kind: 'template legal basis', value: TEMPLATE_FIXTURES[tenant].legalBasis },
    { kind: 'report form id', value: MNE_FIXTURES[tenant].formId },
    { kind: 'report form code', value: MNE_FIXTURES[tenant].formCode },
    { kind: 'report form legal basis', value: MNE_FIXTURES[tenant].formLegalBasis },
    { kind: 'obligation rule id', value: MNE_FIXTURES[tenant].ruleId },
    { kind: 'obligation rule code', value: MNE_FIXTURES[tenant].ruleCode },
    { kind: 'obligation rule recipient', value: MNE_FIXTURES[tenant].ruleRecipient },
    { kind: 'obligation report id', value: MNE_FIXTURES[tenant].reportId },
    { kind: 'glossary term id', value: GLOSSARY_FIXTURES[tenant].termId },
    { kind: 'glossary term code', value: GLOSSARY_FIXTURES[tenant].termCode },
    { kind: 'glossary term definition', value: GLOSSARY_FIXTURES[tenant].definition },
    { kind: 'project id', value: PROJECT_FIXTURES[tenant].id },
    { kind: 'project code', value: PROJECT_FIXTURES[tenant].code },
    { kind: 'project name', value: PROJECT_FIXTURES[tenant].name },
    { kind: 'land parcel id', value: PARCEL_FIXTURES[tenant].id },
    { kind: 'land parcel code', value: PARCEL_FIXTURES[tenant].code },
    { kind: 'household id', value: HOUSEHOLD_FIXTURES[tenant].id },
    { kind: 'inventory record id', value: INVENTORY_FIXTURES[tenant].id },
    { kind: 'compensation plan id', value: PLAN_COMP_FIXTURES[tenant].id },
    { kind: 'compensation plan item id', value: PLAN_COMP_FIXTURES[tenant].itemId },
    { kind: 'compensation plan code', value: PLAN_COMP_FIXTURES[tenant].code },
    { kind: 'compensation payment id', value: PAYMENT_COMP_FIXTURES[tenant].id },
    { kind: 'audit engagement id', value: ENGAGEMENT_FIXTURES[tenant].id },
    { kind: 'audit engagement code', value: ENGAGEMENT_FIXTURES[tenant].code },
    { kind: 'audit engagement title', value: ENGAGEMENT_FIXTURES[tenant].title },
    { kind: 'audit conclusion id', value: CONCLUSION_FIXTURES[tenant].id },
    { kind: 'audit conclusion summary', value: CONCLUSION_FIXTURES[tenant].summary },
    { kind: 'audit finding id', value: CONCLUSION_FIXTURES[tenant].findingId },
    { kind: 'audit finding code', value: CONCLUSION_FIXTURES[tenant].findingCode },
    { kind: 'audit finding words', value: CONCLUSION_FIXTURES[tenant].findingWords },
    { kind: 'audit recommendation id', value: CONCLUSION_FIXTURES[tenant].recommendationId },
    { kind: 'audit recommendation code', value: CONCLUSION_FIXTURES[tenant].recCode },
    { kind: 'audit recommendation words', value: CONCLUSION_FIXTURES[tenant].recWords },
    { kind: 'audit action id', value: CONCLUSION_FIXTURES[tenant].actionId },
    { kind: 'audit action code', value: CONCLUSION_FIXTURES[tenant].actionCode },
    { kind: 'audit action words', value: CONCLUSION_FIXTURES[tenant].actionWords },
    { kind: 'audit recovery link id', value: CONCLUSION_FIXTURES[tenant].linkId },
    { kind: 'audit recovery source id', value: CONCLUSION_FIXTURES[tenant].linkSourceId },
    { kind: 'audit follow-up report id', value: CONCLUSION_FIXTURES[tenant].reportId },
    { kind: 'audit follow-up report hash', value: CONCLUSION_FIXTURES[tenant].reportSha256 },
    { kind: 'land complaint id', value: COMPLAINT_FIXTURES[tenant].id },
    { kind: 'land complaint number', value: COMPLAINT_FIXTURES[tenant].number },
    { kind: 'land complaint words', value: COMPLAINT_FIXTURES[tenant].words },
    { kind: 'inventory price decision', value: INVENTORY_FIXTURES[tenant].priceDecision },
    { kind: 'household code', value: HOUSEHOLD_FIXTURES[tenant].code },
    { kind: 'land section id', value: SECTION_FIXTURES[tenant].id },
    { kind: 'land section code', value: SECTION_FIXTURES[tenant].code },
    { kind: 'land stage id', value: STAGE_FIXTURES[tenant].id },
    { kind: 'procurement package id', value: PACKAGE_FIXTURES[tenant].id },
    { kind: 'procurement package code', value: PACKAGE_FIXTURES[tenant].code },
    { kind: 'procurement external code', value: PACKAGE_FIXTURES[tenant].externalCode },
    { kind: 'land stage note', value: STAGE_FIXTURES[tenant].note },
    { kind: 'proposal id', value: PROPOSAL_FIXTURES[tenant].id },
    { kind: 'proposal bid price', value: PROPOSAL_FIXTURES[tenant].bidPrice },
    { kind: 'conflict declaration id', value: PROPOSAL_FIXTURES[tenant].declarationId },
    { kind: 'conflict relation text', value: PROPOSAL_FIXTURES[tenant].relation },
    { kind: 'procurement result id', value: RESULT_FIXTURES[tenant].id },
    { kind: 'procurement petition id', value: PETITION_FIXTURES[tenant].id },
    { kind: 'procurement result award price', value: RESULT_FIXTURES[tenant].awardPrice },
    { kind: 'assignment id', value: ACCOUNTABILITY_FIXTURES[tenant].assignmentId },
    { kind: 'task force id', value: ACCOUNTABILITY_FIXTURES[tenant].taskForceId },
    { kind: 'task force code', value: ACCOUNTABILITY_FIXTURES[tenant].taskForceCode },
    { kind: 'task force name', value: ACCOUNTABILITY_FIXTURES[tenant].taskForceName },
    { kind: 'contractor id', value: CONTRACTOR_FIXTURES[tenant].id },
    { kind: 'contractor tax id', value: CONTRACTOR_FIXTURES[tenant].taxIdentifier },
    { kind: 'contractor name', value: CONTRACTOR_FIXTURES[tenant].legalName },
    { kind: 'contract id', value: CONTRACT_FIXTURES[tenant].id },
    { kind: 'contract revision id', value: CONTRACT_FIXTURES[tenant].revisionId },
    { kind: 'contract code', value: CONTRACT_FIXTURES[tenant].code },
    { kind: 'contract title', value: CONTRACT_FIXTURES[tenant].title },
    { kind: 'change chain config id', value: CHANGE_FIXTURES[tenant].configId },
    { kind: 'change request id', value: CHANGE_FIXTURES[tenant].id },
    { kind: 'change request reason', value: CHANGE_FIXTURES[tenant].reason },
    { kind: 'measurement id', value: MEASUREMENT_FIXTURES[tenant].id },
    { kind: 'work acceptance id', value: WORK_ACCEPTANCE_FIXTURES[tenant].id },
    { kind: 'work acceptance number', value: WORK_ACCEPTANCE_FIXTURES[tenant].acceptanceNo },
    { kind: 'payment request id', value: PAYMENT_FIXTURES[tenant].id },
    { kind: 'retention hold id', value: PAYMENT_FIXTURES[tenant].holdId },
    { kind: 'payment request number', value: PAYMENT_FIXTURES[tenant].requestNo },
    { kind: 'advance id', value: ADVANCE_FIXTURES[tenant].id },
    { kind: 'reconciliation item id', value: RECONCILIATION_FIXTURES[tenant].id },
    { kind: 'reconciliation item note', value: RECONCILIATION_FIXTURES[tenant].note },
    { kind: 'settlement id', value: SETTLEMENT_FIXTURES[tenant].id },
    { kind: 'settlement note', value: SETTLEMENT_FIXTURES[tenant].note },
    { kind: 'cumulative ledger id', value: LEDGER_FIXTURES[tenant].id },
    { kind: 'cumulative ledger entry id', value: LEDGER_FIXTURES[tenant].entryId },
    { kind: 'cumulative ledger entry reason', value: LEDGER_FIXTURES[tenant].entryReason },
    { kind: 'inspection id', value: INSPECTION_FIXTURES[tenant].id },
    { kind: 'inspection title', value: INSPECTION_FIXTURES[tenant].title },
    { kind: 'handover id', value: HANDOVER_FIXTURES[tenant].id },
    { kind: 'handover number', value: HANDOVER_FIXTURES[tenant].handoverNo },
    { kind: 'punch item id', value: HANDOVER_FIXTURES[tenant].itemId },
    { kind: 'punch item description', value: HANDOVER_FIXTURES[tenant].itemDescription },
    { kind: 'asset id', value: HANDOVER_FIXTURES[tenant].assetId },
    { kind: 'asset code', value: HANDOVER_FIXTURES[tenant].assetCode },
    { kind: 'warranty obligation id', value: HANDOVER_FIXTURES[tenant].warrantyId },
    { kind: 'warranty obligation scope', value: HANDOVER_FIXTURES[tenant].warrantyScope },
    { kind: 'non-conformance id', value: NONCONFORMANCE_FIXTURES[tenant].id },
    { kind: 'non-conformance title', value: NONCONFORMANCE_FIXTURES[tenant].title },
    { kind: 'corrective action id', value: NONCONFORMANCE_FIXTURES[tenant].actionId },
    { kind: 'corrective action description', value: NONCONFORMANCE_FIXTURES[tenant].actionDescription },
    { kind: 'quality acceptance id', value: ACCEPTANCE_FIXTURES[tenant].id },
    { kind: 'quality acceptance record no', value: ACCEPTANCE_FIXTURES[tenant].recordNo },
    { kind: 'measurement reference', value: MEASUREMENT_FIXTURES[tenant].referenceNo },
    { kind: 'boq item id', value: BOQ_FIXTURES[tenant].itemId },
    { kind: 'boq line id', value: BOQ_FIXTURES[tenant].lineId },
    { kind: 'boq business key', value: BOQ_FIXTURES[tenant].businessKey },
    { kind: 'boq description', value: BOQ_FIXTURES[tenant].description },
    { kind: 'guarantee id', value: GUARANTEE_FIXTURES[tenant].id },
    { kind: 'active guarantee id', value: GUARANTEE_FIXTURES[tenant].activeId },
    { kind: 'guarantee number', value: GUARANTEE_FIXTURES[tenant].guaranteeNo },
    { kind: 'active guarantee number', value: GUARANTEE_FIXTURES[tenant].activeGuaranteeNo },
    { kind: 'guarantee issuer', value: GUARANTEE_FIXTURES[tenant].issuer },
    { kind: 'procurement plan id', value: PROCUREMENT_PLAN_FIXTURES[tenant].id },
    { kind: 'procurement plan title', value: PROCUREMENT_PLAN_FIXTURES[tenant].title },
    { kind: 'procurement package id', value: PROCUREMENT_PLAN_FIXTURES[tenant].packageId },
    { kind: 'procurement package code', value: PROCUREMENT_PLAN_FIXTURES[tenant].packageCode },
    { kind: 'procurement package title', value: PROCUREMENT_PLAN_FIXTURES[tenant].packageTitle },
    { kind: 'approved criteria version id', value: CRITERIA_FIXTURES[tenant].approvedId },
    { kind: 'draft criteria version id', value: CRITERIA_FIXTURES[tenant].draftId },
    { kind: 'criterion name', value: CRITERIA_FIXTURES[tenant].criterionName },
    { kind: 'criteria legal basis', value: CRITERIA_FIXTURES[tenant].legalBasis },
    { kind: 'dataset id', value: DATASET_FIXTURES[tenant].id },
    { kind: 'dataset code', value: DATASET_FIXTURES[tenant].datasetCode },
    { kind: 'dataset title', value: DATASET_FIXTURES[tenant].title },
    { kind: 'quality contract id', value: QUALITY_FIXTURES[tenant].contractId },
    { kind: 'quality rule id', value: QUALITY_FIXTURES[tenant].ruleId },
    { kind: 'quality rule code', value: QUALITY_FIXTURES[tenant].ruleCode },
    { kind: 'quality run id', value: QUALITY_FIXTURES[tenant].runId },
    { kind: 'sla policy id', value: SLA_POLICY_FIXTURES[tenant].id },
    { kind: 'sla policy code', value: SLA_POLICY_FIXTURES[tenant].code },
    { kind: 'issue id', value: ISSUE_FIXTURES[tenant].id },
    { kind: 'issue code', value: ISSUE_FIXTURES[tenant].code },
    { kind: 'issue title', value: ISSUE_FIXTURES[tenant].title },
    { kind: 'issue escalation id', value: ESCALATION_FIXTURES[tenant].id },
    { kind: 'permit type id', value: PERMIT_TYPE_FIXTURES[tenant].id },
    { kind: 'permit type code', value: PERMIT_TYPE_FIXTURES[tenant].code },
    { kind: 'permit type legal basis', value: PERMIT_TYPE_FIXTURES[tenant].legalBasis },
    { kind: 'permit gate rule id', value: PERMIT_TYPE_FIXTURES[tenant].gateRuleId },
    { kind: 'permit gate rule legal basis', value: PERMIT_TYPE_FIXTURES[tenant].gateBasis },
    { kind: 'permit gate waiver id', value: WAIVER_FIXTURES[tenant].id },
    { kind: 'support ticket id', value: TICKET_FIXTURES[tenant].id },
    { kind: 'support ticket subject', value: TICKET_FIXTURES[tenant].subject },
    { kind: 'support ticket description', value: TICKET_FIXTURES[tenant].description },
    { kind: 'permit gate waiver reason', value: WAIVER_FIXTURES[tenant].reason },
    { kind: 'permit dossier id', value: PERMIT_FIXTURES[tenant].dossierId },
    { kind: 'permit id', value: PERMIT_FIXTURES[tenant].permitId },
    { kind: 'permit authority', value: PERMIT_FIXTURES[tenant].authority },
    { kind: 'expired permit id', value: PERMIT_FIXTURES[tenant].expiredId },
    { kind: 'expired permit number', value: PERMIT_FIXTURES[tenant].expiredNo },
    { kind: 'reporting period id', value: PERIOD_FIXTURES[tenant].id },
    { kind: 'reporting period code', value: PERIOD_FIXTURES[tenant].code },
    { kind: 'report import id', value: REPORT_IMPORT_FIXTURES[tenant].id },
    { kind: 'report import file hash', value: REPORT_IMPORT_FIXTURES[tenant].fileSha256 },
    { kind: 'weekly report id', value: REPORT_FIXTURES[tenant].id },
    { kind: 'weekly report hash', value: REPORT_FIXTURES[tenant].payloadHash },
    { kind: 'weekly report cumulative', value: REPORT_FIXTURES[tenant].cumulativeVnd },
    { kind: 'locked reporting period id', value: REOPEN_FIXTURES[tenant].periodId },
    { kind: 'locked reporting period code', value: REOPEN_FIXTURES[tenant].periodCode },
    { kind: 'period reopen id', value: REOPEN_FIXTURES[tenant].id },
    { kind: 'period reopen reason', value: REOPEN_FIXTURES[tenant].reason },
    { kind: 'appropriation id', value: APPROPRIATION_FIXTURES[tenant].id },
    { kind: 'appropriation issuing authority', value: APPROPRIATION_FIXTURES[tenant].issuingAuthority },
    { kind: 'capital plan id', value: CAPITAL_PLAN_FIXTURES[tenant].id },
    { kind: 'capital plan code', value: CAPITAL_PLAN_FIXTURES[tenant].planCode },
    { kind: 'published capital plan id', value: CAPITAL_PLAN_FIXTURES[tenant].publishedId },
    { kind: 'published capital plan code', value: CAPITAL_PLAN_FIXTURES[tenant].publishedCode },
    { kind: 'allocation line id', value: CAPITAL_PLAN_FIXTURES[tenant].lineId },
    { kind: 'schedule line id', value: SCHEDULE_FIXTURES[tenant].id },
    { kind: 'schedule assumption', value: SCHEDULE_FIXTURES[tenant].assumption },
    { kind: 'security policy address', value: POLICY_FIXTURES[tenant].address },
    { kind: 'work calendar id', value: WORK_CALENDAR_FIXTURES[tenant].id },
    { kind: 'work calendar code', value: WORK_CALENDAR_FIXTURES[tenant].calendarCode },
    { kind: 'work calendar legal basis', value: WORK_CALENDAR_FIXTURES[tenant].legalBasis },
    { kind: 'fiscal year close note', value: FISCAL_YEAR_FIXTURES[tenant].reason },
    { kind: 'carry-over request id', value: EXTENSION_FIXTURES[tenant].id },
    { kind: 'carry-over request justification', value: EXTENSION_FIXTURES[tenant].justification },
    { kind: 'avc policy id', value: AVC_POLICY_FIXTURES[tenant].id },
    { kind: 'avc policy code', value: AVC_POLICY_FIXTURES[tenant].policyCode },
    { kind: 'avc policy legal basis', value: AVC_POLICY_FIXTURES[tenant].legalBasis },
    { kind: 'doa matrix id', value: DOA_FIXTURES[tenant].id },
    { kind: 'doa matrix legal basis', value: DOA_FIXTURES[tenant].legalBasis },
    { kind: 'doa rule document type', value: DOA_FIXTURES[tenant].documentType },
    { kind: 'retention policy id', value: RETENTION_FIXTURES[tenant].id },
    { kind: 'retention review item id', value: RETENTION_FIXTURES[tenant].reviewId },
    { kind: 'retention record class', value: RETENTION_FIXTURES[tenant].recordClass },
    { kind: 'retention legal basis', value: RETENTION_FIXTURES[tenant].legalBasis },
    { kind: 'connector id', value: INTEGRATION_FIXTURES[tenant].connectorId },
    { kind: 'connector code', value: INTEGRATION_FIXTURES[tenant].connectorCode },
    { kind: 'connector endpoint', value: INTEGRATION_FIXTURES[tenant].endpoint },
    { kind: 'inbox event id', value: INTEGRATION_FIXTURES[tenant].eventId },
    { kind: 'inbox event key', value: INTEGRATION_FIXTURES[tenant].eventKey },
    { kind: 'inbox payload reference', value: INTEGRATION_FIXTURES[tenant].payloadReference },
    { kind: 'register id', value: DOCUMENT_FIXTURES[tenant].registerId },
    { kind: 'register code', value: DOCUMENT_FIXTURES[tenant].registerCode },
    { kind: 'document version id', value: DOCUMENT_FIXTURES[tenant].versionId },
    { kind: 'document object key', value: DOCUMENT_FIXTURES[tenant].objectKey },
    { kind: 'outgoing document id', value: DOCUMENT_FIXTURES[tenant].outgoingId },
    { kind: 'signing session id', value: DOCUMENT_FIXTURES[tenant].sessionId },
    { kind: 'document distribution id', value: DOCUMENT_FIXTURES[tenant].distributionId },
    { kind: 'audit event id', value: AUDIT_EVENT_FIXTURES[tenant].id },
    { kind: 'audit event action', value: AUDIT_EVENT_FIXTURES[tenant].action },
    { kind: 'legal hold authority reference', value: LEGAL_HOLD_FIXTURES[tenant].authorityReference },
    { kind: 'membership id', value: MEMBERSHIP_FIXTURES[tenant].id },
    { kind: 'member name', value: MEMBERSHIP_FIXTURES[tenant].displayName },
    { kind: 'member email', value: MEMBERSHIP_FIXTURES[tenant].email },
  ];
  for (const unit of UNIT_FIXTURES[tenant]) {
    markers.push({ kind: 'unit id', value: unit.id }, { kind: 'unit code', value: unit.code }, { kind: 'unit name', value: unit.name });
  }
  return markers;
}

function exposedKinds(body: string, tenant: TenantName): string[] {
  const haystack = body.toLowerCase();
  const kinds = markersOf(tenant)
    .filter((marker) => haystack.includes(marker.value.toLowerCase()))
    .map((marker) => marker.kind);
  return [...new Set(kinds)];
}

function isEmptyPage(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { items?: unknown };
    return Array.isArray(parsed.items) && parsed.items.length === 0;
  } catch {
    return false;
  }
}

function foreignReadLeaks(channel: IsolationChannel, result: { status: number; body: string }): string[] {
  const leaks: string[] = [];
  if (channel.foreignReadOutcome === 'empty') {
    if (result.status !== 200) leaks.push(`${channel.name}: foreign read answered ${result.status} instead of 200`);
    else if (!isEmptyPage(result.body)) leaks.push(`${channel.name}: foreign read did not come back empty`);
  } else if (result.status !== 404) {
    leaks.push(`${channel.name}: foreign id read answered ${result.status} instead of 404`);
  }
  for (const kind of exposedKinds(result.body, 'TNT-B')) leaks.push(`${channel.name}: foreign id read exposes a TNT-B ${kind}`);
  return leaks;
}

function foreignAttemptLeaks(channel: IsolationChannel, attempt: ForeignAttempt): string[] {
  const leaks: string[] = [];
  const accepted = attempt.expectedStatuses ?? [404];
  if (!accepted.includes(attempt.status)) leaks.push(`${channel.name}: foreign id ${attempt.operation} answered ${attempt.status} instead of ${accepted.join(' or ')}`);
  if (attempt.mustBeEmpty === true && !isEmptyPage(attempt.body)) leaks.push(`${channel.name}: foreign id ${attempt.operation} did not come back empty`);
  for (const kind of exposedKinds(attempt.body, 'TNT-B')) leaks.push(`${channel.name}: foreign id ${attempt.operation} exposes a TNT-B ${kind}`);
  return leaks;
}

function listLeaks(channel: IsolationChannel, result: { status: number; body: string }): string[] {
  const leaks: string[] = [];
  if (result.status !== 200) leaks.push(`${channel.name}: list answered ${result.status} instead of 200`);
  for (const kind of exposedKinds(result.body, 'TNT-B')) leaks.push(`${channel.name}: list exposes a TNT-B ${kind}`);
  for (const unit of UNIT_FIXTURES['TNT-A']) {
    if (!result.body.includes(unit.name)) leaks.push(`${channel.name}: list misses own unit ${unit.code}`);
  }
  return leaks;
}

/**
 * Runs the isolation conformance checks (ST-KERNEL-026) over every channel: a TNT-A user asking for a
 * TNT-B object by id must get 404 with a body free of TNT-B data, and a list must hold TNT-A rows only.
 * Commands and further reads must answer 404 too and leave the TNT-B snapshot unchanged.
 * It also requires a registered foreign-id case for every implemented id-bearing operation.
 * Violations are reported, never thrown, so a negative control can assert on them.
 */
export async function runIsolationSuite(input: IsolationSuiteInput): Promise<IsolationReport> {
  const leaks: string[] = [];
  for (const channel of input.channels) {
    for (const tenant of TENANT_NAMES) await channel.seed(tenant);
    leaks.push(...foreignReadLeaks(channel, await channel.readAs('TNT-A', 'TNT-B')));
    if (channel.listAs !== undefined) leaks.push(...listLeaks(channel, await channel.listAs('TNT-A')));
    if (channel.foreignAttempts !== undefined) {
      const before = await input.snapshot?.('TNT-B');
      for (const attempt of await channel.foreignAttempts('TNT-A')) leaks.push(...foreignAttemptLeaks(channel, attempt));
      if ((await input.snapshot?.('TNT-B')) !== before) leaks.push(`${channel.name}: foreign id attempts changed TNT-B data`);
    }
  }
  const uncoveredOperations = input.idBearingOperations.filter((operation) => !input.foreignIdCases.has(operation));
  return { ok: leaks.length === 0 && uncoveredOperations.length === 0, leaks, uncoveredOperations };
}
