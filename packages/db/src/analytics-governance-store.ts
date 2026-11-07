import { DomainError, KPI_RULE_TYPE, RAG_RULE_TYPE, currentCertification, kpiDefinitionOf, nextCertification, ragModelFromResolver } from '@machvon/kernel';
import type { CertLine, CertStatus, CertSubject, KpiDefinition, RagModel } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** Who is named on a line of a certification (names come from the directory of the tenant). */
export interface CertPerson {
  id: string;
  name: string;
}

/** What a subject's certification is now: the latest line of the version asked for (a version with no line is Nháp). The built-in default of a definition is certified by the review of the repository, with no person. */
export interface CertificationView {
  subject: CertSubject | 'METRIC';
  key: string;
  version: number;
  status: CertStatus;
  origin: 'PLATFORM' | 'TENANT';
  actor: CertPerson | null;
  confirmedBy: CertPerson | null;
  note: string | null;
  at: string | null;
  seq: number;
}

export interface CertLogEntry {
  version: number;
  seq: number;
  status: CertStatus;
  actor: CertPerson;
  confirmedBy: CertPerson | null;
  note: string | null;
  at: string;
}

export interface DatasetCertification extends CertificationView {
  datasetId: string;
  code: string;
  title: string;
  datasetStatus: string;
  /** The latest version of this dataset that was certified, when it is not the one in force now (the definition moved on and must be certified again). */
  lastCertifiedVersion: number | null;
}

export interface MetricCertification {
  id: string;
  code: string;
  revision: number;
  /** The status of the registry mapped to the four words of the certification: DRAFT, IN_REVIEW is confirmed, CERTIFIED, SUPERSEDED and RETIRED are obsolete. */
  status: CertStatus;
  registryStatus: string;
  origin: string;
  certifiedBy: CertPerson | null;
  certifiedAt: string | null;
}

interface LineSql {
  subject_key: string;
  version: string;
  seq: number;
  status: CertStatus;
  actor_membership_id: string;
  actor_name: string | null;
  confirmed_by_membership_id: string | null;
  confirmed_name: string | null;
  note: string | null;
  created_at: string;
}

const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const LINE_COLUMNS = `c.subject_key, c.version::text as version, c.seq, c.status, c.actor_membership_id, ad.display_name as actor_name, c.confirmed_by_membership_id, cd.display_name as confirmed_name, c.note, ${ISO('c.created_at')} as created_at`;
const LINE_JOINS = `left join machvon.tenant_user_directory ad on ad.tenant_id = c.tenant_id and ad.membership_id = c.actor_membership_id
  left join machvon.tenant_user_directory cd on cd.tenant_id = c.tenant_id and cd.membership_id = c.confirmed_by_membership_id`;

const person = (id: string | null, name: string | null): CertPerson | null => (id === null ? null : { id, name: name ?? '' });

const toLog = (row: LineSql): CertLogEntry => ({
  version: Number(row.version),
  seq: row.seq,
  status: row.status,
  actor: { id: row.actor_membership_id, name: row.actor_name ?? '' },
  confirmedBy: person(row.confirmed_by_membership_id, row.confirmed_name),
  note: row.note,
  at: row.created_at,
});

const toLine = (entry: CertLogEntry): CertLine => ({ status: entry.status, actor: entry.actor.id, confirmedBy: entry.confirmedBy?.id ?? null, at: entry.at, note: entry.note });

const VIEW_OF_REGISTRY: Readonly<Record<string, CertStatus>> = { DRAFT: 'DRAFT', IN_REVIEW: 'CONFIRMED', CERTIFIED: 'CERTIFIED', SUPERSEDED: 'OBSOLETE', RETIRED: 'OBSOLETE' };

/**
 * The analytics governance of HOME and BI (G0-4, G3-1): the definitions of the KPI register (rules of the governance store, read through `GovernancePolicyPort` over the built-in defaults), the life of the certification of a
 * definition or of a dataset (`analytics_certification`, append-only), and the certification of the metrics that BI already keeps in its registry, read as the same four words. This store never decides who may move
 * what: the controller holds the permission, this one applies the pure rule of the kernel (`nextCertification`) and writes the line.
 */
export class AnalyticsGovernanceStore {
  private readonly policy: GovernancePolicyPort;

  constructor(policy: GovernancePolicyPort = new GovernancePolicyPort()) {
    this.policy = policy;
  }

  // ---- the register ----------------------------------------------------------------------------------------------------------------------------

  /** Every definition in force on the day, by code: an approved rule of the tenant, or the built-in default. */
  async kpiDefinitions(tx: TenantTx, asOf: string): Promise<Map<string, KpiDefinition>> {
    const resolved = await this.policy.getAll(tx, KPI_RULE_TYPE, asOf);
    return new Map(resolved.map((rule) => [rule.code, kpiDefinitionOf(rule)]));
  }

  async kpiDefinition(tx: TenantTx, code: string, asOf: string): Promise<KpiDefinition | undefined> {
    const resolved = await this.policy.get(tx, KPI_RULE_TYPE, code, asOf);
    return resolved === undefined ? undefined : kpiDefinitionOf(resolved);
  }

  /** The model of the early-warning score in force on the day (factors, weights, lines, the share of data a band needs), with the versions that decided. */
  async ragModel(tx: TenantTx, asOf: string): Promise<RagModel> {
    const resolved = new Map((await this.policy.getAll(tx, RAG_RULE_TYPE, asOf)).map((rule) => [rule.code, rule]));
    return ragModelFromResolver((code) => resolved.get(code));
  }

  // ---- certification of a KPI definition or a dataset --------------------------------------------------------------------------------------------

  /** The log of a subject, every version, oldest first. */
  async log(tx: TenantTx, subject: CertSubject, key: string): Promise<CertLogEntry[]> {
    const rows = await tx.query<LineSql>(`select ${LINE_COLUMNS} from machvon.analytics_certification c ${LINE_JOINS} where c.subject = $1 and c.subject_key = $2 order by c.version, c.seq`, [subject, key]);
    return rows.map(toLog);
  }

  /**
   * What each definition is now. The built-in default (version 0) is certified by the review of the repository: nobody is named. A version a tenant approved has no line until someone confirms it, so it is Nháp
   * and its figures are not given to a leader until it is certified (the second person).
   */
  async kpiCertifications(tx: TenantTx, definitions: Iterable<KpiDefinition>): Promise<Map<string, CertificationView>> {
    const wanted = [...definitions];
    const rows = await tx.query<LineSql>(
      `select distinct on (c.subject_key, c.version) ${LINE_COLUMNS} from machvon.analytics_certification c ${LINE_JOINS} where c.subject = 'KPI' and c.subject_key = any($1::text[]) order by c.subject_key, c.version, c.seq desc`,
      [wanted.map((definition) => definition.code)],
    );
    const latest = new Map(rows.map((row) => [`${row.subject_key}@${row.version}`, row]));
    const views = new Map<string, CertificationView>();
    for (const definition of wanted) {
      if (definition.version === 0) {
        views.set(definition.code, { subject: 'KPI', key: definition.code, version: 0, status: 'CERTIFIED', origin: 'PLATFORM', actor: null, confirmedBy: null, note: null, at: null, seq: 0 });
        continue;
      }
      const row = latest.get(`${definition.code}@${definition.version}`);
      views.set(definition.code, {
        subject: 'KPI',
        key: definition.code,
        version: definition.version,
        status: row?.status ?? 'DRAFT',
        origin: 'TENANT',
        actor: row === undefined ? null : person(row.actor_membership_id, row.actor_name),
        confirmedBy: row === undefined ? null : person(row.confirmed_by_membership_id, row.confirmed_name),
        note: row?.note ?? null,
        at: row?.created_at ?? null,
        seq: row?.seq ?? 0,
      });
    }
    return views;
  }

  /** The datasets with what each is now (the version in force of its definition; a lapsed certification of an older version is named, never carried over). */
  async datasetCertifications(tx: TenantTx): Promise<DatasetCertification[]> {
    const rows = await tx.query<{ id: string; dataset_code: string; title: string; status: string; version: string; last_certified: string | null } & Partial<LineSql>>(
      `select d.id, d.dataset_code, d.title, d.status, d.version::text as version,
              c.status as cert_status, c.actor_membership_id, ad.display_name as actor_name, c.confirmed_by_membership_id, cd.display_name as confirmed_name, c.note, ${ISO('c.created_at')} as created_at, c.seq,
              (select max(k.version)::text from machvon.analytics_certification k where k.tenant_id = d.tenant_id and k.subject = 'DATASET' and k.subject_key = d.id::text and k.status = 'CERTIFIED' and k.version < d.version) as last_certified
         from machvon.bi_dataset d
         left join lateral (select * from machvon.analytics_certification x where x.tenant_id = d.tenant_id and x.subject = 'DATASET' and x.subject_key = d.id::text and x.version = d.version order by x.seq desc limit 1) c on true
         left join machvon.tenant_user_directory ad on ad.tenant_id = d.tenant_id and ad.membership_id = c.actor_membership_id
         left join machvon.tenant_user_directory cd on cd.tenant_id = d.tenant_id and cd.membership_id = c.confirmed_by_membership_id
        order by d.dataset_code`,
    );
    return rows.map((row) => {
      const certStatus = (row as unknown as { cert_status: CertStatus | null }).cert_status;
      return {
        subject: 'DATASET' as const,
        key: row.id,
        version: Number(row.version),
        status: certStatus ?? 'DRAFT',
        origin: 'TENANT' as const,
        actor: person(row.actor_membership_id ?? null, row.actor_name ?? null),
        confirmedBy: person(row.confirmed_by_membership_id ?? null, row.confirmed_name ?? null),
        note: row.note ?? null,
        at: row.created_at ?? null,
        seq: row.seq ?? 0,
        datasetId: row.id,
        code: row.dataset_code,
        title: row.title,
        datasetStatus: row.status,
        lastCertifiedVersion: row.last_certified === null ? null : Number(row.last_certified),
      };
    });
  }

  /** The dataset a command is about: its current version, or undefined when it does not exist in the tenant. */
  async datasetVersion(tx: TenantTx, datasetId: string): Promise<number | undefined> {
    const [row] = await tx.query<{ version: string }>('select version::text as version from machvon.bi_dataset where id = $1::uuid', [datasetId]);
    return row === undefined ? undefined : Number(row.version);
  }

  /** The latest revision of every metric of the registry in the four words of the certification. The registry keeps its own certification (publication requests); this is a read of it, never a second one. */
  async metricCertifications(tx: TenantTx): Promise<MetricCertification[]> {
    const rows = await tx.query<{ id: string; code: string; revision: number; status: string; origin: string; certified_by: string | null; certified_name: string | null; certified_at: string | null }>(
      `select distinct on (m.code) m.id, m.code, m.revision, m.status, m.origin, m.certified_by, d.display_name as certified_name, ${ISO('m.certified_at')} as certified_at
         from machvon.metric_definition m left join machvon.tenant_user_directory d on d.tenant_id = m.tenant_id and d.membership_id = m.certified_by
        order by m.code, m.revision desc`,
    );
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      revision: row.revision,
      status: VIEW_OF_REGISTRY[row.status] ?? 'DRAFT',
      registryStatus: row.status,
      origin: row.origin,
      certifiedBy: person(row.certified_by, row.certified_name),
      certifiedAt: row.certified_at,
    }));
  }

  /**
   * Adds the line of a move: the kernel judges it (no skipped step, a second person certifies, a reason for sending back or making obsolete), the next number of the version is taken under a lock on the subject (two writers
   * of one subject go one after the other), and the line is appended. The version of a dataset must be the one in force now: a certificate of an older definition is not given.
   */
  async transition(tx: TenantTx, input: { subject: CertSubject; key: string; version: number; to: CertStatus; actor: string; note?: string | undefined; now: Date }): Promise<{ id: string; line: CertLine; previous: CertStatus; seq: number }> {
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`analytics_certification:${input.subject}:${input.key}`]);
    const log = await this.log(tx, input.subject, input.key);
    const ofVersion = log.filter((entry) => entry.version === input.version);
    const last = ofVersion[ofVersion.length - 1];
    const lines = ofVersion.map((entry) => ({ version: entry.version, ...toLine(entry) }));
    const current = currentCertification(lines, input.version);
    const line = nextCertification(current, input.to, { actor: input.actor, note: input.note, at: input.now.toISOString() });
    const seq = (last?.seq ?? 0) + 1;
    let id = '';
    try {
      const [inserted] = await tx.query<{ id: string }>(
        `insert into machvon.analytics_certification (tenant_id, subject, subject_key, version, seq, status, actor_membership_id, confirmed_by_membership_id, note)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, $3::bigint, $4, $5, $6::uuid, $7::uuid, $8) returning id`,
        [input.subject, input.key, input.version, seq, line.status, line.actor, line.status === 'CONFIRMED' ? line.actor : line.confirmedBy, line.note],
      );
      id = (inserted as { id: string }).id;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
      throw error;
    }
    return { id, line, previous: current?.status ?? 'DRAFT', seq };
  }
}

export type { ScopeBuilder };
