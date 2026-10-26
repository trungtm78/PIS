import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import TenantCreateScreen from './TenantCreateScreen';
import { PLATFORM_OPERATOR, SYSTEM_ADMIN, harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-02', 'FR-SAS-02');
const PLAN = '00000000-0000-4000-9000-000000000001';
const ACCEPTED = { tenant_id: '00000000-0000-4000-8000-0000000000c1', status: 'Requested', provisioning_run_id: 'run-9', version: 1 };

const field = (label: string) => screen.getByLabelText(label);

async function fill(user: ReturnType<typeof userEvent.setup>, overrides: Record<string, string> = {}): Promise<void> {
  const values: Record<string, string> = {
    [vi_['sas.tenantCreate.name.label']]: 'Ủy ban nhân dân tỉnh Cao Bằng',
    [vi_['sas.tenantCreate.owner.label']]: 'owner@example.org',
    [vi_['sas.tenantCreate.plan.label']]: PLAN,
    [vi_['sas.tenantCreate.code.label']]: 'cao-bang',
    [vi_['sas.tenantCreate.rootUnit.label']]: 'Ủy ban nhân dân tỉnh',
    [vi_['sas.tenantCreate.subdomain.label']]: 'cao-bang',
    ...overrides,
  };
  for (const [label, value] of Object.entries(values)) {
    await user.click(field(label));
    await user.paste(value);
  }
}

const submit = () => screen.getByRole('button', { name: vi_['sas.tenantCreate.submit.action'] });

afterEach(cleanup);

describe('SAS-02 tenant creation', () => {
  it('links back to the tenant list above the title', () => {
    mount(<TenantCreateScreen route={ROUTE} />, harness(() => ({}), () => ACCEPTED));
    const back = screen.getByRole('link', { name: new RegExp(vi_['sas.tenantCreate.back.link']) });
    expect(back.getAttribute('href')).toBe('/sas/sas-01');
  });

  it('refuses a bad tenant code before sending anything and keeps what was typed', async () => {
    const user = userEvent.setup();
    const h = harness(() => ({}), () => ACCEPTED);
    mount(<TenantCreateScreen route={ROUTE} />, h);
    await fill(user, { [vi_['sas.tenantCreate.code.label']]: 'Cao_Bang' });
    await user.click(submit());
    expect(await screen.findByText(vi_['sas.tenantCreate.problem.pattern'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    expect((field(vi_['sas.tenantCreate.name.label']) as HTMLInputElement).value).toBe('Ủy ban nhân dân tỉnh Cao Bằng');
    expect(field(vi_['sas.tenantCreate.code.label']).getAttribute('aria-invalid')).toBe('true');
  });

  it('lists every empty required field at once', async () => {
    const user = userEvent.setup();
    const h = harness(() => ({}));
    mount(<TenantCreateScreen route={ROUTE} />, h);
    await user.click(submit());
    expect(screen.getAllByText(vi_['sas.tenantCreate.problem.required']).length).toBeGreaterThanOrEqual(6);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('clears the refusal of a field as soon as the user edits it', async () => {
    const user = userEvent.setup();
    mount(<TenantCreateScreen route={ROUTE} />, harness(() => ({})));
    await fill(user, { [vi_['sas.tenantCreate.code.label']]: 'Bad' });
    await user.click(submit());
    expect(field(vi_['sas.tenantCreate.code.label']).getAttribute('aria-invalid')).toBe('true');
    await user.clear(field(vi_['sas.tenantCreate.code.label']));
    await user.type(field(vi_['sas.tenantCreate.code.label']), 'good-code');
    expect(field(vi_['sas.tenantCreate.code.label']).getAttribute('aria-invalid')).toBe('false');
  });

  it('sends the typed request once for a double submit and names the run it was given', async () => {
    const user = userEvent.setup();
    const h = harness(() => ({}), () => ACCEPTED);
    mount(<TenantCreateScreen route={ROUTE} />, h);
    await fill(user);
    await user.dblClick(submit());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, string> }];
    expect(operation).toBe('requestTenantProvisioning');
    expect(input.body).toMatchObject({ code: 'cao-bang', plan_version_id: PLAN, region: 'vn-north', isolation_mode: 'POOL', platform_subdomain: 'cao-bang' });
    expect(await screen.findByText(new RegExp(vi_['sas.tenantCreate.accepted.notice'].replace('{status}', 'Requested').replace('{run}', 'run-9').replace(/[().]/g, '\\$&')))).toBeTruthy();
    expect(screen.getByRole('link', { name: vi_['sas.tenantCreate.accepted.link'] })).toBeTruthy();
  });

  it('shows a taken tenant code on the code field without clearing the form', async () => {
    const user = userEvent.setup();
    const h = harness(() => ({}), () => new ApiError({ status: 409, code: 'TENANT_CODE_TAKEN', correlationId: 'c' }));
    mount(<TenantCreateScreen route={ROUTE} />, h);
    await fill(user);
    await user.click(submit());
    const message = await screen.findByText(vi_['sas.tenantCreate.error.codeTaken']);
    expect(message.closest('[data-field]')?.getAttribute('data-field')).toBe('code');
    expect((field(vi_['sas.tenantCreate.owner.label']) as HTMLInputElement).value).toBe('owner@example.org');
  });

  it('puts the server problems of the subdomain, the plan and the region on their own fields', async () => {
    const user = userEvent.setup();
    const codes = ['DOMAIN_TAKEN', 'PLAN_NOT_PUBLISHED', 'PLACEMENT_UNAVAILABLE'];
    let next = 0;
    const h = harness(() => ({}), () => new ApiError({ status: 409, code: codes[next++] ?? 'X', correlationId: 'c' }));
    mount(<TenantCreateScreen route={ROUTE} />, h);
    await fill(user);
    await user.click(submit());
    expect((await screen.findByText(vi_['sas.tenantCreate.error.domainTaken'])).closest('[data-field]')?.getAttribute('data-field')).toBe('platform_subdomain');
    await user.click(submit());
    expect((await screen.findByText(vi_['sas.tenantCreate.error.planNotPublished'])).closest('[data-field]')?.getAttribute('data-field')).toBe('plan_version_id');
    await user.click(submit());
    expect((await screen.findByText(vi_['sas.tenantCreate.error.placementUnavailable'])).closest('[data-field]')?.getAttribute('data-field')).toBe('region');
  });

  it('shows a failure that belongs to no field above the form', async () => {
    const user = userEvent.setup();
    const h = harness(() => ({}), () => new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }));
    mount(<TenantCreateScreen route={ROUTE} />, h);
    await fill(user);
    await user.click(submit());
    expect((await screen.findByRole('alert')).textContent).toBe(vi_['sas.tenantCreate.error.general']);
  });

  it('reuses the idempotency attempt when the same request is sent again after a failure', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const h = harness(() => ({}), () => {
      calls += 1;
      return calls === 1 ? new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) : ACCEPTED;
    });
    mount(<TenantCreateScreen route={ROUTE} />, h);
    await fill(user);
    await user.click(submit());
    await screen.findByRole('alert');
    await user.click(submit());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    const [first, second] = h.command.mock.calls.map(([, input]) => (input as { attempt: unknown }).attempt);
    expect(second).toBe(first);
  });

  it('offers the contract choices for region, isolation and agency type', () => {
    mount(<TenantCreateScreen route={ROUTE} />, harness(() => ({})));
    const options = (label: string) => Array.from((field(label) as HTMLSelectElement).options).map((option) => option.value);
    expect(options(vi_['sas.tenantCreate.region.label'])).toEqual(['vn-north', 'vn-south']);
    expect(options(vi_['sas.tenantCreate.isolation.label'])).toEqual(['POOL', 'SILO']);
    expect(options(vi_['sas.tenantCreate.governingBody.label'])).toEqual(['PROVINCE', 'MINISTRY', 'CENTRAL_AGENCY']);
  });

  it('gives a platform operator no way to submit and says why', async () => {
    const user = userEvent.setup();
    const h = harness(() => ({}), () => ACCEPTED);
    mount(<TenantCreateScreen route={ROUTE} />, h, PLATFORM_OPERATOR);
    expect(screen.getByText(vi_['sas.tenantCreate.readOnly.notice'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['sas.tenantCreate.submit.action'] })).toBeNull();
    await user.type(field(vi_['sas.tenantCreate.name.label']), 'x{enter}');
    expect(h.command).not.toHaveBeenCalled();
  });

  it('writes the reference footer and keeps the administrator permission list in use', () => {
    mount(<TenantCreateScreen route={ROUTE} />, harness(() => ({})), SYSTEM_ADMIN);
    expect(screen.getByText(vi_['sas.tenantCreate.footer.reference'].replace('{id}', 'SAS-02').replace('{req}', 'FR-SAS-02'))).toBeTruthy();
  });

  it('sends a new request, with a new idempotency attempt, after a final refusal, and keeps the attempt after a lost answer', async () => {
    const user = userEvent.setup();
    let answer = 0;
    const h = harness(
      () => ({}),
      () => {
        answer += 1;
        if (answer === 1) return new ApiError({ status: 409, code: 'PLAN_NOT_PUBLISHED', correlationId: 'c' });
        if (answer === 2) return new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' });
        return ACCEPTED;
      },
    );
    mount(<TenantCreateScreen route={ROUTE} />, h);
    await fill(user);
    await user.click(submit());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    await user.click(submit());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    await user.click(submit());
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(3));
    const keys = (h.command.mock.calls as unknown as Array<[string, { attempt: { key: string } }]>).map((call) => call[1].attempt.key);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[1]);
  });

  describe('the seven states (AC-ST-SAS-001-5)', () => {
    const failWith = (error: ApiError) => harness(() => ({}), () => error);

    async function submitWith(h: ReturnType<typeof harness>): Promise<void> {
      const user = userEvent.setup();
      mount(<TenantCreateScreen route={ROUTE} />, h);
      await fill(user);
      await user.click(submit());
    }

    it('shows the empty form first and, while the request is sent, a disabled button and no second request', async () => {
      const user = userEvent.setup();
      let release: (value: unknown) => void = () => undefined;
      const h = harness(
        () => ({}),
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      mount(<TenantCreateScreen route={ROUTE} />, h);
      expect((field(vi_['sas.tenantCreate.name.label']) as HTMLInputElement).value).toBe('');
      await fill(user);
      await user.click(submit());
      await waitFor(() => expect(submit()).toBeDisabled());
      await user.click(submit());
      expect(h.command).toHaveBeenCalledTimes(1);
      release(ACCEPTED);
      expect(await screen.findByRole('link', { name: vi_['sas.tenantCreate.accepted.link'] })).toBeTruthy();
    });

    it('says in words when the person may not create a tenant, when the session has lapsed and when the server cannot be reached', async () => {
      await submitWith(failWith(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })));
      expect(await screen.findByText(vi_['sas.tenantCreate.error.denied'])).toBeTruthy();
      cleanup();
      await submitWith(failWith(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })));
      expect(await screen.findByText(vi_['sas.tenantCreate.error.session'])).toBeTruthy();
      cleanup();
      await submitWith(failWith(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })));
      expect(await screen.findByText(vi_['sas.tenantCreate.error.offline'])).toBeTruthy();
      expect((field(vi_['sas.tenantCreate.owner.label']) as HTMLInputElement).value).toBe('owner@example.org');
      cleanup();
      await submitWith(failWith(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })));
      expect(await screen.findByText(vi_['sas.tenantCreate.error.general'])).toBeTruthy();
    });
  });
});
