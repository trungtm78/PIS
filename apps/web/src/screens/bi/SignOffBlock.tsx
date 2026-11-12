import { useTranslation } from '../../i18n';
import type { Signature, SignOff } from './dashboard-model';

const day = (stamp: string): string => stamp.slice(0, 10);

/**
 * The three signatures of a management report (BC.02): who prepared it, who checked it and who approved it, each with the day. A step nobody took is written as such, a person with no name in the directory is shown by
 * their identifier (a name is never made up), and a report that does not have all three is said not to, in words.
 */
export function SignOffBlock({ signOff }: { signOff: SignOff | null }) {
  const { t } = useTranslation();
  if (signOff === null) {
    return (
      <p className="sub" data-testid="sign-none">
        {t('bi.sign.noVersion')}
      </p>
    );
  }
  const line = (testId: string, label: string, signature: Signature | null) => (
    <div key={testId}>
      <dt>{label}</dt>
      <dd data-testid={testId}>{signature === null ? t('bi.sign.none') : t('bi.sign.line', { name: signature.name ?? signature.id, date: day(signature.at) })}</dd>
    </div>
  );
  return (
    <div data-testid="sign-off" data-state={signOff.state}>
      <h3>{t('bi.sign.title')}</h3>
      <dl>
        {line('sign-prepared', t('bi.sign.prepared'), signOff.prepared)}
        {line('sign-checked', t('bi.sign.checked'), signOff.checked)}
        {line('sign-approved', t('bi.sign.approved'), signOff.approved)}
      </dl>
      {signOff.complete ? (
        <p className="sub" data-testid="sign-complete">
          {t('bi.sign.complete')}
        </p>
      ) : (
        <p className="callout warning" data-testid="sign-incomplete">
          {t('bi.sign.incomplete')}
        </p>
      )}
    </div>
  );
}
