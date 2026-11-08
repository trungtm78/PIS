import {
  DomainError,
  TRANSMITTAL_RULE_TYPE,
  assertAnswerAllowed,
  assertContainerMove,
  assertTransmittalExtension,
  assertTransmittalShape,
  dueOnOf,
  purposeAsksAnswer,
  reviewReading,
  transmittalDefaults,
  transmittalPolicyOf,
  transmittalProgress,
  versionConflict,
} from '@machvon/kernel';
import type { ContainerState, RecipientAnswer, ReviewReading, TransmittalPolicy, TransmittalProgress, TransmittalPurpose } from '@machvon/kernel';
import { resolveDocument } from './gov12-documents.ts';
import type { DocumentRefKind } from './gov12-documents.ts';
import { DAY, ISO, readPolicy } from './gov12-policy.ts';
import type { PolicyReading } from './gov12-policy.ts';
import type { TenantTx } from './tenant-database.ts';

export interface ContainerRow {
  id: string;
  projectId: string;
  documentId: string;
  documentKind: DocumentRefKind;
  revisionLabel: string;
  title: string;
  contentSha256: string;
  state: ContainerState;
  authorId: string;
  stateChangedAt: string;
  version: number;
}

export interface MoveRow {
  id: string;
  fromState: string | null;
  toState: string;
  actorId: string;
  transmittalId: string | null;
  reason: string | null;
  at: string;
}

export interface RecipientRow {
  id: string;
  recipientId: string;
  required: boolean;
  dueOn: string | null;
  extendedDueOn: string | null;
  extensionReason: string | null;
  answer: RecipientAnswer | null;
  answerComment: string | null;
  answeredOn: string | null;
  review: ReviewReading;
}

export interface ItemRow {
  id: string;
  containerId: string;
  documentId: string;
  revisionLabel: string;
  title: string;
  contentSha256: string;
}

export interface TransmittalRow {
  id: string;
  projectId: string;
  number: string;
  purpose: TransmittalPurpose;
  subject: string;
  message: string | null;
  sentOn: string;
  sentBy: string;
  reviewDays: number | null;
  ruleVersion: number;
  supersedesId: string | null;
  supersededById: string | null;
  version: number;
}

export interface TransmittalReading {
  transmittal: TransmittalRow;
  items: ItemRow[];
  recipients: RecipientRow[];
  progress: TransmittalProgress;
}

type Raw = Record<string, unknown>;

const CONTAINER_COLUMNS = `id, project_id, document_id, document_kind, revision_label, title, content_sha256, state, author_membership_id, ${ISO('state_changed_at')} as state_changed_at, version`;
const toContainer = (row: Raw): ContainerRow => ({
  id: row.id as string,
  projectId: row.project_id as string,
  documentId: row.document_id as string,
  documentKind: row.document_kind as DocumentRefKind,
  revisionLabel: row.revision_label as string,
  title: row.title as string,
  contentSha256: (row.content_sha256 as string).trim(),
  state: row.state as ContainerState,
  authorId: row.author_membership_id as string,
  stateChangedAt: row.state_changed_at as string,
  version: Number(row.version),
});

const TRANSMITTAL_COLUMNS = `id, project_id, number, purpose, subject, message, ${DAY('sent_on')} as sent_on, sent_by, review_days, rule_version, supersedes_id, superseded_by_id, version`;
const toTransmittal = (row: Raw): TransmittalRow => ({
  id: row.id as string,
  projectId: row.project_id as string,
  number: row.number as string,
  purpose: row.purpose as TransmittalPurpose,
  subject: row.subject as string,
  message: (row.message as string | null) ?? null,
  sentOn: row.sent_on as string,
  sentBy: row.sent_by as string,
  reviewDays: (row.review_days as number | null) ?? null,
  ruleVersion: row.rule_version as number,
  supersedesId: (row.supersedes_id as string | null) ?? null,
  supersededById: (row.superseded_by_id as string | null) ?? null,
  version: Number(row.version),
});

/**
 * Document containers and transmittals (G4-11). A container is a document of DOC held in a state; a transmittal sends containers to people and asks for answers by a day fixed by the rule of the day of sending. Nothing in
 * a sent transmittal changes: the answers and the one extension are the only writes, and the database holds that (V2603). The kernel judges every move; this store only reads the facts and writes the result.
 */
export class DocTransmittalStore {
  policy(tx: TenantTx, today: string): Promise<PolicyReading<TransmittalPolicy>> {
    return readPolicy(tx, TRANSMITTAL_RULE_TYPE, today, transmittalPolicyOf, transmittalDefaults);
  }

  async registerContainer(tx: TenantTx, input: { projectId: string; documentId: string; documentKind: DocumentRefKind; revisionLabel: string }, author: string): Promise<{ container: ContainerRow; created: boolean }> {
    const [project] = await tx.query<{ id: string }>('select id from machvon.project where id = $1::uuid', [input.projectId]);
    if (project === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    const document = await resolveDocument(tx, input.documentKind, input.documentId);
    if (document === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'document_id');
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.doc_container (tenant_id, project_id, document_id, document_kind, revision_label, title, content_sha256, author_membership_id)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid) on conflict (tenant_id, document_id, revision_label) do nothing returning id`,
      [input.projectId, input.documentId, input.documentKind, input.revisionLabel.trim(), document.title.slice(0, 300), document.sha256, author],
    );
    const [row] = await tx.query<Raw>(`select ${CONTAINER_COLUMNS} from machvon.doc_container where document_id = $1::uuid and revision_label = $2`, [input.documentId, input.revisionLabel.trim()]);
    const container = toContainer(row as Raw);
    if (inserted.length === 1) await this.move(tx, container.id, null, 'WIP', author, null, null);
    return { container, created: inserted.length === 1 };
  }

  private async move(tx: TenantTx, id: string, from: string | null, to: string, actor: string, transmittalId: string | null, reason: string | null): Promise<void> {
    await tx.query(
      `insert into machvon.doc_container_move (tenant_id, container_id, from_state, to_state, actor_membership_id, transmittal_id, reason) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::uuid, $5::uuid, $6)`,
      [id, from, to, actor, transmittalId, reason],
    );
  }

  async findContainer(tx: TenantTx, id: string, lock = false): Promise<ContainerRow | undefined> {
    const [row] = await tx.query<Raw>(`select ${CONTAINER_COLUMNS} from machvon.doc_container where id = $1::uuid${lock ? ' for update' : ''}`, [id]);
    return row === undefined ? undefined : toContainer(row);
  }

  async listContainers(tx: TenantTx, filter: { projectId?: string | undefined; state?: ContainerState | undefined; limit: number; offset: number }): Promise<ContainerRow[]> {
    const rows = await tx.query<Raw>(
      `select ${CONTAINER_COLUMNS} from machvon.doc_container where ($1::uuid is null or project_id = $1::uuid) and ($2::text is null or state = $2) order by created_at desc, id limit $3 offset $4`,
      [filter.projectId ?? null, filter.state ?? null, filter.limit, filter.offset],
    );
    return rows.map(toContainer);
  }

  async moves(tx: TenantTx, containerId: string): Promise<MoveRow[]> {
    const rows = await tx.query<Raw>(`select id, from_state, to_state, actor_membership_id, transmittal_id, reason, ${ISO('at')} as at from machvon.doc_container_move where container_id = $1::uuid order by at, id`, [containerId]);
    return rows.map((row) => ({ id: row.id as string, fromState: (row.from_state as string | null) ?? null, toState: row.to_state as string, actorId: row.actor_membership_id as string, transmittalId: (row.transmittal_id as string | null) ?? null, reason: (row.reason as string | null) ?? null, at: row.at as string }));
  }

  /** The answers of the latest transmittal for review or approval that carried this very version of the document (the hash the recipients saw is the hash of the container). */
  async latestProgress(tx: TenantTx, container: ContainerRow, today: string): Promise<TransmittalProgress | null> {
    const [row] = await tx.query<{ id: string }>(
      `select t.id from machvon.doc_transmittal t join machvon.doc_transmittal_item i on i.tenant_id = t.tenant_id and i.transmittal_id = t.id
        where i.container_id = $1::uuid and i.content_sha256 = $2 and t.purpose <> 'FOR_INFORMATION' and t.superseded_by_id is null order by t.created_at desc, t.sent_on desc, t.id desc limit 1`,
      [container.id, container.contentSha256],
    );
    if (row === undefined) return null;
    return (await this.read(tx, row.id, today))?.progress ?? null;
  }

  async moveContainer(tx: TenantTx, id: string, expectedVersion: number, to: ContainerState, actor: string, reason: string | null, today: string): Promise<ContainerRow> {
    const container = await this.findContainer(tx, id, true);
    if (container === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (container.version !== expectedVersion) throw versionConflict(container.version);
    const latest = await this.latestProgress(tx, container, today);
    assertContainerMove({ from: container.state, to, actorId: actor, authorId: container.authorId, reason: reason === null ? null : reason.trim(), latest });
    await tx.query('update machvon.doc_container set state = $2, state_changed_at = now(), version = version + 1 where id = $1::uuid', [id, to]);
    await this.move(tx, id, container.state, to, actor, null, reason === null ? null : reason.trim());
    return (await this.findContainer(tx, id)) as ContainerRow;
  }

  /**
   * Sends a transmittal. The containers must be of the project and carry the hash they have today, which is what the recipients are shown; the due days come from the rule of today and the version of the rule
   * is kept. A transmittal for review moves its WIP containers to SHARED in the same transaction (a document is shared because somebody was asked to look at it).
   */
  async send(
    tx: TenantTx,
    input: { projectId: string; number: string; purpose: TransmittalPurpose; subject: string; message: string | null; containerIds: string[]; recipients: Array<{ membershipId: string; required: boolean }>; supersedesId: string | null },
    actor: string,
    today: string,
  ): Promise<TransmittalReading> {
    assertTransmittalShape({ purpose: input.purpose, documentIds: input.containerIds, recipients: input.recipients });
    if (new Set(input.recipients.map((recipient) => recipient.membershipId)).size !== input.recipients.length) throw new DomainError('VALIDATION_FAILED', 422, 'recipients');
    const [project] = await tx.query<{ id: string }>('select id from machvon.project where id = $1::uuid', [input.projectId]);
    if (project === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'project_id');
    const containers: ContainerRow[] = [];
    for (const containerId of input.containerIds) {
      const container = await this.findContainer(tx, containerId, true);
      if (container === undefined || container.projectId !== input.projectId) throw new DomainError('VALIDATION_FAILED', 422, 'containers');
      if (container.state === 'ARCHIVE') throw new DomainError('TRANSMITTAL_STATE_INVALID', 409, 'containers');
      const document = await resolveDocument(tx, container.documentKind, container.documentId);
      // What is sent is what the document says today: a document that changed since it was registered is registered again as a new revision, not sent under the old label.
      if (document === undefined || document.sha256 !== container.contentSha256) throw new DomainError('TRANSMITTAL_DOCUMENT_CHANGED', 409, 'containers');
      containers.push(container);
    }
    for (const recipient of input.recipients) {
      const [member] = await tx.query<{ id: string }>('select id from machvon.membership where id = $1::uuid', [recipient.membershipId]);
      if (member === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'recipients');
    }
    let supersedes: TransmittalRow | undefined;
    if (input.supersedesId !== null) {
      const [row] = await tx.query<Raw>(`select ${TRANSMITTAL_COLUMNS} from machvon.doc_transmittal where id = $1::uuid for update`, [input.supersedesId]);
      supersedes = row === undefined ? undefined : toTransmittal(row);
      if (supersedes === undefined || supersedes.projectId !== input.projectId) throw new DomainError('VALIDATION_FAILED', 422, 'supersedes_id');
      if (supersedes.supersededById !== null) throw new DomainError('TRANSMITTAL_STATE_INVALID', 409, 'supersedes_id');
    }
    const reading = await this.policy(tx, today);
    const days = input.purpose === 'FOR_INFORMATION' ? null : input.purpose === 'FOR_REVIEW' ? reading.policy.review_days : reading.policy.approval_days;
    const inserted = await tx.query<{ id: string }>(
      `insert into machvon.doc_transmittal (tenant_id, project_id, number, purpose, subject, message, sent_on, sent_by, review_days, rule_version, supersedes_id)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4, $5, $6::date, $7::uuid, $8, $9, $10::uuid) returning id`,
      [input.projectId, input.number.trim(), input.purpose, input.subject.trim(), input.message === null ? null : input.message.trim(), today, actor, days, reading.version, input.supersedesId],
    );
    const id = (inserted[0] as { id: string }).id;
    for (const container of containers) {
      await tx.query(
        `insert into machvon.doc_transmittal_item (tenant_id, transmittal_id, container_id, document_id, revision_label, title, content_sha256) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
        [id, container.id, container.documentId, container.revisionLabel, container.title, container.contentSha256],
      );
    }
    const due = dueOnOf(input.purpose, today, reading.policy);
    for (const recipient of input.recipients) {
      await tx.query(
        `insert into machvon.doc_transmittal_recipient (tenant_id, transmittal_id, recipient_membership_id, required, due_on) values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::date)`,
        [id, recipient.membershipId, recipient.required && purposeAsksAnswer(input.purpose), due],
      );
    }
    if (supersedes !== undefined) await tx.query('update machvon.doc_transmittal set superseded_by_id = $2::uuid, version = version + 1 where id = $1::uuid', [supersedes.id, id]);
    if (input.purpose !== 'FOR_INFORMATION') {
      for (const container of containers) {
        if (container.state === 'WIP') {
          await tx.query(`update machvon.doc_container set state = 'SHARED', state_changed_at = now(), version = version + 1 where id = $1::uuid`, [container.id]);
          await this.move(tx, container.id, 'WIP', 'SHARED', actor, id, null);
        }
      }
    }
    return (await this.read(tx, id, today)) as TransmittalReading;
  }

  async read(tx: TenantTx, id: string, today: string): Promise<TransmittalReading | undefined> {
    const [row] = await tx.query<Raw>(`select ${TRANSMITTAL_COLUMNS} from machvon.doc_transmittal where id = $1::uuid`, [id]);
    if (row === undefined) return undefined;
    const transmittal = toTransmittal(row);
    const policy = (await this.policy(tx, today)).policy;
    const items = (
      await tx.query<Raw>('select id, container_id, document_id, revision_label, title, content_sha256 from machvon.doc_transmittal_item where transmittal_id = $1::uuid order by title, id', [id])
    ).map((entry) => ({ id: entry.id as string, containerId: entry.container_id as string, documentId: entry.document_id as string, revisionLabel: entry.revision_label as string, title: entry.title as string, contentSha256: (entry.content_sha256 as string).trim() }));
    const recipients = (
      await tx.query<Raw>(
        `select id, recipient_membership_id, required, ${DAY('due_on')} as due_on, ${DAY('extended_due_on')} as extended_due_on, extension_reason, answer, answer_comment, ${DAY('answered_on')} as answered_on
           from machvon.doc_transmittal_recipient where transmittal_id = $1::uuid order by required desc, id`,
        [id],
      )
    ).map((entry): RecipientRow => {
      const due = ((entry.extended_due_on as string | null) ?? (entry.due_on as string | null)) ?? null;
      const answeredOn = (entry.answered_on as string | null) ?? null;
      return {
        id: entry.id as string,
        recipientId: entry.recipient_membership_id as string,
        required: entry.required as boolean,
        dueOn: (entry.due_on as string | null) ?? null,
        extendedDueOn: (entry.extended_due_on as string | null) ?? null,
        extensionReason: (entry.extension_reason as string | null) ?? null,
        answer: (entry.answer as RecipientAnswer | null) ?? null,
        answerComment: (entry.answer_comment as string | null) ?? null,
        answeredOn,
        review: reviewReading({ dueOn: due, required: entry.required as boolean, answeredOn }, today, policy),
      };
    });
    return { transmittal, items, recipients, progress: transmittalProgress(recipients.map((entry) => ({ required: entry.required, answer: entry.answer, review: entry.review }))) };
  }

  async list(tx: TenantTx, filter: { projectId?: string | undefined; limit: number; offset: number }): Promise<TransmittalRow[]> {
    const rows = await tx.query<Raw>(`select ${TRANSMITTAL_COLUMNS} from machvon.doc_transmittal where ($1::uuid is null or project_id = $1::uuid) order by sent_on desc, id limit $2 offset $3`, [filter.projectId ?? null, filter.limit, filter.offset]);
    return rows.map(toTransmittal);
  }

  /** The transmittals that wait for the answer of one person, with the day each is due. */
  async inbox(tx: TenantTx, membershipId: string, today: string): Promise<Array<{ transmittal: TransmittalRow; recipient: RecipientRow }>> {
    const rows = await tx.query<{ id: string }>(
      `select t.id from machvon.doc_transmittal t join machvon.doc_transmittal_recipient r on r.tenant_id = t.tenant_id and r.transmittal_id = t.id
        where r.recipient_membership_id = $1::uuid and r.answer is null and r.required and t.superseded_by_id is null order by coalesce(r.extended_due_on, r.due_on), t.id`,
      [membershipId],
    );
    const out: Array<{ transmittal: TransmittalRow; recipient: RecipientRow }> = [];
    for (const row of rows) {
      const reading = await this.read(tx, row.id, today);
      const recipient = reading?.recipients.find((entry) => entry.recipientId === membershipId);
      if (reading !== undefined && recipient !== undefined) out.push({ transmittal: reading.transmittal, recipient });
    }
    return out;
  }

  /** A recipient answers for themselves, once. */
  async answer(tx: TenantTx, transmittalId: string, actor: string, input: { answer: RecipientAnswer; comment: string | null }, today: string): Promise<TransmittalReading> {
    const [row] = await tx.query<{ id: string; answer: string | null; required: boolean; superseded: string | null }>(
      `select r.id, r.answer, r.required, t.superseded_by_id::text as superseded from machvon.doc_transmittal_recipient r join machvon.doc_transmittal t on t.tenant_id = r.tenant_id and t.id = r.transmittal_id
        where r.transmittal_id = $1::uuid and r.recipient_membership_id = $2::uuid for update of r`,
      [transmittalId, actor],
    );
    // A person who is not a recipient is told the transmittal does not exist.
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (row.superseded !== null) throw new DomainError('TRANSMITTAL_STATE_INVALID', 409, 'superseded');
    assertAnswerAllowed({ answer: input.answer, comment: input.comment === null ? null : input.comment.trim(), alreadyAnswered: row.answer !== null });
    await tx.query('update machvon.doc_transmittal_recipient set answer = $2, answer_comment = $3, answered_on = $4::date, answered_at = now() where id = $1::uuid', [row.id, input.answer, input.comment === null ? null : input.comment.trim(), today]);
    return (await this.read(tx, transmittalId, today)) as TransmittalReading;
  }

  /** The sender moves the due day of a recipient once, forward, with a reason. */
  async extend(tx: TenantTx, transmittalId: string, recipientId: string, newDueOn: string, reason: string, actor: string, today: string): Promise<TransmittalReading> {
    const [transmittal] = await tx.query<{ sent_by: string }>('select sent_by from machvon.doc_transmittal where id = $1::uuid', [transmittalId]);
    if (transmittal === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    if (transmittal.sent_by !== actor) throw new DomainError('SCOPE_DENIED', 403, 'actor');
    const [row] = await tx.query<{ id: string; due_on: string | null; extended: string | null; answer: string | null }>(
      `select id, ${DAY('due_on')} as due_on, ${DAY('extended_due_on')} as extended, answer from machvon.doc_transmittal_recipient where transmittal_id = $1::uuid and id = $2::uuid for update`,
      [transmittalId, recipientId],
    );
    if (row === undefined || row.due_on === null) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'recipient_id');
    if (row.answer !== null) throw new DomainError('TRANSMITTAL_STATE_INVALID', 409, 'answer');
    const policy = (await this.policy(tx, today)).policy;
    assertTransmittalExtension({ dueOn: row.due_on, newDueOn, alreadyExtended: row.extended !== null, reason: reason.trim() }, policy);
    await tx.query('update machvon.doc_transmittal_recipient set extended_due_on = $2::date, extension_reason = $3 where id = $1::uuid', [row.id, newDueOn, reason.trim()]);
    return (await this.read(tx, transmittalId, today)) as TransmittalReading;
  }

  /** The transmittals with a required answer past its day, for the lists that watch deadlines. */
  async overdue(tx: TenantTx, today: string): Promise<number> {
    const [row] = await tx.query<{ n: string }>(
      `select count(*)::text as n from machvon.doc_transmittal_recipient r join machvon.doc_transmittal t on t.tenant_id = r.tenant_id and t.id = r.transmittal_id
        where r.required and r.answer is null and t.superseded_by_id is null and coalesce(r.extended_due_on, r.due_on) < $1::date`,
      [today],
    );
    return Number((row as { n: string }).n);
  }
}
