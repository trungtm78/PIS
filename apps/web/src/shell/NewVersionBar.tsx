import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import { builtVersion, isNewer, servedVersion } from '../version';
import type { AppVersion } from '../version';

/** How often a tab that stays open asks the server for its release, besides every time the tab gets the focus back. */
export const VERSION_CHECK_MS = 5 * 60_000;

interface Props {
  built?: AppVersion | undefined;
  read?: () => Promise<AppVersion | undefined>;
  reload?: () => void;
}

/**
 * A quiet bar for a tab that was loaded before the release now installed: "a new release is there, reload". The tab asks when it gets the focus back and every few
 * minutes; nothing reloads by itself (a person may be in the middle of a form). A build without a version shows nothing and asks nothing.
 */
export function NewVersionBar({ built = builtVersion(), read = servedVersion, reload = () => window.location.reload() }: Props) {
  const { t } = useTranslation();
  const [newer, setNewer] = useState(false);
  const version = built?.version;
  const commit = built?.commit;
  useEffect(() => {
    if (version === undefined) return undefined;
    let alive = true;
    const check = (): void => {
      void read().then((served) => {
        if (alive && isNewer({ version, commit: commit ?? '' }, served)) setNewer(true);
      });
    };
    const onFocus = (): void => {
      if (document.visibilityState !== 'hidden') check();
    };
    check();
    const timer = window.setInterval(check, VERSION_CHECK_MS);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [version, commit, read]);
  if (!newer) return null;
  return (
    <div className="new-version-bar" role="status">
      <span>{t('shell.version.newer.text')}</span>{' '}
      <button type="button" onClick={reload}>
        {t('shell.version.reload.action')}
      </button>
    </div>
  );
}

/** "Phiên bản 1.0.7", small; nothing for a build without a version. */
export function VersionLabel({ built = builtVersion() }: { built?: AppVersion | undefined }) {
  const { t } = useTranslation();
  if (built === undefined) return null;
  return (
    <small className="app-version" title={built.commit === '' ? undefined : built.commit}>
      {t('shell.version.label.text', { version: built.version })}
    </small>
  );
}
