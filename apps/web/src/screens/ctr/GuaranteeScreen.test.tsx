import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import GuaranteeScreen from './GuaranteeScreen';
import { ACCOUNTANT, GUARANTEE_OFFICER, GUARANTEE_READER, LEAD, SECOND, TENANT, client, contractId, detail, guarantee, mount, party, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('CTR-05', 'FR-CTR-05');
const problem = (code: string, status = 422, detailText?: string, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', detail: detailText, extensions });
const EVIDENCE = '00000000-0000-4000-8000-0000000000e1';
const DOCUMENT = '00000000-0000-4000-8000-0000000000d1';
const OTHER_PERSON = '00000000-0000-4000-8000-0000000000aa';
const ANSWER = { operation_id: 'o', status: 'ACTIVE', resource_version: 2, resource_id: 'g' };

afterEach(cleanup);

const pending = guarantee(1);
const active = guarantee(2, { status: 'ACTIVE', verification_status: 'VERIFIED', last_alert_days: 15, version: 2 });
const own = guarantee(3, { registered_by: TENANT.membershipId });
const expired = guarantee(4, { status: 'EXPIRED', verification_status: 'VERIFIED', kind: 'WARRANTY', version: 3 });
const released = guarantee(5, { status: 'RELEASED', verification_status: 'VERIFIED', release_reason: 'Hoàn thành nghĩa vụ', kind: 'INSURANCE', party_name: 'Liên danh Hà Giang', version: 3 });
const all = [pending, active, own, expired, released];

const opened = (command?: (operation: string, input: unknown) => unknown, overrides: Partial<World> = {}) => client(world({ guarantees: all, details: [detail(1)], ...overrides }), command ?? (() => ANSWER));
const open = (h: ReturnType<typeof opened>, permissions: readonly string[] | undefined = ACCOUNTANT, mode?: 'FULL' | 'READ_ONLY', path = '/') =>
  mount(<GuaranteeScreen route={ROUTE} />, h, { permissions, path, ...(mode === undefined ? {} : { mode }) });
const rowOf = (number: string): HTMLElement => {
  const found = screen.getAllByTestId('guarantee-row').find((row) => within(row).queryByText(number) !== null);
  if (found === undefined) throw new Error(`no row ${number}`);
  return found;
};
const ready = () => screen.findByTestId('guarantees');
const set = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const sent = (h: ReturnType<typeof opened>) => h.command.mock.calls as Array<[string, { path: { id: string }; body: Record<string, unknown>; ifMatchVersion?: number }]>;

describe('GuaranteeScreen (CTR-05): the guarantees and insurances', () => {
  it('lists the guarantees with the kind, issuer, number, amount, expiry, warning level, member, verification and release (UI-CTR-05)', async () => {
    open(opened());
    await ready();
    const rows = screen.getAllByTestId('guarantee-row');
    expect(rows).toHaveLength(5);
    const cells = (row: HTMLElement): string[] => within(row).getAllByRole('cell').map((cell) => cell.textContent ?? '');
    expect(cells(rowOf('BL-A-002'))).toEqual([
      `${vi_['ctr.guarantee.kind.performance.label']}${vi_['ctr.guarantee.status.active.label']}`,
      'Ngân hàng Tỉnh',
      'BL-A-002',
      '500.000.000',
      expect.stringContaining('2026-12-31'),
      vi_['ctr.guarantee.alert.d15.label'],
      '',
      vi_['ctr.guarantee.verification.verified.label'],
      '',
      expect.any(String),
    ]);
    expect(cells(rowOf('BL-A-005'))).toEqual([
      `${vi_['ctr.guarantee.kind.insurance.label']}${vi_['ctr.guarantee.status.released.label']}`,
      'Ngân hàng Tỉnh',
      'BL-A-005',
      '500.000.000',
      '2026-12-31',
      vi_['ctr.guarantee.alert.none.label'],
      'Liên danh Hà Giang',
      vi_['ctr.guarantee.verification.verified.label'],
      'Hoàn thành nghĩa vụ',
      '',
    ]);
    for (const column of ['kind', 'issuer', 'number', 'amount', 'expires', 'alert', 'member', 'verification', 'release'] as const) {
      expect(screen.getByRole('columnheader', { name: vi_[`ctr.guarantee.column.${column}`] })).toBeTruthy();
    }
    expect(within(rowOf('BL-A-002')).getByText(/còn \d+ ngày|còn -\d+ ngày/)).toBeTruthy();
  });

  it('names every status, kind and warning level', async () => {
    const warned = [30, 15, 7, 0].map((days, index) => guarantee(10 + index, { status: 'ACTIVE', last_alert_days: days, kind: index % 2 === 0 ? 'ADVANCE' : 'PERFORMANCE', version: 2 }));
    const states = ['CALLED', 'SUPERSEDED', 'REJECTED'].map((status, index) => guarantee(20 + index, { status, verification_status: status === 'REJECTED' ? 'FAILED' : 'VERIFIED' }));
    open(opened(undefined, { guarantees: [...warned, ...states] }));
    await ready();
    expect(rowOf('BL-A-0010').textContent).toContain(vi_['ctr.guarantee.alert.d30.label']);
    expect(rowOf('BL-A-0011').textContent).toContain(vi_['ctr.guarantee.alert.d15.label']);
    expect(rowOf('BL-A-0012').textContent).toContain(vi_['ctr.guarantee.alert.d7.label']);
    expect(rowOf('BL-A-0013').textContent).toContain(vi_['ctr.guarantee.alert.d0.label']);
    expect(rowOf('BL-A-0020').textContent).toContain(vi_['ctr.guarantee.status.called.label']);
    expect(rowOf('BL-A-0021').textContent).toContain(vi_['ctr.guarantee.status.superseded.label']);
    expect(rowOf('BL-A-0022').textContent).toContain(vi_['ctr.guarantee.status.rejected.label']);
    expect(rowOf('BL-A-0022').textContent).toContain(vi_['ctr.guarantee.verification.failed.label']);
    expect(rowOf('BL-A-0010').textContent).toContain(vi_['ctr.guarantee.kind.advance.label']);
  });

  it('filters by status, kind and a word, and says when nothing matches', async () => {
    open(opened());
    await ready();
    set(vi_['ctr.guarantee.status.label'], 'ACTIVE');
    expect(screen.getAllByTestId('guarantee-row')).toHaveLength(1);
    set(vi_['ctr.guarantee.status.label'], '');
    set(vi_['ctr.guarantee.kind.label'], 'WARRANTY');
    expect(screen.getAllByTestId('guarantee-row')).toHaveLength(1);
    set(vi_['ctr.guarantee.kind.label'], '');
    set(vi_['ctr.guarantee.query.label'], 'bl-a-003');
    expect(screen.getAllByTestId('guarantee-row')).toHaveLength(1);
    set(vi_['ctr.guarantee.query.label'], 'nothing');
    expect(screen.getByTestId('no-guarantees').textContent).toBe(vi_['ctr.guarantee.list.empty']);
  });

  it('shows the guarantees of one contract when it is named, with its code in the title and a way back to the draft and to the BOQ', async () => {
    const elsewhere = guarantee(30, { contract_id: contractId(2), contract_code: 'HD-A-002' });
    open(opened(undefined, { guarantees: [...all, elsewhere] }), ACCOUNTANT, undefined, `/?id=${contractId(1)}`);
    await ready();
    expect(screen.getAllByTestId('guarantee-row')).toHaveLength(5);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`HD-A-001 · ${vi_['ctr.guarantee.page.title']}`));
    expect(screen.getByRole('link', { name: vi_['ctr.guarantee.boq.action'] }).getAttribute('href')).toBe(`/ctr/ctr-04?id=${contractId(1)}`);
    expect(screen.getByRole('link', { name: new RegExp(vi_['ctr.back.draft.link']) }).getAttribute('href')).toBe(`/ctr/ctr-02?id=${contractId(1)}`);
  });

  it('offers each command only for a status that allows it and a person who holds its permission', async () => {
    open(opened());
    await ready();
    const buttons = (number: string): string[] => within(rowOf(number)).queryAllByRole('button').map((button) => button.textContent ?? '');
    expect(buttons('BL-A-001')).toEqual([vi_['ctr.guarantee.verify.action']]);
    expect(buttons('BL-A-002')).toEqual([vi_['ctr.guarantee.extend.action'], vi_['ctr.guarantee.release.action']]);
    expect(buttons('BL-A-004')).toEqual([vi_['ctr.guarantee.release.action']]);
    expect(buttons('BL-A-005')).toEqual([]);
    // The person who registered a guarantee is told they may not verify it, and is not offered the release of it.
    expect(buttons('BL-A-003')).toEqual([]);
    expect(within(rowOf('BL-A-003')).getByTestId('own-registration').textContent).toBe(vi_['ctr.guarantee.verify.own.hint']);
  });

  it.each([
    ['a reader of guarantees', GUARANTEE_READER, undefined],
    ['a session that is read only', ACCOUNTANT, 'READ_ONLY' as const],
  ])('gives %s no command and no register button', async (_name, permissions, mode) => {
    open(opened(), permissions, mode, `/?id=${contractId(1)}`);
    await ready();
    expect(screen.queryAllByRole('button').map((button) => button.textContent)).toEqual([vi_['ctr.guarantee.tab.all'], vi_['ctr.guarantee.tab.expiring']]);
  });

  it('does not offer the verification to an officer who may only register, nor the registration to an accountant who may only verify', async () => {
    open(opened(), GUARANTEE_OFFICER, undefined, `/?id=${contractId(1)}`);
    await ready();
    expect(within(rowOf('BL-A-001')).queryAllByRole('button')).toEqual([]);
    expect(within(rowOf('BL-A-002')).getAllByRole('button').map((button) => button.textContent)).toEqual([vi_['ctr.guarantee.extend.action']]);
    expect(screen.getByRole('button', { name: vi_['ctr.guarantee.register.open'] })).toBeTruthy();
    cleanup();
    open(opened(), ['guarantee.read', 'guarantee.verify'], undefined, `/?id=${contractId(1)}`);
    await ready();
    expect(screen.queryByRole('button', { name: vi_['ctr.guarantee.register.open'] })).toBeNull();
  });

  describe('the registration', () => {
    const fill = (): void => {
      set(vi_['ctr.guarantee.field.issuer.label'], ' Ngân hàng Tỉnh ');
      set(vi_['ctr.guarantee.field.number.label'], 'BL-NEW-1');
      set(vi_['ctr.guarantee.field.amount.label'], '750000000');
      set(vi_['ctr.guarantee.field.validFrom.label'], '2026-10-01');
      set(vi_['ctr.guarantee.field.expiresOn.label'], '2027-03-31');
      set(vi_['ctr.guarantee.field.document.label'], DOCUMENT);
    };
    const registering = async (h: ReturnType<typeof opened>, contract: Record<string, unknown> = detail(1)) => {
      open(h, GUARANTEE_OFFICER, undefined, `/?id=${contractId(1)}`);
      void contract;
      await ready();
      fireEvent.click(screen.getByRole('button', { name: vi_['ctr.guarantee.register.open'] }));
    };
    const submit = (): void => {
      fireEvent.click(screen.getByRole('button', { name: vi_['ctr.guarantee.register.action'] }));
    };

    it('registers a guarantee under the contract with the end of the day as its expiry, and closes the form', async () => {
      const h = opened();
      await registering(h);
      set(vi_['ctr.guarantee.field.kind.label'], 'ADVANCE');
      fill();
      submit();
      await waitFor(() => expect(screen.queryByRole('form', { name: vi_['ctr.guarantee.register.title'] })).toBeNull());
      const [operation, input] = sent(h)[0] ?? ['', undefined];
      expect(operation).toBe('registerGuarantee');
      expect(input?.path.id).toBe(contractId(1));
      expect(input?.body).toEqual({
        kind: 'ADVANCE',
        issuer: 'Ngân hàng Tỉnh',
        guarantee_no: 'BL-NEW-1',
        amount_vnd: '750000000',
        valid_from: '2026-10-01',
        expires_at: '2027-03-31T23:59:00+07:00',
        document_version_id: DOCUMENT,
      });
    });

    it('offers the members of a joint venture to be covered', async () => {
      const members = [party(1, LEAD, 'Công ty Xây dựng An Phát', 'LEAD', '60.0000', '6000000000'), party(2, SECOND, 'Công ty Cơ khí Bình Minh', 'MEMBER', '40.0000', '4000000000')];
      const h = opened(undefined, { details: [detail(1, { is_joint_venture: true, parties: members })] });
      await registering(h);
      await screen.findByLabelText(vi_['ctr.guarantee.field.party.label']);
      const options = within(screen.getByLabelText(vi_['ctr.guarantee.field.party.label'])).getAllByRole('option').map((option) => option.textContent);
      expect(options).toEqual([vi_['ctr.guarantee.field.party.none'], 'Công ty Xây dựng An Phát', 'Công ty Cơ khí Bình Minh']);
      fill();
      set(vi_['ctr.guarantee.field.party.label'], (members[1] as { id: string }).id);
      submit();
      await waitFor(() => expect(sent(h)).toHaveLength(1));
      expect(sent(h)[0]?.[1].body.party_id).toBe((members[1] as { id: string }).id);
    });

    it('names the faults of the form before sending anything', async () => {
      const h = opened();
      await registering(h);
      submit();
      expect(h.command).not.toHaveBeenCalled();
      expect(within(screen.getByRole('form', { name: vi_['ctr.guarantee.register.title'] })).getAllByRole('alert').length).toBeGreaterThanOrEqual(6);
      fill();
      set(vi_['ctr.guarantee.field.amount.label'], '0');
      set(vi_['ctr.guarantee.field.expiresOn.label'], '2026-09-30');
      submit();
      expect(screen.getByText(vi_['ctr.guarantee.field.zeroAmount.error'])).toBeTruthy();
      expect(screen.getByText(vi_['ctr.guarantee.field.endBeforeStart.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: vi_['ctr.guarantee.cancel.action'] }));
      expect(screen.queryByRole('form', { name: vi_['ctr.guarantee.register.title'] })).toBeNull();
    });

    it.each([
      [problem('GUARANTEE_DUPLICATE', 409), vi_['ctr.guarantee.problem.duplicate.error']],
      [problem('CONTRACT_STATE_INVALID', 409), vi_['ctr.guarantee.problem.contractState.error']],
      [problem('VALIDATION_FAILED', 422, 'party_id'), vi_['ctr.guarantee.problem.validationField.error'].replace('{field}', 'party_id')],
      [problem('SCOPE_DENIED', 403), vi_['ctr.guarantee.problem.denied.error']],
      [problem('RESOURCE_NOT_FOUND', 404), vi_['ctr.guarantee.problem.notFound.error']],
      [new Error('network'), vi_['ctr.guarantee.problem.general.error']],
    ])('answers a refusal in a sentence and keeps the form (%#)', async (error, sentence) => {
      await registering(opened(() => error));
      fill();
      submit();
      expect((await screen.findByTestId('problem')).textContent).toBe(sentence);
      expect(screen.getByRole('form', { name: vi_['ctr.guarantee.register.title'] })).toBeTruthy();
    });
  });

  describe('the verification', () => {
    const openPanel = async (h: ReturnType<typeof opened>, number = 'BL-A-001'): Promise<void> => {
      open(h);
      await ready();
      fireEvent.click(within(rowOf(number)).getByRole('button', { name: vi_['ctr.guarantee.verify.action'] }));
    };
    const fill = (): void => {
      set(vi_['ctr.guarantee.field.method.label'], ' Letter to the issuer ');
      set(vi_['ctr.guarantee.field.evidence.label'], EVIDENCE);
    };
    const submit = (): void => {
      fireEvent.click(screen.getByRole('button', { name: vi_['ctr.guarantee.verify.submit'] }));
    };

    it('records the check under the version it saw, and says the guarantee is active (AC-ST-CTR-003-1)', async () => {
      const h = opened();
      await openPanel(h);
      expect(screen.getByText(vi_['ctr.guarantee.panel.subject'].replace('{number}', 'BL-A-001').replace('{issuer}', 'Ngân hàng Tỉnh'))).toBeTruthy();
      fill();
      submit();
      expect((await screen.findByTestId('notice')).textContent).toBe(vi_['ctr.guarantee.verify.verified.notice']);
      const [operation, input] = sent(h)[0] ?? ['', undefined];
      expect(operation).toBe('verifyGuarantee');
      expect(input?.path.id).toBe(pending.id);
      expect(input?.ifMatchVersion).toBe(1);
      expect(input?.body).toEqual({ outcome: 'VERIFIED', method: 'Letter to the issuer', evidence_document_version_id: EVIDENCE });
      expect(screen.queryByTestId('action-panel')).toBeNull();
    });

    it('closes the panel and says what happened even though the read that follows the command brings the new version of the guarantee', async () => {
      const state = world({ guarantees: [...all], details: [detail(1)] });
      const h = client(state, () => {
        state.guarantees[0] = guarantee(1, { status: 'ACTIVE', verification_status: 'VERIFIED', version: 2 });
        return ANSWER;
      });
      // The reads that follow the command do not end together, as on a network: the list brings the new version while the contract is still being read, and the panel is on the screen when it arrives.
      const read = h.client.read as unknown as (operation: string, input?: unknown) => Promise<unknown>;
      (h.client as unknown as { read: unknown }).read = async (operation: string, input?: unknown): Promise<unknown> => {
        const answer = await read(operation, input);
        await new Promise((resolve) => setTimeout(resolve, 80));
        return answer;
      };
      open(h, ACCOUNTANT, undefined, `/?id=${contractId(1)}`);
      await ready();
      fireEvent.click(within(rowOf('BL-A-001')).getByRole('button', { name: vi_['ctr.guarantee.verify.action'] }));
      fill();
      submit();
      expect((await screen.findByTestId('notice')).textContent).toBe(vi_['ctr.guarantee.verify.verified.notice']);
      expect(screen.queryByTestId('action-panel')).toBeNull();
      await waitFor(() => expect(rowOf('BL-A-001').textContent).toContain(vi_['ctr.guarantee.status.active.label']));
    });

    it('records a failed check as a rejection', async () => {
      const h = opened();
      await openPanel(h);
      set(vi_['ctr.guarantee.field.outcome.label'], 'FAILED');
      fill();
      submit();
      expect((await screen.findByTestId('notice')).textContent).toBe(vi_['ctr.guarantee.verify.failed.notice']);
      expect(sent(h)[0]?.[1].body.outcome).toBe('FAILED');
    });

    it('asks for the method and the evidence before sending, and can be cancelled', async () => {
      const h = opened();
      await openPanel(h);
      submit();
      expect(within(screen.getByTestId('action-panel')).getAllByRole('alert')).toHaveLength(2);
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: vi_['ctr.guarantee.cancel.action'] }));
      expect(screen.queryByTestId('action-panel')).toBeNull();
    });

    it('tells that the registrant may not verify when the server refuses it', async () => {
      const h = opened(() => problem('SELF_APPROVAL_DENIED', 403));
      await openPanel(h);
      fill();
      submit();
      expect((await screen.findByTestId('problem')).textContent).toBe(vi_['ctr.guarantee.problem.selfApproval.error']);
    });

    it.each([
      [problem('GUARANTEE_STATE_INVALID', 409), vi_['ctr.guarantee.problem.stateInvalid.error']],
      [problem('VERSION_CONFLICT', 409), vi_['ctr.guarantee.problem.versionConflict.error']],
      [problem('VALIDATION_FAILED'), vi_['ctr.guarantee.problem.validation.error']],
    ])('answers a refusal in a sentence (%#)', async (error, sentence) => {
      await openPanel(opened(() => error));
      fill();
      submit();
      expect((await screen.findByTestId('problem')).textContent).toBe(sentence);
    });
  });

  describe('the extension', () => {
    const openPanel = async (h: ReturnType<typeof opened>): Promise<void> => {
      open(h);
      await ready();
      fireEvent.click(within(rowOf('BL-A-002')).getByRole('button', { name: vi_['ctr.guarantee.extend.action'] }));
    };
    const submit = (): void => {
      fireEvent.click(screen.getByRole('button', { name: vi_['ctr.guarantee.extend.submit'] }));
    };

    it('replaces the guarantee with a new one that waits for its verification, and says so', async () => {
      const h = opened();
      await openPanel(h);
      expect(screen.getByText(vi_['ctr.guarantee.extend.rule'])).toBeTruthy();
      expect(screen.getByText(vi_['ctr.guarantee.extend.current'].replace('{date}', '2026-12-31'))).toBeTruthy();
      set(vi_['ctr.guarantee.field.newExpiresOn.label'], '2027-06-30');
      set(vi_['ctr.guarantee.field.newNumber.label'], 'BL-A-002-X');
      set(vi_['ctr.guarantee.field.document.label'], DOCUMENT);
      submit();
      expect((await screen.findByTestId('notice')).textContent).toBe(vi_['ctr.guarantee.extend.done.notice']);
      const [operation, input] = sent(h)[0] ?? ['', undefined];
      expect(operation).toBe('extendGuarantee');
      expect(input?.path.id).toBe(active.id);
      expect(input?.ifMatchVersion).toBe(2);
      expect(input?.body).toEqual({ new_expires_at: '2027-06-30T23:59:00+07:00', new_guarantee_no: 'BL-A-002-X', document_version_id: DOCUMENT });
    });

    it('refuses an expiry that does not go beyond the current one before sending', async () => {
      const h = opened();
      await openPanel(h);
      set(vi_['ctr.guarantee.field.newExpiresOn.label'], '2026-12-31');
      set(vi_['ctr.guarantee.field.newNumber.label'], 'BL-A-002-X');
      set(vi_['ctr.guarantee.field.document.label'], DOCUMENT);
      submit();
      expect(screen.getByText(vi_['ctr.guarantee.field.notLater.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('answers a refusal in a sentence', async () => {
      await openPanel(opened(() => problem('GUARANTEE_DUPLICATE', 409)));
      set(vi_['ctr.guarantee.field.newExpiresOn.label'], '2027-06-30');
      set(vi_['ctr.guarantee.field.newNumber.label'], 'BL-A-002');
      set(vi_['ctr.guarantee.field.document.label'], DOCUMENT);
      submit();
      expect((await screen.findByTestId('problem')).textContent).toBe(vi_['ctr.guarantee.problem.duplicate.error']);
    });
  });

  describe('the release', () => {
    const openPanel = async (h: ReturnType<typeof opened>, number = 'BL-A-002'): Promise<void> => {
      open(h);
      await ready();
      fireEvent.click(within(rowOf(number)).getByRole('button', { name: vi_['ctr.guarantee.release.action'] }));
    };
    const submit = (): void => {
      fireEvent.click(screen.getByRole('button', { name: vi_['ctr.guarantee.release.submit'] }));
    };
    const fill = (): void => {
      set(vi_['ctr.guarantee.field.releaseEvidence.label'], EVIDENCE);
      set(vi_['ctr.guarantee.field.reason.label'], ' Obligation completed ');
    };

    it('releases against evidence and a reason, under the version it saw', async () => {
      const h = opened();
      await openPanel(h);
      submit();
      expect(within(screen.getByTestId('action-panel')).getAllByRole('alert')).toHaveLength(2);
      expect(h.command).not.toHaveBeenCalled();
      fill();
      submit();
      expect((await screen.findByTestId('notice')).textContent).toBe(vi_['ctr.guarantee.release.done.notice']);
      const [operation, input] = sent(h)[0] ?? ['', undefined];
      expect(operation).toBe('releaseGuarantee');
      expect(input?.path.id).toBe(active.id);
      expect(input?.ifMatchVersion).toBe(2);
      expect(input?.body).toEqual({ release_evidence_id: EVIDENCE, reason: 'Obligation completed' });
    });

    it('warns of an advance still owed on an advance guarantee, and tells why the server refused the release', async () => {
      const advance = guarantee(6, { kind: 'ADVANCE', status: 'ACTIVE', verification_status: 'VERIFIED', version: 2, advance_outstanding_vnd: '1250000000', registered_by: OTHER_PERSON });
      const h = opened(() => problem('RELEASE_CONDITION_NOT_MET', 422, 'advance_outstanding_vnd', { advance_outstanding_vnd: '1250000000' }), { guarantees: [advance] });
      await openPanel(h, 'BL-A-006');
      expect(screen.getByTestId('advance-owed').textContent).toBe(vi_['ctr.guarantee.release.owed'].replace('{amount}', '1.250.000.000'));
      fill();
      submit();
      expect((await screen.findByTestId('problem')).textContent).toBe(vi_['ctr.guarantee.problem.releaseCondition.error'].replace('{amount}', '1.250.000.000'));
    });

    it('does not warn when no advance is owed, and has a sentence for a refusal that names no amount', async () => {
      const advance = guarantee(6, { kind: 'ADVANCE', status: 'ACTIVE', verification_status: 'VERIFIED', version: 2, advance_outstanding_vnd: '0' });
      await openPanel(opened(() => problem('RELEASE_CONDITION_NOT_MET'), { guarantees: [advance] }), 'BL-A-006');
      expect(screen.queryByTestId('advance-owed')).toBeNull();
      fill();
      submit();
      expect((await screen.findByTestId('problem')).textContent).toBe(vi_['ctr.guarantee.problem.releaseConditionUnknown.error']);
    });
  });

  describe('the guarantees about to expire', () => {
    const soon = [
      guarantee(7, { kind: 'ADVANCE', status: 'ACTIVE', days_left: 3, expires_on: '2026-10-27', advance_outstanding_vnd: '1250000000' }),
      guarantee(8, { status: 'ACTIVE', days_left: 20, expires_on: '2026-11-13' }),
    ];
    const goToExpiring = async (h: ReturnType<typeof opened>, path = '/'): Promise<void> => {
      open(h, ACCOUNTANT, undefined, path);
      await ready();
      fireEvent.click(screen.getByRole('button', { name: vi_['ctr.guarantee.tab.expiring'] }));
    };
    const openTab = async (h: ReturnType<typeof opened>, path = '/'): Promise<HTMLElement> => {
      await goToExpiring(h, path);
      return screen.findByTestId('expiring');
    };

    it('lists them with the days left and the advance still owed, and reads again for another window', async () => {
      const h = opened(undefined, { expiring: soon });
      await openTab(h);
      const rows = screen.getAllByTestId('expiring-row').map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
      expect(rows).toEqual([
        [vi_['ctr.guarantee.kind.advance.label'], 'HD-A-001', 'Ngân hàng Tỉnh', '500.000.000', '2026-10-27', '3', '1.250.000.000'],
        [vi_['ctr.guarantee.kind.performance.label'], 'HD-A-001', 'Ngân hàng Tỉnh', '500.000.000', '2026-11-13', '20', ''],
      ]);
      expect(h.read.mock.calls.at(-1)).toEqual(['listExpiringGuarantees', { query: { within_days: 30, limit: 200 } }]);
      set(vi_['ctr.guarantee.window.label'], '7');
      await waitFor(() => expect(h.read.mock.calls.at(-1)).toEqual(['listExpiringGuarantees', { query: { within_days: 7, limit: 200 } }]));
      expect(screen.getByRole('button', { name: vi_['ctr.guarantee.tab.expiring'] }).getAttribute('aria-pressed')).toBe('true');
    });

    it('offers the four windows of the reminders and says when nothing expires in one', async () => {
      const h = opened(undefined, { expiring: [] });
      await goToExpiring(h);
      expect((await screen.findByTestId('none-expiring')).textContent).toBe(vi_['ctr.guarantee.expiring.empty']);
      const options = within(screen.getByLabelText(vi_['ctr.guarantee.window.label'])).getAllByRole('option').map((option) => option.textContent);
      expect(options).toEqual([vi_['ctr.guarantee.window.d30.label'], vi_['ctr.guarantee.window.d15.label'], vi_['ctr.guarantee.window.d7.label'], vi_['ctr.guarantee.window.d0.label']]);
      set(vi_['ctr.guarantee.window.label'], '0');
      await waitFor(() => expect(h.read.mock.calls.at(-1)).toEqual(['listExpiringGuarantees', { query: { within_days: 0, limit: 200 } }]));
    });

    it('shows only the contract that is named, and can go back to all the guarantees', async () => {
      const elsewhere = guarantee(9, { contract_id: contractId(2), contract_code: 'HD-A-002', status: 'ACTIVE', days_left: 5 });
      await openTab(opened(undefined, { expiring: [...soon, elsewhere] }), `/?id=${contractId(1)}`);
      expect(screen.getAllByTestId('expiring-row')).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: vi_['ctr.guarantee.tab.all'] }));
      expect(screen.getByTestId('guarantees')).toBeTruthy();
    });

    it('shows the state of the screen when the read fails', async () => {
      const h = opened(undefined, { failing: new Set(['listExpiringGuarantees']) });
      open(h);
      await ready();
      fireEvent.click(screen.getByRole('button', { name: vi_['ctr.guarantee.tab.expiring'] }));
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });
  });

  it('shows the state of the screen when the register cannot be read, and the footer with its requirement', async () => {
    open(opened(undefined, { failing: new Set(['get_resources_guarantee']) }));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    expect(screen.getByText(vi_['ctr.guarantee.footer.reference'].replace('{id}', 'CTR-05').replace('{req}', 'FR-CTR-05'))).toBeTruthy();
  });
});
