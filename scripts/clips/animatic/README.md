# Animatics and recorder of the product clips

Visual tooling for the two intro clips (plan "Dot 6"). Two parts, both under `scripts/clips/`:

- `animatic/` (this folder): title cards, chapter cards and the explainer diagrams, drawn with the tokens and the font of the product and rendered to 1920x1080, 30 fps video.
- `record/`: the recorder of the real screens (web in a browser, phone in the emulator) and the guard that refuses to record an empty tenant.

Code is English. The words of a clip live in JSON data files (`animatic/data/*.json`, `record/examples/*.json`). A test fails when a source file holds a Vietnamese letter.

## Animatics

### What exists

| kind | data file | what it shows |
|---|---|---|
| `title` | `title-public`, `title-enterprise`, `smoke-title` | title card: kicker, product name, a line that draws itself, subtitle, footer |
| `chapter` | `chapter-progress-tree` | chapter card: big number, title, summary, list of what the chapter shows |
| `platform` | `platform-public`, `platform-enterprise` | the diagram of the platform builds up: web, phone, PWA, API, modules, alert centre, BI, database with row-level security, e-GP connector by file (public) or HPM and EBS adapters (enterprise); external systems have a dashed frame |
| `service-flow` | `service-flow-public` | a payment file travels web, API, module, database, alert centre, push, phone; a packet moves along each link, the node it reaches lights up, one sentence per step |
| `progress-tree` | `progress-tree` | "Cay tien do": the tree of procurement states with package counts, a click on a node opens its packages, a click on a package opens the stepper, the day strip and the day-by-day timeline |
| `alert-ladder` | `alert-ladder` | the three severities (Khan, Can xu ly, Theo doi) with icon, word, example and consequence; the life cycle; the two clocks; the escalation chain |
| `governance-chain` | `governance-chain` | maker, checker, approver: a document travels and is stamped at each; the system refuses the same person twice; the audit line (ADM-11) |

The look is the real one: colours are `--mv-color-*` from `packages/design-tokens/dist-css/tokens.css`, the font is Be Vietnam Pro with the `@font-face` rules read from `apps/web/src/styles/app.css` (same woff2 files, same unicode ranges), and the progress tree reuses the structure and classes of `ProcessTree.tsx`, `Stepper.tsx`, `DayStrip.tsx`, `Timeline.tsx` and `docs/process-tree-design.md` (cards with a health stripe and an icon plus word, edges whose width is the volume, dashed return and drop paths, sticky day headers, "N days without change" rows).

Why plain modules and not React: the repo has no machinery to render React to video, and a scene must be a pure function of time. Each scene is `render(data, t) => html` (no DOM, no clock, no random), so the same time always gives the same frame and the scenes are unit-tested in Node.

### Render

```
node scripts/clips/animatic/render.mjs <scene id | path to a json> [--out file.mp4] [--fps 30] [--no-fade] [--max-seconds n]
node scripts/clips/animatic/render.mjs <scene> --still 4000 --out frame.png      one picture
node scripts/clips/animatic/render.mjs --probe file.mp4                          size, fps, codec, length
node scripts/clips/animatic/render.mjs --list | --check                          scenes in data/ | validate them all (no browser)
```

How it works (`render.mjs`, `lib.mjs`): a small local HTTP server serves the page (tokens, fonts, stage css, `runtime.mjs`) because module scripts and fonts do not load from `file:` URLs. Chromium (Playwright) opens it at 1920x1080 with `deviceScaleFactor` 1. For every frame the renderer calls `__animatic.render(t)` with `t = index * 1000 / fps` and takes a PNG screenshot; the PNGs are piped to ffmpeg (`FFMPEG` from `scripts/hdsd/tts.mjs`, `HDSD_FFMPEG` overrides it) which writes H.264 yuv420p, CRF 16, constant 30 fps. Every scene fades in and out over `fadeMs` (default 300); `--no-fade` or `"fadeMs": 0` turns it off when the assembly cross-fades itself. Default output folder is `D:/tmp/clips-out` (`CLIPS_OUT` overrides it), outside the repository.

Memory: the renderer refuses to start Chromium when less than 2.5 GB of RAM is free (`MIN_FREE_GB` in `lib.mjs`, the limit of the lane brief). Render one scene at a time.

### Scene data

Every scene file has `id`, `kind`, `theme` (`light` or `dark`), `durationMs`, optional `fadeMs`, `kicker`, `title`, and the fields of its kind (see `problems()` in `scenes/<kind>.mjs`; `node render.mjs --check` lists what is wrong). Times are milliseconds from the start of the scene. The most useful fields:

- diagrams (`platform`, `service-flow`): `nodes[{id, kind: client|service|store|adapter|external, icon, label, sub, x, y, w, h, at, edition}]`, `links[{from, to, label, dashed, mid, points, at}]` (orthogonal routes are computed; `mid` moves the elbow, `points` gives the route by hand), `captions[{from, to, text}]` for the lower third, `legend`. A `service-flow` adds `steps[{link, at, dur, packet, caption}]`; a link is named `<from>-<to>` unless it has an `id`. Nodes must lie inside 1920x1080 (checked).
- `progress-tree`: `nodes` (count, value, unit, share, health `ok|attention|late|hold`, lateCount, medianDays, col, row, terminal), `edges` (count, kind `forward|return|drop`, label), `phases {tree, select, package}` (when the tree builds, when the node is clicked, when the package is clicked), `select` (id of the node), `panel` (stats, rows, `open` = index of the row clicked), `package` (steps, strip, timeline rows; the timeline must fit 490 px, checked), `labels`, `health`. A node whose count could not be read has `"count": null` and shows `?`, never 0.
- `alert-ladder`, `governance-chain`: see the files in `data/`.

To make a new card for a clip, copy a data file, change the words, and render it by path. Product name in the public clip: "He thong quan ly dau tu cong"; enterprise clip: "Phan mem quan ly dau tu xay dung" (design.md, Product name).

### Tests

```
node --test scripts/clips/animatic/lib.test.mjs scripts/clips/animatic/scenes.test.mjs scripts/clips/record/record.test.mjs
```

They never start a browser: frame scheduling, ffmpeg arguments, static file safety, route geometry, determinism of every scene at many times, the phases of the progress tree, data validation, English-only sources. The root `npm test` does not pick up `scripts/**` sub-folders (same as `scripts/hdsd`), so run the line above by hand.

### Smoke render (done once for this lane)

`smoke-title` (3 s title card, 90 frames) was rendered, probed and deleted: `h264, 1920x1080, 30 fps, 3000 ms, yuv420p`. `ffprobe` is not installed on this machine, so `render.mjs --probe` reads the same facts from `ffmpeg -i`.

## Recorder (`scripts/clips/record/`)

```
node scripts/clips/record/cli.mjs <scene.json | scene.mjs> --web-url <web> --api-url <api> [--slow 1.5] [--audio audio.json] [--only a,b] [--out dir] [--serial adb-id] [--check-data] [--dry-run]
```

- Scene format (`scene.mjs`): `{ id, platform: web|phone, edition: public|enterprise, persona, steps: [{ id, heading, screens, minMs, actions: [...] }] }`. Actions: `goto, click, hover, type, press, select, scroll, spot, expect, wait`; targets are one word: `role:button:Save`, `label:Name`, `text:Total`, `testid:x`, `placeholder:x`, `css:main table`. A `.mjs` scene may use `run(ui, {budgetMs, slowMo})` functions instead of actions. A page opens as `persona` through the `devUser` parameter of the development session. See `examples/`.
- Pacing: with `--audio` (the index CLIP-1 writes: `{ "steps": { "<step id>": { "durationMs": n } } }`, same shape as the guide) a step lasts `400 ms + voice + 700 ms` and never less than its `minMs`; without it a step lasts its `minMs` (default 1500). `--slow 1.5` lengthens every pause, pointer travel (more steps) and key delay by that factor, minimums included.
- Output in `<out>/<scene id>/`: `video.webm` (Playwright), `video.mp4` (constant 30 fps 1920x1080, what the assembly reads), `timeline.json` (`{ flow, platform, slowMo, fps, video, durationMs, timeline: [{ id, heading, screens, startMs, endMs, voiceMs, shot }] }`, the guide's shape plus fields), `shots/<step>.png`. A failed step stops the run, writes `timeline.failed.json` with the error and exits non-zero; `--only` retakes single steps.
- The pointer is an arrow with a ring and a click ripple drawn inside the page (`cursor.mjs`), so it is in the recording; `spot` draws a frame around a part of the screen.
- Empty-data guard (`data-guard.mjs`, `requirements.json`): before any browser or emulator starts, one GET per key list of the edition (projects, contracts, contractors, payments, packages in the progress tree, alerts, BI dashboards; directives for enterprise) must show at least the minimum number of rows. A list that cannot be read counts as missing. Exit code 2 and the list of what is empty. The API is read with a token from `CLIPS_API_TOKEN` or signed from `E2E_SESSION_KEY` + `CLIPS_TENANT_ID` + `CLIPS_MEMBERSHIP_ID` (the format of `apps/web/e2e/support/api.ts`). There is no flag to skip it.
- Phone scenes (`phone.mjs`): `{ platform: "phone", phoneChapter: "<id in scripts/hdsd/mobile-chapters.json>" }`. The existing guide recorder (`scripts/hdsd/mobile-run.mjs`) films the chapter on the emulator `--serial`; its film and timeline are copied next to the web scenes. Side effect to know: the guide recorder also writes its own narration flow `scripts/hdsd/flows/<chapter>.json` and speaks it; the clip uses its own voice, so phone steps are paced by the guide's voice, not by `--audio`. The phone film keeps the phone's own size (portrait); the assembly places it in a frame.
- Stack: the web app and the API must already run with the seeded tenant of the clips (the guide's `E2E_SEED=docs` stack plus the data layer of the clips). The recorder does not start or seed anything.
- Memory: a browser starts only with 2.5 GB free; one browser at a time.

## Hooks for the assembly (CLIP-1)

- Cards and diagrams: `render.mjs <scene> --out x.mp4 [--no-fade]`, constant 30 fps, no audio. `durationMs` is in the data; `--probe` gives the length.
- Screens: `record/cli.mjs` per scene, then use `timeline.json` (`voiceMs` is where the voice of a step begins) with `video.mp4`.
- Captions on the animatics are the lower third (`captions` in the data) and are part of the picture; the `.srt`/burnt subtitles of the clip stay with the assembly.
