import { THEME_COLOR_KEYS } from '@machvon/design-tokens';
import type { Tokens } from '@machvon/design-tokens';
import type { components } from '@machvon/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useApiClient } from '../api/ApiClientContext';
import { useSession } from '../session/SessionContext';
import { BASE_THEME, ThemeProvider } from './ThemeProvider';
import type { TenantThemeSpec } from './ThemeProvider';

type PublishedTheme = components['schemas']['TenantThemeVersion'];

/**
 * The cache entry of the published theme of the selected tenant. The wrapper of the application and the read-only theme screen
 * (SAS-04) use this one key, so a version the screen finds is the version the wrapper applies.
 */
export const publishedThemeKey = (tenantId: string | undefined, membershipId: string | undefined) => ['published-theme', tenantId, membershipId] as const;

/**
 * The published version as the theme provider takes it: the hash is its id (it names the content), the version is the
 * published one, and the overlay holds the twelve colours and the logo asset, which the provider validates once more.
 */
export function specOfPublishedTheme(version: PublishedTheme): TenantThemeSpec {
  const overlay: Record<string, string> = {};
  for (const key of THEME_COLOR_KEYS) overlay[key] = version.config[key];
  if (version.config.logoAssetId !== null) overlay.logoAssetId = version.config.logoAssetId;
  return { themeId: version.hash, version: version.version, overlay };
}

type ThemeLogo = components['schemas']['TenantThemeLogo'];

/**
 * The logo of the theme in force of the selected tenant, as a data address for an image, or undefined while the tenant has none (the shell
 * then shows the monogram). The file is private: it is read with the token of the session (getMyThemeLogo), once for each logo the published
 * version names, and the read is keyed by the tenant and the membership like the theme itself.
 */
export function useTenantLogo(): string | undefined {
  const { tenant, tenantToken } = useSession();
  const client = useApiClient();
  const signedIn = tenantToken !== undefined && tenant !== undefined;
  const published = useQuery<PublishedTheme>({
    queryKey: publishedThemeKey(tenant?.id, tenant?.membershipId),
    queryFn: () => client.read('getMyPublishedTheme'),
    enabled: signedIn,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const assetId = published.data?.config.logoAssetId ?? null;
  const logo = useQuery<ThemeLogo>({
    queryKey: ['tenant-logo', tenant?.id, tenant?.membershipId, assetId],
    queryFn: () => client.read('getMyThemeLogo'),
    enabled: signedIn && assetId !== null,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  return assetId === null || logo.data === undefined ? undefined : `data:${logo.data.mime};base64,${logo.data.content_base64}`;
}

export interface PublishedThemeProviderProps {
  base: Tokens;
  children: ReactNode;
}

/**
 * Applies the theme of the selected tenant. After a real sign-in (a tenant token exists) it reads the published theme of
 * the tenant (`getMyPublishedTheme`) and applies it; until that answer arrives, and when it cannot be read, the theme the
 * session carries stays (the base theme for a real sign-in, the fixture theme of a development session). The read is keyed
 * by the tenant and the membership, so a switch never shows one tenant the theme of another.
 */
export function PublishedThemeProvider({ base, children }: PublishedThemeProviderProps) {
  const { tenant, tenantToken } = useSession();
  const client = useApiClient();
  const published = useQuery<PublishedTheme>({
    queryKey: publishedThemeKey(tenant?.id, tenant?.membershipId),
    queryFn: () => client.read('getMyPublishedTheme'),
    enabled: tenantToken !== undefined && tenant !== undefined,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const theme = published.data === undefined ? (tenant?.theme ?? BASE_THEME) : specOfPublishedTheme(published.data);
  return (
    <ThemeProvider base={base} theme={theme}>
      {children}
    </ThemeProvider>
  );
}
