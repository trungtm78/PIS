import { useMemo, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { WebRoute } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { YearEditor } from './calendar/YearEditor';
import { YearList } from './calendar/YearList';
import { MANAGE_CALENDAR_PERMISSION, MAX_YEAR, MIN_YEAR } from './calendar/model';
import type { CalendarView } from './calendar/model';
import { DEFAULT_CALENDAR_CODE, openingVersion, yearRows } from './calendar/year-model';
import './adm-kit.css';
import './calendar/calendar.css';

function currentYear(): number {
  return Math.min(MAX_YEAR, Math.max(MIN_YEAR, new Date().getFullYear()));
}

export interface WorkCalendarWorkspaceProps {
  route: WebRoute;
  /** The versions of the tenant, as the version reads return them. */
  versions: readonly CalendarView[];
}

/**
 * ADM-07: the yearly work calendar of the tenant (ST-ADM-010). The years are listed with their state; a year opens as one page with its weekly rest days, the days added by range, the table of special days, the twelve months with the
 * working days of each, and the two moves: save the calendar (a draft revision) and confirm the year (the version every deadline created afterwards is counted by; a deadline already counted does not move).
 */
export function WorkCalendarWorkspace({ route, versions }: WorkCalendarWorkspaceProps) {
  const tenantId = useSession().tenant?.id;
  // Everything the screen holds (the open year, the form, the open confirmation) belongs to one tenant: a switch starts it over.
  return <WorkspaceContent key={tenantId ?? 'none'} route={route} versions={versions} />;
}

function WorkspaceContent({ route, versions }: WorkCalendarWorkspaceProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  // A suspended tenant (READ_ONLY mode) is read-only for everyone, whatever the grants say.
  const frozen = mode === 'READ_ONLY';
  const canManage = permissions === undefined || permissions.includes(MANAGE_CALENDAR_PERMISSION);
  const lockedNotice = frozen ? t('wfxcal.frozen.notice') : !canManage ? t('wfxcal.readOnly.notice') : undefined;
  // The calendar the deadlines are counted on is the default one; a tenant whose versions all carry another code starts from that code.
  const defaultCode = useMemo(() => (versions.some((one) => one.calendarCode === DEFAULT_CALENDAR_CODE) || versions.length === 0 ? DEFAULT_CALENDAR_CODE : (versions[0] as CalendarView).calendarCode), [versions]);
  const thisYear = currentYear();
  const rows = useMemo(() => yearRows(versions, defaultCode, [thisYear - 1, thisYear, thisYear + 1, thisYear + 2].filter((year) => year >= MIN_YEAR && year <= MAX_YEAR)), [versions, defaultCode, thisYear]);
  const [opened, setOpened] = useState<{ code: string; year: number; from?: string; nonce: number } | undefined>({ code: defaultCode, year: thisYear, nonce: 0 });
  const row = opened === undefined ? undefined : (rows.find((one) => one.code === opened.code && one.year === opened.year) ?? yearRows(versions, opened.code, [opened.year]).find((one) => one.year === opened.year && one.code === opened.code));
  const source = row === undefined ? undefined : (opened?.from === undefined ? openingVersion(row) : row.versions.find((one) => one.id === opened.from));

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('wfxcal.page.title')}</h1>
          <p>{t('wfxcal.page.subtitle')}</p>
        </div>
      </div>
      <div className="adm-calendar">
        <YearList rows={rows} opened={opened} defaultCode={defaultCode} canManage={canManage && !frozen} onOpen={(code, year) => setOpened((current) => ({ code, year, nonce: (current?.nonce ?? 0) + 1 }))} />
        {row === undefined ? null : (
          <YearEditor
            // A year (or a version of it) opened from the list starts its own form: the form of one year is never carried into another. Saving under another code keeps the form.
            key={`${row.year}:${opened?.nonce ?? 0}:${opened?.from ?? ''}`}
            row={row}
            source={source}
            canManage={canManage}
            lockedNotice={lockedNotice}
            onOpenVersion={(id) => setOpened((current) => ({ code: row.code, year: row.year, from: id, nonce: (current?.nonce ?? 0) + 1 }))}
            onSaved={(code) => setOpened((current) => (current === undefined || current.code === code ? current : { ...current, code }))}
          />
        )}
      </div>
      <p className="prototype-note">{t('adm.calendar.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
