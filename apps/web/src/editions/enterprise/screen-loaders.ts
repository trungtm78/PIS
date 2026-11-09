import type { ScreenLoader } from '../../routes/types';

/**
 * The screens the enterprise edition brings with it, by screen id (ENT-2): the push of the issued reports to HPM and the file import and reconciliation of Oracle EBS. Each is loaded on demand like the screens of the
 * table; the application finds them through the bundle of the edition (`resolveScreen`), so a public build carries none of them.
 */
export const enterpriseScreens: Readonly<Record<string, ScreenLoader>> = {
  'HPM-01': () => import('./screens/hpm/PushLogScreen'),
  'HPM-02': () => import('./screens/hpm/CorrectionScreen'),
  'EBS-01': () => import('./screens/ebs/ConnectionScreen'),
  'EBS-02': () => import('./screens/ebs/DifferencesScreen'),
  'RML-01': () => import('./screens/mail/MailSchedulesScreen'),
};
