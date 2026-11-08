import { useTranslation } from '../../i18n';
import { StatusPill } from '../../ui';
import { certStatusLabel } from './certification-labels';
import { statusTone } from './certification-model';
import type { CertStatus } from './certification-model';

/** A certification state as text on a pill (Draft, Confirmed, Certified, Outdated): never colour alone. */
export function CertPill({ status }: { status: CertStatus }) {
  const { t } = useTranslation();
  return (
    <span data-cert-status={status}>
      <StatusPill tone={statusTone(status)}>{certStatusLabel(t, status)}</StatusPill>
    </span>
  );
}
