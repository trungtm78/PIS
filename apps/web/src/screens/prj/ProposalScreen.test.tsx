import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ProposalScreen from './ProposalScreen';
import { DOCUMENT, PROJECT_ID, appraisalClient, mount, routeOf, world } from './appraisal-test-support';
import { detail, line as projectLine } from './test-support';

const ROUTE = routeOf('PRJ-09', 'FR-PRJ-09');
const SENDER = ['project.read', 'project.stage.submit'];
const OPEN = `/prj/prj-09?id=${PROJECT_ID}`;
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const OK = { operation_id: 'o', status: 'APPRAISAL', resource_version: 2, resource_id: PROJECT_ID };

afterEach(cleanup);

const fill = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const send = (): void => {
  fireEvent.click(screen.getByRole('button', { name: vi_['prj.proposal.submit.action'] }));
};
const ready = () => screen.findByTestId('summary');

describe('ProposalScreen (PRJ-09): the proposal that sends a project to appraisal', () => {
  it('UI-PRJ-09: shows the project, its scale and the group the rules suggest next to the form of the proposal', async () => {
    mount(<ProposalScreen route={ROUTE} />, appraisalClient(world()), { permissions: SENDER, path: OPEN });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['prj.proposal.page.title']);
    expect(screen.getByTestId('project-head').textContent).toContain('DA-2026-001');
    expect(screen.getByTestId('stage').textContent).toBe(vi_['prj.stage.concept.label']);
    const facts = Array.from(screen.getByTestId('summary').querySelectorAll('dt')).map((term) => [term.textContent, term.nextElementSibling?.textContent]);
    expect(facts[0]).toEqual([vi_['prj.proposal.summary.name.label'], 'Dự án số 1']);
    expect(facts[1]?.[1]).toContain('đồng');
    expect(facts[2]).toEqual([vi_['prj.proposal.summary.area.label'], 'Tỉnh P']);
    expect(facts[4]).toEqual([vi_['prj.proposal.summary.program.label'], vi_['prj.proposal.value.none']]);
    expect(screen.getByTestId('suggestion').textContent).toContain('B');
    expect(screen.getByRole('button', { name: vi_['prj.proposal.submit.action'] })).toHaveProperty('disabled', false);
  });

  it('AC-ST-PRJ-003-2: asks for what the server asks for before anything is sent', async () => {
    const h = appraisalClient(world(), () => OK);
    mount(<ProposalScreen route={ROUTE} />, h, { permissions: SENDER, path: OPEN });
    await ready();
    send();
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([vi_['prj.appraisal.field.required.error'], vi_['prj.appraisal.field.required.error']]);
    fill(vi_['prj.proposal.reason.label'], 'ab');
    fill(vi_['prj.proposal.document.label'], 'not-an-id');
    fill(vi_['prj.proposal.date.label'], '2026-11-01');
    send();
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([vi_['prj.appraisal.field.tooShort.error'], vi_['prj.appraisal.field.invalidId.error']]);
  });

  it('AC-ST-PRJ-003-2: sends the proposal under the version of the project and says the project is in appraisal, with the way on', async () => {
    const h = appraisalClient(world(), () => OK);
    mount(<ProposalScreen route={ROUTE} />, h, { permissions: SENDER, path: OPEN });
    await ready();
    fill(vi_['prj.proposal.reason.label'], 'Sent for appraisal with the feasibility file');
    fill(vi_['prj.proposal.document.label'], DOCUMENT.toUpperCase());
    fill(vi_['prj.proposal.date.label'], '2026-11-01');
    send();
    const done = await screen.findByTestId('sent');
    expect(h.command).toHaveBeenCalledTimes(1);
    expect(h.command).toHaveBeenCalledWith(
      'submitProjectForAppraisal',
      expect.objectContaining({ path: { id: PROJECT_ID }, ifMatchVersion: 1, body: { reason: 'Sent for appraisal with the feasibility file', policy_proposal_document_id: DOCUMENT, effective_date: '2026-11-01' } }),
    );
    expect(done.textContent).toContain(vi_['prj.proposal.done.text']);
    expect(within(done).getByRole('link', { name: vi_['prj.proposal.done.score.link'] }).getAttribute('href')).toBe(`/prj/prj-15?id=${PROJECT_ID}`);
    expect(within(done).getByRole('link', { name: vi_['prj.proposal.done.decision.link'] }).getAttribute('href')).toBe(`/prj/prj-10?id=${PROJECT_ID}`);
    expect(screen.getByRole('button', { name: vi_['prj.proposal.submit.action'] })).toHaveProperty('disabled', true);
  });

  it('AC-ST-PRJ-003-2: tells why a proposal was refused and lets the person try again', async () => {
    let refuse: Error | undefined = problem('DECISION_REQUIRED');
    const h = appraisalClient(world(), () => refuse ?? OK);
    mount(<ProposalScreen route={ROUTE} />, h, { permissions: SENDER, path: OPEN });
    await ready();
    fill(vi_['prj.proposal.reason.label'], 'Sent for appraisal');
    fill(vi_['prj.proposal.document.label'], DOCUMENT);
    send();
    expect((await screen.findByTestId('problem')).textContent).toBe(vi_['prj.appraisal.problem.decisionRequired.error']);
    expect(screen.queryByTestId('sent')).toBeNull();
    refuse = undefined;
    send();
    await screen.findByTestId('sent');
    expect(h.command).toHaveBeenCalledTimes(2);
  });

  it('says what a refusal of the stage or of the version means', async () => {
    for (const [code, key] of [
      ['STAGE_TRANSITION_DENIED', 'prj.appraisal.problem.transitionDenied.error'],
      ['VERSION_CONFLICT', 'prj.appraisal.problem.versionConflict.error'],
      ['SOMETHING_ELSE', 'prj.appraisal.problem.general.error'],
    ] as const) {
      const h = appraisalClient(world(), () => problem(code, 409));
      const view = mount(<ProposalScreen route={ROUTE} />, h, { permissions: SENDER, path: OPEN });
      await ready();
      fill(vi_['prj.proposal.reason.label'], 'Sent for appraisal');
      fill(vi_['prj.proposal.document.label'], DOCUMENT);
      send();
      expect((await screen.findByTestId('problem')).textContent).toBe(vi_[key]);
      view.unmount();
    }
  });

  it('offers nothing to a project that is no longer a concept, to a caller without the permission and to a read-only session', async () => {
    const appraised = world({ detail: detail(1, { status: 'APPRAISAL' }) });
    const first = mount(<ProposalScreen route={ROUTE} />, appraisalClient(appraised), { permissions: SENDER, path: OPEN });
    await ready();
    expect(screen.getByTestId('not-concept').textContent).toBe(vi_['prj.proposal.notConcept.notice']);
    expect(screen.getByRole('button', { name: vi_['prj.proposal.submit.action'] })).toHaveProperty('disabled', true);
    first.unmount();
    const second = mount(<ProposalScreen route={ROUTE} />, appraisalClient(world()), { permissions: ['project.read'], path: OPEN });
    await ready();
    expect(screen.getByTestId('read-only').textContent).toBe(vi_['prj.proposal.readOnly.denied.notice']);
    second.unmount();
    mount(<ProposalScreen route={ROUTE} />, appraisalClient(world()), { permissions: SENDER, mode: 'READ_ONLY', path: OPEN });
    await ready();
    expect(screen.getByTestId('read-only').textContent).toBe(vi_['prj.proposal.readOnly.frozen.notice']);
    expect(screen.getByLabelText(vi_['prj.proposal.reason.label']).matches(':disabled')).toBe(true);
  });

  it('PRJ-09 without a project in the address proposes for the first project in concept of the register, says so, and keeps the register one link away', async () => {
    const h = appraisalClient(world());
    (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => Promise.resolve([projectLine(7, { status: 'APPRAISAL' }), projectLine(1, { status: 'CONCEPT' })]));
    mount(<ProposalScreen route={ROUTE} />, h, { permissions: SENDER, path: '/prj/prj-09' });
    await ready();
    expect(h.read).toHaveBeenCalledWith('get_resources_project_id', { path: { id: PROJECT_ID } });
    expect(screen.queryByTestId('no-project')).toBeNull();
    expect(screen.getByTestId('default-project').textContent).toContain(vi_['prj.proposal.default.notice']);
    expect(within(screen.getByTestId('default-project')).getByRole('link', { name: vi_['prj.score.default.link'] }).getAttribute('href')).toBe('/prj/prj-01');
  });

  it('PRJ-09 names no default when the address names the project', async () => {
    mount(<ProposalScreen route={ROUTE} />, appraisalClient(world()), { permissions: SENDER, path: OPEN });
    await ready();
    expect(screen.queryByTestId('default-project')).toBeNull();
  });

  it('says so when no project is named or the project cannot be read, and retries the read', async () => {
    const first = mount(<ProposalScreen route={ROUTE} />, appraisalClient(world()), { permissions: SENDER, path: '/prj/prj-09' });
    expect((await screen.findByTestId('no-project')).textContent).toBe(vi_['prj.proposal.noProject.notice']);
    first.unmount();
    const state = world({ failing: new Set(['get_resources_project_id']) });
    mount(<ProposalScreen route={ROUTE} />, appraisalClient(state), { permissions: SENDER, path: OPEN });
    const retry = await screen.findByRole('button', { name: vi_['states.retry.action'] });
    state.failing = new Set();
    await userEvent.setup().click(retry);
    await waitFor(() => expect(screen.getByTestId('summary')).toBeTruthy());
  });
});
