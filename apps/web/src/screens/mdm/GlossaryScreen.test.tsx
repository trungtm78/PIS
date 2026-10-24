import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { mountInSession } from '../adm/security/test-support';
import GlossaryScreen from './GlossaryScreen';
import { DISBURSEMENT_REQUIRED_TERMS, definitionState, reviseForm, toGlossaryTerm, validateGlossary } from './model';
import { GLOSSARY_ALL, GLOSSARY_OWNER, GLOSSARY_READER, GLOSSARY_STEWARD, ME, OTHER, client, glossaryTerm, mount, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('MDM-34', 'FR-MDM-34');
const problem = (code: string, status = 409, detail?: string) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail, extensions: {} });
const fill = (template: string, params: Record<string, string | number>): string => template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
const OWNER_ID = '00000000-0000-4000-8000-0000000000f1';

afterEach(cleanup);

const rowsOf = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-term-id]'));
const codes = (): string[] => rowsOf().map((row) => row.getAttribute('data-term-code') ?? '');
const rowOf = (code: string): HTMLElement => document.querySelector(`tr[data-term-code="${code}"]`) as HTMLElement;
const ready = () => waitFor(() => expect(rowsOf().length).toBeGreaterThan(0));
const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const mutated = { operation_id: 'o', status: 'IN_REVIEW', resource_version: 2, resource_id: 'x' };

const TERMS = [
  glossaryTerm(1, { status: 'PUBLISHED', domain: 'DISBURSEMENT', term_code: 'GIAI_NGAN_YTD', revision: 2, effective_from: '2026-10-01', formula_ref: 'ytd = SUM(paid)', legal_basis: 'Decree 99', supersedes_id: glossaryTerm(9).id }),
  glossaryTerm(2, { status: 'DRAFT', term_code: 'DRAFT_TERM' }),
  glossaryTerm(3, { status: 'IN_REVIEW', term_code: 'REVIEW_TERM', version: 4 }),
  glossaryTerm(4, { status: 'APPROVED', term_code: 'APPROVED_TERM', version: 5 }),
  glossaryTerm(5, { status: 'REJECTED', term_code: 'REJECTED_TERM', decision_reason: 'Not the wording of the decision' }),
];
const listed = (overrides: Partial<World> = {}): World => world({ glossary: TERMS, ...overrides });

describe('GlossaryScreen (MDM-34): the terms', () => {
  it('lists each term with its code, Vietnamese term, domain, revision, status, owner, effective date and formula', async () => {
    mount(<GlossaryScreen route={ROUTE} />, client(listed()), GLOSSARY_READER, '/mdm/mdm-34');
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['mdm.glossary.page.title']);
    expect(codes()).toEqual(['GIAI_NGAN_YTD', 'DRAFT_TERM', 'REVIEW_TERM', 'APPROVED_TERM', 'REJECTED_TERM']);
    const cells = Array.from(rowOf('GIAI_NGAN_YTD').querySelectorAll('td')).map((cell) => cell.textContent);
    expect(cells[0]).toBe('GIAI_NGAN_YTD');
    expect(cells[1]).toContain('Thuật ngữ 1');
    expect(cells[1]).toContain(fill(vi_['mdm.glossary.legalBasis.text'], { basis: 'Decree 99' }));
    expect(cells[1]).toContain(vi_['mdm.glossary.supersedes.text']);
    expect(cells.slice(2, 8)).toEqual(['DISBURSEMENT', '2', vi_['mdm.glossary.status.published.text'], OTHER.slice(0, 8), '2026-10-01', 'ytd = SUM(paid)']);
    expect(rowOf('REJECTED_TERM').textContent).toContain(fill(vi_['mdm.glossary.decisionReason.text'], { reason: 'Not the wording of the decision' }));
    expect(screen.getByTestId('count').textContent).toBe(fill(vi_['mdm.glossary.count.text'], { count: 5 }));
    expect(screen.getByRole('table', { name: vi_['mdm.glossary.table.aria'] })).toBeTruthy();
    expect(rowOf('GIAI_NGAN_YTD').querySelector('code[title]')?.getAttribute('title')).toBe(OTHER);
  });

  it('filters by domain and by status, and says when nothing matches or nothing exists', async () => {
    mount(<GlossaryScreen route={ROUTE} />, client(listed()), GLOSSARY_READER, '/mdm/mdm-34');
    await ready();
    expect(within(screen.getByLabelText(vi_['mdm.glossary.filter.domain.label'])).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['mdm.glossary.filter.all.option'], 'DISBURSEMENT', 'GENERAL']);
    set(vi_['mdm.glossary.filter.domain.label'], 'GENERAL');
    expect(codes()).toEqual(['DRAFT_TERM', 'REVIEW_TERM', 'APPROVED_TERM', 'REJECTED_TERM']);
    set(vi_['mdm.glossary.filter.status.label'], 'IN_REVIEW');
    expect(codes()).toEqual(['REVIEW_TERM']);
    set(vi_['mdm.glossary.filter.domain.label'], 'DISBURSEMENT');
    expect(screen.getByTestId('empty-glossary').textContent).toBe(vi_['mdm.glossary.noMatch.text']);
    cleanup();
    mount(<GlossaryScreen route={ROUTE} />, client(world()), GLOSSARY_READER, '/mdm/mdm-34');
    expect((await screen.findByTestId('empty-glossary')).textContent).toBe(vi_['mdm.glossary.empty.text']);
  });

  it('says that the terms could not be read, with a retry', async () => {
    const state = listed({ failing: new Set(['listGlossaryTerms']) });
    mount(<GlossaryScreen route={ROUTE} />, client(state), GLOSSARY_READER, '/mdm/mdm-34');
    expect(await screen.findByRole('alert')).toBeTruthy();
    state.failing = new Set();
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
    expect(codes().length).toBe(5);
  });
});

describe('GlossaryScreen: the D03 definitions of the disbursement domain', () => {
  const disbursement = (published: number, extra: Array<Record<string, unknown>> = []): World =>
    world({
      glossary: [
        ...DISBURSEMENT_REQUIRED_TERMS.map((code, index) => glossaryTerm(10 + index, { term_code: code, domain: 'DISBURSEMENT', status: index < published ? 'PUBLISHED' : 'IN_REVIEW' })),
        ...extra,
      ],
    });
  const badge = (): HTMLElement => screen.getByTestId('definition-badge');

  it('says the definitions await sign-off while any required term is not published, and names the missing ones', async () => {
    mount(<GlossaryScreen route={ROUTE} />, client(disbursement(3)), GLOSSARY_READER, '/mdm/mdm-34');
    await ready();
    expect(badge().getAttribute('data-state')).toBe('PENDING');
    expect(within(badge()).getByText(vi_['mdm.glossary.badge.pending.pill'])).toBeTruthy();
    expect(vi_['mdm.glossary.badge.pending.pill']).toBe('Định nghĩa D03 – CHỜ KÝ');
    expect(badge().textContent).toContain(fill(vi_['mdm.glossary.badge.pending.text'], { count: 2, terms: 'MAU_SO_KH_TTG_GIAO, MAU_SO_KH_TONG' }));
  });

  it('shows the signed badge when all five terms are published', async () => {
    mount(<GlossaryScreen route={ROUTE} />, client(disbursement(5)), GLOSSARY_READER, '/mdm/mdm-34');
    await ready();
    expect(badge().getAttribute('data-state')).toBe('SIGNED');
    expect(within(badge()).getByText(vi_['mdm.glossary.badge.signed.pill'])).toBeTruthy();
    expect(badge().textContent).toContain(vi_['mdm.glossary.badge.signed.text']);
  });

  it('is not signed by a deprecated revision, a published term of another domain, or a glossary without the disbursement terms', async () => {
    const stray = [glossaryTerm(30, { term_code: 'MAU_SO_KH_TONG', domain: 'OTHER', status: 'PUBLISHED' }), glossaryTerm(31, { term_code: 'GIAI_NGAN_PTD', domain: 'DISBURSEMENT', status: 'DEPRECATED', revision: 1 })];
    const state = disbursement(5).glossary.slice(0, 4).concat(stray);
    mount(<GlossaryScreen route={ROUTE} />, client(world({ glossary: state })), GLOSSARY_READER, '/mdm/mdm-34');
    await ready();
    expect(badge().getAttribute('data-state')).toBe('PENDING');
    cleanup();
    mount(<GlossaryScreen route={ROUTE} />, client(world({ glossary: [glossaryTerm(2)] })), GLOSSARY_READER, '/mdm/mdm-34');
    await ready();
    expect(badge().getAttribute('data-state')).toBe('PENDING');
    expect(badge().textContent).toContain(fill(vi_['mdm.glossary.badge.pending.text'], { count: 5, terms: DISBURSEMENT_REQUIRED_TERMS.join(', ') }));
  });

  it('keeps the badge from the whole glossary while the list is filtered', async () => {
    mount(<GlossaryScreen route={ROUTE} />, client(disbursement(5, [glossaryTerm(40)])), GLOSSARY_READER, '/mdm/mdm-34');
    await ready();
    set(vi_['mdm.glossary.filter.status.label'], 'DRAFT');
    expect(codes()).toEqual(['TERM_40']);
    expect(badge().getAttribute('data-state')).toBe('SIGNED');
  });
});

describe('GlossaryScreen: what each person is offered', () => {
  const buttons = (code: string): string[] => within(rowOf(code)).queryAllByRole('button').map((button) => button.textContent ?? '');

  it('offers submit on a draft and a new revision on a published term to the one who proposes, and nothing on the others', async () => {
    mount(<GlossaryScreen route={ROUTE} />, client(listed()), GLOSSARY_STEWARD, '/mdm/mdm-34');
    await ready();
    expect(buttons('DRAFT_TERM')).toEqual([vi_['mdm.glossary.submit.action']]);
    expect(buttons('GIAI_NGAN_YTD')).toEqual([vi_['mdm.glossary.revise.action']]);
    expect(buttons('REVIEW_TERM')).toEqual([]);
    expect(buttons('APPROVED_TERM')).toEqual([]);
    expect(buttons('REJECTED_TERM')).toEqual([]);
    expect(screen.getByRole('form', { name: vi_['mdm.glossary.form.aria'] })).toBeTruthy();
  });

  it('offers decide on a term in review and publish on an approved term to the one who approves, and no form', async () => {
    mount(<GlossaryScreen route={ROUTE} />, client(listed()), GLOSSARY_OWNER, '/mdm/mdm-34');
    await ready();
    expect(buttons('REVIEW_TERM')).toEqual([vi_['mdm.glossary.decide.action']]);
    expect(buttons('APPROVED_TERM')).toEqual([vi_['mdm.glossary.publish.action']]);
    expect(buttons('DRAFT_TERM')).toEqual([]);
    expect(buttons('GIAI_NGAN_YTD')).toEqual([]);
    expect(screen.queryByRole('form', { name: vi_['mdm.glossary.form.aria'] })).toBeNull();
  });

  it('offers nothing to a reader, nor to anyone while the tenant is suspended', async () => {
    mount(<GlossaryScreen route={ROUTE} />, client(listed()), GLOSSARY_READER, '/mdm/mdm-34');
    await ready();
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryByRole('form', { name: vi_['mdm.glossary.form.aria'] })).toBeNull();
    cleanup();
    mountInSession(<GlossaryScreen route={ROUTE} />, client(listed()), { permissions: GLOSSARY_ALL, mode: 'READ_ONLY' });
    await ready();
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryByRole('form', { name: vi_['mdm.glossary.form.aria'] })).toBeNull();
  });
});

describe('GlossaryScreen: submit, decide and publish', () => {
  it('submits a draft with the version that was read and says so', async () => {
    const h = client(listed(), () => mutated);
    mount(<GlossaryScreen route={ROUTE} />, h, GLOSSARY_STEWARD, '/mdm/mdm-34');
    await ready();
    await userEvent.setup().click(within(rowOf('DRAFT_TERM')).getByRole('button', { name: vi_['mdm.glossary.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('submitGlossaryTerm', expect.objectContaining({ path: { id: glossaryTerm(2).id }, ifMatchVersion: 1 })));
    expect((await screen.findByRole('status')).textContent).toBe(vi_['mdm.glossary.submitted.notice']);
  });

  it('asks for a reason, then sends the decision with the version that was read', async () => {
    const h = client(listed(), () => ({ ...mutated, status: 'APPROVED' }));
    mount(<GlossaryScreen route={ROUTE} />, h, GLOSSARY_OWNER, '/mdm/mdm-34');
    await ready();
    const user = userEvent.setup();
    await user.click(within(rowOf('REVIEW_TERM')).getByRole('button', { name: vi_['mdm.glossary.decide.action'] }));
    const form = screen.getByRole('form', { name: fill(vi_['mdm.glossary.decide.title'], { code: 'REVIEW_TERM' }) });
    await user.click(within(form).getByRole('button', { name: vi_['mdm.approval.decision.approve.action'] }));
    expect(within(form).getByText(vi_['mdm.field.required.error'])).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(vi_['mdm.approval.reason.label']), { target: { value: 'ab' } });
    await user.click(within(form).getByRole('button', { name: vi_['mdm.approval.decision.approve.action'] }));
    expect(within(form).getByText(vi_['mdm.field.tooShort.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['mdm.approval.reason.label']), { target: { value: '  Matches the decision of the committee  ' } });
    await user.click(within(form).getByRole('button', { name: vi_['mdm.approval.decision.approve.action'] }));
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'decideGlossaryTerm',
        expect.objectContaining({ path: { id: glossaryTerm(3).id }, body: { decision: 'approve', reason: 'Matches the decision of the committee' }, ifMatchVersion: 4 }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('form', { name: fill(vi_['mdm.glossary.decide.title'], { code: 'REVIEW_TERM' }) })).toBeNull());
    expect(screen.getByRole('status').textContent).toBe(vi_['mdm.glossary.decided.notice']);
  });

  it('sends a rejection and a return with their own decision, and lets the person close the panel', async () => {
    const h = client(listed(), () => ({ ...mutated, status: 'REJECTED' }));
    mount(<GlossaryScreen route={ROUTE} />, h, GLOSSARY_OWNER, '/mdm/mdm-34');
    await ready();
    const user = userEvent.setup();
    const open = async (): Promise<HTMLElement> => {
      await user.click(within(rowOf('REVIEW_TERM')).getByRole('button', { name: vi_['mdm.glossary.decide.action'] }));
      const form = screen.getByRole('form', { name: fill(vi_['mdm.glossary.decide.title'], { code: 'REVIEW_TERM' }) });
      fireEvent.change(within(form).getByLabelText(vi_['mdm.approval.reason.label']), { target: { value: 'Needs the legal basis' } });
      return form;
    };
    await user.click(within(await open()).getByRole('button', { name: vi_['mdm.approval.decision.reject.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideGlossaryTerm', expect.objectContaining({ body: { decision: 'reject', reason: 'Needs the legal basis' } })));
    await user.click(within(await open()).getByRole('button', { name: vi_['mdm.approval.decision.return.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('decideGlossaryTerm', expect.objectContaining({ body: { decision: 'return', reason: 'Needs the legal basis' } })));
    await user.click(within(rowOf('REVIEW_TERM')).getByRole('button', { name: vi_['mdm.glossary.decide.action'] }));
    await user.click(screen.getByRole('button', { name: vi_['mdm.approval.cancel.action'] }));
    expect(screen.queryByRole('form', { name: fill(vi_['mdm.glossary.decide.title'], { code: 'REVIEW_TERM' }) })).toBeNull();
  });

  it('publishes an approved term with the version that was read and says so', async () => {
    const h = client(listed(), () => ({ ...mutated, status: 'PUBLISHED' }));
    mount(<GlossaryScreen route={ROUTE} />, h, GLOSSARY_OWNER, '/mdm/mdm-34');
    await ready();
    await userEvent.setup().click(within(rowOf('APPROVED_TERM')).getByRole('button', { name: vi_['mdm.glossary.publish.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('publishGlossaryTerm', expect.objectContaining({ path: { id: glossaryTerm(4).id }, ifMatchVersion: 5 })));
    expect((await screen.findByRole('status')).textContent).toBe(vi_['mdm.glossary.published.notice']);
  });

  it('shows the refusal of the server for a stale version or a state that moved on, and clears it on the next attempt', async () => {
    let answer: unknown = problem('VERSION_CONFLICT');
    const h = client(listed(), () => answer);
    mount(<GlossaryScreen route={ROUTE} />, h, GLOSSARY_OWNER, '/mdm/mdm-34');
    await ready();
    const user = userEvent.setup();
    const publish = () => user.click(within(rowOf('APPROVED_TERM')).getByRole('button', { name: vi_['mdm.glossary.publish.action'] }));
    await publish();
    expect((await screen.findByRole('alert')).textContent).toBe(vi_['mdm.problem.versionConflict.error']);
    answer = problem('STAGE_TRANSITION_DENIED');
    await publish();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(vi_['mdm.problem.stageDenied.error']));
    answer = { ...mutated, status: 'PUBLISHED' };
    await publish();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('GlossaryScreen: the refusals of four-eyes and of the owner scope', () => {
  const decideAs = async (h: ReturnType<typeof client>, permissions: readonly string[]): Promise<ReturnType<typeof userEvent.setup>> => {
    mount(<GlossaryScreen route={ROUTE} />, h, permissions, '/mdm/mdm-34');
    await ready();
    const user = userEvent.setup();
    await user.click(within(rowOf('REVIEW_TERM')).getByRole('button', { name: vi_['mdm.glossary.decide.action'] }));
    const form = screen.getByRole('form', { name: fill(vi_['mdm.glossary.decide.title'], { code: 'REVIEW_TERM' }) });
    fireEvent.change(within(form).getByLabelText(vi_['mdm.approval.reason.label']), { target: { value: 'Matches the decision of the committee' } });
    await user.click(within(form).getByRole('button', { name: vi_['mdm.approval.decision.approve.action'] }));
    return user;
  };

  it('says the proposer cannot approve or publish the term, and the term stays in review (AC-ST-MDM-008-1)', async () => {
    const own = [glossaryTerm(3, { status: 'IN_REVIEW', term_code: 'REVIEW_TERM', version: 4, created_by: ME }), glossaryTerm(4, { status: 'APPROVED', term_code: 'APPROVED_TERM', version: 5, created_by: ME })];
    const h = client(world({ glossary: own }), () => problem('SELF_APPROVAL_DENIED', 403));
    const user = await decideAs(h, GLOSSARY_ALL);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(vi_['mdm.problem.selfApproval.error']);
    expect(h.command).toHaveBeenCalledWith('decideGlossaryTerm', expect.objectContaining({ ifMatchVersion: 4 }));
    expect(rowOf('REVIEW_TERM').getAttribute('data-status')).toBe('IN_REVIEW');
    // The same sentence for the proposer who tries to publish.
    await user.click(within(rowOf('APPROVED_TERM')).getByRole('button', { name: vi_['mdm.glossary.publish.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('publishGlossaryTerm', expect.objectContaining({ ifMatchVersion: 5 })));
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    expect(rowOf('APPROVED_TERM').getAttribute('data-status')).toBe('APPROVED');
  });

  it('says only the owner named on the term can decide it when a holder of the permission is not that owner, and the term stays IN_REVIEW (AC-ST-MDM-008-2)', async () => {
    const h = client(listed(), () => problem('SCOPE_DENIED', 403, 'domain'));
    await decideAs(h, GLOSSARY_OWNER);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(vi_['mdm.problem.notOwner.error']);
    expect(screen.getByRole('alert').textContent).not.toBe(vi_['mdm.problem.denied.error']);
    expect(rowOf('REVIEW_TERM').getAttribute('data-status')).toBe('IN_REVIEW');
    expect(within(rowOf('REVIEW_TERM')).getByText(vi_['mdm.glossary.status.inReview.text'])).toBeTruthy();
  });
});

describe('GlossaryScreen: proposing a term', () => {
  const fillForm = (overrides: Record<string, string> = {}): void => {
    const values: Record<string, string> = {
      [vi_['mdm.glossary.form.code.label']]: ' GIAI_NGAN_NEW ',
      [vi_['mdm.glossary.form.term.label']]: ' Giải ngân mới ',
      [vi_['mdm.glossary.form.domain.label']]: 'DISBURSEMENT',
      [vi_['mdm.glossary.form.owner.label']]: ` ${OWNER_ID.toUpperCase()} `,
      [vi_['mdm.glossary.form.definition.label']]: '  Giải ngân tính theo ngày Kho bạc thanh toán.  ',
      ...overrides,
    };
    for (const [label, value] of Object.entries(values)) set(label, value);
  };
  const form = () => screen.getByRole('form', { name: vi_['mdm.glossary.form.aria'] });
  const save = (user: ReturnType<typeof userEvent.setup>) => user.click(within(form()).getByRole('button', { name: vi_['mdm.glossary.save.action'] }));

  it('names the fields that are missing or wrong, and sends nothing until the form is right', async () => {
    const h = client(listed());
    mount(<GlossaryScreen route={ROUTE} />, h, GLOSSARY_STEWARD, '/mdm/mdm-34');
    await ready();
    const user = userEvent.setup();
    await save(user);
    expect(within(form()).getAllByText(vi_['mdm.field.required.error'])).toHaveLength(5);
    fillForm({
      [vi_['mdm.glossary.form.code.label']]: 'lower case',
      [vi_['mdm.glossary.form.domain.label']]: 'D'.repeat(51),
      [vi_['mdm.glossary.form.owner.label']]: 'not-an-id',
      [vi_['mdm.glossary.form.definition.label']]: 'too short',
      [vi_['mdm.glossary.form.formula.label']]: 'f'.repeat(121),
    });
    await save(user);
    expect(within(form()).getByText(vi_['mdm.field.invalidCode.error'])).toBeTruthy();
    expect(within(form()).getByText(vi_['mdm.field.invalidId.error'])).toBeTruthy();
    expect(within(form()).getByText(vi_['mdm.field.definitionTooShort.error'])).toBeTruthy();
    expect(within(form()).getAllByText(vi_['mdm.field.tooLong.error'])).toHaveLength(2);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('sends the trimmed term with the lower-case owner, leaves out what is empty, and clears the form', async () => {
    const h = client(listed(), () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: 'new' }));
    mount(<GlossaryScreen route={ROUTE} />, h, GLOSSARY_STEWARD, '/mdm/mdm-34');
    await ready();
    fillForm();
    await save(userEvent.setup());
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'proposeGlossaryTerm',
        expect.objectContaining({
          body: { term_code: 'GIAI_NGAN_NEW', term_vi: 'Giải ngân mới', definition: 'Giải ngân tính theo ngày Kho bạc thanh toán.', domain: 'DISBURSEMENT', owner_membership_id: OWNER_ID },
        }),
      ),
    );
    expect((await screen.findByTestId('glossary-saved')).textContent).toBe(vi_['mdm.glossary.saved.notice']);
    expect((screen.getByLabelText(vi_['mdm.glossary.form.code.label']) as HTMLInputElement).value).toBe('');
    // Typing again clears the notice.
    set(vi_['mdm.glossary.form.code.label'], 'X');
    expect(screen.queryByTestId('glossary-saved')).toBeNull();
  });

  it('sends the formula and the legal basis when they are given', async () => {
    const h = client(listed(), () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: 'new' }));
    mount(<GlossaryScreen route={ROUTE} />, h, GLOSSARY_STEWARD, '/mdm/mdm-34');
    await ready();
    fillForm({ [vi_['mdm.glossary.form.formula.label']]: ' ytd = SUM(paid) ', [vi_['mdm.glossary.form.basis.label']]: ' Decree 99 ' });
    await save(userEvent.setup());
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('proposeGlossaryTerm', expect.objectContaining({ body: expect.objectContaining({ formula_ref: 'ytd = SUM(paid)', legal_basis: 'Decree 99' }) })));
  });

  it('shows the refusal of the server: a code already in progress and a field it does not accept', async () => {
    let answer: unknown = problem('GLOSSARY_TERM_DUPLICATE');
    const h = client(listed(), () => answer);
    mount(<GlossaryScreen route={ROUTE} />, h, GLOSSARY_STEWARD, '/mdm/mdm-34');
    await ready();
    const user = userEvent.setup();
    fillForm();
    await save(user);
    expect((await within(form()).findByRole('alert')).textContent).toBe(vi_['mdm.problem.duplicateTerm.error']);
    answer = problem('VALIDATION_FAILED', 422, 'owner_membership_id');
    await save(user);
    await waitFor(() => expect(within(form()).getByRole('alert').textContent).toBe(fill(vi_['mdm.problem.validationField.error'], { field: 'owner_membership_id' })));
  });

  it('starts a new revision of a published term from its words, keeps its code and domain, and sets what it replaces', async () => {
    const h = client(listed(), () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: 'new' }));
    mount(<GlossaryScreen route={ROUTE} />, h, GLOSSARY_STEWARD, '/mdm/mdm-34');
    await ready();
    const user = userEvent.setup();
    await user.click(within(rowOf('GIAI_NGAN_YTD')).getByRole('button', { name: vi_['mdm.glossary.revise.action'] }));
    expect(screen.getByRole('heading', { level: 2, name: fill(vi_['mdm.glossary.revise.title'], { code: 'GIAI_NGAN_YTD', revision: 2 }) })).toBeTruthy();
    const code = screen.getByLabelText(vi_['mdm.glossary.form.code.label']) as HTMLInputElement;
    expect([code.value, code.readOnly, (screen.getByLabelText(vi_['mdm.glossary.form.domain.label']) as HTMLInputElement).readOnly]).toEqual(['GIAI_NGAN_YTD', true, true]);
    expect((screen.getByLabelText(vi_['mdm.glossary.form.formula.label']) as HTMLInputElement).value).toBe('ytd = SUM(paid)');
    expect((screen.getByLabelText(vi_['mdm.glossary.form.owner.label']) as HTMLInputElement).value).toBe(OTHER);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(vi_['mdm.glossary.form.definition.label'])));
    set(vi_['mdm.glossary.form.definition.label'], 'Giải ngân lũy kế từ đầu năm kế hoạch, phiên bản ba.');
    await save(user);
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith(
        'proposeGlossaryTerm',
        expect.objectContaining({
          body: expect.objectContaining({ term_code: 'GIAI_NGAN_YTD', domain: 'DISBURSEMENT', supersedes_id: glossaryTerm(1).id, definition: 'Giải ngân lũy kế từ đầu năm kế hoạch, phiên bản ba.' }),
        }),
      ),
    );
    // The form goes back to a new term, and the notice stays.
    expect((await screen.findByTestId('glossary-saved')).textContent).toBe(vi_['mdm.glossary.saved.notice']);
    expect((screen.getByLabelText(vi_['mdm.glossary.form.code.label']) as HTMLInputElement).readOnly).toBe(false);
  });

  it('lets the person drop a revision that was started', async () => {
    mount(<GlossaryScreen route={ROUTE} />, client(listed()), GLOSSARY_STEWARD, '/mdm/mdm-34');
    await ready();
    const user = userEvent.setup();
    await user.click(within(rowOf('GIAI_NGAN_YTD')).getByRole('button', { name: vi_['mdm.glossary.revise.action'] }));
    await user.click(screen.getByRole('button', { name: vi_['mdm.glossary.revise.cancel.action'] }));
    expect((screen.getByLabelText(vi_['mdm.glossary.form.code.label']) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('heading', { level: 2, name: vi_['mdm.glossary.form.title'] })).toBeTruthy();
  });
});

describe('the glossary model', () => {
  const raw = glossaryTerm(1, { status: 'PUBLISHED', effective_from: '2026-10-01' });

  it('reads a term and refuses what is not one', () => {
    expect(toGlossaryTerm(raw)).toMatchObject({ id: raw.id, termCode: 'TERM_1', status: 'PUBLISHED', effectiveFrom: '2026-10-01', formulaRef: null, legalBasis: null, supersedesId: null, version: 1 });
    expect(toGlossaryTerm({ ...raw, status: 'UNKNOWN' })).toBeUndefined();
    expect(toGlossaryTerm({ ...raw, version: 'x' })).toBeUndefined();
    expect(toGlossaryTerm('term')).toBeUndefined();
  });

  it('has a definition status only for the disbursement domain', () => {
    expect(definitionState([], 'GENERAL')).toBeUndefined();
    expect(definitionState([], 'DISBURSEMENT')).toEqual({ signed: false, missing: [...DISBURSEMENT_REQUIRED_TERMS] });
  });

  it('starts a revision from the words of the term it replaces, and validates the form', () => {
    const term = toGlossaryTerm(glossaryTerm(1, { formula_ref: 'a = b', legal_basis: 'Decree 99' }));
    expect(term === undefined ? undefined : reviseForm(term)).toMatchObject({ termCode: 'TERM_1', formulaRef: 'a = b', legalBasis: 'Decree 99', ownerMembershipId: OTHER });
    expect(validateGlossary(term === undefined ? ({} as never) : reviseForm(term))).toEqual({});
  });

  it('has the same words in both languages for the badge of the definitions', () => {
    expect(Object.keys(en).filter((key) => key.startsWith('mdm.glossary.')).sort()).toEqual(Object.keys(vi_).filter((key) => key.startsWith('mdm.glossary.')).sort());
  });
});
