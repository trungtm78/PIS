import { lazy, Suspense } from 'react';
import { useEdition } from '../../editions/EditionContext';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import OverviewScreen from '../home/OverviewScreen';
import { isCaMauTenant } from './scope';

const DashboardScreen = lazy(() => import('./DashboardScreen'));

/**
 * HOME-01, the leader home. The province of Cà Mau, in the public edition, opens on the dashboard of its steering work; every other tenant, and the enterprise edition, keeps the executive
 * overview. The figures of the overview stay one click away for Cà Mau too: the command center (HOME-09) draws the same snapshot.
 */
export default function HomeLandingScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  const edition = useEdition().manifest.edition;
  if (edition !== 'public' || !isCaMauTenant(tenant)) return <OverviewScreen route={route} />;
  return (
    <Suspense fallback={null}>
      <DashboardScreen key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />
    </Suspense>
  );
}
