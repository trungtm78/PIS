import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { root, useCommand } from '../hooks';
import { toProducts } from './model';
import type { ProductView } from './model';

/** The data products with their certification and what stands between each and a certification. */
export function useProducts() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ProductView[]>({
    queryKey: [...root(tenant?.id), tenant?.membershipId, 'products'],
    queryFn: async () => toProducts(await client.read('listDataProducts', {})),
    enabled: tenant !== undefined,
    retry: false,
  });
}

export interface DecideInput {
  id: string;
  version: number;
  body: Record<string, unknown>;
}

export function useDecideProduct() {
  const client = useApiClient();
  return useCommand<DecideInput>((input, attempt) => client.command('certifyDataProduct', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}
