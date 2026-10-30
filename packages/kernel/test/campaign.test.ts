import { assertCampaignDraft, assertCampaignReason, assertCampaignSubmission, assertCampaignVerdict, campaignAfter, emptyExclusions, exclusionOf, previewHashOf } from '../src/campaign';

const refusal = (run: () => unknown): { code: string; detail: string | undefined } => {
  try {
    run();
  } catch (error) {
    const known = error as { code: string; detail?: string };
    return { code: known.code, detail: known.detail };
  }
  throw new Error('it was allowed');
};
const NOW = new Date('2026-10-30T10:00:00.000Z');
const UNIT = '00000000-0000-4000-8000-000000000001';
const TEMPLATE = '00000000-0000-4000-8000-0000000000e2';
const draft = (change: Record<string, unknown> = {}) => ({ name: ' Thông báo nghỉ lễ ', purpose: 'ANNOUNCEMENT', template_version_id: TEMPLATE, segment: { unit_ids: [UNIT] }, ...change });

describe('the campaign (ST-NOT-009, BR-NOT-12)', () => {
  it('takes a name, a purpose, a template, a segment that names someone and a time in the future, and trims and sorts what it keeps', () => {
    const made = assertCampaignDraft(draft({ segment: { unit_ids: [UNIT.toUpperCase(), UNIT], role_codes: ['STAFF', 'ENGINEER', 'STAFF'], include_guests: true }, scheduled_at: '2026-11-01T01:00:00Z' }), NOW);
    expect(made).toEqual({
      name: 'Thông báo nghỉ lễ',
      purpose: 'ANNOUNCEMENT',
      templateVersionId: TEMPLATE,
      segment: { unitIds: [UNIT], roleCodes: ['ENGINEER', 'STAFF'], includeGuests: true },
      scheduledAt: new Date('2026-11-01T01:00:00Z'),
    });
    expect(assertCampaignDraft(draft(), NOW).scheduledAt).toBeUndefined();
    expect(assertCampaignDraft(draft(), NOW).segment.includeGuests).toBe(false);
  });

  it('refuses a name that is empty or too long, an unknown purpose, a template that is not an id, and a segment that is malformed', () => {
    expect(refusal(() => assertCampaignDraft(draft({ name: '   ' }), NOW))).toEqual({ code: 'VALIDATION_FAILED', detail: 'name' });
    expect(refusal(() => assertCampaignDraft(draft({ name: 'x'.repeat(121) }), NOW)).detail).toBe('name');
    expect(refusal(() => assertCampaignDraft(draft({ purpose: 'MARKETING' }), NOW)).detail).toBe('purpose');
    expect(refusal(() => assertCampaignDraft(draft({ template_version_id: 'nope' }), NOW)).detail).toBe('template_version_id');
    expect(refusal(() => assertCampaignDraft(draft({ segment: 'all' }), NOW)).detail).toBe('segment');
    expect(refusal(() => assertCampaignDraft(draft({ segment: { unit_ids: ['nope'] } }), NOW)).detail).toBe('segment.unit_ids');
    expect(refusal(() => assertCampaignDraft(draft({ segment: { role_codes: ['lower'] } }), NOW)).detail).toBe('segment.role_codes');
    expect(refusal(() => assertCampaignDraft(draft({ segment: { unit_ids: [UNIT], include_guests: 'yes' } }), NOW)).detail).toBe('segment.include_guests');
  });

  it('refuses a segment that names nobody: it is not "everybody"', () => {
    expect(refusal(() => assertCampaignDraft(draft({ segment: {} }), NOW))).toEqual({ code: 'SEGMENT_INVALID', detail: 'segment' });
    expect(refusal(() => assertCampaignDraft(draft({ segment: { unit_ids: [], role_codes: [], include_guests: true } }), NOW)).code).toBe('SEGMENT_INVALID');
  });

  it('wants a time at least a minute ahead and within a year', () => {
    expect(refusal(() => assertCampaignDraft(draft({ scheduled_at: '2026-10-30T10:00:30Z' }), NOW)).detail).toBe('scheduled_at');
    expect(refusal(() => assertCampaignDraft(draft({ scheduled_at: '2028-01-01T00:00:00Z' }), NOW)).detail).toBe('scheduled_at');
    expect(refusal(() => assertCampaignDraft(draft({ scheduled_at: 'tomorrow' }), NOW)).detail).toBe('scheduled_at');
    expect(assertCampaignDraft(draft({ scheduled_at: '2026-10-30T10:01:00Z' }), NOW).scheduledAt).toEqual(new Date('2026-10-30T10:01:00Z'));
  });

  it('fingerprints the set: the same recipients, template and time give the same hash in any order, and any change gives another', () => {
    const base = { recipientIds: ['b', 'a', 'c'], templateVersionId: TEMPLATE, scheduledAt: new Date('2026-11-01T01:00:00Z') };
    const hash = previewHashOf(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(previewHashOf({ ...base, recipientIds: ['c', 'a', 'b'] })).toBe(hash);
    expect(previewHashOf({ ...base, recipientIds: ['a', 'b'] })).not.toBe(hash);
    expect(previewHashOf({ ...base, templateVersionId: '00000000-0000-4000-8000-0000000000e3' })).not.toBe(hash);
    expect(previewHashOf({ ...base, scheduledAt: undefined })).not.toBe(hash);
    expect(previewHashOf({ ...base, scheduledAt: new Date('2026-11-01T01:00:01Z') })).not.toBe(hash);
  });

  it('counts each person under one reason, the first that applies: inactive, then duplicate, then opted out, then no consent', () => {
    const fine = { active: true, firstOfPerson: true, channelEnabled: true, consented: true };
    expect(exclusionOf(fine)).toBeUndefined();
    expect(exclusionOf({ ...fine, consented: false })).toBe('no_consent');
    expect(exclusionOf({ ...fine, channelEnabled: false, consented: false })).toBe('opted_out');
    expect(exclusionOf({ ...fine, firstOfPerson: false, channelEnabled: false })).toBe('duplicate');
    expect(exclusionOf({ active: false, firstOfPerson: false, channelEnabled: false, consented: false })).toBe('inactive');
    expect(emptyExclusions()).toEqual({ opted_out: 0, no_consent: 0, inactive: 0, duplicate: 0 });
  });

  it('moves a campaign only the ways the state table allows, and says CAMPAIGN_STATE_INVALID otherwise', () => {
    expect(campaignAfter('Draft', 'preview')).toBe('Previewed');
    expect(campaignAfter('Previewed', 'preview')).toBe('Previewed');
    expect(campaignAfter('Previewed', 'submit')).toBe('PendingApproval');
    expect(campaignAfter('PendingApproval', 'approve')).toBe('Approved');
    expect(campaignAfter('PendingApproval', 'return')).toBe('Draft');
    expect(campaignAfter('PendingApproval', 'reject')).toBe('Rejected');
    expect(campaignAfter('Approved', 'schedule')).toBe('Scheduled');
    expect(campaignAfter('Scheduled', 'start')).toBe('Sending');
    expect(campaignAfter('Sending', 'complete')).toBe('Completed');
    for (const status of ['Draft', 'Previewed', 'PendingApproval', 'Approved', 'Scheduled', 'Sending'] as const) expect(campaignAfter(status, 'cancel')).toBe('Cancelled');
    // A draft cannot be submitted without a preview, nothing is approved twice, and what ended cannot be cancelled or moved.
    expect(refusal(() => campaignAfter('Draft', 'submit'))).toEqual({ code: 'CAMPAIGN_STATE_INVALID', detail: 'status' });
    expect(refusal(() => campaignAfter('Approved', 'approve')).code).toBe('CAMPAIGN_STATE_INVALID');
    expect(refusal(() => campaignAfter('PendingApproval', 'preview')).code).toBe('CAMPAIGN_STATE_INVALID');
    for (const status of ['Completed', 'Rejected', 'Cancelled'] as const) {
      expect(refusal(() => campaignAfter(status, 'cancel')).code).toBe('CAMPAIGN_STATE_INVALID');
      expect(refusal(() => campaignAfter(status, 'preview')).code).toBe('CAMPAIGN_STATE_INVALID');
    }
  });

  it('takes the hash of a preview (64 hex) with an optional reason of 10 to 2000 characters', () => {
    const hash = 'a'.repeat(64);
    expect(assertCampaignSubmission({ preview_hash: hash })).toEqual({ previewHash: hash, reason: undefined });
    expect(assertCampaignSubmission({ preview_hash: hash, reason: '  for the holiday notice ' }).reason).toBe('for the holiday notice');
    expect(refusal(() => assertCampaignSubmission({ preview_hash: 'ABC' })).detail).toBe('preview_hash');
    expect(refusal(() => assertCampaignSubmission({ preview_hash: hash, reason: 'short' })).detail).toBe('reason');
  });

  it('takes a decision of approve, return or reject with a reason and the ids of its evidence, and a reason alone for a preview or a cancellation', () => {
    expect(assertCampaignVerdict({ decision: 'approve', reason: ' ok ', evidence_ids: [UNIT, UNIT] })).toEqual({ decision: 'approve', reason: 'ok', evidenceIds: [UNIT] });
    expect(refusal(() => assertCampaignVerdict({ decision: 'maybe', reason: 'x' })).detail).toBe('decision');
    expect(refusal(() => assertCampaignVerdict({ decision: 'reject', reason: '   ' })).detail).toBe('reason');
    expect(refusal(() => assertCampaignVerdict({ decision: 'reject', reason: 'no', evidence_ids: ['x'] })).detail).toBe('evidence_ids');
    expect(assertCampaignReason({ reason: 'the holiday moved' })).toBe('the holiday moved');
    expect(refusal(() => assertCampaignReason({ reason: 'short' })).detail).toBe('reason');
  });
});
