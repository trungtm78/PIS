import { ApiError } from '@machvon/api-client';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { OpenDossierForm } from './OpenDossierForm';
import { toProjectOption } from './dossier-model';
import type { ProjectOption } from './dossier-model';
import { OFFICER, OWNER_UNIT, client, dossierId, mount, projectId, projectRow, world } from './dossier-test-support';

afterEach(cleanup);

const projects = (...ns: number[]): ProjectOption[] => ns.flatMap((n) => toProjectOption(projectRow(n)) ?? []);
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} });
const open = (list: ProjectOption[], command?: (operation: string, input: unknown) => unknown, onOpened?: (id: string) => void) => {
  const h = client(world(), command);
  mount(<OpenDossierForm projects={list} {...(onOpened === undefined ? {} : { onOpened })} />, h, { permissions: OFFICER });
  return h;
};

describe('OpenDossierForm (PMT-01): opening the legal dossier of a project', () => {
  it('opens the dossier of the chosen project, kept by the unit that owns it, and tells which dossier it opened (UI-PMT-01)', async () => {
    const onOpened = vi.fn();
    const h = open(projects(1, 2), () => ({ operation_id: 'o', status: 'OPEN', resource_version: 1, resource_id: dossierId(2) }), onOpened);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(vi_['pmt.dossier.open.project.label']), projectId(2));
    await user.click(screen.getByRole('button', { name: vi_['pmt.dossier.open.action'] }));
    await vi.waitFor(() => expect(onOpened).toHaveBeenCalledWith(dossierId(2)));
    expect(h.command).toHaveBeenCalledWith('createPermitDossier', expect.objectContaining({ path: { id: projectId(2) }, body: { owner_unit_id: OWNER_UNIT } }));
  });

  it('asks for a project first and sends nothing without one', async () => {
    const h = open(projects(1));
    await userEvent.setup().click(screen.getByRole('button', { name: vi_['pmt.dossier.open.action'] }));
    expect(screen.getByText(vi_['pmt.permit.field.required.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('says that the project already has a dossier when the server says so, and clears the refusal when another project is chosen', async () => {
    open(projects(1, 2), () => problem('DOSSIER_EXISTS'));
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(vi_['pmt.dossier.open.project.label']), projectId(1));
    await user.click(screen.getByRole('button', { name: vi_['pmt.dossier.open.action'] }));
    expect((await screen.findByRole('alert')).textContent).toBe(vi_['pmt.permit.problem.dossierExists.error']);
    await user.selectOptions(screen.getByLabelText(vi_['pmt.dossier.open.project.label']), projectId(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opens without a listener, and says so when every project has a dossier already', async () => {
    const h = open(projects(1), () => ({ operation_id: 'o', status: 'OPEN', resource_version: 1 }));
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(vi_['pmt.dossier.open.project.label']), projectId(1));
    await user.click(screen.getByRole('button', { name: vi_['pmt.dossier.open.action'] }));
    await vi.waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    cleanup();
    open([]);
    expect(screen.getByTestId('every-project-has-one').textContent).toBe(vi_['pmt.dossier.open.none.text']);
    expect(screen.queryByRole('form')).toBeNull();
  });
});
