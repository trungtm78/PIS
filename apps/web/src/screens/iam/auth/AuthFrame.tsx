import type { ReactNode } from 'react';
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
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
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
