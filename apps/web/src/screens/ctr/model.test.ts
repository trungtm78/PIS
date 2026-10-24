import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER,
  EMPTY_FORM,
  amountText,
  createBody,
  describeProblem,
  draftLink,
  draftsOf,
  filterContracts,
  formOf,
  partiesBody,
  partiesLink,
  partyTotals,
  reviseBody,
  toContractLine,
  toContractView,
  toContractorOption,
  toProjectOption,
  validateForm,
  validateParties,
} from './model';
import type { ContractForm, PartyDraft } from './model';
import { DOCUMENT, LEAD, SECOND, detail, line, party } from './test-support';

const UUID_A = '00000000-0000-4000-8000-000000000a01';
const UUID_B = '00000000-0000-4000-8000-000000000a02';
const UUID_C = '00000000-0000-4000-8000-000000000a03';
const filled: ContractForm = { ...EMPTY_FORM, projectId: UUID_A, packageId: UUID_B, contractorId: UUID_C, code: ' HD-1 ', title: ' Cầu ', contractValue: '10200000000', documentVersionId: UUID_A };

describe('reading the answers of the server', () => {
  it('reads a line and leaves out what is not a contract', () => {
    expect(toContractLine(line(1))).toMatchObject({ code: 'HD-A-001', status: 'DRAFT', contractValueVnd: '10200000000', estimateCeilingVnd: '10200000000', version: 1, isJointVenture: false });
    expect(toContractLine({ ...line(1), estimate_ceiling_vnd: undefined })?.estimateCeilingVnd).toBeNull();
    const guestLine = { ...line(1) } as Record<string, unknown>;
    delete guestLine.estimate_ceiling_vnd;
    expect(toContractLine(guestLine)?.estimateCeilingVnd).toBeUndefined();
    for (const broken of [null, 'x', [], { ...line(1), status: 'UNKNOWN' }, { ...line(1), type: 'GIFT' }, { ...line(1), version: '1' }, { ...line(1), contract_value_vnd: 10 }]) expect(toContractLine(broken)).toBeUndefined();
  });

  it('reads the detail with its revisions, members, history and the document of the draft', () => {
    const view = toContractView(
      detail(1, {
        parties: [party(1, LEAD, 'An Phát', 'LEAD', '60.0000', '6000000000'), party(2, SECOND, 'Bình Minh', 'MEMBER', '40.0000', '4000000000'), { id: 'x' }],
        parties_check: { work_matches_value: true },
        status_changes: [{ id: 's1', from_status: 'DRAFT', to_status: 'CANCELLED', reason: 'Lý do', effective_on: '2026-10-24' }, null],
        status_reason: 'Lý do',
        revisions: [{ id: 'r1', revision: 1, kind: 'BASE', status: 'DRAFT', amount_vnd: '1', document_version_id: UUID_A, valid_from: '2026-10-24' }, { nope: true }],
      }),
    );
    expect(view).toMatchObject({ advanceCategory: 'CONSTRUCTION', requiresQualityAcceptance: true, statusReason: 'Lý do', documentVersionId: UUID_A, workMatchesValue: true });
    expect(view?.parties.map((item) => item.role)).toEqual(['LEAD', 'MEMBER']);
    expect(view?.statusChanges).toHaveLength(1);
    expect(view?.revisions).toHaveLength(1);
    expect(toContractView({ ...detail(1), advance_category: 'GIFT' })).toBeUndefined();
    expect(toContractView({ ...detail(1), revisions: 'none', parties: 'none', status_changes: 7 })).toMatchObject({ revisions: [], parties: [], statusChanges: [], documentVersionId: null });
    expect(toContractView({ ...detail(1), requires_quality_acceptance: false })?.requiresQualityAcceptance).toBe(false);
  });

  it('offers projects and the verified contractors only', () => {
    expect(toProjectOption({ id: UUID_A, code: 'DA-1', name: 'Cầu' })).toEqual([{ id: UUID_A, label: 'DA-1 · Cầu' }]);
    expect(toProjectOption({ id: UUID_A })).toEqual([]);
    expect(toProjectOption(null)).toEqual([]);
    expect(toContractorOption({ id: UUID_A, legal_name: 'An Phát', verification_status: 'VERIFIED' })).toEqual([{ id: UUID_A, label: 'An Phát' }]);
    expect(toContractorOption({ id: UUID_A, verification_status: 'VERIFIED' })).toEqual([{ id: UUID_A, label: UUID_A }]);
    expect(toContractorOption({ id: UUID_A, legal_name: 'An Phát', verification_status: 'UNVERIFIED' })).toEqual([]);
    expect(toContractorOption(undefined)).toEqual([]);
  });

  it('groups the digits of an amount by language without turning it into a float', () => {
    expect(amountText('10200000000', 'en')).toBe('10,200,000,000');
    expect(amountText('9007199254740993123', 'en')).toBe('9,007,199,254,740,993,123');
    expect(amountText('12.50', 'en')).toBe('12');
    expect(amountText('abc', 'en')).toBe('abc');
  });
});

describe('the form of the draft', () => {
  it('names what is missing or wrong, for the creation and for the revision', () => {
    expect(validateForm(EMPTY_FORM, 'create')).toEqual({
      projectId: 'required',
      packageId: 'required',
      contractorId: 'required',
      code: 'required',
      title: 'required',
      contractValue: 'required',
      documentVersionId: 'required',
    });
    expect(validateForm({ ...filled, projectId: 'x', packageId: 'y', contractorId: 'z', code: 'c'.repeat(51), title: 't'.repeat(501), contractValue: '1.5', estimateCeiling: '-1', completionDue: 'tomorrow', documentVersionId: 'q' }, 'create')).toEqual({
      projectId: 'invalidId',
      packageId: 'invalidId',
      contractorId: 'invalidId',
      code: 'tooLong',
      title: 'tooLong',
      contractValue: 'invalidAmount',
      estimateCeiling: 'invalidAmount',
      completionDue: 'invalidDate',
      documentVersionId: 'invalidId',
    });
    expect(validateForm({ ...filled, contractValue: '0' }, 'create')).toEqual({ contractValue: 'zeroAmount' });
    expect(validateForm({ ...EMPTY_FORM, title: 'x', contractValue: '5', documentVersionId: UUID_A }, 'revise')).toEqual({});
    expect(validateForm(filled, 'create')).toEqual({});
  });

  it('refuses a value above the lower of the ceiling typed and the ceiling of the server, before sending anything (AC-ST-CTR-001-1)', () => {
    expect(validateForm(filled, 'create', '10200000000')).toEqual({});
    expect(validateForm({ ...filled, contractValue: '10300000000' }, 'create', '10200000000')).toEqual({ contractValue: 'aboveCeiling' });
    expect(validateForm({ ...filled, estimateCeiling: '9000000000' }, 'create', '10200000000')).toEqual({ contractValue: 'aboveCeiling' });
    expect(validateForm({ ...filled, estimateCeiling: '11000000000', contractValue: '10300000000' }, 'create', '10200000000')).toEqual({ contractValue: 'aboveCeiling' });
    expect(validateForm({ ...filled, estimateCeiling: '11000000000', contractValue: '10300000000' }, 'create', null)).toEqual({});
    expect(validateForm({ ...filled, contractValue: '9007199254740993' }, 'create', '9007199254740992')).toEqual({ contractValue: 'aboveCeiling' });
  });

  it('builds the body of the creation from the trimmed form, leaving out what was left empty', () => {
    expect(createBody(filled)).toEqual({
      project_id: UUID_A,
      package_id: UUID_B,
      contractor_id: UUID_C,
      code: 'HD-1',
      title: 'Cầu',
      type: 'LUMP_SUM',
      advance_category: 'CONSTRUCTION',
      is_joint_venture: false,
      requires_quality_acceptance: true,
      contract_value_vnd: '10200000000',
      document_version_id: UUID_A,
    });
    expect(createBody({ ...filled, estimateCeiling: ' 9000000000 ', completionDue: '2027-12-31', isJointVenture: true })).toMatchObject({ estimate_ceiling_vnd: '9000000000', completion_due: '2027-12-31', is_joint_venture: true });
  });

  it('builds the body of the revision from what differs, and never the code, the status or the contractor', () => {
    const view = toContractView(detail(1))!;
    const form = formOf(view);
    expect(form).toMatchObject({ code: 'HD-A-001', title: 'Hợp đồng số 1', contractValue: '10200000000', estimateCeiling: '10200000000', documentVersionId: DOCUMENT });
    expect(reviseBody(view, form)).toEqual({});
    const body = reviseBody(view, { ...form, title: ' Tên mới ', contractValue: '0009000000000', estimateCeiling: '9500000000', completionDue: '2028-01-31', requiresQualityAcceptance: false, documentVersionId: UUID_B });
    expect(body).toEqual({ title: 'Tên mới', contract_value_vnd: '9000000000', estimate_ceiling_vnd: '9500000000', completion_due: '2028-01-31', requires_quality_acceptance: false, document_version_id: UUID_B });
    expect(Object.keys(body)).not.toEqual(expect.arrayContaining(['code', 'status', 'contractor_id', 'project_id']));
    const guest = toContractView({ ...detail(1), estimate_ceiling_vnd: undefined, completion_due: null })!;
    expect(formOf(guest)).toMatchObject({ estimateCeiling: '', completionDue: '' });
  });
});

describe('the members of a joint venture', () => {
  const rows = (...items: Array<[string, string]>): PartyDraft[] => items.map(([share, work], index) => ({ key: index, contractorId: `c${index}`, role: index === 0 ? 'LEAD' : 'MEMBER', sharePct: share, workValueVnd: work }));

  it('starts from the lead alone with the whole contract, or from the members the contract has', () => {
    expect(draftsOf(toContractView(detail(1))!)).toEqual([{ key: 0, contractorId: LEAD, role: 'LEAD', sharePct: '100', workValueVnd: '10200000000' }]);
    const held = toContractView(detail(1, { parties: [party(1, LEAD, 'A', 'LEAD', '60.0000', '6'), party(2, SECOND, 'B', 'SOLE', '40.0000', '4')] }))!;
    expect(draftsOf(held).map((row) => [row.role, row.sharePct])).toEqual([['LEAD', '60.0000'], ['MEMBER', '40.0000']]);
  });

  it('adds the shares and the work in exact arithmetic and tells whether they are complete (AC-ST-CTR-001-3)', () => {
    expect(partyTotals(rows(['60', '6000000000'], ['40', '4000000000']), '10000000000')).toEqual({ share: '100.0000', work: '10000000000', sharesComplete: true, workMatchesValue: true });
    expect(partyTotals(rows(['60', '6000000000'], ['30', '4000000000']), '10000000000')).toMatchObject({ share: '90.0000', sharesComplete: false, workMatchesValue: true });
    expect(partyTotals(rows(['33.3333', '3'], ['33.3333', '3'], ['33.3334', '4']), '10')).toMatchObject({ share: '100.0000', sharesComplete: true, workMatchesValue: true });
    expect(partyTotals(rows(['60', '6000000001'], ['40', '4000000000']), '10000000000')).toMatchObject({ workMatchesValue: false, work: '10000000001' });
    expect(partyTotals(rows(['60', '9007199254740993'], ['40', '9007199254740993']), '18014398509481986')).toMatchObject({ workMatchesValue: true });
    expect(partyTotals(rows(['60', ''], ['x', '1']), '1')).toEqual({ share: undefined, work: undefined, sharesComplete: false, workMatchesValue: false });
  });

  it('names the problem of a row before anything is sent', () => {
    const list: PartyDraft[] = [
      { key: 0, contractorId: '', role: 'LEAD', sharePct: '60', workValueVnd: '1' },
      { key: 1, contractorId: 'a', role: 'MEMBER', sharePct: '0', workValueVnd: '1' },
      { key: 2, contractorId: 'b', role: 'MEMBER', sharePct: '101', workValueVnd: '1' },
      { key: 3, contractorId: 'c', role: 'MEMBER', sharePct: '5.12345', workValueVnd: '1' },
      { key: 4, contractorId: 'd', role: 'MEMBER', sharePct: '5', workValueVnd: '1.5' },
      { key: 5, contractorId: 'a', role: 'MEMBER', sharePct: '5', workValueVnd: '1' },
      { key: 6, contractorId: 'e', role: 'MEMBER', sharePct: '5', workValueVnd: '1' },
    ];
    expect([...validateParties(list)]).toEqual([
      [0, 'contractorRequired'],
      [1, 'invalidShare'],
      [2, 'invalidShare'],
      [3, 'invalidShare'],
      [4, 'invalidAmount'],
      [5, 'contractorTwice'],
    ]);
  });

  it('sends the shares as typed and the work as whole VND', () => {
    expect(partiesBody([{ key: 0, contractorId: 'a', role: 'LEAD', sharePct: ' 60.5 ', workValueVnd: '0006' }])).toEqual({ parties: [{ contractor_id: 'a', role: 'LEAD', share_pct: '60.5', work_value_vnd: '6' }] });
  });
});

describe('refusals, the register and its links', () => {
  const problem = (code: string, detailText?: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', detail: detailText, extensions });

  it('maps the codes of the commands, carries the ceiling the server named, and leaves anything else as general', () => {
    expect(describeProblem(problem('CONTRACT_VALUE_EXCEEDS_CEILING', 'contract_value_vnd', { ceiling_vnd: '10200000000' }))).toEqual({ reason: 'exceedsCeiling', field: 'contract_value_vnd', ceiling: '10200000000' });
    expect(describeProblem(problem('CONTRACT_VALUE_EXCEEDS_CEILING', undefined, { ceiling_vnd: 5 })).ceiling).toBeUndefined();
    const reasons: Record<string, string> = {
      CONTRACT_CODE_DUPLICATE: 'duplicateCode',
      CAPITAL_PLAN_NOT_APPROVED: 'planNotApproved',
      PACKAGE_NOT_AWARDED: 'packageNotAwarded',
      CONTRACTOR_NOT_VERIFIED: 'contractorNotVerified',
      CONTRACTOR_RESTRICTED: 'contractorRestricted',
      JV_SHARE_NOT_100: 'shareNot100',
      BOQ_TOTAL_MISMATCH: 'workMismatch',
      CONTRACT_STATE_INVALID: 'stateInvalid',
      VERSION_CONFLICT: 'versionConflict',
      VALIDATION_FAILED: 'validation',
      INVALID_REQUEST: 'validation',
      FIELD_NOT_ALLOWED: 'validation',
      RESOURCE_NOT_FOUND: 'notFound',
      SCOPE_DENIED: 'denied',
      SOMETHING_ELSE: 'general',
    };
    for (const [code, reason] of Object.entries(reasons)) expect(describeProblem(problem(code)).reason).toBe(reason);
    expect(describeProblem(new Error('offline'))).toEqual({ reason: 'general', field: undefined, ceiling: undefined });
  });

  it('filters by words and by status', () => {
    const contracts = [toContractLine(line(1))!, toContractLine(line(2, { status: 'ACTIVE', title: null, contractor_name: null }))!];
    expect(filterContracts(contracts, EMPTY_FILTER)).toHaveLength(2);
    expect(filterContracts(contracts, { query: ' hd-a-002 ', status: '' }).map((item) => item.code)).toEqual(['HD-A-002']);
    expect(filterContracts(contracts, { query: 'số 1', status: '' }).map((item) => item.code)).toEqual(['HD-A-001']);
    expect(filterContracts(contracts, { query: 'an phát', status: '' }).map((item) => item.code)).toEqual(['HD-A-001']);
    expect(filterContracts(contracts, { query: 'da-2026', status: 'ACTIVE' }).map((item) => item.code)).toEqual(['HD-A-002']);
    expect(filterContracts(contracts, { query: 'zzz', status: '' })).toEqual([]);
  });

  it('links to the draft and to the members by the id of the contract', () => {
    expect(draftLink('abc')).toBe('/ctr/ctr-02?id=abc');
    expect(partiesLink('a b')).toBe('/ctr/ctr-25?id=a+b');
  });
});
