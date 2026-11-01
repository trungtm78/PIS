import { describe, expect, it } from 'vitest';
import { toAsset } from '../../ast/asset/model';
import { toHandover } from '../../ast/handover/model';
import { toWarranty } from '../../ast/warranty/model';
import { toSettlement } from '../../pay/settlement/model';
import { toNcrLine } from '../../qms/nonconformance/model';
import { contractId } from '../test-support';
import { CONTRACT, asset, handover, ncr, otherContractSettlement, ownSettlement, projectSettlement, warranty } from './test-support';
import {
  ASSET_PATH,
  DIARY_PATH,
  acceptedHandovers,
  assetsTotal,
  blockingNcrs,
  contractIdOf,
  ownerLink,
  runningWarranties,
  seesFinancials,
  settlementsOf,
  viewLink,
  withinContractValue,
} from './model';

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('fixture does not parse');
  return value;
};

describe('the model of the aggregation views of a contract (ST-CTR-017)', () => {
  it('takes the contract from the address only when it is an identifier, and builds the links between the views', () => {
    expect(contractIdOf(CONTRACT)).toBe(CONTRACT);
    expect(contractIdOf(`  ${CONTRACT.toUpperCase()} `)).toBe(CONTRACT.toUpperCase());
    expect(contractIdOf('HD-A-002')).toBeNull();
    expect(contractIdOf('')).toBeNull();
    expect(contractIdOf(null)).toBeNull();
    expect(viewLink(DIARY_PATH, CONTRACT)).toBe(`/ctr/ctr-09?id=${CONTRACT}`);
    expect(viewLink(ASSET_PATH, CONTRACT)).toBe(`/ctr/ctr-18?id=${CONTRACT}`);
  });

  it('builds the links to the screens of the owners', () => {
    expect(ownerLink.coverage(CONTRACT)).toBe(`/qms/qms-11?contract=${CONTRACT}`);
    expect(ownerLink.nonconformances(CONTRACT)).toBe(`/qms/qms-07?contract=${CONTRACT}`);
    expect(ownerLink.inspections(CONTRACT)).toBe(`/qms/qms-04?contract=${CONTRACT}`);
    expect(ownerLink.handovers()).toBe('/ast/ast-01');
    expect(ownerLink.handover('h1')).toBe('/ast/ast-02?id=h1');
    expect(ownerLink.warranties()).toBe('/ast/ast-04');
    expect(ownerLink.warranties('h1')).toBe('/ast/ast-04?handover=h1');
    expect(ownerLink.assets()).toBe('/ast/ast-03');
    expect(ownerLink.assets('h1')).toBe('/ast/ast-03?handover=h1');
  });

  it('tells a guest contractor from the staff by the estimate ceiling the register leaves out of the answer', () => {
    expect(seesFinancials({ estimateCeilingVnd: '10200000000' })).toBe(true);
    expect(seesFinancials({ estimateCeilingVnd: null })).toBe(true);
    expect(seesFinancials({ estimateCeilingVnd: undefined })).toBe(false);
  });

  it('picks the non-conformances that block the acceptance, the accepted handovers and the warranties in force', () => {
    const ncrs = [must(toNcrLine(ncr(1, { blocks_acceptance: true }))), must(toNcrLine(ncr(2)))];
    expect(blockingNcrs(ncrs).map((line) => line.ncrNo)).toEqual(['NCR-001']);
    const handovers = [must(toHandover(handover(1, { status: 'ACCEPTED' }))), must(toHandover(handover(2, { status: 'DRAFT' })))];
    expect(acceptedHandovers(handovers).map((line) => line.handoverNo)).toEqual(['BG-001']);
    const warranties = [must(toWarranty(warranty(1))), must(toWarranty(warranty(2, { status: 'CLOSED' })))];
    expect(runningWarranties(warranties)).toHaveLength(1);
  });

  it('keeps the settlements of the contract and of its project, and drops those of the other contracts', () => {
    const lines = [projectSettlement, ownSettlement, otherContractSettlement].map((raw) => must(toSettlement(raw)));
    const project = must(toSettlement(projectSettlement)).projectId;
    expect(settlementsOf(lines, { id: CONTRACT, projectId: project }).map((line) => line.scope)).toEqual(['PROJECT', 'CONTRACT']);
    expect(settlementsOf(lines, { id: contractId(3), projectId: project }).map((line) => line.contractId)).toEqual([null, contractId(3)]);
    expect(settlementsOf(lines, { id: CONTRACT, projectId: 'another-project' })).toEqual([]);
  });

  it('adds up the value of the assets the reader may value, and checks it against the value of the contract (BR-CTR-18)', () => {
    const assets = [asset(1, { value_vnd: '3200000000' }), asset(2, { value_vnd: '1800000000' }), asset(3, { value_vnd: null })].map((raw) => must(toAsset(raw)));
    const total = assetsTotal(assets);
    expect(total).toBe(5_000_000_000n);
    expect(assetsTotal([])).toBe(0n);
    expect(withinContractValue(total, '5000000000')).toBe(true);
    expect(withinContractValue(total, '4999999999')).toBe(false);
    // A value that is not an amount cannot be compared, and is not reported as exceeded.
    expect(withinContractValue(total, 'x')).toBe(true);
    expect(assetsTotal([{ ...must(toAsset(asset(4))), valueVnd: 'not-an-amount' }])).toBe(0n);
  });
});
