# Contract of `apps/web/src/ui` (read with `design.md`)

One file per component (`Name.tsx`, `Name.test.tsx`), all exported from `index.ts`. Styles are plain CSS in `ui.css` (shared) and `alerts/alerts.css`, using only the `--mv-color-*` tokens of `packages/design-tokens/dist-css/tokens.css` (never a hex). Components take **already translated strings** from the caller; strings they own use keys `ui.<component>.<what>` in `src/i18n/parts/ui.vi.json` / `ui.en.json`.
Every component handles the states of design.md. A component with data has `state?: 'ready' | 'loading' | 'error' | 'empty'` (default `ready`) and `onRetry?: () => void`; `loading` renders a grey skeleton and **never the number 0**.

```ts
type Tone = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
type Severity = 'URGENT' | 'ACTION' | 'WATCH';

KpiTile      { icon?: ReactNode; label: string; value: string; unit?: string; sub?: ReactNode; tone?: Tone; href?: string; state?; onRetry? }
KpiStrip     { children: ReactNode; label?: string }                       // responsive grid of KpiTile / PeriodProgress, 4 → 2 → 1 columns
CommandHero  { label: string; value: string; unit: string; caption?: ReactNode; ratio?: { percent: number | null; label: string }; chips?: { label: string; value: string }[]; actions?: ReactNode; state?; onRetry? }
ContextBar   { items: { label: string; value: string }[]; asOf?: string; stale?: boolean; unit?: string }   // scope · period · closing date · unit · freshness
PeriodProgress { title: string; percent: number | null; sent: number; total: number; dueLabel?: string; tone?: Tone; state? }
StatusPill   { tone: Tone; children: ReactNode; icon?: ReactNode }       // always text; the icon is optional
SectionCard  { title: string; unit?: string; status?: ReactNode; actions?: ReactNode; children: ReactNode }
ReadonlyStat { label: string; value: string; sub?: string; tone?: Tone }
FilterPanel  { children: ReactNode; unitLabel?: string; updatedAt?: string; actions?: ReactNode; applied?: number }   // collapses under 980 px with a count of applied filters
DataTable<T> { columns: { key: string; header: string; group?: string; align?: 'left' | 'right'; pinned?: boolean; render: (row: T) => ReactNode }[]; rows: T[]; rowKey: (row: T) => string;
               totals?: Record<string, ReactNode>; totalsLabel?: string; severity?: (row: T) => Severity | null;
               page?: { from: number; to: number; total: number; size: number; index: number; onPage: (index: number) => void; onSize: (size: number) => void };
               state?; emptyKind?: 'none' | 'filtered' | 'noPeriod'; onClearFilters?: () => void; caption: string }
FundMatrix   { groups: { title: string; total?: string; cells: { label: string; control: ReactNode }[]; programme?: { title: string; cells: { label: string; control: ReactNode }[] } | 'na' }[] }   // stacks per source at ≤ 360 px
StickyActions { primary: ReactNode; secondary?: ReactNode[]; overflow?: ReactNode[] }   // at ≤ 360 px only `primary` stays, the rest go in an overflow menu
AuditLine    { items: { label: string; value: string }[] }
MakerCheckerBadge { maker: string; checker?: string | null }
ConfirmDialog { open: boolean; title: string; context: { label: string; value: string }[]; confirmLabel: string; cancelLabel: string; onConfirm: () => void; onCancel: () => void; pending?: boolean; reason?: { label: string; required?: boolean } }
FlowChart    { series: { label: string; style: 'actual' | 'plan'; points: { x: string; y: number }[] }[]; unit: string; caption: string }   // SVG, plan dashed, data table fallback

// ui/alerts (the alert centre, see design.md)
SeverityBadge     { severity: Severity; label: string }                  // icon + text + colour
DeadlineCountdown { dueOn: string | null; today: string; daysLate?: number }  // "Còn 2 ngày · 09/11", "Quá hạn 3 ngày", no seconds, aria-live off
EscalationTrail   { level: number; of: number; chain: string[]; nextAt: string | null }
AlertActions      { item: AlertItem; can: { claim: boolean; assign: boolean; snooze: boolean }; onClaim: () => void; onAssign: () => void; onSnooze: () => void }
AlertBand         { items: AlertItem[]; counts: AlertCounts; max?: number; state?; unavailable?: string[]; onRetry?: () => void }   // the band on HOME-01
AlertBell         { }                                                    // the shell button: own hook (counts, 60 s refresh), opens AlertCenter
AlertCenter       { open: boolean; onClose: () => void }                  // the drawer: severity filter, list, actions, "Xem tất cả" → HOME-02
useAlertCounts(view) · useAlertItems(view) · useAlertAction()            // react-query over getMyWorkCounts / getMyWork / claimWork, assignWork, snoozeWork
```

`AlertItem` and `AlertCounts` are the API shapes in design.md (snake_case as the API returns them), typed in `ui/alerts/types.ts`.
