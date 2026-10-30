import { AuthzHarness, TENANT_A, id, memberId } from './support/authz-fixtures';

const ACTOR = memberId(1);
const OTHER = memberId(2);
const TEMPLATE = id(0xe0, 1);
const SEGMENT = '{"unit_ids":[],"role_codes":["STAFF"],"include_guests":false}';

describe('the guard of the campaign table (ST-NOT-009, V1447, BR-NOT-12)', () => {
  const harness = new AuthzHarness();
  let counter = 0;

  const owner = <T extends object>(text: string, params: unknown[] = []): Promise<T[]> => harness.owner<T>(TENANT_A, [[text, params]]);
  const refused = async (text: string, params: unknown[] = []): Promise<string> => {
    try {
      await owner(text, params);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('it was allowed');
  };

  /** A campaign in the given state, with a preview when it has been past Draft. */
  async function campaign(status = 'Draft', extra: { approvedBy?: string; decidedBy?: string } = {}): Promise<string> {
    const campaignId = id(0xc0, (counter += 1));
    await owner(
      `insert into machvon.notification_campaign
         (tenant_id, id, name, purpose, template_version_id, segment_json, status, created_by, preview_hash, preview_recipient_count, preview_excluded_count, approved_by, approved_at, decided_by)
       values ($1, $2, 'Guarded', 'ANNOUNCEMENT', $3, $4::jsonb, $5, $6, repeat('a', 64), 3, 1, $7, case when $7::uuid is null then null else now() end, $8)`,
      [TENANT_A, campaignId, TEMPLATE, SEGMENT, status, ACTOR, extra.approvedBy ?? null, extra.decidedBy ?? null],
    );
    return campaignId;
  }

  beforeAll(async () => {
    await harness.start();
    await harness.seedUnits(TENANT_A, [{ n: 1, path: `/${id(0x10, 1)}/` }]);
    await harness.seedMembership(TENANT_A, 1, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await harness.seedMembership(TENANT_A, 2, 1, { validFrom: '2026-01-01T00:00:00Z' });
    await owner(
      `insert into machvon.notification_template_version (tenant_id, id, code, channel, locale, revision, content_ast, variable_schema, status, content_hash, created_by)
       values ($1, $2, 'guard.template', 'EMAIL', 'vi-VN', 1, '{"body":"B"}'::jsonb, '{}'::jsonb, 'Active', repeat('b', 64), $3)`,
      [TENANT_A, TEMPLATE, ACTOR],
    );
  }, 180_000);

  afterAll(() => harness.stop(), 60_000);

  it('keeps a campaign and never deletes it', async () => {
    const campaignId = await campaign();
    expect(await refused('delete from machvon.notification_campaign where id = $1', [campaignId])).toMatch(/CAMPAIGN_IMMUTABLE/);
  });

  it('does not change what a campaign is once it is made: name, purpose, template, segment, time and maker', async () => {
    const campaignId = await campaign();
    for (const change of ["name = 'Other'", "purpose = 'REMINDER'", `segment_json = '{"unit_ids":[],"role_codes":["ADMIN"],"include_guests":false}'::jsonb`, "scheduled_at = now() + interval '1 day'", `created_by = '${OTHER}'`]) {
      expect(await refused(`update machvon.notification_campaign set ${change} where id = $1`, [campaignId])).toMatch(/CAMPAIGN_IMMUTABLE/);
    }
  });

  it('moves a campaign only the ways the table allows, and what ended is not touched again', async () => {
    const draft = await campaign('Draft');
    expect(await refused("update machvon.notification_campaign set status = 'PendingApproval' where id = $1", [draft])).toMatch(/CAMPAIGN_STATE_INVALID/);
    expect(await refused("update machvon.notification_campaign set status = 'Completed' where id = $1", [draft])).toMatch(/CAMPAIGN_STATE_INVALID/);
    await owner("update machvon.notification_campaign set status = 'Previewed' where id = $1", [draft]);
    await owner("update machvon.notification_campaign set status = 'PendingApproval' where id = $1", [draft]);
    await owner("update machvon.notification_campaign set status = 'Cancelled' where id = $1", [draft]);
    for (const next of ['Draft', 'Previewed', 'Cancelled']) expect(await refused(`update machvon.notification_campaign set status = '${next}' where id = $1`, [draft])).toMatch(/CAMPAIGN_IMMUTABLE/);
    const rejected = await campaign('PendingApproval');
    await owner("update machvon.notification_campaign set status = 'Rejected', decided_by = $2 where id = $1", [rejected, OTHER]);
    expect(await refused("update machvon.notification_campaign set decision_reason = 'late' where id = $1", [rejected])).toMatch(/CAMPAIGN_IMMUTABLE/);
  });

  it('freezes the preview once the campaign was sent to approval: a preview changes only while the campaign is a draft or previewed', async () => {
    const previewed = await campaign('Previewed');
    await owner("update machvon.notification_campaign set preview_hash = repeat('c', 64), preview_recipient_count = 4 where id = $1", [previewed]);
    await owner("update machvon.notification_campaign set status = 'PendingApproval' where id = $1", [previewed]);
    expect(await refused("update machvon.notification_campaign set preview_hash = repeat('d', 64) where id = $1", [previewed])).toMatch(/CAMPAIGN_IMMUTABLE/);
    expect(await refused('update machvon.notification_campaign set preview_recipient_count = 9 where id = $1', [previewed])).toMatch(/CAMPAIGN_IMMUTABLE/);
  });

  it('keeps the maker-checker rule in the table: the maker is neither the approver nor the one who decides, and an approved campaign has a preview', async () => {
    const pending = await campaign('PendingApproval');
    expect(await refused("update machvon.notification_campaign set status = 'Approved', approved_by = $2, approved_at = now() where id = $1", [pending, ACTOR])).toMatch(/notification_campaign_check|violates check/);
    expect(await refused("update machvon.notification_campaign set status = 'Rejected', decided_by = $2 where id = $1", [pending, ACTOR])).toMatch(/notification_campaign_decider_ck/);
    await owner("update machvon.notification_campaign set status = 'Approved', approved_by = $2, approved_at = now(), decided_by = $2 where id = $1", [pending, OTHER]);
    // An approved campaign needs the hash of its preview.
    const bare = id(0xc0, 900);
    expect(
      await refused(
        `insert into machvon.notification_campaign (tenant_id, id, name, purpose, template_version_id, segment_json, status, created_by, approved_by, approved_at)
         values ($1, $2, 'No preview', 'ANNOUNCEMENT', $3, $4::jsonb, 'Approved', $5, $6, now())`,
        [TENANT_A, bare, TEMPLATE, SEGMENT, ACTOR, OTHER],
      ),
    ).toMatch(/violates check/);
  });

  it('takes a count of the left-out people only as an object', async () => {
    const campaignId = await campaign('Previewed');
    expect(await refused("update machvon.notification_campaign set preview_excluded = '[1]'::jsonb where id = $1", [campaignId])).toMatch(/notification_campaign_excluded_ck/);
    await owner(`update machvon.notification_campaign set preview_excluded = '{"opted_out":1}'::jsonb where id = $1`, [campaignId]);
  });
});
