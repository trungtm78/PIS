import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useDashboardData } from './hooks';
import { mountDashboard } from './template/index.js';
import type { MountedDashboard } from './template/index.js';
import './screen.css';

const PAGE_PARAM = 'trang';

/** The page the address names (`?trang=3` is the third), or the first. */
export function pageOf(value: string | null): number {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? page - 1 : 0;
}

/**
 * The dashboard of the steering work of the province (HOME-01 of Cà Mau): the owner's template, drawn from the tables `useDashboardData` assembles. The page on
 * screen is part of the address, so a link opens the page it was copied from and Back returns to the page before.
 */
export default function DashboardScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const data = useDashboardData();
  const [params, setParams] = useSearchParams();
  const page = pageOf(params.get(PAGE_PARAM));
  const host = useRef<HTMLDivElement>(null);
  const mounted = useRef<MountedDashboard | undefined>(undefined);
  const first = useRef(page);
  first.current = page;

  // The board is mounted once for one database: what it calls when the reader changes page is read through a ref, because the setter of the address changes with every address.
  const onPage = useRef<(index: number) => void>(() => undefined);
  onPage.current = (index: number) => {
    setParams((before) => {
      const next = new URLSearchParams(before);
      next.set(PAGE_PARAM, String(index + 1));
      return next;
    });
  };

  const db = data.data?.db;
  useEffect(() => {
    if (host.current === null || db === undefined) return undefined;
    const dashboard = mountDashboard(host.current, db, { page: first.current, onPage: (index) => onPage.current(index) });
    mounted.current = dashboard;
    return () => {
      mounted.current = undefined;
      dashboard.dispose();
    };
  }, [db]);
  useEffect(() => {
    mounted.current?.go(page);
  }, [page]);

  // A browser that cannot show an element full screen gets no button; one that refuses this time (no user gesture, a policy of the page) leaves the board as it was.
  const canShowFull = typeof document !== 'undefined' && document.fullscreenEnabled === true;
  const showFull = () => {
    host.current?.requestFullscreen?.()?.catch(() => undefined);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="dash9-screen">
      <h1 id="screen-title" className="ui-sr-only">
        {route.title}
      </h1>
      <div className="dash9-bar">
        <span className="dash9-hint">{t('home.dash.keys.hint')}</span>
        {canShowFull ? (
          <button type="button" className="ui-button" onClick={showFull} disabled={db === undefined}>
            {t('home.dash.full.label')}
          </button>
        ) : null}
      </div>
      {data.isLoading ? <p role="status">{t('home.dash.loading.label')}</p> : null}
      {data.isError ? (
        <div role="alert" className="dash9-problem">
          <p>{t('home.dash.error.title')}</p>
          <button type="button" className="ui-button" onClick={() => void data.refetch()}>
            {t('home.dash.retry.label')}
          </button>
        </div>
      ) : null}
      <div ref={host} className="dash9-host" data-testid="dash9" role="region" aria-label={t('home.dash.region.label')} tabIndex={0} />
    </section>
  );
}
