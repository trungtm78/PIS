import { X509Certificate, randomUUID } from 'node:crypto';
import { DoaMatrixStore } from '@machvon/db';
import { fingerprintOf } from '../../../src/modules/doc/cms-verification';
import { MockSigningPort } from '../../../src/modules/doc/signing-port';
import { roleId } from '../../../../../packages/db/test/support/authz-fixtures';
import { ACTOR, ADMIN, CLERK, DocApp, LEADER, LEGAL_ISSUER, MAKER, NOW, REVIEWER, TENANT_A, memberId, unitId } from '../doc-app';
import type { Reply } from '../doc-app';
import { createWorld } from './pki-world';
import type { World } from './pki-world';

export const CHECKLIST = { national_title: true, motto: true, agency_name: true, number_symbol: true, summary: true, body: true, signer_title: true, recipients: true };

export const payloadOf = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  agency: 'People Committee of Cao Bang',
  place: 'Cao Bang',
  title: 'Decision on the assignment of the capital plan',
  body: 'The capital plan of 2026 is assigned to the units listed in the annex.',
  signer_title: 'CHAIRMAN',
  amount_vnd: '1000000000',
  ...extra,
});

/**
 * The world the flows of the outgoing documents run in: the document application over a real database, a test certification authority with the leader and
 * the organisation seal registered, the QD document type, a matrix of authority that names the role of the leader, and the people of DOC-1 (drafter, reviewer,
 * leader, clerk). A flow takes a document from a draft to SEALED with the helpers below, over the same HTTP routes the screens use.
 */
export class FlowWorld {
  readonly app = new DocApp();
  world!: World;
  private registerCounter = 0;

  async start(): Promise<void> {
    this.world = await createWorld();
    await this.app.start();
    const { app, world } = this;
    app.anchors = [{ regime: 'PUBLIC_CA', certificate: world.root.certificate }];
    const clock = (): Date => app.now;
    app.signing.register(fingerprintOf(new X509Certificate(world.leader.certificate)), new MockSigningPort({ identity: world.leader, clock, timestamps: world.tsa }));
    app.signing.register(fingerprintOf(new X509Certificate(world.organization.certificate)), new MockSigningPort({ identity: world.organization, clock, timestamps: world.tsa }));
    world.setTime(NOW);
    // The members were seeded with the real clock; the clock of the module runs in October 2026.
    await app.harness.owner(TENANT_A, [["update machvon.membership set valid_from = '2020-01-01'"]]);
    await this.registerCertificate('PERSONAL', memberId(LEADER), null, 'CN=Nguyen Van A', world.leader.certificate);
    await this.registerCertificate('ORGANIZATION', null, unitId(1), 'CN=Test Agency Seal', world.organization.certificate);
    const type = await app.call('POST', '/document-types', {
      member: ADMIN,
      body: { code: 'QD', name: 'Decision', abbreviation: 'QD', symbol_kind: 'DECISION', symbol_pattern: '{number}/{type}-{agency}', register_code: 'REG-QD', legal_basis: 'ND 30/2020', effective_from: '2026-01-01' },
    });
    if (type.status !== 200) throw new Error(`the document type was refused: ${JSON.stringify(type.json)}`);
    const report = await app.call('POST', '/document-types', {
      member: ADMIN,
      body: { code: 'BC', name: 'Report', abbreviation: 'BC', symbol_kind: 'NAMED_TYPE', symbol_pattern: '{number}/{type}-{agency}', register_code: 'REG-BC', legal_basis: 'ND 30/2020', effective_from: '2026-01-01' },
    });
    if (report.status !== 200) throw new Error(`the report type was refused: ${JSON.stringify(report.json)}`);
    const matrix = new DoaMatrixStore();
    await app.harness.tenants.withTenant({ tenantId: TENANT_A, membershipId: memberId(ADMIN), scopeVersion: 1 }, async (tx) => {
      const draft = await matrix.createDraft(
        tx,
        { effective_from: '2026-01-01', legal_basis_ref: 'Internal regulation 12/QD-2026', rules: ['QD', 'BC'].map((documentType) => ({ document_type: documentType, unit_id: unitId(1), amount_min_vnd: '0', approver_role_id: roleId(4) })) },
        memberId(ADMIN),
      );
      await matrix.submit(tx, draft.id, draft.version, memberId(ADMIN));
      await matrix.decide(tx, draft.id, draft.version + 1, 'approve', memberId(REVIEWER));
    });
  }

  stop(): Promise<void> {
    return this.app.stop();
  }

  reset(): void {
    this.app.now = NOW;
    this.world.setTime(NOW);
    this.app.signing.setAvailable(true);
  }

  private async registerCertificate(kind: string, holder: string | null, unit: string | null, subject: string, bytes: Buffer): Promise<void> {
    await this.app.harness.owner(TENANT_A, [
      [
        `insert into machvon.signing_certificate (tenant_id, id, kind, holder_membership_id, organization_unit_id, certificate_serial, issuer_dn, subject_dn, provider_code, valid_from, valid_until, fingerprint_sha256, status, registered_by)
         values ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, '01', 'CN=Test Root CA', $6, 'MOCK', '2026-01-01', '2030-01-01', $7, 'Active', $8::uuid)`,
        [TENANT_A, randomUUID(), kind, holder, unit, subject, fingerprintOf(new X509Certificate(bytes)), ACTOR],
      ],
    ]);
  }

  async openRegister(overrides: Record<string, unknown> = {}): Promise<string> {
    this.registerCounter += 1;
    const reply = await this.app.call('POST', '/document-number-registers', {
      member: ADMIN,
      body: { register_code: `R${this.registerCounter}`, name: 'Outgoing register', direction: 'OUTGOING', organization_unit_id: unitId(2), year: 2026, mode: 'MANAGED', scope_doc_types: ['QD'], ...overrides },
    });
    if (reply.status !== 200) throw new Error(`the register was refused: ${JSON.stringify(reply.json)}`);
    return reply.json.resource_id as string;
  }

  private call(method: 'GET' | 'POST', url: string, member: number, extra: { body?: unknown; version?: number; key?: string } = {}): Promise<Reply> {
    return this.app.call(method, url, { member, ...(extra.body === undefined ? {} : { body: extra.body }), ...(extra.version === undefined ? {} : { ifMatch: `"${extra.version}"` }), ...(extra.key === undefined ? {} : { key: extra.key }) });
  }

  create(body: Record<string, unknown>, member: number = MAKER): Promise<Reply> {
    return this.call('POST', '/outgoing-documents', member, { body });
  }

  submit(id: string, version: number, member: number = MAKER): Promise<Reply> {
    return this.call('POST', `/outgoing-documents/${id}/review-submission`, member, { version });
  }

  approve(id: string, version: number, member: number = REVIEWER): Promise<Reply> {
    return this.call('POST', `/outgoing-documents/${id}/review-decision`, member, { version, body: { decision: 'APPROVE', format_checklist: CHECKLIST } });
  }

  async approveSession(sessionId: string): Promise<void> {
    const [row] = await this.app.harness.owner<{ provider_txn_ref: string; expires_at: Date }>(TENANT_A, [['select provider_txn_ref, expires_at from machvon.doc_signing_session where id = $1', [sessionId]]]);
    if (row === undefined) throw new Error('no session');
    this.app.signing.approve({ provider: 'MOCK', sessionId: row.provider_txn_ref, expiresAt: row.expires_at });
  }

  /** Signs as the leader, numbers as the clerk and seals as the organisation: SUBMITTED to SEALED. Returns the version of the document. */
  async sealFrom(id: string, submittedVersion: number, registerId: string): Promise<number> {
    const started = await this.call('POST', `/outgoing-documents/${id}/leader-signing-sessions`, LEADER, { version: submittedVersion, body: {} });
    if (started.status !== 202) throw new Error(`leader signing was refused: ${JSON.stringify(started.json)}`);
    const leaderSession = started.json.resource_id as string;
    await this.approveSession(leaderSession);
    const signed = await this.call('POST', `/signing-sessions/${leaderSession}/completion`, LEADER, { version: 1, body: {} });
    if (signed.status !== 200) throw new Error(`the signature was refused: ${JSON.stringify(signed.json)}`);
    const numbered = await this.call('POST', `/outgoing-documents/${id}/numbering`, CLERK, { version: signed.json.document_version as number, body: { register_id: registerId } });
    if (numbered.status !== 200) throw new Error(`numbering was refused: ${JSON.stringify(numbered.json)}`);
    const seal = await this.call('POST', `/outgoing-documents/${id}/organization-seal-sessions`, CLERK, { version: numbered.json.resource_version as number, body: {} });
    if (seal.status !== 202) throw new Error(`the seal was refused: ${JSON.stringify(seal.json)}`);
    const sealSession = seal.json.resource_id as string;
    await this.approveSession(sealSession);
    const sealed = await this.call('POST', `/signing-sessions/${sealSession}/completion`, CLERK, { version: 1, body: {} });
    if (sealed.status !== 200) throw new Error(`the seal was refused: ${JSON.stringify(sealed.json)}`);
    return sealed.json.document_version as number;
  }

  /**
   * Issues a sealed document through the command (the gate verifies both signatures again): a legal user of the whole tenant, with the reason that a document
   * of the unconfirmed default template needs. A refusal rejects with the code of the problem.
   */
  async issueSealed(id: string, member: number = LEGAL_ISSUER): Promise<void> {
    const [current] = await this.app.harness.owner<{ version: string }>(TENANT_A, [['select version::text as version from machvon.outgoing_document where id = $1', [id]]]);
    const reply = await this.call('POST', `/outgoing-documents/${id}/issuance`, member, {
      version: Number(current?.version),
      body: { unconfirmed_override_reason: 'The legal office confirmed the template by letter 12/PC' },
    });
    if (reply.status !== 200) throw Object.assign(new Error(String(reply.json.code)), { code: reply.json.code });
  }
}
