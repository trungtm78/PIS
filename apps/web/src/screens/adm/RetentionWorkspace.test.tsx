import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en_ from '../../i18n/en.json';
import vi_ from '../../i18n/vi.json';
import { translator } from '../../i18n';
import { routeOf } from '../doc/test-support';
import { RetentionWorkspace } from './RetentionWorkspace';
import { toHold, toPolicy, toReviewItem } from './retention/model';
import type { HoldView, PolicyView, ReviewItemView } from './retention/model';
import { SECOND_TENANT, FIRST_TENANT, harness, mountInSession } from './security/test-support';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('ADM-12', 'FR-ADM-12');
const MANAGER = ['adm.retention.manage'];
const APPROVER = ['adm.retention.approve'];
const BOTH = ['adm.retention.manage', 'adm.retention.approve'];
const ME = FIRST_TENANT.membershipId;

const policy = (id: string, recordClass: string, revision: number, status: string, extra: Record<string, unknown> = {}): PolicyView =>
  toPolicy({
    id,
    record_class: recordClass,
    revision,
    retention_years: 10,
    retention_basis: 'FROM_CLOSED',
    legal_basis_ref: `Basis of ${id} [CXN-RET-03]`,
    end_action: 'REVIEW_FOR_DESTRUCTION',
    effective_from: '2026-01-01',
    status,
    created_by: 'someone-else',
    approved_by: status === 'Draft' ? null : 'approver',
    published_at: status === 'Draft' ? null : '2026-01-02T00:00:00.000Z',
    version: status === 'Draft' ? 1 : 2,
    ...extra,
  }) as PolicyView;

const POLICIES: PolicyView[] = [
  policy('p-old', 'project_dossier', 1, 'Superseded'),
  policy('p-live', 'project_dossier', 2, 'Published', { retention_years: 12 }),
  policy('p-draft', 'project_dossier', 3, 'Draft', { retention_years: 15 }),
  policy('p-own', 'payment_dossier', 1, 'Draft', { created_by: ME }),
  policy('p-session', 'user_session', 1, 'Published', { retention_basis: 'PERMANENT', retention_years: null, end_action: 'AUTO_PURGE_TECHNICAL' }),
];
const hold = (id: string, status: string, scope: Record<string, unknown> = { kind: 'PROJECT', ids: ['a', 'b'] }): HoldView =>
  toHold({ id, hold_kind: 'INSPECTION', status, resource_scope: scope, authority_reference: '***', reason: `Reason of ${id}`, effective_at: '2026-01-01T00:00:00.000Z' }) as HoldView;
const HOLDS: HoldView[] = [hold('h-project', 'Active'), hold('h-tenant', 'Active', { kind: 'TENANT', ids: [] }), hold('h-over', 'Released')];
const REVIEW: ReviewItemView[] = [
  toReviewItem({ id: 'r1', record_class: 'project_dossier', resource_type: 'project', resource_id: 'abcdef12-0000-4000-8000-000000000001', basis_date: '2024-03-15', due_on: '2025-03-15', end_action: 'REVIEW_FOR_DESTRUCTION' }) as ReviewItemView,
];

const mount = (
  options: { policies?: PolicyView[]; holds?: HoldView[]; review?: ReviewItemView[]; permissions?: readonly string[] | undefined; mode?: 'FULL' | 'READ_ONLY'; h?: ReturnType<typeof harness> } = {},
) => {
  const h = options.h ?? harness(() => new Error('no read'));
  const view = mountInSession(
    <RetentionWorkspace route={ROUTE} policies={options.policies ?? POLICIES} holds={options.holds ?? HOLDS} review={options.review ?? REVIEW} />,
    h,
    { permissions: 'permissions' in options ? options.permissions : BOTH, ...(options.mode === undefined ? {} : { mode: options.mode }) },
  );
  return { h, view };
};
const rowOf = (id: string): HTMLElement => document.querySelector(`[data-policy-id="${id}"]`) as HTMLElement;
const pick = async (label: string, value: string): Promise<void> => {
  await userEvent.setup().selectOptions(screen.getByLabelText(label), value);
};
const fillDraft = async (): Promise<void> => {
  const user = userEvent.setup();
  await pick(vi_['adm.retention.draft.class.label'], 'project_dossier');
  await user.type(screen.getByLabelText(vi_['adm.retention.draft.years.label']), '10');
  await user.type(screen.getByLabelText(vi_['adm.retention.draft.legalBasis.label']), 'TT 10/2022/TT-BNV CXN-RET-03');
  fireEvent.change(screen.getByLabelText(vi_['adm.retention.draft.effective.label']), { target: { value: '2026-01-01' } });
};
const saveDraft = (): Promise<void> => userEvent.setup().click(screen.getByRole('button', { name: vi_['adm.retention.draft.submit.action'] }));

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

describe('RetentionWorkspace (ADM-12)', () => {
  it('shows each class with its basis, its period, what happens at the end, its status and the active holds, and says the periods are placeholders (AC-ST-ADM-017-3, UI-ADM-12)', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['adm.retention.page.title']);
    expect(screen.getByTestId('placeholder-note').textContent).toBe(vi_['adm.retention.placeholder.note']);
    expect([...document.querySelectorAll('[data-policy-id]')].map((row) => row.getAttribute('data-policy-id'))).toEqual(['p-own', 'p-draft', 'p-live', 'p-old', 'p-session']);
    const live = rowOf('p-live');
    expect(within(live).getByText('project_dossier')).toBeTruthy();
    expect(within(live).getByText(vi_['adm.retention.basis.closed'])).toBeTruthy();
    expect(within(live).getByText(vi_['adm.retention.period.years'].replace('{count}', '12'))).toBeTruthy();
    expect(within(live).getByText(vi_['adm.retention.endAction.review'])).toBeTruthy();
    expect(within(live).getByText(vi_['adm.retention.status.published']).closest('.ui-pill')?.className).toContain('ui-tone-success');
    expect(within(live).getByText(/Basis of p-live/)).toBeTruthy();
    expect(within(rowOf('p-draft')).getByText(vi_['adm.retention.status.draft']).closest('.ui-pill')?.className).toContain('ui-tone-warning');
    expect(within(rowOf('p-old')).getByText(vi_['adm.retention.status.superseded']).closest('.ui-pill')?.className).toContain('ui-tone-neutral');
    const session = rowOf('p-session');
    expect(within(session).getAllByText(vi_['adm.retention.period.permanent']).length).toBeGreaterThan(0);
    expect(within(session).getByText(vi_['adm.retention.endAction.purge'])).toBeTruthy();
    expect(within(live).getByText(new RegExp(vi_['adm.retention.kind.business']))).toBeTruthy();
    expect(within(session).getByText(new RegExp(vi_['adm.retention.kind.technical']))).toBeTruthy();
  });

  it('lists the active legal holds only, the whole tenant without a count, and the authority as the server gave it', () => {
    mount();
    const holds = screen.getByTestId('holds');
    expect([...holds.querySelectorAll('[data-hold-id]')].map((row) => row.getAttribute('data-hold-id'))).toEqual(['h-project', 'h-tenant']);
    expect(within(holds.querySelector('[data-hold-id="h-project"]') as HTMLElement).getByText(/\(2\)/)).toBeTruthy();
    expect(within(holds.querySelector('[data-hold-id="h-tenant"]') as HTMLElement).getByText(vi_['adm.retention.hold.scope.tenant']).parentElement?.textContent).not.toContain('(');
    expect(within(holds).getAllByText('***').length).toBe(2);
    expect(screen.queryByText('Reason of h-over')).toBeNull();
  });

  it('lists the records that wait for a decision, and says that nothing deletes them', () => {
    mount();
    const review = screen.getByTestId('review');
    expect(within(review).getByText(vi_['adm.retention.review.hint'])).toBeTruthy();
    const row = review.querySelector('[data-review-id="r1"]') as HTMLElement;
    expect(within(row).getByText('2025-03-15')).toBeTruthy();
    expect(within(row).getByText('abcdef12')).toBeTruthy();
  });

  it('says so when there is nothing to list', () => {
    mount({ policies: [], holds: [HOLDS[2] as HoldView], review: [] });
    expect(screen.getByText(vi_['adm.retention.policy.empty'])).toBeTruthy();
    expect(screen.getByText(vi_['adm.retention.hold.empty'])).toBeTruthy();
    expect(screen.getByText(vi_['adm.retention.review.empty'])).toBeTruthy();
    expect(document.querySelector('table')).toBeNull();
  });

  describe('writing a draft', () => {
    it('sends the body of the form for a business class, and says the draft waits for someone else (AC-ST-ADM-017-1)', async () => {
      const { h } = mount({ h: harness(() => new Error('no read'), () => ({ resource_id: 'new', status: 'DRAFTED', resource_version: 1 })) });
      await fillDraft();
      await saveDraft();
      expect((await screen.findByTestId('draft-saved')).textContent).toBe(vi_['adm.retention.draft.saved.text']);
      expect(h.command).toHaveBeenCalledWith(
        'createRetentionPolicyVersion',
        expect.objectContaining({ body: { record_class: 'project_dossier', retention_years: 10, retention_basis: 'FROM_CREATED', legal_basis_ref: 'TT 10/2022/TT-BNV CXN-RET-03', end_action: 'REVIEW_FOR_DESTRUCTION', effective_from: '2026-01-01' } }),
      );
    });

    it('does not offer a purge for a business class, nor a review for a technical class, and follows the class when it changes', async () => {
      mount();
      const actionOptions = (): string[] => [...(screen.getByLabelText(vi_['adm.retention.draft.endAction.label']) as HTMLSelectElement).options].map((option) => option.value);
      await pick(vi_['adm.retention.draft.class.label'], 'project_dossier');
      expect(actionOptions()).toEqual(['REVIEW_FOR_DESTRUCTION', 'ARCHIVE_TRANSFER']);
      await pick(vi_['adm.retention.draft.endAction.label'], 'ARCHIVE_TRANSFER');
      await pick(vi_['adm.retention.draft.class.label'], 'outbox_event');
      expect(actionOptions()).toEqual(['AUTO_PURGE_TECHNICAL']);
      expect((screen.getByLabelText(vi_['adm.retention.draft.endAction.label']) as HTMLSelectElement).value).toBe('AUTO_PURGE_TECHNICAL');
      const bases = [...(screen.getByLabelText(vi_['adm.retention.draft.basis.label']) as HTMLSelectElement).options].map((option) => option.value);
      expect(bases).toEqual(['FROM_CREATED', 'PERMANENT']);
      await pick(vi_['adm.retention.draft.class.label'], 'payment_dossier');
      expect(actionOptions()).toEqual(['REVIEW_FOR_DESTRUCTION', 'ARCHIVE_TRANSFER']);
      expect((screen.getByLabelText(vi_['adm.retention.draft.endAction.label']) as HTMLSelectElement).value).toBe('REVIEW_FOR_DESTRUCTION');
    });

    it('keeps a technical class on a basis it allows when the class changes from one that counted from the closing', async () => {
      mount();
      await pick(vi_['adm.retention.draft.class.label'], 'project_dossier');
      await pick(vi_['adm.retention.draft.basis.label'], 'FROM_CLOSED');
      await pick(vi_['adm.retention.draft.class.label'], 'user_session');
      expect((screen.getByLabelText(vi_['adm.retention.draft.basis.label']) as HTMLSelectElement).value).toBe('FROM_CREATED');
      await pick(vi_['adm.retention.draft.basis.label'], 'PERMANENT');
      await pick(vi_['adm.retention.draft.class.label'], 'outbox_event');
      expect((screen.getByLabelText(vi_['adm.retention.draft.basis.label']) as HTMLSelectElement).value).toBe('PERMANENT');
    });

    it('refuses PERMANENT with ten years and an empty form without asking the server (AC-ST-ADM-017-1)', async () => {
      const { h } = mount();
      await saveDraft();
      expect(await screen.findByText(vi_['adm.retention.field.required'])).toBeTruthy();
      expect(screen.getByText(vi_['adm.retention.error.yearsRequired'])).toBeTruthy();
      expect(screen.getByText(vi_['adm.retention.error.legalBasis'])).toBeTruthy();
      expect(screen.getByText(vi_['adm.retention.error.date'])).toBeTruthy();
      await pick(vi_['adm.retention.draft.class.label'], 'project_dossier');
      await pick(vi_['adm.retention.draft.basis.label'], 'PERMANENT');
      await userEvent.setup().type(screen.getByLabelText(vi_['adm.retention.draft.years.label']), '10');
      await saveDraft();
      expect(await screen.findByText(vi_['adm.retention.error.yearsNotAllowed'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('shows the findings of a 422 RETENTION_POLICY_INVALID in the words of the form', async () => {
      const failure = new ApiError({
        status: 422,
        code: 'RETENTION_POLICY_INVALID',
        correlationId: 'c',
        extensions: { errors: [{ field: 'retention_years', code: 'BELOW_PLATFORM_BASELINE' }, { field: 'effective_from', code: 'DATE_FUTURE' }] },
      });
      mount({ h: harness(() => new Error('no read'), () => failure) });
      await fillDraft();
      await saveDraft();
      const box = await screen.findByTestId('draft-problem');
      expect(within(box).getByText(vi_['adm.retention.problem.invalid'])).toBeTruthy();
      expect(within(box).getByText(vi_['adm.retention.error.belowBaseline'])).toBeTruthy();
      expect(within(box).getByText(vi_['adm.retention.error.dateFuture'])).toBeTruthy();
    });

    it.each([
      ['SCOPE_DENIED', 403, 'adm.retention.problem.denied'],
      ['INTERNAL_ERROR', 500, 'adm.retention.problem.general'],
      ['SESSION_EXPIRED', 401, 'adm.retention.problem.session'],
    ] as const)('says what happened when the draft is answered %s', async (code, status, key) => {
      mount({ h: harness(() => new Error('no read'), () => new ApiError({ status, code, correlationId: 'c' })) });
      await fillDraft();
      await saveDraft();
      expect(within(await screen.findByTestId('draft-problem')).getByText(vi_[key])).toBeTruthy();
    });

    it('forgets that a draft was saved as soon as the form changes', async () => {
      mount({ h: harness(() => new Error('no read'), () => ({ resource_id: 'new' })) });
      await fillDraft();
      await saveDraft();
      await screen.findByTestId('draft-saved');
      await userEvent.setup().type(screen.getByLabelText(vi_['adm.retention.draft.legalBasis.label']), ' more');
      expect(screen.queryByTestId('draft-saved')).toBeNull();
    });
  });

  describe('publishing', () => {
    const open = async (id: string): Promise<void> => {
      await userEvent.setup().click(within(rowOf(id)).getByRole('button', { name: vi_['adm.retention.publish.action'] }));
    };

    it('is offered on the draft of someone else and not on a published or an own draft, which says another person must publish it (BR-ADM-01)', () => {
      mount({ permissions: APPROVER });
      expect(within(rowOf('p-draft')).getByRole('button', { name: vi_['adm.retention.publish.action'] })).toBeTruthy();
      expect(within(rowOf('p-live')).queryByRole('button')).toBeNull();
      expect(within(rowOf('p-own')).queryByRole('button')).toBeNull();
      expect(within(rowOf('p-own')).getByTestId('own-draft').textContent).toBe(vi_['adm.retention.publish.own.hint']);
    });

    it('asks for a reason of 10 to 2000 characters and sends the version the person saw (UAT-AC142)', async () => {
      const { h } = mount({ permissions: APPROVER, h: harness(() => new Error('no read'), () => ({ resource_id: 'p-draft', status: 'PUBLISHED', resource_version: 2 })) });
      await open('p-draft');
      const panel = screen.getByTestId('publish-panel');
      expect(within(panel).getByText('project_dossier')).toBeTruthy();
      const user = userEvent.setup();
      await user.click(within(panel).getByRole('button', { name: vi_['adm.retention.publish.confirm.action'] }));
      expect(await within(panel).findByText(vi_['adm.retention.publish.reason.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.type(within(panel).getByLabelText(vi_['adm.retention.publish.reason.label']), 'Approved by the records council');
      await user.click(within(panel).getByRole('button', { name: vi_['adm.retention.publish.confirm.action'] }));
      await waitFor(() => expect(screen.queryByTestId('publish-panel')).toBeNull());
      expect(h.command).toHaveBeenCalledWith('publishRetentionPolicy', expect.objectContaining({ path: { policyId: 'p-draft' }, body: { reason: 'Approved by the records council' }, ifMatchVersion: 1 }));
    });

    it('can be cancelled, and starts over with an empty reason when opened again', async () => {
      mount({ permissions: APPROVER });
      await open('p-draft');
      await userEvent.setup().type(screen.getByLabelText(vi_['adm.retention.publish.reason.label']), 'A reason that is long enough');
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['adm.retention.publish.cancel.action'] }));
      expect(screen.queryByTestId('publish-panel')).toBeNull();
      await open('p-draft');
      expect((screen.getByLabelText(vi_['adm.retention.publish.reason.label']) as HTMLTextAreaElement).value).toBe('');
    });

    it.each([
      ['SELF_APPROVAL_DENIED', 403, 'adm.retention.problem.selfApproval'],
      ['VERSION_CONFLICT', 409, 'adm.retention.problem.conflict'],
      ['RESOURCE_NOT_FOUND', 404, 'adm.retention.problem.notFound'],
    ] as const)('says what happened when the publication is answered %s and keeps the panel open', async (code, status, key) => {
      mount({ permissions: APPROVER, h: harness(() => new Error('no read'), () => new ApiError({ status, code, correlationId: 'c' })) });
      await open('p-draft');
      await userEvent.setup().type(screen.getByLabelText(vi_['adm.retention.publish.reason.label']), 'Approved by the records council');
      await userEvent.setup().click(screen.getByRole('button', { name: vi_['adm.retention.publish.confirm.action'] }));
      expect((await screen.findByTestId('publish-problem')).textContent).toBe(vi_[key]);
      expect(screen.getByTestId('publish-panel')).toBeTruthy();
    });
  });

  describe('permissions', () => {
    it('shows the form to a manager only and the publication to an approver only', () => {
      mount({ permissions: MANAGER });
      expect(screen.getByRole('button', { name: vi_['adm.retention.draft.submit.action'] })).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['adm.retention.publish.action'] })).toBeNull();
      cleanup();
      mount({ permissions: APPROVER });
      expect(screen.queryByRole('button', { name: vi_['adm.retention.draft.submit.action'] })).toBeNull();
      expect(screen.getAllByRole('button', { name: vi_['adm.retention.publish.action'] }).length).toBeGreaterThan(0);
      cleanup();
      mount({ permissions: [] });
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('offers nothing to write while the tenant is suspended, whatever the grants say', () => {
      mount({ permissions: BOTH, mode: 'READ_ONLY' });
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.getByTestId('holds')).toBeTruthy();
    });

    it('offers both when the permissions are not known yet', () => {
      mount({ permissions: undefined });
      expect(screen.getByRole('button', { name: vi_['adm.retention.draft.submit.action'] })).toBeTruthy();
    });
  });

  it('starts the form over when the tenant is switched', async () => {
    const { view } = mount({ permissions: MANAGER });
    await userEvent.setup().type(screen.getByLabelText(vi_['adm.retention.draft.legalBasis.label']), 'typed for the first tenant');
    view.rerenderWith({ permissions: MANAGER, tenant: SECOND_TENANT });
    expect((screen.getByLabelText(vi_['adm.retention.draft.legalBasis.label']) as HTMLInputElement).value).toBe('');
  });

  it('shows the screen in English', () => {
    translator.setLocale('en');
    mount();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(en_['adm.retention.page.title']);
    expect(screen.getByText(en_['adm.retention.hold.title'])).toBeTruthy();
    expect(within(rowOf('p-live')).getByText(en_['adm.retention.period.years'].replace('{count}', '12'))).toBeTruthy();
  });
});
