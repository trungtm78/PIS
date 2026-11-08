import { Outlet } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import './portal.css';

/**
 * The reduced frame of a contractor account (portal layout rule 1): the product name and the name of the workspace on top, the routed portal screen below. No sidebar, no module menu, no alert bell of the staff, no search of other
 * records. The shell chooses it when `isPortalCaller` says the caller holds the portal rights and none of the staff reading rights of the register.
 */
export function PortalFrame() {
  const { t } = useTranslation();
  const { tenant } = useSession();
  return (
    <div className="portal-frame" id="screen-capture" data-testid="portal-frame">
      <header className="portal-frame__bar">
        <strong>{t('vnp.frame.product.text')}</strong>
        {tenant !== undefined && <span className="portal-frame__tenant">{tenant.name}</span>}
      </header>
      <main className="portal-frame__body">
        <Outlet />
      </main>
    </div>
  );
}
