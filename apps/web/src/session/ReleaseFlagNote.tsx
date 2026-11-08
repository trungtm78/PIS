import { useTranslation } from '../i18n';
import { useFeatureFlags } from './useFeatureFlags';

export interface ReleaseFlagNoteProps {
  /** The release flag the screen's actions need (the server refuses them while it is off). */
  flagKey: string;
}

/**
 * Tells the person, above a screen whose actions rest on a release flag, that the flag is not on for the tenant, so the refusal of the server is no surprise. Nothing is shown while the flags load or when the flag is on;
 * a failed read says so with a way to read again, because a flag that could not be read is not a flag that is off.
 */
export function ReleaseFlagNote({ flagKey }: ReleaseFlagNoteProps) {
  const { t } = useTranslation();
  const flags = useFeatureFlags();
  if (flags.isLoading) return null;
  if (flags.isError) {
    return (
      <p className="callout" role="status" data-testid="release-flag-unknown">
        {t('misc.flag.unknown')}{' '}
        <button type="button" onClick={() => flags.refetch()}>
          {t('misc.flag.retry')}
        </button>
      </p>
    );
  }
  if (flags.enabled(flagKey) !== false) return null;
  return (
    <p className="callout warning" role="status" data-testid="release-flag-off" data-flag={flagKey}>
      {t('misc.flag.off', { flag: flagKey })}
    </p>
  );
}
