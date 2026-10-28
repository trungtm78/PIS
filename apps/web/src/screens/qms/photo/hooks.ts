import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { filterQuery, toChecksView, toPhotoPage } from './model';
import type { PhotoChecksView, PhotoFilter, PhotoPage } from './model';

export const PHOTO_PAGE = 50;

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['qms-photos', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['qms-photos', tenant?.id, tenant?.membershipId];
}

/** The photos in the scope of the caller, the latest first, a page at a time; a new filter keeps the list on the screen until the new one is there. */
export function usePhotos(filter: PhotoFilter) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<PhotoPage, Error, { pages: PhotoPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'list', filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toPhotoPage(await client.read('get_resources_site_photo', { query: { limit: PHOTO_PAGE, ...filterQuery(filter), ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.next,
    placeholderData: keepPreviousData,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The checks of one photo; nothing is read until one is chosen. */
export function usePhotoChecks(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PhotoChecksView | null>({
    queryKey: [...key, 'checks', id],
    queryFn: async () => toChecksView(await client.read('getSitePhotoChecks', { path: { id: id as string } })) ?? null,
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}
