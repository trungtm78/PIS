import type { ApiClient } from '@machvon/api-client';
import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toAsset } from '../../ast/asset/model';
import type { AssetLine } from '../../ast/asset/model';
import { toHandover } from '../../ast/handover/model';
import type { HandoverLine } from '../../ast/handover/model';
import { toWarranty } from '../../ast/warranty/model';
import type { WarrantyLine } from '../../ast/warranty/model';
import { toPaymentRequest } from '../../pay/payment/model';
import type { PaymentRequest } from '../../pay/payment/model';
import { toSettlement } from '../../pay/settlement/model';
import type { Settlement } from '../../pay/settlement/model';
import { toDiaryLine } from '../../qms/diary/model';
import type { DiaryLine } from '../../qms/diary/model';
import { toInspectionLine } from '../../qms/inspection/model';
import type { InspectionLine } from '../../qms/inspection/model';
import { toNcrLine } from '../../qms/nonconformance/model';
import type { NcrLine } from '../../qms/nonconformance/model';
import { useContract, useContractChoice, useScopeKey } from '../hooks';
import type { ContractChoice } from '../hooks';
import type { ContractView } from '../model';
import { contractIdOf, settlementsOf } from './model';

const PAGE = 200;

/** The filters of a read as the text they travel as: the declared parameters of a list are the page alone, the filters are the server's own. */
const query = (parameters: Record<string, string | number>): Record<string, string> => Object.fromEntries(Object.entries(parameters).map(([name, value]) => [name, String(value)]));

/** What a view stands on: the contract it was opened for (named in the address), the contract as the caller may read it, and whether the caller holds the reads of the data it shows (all of them: a view that reads two owners is not shown half). */
export interface ViewScope {
  contractId: string | null;
  /** The contract of the address, or the default one with the register to change it when the address names none. */
  choice: ContractChoice;
  contract: UseQueryResult<ContractView | null>;
  mayRead: boolean;
}

/** The contract of the address and the read right over the data of the view; a caller without a right reads nothing (the screen says it is denied). */
export function useViewScope(permission: string | readonly string[]): ViewScope {
  const { permissions } = useSession();
  const choice = useContractChoice('id');
  const contractId = contractIdOf(choice.contractId);
  const contract = useContract(contractId);
  const needed = typeof permission === 'string' ? [permission] : permission;
  return { contractId, choice, contract, mayRead: permissions === undefined || needed.every((one) => permissions.includes(one)) };
}

const rowsOf = <T>(raw: readonly unknown[], parse: (item: unknown) => T | undefined): T[] => raw.flatMap((item) => parse(item) ?? []);

/** One read over the contract of a view, all its pages; nothing is read before a contract is named, nor for a caller who may not read the data. */
function useContractRead<T>(scope: ViewScope, name: string, read: (client: ApiClient, contractId: string) => Promise<T>, ready = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<T>({
    queryKey: [...key, 'aggregate', name, scope.contractId ?? ''],
    queryFn: () => read(client, scope.contractId ?? ''),
    enabled: key[1] !== undefined && scope.mayRead && scope.contractId !== null && ready,
    retry: false,
  });
}

/** CTR-09: the diaries of the contract, the latest day first (QMS-01). */
export function useDiaries(scope: ViewScope) {
  return useContractRead<DiaryLine[]>(scope, 'diaries', async (client, contractId) =>
    rowsOf(await client.readAll('get_resources_site_diary', { query: query({ contract_id: contractId, limit: PAGE }) }), toDiaryLine),
  );
}

export interface QualityView {
  ncrs: NcrLine[];
  inspections: InspectionLine[];
}

/** CTR-11: the non-conformances and the inspections of the contract (QMS-07, QMS-04). Both are read, or the view is not shown half. */
export function useQuality(scope: ViewScope) {
  return useContractRead<QualityView>(scope, 'quality', async (client, contractId) => {
    const [ncrs, inspections] = await Promise.all([
      client.readAll('get_resources_quality_nonconformance', { query: query({ contract_id: contractId, limit: PAGE }) }),
      client.readAll('listInspections', { query: query({ contract_id: contractId }) }),
    ]);
    return { ncrs: rowsOf(ncrs, toNcrLine), inspections: rowsOf(inspections, toInspectionLine) };
  });
}

/** CTR-15: the handovers of the contract (AST-01, AST-02). */
export function useHandovers(scope: ViewScope) {
  return useContractRead<HandoverLine[]>(scope, 'handovers', async (client, contractId) =>
    rowsOf(await client.readAll('get_resources_handover', { query: query({ contract_id: contractId, limit: PAGE }) }), toHandover),
  );
}

/** CTR-16: the warranty obligations of the contract (AST-04). */
export function useWarranties(scope: ViewScope) {
  return useContractRead<WarrantyLine[]>(scope, 'warranties', async (client, contractId) =>
    rowsOf(await client.readAll('listWarrantyObligations', { query: query({ contract_id: contractId, limit: PAGE }) }), toWarranty),
  );
}

export interface SettlementView {
  settlements: Settlement[];
  finals: PaymentRequest[];
}

/** CTR-17: the settlements of the contract and of its project (PAY-15) and the final payment requests of the contract (PAY-03). The project comes from the contract, so nothing is read before it is. */
export function useSettlementView(scope: ViewScope) {
  const contract = scope.contract.data;
  return useContractRead<SettlementView>(
    scope,
    'settlements',
    async (client, contractId) => {
      const [settlements, finals] = await Promise.all([
        client.readAll('get_resources_settlement_revision', { query: query({ project_id: contract?.projectId ?? '', limit: PAGE }) }),
        client.readAll('get_resources_payment_request', { query: query({ contract_id: contractId, request_kind: 'FINAL' }) }),
      ]);
      return { settlements: settlementsOf(rowsOf(settlements, toSettlement), { id: contractId, projectId: contract?.projectId ?? '' }), finals: rowsOf(finals, toPaymentRequest) };
    },
    contract !== null && contract !== undefined,
  );
}

/** CTR-18: the assets of the contract (AST-03). */
export function useAssets(scope: ViewScope) {
  return useContractRead<AssetLine[]>(scope, 'assets', async (client, contractId) =>
    rowsOf(await client.readAll('get_resources_asset_record', { query: query({ contract_id: contractId, limit: PAGE }) }), toAsset),
  );
}
