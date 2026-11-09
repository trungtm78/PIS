import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';

/** The way back to the start page of the manager screens; a target of at least 44 px, because the screens are used with a thumb. */
export function PwaBackLink({ to, label }: { to: string; label?: string }) {
  const { t } = useTranslation();
  return (
    <Link to={to} className="pwa-back pwa-touch" data-testid="pwa-back">
      <span aria-hidden="true">‹</span> {label ?? t('pwa.common.back.link')}
    </Link>
  );
}
