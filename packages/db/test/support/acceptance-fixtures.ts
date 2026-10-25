import { randomUUID } from 'node:crypto';
import { CtrAcceptanceStore } from '../../src/ctr-acceptance-store';
import type { AcceptanceResult } from '../../src/ctr-acceptance-store';
import type { ContractScopes } from '../../src/ctr-contract-store';
import type { TenantTx } from '../../src/tenant-database';
import { TENANT_A, contextFor, id, memberId } from './authz-fixtures';
import { seedAs, seedContractor } from './bid-proposal-fixtures';
import { CapWorld } from './cap-fixtures';

const FAMILY = 0xb1;
const CREATOR = 1;
const SENDER = 2;
const APPROVER = 3;
const REVOKER = 5;
const DOCUMENT = id(FAMILY, 30);
const VERSION = id(FAMILY, 31);
const TODAY = '2026-07-25';
const SIGNERS = [{ name: 'Representative of the owner', role: 'OWNER' }];
const everything: ContractScopes = { update: () => ({ sql: 'true', params: [] }), read: () => ({ sql: 'true', params: [] }) };

/** The items of a seeded contract: B01 (8,000 m3 at 1,000,000), B02 (500 m3 at 2,000,000) and B03 (10 at 1,234.5, to the dong). */
export interface SeededContract {
  contractId: string;
  code: string;
  revisionId: string;
  items: [string, string, string];
  partyId: string;
}

export interface ApprovedAcceptance {
  contract: SeededContract;
  acceptance: AcceptanceResult;
  /** The amount of each line, by item. */
  amounts: Map<string, string>;
}

/**
 * A contract being performed and the approved acceptance of work done under it, made the way the commands of CTR leave them (the measurements are written to the table, the acceptance goes
 * through draft, send and approve). The tests of the cumulative ledger (PAY) start from it.
 */
export class AcceptanceWorld {
  readonly world = new CapWorld();
  readonly harness = this.world.harness;
  readonly acceptances = new CtrAcceptanceStore();
  readonly memberIds = { creator: memberId(CREATOR), approver: memberId(APPROVER), revoker: memberId(REVOKER) };
  /** The project and the line of capital of the first published plan: the contracts of the tests are of this project unless they are given another. */
  projectId = '';
  lineId = '';
  /** The contractor of the contracts of the tests (a row of the table, so a contract can be changed in a transaction that wrote it). */
  contractorId = '';
  private periodId = '';
  private counter = 0;

  async start(): Promise<void> {
    await this.world.start();
    this.contractorId = await seedContractor(this.harness);
    await this.harness.seedMembership(TENANT_A, REVOKER, 1);
    const published = await this.world.publishedLine({ allocated: '10000000000000', appropriationAmount: '20000000000000' });
    this.projectId = published.projectId;
    this.lineId = published.lineId;
    this.periodId = randomUUID();
    await seedAs(this.harness, [
      [`insert into machvon.document (tenant_id, id, doc_kind, doc_type_code, title, classification, created_by, updated_by) values ($1, $2, 'REFERENCE', 'QD', 'Record', 'INTERNAL', $3, $3)`, [TENANT_A, DOCUMENT, memberId(CREATOR)]],
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, 1, 'tenants/pay/record.pdf', repeat('a', 64), 'application/pdf', 1, 'INTERNAL', 'CLEAN', '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, VERSION, DOCUMENT],
      ],
      [
        `insert into machvon.reporting_period (tenant_id, id, code, calendar_version, start_date, end_date, deadline_at, calendar_code, period_type, fiscal_year, status, calendar_version_id, created_by, updated_by)
         values ($1, $2, '2026-07', 1, date '2026-07-01', date '2026-07-28', date '2026-07-28' + interval '3 hours', 'CAL-N', 'MONTH', 2026, 'OPEN', gen_random_uuid(), $3, $3)`,
        [TENANT_A, this.periodId, memberId(CREATOR)],
      ],
    ]);
  }

  async stop(): Promise<void> {
    await this.world.stop();
  }

  as<T>(work: (tx: TenantTx) => Promise<T>, member = CREATOR): Promise<T> {
    return this.harness.tenants.withTenant(contextFor(TENANT_A, memberId(member)), work);
  }

  owner<R extends object = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
    return this.harness.owner<R>(TENANT_A, [[sql, params]]);
  }

  /** A contract worth nine billion under revision 1 with the three items of the BOQ and its one party. */
  async seedContract(options: { projectId?: string; lineId?: string } = {}): Promise<SeededContract> {
    this.counter += 1;
    const contractId = randomUUID();
    const revisionId = randomUUID();
    const packageId = randomUUID();
    const partyId = randomUUID();
    const code = `HD-P-${String(this.counter).padStart(4, '0')}`;
    const items: [string, string, string] = [randomUUID(), randomUUID(), randomUUID()];
    const line = (n: number, key: string, quantity: string, price: string, amount: string): [string, unknown[]] => [
      `insert into machvon.boq_line (tenant_id, id, contract_revision_id, contract_id, boq_item_id, line_no, business_key, description, unit_code, quantity, unit_price, rounding_rule, amount_vnd, retention_pct, created_by)
       values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, 'M3', $8::numeric, $9::numeric, 'HALF_UP', $10::numeric, 5, $11)`,
      [TENANT_A, revisionId, contractId, items[n - 1], n, key, `Item ${key}`, quantity, price, amount, memberId(CREATOR)],
    ];
    await seedAs(this.harness, [
      [
        `insert into machvon.procurement_package (tenant_id, id, project_id, code, budget_vnd, method, revision, status, allocation_line_id)
         values ($1, $2, $3, $4, 100000000000, 'OPEN', 1, 'AWARDED', $5)`,
        [TENANT_A, packageId, options.projectId ?? this.projectId, `PKG-${code}`, options.lineId ?? this.lineId],
      ],
      [
        `insert into machvon.contract
           (tenant_id, id, project_id, package_id, contractor_id, code, type, currency, status, version, title, advance_category, is_joint_venture, requires_quality_acceptance, contract_value_vnd,
            created_by, updated_by, signed_on, effective_from)
         values ($1, $2, $3, $4, $5, $6, 'UNIT_PRICE', 'VND', 'ACTIVE', 1, 'Contract', 'OTHER', false, false, 9000000000, $7, $7, date '2026-01-01', date '2026-01-02')`,
        [TENANT_A, contractId, options.projectId ?? this.projectId, packageId, this.contractorId, code, memberId(CREATOR)],
      ],
      [
        `insert into machvon.contract_revision (tenant_id, id, contract_id, revision, amount_vnd, document_version_id, valid_from, status, kind, version, created_by, updated_by)
         values ($1, $2, $3, 1, 9000000000, $4, date '2026-01-02', 'DRAFT', 'BASE', 1, $5, $5)`,
        [TENANT_A, revisionId, contractId, VERSION, memberId(CREATOR)],
      ],
      [
        `insert into machvon.boq_item (tenant_id, id, contract_id, business_key, description, unit_code, created_by, updated_by)
         values ($1, $2, $5, 'B01', 'Item B01', 'M3', $6, $6), ($1, $3, $5, 'B02', 'Item B02', 'M3', $6, $6), ($1, $4, $5, 'B03', 'Item B03', 'M3', $6, $6)`,
        [TENANT_A, items[0], items[1], items[2], contractId, memberId(CREATOR)],
      ],
      line(1, 'B01', '8000', '1000000', '8000000000'),
      line(2, 'B02', '500', '2000000', '1000000000'),
      line(3, 'B03', '10', '1234.5', '12345'),
      [
        `insert into machvon.contract_party (tenant_id, id, contract_id, contractor_id, role, share_pct, work_value_vnd, status, valid_from, created_by, updated_by)
         values ($1, $2, $3, $4, 'SOLE', 100, 9000000000, 'ACTIVE', date '2026-01-02', $5, $5)`,
        [TENANT_A, partyId, contractId, this.contractorId, memberId(CREATOR)],
      ],
      [`update machvon.contract_revision set status = 'EFFECTIVE', decided_by = $2, decided_at = now() where id = $1::uuid`, [revisionId, memberId(CREATOR)]],
      [`update machvon.contract set current_revision_id = $2 where id = $1::uuid`, [contractId, revisionId]],
    ]);
    return { contractId, code, revisionId, items, partyId };
  }

  /** A version of a file of the tenant, with the result of the scan given (clean by default), for the documents the tests attach. */
  async documentVersion(scan = 'CLEAN'): Promise<{ id: string; checksum: string }> {
    this.counter += 1;
    const id = randomUUID();
    const checksum = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    await seedAs(this.harness, [
      [
        `insert into machvon.document_version (tenant_id, id, document_id, version, object_key, checksum, mime, page_count, classification, scan_status, acl_json, stage)
         values ($1, $2, $3, $4, $5, $6, 'application/pdf', 1, 'INTERNAL', $7, '{}'::jsonb, 'RENDERED_FINAL')`,
        [TENANT_A, id, DOCUMENT, 1000 + this.counter, `tenants/pay/doc-${this.counter}.pdf`, checksum, scan],
      ],
    ]);
    return { id, checksum };
  }

  /**
   * Puts a request that is checked with the Treasury the way the commands of PAY do: a standing form of each of the four kinds, then the day it was sent and the person who sent it. For the tests
   * that need a request in SENT_TREASURY and are not about the forms.
   */
  async sendToTreasury(requestId: string): Promise<void> {
    for (const code of ['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT']) {
      const version = await this.documentVersion();
      await this.owner(
        `insert into machvon.payment_form_instance
           (tenant_id, id, subject_kind, payment_request_id, form_code, template_version_id, template_code, template_revision, document_id, document_version_id, file_sha256, payload_sha256, input_sha256,
            legal_basis, status, generated_at, generated_by, created_by, updated_by)
         select $1, gen_random_uuid(), 'PAYMENT_REQUEST', $2::uuid, $3, gen_random_uuid(), $4, 1, v.document_id, v.id, repeat('a', 64), repeat('b', 64), repeat('c', 64), 'Fixture appendix', 'GENERATED', now(), $5, $5, $5
           from machvon.document_version v where v.id = $6::uuid`,
        [TENANT_A, requestId, code, `FIXTURE-${code}`, memberId(CREATOR), version.id],
      );
    }
    await this.owner(
      `update machvon.payment_request set status = 'SENT_TREASURY', treasury_submitted_on = date '2026-07-26', treasury_sent_by = $2::uuid, treasury_sent_at = now() where id = $1::uuid`,
      [requestId, memberId(CREATOR)],
    );
  }

  /** An approved measurement of an item (by position in the BOQ). */
  async measured(contract: SeededContract, item: 0 | 1 | 2, quantity: string, party = false): Promise<string> {
    this.counter += 1;
    const measurementId = randomUUID();
    const lineId = (await this.owner<{ id: string }>('select id from machvon.boq_line where contract_id = $1::uuid and boq_item_id = $2::uuid limit 1', [contract.contractId, contract.items[item]]))[0]?.id;
    await seedAs(this.harness, [
      [
        `insert into machvon.measurement
           (tenant_id, id, contract_id, contract_revision_id, boq_line_id, boq_item_id, party_id, period_id, quantity_period, quantity_cumulative, revision, status, evidence_refs, reference_no,
            created_by, updated_by, submitted_by, submitted_at, decided_by, decided_at, version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $9::numeric, $13, 'APPROVED', jsonb_build_array(jsonb_build_object('document_version_id', $10::text)), $11,
                 $12, $12, $12, now(), $14, now(), 1)`,
        [TENANT_A, measurementId, contract.contractId, contract.revisionId, lineId, contract.items[item], party ? contract.partyId : null, this.periodId, quantity, VERSION, `NK-P-${String(this.counter).padStart(5, '0')}`, memberId(CREATOR), this.counter, memberId(APPROVER)],
      ],
    ]);
    return measurementId;
  }

  /** An acceptance of the measurements, drafted by the command of CTR. */
  async draft(contract: SeededContract, measurements: ReadonlyArray<{ item: 0 | 1 | 2; quantity: string; party?: boolean }>): Promise<AcceptanceResult> {
    const ids: string[] = [];
    for (const measurement of measurements) ids.push(await this.measured(contract, measurement.item, measurement.quantity, measurement.party === true));
    return this.as((tx) => this.acceptances.create(tx, contract.contractId, { measurementIds: ids, periodId: this.periodId, documentVersionId: VERSION }, memberId(CREATOR), everything, TODAY), CREATOR);
  }

  /** An acceptance of the measurements, drafted, sent and approved by the commands of CTR. */
  async approve(contract: SeededContract, measurements: ReadonlyArray<{ item: 0 | 1 | 2; quantity: string; party?: boolean }>): Promise<ApprovedAcceptance> {
    const drafted = await this.draft(contract, measurements);
    const sent = await this.as((tx) => this.acceptances.submit(tx, drafted.id, drafted.version, { signerRefs: SIGNERS }, memberId(SENDER), everything), SENDER);
    const acceptance = await this.as(
      (tx) => this.acceptances.decide(tx, sent.id, sent.version, { decision: 'approve', reason: 'Checked against the measurements.', evidenceIds: [] }, memberId(APPROVER), everything),
      APPROVER,
    );
    const amounts = new Map<string, string>();
    for (const line of acceptance.lines) amounts.set(line.boqItemId, (BigInt(amounts.get(line.boqItemId) ?? '0') + BigInt(line.amountVnd)).toString());
    return { contract, acceptance, amounts };
  }

  /** The acceptance revoked by the command of CTR. */
  async revoke(approved: ApprovedAcceptance): Promise<AcceptanceResult> {
    return this.as(
      (tx) =>
        this.acceptances.revoke(tx, approved.acceptance.id, approved.acceptance.version, { reason: 'The measurements were found wrong.', approvalDocumentVersionId: VERSION }, memberId(REVOKER), everything),
      REVOKER,
    );
  }
}
