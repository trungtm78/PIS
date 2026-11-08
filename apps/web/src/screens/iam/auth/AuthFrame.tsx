import type { ReactNode } from 'react';
import { BrandMark } from '../../../brand/BrandMark';
import { useTranslation } from '../../../i18n';
import { useEdition } from '../../../editions/EditionContext';
import type { WebRoute } from '../../../routes/types';

export interface AuthFrameProps {
  route: WebRoute;
  title: string;
  subtitle: string;
  footer: string;
  children: ReactNode;
}

/** The page frame of the three sign-in screens: title, one line of what the page is for, and the footer that names the screen and its requirement. */
export function AuthFrame({ route, title, subtitle, footer, children }: AuthFrameProps) {
  const { t } = useTranslation();
  const { manifest } = useEdition();
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="auth-brand" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <BrandMark size={56} labelled />
        <p style={{ margin: 0, fontWeight: 600 }}>{manifest.edition === 'enterprise' ? t('logo.tagline.enterprise') : t('logo.tagline.public')}</p>
      </div>
      <div className="heading">
        <div>
          <h1 id="screen-title">{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>
      {children}
      <p className="prototype-note">{footer}</p>
    </section>
  );
}
