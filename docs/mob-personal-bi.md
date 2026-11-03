# MOB: the personal BI dashboard and the search on the phone (ST-MOB-027)

Two screens of the Flutter application read what the web already shows: the personal BI dashboard with its drill (MOB-40, web BI-01/02/09) and the search across what the reader may see (MOB-51, web IAM-07). The code is in `apps/mobile/lib/features/personal_bi` and `apps/mobile/lib/features/phone_search`. The phone calls the same operations as the web, the server decides the figures and the scope, and nothing is computed on the phone: the figures a person reads are the exact text the server gave.

## MOB-40: the dashboard

`/home/mob-40` lists the dashboards of the reader (`listDashboards`: theirs first, then those shared with them or published to the tenant, with the version and whether every metric is still certified). `/home/mob-40?dashboard=<id>` opens one; `&snapshot=<id>` opens it over the snapshot that was named, which is how a link to a figure can keep the snapshot it came from (no screen builds such a link yet; the web board does the same with `?snapshot=`). A dashboard without a version cannot be opened; one whose metrics are no longer certified says so at the top.

### One snapshot for the whole screen (AC-ST-MOB-027-1, UAT-AC34)

Every tile is asked of **one snapshot**, so the figures of the screen are all of one moment: the one named in the address; else the first pinned version when the dashboard pins its data; else the newest frozen version of the period-snapshot dataset (`listBiDatasets` then `listBiDatasetVersions`, read next to the dashboard in the same round of requests). A tile asks `post_dashboard_queries` with the metric version, the snapshot and, for a tile cut by a dimension, that dimension.

Each answer carries what BR-BI-04 says every number carries, and the tile shows it: the period and the snapshot (first eight characters), the quality badge of the data, whether it came from the cache and when it was built, whose scope it is, the rows the quarantine left out, whether the groups add up to the total. A figure that is missing says why (no data, not applicable, outside your scope, not reported yet) and is never 0 or a bar of zero. A ratio is written as a percentage with two decimals rounded half up on the exact decimal and shows its numerator and denominator.

When a newer snapshot of the period was frozen after the one that is open, the answers say `new_data_available`: the screen **keeps showing the snapshot that is open**, says "Có dữ liệu mới hơn" with the ids of both, and offers "Làm mới dữ liệu". Only that choice (a command, so online) sends `refreshBiQueryContext` with the token of the tile; the answer names the newer snapshot, every tile is read again over it, and the banner goes. The old drill token goes on answering for the snapshot it was made on until it expires (30 minutes); a drill that finds it expired says so with `SNAPSHOT_EXPIRED` and offers the renewal in place.

### The drill (AC-ST-MOB-027-1)

Each group of a tile that has a token has "Đi sâu": the person chooses a dimension that the path has not used (unit, funding source, project, budget level, plan bucket) and the screen asks `explainBiMetric` with the token and the dimension. Every step shows a check against the cell that was tapped: **the total of the drill equals the value of the cell, from the same snapshot** (exact decimal comparison, `100` equals `100.00`; for a ratio the numerator and denominator too). A difference is shown with both figures, a drill from another snapshot says it cannot be compared, a cell or total with no figure says so. A breadcrumb names the path and "Quay lại" goes up one step.

### Performance (AC-ST-MOB-027-3, UAT-NFR-PERFORMANCE-02)

Each tile reads for itself and all start together: the first content is on the screen as soon as the first answer is there and a slow tile never holds up the others (tested with one answer held back). The loading state is a still skeleton. A heavy question that the server turns into a job (`202 ASYNC_JOB`) is waited for by looking at its run every 3 seconds for a minute, then asked again; one that is still running after the minute says so and can be asked again. The 2.5 seconds p95 on the target device is measured on a device (see below).

### Charts

No chart library: the tiles draw with the framework. A single figure is a number; a bar and a pie are proportion bars under each group (the pie does not compute shares: it is the same bars); a line and an area are a sketch through the groups that have a figure; a table is rows. Every mark is decorative and skipped by a screen reader: the exact figure is the text beside it, so the chart is never the only carrier of a number. A tile lists eight groups and offers the rest.

### Offline (BR-MOB-01)

The definition of the dashboard and each tile are kept as copies in the read cache (in memory until the persistent store of ST-MOB-007 plugs in) under the tenant and the person. When the server cannot be reached a tile shows its last answer with "Bản lưu trên máy, số liệu kỳ {period}, tính lúc {time}", that it is reference data, and that it is out of date past 12 hours; a drill and a renewal need the server and are not offered on a copy. What the server refuses (401, 403) drops the copy of that tile.

## MOB-51: search

`/account/mob-51` (and `?q=<keyword>`, which a link keeps and searches at once). The keyword is 2 to 200 characters counted as characters, not code units, checked before anything is sent. `searchGlobal` answers from a projection filtered by tenant and by the scope of the caller **before ranking**, so the phone filters nothing and adds nothing, and **shows no total of any kind** (a count would show how much exists outside the scope). Up to four pages of 50 are read; a list longer than that says there is more without saying how many. A hit shows what its classification lets it show (a personal record has no name: "Hồ sơ cá nhân, mở để xem chi tiết"; above INTERNAL there is no extract); chips narrow the list to one kind of record.

A hit opens the screen of its record: a project opens MOB-10, a conversation MOB-36; any other kind is named and says it cannot be opened on the phone yet. The screen it opens asks the server again, so **a record outside the scope of the reader opened by its id is `404 RESOURCE_NOT_FOUND`** and shows the code and nothing of the record (AC-ST-MOB-027-2, UAT-PLAN-41; the server half, that the response and the log carry no field of the other record, is a server test).

**Recent items.** The keywords searched for lately (ten at most, newest first, the same keyword in another case once) are listed while the field is empty, tap to search again, with "Xóa lịch sử tìm kiếm". They are kept in the encrypted store of the person in that tenant (`meta` key `recent_searches.v1`), so they go with the store on sign-out and tenant switch, and only keywords are kept: never a hit, a title, a name or an id. The results themselves are not kept on the device (`keepCopy: false`): a lost connection is the offline state.

## Entry points

The phone had no door to these screens, so three small additive changes were made in files of earlier stories: a button in the bar of the notification inbox (MOB-32 to MOB-35), a row on the leader's home (MOB-07 to MOB-40) and a row in the account (MOB-47 to MOB-51). `DataView` gained `keepCopy` (default true) in `read_support`.

## Gaps

- **Period filter of MOB-51.** The screen catalogue lists "Kỳ" among the fields of the search; `searchGlobal` has no period parameter and a hit carries no period, so the phone offers the keyword and the kind only.
- **Pinned data of several datasets.** A pinned dashboard is read over its first pinned version for every tile; the only dataset today is the period snapshot. A dashboard over several datasets needs the dataset of each metric.
- **The persistent copy store** (ST-MOB-007): copies are in memory until it plugs in.
- **Refresh by pull** and **a share link**: not in the story.

## Tests

`apps/mobile/test/features/personal_bi` (`query_models_test.dart`: figures, rounding, drill check, parsing; `bi_query_service_test.dart`: query, job, drill, renewal with a lost answer, refusals; `dashboard_screen_test.dart`: AC-ST-MOB-027-1..4, every state at the three sizes and 200 percent text; labels and charts), `apps/mobile/test/features/phone_search` (`search_test.dart`: AC-ST-MOB-027-2, keyword rules, kinds, recent items, states; `entry_points_test.dart`). Every rule above was broken once and the tests went red.

## What only a device can prove

The cold start of the dashboard within 2.5 seconds p95 on the target device class with the real network (the host tests show that the tiles ask together and that the first one does not wait for the others, not the time); that a tile drawn on a 360 dp screen at 200 percent text reads well and that the bars and the line are legible in sunlight; TalkBack and VoiceOver reading of the tiles, the banner and the drill check; the 12-hour copy and the offline reading across a restart (the copy is in memory); the recent keywords surviving a restart and being gone after a sign-out (the encrypted store is tested on the host with a key store in memory, not on the Keychain or Keystore).
