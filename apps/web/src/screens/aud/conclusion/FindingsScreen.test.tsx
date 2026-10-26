import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { CONTRACT, PROJECT, READER, RECORDER, UNIT, client, conclusionRecord, detailRecord, engagementRecord, findingRecord, mount, routeOf, world } from '../test-support';
import FindingsScreen from './FindingsScreen';

const ROUTE = routeOf('AUD-05', 'FR-AUD-05');
const ID = detailRecord(1).id as string;
const CONCLUSION = conclusionRecord().id as string;
const PATH = `/aud/aud-05?engagement=${ID}`;

afterEach(cleanup);

interface Setup {
  engagement?: Record<string, unknown>;
  conclusion?: Record<string, unknown> | null;
  findings?: Array<Record<string, unknown>>;
}

const stateOf = ({ engagement = {}, conclusion = conclusionRecord(), findings }: Setup) =>
  world({
    engagements: [engagementRecord(1, { status: 'FOLLOW_UP', ...engagement })],
    details: { [ID]: detailRecord(1, { status: 'FOLLOW_UP', ...engagement }) },
    conclusions: { [ID]: conclusion === null ? [] : [conclusion] },
    findings: { [CONCLUSION]: findings ?? [findingRecord(1), findingRecord(2, { project: null, contract: { id: CONTRACT, code: 'HD-A-001' }, organization_unit: null, amount_vnd: null, legal_basis_cited: null, severity: 'LOW', category: 'PROCEDURE' })] },
  });

const open = (setup: Setup = {}, permissions: readonly string[] | undefined = RECORDER, command: (operation: string, input: unknown) => unknown = () => ({ status: 'OK' }), mode?: 'FULL' | 'READ_ONLY') => {
  const h = client(stateOf(setup), command);
  mount(<FindingsScreen route={ROUTE} />, h, { permissions, path: PATH, ...(mode === undefined ? {} : { mode }) });
  return h;
};

describe('AUD-05 findings of a conclusion', () => {
  it('lists the findings with their group, the place, the unit, the amount in dong, the severity and the rule they break, and dashes for what a finding does not have', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['aud.finding.page.title'] })).toBeTruthy();
    const rows = (await screen.findAllByRole('row')).slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows.map((row) => [row[0]?.slice(0, 6), ...row.slice(1)])).toEqual([
      ['PH-001', vi_['aud.findingCategory.financial'], 'DA-2026-001 · Cầu qua sông', 'Sở Xây dựng', '300.000.000', vi_['aud.findingSeverity.high'], 'Điều 12 Luật Đầu tư công'],
      ['PH-002', vi_['aud.findingCategory.procedure'], 'HD-A-001', '—', '—', vi_['aud.findingSeverity.low'], '—'],
    ]);
    expect(screen.getByRole('heading', { level: 2, name: vi_['aud.finding.list.title'].replace('{code}', 'TTCP-2026-001') })).toBeTruthy();
    expect(screen.getByRole('link', { name: vi_['aud.finding.list.conclusion.link'] }).getAttribute('href')).toBe(`/aud/aud-04?engagement=${ID}`);
  });

  it('says there are none when the conclusion has no finding', async () => {
    open({ findings: [] });
    expect((await screen.findByTestId('no-findings')).textContent).toBe(vi_['aud.finding.none.text']);
  });

  it('says the engagement has no conclusion, and where to receive it, when it has none (or only a superseded one)', async () => {
    for (const conclusion of [null, conclusionRecord({ status: 'SUPERSEDED' })]) {
      open({ conclusion });
      const note = await screen.findByTestId('finding-no-conclusion');
      expect(note.textContent).toContain(vi_['aud.finding.noConclusion.note']);
      expect(within(note).getByRole('link', { name: vi_['aud.finding.noConclusion.link'] }).getAttribute('href')).toBe(`/aud/aud-04?engagement=${ID}`);
      cleanup();
    }
  });

  it('offers the finding to whoever may record, on the current revision of an engagement that is followed up and not otherwise', async () => {
    open();
    await screen.findAllByRole('row');
    expect(screen.getByRole('button', { name: vi_['aud.finding.add.action'] })).toBeTruthy();
    cleanup();
    open({}, READER);
    await screen.findAllByRole('row');
    expect(screen.queryByRole('button', { name: vi_['aud.finding.add.action'] })).toBeNull();
    cleanup();
    open({}, RECORDER, undefined, 'READ_ONLY');
    await screen.findAllByRole('row');
    expect(screen.queryByRole('button', { name: vi_['aud.finding.add.action'] })).toBeNull();
    cleanup();
    open({ engagement: { status: 'CLOSED' } });
    await screen.findAllByRole('row');
    expect(screen.queryByRole('button', { name: vi_['aud.finding.add.action'] })).toBeNull();
  });

  describe('adding a finding', () => {
    const dialog = async (command: (operation: string, input: unknown) => unknown = () => ({ status: 'OK' })) => {
      const h = open({}, RECORDER, command);
      const user = userEvent.setup();
      await user.click(await screen.findByRole('button', { name: vi_['aud.finding.add.action'] }));
      return { h, user, box: screen.getByRole('dialog') };
    };

    it('offers only the places of the engagement, and sends the finding with the place as the field of its kind', async () => {
      const { h, user, box } = await dialog();
      const place = within(box).getByLabelText(vi_['aud.finding.dialog.place.label']);
      expect(within(place).getAllByRole('option').map((option) => option.textContent)).toEqual([
        vi_['aud.finding.dialog.place.none'],
        `${vi_['aud.scopeKind.contract']} · HD-A-001`,
        `${vi_['aud.scopeKind.project']} · DA-2026-001`,
      ]);
      await user.type(within(box).getByLabelText(vi_['aud.finding.dialog.code.label']), 'PH-003');
      await user.selectOptions(within(box).getByLabelText(vi_['aud.finding.dialog.category.label']), 'PROCUREMENT');
      await user.selectOptions(within(box).getByLabelText(vi_['aud.finding.dialog.severity.label']), 'CRITICAL');
      await user.selectOptions(place, `PROJECT:${PROJECT}`);
      await user.type(within(box).getByLabelText(vi_['aud.finding.dialog.amount.label']), '1.500.000');
      await user.type(within(box).getByLabelText(vi_['aud.finding.dialog.description.label']), 'Chia nhỏ gói thầu để chỉ định thầu.');
      await user.type(within(box).getByLabelText(vi_['aud.finding.dialog.legalBasis.label']), 'Điều 16 Luật Đấu thầu');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('recordAuditFinding');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({
        path: { id: CONCLUSION },
        body: {
          finding_code: 'PH-003',
          category: 'PROCUREMENT',
          severity: 'CRITICAL',
          project_id: PROJECT,
          amount_vnd: '1500000',
          description: 'Chia nhỏ gói thầu để chỉ định thầu.',
          legal_basis_cited: 'Điều 16 Luật Đấu thầu',
        },
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('sends a contract or a unit as its own field, and none when no place is chosen', async () => {
      for (const [choice, field] of [
        [`CONTRACT:${CONTRACT}`, 'contract_id'],
        [`UNIT:${UNIT}`, 'organization_unit_id'],
        ['', undefined],
      ] as const) {
        cleanup();
        const state = stateOf({});
        const unitScope = [...(state.details[ID]?.scope as Array<Record<string, unknown>>), { kind: 'UNIT', id: UNIT, code: 'SXD', name: 'Sở Xây dựng' }];
        state.details[ID] = { ...(state.details[ID] as Record<string, unknown>), scope: unitScope };
        const h = client(state, () => ({ status: 'OK' }));
        mount(<FindingsScreen route={ROUTE} />, h, { permissions: RECORDER, path: PATH });
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: vi_['aud.finding.add.action'] }));
        const box = screen.getByRole('dialog');
        await user.type(within(box).getByLabelText(vi_['aud.finding.dialog.code.label']), 'PH-004');
        await user.selectOptions(within(box).getByLabelText(vi_['aud.finding.dialog.category.label']), 'OTHER');
        await user.selectOptions(within(box).getByLabelText(vi_['aud.finding.dialog.severity.label']), 'LOW');
        if (choice !== '') await user.selectOptions(within(box).getByLabelText(vi_['aud.finding.dialog.place.label']), choice);
        await user.type(within(box).getByLabelText(vi_['aud.finding.dialog.description.label']), 'Hồ sơ thiếu chữ ký của chủ đầu tư.');
        await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
        await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
        const body = (h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body;
        for (const key of ['project_id', 'contract_id', 'organization_unit_id']) {
          if (key === field) expect(body[key]).toBeTruthy();
          else expect(body).not.toHaveProperty(key);
        }
        expect(body).not.toHaveProperty('amount_vnd');
        expect(body).not.toHaveProperty('legal_basis_cited');
      }
    });

    it('says what is missing and what is wrong without sending anything', async () => {
      const { h, user, box } = await dialog();
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getAllByText(vi_['aud.formProblem.required']).length).toBe(4);
      await user.type(within(box).getByLabelText(vi_['aud.finding.dialog.amount.label']), '12x');
      await user.type(within(box).getByLabelText(vi_['aud.finding.dialog.description.label']), 'ngắn');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getByText(vi_['aud.formProblem.invalid'])).toBeTruthy();
      expect(within(box).getByText(vi_['aud.formProblem.tooShort'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    const REFUSALS: Array<[string, string]> = [
      ['FINDING_CODE_DUPLICATE', vi_['aud.conclusionProblem.findingDuplicate']],
      ['TARGET_OUT_OF_ENGAGEMENT', vi_['aud.conclusionProblem.targetOutside']],
      ['ENGAGEMENT_STATE_INVALID', vi_['aud.conclusionProblem.stateInvalid']],
      ['RESOURCE_NOT_FOUND', vi_['aud.conclusionProblem.notFound']],
    ];

    it.each(REFUSALS)('tells the refusal %s of the server in words and keeps the dialog', async (code, message) => {
      const { user, box } = await dialog(() => new ApiError({ status: 409, code, correlationId: 'c' }));
      await user.type(within(box).getByLabelText(vi_['aud.finding.dialog.code.label']), 'PH-009');
      await user.selectOptions(within(box).getByLabelText(vi_['aud.finding.dialog.category.label']), 'QUALITY');
      await user.selectOptions(within(box).getByLabelText(vi_['aud.finding.dialog.severity.label']), 'MEDIUM');
      await user.type(within(box).getByLabelText(vi_['aud.finding.dialog.description.label']), 'Bê tông không đạt mác thiết kế.');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect((await within(box).findByTestId('refusal')).textContent).toBe(message);
      expect(screen.getByRole('dialog')).toBeTruthy();
    });
  });

  describe('choosing the engagement and the seven states', () => {
    it('with none chosen asks for one, and offers the engagements that have a conclusion or can take one', async () => {
      mount(<FindingsScreen route={ROUTE} />, client(stateOf({})), { permissions: RECORDER, path: '/aud/aud-05' });
      expect((await screen.findByTestId('finding-choose')).textContent).toBe(vi_['aud.finding.choose.text']);
      await waitFor(() => expect(screen.getAllByRole('option').length).toBe(2));
    });

    it('says the engagement is not there for one that is not found (the same words as an engagement of another scope)', async () => {
      mount(<FindingsScreen route={ROUTE} />, client(world()), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });

    it('shows a loading state first, then the denied, signed-out, offline and error states', async () => {
      const failing = (operation: string, error: Error) => {
        const state = stateOf({});
        state.failing.set(operation, error);
        return client(state);
      };
      mount(<FindingsScreen route={ROUTE} />, failing('getAuditEngagement', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      cleanup();
      mount(<FindingsScreen route={ROUTE} />, failing('listAuditConclusions', new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      mount(<FindingsScreen route={ROUTE} />, failing('listAuditFindings', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      mount(<FindingsScreen route={ROUTE} />, failing('getAuditEngagement', new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });
  });
});
