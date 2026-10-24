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

/** A PUBLISHED permit type version of each tenant, still waiting for its legal confirmation (the code and the legal basis are distinctive; tenant legal data). */
export const PERMIT_TYPE_FIXTURES: Readonly<Record<TenantName, { id: string; code: string; legalBasis: string }>> = {
  'TNT-A': { id: '00000000-0000-4000-a0f1-000000000001', code: 'ALPHA_PERMIT_0001', legalBasis: 'Alpha tenant permit regulation 0001' },
  'TNT-B': { id: '00000000-0000-4000-b0f1-000000000001', code: 'BETA_PERMIT_0001', legalBasis: 'Beta tenant permit regulation 0001' },
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

/** A LOCKED reporting period of each tenant and a request to reopen it that waits for a decision (the reason of the request is distinctive: it is internal to the tenant). */
export const REOPEN_FIXTURES: Readonly<Record<TenantName, { periodId: string; periodCode: string; id: string; reason: string }>> = {
  'TNT-A': { periodId: '00000000-0000-4000-a0b6-000000000001', periodCode: 'ALPHA-PERIOD-0002', id: '00000000-0000-4000-a0b7-000000000001', reason: 'Alpha tenant request to reopen the locked period 0001' },
  'TNT-B': { periodId: '00000000-0000-4000-b0b6-000000000001', periodCode: 'BETA-PERIOD-0002', id: '00000000-0000-4000-b0b7-000000000001', reason: 'Beta tenant request to reopen the locked period 0001' },
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
    { kind: 'land section id', value: SECTION_FIXTURES[tenant].id },
    { kind: 'land section code', value: SECTION_FIXTURES[tenant].code },
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
    { kind: 'permit dossier id', value: PERMIT_FIXTURES[tenant].dossierId },
    { kind: 'permit id', value: PERMIT_FIXTURES[tenant].permitId },
    { kind: 'permit authority', value: PERMIT_FIXTURES[tenant].authority },
    { kind: 'expired permit id', value: PERMIT_FIXTURES[tenant].expiredId },
    { kind: 'expired permit number', value: PERMIT_FIXTURES[tenant].expiredNo },
    { kind: 'reporting period id', value: PERIOD_FIXTURES[tenant].id },
    { kind: 'reporting period code', value: PERIOD_FIXTURES[tenant].code },
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
