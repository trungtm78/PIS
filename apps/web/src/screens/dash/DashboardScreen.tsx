import { useCallback, useEffect, useRef } from 'react';
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

  const onPage = useCallback(
    (index: number) => {
      setParams((before) => {
        const next = new URLSearchParams(before);
        next.set(PAGE_PARAM, String(index + 1));
        return next;
      });
    },
    [setParams],
  );

  const db = data.data?.db;
  useEffect(() => {
    if (host.current === null || db === undefined) return undefined;
    const dashboard = mountDashboard(host.current, db, { page: first.current, onPage });
    mounted.current = dashboard;
    return () => {
      mounted.current = undefined;
      dashboard.dispose();
    };
  }, [db, onPage]);
  useEffect(() => {
    mounted.current?.go(page);
  }, [page]);

  const showFull = () => {
    void host.current?.requestFullscreen?.();
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="dash9-screen">
      <h1 id="screen-title" className="ui-sr-only">
        {route.title}
      </h1>
      <div className="dash9-bar">
        <span className="dash9-hint">{t('home.dash.keys.hint')}</span>
        <button type="button" className="ui-button" onClick={showFull} disabled={db === undefined}>
          {t('home.dash.full.label')}
        </button>
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
