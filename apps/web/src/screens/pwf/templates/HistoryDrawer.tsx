import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import { statusText } from '../../adm/governance/labels';
import { useEffective, useVersions } from '../../adm/governance/hooks';
import { PATHS, TEMPLATE_RULE_TYPE, editorLink } from '../model';
import { TemplateCompare } from './Compare';
import { DEFAULT_SIDE, compareSides } from './library-model';
import type { CompareSide } from './library-model';
import { SideDrawer } from './SideDrawer';
import { RuleVersionList } from './store';

export interface HistoryDrawerProps {
  code: string;
  canManage: boolean;
  canApprove: boolean;
  writable: boolean;
  onClose: () => void;
}

/**
 * The versions of the procedure and what each says (PWF 22): who wrote and who approved each, the moves a person may make (never their own approval), and any two versions side by side. It is the same list the rule store
 * keeps; the drawer only puts it beside the table so that the table is not left.
 */
export function HistoryDrawer({ code, canManage, canApprove, writable, onClose }: HistoryDrawerProps) {
  const { t } = useTranslation();
  const versions = useVersions(TEMPLATE_RULE_TYPE, code, undefined, true);
  const effective = useEffective(TEMPLATE_RULE_TYPE, code, undefined, true);
  const sides = compareSides(versions.data ?? [], effective.data ?? null);
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('');
  const left = sides.find((side) => side.id === leftId);
  const right = sides.find((side) => side.id === rightId);
  const label = (side: CompareSide): string => (side.id === DEFAULT_SIDE ? t('pwf.templates.compare.default.option') : t('pwf.templates.compare.version.option', { version: side.version, status: side.status === 'DEFAULT' ? '' : statusText(t, side.status) }).trim());
  return (
    <SideDrawer title={t('pwfx.history.title')} onClose={onClose} testId="history-drawer">
      <RuleVersionList
        ruleType={TEMPLATE_RULE_TYPE}
        code={code}
        canManage={canManage}
        canApprove={canApprove}
        writable={writable}
        editLink={(id) => editorLink(code, id)}
        diffLink={(id, against) => `${PATHS.ruleDiff}?rule=${id}${against === undefined ? '' : `&against=${against}`}`}
      />
      <section className="pwfx-group" aria-labelledby="pwfx-history-compare">
        <h3 id="pwfx-history-compare">{t('pwf.templates.compare.title')}</h3>
        <div className="pwf-filters">
          {([
            ['left', leftId, setLeftId],
            ['right', rightId, setRightId],
          ] as const).map(([name, value, set]) => (
            <div key={name} className="pwf-field">
              <label htmlFor={`pwfx-history-${name}`}>{t(`pwf.templates.compare.${name}.label`)}</label>
              <select id={`pwfx-history-${name}`} data-testid={`compare-${name}`} value={value} disabled={sides.length === 0} onChange={(event) => set(event.target.value)}>
                <option value="">{t('pwf.templates.compare.choose.option')}</option>
                {sides.map((side) => (
                  <option key={side.id} value={side.id}>
                    {label(side)}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        {left === undefined || right === undefined ? (
          <p className="callout" role="status" data-testid="compare-pick">
            {t('pwf.templates.compare.pick.text')}
          </p>
        ) : (
          <TemplateCompare before={left.template} after={right.template} left={label(left)} right={label(right)} />
        )}
      </section>
    </SideDrawer>
  );
}
