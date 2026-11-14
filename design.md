# Design — MACHVON (Hệ Thống Quản Lý Dự Án Đầu Tư Công)

The locked design system of the web app (`apps/web`) and the phone app (`apps/mobile`). Every screen reads this file before it is designed or restyled. Do not invent per-screen colours, fonts or patterns: extend this file first (CR in `Design/MACHVON_Design/01_Documents/06_UI_UX_Design_System.md`).
Decision trail: D-B11 (binding mockups and tokens), CR-06-13 (palette moves from Ruby / Porcelain to **Xanh dầu điều hành**), plan `harmonic-foraging-pond` (design review 1A–7d, eng review D1–D4).

/* Hallmark · genre: modern-minimal · macrostructure family: app (workbench) · theme: custom "Xanh dầu điều hành" · designed-as-app */

## Genre and mode
- Genre: modern-minimal, mode **OPERATE** (a person finishes a task; scanability beats expression).
- App pages MUST NOT use decorative enrichment. The dark command block (`CommandHero`) is the one visual anchor of the leader home.
- Reading order of every management screen: **scope line → what needs action now → the numbers → causes → trends**.

## Tokens (source: `Design/MACHVON_Design/04_Design_Assets/design_tokens.json`, generated to `packages/design-tokens/dist-css/tokens.css` as `--mv-color-*` and to `packages/mobile-tokens/lib/machvon_theme.generated.dart`)

| Role | Token | Value |
|---|---|---|
| Sidebar / app bar | `sidebar` · `menuText` · `menuMuted` | `#102E3B` · `#FFFFFF` · `#C4D5DC` |
| Workspace card, command block | `workspaceCard` | `#1C3B48` |
| Selected item | `selected` · `selectedBar` | `#1C4A52` · `#2FB5A8` |
| Primary action | `primary` · `primaryHover` · `primarySoft` | `#007D77` · `#00635E` · `#EDF7F5` |
| Table head | `tableHead` · `tableHeadGroup` | `#173D48` · `#102E3B` (text white) |
| Surfaces | `background` · `surface` · `surface2` | `#F3F6F5` · `#FFFFFF` · `#F4F7F6` |
| Text / lines | `ink` · `textSecondary` · `border` | `#122D3B` · `#5B6E77` · `#DDE6E7` |
| Focus | `focus` (light) · `focusOnDark` | `#007D77` · `#7FE0D6` (never animated; ≥ 3:1) |
| Plan line in charts | `chartPlan` | `#7A8F99`, dashed, always labelled |
| Semantic | `success` `warning` `danger` `info` `neutral` + `*Soft` | `#2E7D4F` `#9A5B00` `#A63838` `#2F6690` `#4F616A` |
| Fund sources | `fundYear` `fundCarryOver` `fundOther` `fundIncrease` `fundProgramme` | `#007D77` `#E0AA52` `#B26B6B` `#4C9BC9` `#6D4BA3` |

Rules: every colour is a token (no hex in a screen); amber (`warning`) is for warnings only; no state is shown by colour alone (always text or icon); the 12 tenant colours of SAS-04 may override `primary`, `menu`, `menuText`, `selected`, `selectedText`, `headerBg/Text`, `footerBg/Text`, `background`, `titleColor`: derived tokens (`selectedBar`, `tableHead`, focus) must be derived from them and pass the contrast check.

## Typography
- **Be Vietnam Pro** (OFL), bundled, never loaded from a CDN; fallbacks Segoe UI, Arial. Numbers use `font-variant-numeric: tabular-nums`.
- Body 14 (phone 16); secondary 12; section label 12 uppercase, letter-spacing .06em; page title 28; KPI number 26–28; command number 56 (web) / 32 (phone).
- No italic headings. No type below 12.

## Shape and density
- Radius: card 14, control 8, pill 999. Thin 1px borders (`border`), very soft shadow only on overlays.
- Table rows 44–56 px by `min-height` (never a fixed height: text must survive 200%), header sticky.
- Spacing scale 4 8 12 16 20 24 32 48.

## Header (3 layers only)
Breadcrumb · page title (+ one context line) · scope bar (`ContextBar`). No uppercase module eyebrow.

## Shell (web)
- Left sidebar 252 px (236 compact), `#102E3B`: product name, workspace card (tenant, plan, licence), destinations with `aria-current`, count badges per module, pinned items, account chip at the foot.
- Top bar white 54 px: breadcrumb, **search "Tìm nhanh hồ sơ"** (opens IAM-07 / ⌘K), **alert bell "Cần xử lý"**, avatar.
- Below 980 px the sidebar is a drawer (Escape closes and returns focus). No horizontally scrolling chip rows.
- Footer of the tenant uses `footerBg/footerText`.

## Alert centre ("Cần xử lý ngay") — one source, many views
Source: `GET /home/my-work` (`getMyWork`) and `GET /home/my-work/counts` (`getMyWorkCounts`), query `view=mine|scope` (`scope` only for roles that read the whole scope). Commands: `claimWork`, `assignWork`, `snoozeWork` (`POST /home/work-actions/{claim|assign|snooze}`; `Idempotency-Key` required; body `WorkActionTarget`).

Each item adds to the existing fields (`id, kind, title, subtitle, status, due_on, original_due_on, bucket, overdue, days_late, target`):

| Field | Meaning |
|---|---|
| `severity` | `URGENT` (Khẩn) · `ACTION` (Cần xử lý) · `WATCH` (Theo dõi) |
| `source` | the module source (`APPROVAL`, `EXPLANATION`, `REPORT`, `EARLY_WARNING`, `ADVANCE`, `PERMIT`, `AUDIT_RECOMMENDATION`, `ISSUE`, `SITE_DIARY`, `GUARANTEE`, …) |
| `lifecycle` | `NEW` · `CLAIMED` · `IN_PROGRESS` · `RESOLVED` (read ≠ handled) |
| `claimed_by` / `assignee` | `{id, name, at}` / `{id, name, due_on}` or `null` |
| `escalation` | `{level, of, next_at, chain[]}` or `null` |
| `consequence` | one sentence: what happens if it is not done |
| `snoozed_until` | ISO time or `null` (URGENT items cannot be snoozed; the server refuses) |

Top level adds `unavailable_sources: string[]` (a failed source is named, never shown as "no work"). `counts` response: `{ view, counts: { urgent, action, watch, total }, unavailable_sources, as_of }`.

Severity defaults (data, configurable): PMT expired → URGENT, ≤ 30 days → WATCH; PAY advance overdue → ACTION; AUD recommendation overdue and escalated → URGENT; ISS SLA breach level 3 → URGENT, level 1–2 → ACTION; QMS missing diary → WATCH; HOME-03 red → URGENT, amber → ACTION.

Surfaces: web bell + drawer (`AlertCenter`), HOME-01 band (`AlertBand`), HOME-02 queue, menu counts, row stripe in tables, record banner; phone: card at the top of MOB-07 (`AlertCard`/`AlertList`), tab badge, MOB-32, push deep links. Bell counts refresh every 60 s, on window focus, and on a new notification; the full list loads only when the drawer opens.
Rules: countdown shows the remaining time and the absolute day ("Còn 2 ngày · 09/11"), no seconds, screen readers are not re-announced; no sound, no blinking; acknowledgements are audited (ADM-11).

## Components (web, `apps/web/src/ui/`, one file each + test; CSS in `ui.css`, tokens only)
`CommandHero` · `ContextBar` · `KpiTile` / `KpiStrip` · `PeriodProgress` · `FlowChart` (SVG: actual solid, plan dashed `chartPlan`, data table fallback) · `FilterPanel` · `UnitChip` · `StatusPill` (5 semantic colours + label) · `DataTable` (two-tier head, `TotalsRow`, `TablePager`) · `SectionCard` · `ReadonlyStat` · `FundMatrix` · `StickyActions` · `AuditLine` · `MakerCheckerBadge` · `ConfirmDialog` · `Tabs` (a long record page is split into tabs of one purpose each, the chosen tab kept in the address) · alerts in `apps/web/src/ui/alerts/`: `AlertCenter` · `AlertBand` · `SeverityBadge` · `DeadlineCountdown` · `EscalationTrail` · `AlertActions`.
Phone (`apps/mobile/lib/core/widgets/` and `features/read_support/widgets.dart`): `CommandHero` · `KpiTile` · `SectionCard` (uppercase title + ĐVT chip) · `StatusPill` (icon + label) · `ContextBar` (FreshnessBar) · `AlertCard` · `AlertList`.

## States (every new component, web and Flutter)
Loading (grey skeleton, **never a 0**) · empty (3 kinds: no work / filter found nothing / no data for this period, each with its action) · error (name the failing source, retry in place) · partial · stale ("Số liệu cũ", with the last good time) · denied (say the scope is hidden, leak no names) · offline (phone: read-only with last sync time) · submitting (lock, no double send) · success (receipt: code, time, recipient, next step) · period locked (read-only with reason) · version conflict (compare and choose).

## Responsive and accessibility
- ≥ 1280 full; 980–1279 compact sidebar; < 980 drawer, filters collapse with a count of applied conditions, KPI strip loses columns, table keeps the project column pinned and scrolls inside its own region (the page never scrolls sideways); ≤ 360 FundMatrix stacks per source, sticky action bar keeps **Gửi** and moves Lưu/Quay lại to an overflow menu with safe area and keyboard handled.
- WCAG 2.2 AA: text 4.5:1, controls 3:1, focus ring ≥ 3:1 (`focusOnDark` on dark), targets ≥ 24 px web / 44 pt · 48 dp phone, `aria-current` on the selected destination, big numbers read with unit and scope, text scaling to 200% (Flutter `textScaler` 2.0) without clipping, drag has a non-drag alternative.
- Review screenshots are taken at 1440, 1280, 375 and 360 px.

## What every page must share
Tokens above · Be Vietnam Pro · the 3-layer header · `ContextBar` on every number · `StatusPill` for every state · the primary action is a solid teal button, secondary is outlined ("↓ Xuất", "Xuất Excel" outlined with icon) · unit chip "ĐVT: …" on money blocks · audit line on records.

## What pages may differ on
Layout inside the app workbench family (list, record workspace, form, dashboard, ledger) and which components they compose. Never colours, fonts, radius or the header.

## Product name
Displayed name (web shell, tab title, phone app label, guide text and voice): **Hệ thống quản lý đầu tư công**; English: **Public Investment Management System**.
MACHVON is the internal code name only (package, file and directory names, ids, env vars, tokens, URLs, `Huong-dan-su-dung-MACHVON.html`, `docs/hdsd/machvon`); it is never shown to a customer or read aloud.
In guide narration the first mention of a chapter uses the full name, later mentions say "hệ thống".
The public edition's names, in one place per edition: the `brand` of its manifest (`packages/kernel/src/edition.ts`; the enterprise edition has its own in `packages/edition-enterprise/src/manifest.ts`): product name (**Hệ thống quản lý đầu tư công** / Public Investment Management System), launcher name under the phone icon (**Đầu tư công** / Public Investment), short name of the web install (Đầu tư công), the label of the logo and the tagline. Nothing else types them: the phone files are generated by `node scripts/edition-brand.mjs --write`, and `npm run edition:check` fails when a public surface says the code name as a name or a generated name drifts from the manifest. The enterprise edition keeps its own identity (Phần mềm quản lý đầu tư xây dựng, Mạch Vốn).
