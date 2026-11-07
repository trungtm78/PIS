import type { ReactNode } from 'react';
import { useTranslation } from '../../../i18n';
import type { WebRoute } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { holds } from './model';
import '../dgv-kit.css';

/** The page of a governance view: its heading, what it reads and where it stands, with the footer that names the screen. */
export function Frame({ route, title, subtitle, children }: { route: WebRoute; title: string; subtitle: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>
      <p className="callout" data-testid="readonly-note">
        {t('dgv.governance.readonly.note')}
      </p>
      {children}
      <p className="prototype-note">{t('dgv.governance.footer.reference', { id: route.id, req: route.req ?? '', title })}</p>
    </section>
  );
}

/** A part of a view that is shown only to who holds the right to read what it reads: without it the part is the denied state and nothing is asked of the server. */
export function Gate({ permission, name, children }: { permission: string; name: string; children: ReactNode }) {
  const { permissions } = useSession();
  if (holds(permissions, permission)) return <>{children}</>;
  return (
    <div data-testid={`${name}-denied`}>
      <StateBoundary state="denied" />
    </div>
  );
}
