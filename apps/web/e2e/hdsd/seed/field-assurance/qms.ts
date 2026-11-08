import { randomUUID } from 'node:crypto';
import type { SeedContext } from '../context.ts';
import type { Obj } from '../context.ts';
import { CHECKER, MAKER, OWNER, activeContracts, asString, paper, tolerate } from './shared.ts';
import { asObj } from '../context.ts';
import TEXTS from './data/qms.json' with { type: 'json' };
import { textsOf } from '../../../support/texts.ts';

const tx = textsOf(TEXTS);

/**
 * QMS: the quality of what is built. The story, for the contract of the road 205 (the busiest) and one of the health station: the site diaries of the last
 * two weeks are written (a diary of the contractor's day is a draft until the contractor signs it, which only the contractor's own guest account can do, so
 * the days stay drafts; today and a day before are missing, so the alert of missing diaries has something to show); the supervisor asks for inspections of
 * concealed work, materials, stages and safety, some are scheduled, some recorded as passed, failed or conditional, one is cancelled; the minutes of an
 * accepted inspection are drawn up and signed by the supervisor and the owner; materials go to the laboratory; and non-conformities are raised, given corrective
 * actions, answered with evidence, verified and closed, or left open as critical.
 */

type Inspection = 'MATERIAL_ENTRY' | 'CONCEALED_WORK' | 'CONSTRUCTION_STAGE' | 'PART_ACCEPTANCE' | 'COMPLETION' | 'SAFETY' | 'OTHER';

const CHECKLIST_CODES: Record<Inspection, string[]> = {
  MATERIAL_ENTRY: ['ORIGIN', 'SAMPLE'],
  CONCEALED_WORK: ['DRAWING', 'QUALITY', 'RECORD'],
  CONSTRUCTION_STAGE: ['DRAWING', 'QUALITY'],
  PART_ACCEPTANCE: ['DRAWING', 'QUALITY'],
  COMPLETION: ['DRAWING', 'QUALITY', 'DOSSIER'],
  SAFETY: ['MEASURES', 'EQUIPMENT'],
  OTHER: ['CONTENT'],
};

interface InspectionSpec {
  title: string;
  type: Inspection;
  location: string;
  requestedAgo: number;
  to: 'REQUESTED' | 'SCHEDULED' | 'PASS' | 'FAIL' | 'CONDITIONAL' | 'CANCELLED';
  note?: string;
}

const ROAD_INSPECTIONS: InspectionSpec[] = [
  { title: tx('title.001'), type: 'CONCEALED_WORK', location: tx('location.002'), requestedAgo: 21, to: 'PASS', note: tx('note.003') },
  { title: tx('title.004'), type: 'CONSTRUCTION_STAGE', location: 'Km5 - Km6', requestedAgo: 16, to: 'PASS', note: tx('note.005') },
  { title: tx('title.006'), type: 'MATERIAL_ENTRY', location: tx('location.007'), requestedAgo: 12, to: 'FAIL', note: tx('note.008') },
  { title: tx('title.009'), type: 'SAFETY', location: tx('location.010'), requestedAgo: 9, to: 'CONDITIONAL', note: tx('note.011') },
  { title: tx('title.012'), type: 'PART_ACCEPTANCE', location: 'Km0 - Km3', requestedAgo: 6, to: 'SCHEDULED' },
  { title: tx('title.013'), type: 'CONCEALED_WORK', location: tx('location.014'), requestedAgo: 3, to: 'REQUESTED' },
  { title: tx('title.015'), type: 'MATERIAL_ENTRY', location: tx('location.016'), requestedAgo: 25, to: 'CANCELLED', note: tx('note.017') },
];

const STATION_INSPECTIONS: InspectionSpec[] = [
  { title: tx('title.018'), type: 'CONCEALED_WORK', location: tx('location.019'), requestedAgo: 10, to: 'PASS', note: tx('note.020') },
  { title: tx('title.021'), type: 'SAFETY', location: tx('location.022'), requestedAgo: 4, to: 'SCHEDULED' },
];

const MATERIALS = [
  { sample: 'MAU-BT-0712', kind: tx('kind.023'), lab: tx('lab.024'), standard: 'TCVN 3118:2022', ago: 33, result: 'FAIL' as const },
  { sample: 'MAU-BT-0725', kind: tx('kind.025'), lab: tx('lab.024'), standard: 'TCVN 12252:2020', ago: 12, result: 'PASS' as const },
  { sample: 'MAU-DA-0409', kind: tx('kind.026'), lab: tx('lab.027'), standard: 'TCVN 7570:2006', ago: 14, result: 'FAIL' as const },
  { sample: 'MAU-TH-0318', kind: tx('kind.028'), lab: tx('lab.027'), standard: 'TCVN 1651-2:2018', ago: 8, result: 'PASS' as const },
  { sample: 'MAU-DT-0221', kind: tx('kind.029'), lab: tx('lab.027'), standard: 'TCVN 4201:2012', ago: 18, result: undefined },
];

interface NcrSpec {
  title: string;
  description: string;
  severity: 'MINOR' | 'MAJOR' | 'CRITICAL';
  source: 'INSPECTION' | 'MATERIAL_TEST' | 'SUPERVISOR_REMARK' | 'SELF_REPORT' | 'AUDIT';
  owner: 'projectManager' | 'owner';
  dueIn: number;
  to: 'OPEN' | 'ACTION' | 'EVIDENCE' | 'CLOSED';
  action: string;
}

const NCRS: NcrSpec[] = [
  { title: tx('title.030'), description: tx('description.031'), severity: 'MAJOR', source: 'MATERIAL_TEST', owner: 'projectManager', dueIn: -2, to: 'CLOSED', action: tx('action.032') },
  { title: tx('title.033'), description: tx('description.034'), severity: 'MAJOR', source: 'SUPERVISOR_REMARK', owner: 'owner', dueIn: 6, to: 'EVIDENCE', action: tx('action.035') },
  { title: tx('title.036'), description: tx('description.037'), severity: 'MINOR', source: 'MATERIAL_TEST', owner: 'projectManager', dueIn: 4, to: 'ACTION', action: tx('action.038') },
  { title: tx('title.039'), description: tx('description.040'), severity: 'CRITICAL', source: 'INSPECTION', owner: 'owner', dueIn: 1, to: 'OPEN', action: tx('action.041') },
];

// ---- diaries ------------------------------------------------------------------------------------------------------------------------

const WEATHER = ['NANG', 'NANG', 'MAY', 'MUA_NHO', 'NANG', 'MUA_LON', 'MAY'];
const WORK = [
  tx('WORK.042'),
  tx('WORK.043'),
  tx('WORK.044'),
  tx('WORK.045'),
  tx('WORK.046'),
  tx('WORK.047'),
  tx('WORK.048'),
];

async function diaries(ctx: SeedContext, contract: Obj, label: string, spec: { daysBack: number; skipRecent: number; keepEvery: number }): Promise<void> {
  const contractId = asString(contract.id);
  const have = new Set((await ctx.list(MAKER, '/resources/site_diary', { contract_id: contractId })).map((row) => asString(row.record_date)));
  let made = 0;
  for (let ago = spec.daysBack; ago >= spec.skipRecent; ago -= 1) {
    const date = ctx.day(-ago);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6 || have.has(date) || (ago % spec.keepEvery !== 0 && spec.keepEvery > 1)) continue;
    const index = Math.abs(ago);
    const saved = await tolerate(ctx, `diary ${label} ${date}`, () =>
      ctx.command(MAKER, '/site-diaries', {
        contract_id: contractId,
        record_date: date,
        client_operation_id: randomUUID(),
        content: {
          weather_code: WEATHER[index % WEATHER.length],
          workforce_count: 38 + (index % 6) * 4,
          work_done: WORK[index % WORK.length],
          equipment: tx('equipment.049'),
          issues: index % 5 === 0 ? tx('issues.050') : tx('issues.051'),
        },
      }),
    );
    if (saved !== undefined) made += 1;
  }
  ctx.record({ module: 'QMS', screen: 'QMS-01', kind: 'site-diaries', id: contractId, code: asString(contract.code), note: `${made} drafts` });
}

// ---- inspections -------------------------------------------------------------------------------------------------------------------

async function inspections(ctx: SeedContext, contract: Obj, list: InspectionSpec[]): Promise<Obj[]> {
  const contractId = asString(contract.id);
  const existing = await ctx.list(MAKER, '/inspections', { contract_id: contractId });
  const results: Obj[] = [];
  for (const spec of list) {
    let row = existing.find((candidate) => candidate.title === spec.title);
    if (row === undefined) {
      const made = await tolerate(ctx, `inspection ${spec.title}`, () => ctx.command(MAKER, '/inspections', { contract_id: contractId, inspection_type: spec.type, title: spec.title, location_text: spec.location, requested_for: ctx.day(-(spec.requestedAgo - 2)) }));
      if (made === undefined) continue;
      row = { id: made.resource_id, status: 'REQUESTED', version: made.resource_version, title: spec.title };
      ctx.record({ module: 'QMS', screen: 'QMS-04', kind: 'inspection', id: made.resource_id, code: spec.title.slice(0, 40), note: spec.to });
    }
    const id = asString(row.id);
    const read = (): Promise<Obj> => ctx.get(MAKER, `/inspections/${id}`);
    let detail = await read();
    if (detail.status === 'REQUESTED' && ['SCHEDULED', 'PASS', 'FAIL', 'CONDITIONAL'].includes(spec.to)) {
      await tolerate(ctx, `schedule ${spec.title}`, () =>
        ctx.command(MAKER, `/inspections/${id}/schedule`, { scheduled_at: new Date(Date.now() + (spec.to === 'SCHEDULED' ? 2 : -(spec.requestedAgo - 3)) * 86_400_000).toISOString(), participant_membership_ids: [ctx.person(CHECKER).membershipId, ctx.person(OWNER).membershipId] }, { version: Number(detail.version) }),
      );
      detail = await read();
    }
    if (detail.status === 'SCHEDULED' && ['PASS', 'FAIL', 'CONDITIONAL'].includes(spec.to)) {
      const outcome = spec.to === 'PASS' ? 'PASS' : 'FAIL';
      await tolerate(ctx, `record the result of ${spec.title}`, () =>
        ctx.command(
          MAKER,
          `/inspections/${id}/result`,
          { result: spec.to, result_note: spec.note ?? tx('result_note.052'), checklist: CHECKLIST_CODES[spec.type].map((code, index) => ({ code, outcome: spec.to === 'PASS' || index > 0 ? 'PASS' : outcome, note: spec.to === 'PASS' ? tx('note.053') : index === 0 ? spec.note : tx('note.053') })) },
          { version: Number(detail.version) },
        ),
      );
      detail = await read();
    }
    if (spec.to === 'CANCELLED' && !['CANCELLED'].includes(asString(detail.status))) {
      await tolerate(ctx, `cancel ${spec.title}`, () => ctx.command(MAKER, `/inspections/${id}/cancel`, { reason: spec.note ?? tx('reason.054') }, { version: Number(detail.version) }));
      detail = await read();
    }
    results.push(detail);
  }
  return results;
}

/** The minutes of an accepted inspection, signed by the supervisor and the owner; the contractor's signature and the leader's approval are still to come. */
async function acceptances(ctx: SeedContext, passed: Obj[]): Promise<void> {
  const existing = await ctx.list(MAKER, '/quality-acceptances');
  let n = existing.length;
  for (const [index, inspection] of passed.entries()) {
    if (index >= 2) break;
    const id = asString(inspection.id);
    if (existing.some((row) => asString(row.inspection_id ?? asObj(row.inspection).id) === id)) continue;
    n += 1;
    const minutes = await paper(ctx, { symbol: `BB-NTCL-${String(n).padStart(3, '0')}`, title: tx('title.055', asString(inspection.title)), type: 'BB', sender: tx('sender.056'), issuedOn: ctx.day(-5) });
    const made = await tolerate(ctx, `acceptance minutes for ${asString(inspection.title)}`, () =>
      ctx.command(MAKER, `/inspections/${id}/quality-acceptances`, { acceptance_scope: asString(inspection.inspection_type) === 'CONSTRUCTION_STAGE' ? 'STAGE' : 'WORK_ITEM', record_no: `BB-NTCL-${ctx.year}-${String(n).padStart(3, '0')}`, document_version_id: minutes.versionId }),
    );
    if (made === undefined) continue;
    ctx.record({ module: 'QMS', screen: 'QMS-05', kind: 'quality-acceptance', id: made.resource_id, code: `BB-NTCL-${n}`, note: 'minutes drawn up' });
    if (index === 0) {
      const signers: Array<[string, string]> = [
        [CHECKER, 'SUPERVISOR'],
        [OWNER, 'OWNER'],
      ];
      for (const [person, role] of signers) {
        await tolerate(ctx, `sign the minutes as ${role}`, () => ctx.command(person, `/quality-acceptances/${made.resource_id}/sign`, { signer_role: role, signature_method: 'IN_APP_OTP', client_operation_id: randomUUID() }));
      }
    }
  }
}

async function materials(ctx: SeedContext, contract: Obj): Promise<void> {
  const contractId = asString(contract.id);
  const existing = await ctx.list(MAKER, '/material-tests', { contract_id: contractId });
  for (const material of MATERIALS) {
    let row = existing.find((candidate) => candidate.sample_code === material.sample);
    if (row === undefined) {
      const made = await tolerate(ctx, `material test ${material.sample}`, () => ctx.command(MAKER, '/material-tests', { contract_id: contractId, sample_code: material.sample, material_kind: material.kind, lab_name: material.lab, standard_ref: material.standard, sampled_on: ctx.day(-material.ago) }));
      if (made === undefined) continue;
      row = { id: made.resource_id, status: 'REGISTERED' };
      ctx.record({ module: 'QMS', screen: 'QMS-06', kind: 'material-test', id: made.resource_id, code: material.sample, note: material.result ?? 'waiting for the laboratory' });
    }
    if (material.result !== undefined && !['PASS', 'FAIL'].includes(asString(row.result ?? row.status))) {
      const report = await paper(ctx, { symbol: `KQTN-${material.sample}`, title: tx('title.057', material.sample), type: 'BC', sender: material.lab, issuedOn: ctx.day(-(material.ago - 5)) });
      await tolerate(ctx, `result of ${material.sample}`, () =>
        ctx.command(MAKER, `/material-tests/${asString(row?.id)}/result`, {
          result: material.result,
          tested_on: ctx.day(-(material.ago - 5)),
          result_values: material.result === 'PASS' ? { ket_qua: tx('ket_qua.058') } : { ket_qua: tx('ket_qua.059') },
          report_document_version_id: report.versionId,
        }),
      );
    }
  }
}

async function nonconformances(ctx: SeedContext, contract: Obj): Promise<void> {
  const contractId = asString(contract.id);
  const existing = await ctx.list(MAKER, '/resources/quality_nonconformance', { contract_id: contractId });
  for (const spec of NCRS) {
    let row = existing.find((candidate) => candidate.title === spec.title);
    if (row === undefined) {
      const made = await tolerate(ctx, `non-conformity ${spec.title}`, () =>
        ctx.command(MAKER, '/nonconformances', {
          contract_id: contractId,
          severity: spec.severity,
          title: spec.title,
          description: spec.description,
          source_kind: spec.source,
          action_owner_id: ctx.person(spec.owner).membershipId,
          due_at: new Date(Date.now() + spec.dueIn * 86_400_000).toISOString(),
        }),
      );
      if (made === undefined) continue;
      row = { id: made.resource_id, status: 'OPEN' };
      ctx.record({ module: 'QMS', screen: 'QMS-07', kind: 'nonconformance', id: made.resource_id, code: spec.title.slice(0, 40), note: spec.severity });
    }
    const id = asString(row.id);
    const read = (): Promise<Obj> => ctx.get(MAKER, `/resources/quality_nonconformance/${id}`);
    let detail = await read();
    const actions = (): Obj[] => ((detail.corrective_actions ?? detail.actions ?? []) as Obj[]);
    if (spec.to !== 'OPEN' && actions().length === 0) {
      await tolerate(ctx, `corrective action of ${spec.title}`, () => ctx.command(MAKER, `/nonconformances/${id}/corrective-actions`, { description: spec.action, owner_membership_id: ctx.person(spec.owner).membershipId, due_at: new Date(Date.now() + Math.max(spec.dueIn, 1) * 86_400_000).toISOString() }));
      detail = await read();
    }
    const action = actions()[0];
    if (['EVIDENCE', 'CLOSED'].includes(spec.to) && action !== undefined && ['OPEN', 'ASSIGNED', 'PENDING'].includes(asString(action.status))) {
      const proof = await paper(ctx, { symbol: `KP-${id.slice(0, 8)}`, title: tx('title.060', spec.title), type: 'BB', sender: tx('sender.061'), issuedOn: ctx.day(-2) });
      await tolerate(ctx, `evidence of ${spec.title}`, () => ctx.command(spec.owner, `/corrective-actions/${asString(action.id)}/evidence`, { evidence_document_version_id: proof.versionId, note: tx('note.062') }));
      detail = await read();
    }
    const after = actions()[0];
    if (spec.to === 'CLOSED' && after !== undefined && asString(after.status) !== 'VERIFIED') {
      await tolerate(ctx, `verify ${spec.title}`, () => ctx.command(CHECKER, `/corrective-actions/${asString(after.id)}/verify`, { outcome: 'VERIFIED', verification_note: tx('verification_note.063') }));
      detail = await read();
    }
    if (spec.to === 'CLOSED' && asString(detail.status) !== 'CLOSED') {
      await tolerate(ctx, `close ${spec.title}`, () => ctx.command(MAKER, `/nonconformances/${id}/close`, { closure_note: tx('closure_note.064') }));
    }
  }
}

export async function seedQms(ctx: SeedContext): Promise<void> {
  const contracts = await activeContracts(ctx);
  if (contracts.length === 0) {
    ctx.warn('QMS: no contract is being performed (the delivery group makes them): the screens of the quality module stay empty');
    return;
  }
  const projects = new Map((await ctx.list(MAKER, '/resources/project')).map((row) => [asString(row.id), asString(row.code)]));
  const byProject = (code: string): Obj | undefined => contracts.find((row) => projects.get(asString(row.project_id)) === code);
  const road = byProject('DA-DT205') ?? contracts[0];
  const station = byProject('DA-YT007') ?? contracts.find((row) => row !== road);
  if (road === undefined) return;
  await ctx.step('QMS', `site diaries of ${asString(road.code)}`, () => diaries(ctx, road, 'road', { daysBack: 16, skipRecent: 2, keepEvery: 1 }));
  if (station !== undefined) await ctx.step('QMS', `site diaries of ${asString(station.code)}`, () => diaries(ctx, station, 'station', { daysBack: 14, skipRecent: 9, keepEvery: 2 }));
  const roadResults = await ctx.step('QMS', 'inspections of the road', () => inspections(ctx, road, ROAD_INSPECTIONS));
  if (station !== undefined) await ctx.step('QMS', 'inspections of the station', () => inspections(ctx, station, STATION_INSPECTIONS));
  const passed = roadResults.filter((row) => asString(row.result) === 'PASS' || asString(row.status) === 'PASSED');
  await ctx.step('QMS', 'minutes of acceptance', () => acceptances(ctx, passed));
  await ctx.step('QMS', 'material tests', () => materials(ctx, road));
  await ctx.step('QMS', 'non-conformities', () => nonconformances(ctx, road));
}
