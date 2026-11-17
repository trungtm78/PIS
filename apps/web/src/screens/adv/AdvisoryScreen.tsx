import { useTranslation } from '../../i18n';
import { NotImplementedScreen } from '../../routes/NotImplementedScreen';
import type { ScreenProps } from '../../routes/types';
import { Icon } from '../../shell/Icon';
import { SectionCard, StatusPill, Tabs, useTabParam } from '../../ui';
import { AdvisoryMockup } from './AdvisoryMockup';
import { advisoryContent, isAdvisoryId } from './advisory-content';
import './adv.css';

/** The tabs of a page: the mockup first, since a reader wants to see the screen; the address keeps the other one (?view=intro). */
const TAB_IDS = ['screen', 'intro'] as const;

function Lines({ items, ordered = false }: { items: readonly string[]; ordered?: boolean }) {
  const rows = items.map((item) => <li key={item}>{item}</li>);
  return ordered ? <ol className="adv-list">{rows}</ol> : <ul className="adv-list">{rows}</ul>;
}

/**
 * ADV-01 to ADV-05, the explanatory pages of the advisory group ("Co van AI"). The functions are not built: each page says in words that the function will be deployed, and explains what it is planned to do,
 * which data of the system it would read, how it would work, how it would be paid for where a fee applies and what a leader of the province gains. One component draws the five pages from the content of the
 * screen (advisory-content.ts). The page has two tabs: the mockup of the planned screen first (AdvisoryMockup.tsx, example figures only), then the explanation in words; the status stays above both. A page reads nothing from the server and changes nothing, so it has no loading, empty or error state and every member may read it.
 */
export default function AdvisoryScreen({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useTabParam('view', TAB_IDS);
  const content = advisoryContent(route.id, t);
  if (content === undefined || !isAdvisoryId(route.id)) return <NotImplementedScreen route={route} />;
  const intro = (
    <>
      <p className="callout adv-callout" role="note" data-testid="adv-status-note">
        {t('adv.page.status.note')}
      </p>
      <div className="adv-sections">
        <SectionCard title={t('adv.section.features.title')}>
          <Lines items={content.features} />
        </SectionCard>
        <SectionCard title={t('adv.section.data.title')}>
          <Lines items={content.data} />
        </SectionCard>
        <SectionCard title={t('adv.section.steps.title')}>
          <Lines items={content.steps} ordered />
        </SectionCard>
        <SectionCard title={t('adv.section.benefits.title')}>
          <Lines items={content.benefits} />
        </SectionCard>
        {content.plans === undefined ? null : (
          <div className="adv-wide">
            <SectionCard title={t('adv.section.plans.title')}>
              <ul className="adv-plans">
                {content.plans.rows.map((plan) => (
                  <li className="adv-plan" key={plan.id} data-plan={plan.id}>
                    <h3>{plan.name}</h3>
                    <p className="adv-plan__fee">{plan.fee}</p>
                    <p>{plan.adds}</p>
                  </li>
                ))}
              </ul>
              <p className="adv-note">{content.plans.note}</p>
            </SectionCard>
          </div>
        )}
        {content.fee === undefined ? null : (
          <div className="adv-wide">
            <SectionCard title={t('adv.section.fee.title')}>
              {content.fee.map((line) => (
                <p className="adv-text" key={line}>
                  {line}
                </p>
              ))}
            </SectionCard>
          </div>
        )}
      </div>
    </>
  );
  return (
    <section className="adv-page" data-screen-id={route.id} aria-labelledby="screen-title">
      <header className="adv-head">
        <span className="adv-head__icon">
          <Icon name={content.icon} />
        </span>
        <div>
          <h1 id="screen-title">{content.title}</h1>
          <p className="adv-status">
            <StatusPill tone="info">{t('adv.page.status.label')}</StatusPill>
          </p>
          <p className="adv-summary">{content.summary}</p>
        </div>
      </header>
      <Tabs
        label={t('adv.tabs.list.label')}
        value={tab}
        onChange={setTab}
        testId="adv"
        tabs={[
          { id: 'screen', label: t('adv.tabs.screen.label'), panel: <AdvisoryMockup id={route.id} /> },
          { id: 'intro', label: t('adv.tabs.intro.label'), panel: intro },
        ]}
      />
    </section>
  );
}
