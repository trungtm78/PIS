import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { WEB_ROUTES } from '../routes/web-routes';
import { SessionGate } from './SessionGate';
import ApprovalDetailScreen from './screens/ApprovalDetailScreen';
import ApprovalQueueScreen from './screens/ApprovalQueueScreen';
import DirectiveDetailScreen from './screens/DirectiveDetailScreen';
import DirectivesScreen from './screens/DirectivesScreen';
import FiguresDetailScreen from './screens/FiguresDetailScreen';
import LeaderDashboardScreen from './screens/LeaderDashboardScreen';
import ProgressScreen from './screens/ProgressScreen';
import PwaNotificationsScreen from './screens/PwaNotificationsScreen';
import PwaStartScreen from './screens/PwaStartScreen';
import SettingsScreen from './screens/SettingsScreen';
import { useApiDirectives } from './screens/directives-api-source';
import { DirectivesSourceContext } from './screens/directives-source';

/** The route of the start page and the screens; `/m` is what the manifest's `start_url` opens. */
export const PWA_ROUTE_PREFIX = '/m';
/** The tenant chooser (IAM-04), where a person who is known and has not chosen a tenant is sent. */
const CHOOSER_PATH = WEB_ROUTES.find((route) => route.id === 'IAM-04')?.path ?? '/';

function Gated({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <SessionGate next={`${location.pathname}${location.search}`} chooserPath={CHOOSER_PATH}>{children}</SessionGate>;
}

/** The manager screens of the installed application, behind the same sign-in and tenant gate as every other screen. The directive tracking reads the directive module (PWA-04). */
export function PwaRoutes() {
  return (
    <DirectivesSourceContext.Provider value={useApiDirectives}>
      <Routes>
        <Route index element={<Gated><PwaStartScreen /></Gated>} />
        <Route path="approvals" element={<Gated><ApprovalQueueScreen /></Gated>} />
        <Route path="approvals/:taskId" element={<Gated><ApprovalDetailScreen /></Gated>} />
        <Route path="dashboard" element={<Gated><LeaderDashboardScreen /></Gated>} />
        <Route path="dashboard/detail" element={<Gated><FiguresDetailScreen /></Gated>} />
        <Route path="progress" element={<Gated><ProgressScreen /></Gated>} />
        <Route path="directives" element={<Gated><DirectivesScreen /></Gated>} />
        <Route path="directives/:id" element={<Gated><DirectiveDetailScreen /></Gated>} />
        <Route path="settings" element={<Gated><SettingsScreen /></Gated>} />
        <Route path="notifications" element={<Gated><PwaNotificationsScreen /></Gated>} />
        <Route path="*" element={<Navigate to={PWA_ROUTE_PREFIX} replace />} />
      </Routes>
    </DirectivesSourceContext.Provider>
  );
}
