import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SeedContext } from '../context.ts';
import type { Obj } from '../context.ts';
import { made, once, remembered } from './shared.ts';
import { asVersion } from '../context.ts';
import TEXTS from './data/doc.json' with { type: 'json' };
import ENTERPRISE_TEXTS from './data/doc.enterprise.json' with { type: 'json' };
import { textsOf } from '../../../support/texts.ts';
import { clipPlan } from '../clip/plan.ts';

/** The enterprise clip dataset writes the same documents in the words of the enterprise (data/doc.enterprise.json), never those of the province. */
const ENTERPRISE = clipPlan()?.dataset === 'enterprise';
const tx = textsOf(ENTERPRISE ? (ENTERPRISE_TEXTS as typeof TEXTS) : TEXTS);
/** A value the enterprise dataset writes in its own words where the guide keeps the province's: symbols and codes, the projects a paper is about, the sums it quotes. */
const ent = <T>(province: T, enterprise: T): T => (ENTERPRISE ? enterprise : province);
/** Recipient codes (external agencies) and the keys of the two project decisions / dossiers. */
const KBNN_CODE = ent('KBNN-CB', 'NHTM-DT');
const BKHDT_CODE = ent('BKHDT', 'DKVN');
const UBND_CODE = ent('UBND-CB', 'HDTV-DPM');
const REGISTER_OUT = ent('SKHDT', 'KHDT');
const KEY_DECISION_A = ent('QD-PHE-DUYET-DT205', 'QD-PHE-DUYET-PMDT154');
const KEY_DECISION_B = ent('QD-PHE-DUYET-TH012', 'QD-PHE-DUYET-PMTB164');

/**
 * Module DOC of the group `platform-records`: the office of the Department of Planning and Investment of Cao Bang at work with documents.
 *
 * The story. The office keeps its layout of Decree 30/2020 and the library of templates of the platform pack (drafted by the project board, published by the
 * leader, confirmed by the owner for the confirmed ones), the register of outgoing documents of the year (and the closed one of last year) and the register of
 * incoming letters. Over the weeks it drafts decisions, letters and reports about the three projects and the capital plan: some are still drafts, some wait for
 * review, some wait for the leader's signature, some are signed, numbered or sealed, most are issued and sent to the units, the Treasury and the Ministry; one
 * was recalled, one replaced, one corrected, one cancelled. Letters arrive from the People's Committee, the Ministry, the Treasury, the State Audit and the
 * contractors and wait in every state of the register (received, registered, assigned, processing, resolved, filed, rejected). Finished papers are filed in
 * dossiers, closed under the retention rules and handed over to the archive.
 *
 * People: `projectManager` drafts and keeps the register (the clerk), `capApprover` is the leader who reviews and signs, `owner` assigns the letters, seals and
 * issues (the API refuses the same person twice on a chain: maker is not checker).
 */

const DRAFTER = 'projectManager';
const LEADER = 'capApprover';
const OWNER = 'owner';

const AGENCY = tx('AGENCY.001');
const PARENT_AGENCY = tx('PARENT_AGENCY.002');
const PLACE = tx('PLACE.003');
const OVERRIDE = tx('OVERRIDE.004');
const GUIDE_LEGAL_REF = 'CXN-DOC-01';
/** The demo forms of the payment (payment-forms-demo.json): confirmed with a reference that says demo, never as an official form. */
const DEMO_LEGAL_REF = 'DEMO-PAY-FORMS';
const DEMO_FORM_CODES = ['DEMO-PAY-03A', 'DEMO-PAY-04A', 'DEMO-PAY-04B', 'DEMO-PAY-05A'];

const CHECKLIST = { national_title: true, motto: true, agency_name: true, number_symbol: true, summary: true, body: true, signer_title: true, recipients: true };

/** The layout of Appendix I of Decree 30/2020 (packages/kernel/src/pdf-layout.ts, ND30_A4_STANDARD): every value inside the legal range. */
const style = (sizePt: number, flags: { bold?: boolean; italic?: boolean; uppercase?: boolean } = {}) => ({ sizePt, bold: flags.bold ?? false, italic: flags.italic ?? false, uppercase: flags.uppercase ?? false });
const LAYOUT = {
  profile_code: 'ND30_A4_STANDARD',
  margins_mm: { top: 20, bottom: 20, left: 30, right: 15 },
  font_family: 'Times New Roman',
  font_substitute: 'Tinos',
  element_styles: {
    nationalTitle: style(13, { bold: true, uppercase: true }),
    motto: style(14, { bold: true }),
    agency: style(13, { bold: true, uppercase: true }),
    number: style(13),
    placeDate: style(14, { italic: true }),
    docTypeName: style(14, { bold: true, uppercase: true }),
    summary: style(14, { bold: true }),
    body: style(14),
    signerTitle: style(14, { bold: true, uppercase: true }),
    signerName: style(14, { bold: true }),
    recipientsLabel: style(12, { bold: true, italic: true }),
    recipientsList: style(11),
    pageNumber: style(14),
  },
  signature_layout: { leaderBox: { xMm: 110, yMm: 215, widthMm: 70, heightMm: 40 }, sealBox: { xMm: 95, yMm: 225, widthMm: 40, heightMm: 40 } },
  number_field_layout: { number: { xMm: 30, yMm: 42, widthMm: 40, heightMm: 6 }, symbol: { xMm: 70, yMm: 42, widthMm: 50, heightMm: 6 }, date: { xMm: 125, yMm: 50, widthMm: 60, heightMm: 6 } },
  watermark_policy: { text: tx('text.005') },
  legal_basis: tx('legal_basis.006'),
  effective_from: '2026-01-01',
};
/** The layout the DEMO payment forms stand on: the same legal ranges, a code of its own (confirmed by the stack in place of the legal officer). */const DEMO_LAYOUT = { ...LAYOUT, profile_code: 'DEMO_PAY_FORMS_A4' };

/** The document types of the office. QD (decision) is declared by the base group (clip 02); a type that exists answers DOC_TYPE_RANGE_OVERLAP and is skipped. */
const DOC_TYPES = [
  { code: 'QD', name: tx('name.007'), abbreviation: tx('abbreviation.008'), symbol_kind: 'DECISION', symbol_pattern: '{number}/{type}-{agency}', register_code: 'SO-QD' },
  { code: 'CV', name: tx('name.009'), abbreviation: 'CV', symbol_kind: 'OFFICIAL_LETTER', symbol_pattern: '{number}/{agency}-VP', register_code: 'SO-CV' },
  { code: 'BC', name: tx('name.010'), abbreviation: 'BC', symbol_kind: 'NAMED_TYPE', symbol_pattern: '{number}/{type}-{agency}', register_code: 'SO-BC' },
  { code: 'TB', name: tx('name.011'), abbreviation: 'TB', symbol_kind: 'NAMED_TYPE', symbol_pattern: '{number}/{type}-{agency}', register_code: 'SO-TB' },
  { code: 'TTR', name: tx('name.012'), abbreviation: 'TTr', symbol_kind: 'NAMED_TYPE', symbol_pattern: '{number}/{type}-{agency}', register_code: 'SO-TTR' },
  { code: 'KH', name: tx('name.013'), abbreviation: 'KH', symbol_kind: 'NAMED_TYPE', symbol_pattern: '{number}/{type}-{agency}', register_code: 'SO-KH' },
  { code: 'GM', name: tx('name.014'), abbreviation: 'GM', symbol_kind: 'NAMED_TYPE', symbol_pattern: '{number}/{type}-{agency}', register_code: 'SO-GM' },
  { code: 'BB', name: tx('name.015'), abbreviation: 'BB', symbol_kind: 'NAMED_TYPE', symbol_pattern: '{number}/{type}-{agency}', register_code: 'SO-BB' },
];
const TYPE_CODES = DOC_TYPES.map((type) => type.code);

/** The templates of the platform pack that the tenant confirms legally (the rest stay published and waiting for the confirmation, with their watermark). */
const CONFIRMED_TEMPLATES = new Set([
  'DOC-QD-CHU-TRUONG-DAU-TU',
  'DOC-QD-PHE-DUYET-DU-AN',
  'DOC-QD-GIAO-KE-HOACH-VON',
  'DOC-QD-DIEU-CHINH-KE-HOACH-VON',
  'DOC-CV-DON-DOC-GIAI-NGAN',
  'DOC-CV-DE-NGHI-DIEU-CHUYEN-VON',
  'DOC-CV-GIAI-TRINH',
  'MNE-CV3665-WEEKLY',
]);

interface Pack {
  templates: Array<{ template_code: string; group_code: string; doc_type_code: string; form_code: string | null; title: string; source_module: string | null; body_blocks: unknown; placeholder_schema: unknown; legal_basis: string; watermark_text: string; effective_from: string; effective_until?: string | null }>;
}

function readPack(): Pack {
  // The platform pack is data of the API (template-pack.json); the seed reads the same file the platform would load.
  const directory = join(process.cwd(), '..', 'api', 'src', 'modules', 'doc');
  const pack = JSON.parse(readFileSync(join(directory, 'template-pack.json'), 'utf8')) as Pack;
  // The demo forms of the payment are part of the clip data: the Treasury forms of a payment request need templates in force.
  const demo = JSON.parse(readFileSync(join(directory, 'payment-forms-demo.json'), 'utf8')) as Pack;
  return { ...pack, templates: [...pack.templates, ...demo.templates] };
}

// ---- the recipients ------------------------------------------------------------------------------------------------------------------

const KBNN = { kind: 'EXTERNAL_AGENCY', name: tx('name.016'), code: KBNN_CODE };
const BO_KHDT = { kind: 'EXTERNAL_AGENCY', name: tx('name.017'), code: BKHDT_CODE };
const UBND_TINH = { kind: 'EXTERNAL_AGENCY', name: tx('name.018'), code: UBND_CODE };
const STC = (ctx: SeedContext) => ({ kind: 'INTERNAL_UNIT', name: tx('name.019'), code: 'CB-STC', unit_id: ctx.unitId('CB-STC') });
const QLDA = (ctx: SeedContext) => ({ kind: 'INTERNAL_UNIT', name: tx('name.020'), code: 'CB-SKHDT-QLDA', unit_id: ctx.unitId('CB-SKHDT-QLDA') });
const VP = (ctx: SeedContext) => ({ kind: 'INTERNAL_UNIT', name: tx('name.021'), code: 'CB-SKHDT-VP', unit_id: ctx.unitId('CB-SKHDT-VP') });

// ---- the outgoing documents ------------------------------------------------------------------------------------------------------------

/** How far a document goes on its chain; `extra` is what happens to it after the stage (recall, replacement, correction, cancellation, return). */
type Stage = 'draft' | 'review' | 'submitted' | 'signed' | 'numbered' | 'sealed' | 'issued';
type After = 'none' | 'recall' | 'replace' | 'correct' | 'cancel' | 'return' | 'distribute' | 'distribute-ack' | 'distribute-mixed' | 'verify';

interface OutgoingPlan {
  key: string;
  type: string;
  template: string;
  title: string;
  unit: 'CB-SKHDT-QLDA' | 'CB-SKHDT-VP' | 'CB-SKHDT';
  urgency?: 'NORMAL' | 'KHAN' | 'THUONG_KHAN' | 'HOA_TOC';
  subject?: { module: string; project: string };
  payload: Record<string, unknown>;
  amountVnd?: string;
  recipients: (ctx: SeedContext) => Obj[];
  upTo: Stage;
  after?: After;
}

const ORDER: Stage[] = ['draft', 'review', 'submitted', 'signed', 'numbered', 'sealed', 'issued'];
const reached = (plan: OutgoingPlan, stage: Stage): boolean => ORDER.indexOf(plan.upTo) >= ORDER.indexOf(stage);

function plans(ctx: SeedContext): OutgoingPlan[] {
  const sign = { signer_title: tx('signer_title.022'), signer_name: ctx.nameOf(LEADER) };
  const face = { agency: AGENCY, parent_agency: PARENT_AGENCY, place: PLACE, ...sign };
  return [
    {
      key: KEY_DECISION_A, type: 'QD', template: 'DOC-QD-PHE-DUYET-DU-AN', unit: 'CB-SKHDT-QLDA', subject: { module: 'PRJ', project: ent('DA-DT205', 'DA-PMDT154') }, upTo: 'issued', after: 'distribute-ack',
      title: tx('title.023'),
      payload: { ...face, title: tx('title.023'), grounds: tx('grounds.024'), body: tx('body.025') },
      amountVnd: ent('150000000000', '251000000000'),
      recipients: (c) => [QLDA(c), STC(c), KBNN],
    },
    {
      key: KEY_DECISION_B, type: 'QD', template: 'DOC-QD-PHE-DUYET-DU-AN', unit: 'CB-SKHDT-QLDA', subject: { module: 'PRJ', project: ent('DA-TH012', 'DA-PMTB164') }, upTo: 'issued', after: 'distribute',
      title: tx('title.026'),
      payload: { ...face, title: tx('title.026'), grounds: tx('grounds.027'), body: tx('body.028') },
      amountVnd: ent('45000000000', '86000000000'),
      recipients: (c) => [QLDA(c), STC(c)],
    },
    {
      key: 'QD-GIAO-KE-HOACH-VON', type: 'QD', template: 'DOC-QD-GIAO-KE-HOACH-VON', unit: 'CB-SKHDT', upTo: 'issued', after: 'distribute-ack',
      title: tx('title.029'),
      payload: { ...face, title: tx('title.029'), grounds: tx('grounds.030'), body: tx('body.031') },
      amountVnd: '210000000000',
      recipients: (c) => [QLDA(c), STC(c), KBNN],
    },
    {
      key: 'CV-DON-DOC-GIAI-NGAN', type: 'CV', template: 'DOC-CV-DON-DOC-GIAI-NGAN', unit: 'CB-SKHDT-VP', urgency: 'KHAN', upTo: 'issued', after: 'distribute-mixed',
      title: tx('title.032'),
      payload: { ...face, subject: tx('subject.033'), greeting: tx('greeting.034'), body: tx('body.035') },
      recipients: (c) => [QLDA(c), STC(c), KBNN],
    },
    {
      key: 'CV-GIAI-TRINH-BO', type: 'CV', template: 'DOC-CV-GIAI-TRINH', unit: 'CB-SKHDT-VP', upTo: 'issued', after: 'verify',
      title: tx('title.036'),
      payload: { ...face, subject: tx('subject.037'), greeting: tx('greeting.038'), body: tx('body.039') },
      recipients: () => [BO_KHDT],
    },
    {
      key: 'CV-DE-NGHI-DIEU-CHUYEN-VON', type: 'CV', template: 'DOC-CV-DE-NGHI-DIEU-CHUYEN-VON', unit: 'CB-SKHDT-VP', upTo: 'sealed',
      title: tx('title.040'),
      payload: { ...face, subject: tx('subject.041'), greeting: tx('greeting.042'), body: tx('body.043') },
      recipients: () => [UBND_TINH],
    },
    {
      key: 'BC-GIAI-NGAN-THANG', type: 'BC', template: 'MNE-CV3665-WEEKLY', unit: 'CB-SKHDT-VP', upTo: 'numbered',
      title: tx('title.044'),
      payload: { ...face, title: tx('title.044'), period: tx('period.045'), body: tx('body.046') },
      recipients: () => [UBND_TINH, BO_KHDT],
    },
    {
      key: 'TB-GIAO-BAN', type: 'CV', template: 'DOC-CV-DON-DOC-GIAI-NGAN', unit: 'CB-SKHDT-VP', upTo: 'signed',
      title: tx('title.047'),
      payload: { ...face, subject: tx('title.047'), greeting: tx('greeting.048'), body: tx('body.049') },
      recipients: (c) => [QLDA(c), VP(c), STC(c)],
    },
    {
      key: 'TTR-DIEU-CHINH-VON', type: 'QD', template: 'DOC-QD-DIEU-CHINH-KE-HOACH-VON', unit: 'CB-SKHDT-QLDA', upTo: 'submitted', urgency: 'THUONG_KHAN',
      title: tx('title.050'),
      payload: { ...face, title: tx('title.050'), body: tx('body.051') },
      amountVnd: ent('18000000000', '20000000000'),
      recipients: () => [UBND_TINH],
    },
    {
      key: 'KH-KIEM-TRA-TIEN-DO', type: 'QD', template: 'DOC-QD-CHU-TRUONG-DAU-TU', unit: 'CB-SKHDT-VP', upTo: 'review',
      title: tx('title.052'),
      payload: { ...face, title: tx('title.052'), body: tx('body.053') },
      recipients: (c) => [QLDA(c), STC(c)],
    },
    {
      key: 'CV-HUONG-DAN-QUYET-TOAN', type: 'CV', template: 'DOC-CV-GIAI-TRINH', unit: 'CB-SKHDT-VP', upTo: 'review',
      title: tx('title.054'),
      payload: { ...face, subject: tx('subject.055'), greeting: tx('greeting.056'), body: tx('body.057') },
      recipients: (c) => [QLDA(c)],
    },
    {
      key: 'QD-THANH-LAP-TO-GIUP-VIEC', type: 'QD', template: 'DOC-QD-THANH-LAP-BAN-QLDA', unit: 'CB-SKHDT-VP', upTo: 'draft',
      title: tx('title.058'),
      payload: { ...face, title: tx('title.058'), grounds: tx('grounds.059'), body: tx('body.060') },
      recipients: (c) => [VP(c), QLDA(c)],
    },
    {
      key: 'GM-HOP-CHU-DAU-TU', type: 'CV', template: 'DOC-CV-GIAI-TRINH', unit: 'CB-SKHDT-VP', upTo: 'draft', urgency: 'HOA_TOC',
      title: tx('title.061'),
      payload: { ...face, subject: tx('subject.062'), greeting: tx('greeting.063'), body: tx('body.064') },
      recipients: (c) => [QLDA(c), STC(c)],
    },
    {
      key: 'BC-TRA-LAI', type: 'BC', template: 'MNE-CV3665-WEEKLY', unit: 'CB-SKHDT-QLDA', upTo: 'draft', after: 'return',
      title: tx('title.065'),
      payload: { ...face, title: tx('title.065'), period: tx('period.066'), body: tx('body.067') },
      recipients: (c) => [VP(c)],
    },
    {
      key: 'QD-THU-HOI', type: 'QD', template: 'DOC-QD-CHU-TRUONG-DAU-TU', unit: 'CB-SKHDT', upTo: 'issued', after: 'recall',
      title: tx('title.068'),
      payload: { ...face, title: tx('title.068'), grounds: tx('grounds.069'), body: tx('body.070') },
      amountVnd: ent('9500000000', '840000000000'),
      recipients: (c) => [QLDA(c), STC(c)],
    },
    {
      key: 'QD-THAY-THE', type: 'QD', template: 'DOC-QD-DIEU-CHINH-KE-HOACH-VON', unit: 'CB-SKHDT', upTo: 'issued', after: 'replace',
      title: tx('title.071'),
      payload: { ...face, title: tx('title.071'), grounds: tx('grounds.072'), body: tx('body.073') },
      amountVnd: ent('12000000000', '20000000000'),
      recipients: (c) => [QLDA(c), STC(c)],
    },
    {
      key: 'CV-DINH-CHINH', type: 'CV', template: 'DOC-CV-DON-DOC-GIAI-NGAN', unit: 'CB-SKHDT-VP', upTo: 'issued', after: 'correct',
      title: tx('title.074'),
      payload: { ...face, subject: tx('subject.075'), greeting: tx('greeting.056'), body: tx('body.076') },
      recipients: (c) => [QLDA(c)],
    },
    {
      key: 'QD-HUY-DU-THAO', type: 'QD', template: 'DOC-QD-PHE-DUYET-KHLCNT', unit: 'CB-SKHDT-QLDA', upTo: 'draft', after: 'cancel',
      title: tx('title.077'),
      payload: { ...face, title: tx('title.078'), grounds: tx('grounds.079'), body: tx('body.080') },
      recipients: (c) => [QLDA(c)],
    },
  ];
}

interface State extends Obj {
  id: string;
  version: number;
  documentId: string;
}

/** The ids and the version of a document on its chain, kept after every stage so that a second run goes on from where the first one stopped. */
async function stage(ctx: SeedContext, plan: OutgoingPlan, name: string, previous: State | undefined, run: (state: State | undefined) => Promise<Obj>): Promise<State> {
  return once(ctx, `doc.out.${plan.key}.${name}`, async () => ({ ...(previous ?? {}), ...(await run(previous)) }) as State) as Promise<State>;
}

async function projectId(ctx: SeedContext, code: string): Promise<string | undefined> {
  const project = await ctx.find(DRAFTER, '/resources/project', (row) => row.code === code || row.project_code === code);
  return project?.id as string | undefined;
}

async function createDraft(ctx: SeedContext, plan: OutgoingPlan): Promise<Obj> {
  const subject = plan.subject === undefined ? undefined : await projectId(ctx, plan.subject.project);
  const reply = await ctx.must<Obj>(DRAFTER, 'POST', '/outgoing-documents', {
    doc_type_code: plan.type,
    template_code: plan.template,
    title: plan.title,
    drafting_unit_id: ctx.unitId(plan.unit),
    urgency: plan.urgency ?? 'NORMAL',
    circulation: 'INTERNAL_CIRCULATION',
    payload: { ...plan.payload, ...(plan.amountVnd === undefined ? {} : { amount_vnd: plan.amountVnd }) },
    recipients: plan.recipients(ctx),
    signer_user_id: ctx.person(LEADER).membershipId,
    signing_mode: 'DIRECT',
    ...(subject === undefined || plan.subject === undefined ? {} : { subject_module: plan.subject.module, subject_id: subject }),
  });
  return { id: reply.resource_id, version: reply.resource_version, documentId: reply.document_id };
}

/** Takes the document of a plan as far as the plan says. */
async function advance(ctx: SeedContext, plan: OutgoingPlan, registerId: string): Promise<State> {
  let state = await stage(ctx, plan, 'draft', undefined, () => createDraft(ctx, plan));
  if (reached(plan, 'review')) {
    state = await stage(ctx, plan, 'review', state, async (s) => {
      const reply = await ctx.command(DRAFTER, `/outgoing-documents/${s!.id}/review-submission`, {}, { version: s!.version });
      return { version: reply.resource_version };
    });
  }
  if (reached(plan, 'submitted')) {
    state = await stage(ctx, plan, 'submitted', state, async (s) => {
      const reply = await ctx.command(LEADER, `/outgoing-documents/${s!.id}/review-decision`, { decision: 'APPROVE', comment: tx('comment.081'), format_checklist: CHECKLIST }, { version: s!.version });
      return { version: reply.resource_version };
    });
  }
  if (reached(plan, 'signed')) {
    state = await stage(ctx, plan, 'signed', state, async (s) => {
      const started = await ctx.must<Obj>(LEADER, 'POST', `/outgoing-documents/${s!.id}/leader-signing-sessions`, {}, { version: s!.version });
      const done = await ctx.must<Obj>(LEADER, 'POST', `/signing-sessions/${started.resource_id}/completion`, {}, { version: asVersion(started.resource_version) });
      return { version: done.document_version };
    });
  }
  if (reached(plan, 'numbered')) {
    state = await stage(ctx, plan, 'numbered', state, async (s) => {
      const reply = await ctx.must<Obj>(DRAFTER, 'POST', `/outgoing-documents/${s!.id}/numbering`, { register_id: registerId, issued_on: ctx.today, clerk_note: tx('clerk_note.082') }, { version: s!.version });
      return { version: reply.resource_version, number: reply.number, symbol: reply.symbol };
    });
  }
  if (reached(plan, 'sealed')) {
    state = await stage(ctx, plan, 'sealed', state, async (s) => {
      const started = await ctx.must<Obj>(OWNER, 'POST', `/outgoing-documents/${s!.id}/organization-seal-sessions`, {}, { version: s!.version });
      const done = await ctx.must<Obj>(OWNER, 'POST', `/signing-sessions/${started.resource_id}/completion`, {}, { version: asVersion(started.resource_version) });
      return { version: done.document_version };
    });
  }
  if (reached(plan, 'issued')) {
    state = await stage(ctx, plan, 'issued', state, async (s) => {
      const reply = await ctx.must<Obj>(OWNER, 'POST', `/outgoing-documents/${s!.id}/issuance`, { unconfirmed_override_reason: OVERRIDE, distribute_now: false }, { version: s!.version });
      return { version: reply.resource_version, number: reply.document_number, symbol: reply.symbol };
    });
  }
  return state;
}

async function currentVersion(ctx: SeedContext, id: string): Promise<number> {
  const document = await ctx.get<Obj>(DRAFTER, `/outgoing-documents/${id}`);
  return Number(document.version ?? document.resource_version);
}

/** What happens to a document after it has gone as far as its plan says. */
async function afterwards(ctx: SeedContext, plan: OutgoingPlan, state: State, registerId: string): Promise<void> {
  const key = (name: string): string => `doc.out.${plan.key}.${name}`;
  switch (plan.after) {
    case 'distribute':
    case 'distribute-ack':
    case 'distribute-mixed': {
      const sent = await once(ctx, key('distributed'), async () => {
        const recipients = plan.recipients(ctx);
        const channelOf = (recipient: Obj): string => (recipient.kind === 'INTERNAL_UNIT' ? 'INTERNAL' : plan.after === 'distribute-mixed' && recipient.code === KBNN_CODE ? 'EMAIL' : recipient.code === BKHDT_CODE ? 'LGSP' : 'PAPER_HANDOVER');
        const reply = await ctx.must<Obj>(DRAFTER, 'POST', `/outgoing-documents/${state.id}/distributions`, { recipients: recipients.map((recipient) => ({ ...recipient, channel: channelOf(recipient), acknowledgement_required: true })) }, { version: await currentVersion(ctx, state.id) });
        // the answer lists the distributions it made
        return { distributions: ((reply.distributions ?? []) as Obj[]).map((row) => ({ id: String(row.distribution_id), status: String(row.status ?? '') })) };
      });
      if (plan.after === 'distribute-ack' || plan.after === 'distribute-mixed') {
        let first = true;
        for (const row of sent.distributions as Array<{ id: string }>) {
          await once(ctx, key(`ack.${row.id}`), async () => {
            // A recipient acknowledges; the others are still waiting (the ledger of distributions shows both).
            if (!first && plan.after === 'distribute-mixed') return { skipped: true, acknowledged: null };
            first = false;
            const found = await ctx.attempt(DRAFTER, 'POST', `/document-distributions/${row.id}/acknowledgement`, { acknowledged_at: new Date().toISOString(), external_ref: tx('external_ref.083') }, { version: await distributionVersion(ctx, state.id, row.id) });
            return { skipped: false, acknowledged: found.ok };
          });
        }
      }
      break;
    }
    case 'verify':
      await once(ctx, key('verified'), async () => {
        const timeline = await ctx.get<Obj>(DRAFTER, `/documents/${state.documentId}/timeline`);
        const version = (timeline.versions as Obj[] | undefined)?.slice(-1)[0];
        if (version === undefined) return { skipped: true, overall: null, ok: null };
        const reply = await ctx.attempt(DRAFTER, 'POST', `/document-versions/${version.id}/signature-verifications`, { policy: 'STRICT' });
        return { skipped: false, overall: String(reply.json.overall ?? ''), ok: reply.ok };
      });
      break;
    case 'recall':
      await once(ctx, key('recalled'), async () => {
        const reply = await ctx.must<Obj>(OWNER, 'POST', `/outgoing-documents/${state.id}/recall`, { reason: tx('reason.084'), notify_recipients: true }, { version: await currentVersion(ctx, state.id) });
        return { version: reply.resource_version };
      });
      break;
    case 'correct':
      await once(ctx, key('corrected'), async () => {
        const reply = await ctx.must<Obj>(DRAFTER, 'POST', `/outgoing-documents/${state.id}/corrections`, { correction_text: tx('correction_text.085'), reason: tx('reason.086') }, { version: await currentVersion(ctx, state.id) });
        return { correctionId: reply.resource_id };
      });
      break;
    case 'replace': {
      const replacement = await once(ctx, key('replacement'), async () => {
        const reply = await ctx.must<Obj>(DRAFTER, 'POST', `/outgoing-documents/${state.id}/replacements`, { title: tx('title.087'), reason: tx('reason.088') }, { version: await currentVersion(ctx, state.id) });
        return { id: reply.resource_id, version: reply.resource_version, documentId: reply.document_id };
      });
      await advanceExisting(ctx, { ...plan, key: `${plan.key}.REPLACEMENT`, title: 'replacement' }, replacement as State, registerId);
      break;
    }
    case 'cancel':
      await once(ctx, key('cancelled'), async () => {
        const reply = await ctx.must<Obj>(DRAFTER, 'POST', `/outgoing-documents/${state.id}/cancellation`, { reason: tx('reason.089'), reject_code: 'CANCELLED_BY_DRAFTER' }, { version: await currentVersion(ctx, state.id) });
        return { version: reply.resource_version };
      });
      break;
    case 'return':
      await once(ctx, key('returned'), async () => {
        // The draft is sent for review and the leader returns it with the reason; it is a draft again.
        const review = await ctx.command(DRAFTER, `/outgoing-documents/${state.id}/review-submission`, {}, { version: await currentVersion(ctx, state.id) });
        const reply = await ctx.must<Obj>(LEADER, 'POST', `/outgoing-documents/${state.id}/review-decision`, { decision: 'RETURN', comment: tx('comment.090') }, { version: asVersion(review.resource_version) });
        return { version: reply.resource_version };
      });
      break;
    default:
      break;
  }
}

/** The replacement of a document is drafted by the product from the old one; it goes on the chain like any draft, and the old one becomes REPLACED when it is issued. */
async function advanceExisting(ctx: SeedContext, plan: OutgoingPlan, draft: State, registerId: string): Promise<void> {
  let state = draft;
  const step = async (name: string, run: (s: State) => Promise<Obj>): Promise<void> => {
    state = await once(ctx, `doc.out.${plan.key}.${name}`, async () => ({ ...state, ...(await run(state)) }) as State);
  };
  await step('review', async (s) => ({ version: (await ctx.command(DRAFTER, `/outgoing-documents/${s.id}/review-submission`, {}, { version: s.version })).resource_version }));
  await step('submitted', async (s) => ({ version: (await ctx.command(LEADER, `/outgoing-documents/${s.id}/review-decision`, { decision: 'APPROVE', comment: tx('comment.091'), format_checklist: CHECKLIST }, { version: s.version })).resource_version }));
  await step('signed', async (s) => {
    const started = await ctx.must<Obj>(LEADER, 'POST', `/outgoing-documents/${s.id}/leader-signing-sessions`, {}, { version: s.version });
    return { version: (await ctx.must<Obj>(LEADER, 'POST', `/signing-sessions/${started.resource_id}/completion`, {}, { version: asVersion(started.resource_version) })).document_version };
  });
  await step('numbered', async (s) => ({ version: (await ctx.must<Obj>(DRAFTER, 'POST', `/outgoing-documents/${s.id}/numbering`, { register_id: registerId, issued_on: ctx.today }, { version: s.version })).resource_version }));
  await step('sealed', async (s) => {
    const started = await ctx.must<Obj>(OWNER, 'POST', `/outgoing-documents/${s.id}/organization-seal-sessions`, {}, { version: s.version });
    return { version: (await ctx.must<Obj>(OWNER, 'POST', `/signing-sessions/${started.resource_id}/completion`, {}, { version: asVersion(started.resource_version) })).document_version };
  });
  await step('issued', async (s) => ({ version: (await ctx.must<Obj>(OWNER, 'POST', `/outgoing-documents/${s.id}/issuance`, { unconfirmed_override_reason: OVERRIDE }, { version: s.version })).resource_version }));
}

async function distributionVersion(ctx: SeedContext, outgoingId: string, distributionId: string): Promise<number> {
  const document = await ctx.get<Obj>(DRAFTER, `/outgoing-documents/${outgoingId}`);
  const row = ((document.distributions ?? []) as Obj[]).find((candidate) => candidate.id === distributionId);
  return Number(row?.version ?? 1);
}

// ---- the setup: layout, types, registers, templates, retention rules ---------------------------------------------------------------------

async function layoutProfile(ctx: SeedContext, layout: typeof LAYOUT = LAYOUT): Promise<string> {
  const published = await ctx.find(DRAFTER, '/document-layout-profiles', (row) => row.profile_code === layout.profile_code && row.status === 'PUBLISHED');
  if (published !== undefined) return String(published.id);
  const draft = await ctx.find(DRAFTER, '/document-layout-profiles', (row) => row.profile_code === layout.profile_code && row.status === 'DRAFT');
  const created = draft === undefined ? await ctx.command(DRAFTER, '/document-layout-profiles', layout) : { resource_id: String(draft.id), resource_version: Number(draft.version) };
  // The leader publishes what the clerk drafted (four eyes).
  await ctx.command(LEADER, `/document-layout-profiles/${created.resource_id}/publish`, {}, { version: created.resource_version });
  made(ctx, 'DOC', 'layout-profile', layout.profile_code, 'published, waiting for legal confirmation', { id: created.resource_id, screen: 'DOC-16' });
  return created.resource_id;
}

async function documentTypes(ctx: SeedContext): Promise<void> {
  for (const type of DOC_TYPES) {
    await once(ctx, `doc.type.${type.code}`, async () => {
      const reply = await ctx.call(DRAFTER, 'POST', '/document-types', { ...type, legal_basis: tx('legal_basis.092'), effective_from: '2026-01-01' });
      if (!reply.ok && reply.json.code !== 'DOC_TYPE_RANGE_OVERLAP') ctx.expectOk(reply, `define the document type ${type.code}`);
      made(ctx, 'DOC', 'document-type', type.code, reply.ok ? 'defined' : 'existing', { screen: 'DOC-21' });
      return { ok: true };
    });
  }
}

/** The registers of the office: outgoing documents of the year (open), of last year (closed), the register of documents signed elsewhere (mirrored) and the incoming letters. */
async function registers(ctx: SeedContext): Promise<{ outgoing: string; incoming: string }> {
  const open = async (code: string, name: string, direction: 'OUTGOING' | 'INCOMING', year: number, mode: 'MANAGED' | 'MIRRORED', unit: string): Promise<string> => {
    const existing = await ctx.find(DRAFTER, '/document-number-registers', (row) => row.register_code === code && Number(row.year) === year);
    if (existing !== undefined) return String(existing.id);
    const reply = await ctx.command(DRAFTER, '/document-number-registers', { register_code: code, name, direction, organization_unit_id: ctx.unitId(unit), year, mode, scope_doc_types: TYPE_CODES });
    made(ctx, 'DOC', 'register', `${code}/${year}`, `${direction} ${mode}`, { id: reply.resource_id, screen: 'DOC-21' });
    return reply.resource_id;
  };
  const outgoing = await open(REGISTER_OUT, tx('outgoing.093', ctx.year), 'OUTGOING', ctx.year, 'MANAGED', 'CB-SKHDT-VP');
  const incoming = await open('DEN', tx('incoming.094', ctx.year), 'INCOMING', ctx.year, 'MANAGED', 'CB-SKHDT-VP');
  await open('ZEXT', tx('registers.095', ctx.year), 'OUTGOING', ctx.year, 'MIRRORED', 'CB-SKHDT-VP');
  const previous = await open(REGISTER_OUT, tx('outgoing.093', ctx.year - 1), 'OUTGOING', ctx.year - 1, 'MANAGED', 'CB-SKHDT-VP');
  await once(ctx, `doc.register.closed.${ctx.year - 1}`, async () => {
    const found = await ctx.get<Obj>(DRAFTER, `/document-number-registers/${previous}/entries`).catch(() => ({}) as Obj);
    void found;
    const register = await ctx.find(DRAFTER, '/document-number-registers', (row) => row.id === previous);
    await ctx.attempt(DRAFTER, 'POST', `/document-number-registers/${previous}/closure`, { reason: tx('reason.096') }, { version: Number(register?.version ?? 1) });
    return { ok: true };
  });
  return { outgoing, incoming };
}

/** The 25 templates of the platform pack: drafted by the project board, published by the leader, and the main ones confirmed by the owner with an evidence document. */
async function templates(ctx: SeedContext, layoutId: string, evidenceDocument: string, demoLayoutId: string): Promise<void> {
  for (const template of readPack().templates) {
    await once(ctx, `doc.template.${template.template_code}`, async () => {
      const existing = await ctx.find(DRAFTER, '/document-templates', (row) => row.template_code === template.template_code);
      let id: string;
      let version: number;
      let status: string;
      if (existing === undefined) {
        const created = await ctx.command(DRAFTER, '/document-templates', {
          template_code: template.template_code,
          group_code: template.group_code,
          doc_type_code: template.doc_type_code,
          ...(template.form_code === null ? {} : { form_code: template.form_code }),
          title: template.title,
          ...(template.source_module === null ? {} : { source_module: template.source_module }),
          layout_profile_id: DEMO_FORM_CODES.includes(template.template_code) ? demoLayoutId : layoutId,
          body_blocks: { blocks: template.body_blocks },
          placeholder_schema: template.placeholder_schema,
          legal_basis: template.legal_basis,
          effective_from: template.effective_from,
          watermark_text: template.watermark_text,
        });
        id = created.resource_id;
        version = created.resource_version;
        status = 'DRAFT';
      } else {
        id = String(existing.id);
        version = Number(existing.version);
        status = String(existing.status);
      }
      if (status === 'DRAFT') {
        const published = await ctx.command(LEADER, `/document-templates/${id}/publish`, {}, { version });
        version = published.resource_version;
      }
      if (CONFIRMED_TEMPLATES.has(template.template_code) || DEMO_FORM_CODES.includes(template.template_code)) {
        await ctx.command(OWNER, `/document-templates/${id}/legal-confirmation`, { legal_confirmation_ref: DEMO_FORM_CODES.includes(template.template_code) ? DEMO_LEGAL_REF : GUIDE_LEGAL_REF, evidence_document_id: evidenceDocument, note: tx('note.097') }, { version });
      }
      made(ctx, 'DOC', 'template', template.template_code, CONFIRMED_TEMPLATES.has(template.template_code) || DEMO_FORM_CODES.includes(template.template_code) ? 'published and legally confirmed' : 'published, waiting for confirmation', { id, screen: 'DOC-14' });
      return { id };
    });
  }
}

const RETENTION_RULES = [
  { rule_set: 'TT74_2025_BTC', category_code: 'HO_SO_DU_AN', class_code: 'Y20', start_basis: 'FROM_CLOSED', handover_months: 12, legal_basis: tx('legal_basis.098'), confirm: true },
  { rule_set: 'TT74_2025_BTC', category_code: 'HO_SO_QUYET_TOAN', class_code: 'PERMANENT', start_basis: 'FROM_SETTLEMENT', handover_months: 12, legal_basis: tx('legal_basis.099'), confirm: true },
  { rule_set: 'TT10_2022_BNV', category_code: 'VAN_BAN_DIEU_HANH', class_code: 'Y10', start_basis: 'FROM_ISSUED', handover_months: 12, legal_basis: tx('legal_basis.100'), confirm: true },
  { rule_set: 'TENANT_CUSTOM', category_code: 'HO_SO_GIAI_NGAN', class_code: 'Y10', start_basis: 'FROM_CLOSED', handover_months: 6, legal_basis: tx('legal_basis.101'), confirm: false },
  { rule_set: 'TENANT_CUSTOM', category_code: 'TAI_LIEU_THAM_KHAO', class_code: 'Y5', start_basis: 'FROM_ISSUED', handover_months: 6, legal_basis: tx('legal_basis.101'), confirm: false },
];

async function retentionRules(ctx: SeedContext, evidenceDocument: string): Promise<void> {
  for (const rule of RETENTION_RULES) {
    await once(ctx, `doc.retention.${rule.category_code}`, async () => {
      const { confirm, ...body } = rule;
      const existing = await ctx.find(DRAFTER, '/document-retention-rules', (row) => row.category_code === rule.category_code);
      const created = existing === undefined ? await ctx.command(DRAFTER, '/document-retention-rules', { ...body, effective_from: '2026-01-01' }) : { resource_id: String(existing.id), resource_version: Number(existing.version) };
      const published = await ctx.command(LEADER, `/document-retention-rules/${created.resource_id}/publish`, {}, { version: created.resource_version });
      if (confirm) await ctx.command(OWNER, `/document-retention-rules/${created.resource_id}/legal-confirmation`, { legal_confirmation_ref: 'CXN-05', evidence_document_id: evidenceDocument, note: tx('note.102') }, { version: published.resource_version });
      made(ctx, 'DOC', 'retention-rule', rule.category_code, `${rule.class_code}${confirm ? ' confirmed' : ' waiting for confirmation'}`, { id: created.resource_id, screen: 'DOC-18' });
      return { id: created.resource_id };
    });
  }
}

// ---- incoming letters --------------------------------------------------------------------------------------------------------------------

type IncomingTarget = 'received' | 'registered' | 'assigned' | 'processing' | 'resolved' | 'filed' | 'rejected';
interface IncomingPlan {
  key: string;
  title: string;
  type: string;
  channel: 'PAPER_SCAN' | 'EMAIL' | 'LGSP' | 'PORTAL' | 'UPLOAD';
  sender: string;
  symbol: string;
  issuedDaysAgo: number;
  urgency?: 'NORMAL' | 'KHAN' | 'THUONG_KHAN' | 'HOA_TOC';
  classification?: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'PERSONAL';
  target: IncomingTarget;
  directive?: string;
  dueInDays?: number;
  handler?: 'projectManager' | 'owner';
  unit?: 'CB-SKHDT-QLDA' | 'CB-SKHDT-VP' | 'CB-STC';
  resolution?: string;
  dossier?: string;
  rejection?: string;
}

const INCOMING: IncomingPlan[] = [
  { key: 'CV-1523', title: tx('title.103'), type: 'CV', channel: 'LGSP', sender: tx('name.018'), symbol: ent('1523/UBND-KTTH', '1523/HĐTV-KHĐT'), issuedDaysAgo: 6, urgency: 'KHAN', target: 'assigned', directive: tx('directive.104'), dueInDays: 5, handler: 'projectManager', unit: 'CB-SKHDT-QLDA' },
  { key: 'CV-3472', title: tx('title.105'), type: 'CV', channel: 'EMAIL', sender: tx('name.017'), symbol: tx('symbol.106'), issuedDaysAgo: 9, urgency: 'THUONG_KHAN', target: 'processing', directive: tx('directive.107'), dueInDays: 1, handler: 'projectManager', unit: 'CB-SKHDT-VP' },
  { key: 'TB-412', title: tx('title.108'), type: 'TB', channel: 'PAPER_SCAN', sender: tx('name.016'), symbol: ent('412/TB-KBNN', '412/TB-NHTM'), issuedDaysAgo: 14, target: 'filed', directive: tx('directive.109'), dueInDays: 7, handler: 'projectManager', unit: 'CB-SKHDT-QLDA', resolution: tx('resolution.110'), dossier: 'HO_SO_GIAI_NGAN' },
  { key: 'CV-87', title: tx('title.111'), type: 'CV', channel: 'EMAIL', sender: tx('sender.112'), symbol: tx('symbol.113'), issuedDaysAgo: 3, target: 'registered' },
  { key: 'CV-219', title: tx('title.114'), type: 'CV', channel: 'UPLOAD', sender: tx('sender.115'), symbol: ent('219/STC-QLNS', '219/TCKT-QLV'), issuedDaysAgo: 1, target: 'received' },
  { key: 'GM-64', title: tx('title.116'), type: 'GM', channel: 'LGSP', sender: tx('sender.117'), symbol: ent('64/GM-VPUBND', '64/GM-VPTCT'), issuedDaysAgo: 2, urgency: 'HOA_TOC', target: 'assigned', directive: tx('directive.118'), dueInDays: 0, handler: 'owner', unit: 'CB-SKHDT-VP' },
  { key: 'CV-905', title: tx('title.119'), type: 'CV', channel: 'PAPER_SCAN', sender: tx('sender.120'), symbol: ent('905/KTNN-KV1', '905/KTĐL-PM'), issuedDaysAgo: 8, urgency: 'KHAN', classification: 'CONFIDENTIAL', target: 'processing', directive: tx('directive.121'), dueInDays: 4, handler: 'projectManager', unit: 'CB-SKHDT-QLDA' },
  { key: 'CV-5588', title: tx('title.122'), type: 'CV', channel: 'EMAIL', sender: tx('sender.123'), symbol: ent('5588/SXD-QLXD', '5588/QV-KD'), issuedDaysAgo: 5, target: 'rejected', rejection: tx('rejection.124') },
  { key: 'QD-301', title: tx('title.125'), type: 'QD', channel: 'LGSP', sender: tx('name.018'), symbol: tx('symbol.126'), issuedDaysAgo: 20, target: 'filed', directive: tx('directive.127'), dueInDays: 3, handler: 'projectManager', unit: 'CB-SKHDT-VP', resolution: tx('resolution.128'), dossier: 'HO_SO_KE_HOACH_VON' },
  { key: 'BC-78', title: tx('title.129'), type: 'BC', channel: 'PORTAL', sender: tx('sender.130'), symbol: ent('78/BC-UBND', '78/BC-NMĐPM'), issuedDaysAgo: 4, target: 'registered' },
  { key: 'CV-1190', title: tx('title.131'), type: 'CV', channel: 'LGSP', sender: tx('sender.132'), symbol: tx('symbol.133'), issuedDaysAgo: 11, target: 'resolved', directive: tx('directive.134'), dueInDays: 6, handler: 'projectManager', unit: 'CB-SKHDT-QLDA', resolution: tx('resolution.135') },
  { key: 'TB-33', title: tx('title.136'), type: 'TB', channel: 'PAPER_SCAN', sender: tx('sender.137'), symbol: ent('33/TB-BL', '33/TB-BA'), issuedDaysAgo: 7, target: 'resolved', directive: tx('directive.138'), dueInDays: 2, handler: 'owner', unit: 'CB-SKHDT-VP', resolution: tx('resolution.139') },
  { key: 'CV-612', title: tx('title.140'), type: 'CV', channel: 'EMAIL', sender: tx('sender.141'), symbol: ent('612/BDT-CSDT', '612/ATSKMT-KHĐT'), issuedDaysAgo: 2, target: 'assigned', directive: tx('directive.142'), dueInDays: 9, handler: 'projectManager', unit: 'CB-SKHDT-QLDA' },
];

async function incomingLetters(ctx: SeedContext, registerId: string, dossiers: Map<string, string>): Promise<void> {
  const order: IncomingTarget[] = ['received', 'registered', 'assigned', 'processing', 'resolved', 'filed'];
  for (const plan of INCOMING) {
    await once(ctx, `doc.in.${plan.key}`, async () => {
      const reached = (target: IncomingTarget): boolean => order.indexOf(plan.target) >= order.indexOf(target) && plan.target !== 'rejected';
      const existing = await ctx.find(DRAFTER, '/incoming-documents', (row) => row.original_symbol === plan.symbol);
      let id: string;
      let version: number;
      if (existing !== undefined) {
        id = String(existing.id);
        version = Number(existing.version);
      } else {
        const pdf = ctx.pdf(plan.sender.toUpperCase(), `So: ${plan.symbol}`, plan.title);
        const uploaded = ctx.expectOk(await ctx.upload<{ file_object_key: string; file_sha256: string }>(DRAFTER, '/document-files', { filename: `${plan.key.toLowerCase()}.pdf`, buffer: pdf }), `upload the letter ${plan.symbol}`).json;
        const received = await ctx.must<Obj>(DRAFTER, 'POST', '/incoming-documents', {
          title: plan.title,
          doc_type_code: plan.type,
          channel: plan.channel,
          file_object_key: uploaded.file_object_key,
          file_sha256: uploaded.file_sha256,
          original_symbol: plan.symbol,
          original_issued_on: ctx.day(-plan.issuedDaysAgo),
          sender_name: plan.sender,
          urgency: plan.urgency ?? 'NORMAL',
          classification: plan.classification ?? 'INTERNAL',
        });
        id = String(received.resource_id);
        version = Number(received.resource_version);
      }
      if (plan.target === 'rejected') {
        const rejected = await ctx.command(DRAFTER, `/incoming-documents/${id}/rejection`, { rejection_reason: plan.rejection }, { version });
        return { id, version: rejected.resource_version, documentId: String((await ctx.get<Obj>(DRAFTER, `/incoming-documents/${id}`)).document_id) };
      }
      if (reached('registered')) {
        const registered = await ctx.command(DRAFTER, `/incoming-documents/${id}/registration`, { register_id: registerId }, { version });
        version = registered.resource_version;
      }
      if (reached('assigned')) {
        const handler = plan.handler ?? 'projectManager';
        const assigned = await ctx.command(OWNER, `/incoming-documents/${id}/assignment`, { assigned_unit_id: ctx.unitId(plan.unit ?? 'CB-SKHDT-QLDA'), assignee_user_id: ctx.person(handler).membershipId, leader_directive: plan.directive, due_on: ctx.day(plan.dueInDays ?? 5) }, { version });
        version = assigned.resource_version;
      }
      if (reached('processing')) {
        const started = await ctx.command(plan.handler ?? 'projectManager', `/incoming-documents/${id}/processing`, {}, { version });
        version = started.resource_version;
      }
      if (reached('resolved')) {
        const resolved = await ctx.command(plan.handler ?? 'projectManager', `/incoming-documents/${id}/resolution`, { resolution_summary: plan.resolution }, { version });
        version = resolved.resource_version;
      }
      if (reached('filed') && plan.dossier !== undefined) {
        const dossierId = dossiers.get(plan.dossier);
        if (dossierId !== undefined) {
          const filed = await ctx.command(DRAFTER, `/incoming-documents/${id}/filing`, { dossier_id: dossierId }, { version });
          version = filed.resource_version;
        }
      }
      const letter = await ctx.get<Obj>(DRAFTER, `/incoming-documents/${id}`);
      return { id, version, documentId: String(letter.document_id) };
    });
    made(ctx, 'DOC', 'incoming-document', plan.symbol, plan.target, { screen: 'DOC-12' });
  }
}

// ---- dossiers ----------------------------------------------------------------------------------------------------------------------------

interface DossierPlan {
  key: string;
  code: string;
  title: string;
  category: string;
  unit: 'CB-SKHDT-QLDA' | 'CB-SKHDT-VP';
  project?: string;
  outgoing: string[];
  end: 'open' | 'closed' | 'handed-over';
}

const DOSSIERS: DossierPlan[] = [
  { key: 'HO_SO_DU_AN', code: ent('HS-DT205-2026', 'HS-PMDT154-2026'), title: tx('title.143'), category: 'HO_SO_DU_AN', unit: 'CB-SKHDT-QLDA', project: ent('DA-DT205', 'DA-PMDT154'), outgoing: [KEY_DECISION_A], end: 'closed' },
  { key: 'HO_SO_KE_HOACH_VON', code: 'HS-KHV-2027', title: tx('title.144'), category: 'VAN_BAN_DIEU_HANH', unit: 'CB-SKHDT-VP', outgoing: ['QD-GIAO-KE-HOACH-VON'], end: 'open' },
  { key: 'HO_SO_GIAI_NGAN', code: 'HS-GN-Q3-2026', title: tx('title.145'), category: 'HO_SO_GIAI_NGAN', unit: 'CB-SKHDT-VP', outgoing: ['CV-DON-DOC-GIAI-NGAN'], end: 'open' },
  { key: 'HO_SO_TH012', code: ent('HS-TH012-2026', 'HS-PMTB164-2026'), title: tx('title.146'), category: 'HO_SO_DU_AN', unit: 'CB-SKHDT-QLDA', project: ent('DA-TH012', 'DA-PMTB164'), outgoing: [KEY_DECISION_B], end: 'handed-over' },
  { key: 'HO_SO_THAM_KHAO', code: 'HS-TK-2026', title: tx('title.147'), category: 'TAI_LIEU_THAM_KHAO', unit: 'CB-SKHDT-VP', outgoing: [], end: 'open' },
];

/** The dossiers exist before the letters are filed; each is opened, filled with its issued documents and, when its plan says so, closed and handed over. */
async function openDossiers(ctx: SeedContext): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const plan of DOSSIERS) {
    const state = await once(ctx, `doc.dossier.${plan.key}.open`, async () => {
      const existing = await ctx.find(DRAFTER, '/dossiers', (row) => row.dossier_code === plan.code);
      if (existing !== undefined) return { id: String(existing.id) };
      const project = plan.project === undefined ? undefined : await projectId(ctx, plan.project);
      const created = await ctx.command(DRAFTER, '/dossiers', { dossier_code: plan.code, year: ctx.year, title: plan.title, organization_unit_id: ctx.unitId(plan.unit), category_code: plan.category, ...(project === undefined ? {} : { subject_module: 'PRJ', subject_id: project }) });
      made(ctx, 'DOC', 'dossier', plan.code, 'opened', { id: created.resource_id, screen: 'DOC-17' });
      return { id: created.resource_id };
    });
    ids.set(plan.key, state.id);
  }
  return ids;
}

async function fillDossiers(ctx: SeedContext, issued: Map<string, State>): Promise<void> {
  const ids = new Map<string, string>();
  for (const plan of DOSSIERS) ids.set(plan.key, (await once(ctx, `doc.dossier.${plan.key}.open`, async () => ({ id: '' }))).id);
  for (const plan of DOSSIERS) {
    const dossierId = ids.get(plan.key)!;
    for (const key of plan.outgoing) {
      const document = issued.get(key);
      if (document === undefined) continue;
      await once(ctx, `doc.dossier.${plan.key}.item.${key}`, async () => {
        await ctx.attempt(DRAFTER, 'POST', `/dossiers/${dossierId}/items`, { document_id: document.documentId }, { version: await dossierVersion(ctx, dossierId) });
        return { ok: true };
      });
    }
    if (plan.end === 'open') continue;
    const closed = await once(ctx, `doc.dossier.${plan.key}.closed`, async () => {
      const reply = await ctx.attempt(DRAFTER, 'POST', `/dossiers/${dossierId}/closure`, { settlement_closed_on: ctx.day(-3) }, { version: await dossierVersion(ctx, dossierId) });
      return { ok: reply.ok };
    });
    if (plan.end === 'handed-over' && closed.ok) {
      await once(ctx, `doc.dossier.${plan.key}.handed`, async () => {
        const reply = await ctx.attempt(DRAFTER, 'POST', `/dossiers/${dossierId}/handover`, { archive_ref: `LT-2026/${plan.code}`, handed_over_at: new Date(Date.now() - 1000).toISOString() }, { version: await dossierVersion(ctx, dossierId) });
        return { ok: reply.ok };
      });
    }
  }
}

async function dossierVersion(ctx: SeedContext, id: string): Promise<number> {
  const dossier = await ctx.get<Obj>(DRAFTER, `/dossiers/${id}`);
  return Number(dossier.version ?? dossier.resource_version);
}

// ---- the entry ----------------------------------------------------------------------------------------------------------------------------

export async function seedDoc(ctx: SeedContext): Promise<void> {
  const layoutId = await ctx.step('DOC', 'layout profile of Decree 30/2020', () => layoutProfile(ctx));
  // The Treasury forms are DEMO forms: they stand on a layout profile of their own, confirmed by the stack in place of the legal officer (an act outside the product), so that the
  // layout of the guide (Decree 30/2020) keeps waiting for its confirmation.
  const demoLayoutId = await ctx.step('DOC', 'layout profile of the demo payment forms', async () => {
    const id = await layoutProfile(ctx, DEMO_LAYOUT);
    if (!(await ctx.confirmLayout(DEMO_LAYOUT.profile_code, DEMO_LEGAL_REF))) ctx.warn('the stack did not confirm the layout of the demo payment forms: the Treasury forms cannot be drawn');
    return id;
  });
  await ctx.step('DOC', 'document types', () => documentTypes(ctx));
  const regs = await ctx.step('DOC', 'number registers', () => registers(ctx));

  // The decision of the People's Committee that the base group received is the evidence of the legal confirmations.
  let evidence = await ctx.find(DRAFTER, '/incoming-documents', (row) => row.original_symbol === tx('evidence.148'));
  // The enterprise dataset has no group `base`: its evidence is a decision of the board of members, received here.
  if (evidence === undefined && ENTERPRISE) {
    const received = await ctx.letter({ symbol: tx('evidence.148'), title: tx('title.125'), sender: tx('name.018'), issuedOn: ctx.day(-60) });
    evidence = { document_id: received.documentId };
  }
  if (evidence === undefined) throw new Error(tx('seedDoc.149'));
  const evidenceDocument = String(evidence.document_id);

  await ctx.step('DOC', 'template library (platform pack)', () => templates(ctx, layoutId, evidenceDocument, demoLayoutId));
  await ctx.step('DOC', 'retention rules', () => retentionRules(ctx, evidenceDocument));

  const issued = new Map<string, State>();
  await ctx.step('DOC', 'outgoing documents', async () => {
    for (const plan of plans(ctx)) {
      const state = await advance(ctx, plan, regs.outgoing);
      issued.set(plan.key, state);
      made(ctx, 'DOC', 'outgoing-document', plan.title, `${plan.upTo}${plan.after === undefined ? '' : ` then ${plan.after}`}`, { id: state.id, screen: 'DOC-03' });
      await afterwards(ctx, plan, state, regs.outgoing);
    }
  });

  const dossierIds = await ctx.step('DOC', 'dossiers opened', () => openDossiers(ctx));
  await ctx.step('DOC', 'incoming letters', () => incomingLetters(ctx, regs.incoming, dossierIds));
  await ctx.step('DOC', 'dossiers filled, closed and handed over', () => fillDossiers(ctx, issued));
  void remembered;
}
