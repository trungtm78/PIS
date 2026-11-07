<!-- Hallmark · component: process-tree + timeline · genre: modern-minimal (OPERATE) · theme: Xanh dầu điều hành (design.md)
     states: default · hover · focus · active/selected · disabled · loading · error · empty · partial · stale
     pre-emit critique: P5 H5 E4 S5 R5 V4 · contrast: tokens already pass (design.md) -->

# "Cây tiến độ" (ProcessTree) and day-by-day Timeline: design spec

Written for: the PRC-1 lane (and any later lane that reuses the components for projects, contracts, payments, audit recommendations). Source of truth for colours, type and shape is `design.md`; components follow `apps/web/src/ui/CONTRACT.md`. Component scope: macrostructure, nav and footer picks are skipped; the host page is a workbench list/dashboard page (header: breadcrumb · title + one context line · ContextBar).

Inferences (owner delegated decisions): audience = leaders and procurement officers who must see, in five seconds, where every package is and what is stuck; use = answer "how many are where, what is late, show me the story of this one"; tone = utilitarian, calm, numbers first. No decorative enrichment: the tree itself is the visual anchor.

## 1. What the manager must get at a glance (order of reading)
1. Scope line (ContextBar: phạm vi · kỳ · ngày chốt · ĐVT · độ mới).
2. The funnel: how many packages sit in each state, as one connected picture.
3. What is wrong: late, stalled, on hold, returned: always as text + icon, never colour alone.
4. Click: the story of one node, then of one package, day by day.

## 2. View switcher (top of the board)
Segmented control (`role="tablist"`): **Cây tiến độ** (default) · **Bảng cột theo bước** (kanban) · **Danh sách**. Same filters apply to all three (FilterPanel: đơn vị, dự án, hình thức, người phụ trách, chỉ gói trễ, kỳ). A KpiStrip sits above: Tổng gói · Đang xử lý · Trễ hạn · Đứng yên > N ngày · Giá trị (tỷ đồng) · Trung vị ngày/bước. KpiTile loading = skeleton, never 0.

## 3. ProcessTree: layout
- **≥ 1280 px (flow view):** left-to-right flow, columns = depth. Each column is 232 px wide with 48 px gutters carrying the edges. The tree may branch: a **branch lane header** (SectionCard-style label, uppercase 12 px, e.g. "ĐẤU THẦU RỘNG RÃI · 14 gói") groups the nodes of one selection method. Terminal nodes (Đã ký hợp đồng, Đã hủy/Không thành) sit in the last column; Hold and Returned paths are drawn below the main row. The canvas scrolls inside its own region (`role="region"` + label, `tabindex=0`); the page never scrolls sideways. Pan with scroll, no drag-to-pan requirement (drag has no non-drag alternative otherwise).
- **980–1279 px:** same flow, column width 200 px, drill-down becomes a drawer.
- **< 980 px and phone/PWA:** the **outline view**: an indented list, one row per node (see §8). The flow canvas is not rendered.

## 4. Node anatomy (card, radius 14, 1 px `--mv-color-border`, surface `--mv-color-surface`)
```
┌──────────────────────────────────────────┐
│ ▎ Đánh giá hồ sơ dự thầu          ⚠ 2 trễ │  ← title 14/600 ink; late badge (icon + text)
│ ▎ 10 gói            ĐVT: tỷ đồng 128,40   │  ← count 28/700 tabular-nums; value 14 secondary
│ ▎ ▓▓▓▓▓▓▓░░░░░░  38% tổng                 │  ← share bar (4 px, primary), % text
│ ▎ ⏱ trung vị 6 ngày · lâu nhất 19 ngày    │  ← 12 secondary
└──────────────────────────────────────────┘
```
- Left stripe 4 px by health, always paired with an icon + word: **ổn** (success), **cần chú ý** (warning, icon ⚠), **trễ** (danger, icon ⛔), **tạm dừng** (neutral, icon ⏸). Health comes from the share of late packages (thresholds are rule data `PROCUREMENT_WORKFLOW`, shown in the help text), not from the colour.
- Number format: count as integer; value with `font-variant-numeric: tabular-nums`; zero count shows "0 gói" in secondary text and the card is `disabled`-styled (not clickable) but remains in the structure.
- **Selected:** 2 px `--mv-color-primary` border, `--mv-color-primary-soft` fill, stripe `--mv-color-selected-bar`.
- **Hover:** border `--mv-color-primary`; **focus-visible:** 2 px `--mv-color-focus` ring offset 2 (never animated); **active:** no transform, fill `--mv-color-surface2`.
- **Loading:** grey skeleton card keeping the size; counts never 0. **Error:** card replaced by an inline "Không tải được trạng thái này · Thử lại". **Stale:** the board's ContextBar shows "Số liệu cũ" chip; nodes keep their values.
- Min target height 72 px; the whole card is one button (`aria-pressed` when selected).

## 5. Edges and flow
- Orthogonal connectors (SVG `path`, 90° with 8 px radius), drawn behind the cards, `aria-hidden`.
- **Width encodes flow volume:** 2 px (1 package) to 10 px (max in the view), colour `--mv-color-chart-plan`-family neutral; the **edge label** (12 px, on a surface-coloured pill so it never sits on a line) states the count and, on hover/focus of either node, the period: "8 gói chuyển trong kỳ".
- **Return / rejected paths** are dashed and labelled "trả lại 2"; **cancelled/drop-out** paths end in a muted terminal node "Hủy / không thành 1" with dotted edge. Dashing + label carry the meaning (not colour).
- Edge labels are also present in the accessible outline (§9); the SVG adds nothing the text does not say.
- Highlight: hovering or selecting a node raises the opacity of its incoming/outgoing edges and dims the rest to 40 %.

## 6. Drill-down
- **Click a node** → side panel (≥ 1280: 420 px sticky right column; 980–1279: drawer; phone: full-screen sheet with a back button). Panel header: node title + count + value + health word. Tabs: **Tổng quan** · **Gói thầu** · **Biến động**.
  - *Tổng quan:* median/longest/shortest days in node, late/stalled/on-hold counts, the checklist items most often unfinished in this step (top 3), who holds the most packages (top 3), a 12-week mini bar of arrivals vs departures.
  - *Gói thầu:* DataTable (columns: mã + tên gói + StatusPill hình thức, dự án, giá gói (ĐVT), ngày ở bước (số + mini timeline sparkline of days in previous steps), người giữ, hạn bước với đếm ngược "Còn 2 ngày · 09/11" / "Quá hạn 3 ngày"); severity stripe for late rows; pager; "Xuất Excel".
  - *Biến động:* the node feed: recent transitions in/out (Timeline component, §7), filter by day range.
- **Click a package row** → the **package page** (full page, breadcrumb back to the tree with the node preselected): header (mã, tên, dự án, giá gói, hình thức, người phụ trách, AuditLine), the **Stepper** (§7.1), blockers banner, tabs **Tiến trình** (timeline) · **Danh mục kiểm** · **Tài liệu** · **Liên quan** (muasamcong, kiến nghị, hợp đồng).

## 7. Package Stepper and day-by-day Timeline
### 7.1 Stepper (top of the package page)
Horizontal at ≥ 980 px (steps wrap into two rows rather than scroll), vertical below. Each step: circle 24 px with number/icon, name, and under it the **planned vs actual days** ("chuẩn 5 · thực 8"). States (icon + text + stripe): **Xong** (check, success), **Đang ở đây** (filled primary ring, the only element with `--mv-color-primary` fill), **Sắp tới** (outline), **Bỏ qua** (skipped, strikethrough label + reason in tooltip text), **Tạm dừng** (pause icon, neutral), **Trễ** (⛔ + "trễ 4 ngày"). Below the stepper: one line "Đang ở **Đánh giá hồ sơ** · 12 ngày · trễ 4 ngày so với chuẩn · người giữ: Nguyễn Văn An" and, if blocked, a callout "Đang chặn: thiếu biên bản mở thầu (mục bắt buộc)" with the action button.

### 7.2 Day strip (above the timeline)
A compact calendar strip, one cell per day (week rows on desktop, horizontal scroll inside its region on phone) from the package start to today; cell fill: **có thay đổi** (primary-soft + dot), **ngày làm việc không đổi** (empty), **cuối tuần/lễ** (surface2 hatch), **hạn bước** (flag icon), **hôm nay** (outline + label). Plan-vs-actual bars per step sit under the strip (actual solid, plan dashed `--mv-color-chart-plan`, overrun portion with a hatch + "+4 ngày" label). Data-table fallback: "Xem dạng bảng". Selecting a day scrolls/filters the timeline to that day.

### 7.3 Timeline (day groups)
- Newest day first (toggle "Cũ nhất trước"). **Sticky day header**: "Thứ Ba, 05/11/2026 · 3 thay đổi" (14/600) with a hairline rule.
- **Entry** (a list item, 56 px min): `HH:mm` (tabular) · kind icon in a 28 px circle · **"Chuyển từ [StatusPill: Mời thầu] → [StatusPill: Mở thầu]"** (or "Hoàn thành mục: Biên bản mở thầu", "Tạm dừng", "Trả lại", "Nhắc việc", "Nhập từ muasamcong") · actor chip (initials + name) · "sau 6 ngày 2 giờ ở bước trước" (secondary) · optional **reason/note** (expandable, 2-line clamp) · evidence chips (tài liệu, link) · system events are labelled "Hệ thống".
- **Gap rows:** consecutive days with no change collapse into one muted row "12 ngày không có thay đổi · đang chờ [bước]"; this is the wait the manager cares about; it is clickable to expand into the empty days.
- **Late/clock events** (reminder sent, step overdue, escalated) use the alert severity badge (icon + word) with the consequence sentence.
- Timeline is append-only and read-only; corrections appear as new entries ("Sửa: …") never edits.
- Filters: khoảng ngày, người, chỉ đổi trạng thái / tất cả; summary strip: "12 ngày ở bước 3 · trễ 4 ngày · 7 thay đổi trong 30 ngày"; "Xuất Excel".
- The same `Timeline` component (props: `groups: {date, entries[]}[]`, `onSelectEntry`, `gaps: boolean`) is generic for contracts, projects, payments later.

## 8. Outline view (small screens, PWA, phone) and accessibility equivalent
Indented `ul` with `role="tree"` semantics: each row = chevron (expand/collapse, 44 px target) + title + count (right-aligned, tabular) + health icon-word + 4 px share bar underneath; depth shown by 16 px indents with a 1 px guide line. Tap a row → sheet (§6). Expand state is remembered per user in `sessionStorage` (UI state only). Phone native (Flutter) mirrors it as an `ExpansionTile` list with the same strings; the day strip becomes a vertical timeline only.
PWA dashboard card: top 5 nodes by count as a vertical funnel (count + health word), "Xem cây tiến độ" link.

## 9. Accessibility
- The accessible source of truth is the **outline** (always rendered for assistive tech in flow view as visually-hidden `role="tree"` equivalent, or the flow cards themselves expose `aria-label`s: "Đánh giá hồ sơ dự thầu, 10 gói thầu, giá trị 128,40 tỷ đồng, 2 trễ hạn, chọn để xem chi tiết"). Edges: `aria-hidden`; edge counts are repeated in the node panel as text ("Đã chuyển từ Mời thầu: 8 gói").
- Keyboard: Tab to the board, arrow keys move between nodes (Right = to child, Left = to parent, Up/Down = sibling), Enter/Space opens the panel, Escape closes it and returns focus to the node, Home/End jump to first/last; roving tabindex; focus ring ≥ 3:1 (`--mv-color-focus`, `focus-on-dark` on dark).
- Targets ≥ 44 px on touch; text ≥ 12 px; contrast from tokens (text 4.5:1, borders/controls 3:1); 200 % text scale: nodes grow in height (min-height only, never fixed), no clipping.
- No colour-only meaning: every tone has icon + word; dashed vs solid for edge meaning; hatch + text for overrun.
- Live updates (60 s refresh) do not move focus and are not announced; a polite status line "Cập nhật lúc 07:05" changes only on user refresh.
- Screen-reader reading order: summary → filters → tree → panel.

## 10. Motion (cut before adding)
- Only: 120 ms border/fill transition on hover/selection, 180 ms panel slide (transform) and 160 ms expand/collapse (grid-rows trick), edge opacity 120 ms. No count-up, no pulsing, no continuous animation. `prefers-reduced-motion: reduce` removes the slide and expansion animation (instant). Easing: the three named easings only.

## 11. States matrix (every state present in the component and its tests)
| State | Tree | Panel/Package/Timeline |
|---|---|---|
| Loading | skeleton nodes in the right columns, KPI skeleton, never "0" | skeleton rows/day groups |
| Empty (no packages yet) | "Chưa có gói thầu nào trong phạm vi · Thêm gói thầu" (action) | "Chưa có thay đổi nào" |
| Empty (filter) | "Không có gói nào khớp bộ lọc · Xóa bộ lọc" | same |
| Error | board-level callout with the failing source named + Thử lại; nodes keep last values with "Số liệu cũ" | inline retry in the panel |
| Partial | banner "Chưa đọc được: <nguồn>. Có thể thiếu gói." | entries that failed are omitted with the same banner |
| Stale | ContextBar chip "Số liệu cũ · cập nhật <giờ>" | same |
| Denied | "Một số phạm vi bị ẩn" line; hidden nodes show only the aggregate count, no names | package row not rendered; no names leak |
| Offline (phone/PWA) | read-only last data with "Đồng bộ lúc …" | cached timeline of already-opened packages |
| Submitting (hold/resume, assign) | button locks, no double send | optimistic entry labelled "đang ghi" until confirmed |
| Success | receipt line "Đã chuyển sang <bước> lúc <giờ>" with Hoàn tác 5 s where allowed | new entry appears at the top |

## 12. Tokens used (no hex)
`--mv-color-ink · text-secondary · border · surface · surface2 · primary · primary-soft · primary-hover · selected-bar · success(-soft) · warning(-soft) · danger(-soft) · info · neutral(-soft) · chart-plan · focus · focus-on-dark · table-head`; `--mv-space-4…32`; `--mv-radius-card (14) · control (8) · pill`; type: Be Vietnam Pro 14 body, 12 secondary and uppercase section labels with .06em tracking, count 28/700, `tabular-nums`; no italic. CSS classes `ui-process-tree*`, `ui-timeline*`, `ui-stepper*` in `apps/web/src/ui/ui.css` (tokens only; the lint for hex must stay clean).

## 13. Component contracts
```ts
ProcessTree { nodes: { id; label; count: number | null; value?: string; unit?: string; share?: number | null;
                       health?: 'ok'|'attention'|'late'|'hold'|'none'; medianDays?: number | null; lateCount?: number; heldCount?: number;
                       parentId?: string | null; lane?: string; terminal?: boolean }[];
              edges: { from; to; count: number; kind: 'forward'|'return'|'drop' }[];
              selectedId?; onSelect(id); state?; onRetry?; view?: 'flow'|'outline'; caption: string; emptyKind? }
Timeline    { groups: { date: string; entries: { id; at: string; kind: 'transition'|'checklist'|'hold'|'return'|'clock'|'import'|'note';
                       from?: string; to?: string; actor?: { name; initials }; after?: string; note?: string; evidence?: {label; href}[]; tone? }[] }[];
              gaps?: boolean; order?: 'desc'|'asc'; state?; onRetry?; caption: string }
Stepper     { steps: { code; label; status: 'done'|'current'|'upcoming'|'skipped'|'hold'|'late'; plannedDays?; actualDays?; note? }[] }
DayStrip    { from: string; to: string; changes: string[]; deadlines: string[]; today: string; onSelectDay(date) }
```
All strings are passed in already translated; strings the components own use keys `ui.processTree.*`, `ui.timeline.*`, `ui.stepper.*`.

## 14. Test and review checklist (for the lane)
vitest per component for every state of §11; axe (no serious violations) for flow and outline; keyboard test (arrows, Enter, Escape returns focus); layout tests at 1440/980/360 widths; a snapshot of the data-table fallback; a test that no 0 is shown while loading; reduced-motion test; Playwright spec for the drill-down journey (tree → node panel → package → timeline); `design-review` pass on screenshots at 1440, 1280, 375, 360 once the stack can run.
