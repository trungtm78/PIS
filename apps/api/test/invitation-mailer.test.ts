import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileInvitationMailer, INVITATION_OUTBOX_VARIABLE, MockInvitationMailer, invitationMailerFromEnv } from '../src/modules/adm/invitation-mailer';
import type { InvitationHandOver, InvitationMessage } from '../src/modules/adm/invitation-mailer';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FIRST = '22222222-2222-4222-8222-222222222222';
const SECOND = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-15T00:00:00Z');

const message = (invitationId: string, expiresAt: Date, token = 'tenant-part.secret+part/with=signs'): InvitationMessage => ({ tenantId: TENANT, invitationId, toEmail: 'owner@example.vn', token, expiresAt });

describe('the hand-over outbox of invitations', () => {
  let directory: string;

  beforeEach(() => {
    directory = join(mkdtempSync(join(tmpdir(), 'machvon-invitations-')), 'outbox');
  });

  afterEach(() => {
    rmSync(join(directory, '..'), { recursive: true, force: true });
  });

  const read = (invitationId: string): InvitationHandOver => JSON.parse(readFileSync(join(directory, `${invitationId}.json`), 'utf8')) as InvitationHandOver;

  it('writes one file per invitation with the link of the accepting page, the token escaped', async () => {
    const mailer = new FileInvitationMailer(directory, 'https://machvon.example.vn', () => NOW);
    await mailer.send(message(FIRST, new Date('2026-11-22T00:00:00Z')));
    expect(read(FIRST)).toEqual({
      invitation_id: FIRST,
      tenant_id: TENANT,
      to_email: 'owner@example.vn',
      link: `https://machvon.example.vn/invitations/${FIRST}/accept?token=tenant-part.secret%2Bpart%2Fwith%3Dsigns`,
      token: 'tenant-part.secret+part/with=signs',
      expires_at: '2026-11-22T00:00:00.000Z',
    });
    if (process.platform !== 'win32') expect(statSync(join(directory, `${FIRST}.json`)).mode & 0o077).toBe(0);
  });

  it('leaves the link out when the origin of the web application is not known, and replaces the file of an invitation sent again', async () => {
    const mailer = new FileInvitationMailer(directory, undefined, () => NOW);
    await mailer.send(message(FIRST, new Date('2026-11-22T00:00:00Z'), 'old-token-of-the-first-invitation-000'));
    await mailer.send(message(FIRST, new Date('2026-11-23T00:00:00Z'), 'new-token-of-the-first-invitation-111'));
    expect(read(FIRST).link).toBeUndefined();
    expect(read(FIRST).token).toBe('new-token-of-the-first-invitation-111');
    expect(readdirSync(directory)).toEqual([`${FIRST}.json`]);
  });

  it('removes the files of expired invitations at the next send and leaves what is not an invitation alone', async () => {
    let now = NOW;
    const mailer = new FileInvitationMailer(directory, undefined, () => now);
    await mailer.send(message(FIRST, new Date('2026-11-16T00:00:00Z')));
    writeFileSync(join(directory, 'notes.txt'), 'kept');
    writeFileSync(join(directory, '44444444-4444-4444-8444-444444444444.json'), 'not json');
    now = new Date('2026-11-17T00:00:00Z');
    await mailer.send(message(SECOND, new Date('2026-11-24T00:00:00Z')));
    expect(readdirSync(directory).sort()).toEqual([`${SECOND}.json`, '44444444-4444-4444-8444-444444444444.json', 'notes.txt'].sort());
  });

  it('is chosen by the environment: the outbox where a directory is named, the in-memory stand-in otherwise', async () => {
    expect(invitationMailerFromEnv({})).toBeInstanceOf(MockInvitationMailer);
    expect(invitationMailerFromEnv({ [INVITATION_OUTBOX_VARIABLE]: '  ' })).toBeInstanceOf(MockInvitationMailer);
    const mailer = invitationMailerFromEnv({ [INVITATION_OUTBOX_VARIABLE]: directory, WEB_BASE_URL: 'https://machvon.example.vn/' });
    expect(mailer).toBeInstanceOf(FileInvitationMailer);
    await mailer.send(message(FIRST, new Date(Date.now() + 86_400_000)));
    expect(read(FIRST).link).toBe(`https://machvon.example.vn/invitations/${FIRST}/accept?token=tenant-part.secret%2Bpart%2Fwith%3Dsigns`);
  });
});
