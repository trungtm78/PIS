import { ApiError } from '@machvon/api-client';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { SectionCard } from '../../ui';
import { ClockChip, FormulaTile, Notice, PolicyNote } from './components';
import { useWidget } from './hooks';
import { BOARD_PATH, dayText, directivePath } from './model';

/**
 * The dashboard widget of the directives (DIR-1, CN.03 and QT.02): how many directives are overdue, due soon and escalated to the head of the unit, and the oldest overdue ones, each opening its directive. It reads
 * `getDirectiveWidget` itself, so a dashboard places it and nothing else. Every figure has its "i" (formula, source, time, policy); loading is a skeleton and never 0; a failure is an error with a retry, never "no
 * directive is late"; a reader who has no right to read directives is told so in words (the widget is a place a dashboard may show to everybody).
 */
export function DirectiveWidget() {
  const { t } = useTranslation();
  const read = useWidget();
  const data = read.data ?? undefined;
  const denied = read.error instanceof ApiError && read.error.status === 403;
  const state = read.isLoading ? 'loading' : data === undefined && read.error !== null ? 'error' : 'ready';
  const policy = data?.policy ?? { code: 'DEFAULT', version: null, source: 'DEFAULT' as const, unverified: true, reminderDaysBefore: [], escalateAfterOverdueDays: 0, maxExtensions: 0, maxExtensionDays: 0, closeRequiresEvidence: true };
  if (denied) {
    return (
      <SectionCard title={t('dir.widget.title')}>
        <p className="callout" role="status" data-testid="widget-denied">
          {t('dir.widget.denied.text')}
        </p>
      </SectionCard>
    );
  }
  const tile = (label: string, value: number | undefined, formula: string | undefined, tone?: 'danger' | 'warning') => (
    <FormulaTile label={label} value={value === undefined ? '' : String(value)} {...(tone === undefined ? {} : { tone })} formula={formula} asOf={data?.asOf ?? ''} policy={policy} state={data === undefined ? state : 'ready'} onRetry={() => void read.refetch()} />
  );
  return (
    <SectionCard
      title={t('dir.widget.title')}
      actions={
        <Link className="ui-button ui-button--outline" to={BOARD_PATH}>
          {t('dir.widget.all.action')}
        </Link>
      }
    >
      <div className="dir-widget" data-testid="directive-widget">
        <div className="dir-board">
          {tile(t('dir.widget.overdue.label'), data?.counts.overdue, data?.definitions.overdue, 'danger')}
          {tile(t('dir.widget.escalated.label'), data?.counts.escalated, data?.definitions.escalated, 'danger')}
          {tile(t('dir.widget.soon.label'), data?.counts.dueSoon, data?.definitions.due_soon, 'warning')}
        </div>
        {data === undefined ? null : data.items.length === 0 ? (
          <p className="muted" data-testid="widget-none">
            {t('dir.widget.none.text')}
          </p>
        ) : (
          <ul className="dir-widget__items" aria-label={t('dir.widget.items.label')}>
            {data.items.map((line) => (
              <li key={line.id} className="dir-card">
                <Link to={directivePath(line.id)}>{line.code}</Link>
                <p>{line.text}</p>
                <div className="dir-card__meta">
                  <span>{line.assigneeUnit.code}</span>
                  <span>{t('dir.card.due.text', { day: dayText(line.dueOn) })}</span>
                  <ClockChip line={line} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {data?.truncated === true ? <Notice tone="info">{t('dir.board.truncated.text')}</Notice> : null}
        {data === undefined ? null : <PolicyNote policy={data.policy} />}
      </div>
    </SectionCard>
  );
}

export default DirectiveWidget;
