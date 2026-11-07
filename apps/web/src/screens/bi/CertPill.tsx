import { useTranslation } from '../../i18n';
import { StatusPill } from '../../ui';
import { certStatusLabel } from './certification-labels';
import { statusTone } from './certification-model';
import type { CertStatus } from './certification-model';

/** A certification state as text on a pill (Nháp, Đã xác nhận, Đã chứng nhận, Lỗi thời): never colour alone. */
export function CertPill({ status }: { status: CertStatus }) {
  const { t } = useTranslation();
  return (
    <span data-cert-status={status}>
      <StatusPill tone={statusTone(status)}>{certStatusLabel(t, status)}</StatusPill>
    </span>
  );
}
