import type { Translator } from '../../i18n';
import type { IconName } from '../../shell/icons';

type T = Translator['t'];

/** One plan of a paid advisory: its name, how it is paid for and what it holds. No price: the fee is agreed when the function is deployed. */
export interface AdvisoryPlan {
  id: string;
  name: string;
  fee: string;
  adds: string;
}

/**
 * What an explanatory page of the advisory group (ADV-01 to ADV-05) says. The function behind the page is not built: the page tells the reader what the system will have.
 * Every text is a line of the catalogue; the page holds no figure, no partner name and no price.
 */
export interface AdvisoryContent {
  icon: IconName;
  title: string;
  summary: string;
  /** What the function is planned to do. */
  features: readonly string[];
  /** Which data of the system the advisory would read. */
  data: readonly string[];
  /** The steps of the advisory, in order. */
  steps: readonly string[];
  /** The plans of the advisory and the note under them, where the function has plans (ADV-01). */
  plans?: { rows: readonly AdvisoryPlan[]; note: string };
  /** How the advisory is paid for where it has no plans (ADV-02: through the partner). */
  fee?: readonly string[];
  /** What a leader of the province gains. */
  benefits: readonly string[];
}

export const ADVISORY_IDS = ['ADV-01', 'ADV-02', 'ADV-03', 'ADV-04', 'ADV-05'] as const;
export type AdvisoryId = (typeof ADVISORY_IDS)[number];

/** ADV-01: AI advisory on capital steering, with a free plan and two plans paid by monthly subscription. */
function capitalByAi(t: T): AdvisoryContent {
  return {
    icon: 'chip',
    title: t('adv.ai.page.title'),
    summary: t('adv.ai.page.summary'),
    features: [t('adv.ai.feature.f1'), t('adv.ai.feature.f2'), t('adv.ai.feature.f3'), t('adv.ai.feature.f4'), t('adv.ai.feature.f5'), t('adv.ai.feature.f6')],
    data: [t('adv.ai.data.d1'), t('adv.ai.data.d2'), t('adv.ai.data.d3'), t('adv.ai.data.d4')],
    steps: [t('adv.ai.step.s1'), t('adv.ai.step.s2'), t('adv.ai.step.s3'), t('adv.ai.step.s4')],
    plans: {
      rows: [
        { id: 'standard', name: t('adv.ai.plan.standard.name'), fee: t('adv.ai.plan.standard.fee'), adds: t('adv.ai.plan.standard.adds') },
        { id: 'pro', name: t('adv.ai.plan.pro.name'), fee: t('adv.ai.plan.paid.fee'), adds: t('adv.ai.plan.pro.adds') },
        { id: 'premium', name: t('adv.ai.plan.premium.name'), fee: t('adv.ai.plan.paid.fee'), adds: t('adv.ai.plan.premium.adds') },
      ],
      note: t('adv.ai.plan.note.text'),
    },
    benefits: [t('adv.ai.benefit.b1'), t('adv.ai.benefit.b2'), t('adv.ai.benefit.b3')],
  };
}

/** ADV-02: advisory by financial experts, paid for through the partner that makes the connection. */
function capitalByExperts(t: T): AdvisoryContent {
  return {
    icon: 'expert',
    title: t('adv.expert.page.title'),
    summary: t('adv.expert.page.summary'),
    features: [t('adv.expert.feature.f1'), t('adv.expert.feature.f2'), t('adv.expert.feature.f3'), t('adv.expert.feature.f4'), t('adv.expert.feature.f5'), t('adv.expert.feature.f6')],
    data: [t('adv.expert.data.d1'), t('adv.expert.data.d2'), t('adv.expert.data.d3'), t('adv.expert.data.d4')],
    steps: [t('adv.expert.step.s1'), t('adv.expert.step.s2'), t('adv.expert.step.s3'), t('adv.expert.step.s4')],
    fee: [t('adv.expert.fee.p1'), t('adv.expert.fee.p2')],
    benefits: [t('adv.expert.benefit.b1'), t('adv.expert.benefit.b2'), t('adv.expert.benefit.b3')],
  };
}

/** ADV-03: strategic solutions and drafts of provincial decisions. */
function strategy(t: T): AdvisoryContent {
  return {
    icon: 'compass',
    title: t('adv.strategy.page.title'),
    summary: t('adv.strategy.page.summary'),
    features: [t('adv.strategy.feature.f1'), t('adv.strategy.feature.f2'), t('adv.strategy.feature.f3'), t('adv.strategy.feature.f4'), t('adv.strategy.feature.f5'), t('adv.strategy.feature.f6')],
    data: [t('adv.strategy.data.d1'), t('adv.strategy.data.d2'), t('adv.strategy.data.d3'), t('adv.strategy.data.d4')],
    steps: [t('adv.strategy.step.s1'), t('adv.strategy.step.s2'), t('adv.strategy.step.s3'), t('adv.strategy.step.s4')],
    benefits: [t('adv.strategy.benefit.b1'), t('adv.strategy.benefit.b2'), t('adv.strategy.benefit.b3')],
  };
}

/** ADV-04: revision of the existing procedures of the province. */
function procedures(t: T): AdvisoryContent {
  return {
    icon: 'flowEdit',
    title: t('adv.process.page.title'),
    summary: t('adv.process.page.summary'),
    features: [t('adv.process.feature.f1'), t('adv.process.feature.f2'), t('adv.process.feature.f3'), t('adv.process.feature.f4'), t('adv.process.feature.f5'), t('adv.process.feature.f6')],
    data: [t('adv.process.data.d1'), t('adv.process.data.d2'), t('adv.process.data.d3'), t('adv.process.data.d4')],
    steps: [t('adv.process.step.s1'), t('adv.process.step.s2'), t('adv.process.step.s3'), t('adv.process.step.s4')],
    benefits: [t('adv.process.benefit.b1'), t('adv.process.benefit.b2'), t('adv.process.benefit.b3')],
  };
}

/** ADV-05: strategy and management training for the steering board, the departments, the wards and the communes. */
function training(t: T): AdvisoryContent {
  return {
    icon: 'graduation',
    title: t('adv.training.page.title'),
    summary: t('adv.training.page.summary'),
    features: [
      t('adv.training.feature.f1'),
      t('adv.training.feature.f2'),
      t('adv.training.feature.f3'),
      t('adv.training.feature.f4'),
      t('adv.training.feature.f5'),
      t('adv.training.feature.f6'),
      t('adv.training.feature.f7'),
    ],
    data: [t('adv.training.data.d1'), t('adv.training.data.d2'), t('adv.training.data.d3'), t('adv.training.data.d4')],
    steps: [t('adv.training.step.s1'), t('adv.training.step.s2'), t('adv.training.step.s3'), t('adv.training.step.s4')],
    benefits: [t('adv.training.benefit.b1'), t('adv.training.benefit.b2'), t('adv.training.benefit.b3')],
  };
}

const BUILDERS: Readonly<Record<AdvisoryId, (t: T) => AdvisoryContent>> = {
  'ADV-01': capitalByAi,
  'ADV-02': capitalByExperts,
  'ADV-03': strategy,
  'ADV-04': procedures,
  'ADV-05': training,
};

/** Whether a screen id is a page of the advisory group. */
export const isAdvisoryId = (id: string): id is AdvisoryId => (ADVISORY_IDS as readonly string[]).includes(id);

/** The content of the explanatory page of a screen, in the language of the translator; undefined for an id that is not a page of the group. */
export function advisoryContent(id: string, t: T): AdvisoryContent | undefined {
  return isAdvisoryId(id) ? BUILDERS[id](t) : undefined;
}
