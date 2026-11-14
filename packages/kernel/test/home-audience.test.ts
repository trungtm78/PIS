import { HOME_AUDIENCES, homeAudienceOf } from '../src/home-audience';
import type { HomeAuthority } from '../src/home-audience';

const held = (scopeKind: string, ...permissions: string[]): HomeAuthority => ({ scopeKind, permissions });

describe('homeAudienceOf (R53, lane fix11)', () => {
  it('names the two audiences', () => {
    expect(HOME_AUDIENCES).toEqual(['LEADER', 'OFFICER']);
  });

  it('a right to read the workspace of the committee does not make a leader', () => {
    expect(homeAudienceOf({ authorities: [held('TENANT', 'committee.read', 'home.read', 'pwf.read', 'pwf.task.work')], committeeRole: null })).toBe('OFFICER');
  });

  it('a member and the secretariat of the committee are officers; the head and the deputy lead', () => {
    for (const role of ['MEMBER', 'SECRETARIAT']) expect(homeAudienceOf({ authorities: [held('TENANT', 'committee.read')], committeeRole: role })).toBe('OFFICER');
    for (const role of ['HEAD', 'DEPUTY']) expect(homeAudienceOf({ authorities: [], committeeRole: role })).toBe('LEADER');
  });

  it('deciding approvals for a unit or wider makes a leader, exactly or through a pattern', () => {
    for (const kind of ['TENANT', 'UNIT_SUBTREE', 'UNIT_ONLY']) expect(homeAudienceOf({ authorities: [held(kind, 'approval.decide')], committeeRole: null })).toBe('LEADER');
    expect(homeAudienceOf({ authorities: [held('UNIT_SUBTREE', 'approval.*')], committeeRole: null })).toBe('LEADER');
  });

  it('deciding approvals of one project or one contract is the work of an officer', () => {
    for (const kind of ['PROJECT', 'CONTRACT']) expect(homeAudienceOf({ authorities: [held(kind, 'approval.decide')], committeeRole: null })).toBe('OFFICER');
  });

  it('a person with nothing, or with a look-alike permission, is an officer', () => {
    expect(homeAudienceOf({ authorities: [], committeeRole: null })).toBe('OFFICER');
    expect(homeAudienceOf({ authorities: [held('TENANT', 'approval_task.read', 'approvalx.decide', '*')], committeeRole: null })).toBe('OFFICER');
  });
});
