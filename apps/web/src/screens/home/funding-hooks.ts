import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import { ctmtqgAmounts, fundingOf, fundingYears, toFundingRow } from './funding-model';
import type { Funding, FundingRow } from './funding-model';
import { homeRoot } from './hooks';

/** The register of the tenant, as the funding structure reads it: every appropriation, of which only the published ones of a year are drawn. */
export function useFundingRegister() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<FundingRow[]>({
    queryKey: [...homeRoot(tenant?.id), 'funding', tenant?.membershipId],
    queryFn: async () => (await client.readAll('listAppropriations')).flatMap((raw) => toFundingRow(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/**
 * The allocation lines of the tenant: what the part that is CTMTQG of an appropriation is read from (the plan an appropriation names is optional and a plan
 * may be revised, so the lines are asked for and grouped by the appropriation they draw on). When they cannot be read (the reader may not read them, or the read
 * failed) the part is "no data" on the screen and not zero; it never fails the screen, which still has the capital that was published.
 */
export function useAllocationLines() {
  const client = useApiClient();
  const { tenant } = useSession();
  // `null` is the answer "could not be read": a query cannot hold `undefined`, and a failed refresh must replace the lines it read before, not leave them on the screen.
  return useQuery<unknown[] | null>({
    queryKey: [...homeRoot(tenant?.id), 'funding-lines', tenant?.membershipId],
    queryFn: async () => {
      try {
        return await client.readAll('get_resources_allocation_line');
      } catch {
        return null;
      }
    },
    enabled: tenant !== undefined,
    retry: false,
  });
}

export interface FundingReading {
  register: ReturnType<typeof useFundingRegister>;
  /** The years that have capital published, the newest first. */
  years: number[];
  /** The year shown: the one in the address if it is a year of four digits, else the newest one that has capital. */
  year: number | undefined;
  funding: Funding | undefined;
  setYear(year: number): void;
}

const YEAR = /^\d{4}$/;

/**
 * What both screens of the funding structure read: the register, the year (kept in the address so the detail opens on the year the cards were), and
 * the part that is CTMTQG, read from the allocation lines. The part is never waited for: the cards are drawn with it as "no data" until it is read.
 */
export function useFunding(): FundingReading {
  const register = useFundingRegister();
  const [params, setParams] = useSearchParams();
  const rows = register.data;
  const years = useMemo(() => fundingYears(rows ?? []), [rows]);
  const asked = params.get('year') ?? '';
  const year = YEAR.test(asked) ? Number(asked) : years[0];
  const lines = useAllocationLines();
  const funding = useMemo(() => {
    if (rows === undefined || year === undefined) return undefined;
    return fundingOf(rows, year, ctmtqgAmounts(rows, lines.data ?? undefined));
  }, [rows, year, lines.data]);
  return { register, years, year, funding, setYear: (next) => setParams({ year: String(next) }, { replace: true }) };
}
