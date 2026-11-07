import { useTranslation } from '../../../i18n';
import { SectionCard } from '../../../ui';
import { groupPermissions } from './permission-groups';
import type { RoleView } from './types';

export interface RolePreviewProps {
  role?: RoleView;
}

/** The preview card of the mockup: the rule callout and a paper sheet, here summarising the selected role. */
export function RolePreview({ role }: RolePreviewProps) {
  const { t } = useTranslation();
  const groups = role === undefined ? [] : groupPermissions(role.permissions);
  return (
    <SectionCard title={t('adm.roles.preview.title')}>
      <div className="callout">{t('adm.roles.preview.rule')}</div>
      <div className="paper">
        <div className="eyebrow">{t('adm.roles.preview.eyebrow')}</div>
        {role === undefined ? (
          <p className="muted">{t('adm.roles.preview.empty')}</p>
        ) : (
          <>
            <h3 className="gap">{role.code}</h3>
            <p className="sub">
              {t('adm.roles.preview.rank', { rank: role.rank })} · {t('adm.roles.preview.count', { count: groups.reduce((sum, group) => sum + group.actions.length, 0) })}
            </p>
            <div className="quote">{role.guest_allowed ? t('adm.roles.preview.guest.yes') : t('adm.roles.preview.guest.no')}</div>
            {groups.map((group) => (
              <div className="docline" key={group.resource} title={group.resource} />
            ))}
          </>
        )}
      </div>
    </SectionCard>
  );
}
