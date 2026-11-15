/**
 * The release this build of the application is (stamped by the build that packs an installation: VITE_APP_VERSION, VITE_APP_COMMIT), and the question a running tab asks
 * the server: is a newer release installed? A development build carries no version: nothing is shown and nothing is asked.
 */
export interface AppVersion {
  version: string;
  commit: string;
}

export function builtVersion(env: { VITE_APP_VERSION?: string; VITE_APP_COMMIT?: string } = import.meta.env as unknown as { VITE_APP_VERSION?: string; VITE_APP_COMMIT?: string }): AppVersion | undefined {
  const version = (env.VITE_APP_VERSION ?? '').trim();
  if (version === '') return undefined;
  return { version, commit: (env.VITE_APP_COMMIT ?? '').trim() };
}

/** `/version.json` of the server, never from a cache; undefined when it cannot be read (offline, an installation without the file). */
export async function servedVersion(fetcher: typeof fetch = fetch): Promise<AppVersion | undefined> {
  try {
    const response = await fetcher('/version.json', { cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Partial<AppVersion>;
    return typeof body.version === 'string' && body.version !== '' ? { version: body.version, commit: typeof body.commit === 'string' ? body.commit : '' } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the server holds another release than the one this tab runs. */
export function isNewer(built: AppVersion | undefined, served: AppVersion | undefined): boolean {
  if (built === undefined || served === undefined) return false;
  return served.version !== built.version || (served.commit !== '' && built.commit !== '' && served.commit !== built.commit);
}
