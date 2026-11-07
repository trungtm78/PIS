import { useTranslation } from '../i18n';
import { StatusPill } from './StatusPill';

export interface MakerCheckerBadgeProps {
  maker: string;
  checker?: string | null;
}

/** Who made the record and who checked it; a record nobody checked yet says so, and the same person in both roles is flagged. */
export function MakerCheckerBadge({ maker, checker }: MakerCheckerBadgeProps) {
  const { t } = useTranslation();
  const checked = checker !== undefined && checker !== null && checker !== '';
  const same = checked && checker === maker;
  return (
    <span className="ui-maker-checker" role="group" aria-label={t('ui.makerChecker.label')}>
      <span className="ui-maker-checker__maker">{t('ui.makerChecker.maker', { name: maker })}</span>
      {checked ? <span className="ui-maker-checker__checker">{t('ui.makerChecker.checker', { name: checker })}</span> : <StatusPill tone="warning">{t('ui.makerChecker.pending')}</StatusPill>}
      {same && <StatusPill tone="danger">{t('ui.makerChecker.same')}</StatusPill>}
    </span>
  );
}
