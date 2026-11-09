# Product intro clips: pipeline and scripts

Two clips, each a main video of 8 to 12 minutes plus chapter cuts that stand alone. 16:9, 1920x1080, 30 fps, Vietnamese voice, light music, burned-in subtitles plus `.srt` and `.vtt`, Be Vietnam Pro and the "Xanh dau dieu hanh" palette (`design.md`, `packages/design-tokens`).

| Clip id | Product name shown and read | Edition | Chapters (cuts) |
|---|---|---|---|
| `public-investment` | Hệ thống quản lý đầu tư công | public | leader-home, disbursement, contracts, analytics, alerts, contractors, egp (muasamcong), province-committee, process-tree, phone |
| `enterprise-phu-my` | Phần mềm quản lý đầu tư xây dựng (Đạm Phú Mỹ, PVFCCo) | enterprise | leader-home, capital, projects, reports-pvn, workflow, hpm-ebs, directives, docs-ai, analytics, alerts, contractors, process-tree, phone |

`intro` and `close` are parts of the main video only (`standalone: false`). The internal code name is never shown or read (check enforced). The six PVFCCo forms are DEMO forms: every scene that shows them is stamped "MẪU DEMO — chờ mẫu chính thức" (caption and narration). Everything built on a working assumption (e-GP file layouts, the file writer standing in for HPM, the accounting file layout, legal deadlines) carries its stamp on screen and in the narration (`clip-spec.json` `stamps`, rule R18 of the plan).

Source files here are English only; the Vietnamese text lives in JSON and markdown data files. The clips are in Vietnamese only (owner decision): narration, subtitles and on-screen text, no English track.

## Production layer (scripts, shot checklist, music, data readiness)

`production/` holds the data that turns the scenarios into a shooting plan, and `node scripts/clip-scripts-check.mjs` checks all of it (it runs in `npm run qa:check`):

| File | What it holds |
|---|---|
| `production/rules.json` | Limits and scope: words per sentence for the voice, caption length, removed labels, English stop words, secret patterns, required chapters and platforms, stamps that some screens always need, chapter budgets. |
| `production/texts.json` | Vietnamese words of the shot checklist and of the shooting script (the code only fills the placeholders). |
| `production/shots.json` | Curated extras of the checklist by scene id. The rest of the checklist is derived from the scene: screens with their routes, pointer targets, captions, stamps, and each figure with the operation it is read from. |
| `production/music.json` | CC0 tracks (pending owner approval) and the cue sheet of each clip. |
| `production/readiness.json` | Which groups of the clip seed (`docs/clip-data.md`) make the data of each chapter and what is proven; chapters at risk are listed. |

```
node scripts/clip-scripts-check.mjs check [clip] [--strict] [--strict-data]   screen ids and routes, durations, English-only sentences, sentence length for the voice, phonetic table, secrets, subtitle lines, music cues, data groups, up-to-date shooting scripts
node scripts/clip-scripts-check.mjs book [clip] --write                      writes docs/clips/<clip>.script.md (narration, respelled voice text, subtitles, steps, checklist, music)
node scripts/clip-scripts-check.mjs report                                   warnings only
```

`--strict` fails on a screen that has a route but no module in this build yet; `--strict-data` fails on a chapter whose data groups are not all run and verified. Run both before the recording starts.

## The flow

```
scenarios/*.json ──check──▶ plan of what to record
       │                       (screens, real operations, steps, figures, stamps)
       ▼
seed layer (apps/web/e2e/hdsd/seed): the groups of docs/clip-data.md, `scripts/clip-seed.mjs`
       │  real commands on a real stack ──▶ data-manifest.json  (the figures)
       ▼
tts.mjs  (narration text = respelled + numbers as words, cached by sha256)  ──▶ <clip>.audio.json (+ WAV files)
       ▼
recorder specs (Playwright web, emulator phone, animatics from CLIP-2) paced to the voice durations ──▶ screen video
       ▼
subtitles.mjs  ──▶ timeline.json, .srt, .vtt        mix.mjs  ──▶ final.mp4 (+ sidecars + .clip.json)
       ▼
verify.mjs  (1920x1080, 30 fps, duration range, loudness, subtitles)
```

## Commands (from the repository root)

```
node scripts/clips/scenario.mjs check [clip] [--strict]   validate the scenarios (catalogue, contract, refs, phonetics, figures, stamps, durations)
node scripts/clips/scenario.mjs stamp [clip]              write expectedSec from the narration (run after every text change)
node scripts/clips/scenario.mjs report [clip]             length, words and what is still planned, per cut
node scripts/clips/tts.mjs <clip> [main|chapter] --manifest data-manifest.json --out <clip>.audio.json [--dry-run]
node scripts/clips/subtitles.mjs <clip> [main|chapter] --audio <clip>.audio.json --manifest data-manifest.json --out <dir>
node scripts/clips/mix.mjs --video screen.mp4 --timeline <dir>/<clip>.main.timeline.json --audio <clip>.audio.json [--music file] --out final.mp4
node scripts/clips/verify.mjs final.mp4 [--kind main|chapter]
node --test scripts/clips/*.test.mjs
```

`check` without `--strict` accepts what other lanes still have to build (listed in `planned.json` with the lane). **`check --strict` must pass before the recording starts**: it turns every planned screen, operation or figure source that is still missing into an error.

## Files

| File | What it is |
|---|---|
| `scenarios/<clip>.json` | The ordered scenes. `scenes[]` holds scenes and `{ "include": "shared/x.json" }` entries; a shared chapter file (`clip-chapter/1`) holds a chapter, its scenes, the figures, literal numbers and typed texts it needs, so the footage and the words are the same in both clips. |
| `scenarios/shared/*.json` | Chapters used by both clips: leader-home, analytics, alerts, contractors, process-tree, phone. |
| `clip-spec.json` | The one source of the format (1920x1080, 30 fps), the duration ranges, the narration pace used for estimates, subtitle line rules, loudness targets, the stamps, the forbidden words, the personas. |
| `phonetics.json` | Respelling of foreign words and abbreviations (dashboard, AI, PWA, ERP, HPM, EBS, SoD, EVM, KPI, BI, API, SSO, MFA, OCR, e-GP, muasamcong, PVN, PVFCCo, ...). Applied only to the text sent to TTS, never to subtitles or captions. The check fails when a narration contains a word the voice would read wrongly and the table does not cover it. |
| `numerals.json` | Vietnamese number words for the voice (numbers and figures are spoken as words; subtitles keep digits). |
| `voices.json` | The non-secret contract of both TTS services, the seven voices of the appendix with their codes and recommended speeds, the chosen voice and why. |
| `refs.json` | Symbolic UI references used by step lists. The recorder spec binds each to a locator. |
| `planned.json` | Screens and operations that other lanes still build, with the lane and a note. |
| `music.md` | Three proposed CC0 tracks for the owner to approve. |
| `common.mjs numbers.mjs figures.mjs phonetics.mjs text.mjs` | Pure helpers (tested). |
| `scenario.mjs subtitles.mjs tts.mjs mix.mjs verify.mjs` | The tools. |

## A scene

```
{ "id": "egp-import", "chapter": "egp", "main": true, "mainFor": ["public"],
  "narration": "... {{figure:egp-rows-valid}} dòng hợp lệ ...",
  "screen": { "platform": "web|phone|pwa|animatic|title", "screens": ["BID-24"], "animatic": "id (animatic and title scenes)" },
  "steps": [ { "do": "open", "screen": "BID-24" }, ... ],
  "expectedSec": 17.5,
  "captions": [ { "text": "...", "atSec": 3, "forSec": 5 } ],
  "stamps": ["egp-assumption"] }
```

- `main` puts the scene in the main video; `mainFor` limits that to one edition. A chapter cut is every scene of the chapter, main or not, in order.
- `screens` are catalogue ids (`Design/MACHVON_Design/03_Engineering/screen_catalog.json`), or `PWA-0n` / `planned:<name>` entries of `planned.json`. A phone scene names phone screens and a web scene web screens (checked).
- `expectedSec` is stamped from the narration (voice estimate plus lead-in and tail); at record time the measured audio replaces it.
- Numbers: a digit sequence in a narration or caption must be listed in the scenario's `literalNumbers` (a structural count of the product, such as "19 reports"). Every other figure is a placeholder `{{figure:id}}` declared in `figures` with its kind, an authoring-time `sample` (used only to estimate durations) and its `source` (an operation of the contract and a path in its answer). At record time the figures are read from the seeded data into `data-manifest.json` (`{ "figures": { "<id>": { "value": 62.4 } } }`); a figure with no value stops the run, and no value is ever invented.
- Stamps: a scene with a stamp needs the stamp caption exactly and a narration that says it (`clip-spec.json`).

### Step verbs

A later recorder implements each verb once (Playwright for `web` and `pwa`, the emulator driver for `phone`), reusing `apps/web/e2e/hdsd/recorder.ts` (`Ui.point`, `click`, `type`, `spot`, `scrollThrough`) and the persona users of the stack (`?devUser=`).

| Verb | Fields | Meaning |
|---|---|---|
| `as` | `persona` | Switch the signed-in user (a persona of `clip-spec.json`). |
| `open` | `screen` | Open a web or PWA screen as the current persona. |
| `choose` | `ref`, `option` | Pick an option of a select or a list (`first` or a data key). |
| `point` | `ref` | Move the pointer to a target without clicking. |
| `click` | `ref` | Point, pause, click. |
| `type` | `ref`, `textKey` | Type a text of the scenario `typed` table (Vietnamese text lives there). |
| `spot` | `ref` | Frame a part of the screen while the voice speaks about it. |
| `scroll` | `through` | Scroll the main region slowly for the length of the voice (`voice`) or a number of ms. |
| `wait` | `for` or `ms` | Hold for the voice, or for ms. |
| `expect` | `ref` | Assert a state is visible (fails the recording rather than filming a wrong screen). |
| `command` | `operation`, `as` | Run a real operation of the contract through the seed layer (an `operationId` of `openapi.json`, or a planned one). |
| `upload` | `operation`, `fixture` | Send a fixture file (declared in the scenario `data.fixtures`) to an upload operation. |
| `phone-open` | `screen` | Open a phone screen in the emulator. |
| `phone-tap` | `ref` | Tap a target on the phone. |
| `phone-scroll` | `through` | Scroll on the phone for the length of the voice. |
| `animatic` | `id` | Show an animatic made by CLIP-2 (declared in `animatics`). |
| `still` | `id` | Show a reconstructed picture (the approval confirmation sheet that the operating system refuses to record). |

## Voice

`tts.mjs` calls VieNeuTTS (`POST /v1/tts/generate`, the voice `vieneu-north-female` with its codes and speed 1.1, temperature 0.6, `stream` false). NghiTTS (`POST /api/v1/synthesize`) is used only with `--engine nghi` or after a failure of VieNeuTTS when `--fallback nghi` was given; that use is logged and written in the metadata of the audio.

- Keys are read only from the environment: `VIENEU_TTS_API_KEY` and `NGHI_TTS_API_KEY`. Base URLs: `VIENEU_TTS_BASE_URL`, `NGHI_TTS_BASE_URL` (the documented URLs are the defaults). A missing variable stops the run with a message naming it; a rejected key (403) is final; nothing switches service silently. Never write a key into a file, a command line, a log or a commit.
- Cache: `<CLIPS_CACHE or D:/tmp/clips-cache/audio>/<sha256(voice, speed, text)>.wav` plus a small `.json` (engine, duration, fallback). The text is the respelled narration with figures and numbers as words, so a changed figure or phonetic entry is a new key. Retries (5xx, 429, no answer) back off; 4xx never retries.
- `--dry-run` prints the exact text that would be sent for every scene and whether it is cached; it needs no key and makes no call. `--sample` uses the nominal figure samples (a trial only).
- Chosen voice and reason: `voices.json` (`defaultVoice`, `defaultReason`). No audition was possible without keys; audition the three candidates of `auditionCandidates` once they exist.

## Subtitles and mix

- Subtitles are cut from the displayed narration (digits, original words), at most 2 lines of 42 characters, 1.0 to 6.5 s per cue, about 17 characters per second, spread over the measured voice; the burned-in style is Be Vietnam Pro 11 on the 288-line ASS grid (about 41 px at 1080p), white on the dark `workspaceCard` token (`mix.mjs subtitleStyle`).
- `mix.mjs` needs ffmpeg 7 or later (`-/filter_complex file`; the one of `scripts/hdsd/tts.mjs` is 9.0.2 with libass, sidechaincompress and loudnorm; `HDSD_FFMPEG` overrides the path). It places each scene voice at its time, loops the music under it with ducking, fades it, measures the loudness in a first pass and normalises to minus 16 LUFS (true peak at most minus 1.5) in the second, burns the subtitles with the Be Vietnam Pro TTF files of `apps/mobile/assets/fonts`, and also writes a soft Vietnamese subtitle track, the `.srt`, the `.vtt` and a `.clip.json` record. A smoke run on generated tones and a colour video gave minus 16.1 LUFS and a correct frame (Vietnamese diacritics in Be Vietnam Pro on the box).
- `verify.mjs` uses ffprobe when it exists (`CLIPS_FFPROBE`, beside ffmpeg, or the PATH); this machine has none, so it reads the report of ffmpeg and measures with `ebur128`. It checks 1920x1080, 30 fps, the duration range of a main video (480-720 s) or a chapter cut (45-720 s), an audio stream, loudness within 1.5 LU of minus 16 and a true peak under minus 1, the sidecar subtitles, the line rules and the record of burned-in subtitles.
- Music: any file path, or the proposed track of `production/music.json` (see the REC5 section). `music.md` proposes CC0 tracks for approval.

## Production tooling of round REC5 (step replay, composition, quality, music, voice)

Command line options (all optional, every default keeps the pipeline working):

| Tool | Option | What it does |
|---|---|---|
| `make.mjs` | `--no-steps` | Do not replay the click steps; open the screens, point and scroll as in round 1. Default: the steps of each scene (`click`, `choose`, `type`, `point`, `spot`, `scroll`, `wait`) are replayed on the real screens. |
| `make.mjs` | `--no-compose` | Plain footage with burned captions (round 1 look). Default: the composition layer (see below). |
| `make.mjs` | `--phone-dir <dir>` | Folder with `<scene id>.mp4` (or `.webm`) films of the phone from the emulator (`record/phone.mjs`); a phone scene and the `split` and `phone-right` layouts put them in the phone frame. Without a file the phone shows the real web app at phone size (the report says `responsive-web-preview`). |
| `make.mjs` | `--no-quality` | Skip the quality check of the joined screen film. |
| `quality.mjs` | `<film> [--timeline t.json] [--report make.json] [--max-freeze 7] [--min-black 0.8]` | Still windows (freezedetect), black windows (blackdetect), page problems seen by the recorder (spinner left on screen, error banner, blank page) and steps that could not be replayed; the findings go into `quality` of `<clip>.<cut>.make.json`. |
| `mix.mjs` | `--bar <clip>.<cut>.bar.txt` | Lays the dark rounded subtitle bar (key term in the accent colour) over the film; `make.mjs` writes the list and `record-clip.sh` passes it. The soft subtitle track and the .srt/.vtt stay. |
| `mix.mjs` | `--music <file>` / `--no-music` / `--clip <id>` | Without `--music` the proposed track of the clip in `production/music.json` (`track-0`, `file`) is used when the file is on disk; `--no-music` turns it off. The music is first brought to `musicTargetLufs` (-22 LUFS, measured with ebur128), then ducked by the sidechain compressor under the voice, looped and faded in and out. |
| `tts-edge.mjs` | `--voice`, `--rate`, `--pitch` | Fallback voice. Defaults per voice in `edge-voices.json` (HoaiMy rate -3%, NamMinh rate -4% pitch -2Hz); every sentence is spoken alone and joined with a 320 ms pause; each scene is normalised to -18 LUFS. The comparison of the two voices and the decision are in the same file. `CLIPS_EDGE_VOICE`, `CLIPS_EDGE_RATE`, `CLIPS_EDGE_PITCH` override. The VieNeuTTS command of the round-1 README is unchanged. |

Step replay (`record/replay.mjs`, `record/bindings.json`): a step names its place by a symbolic ref; `bindings.json` finds it on the screen by an exact line for the ref, by the last word of the ref (Vietnamese button names) or by the kind of place (table, chart, cards, first row). A step that cannot be done is skipped with a warning and a reason; the film is always made. The pointer glides on an eased, slightly curved path, a click leaves a ripple, a `spot` zooms the part a little and dims the rest, each view gets time in proportion to its steps, and `make.json` lists for every scene which steps were replayed or skipped. Add a line to `bindings.json` `refs` when a screen needs an exact binding.

Composition (`compose/`): `layout` of a scene is `full-web`, `web+callouts` (default for web), `phone-right` (default for phone), `split` (web and phone side by side) or `title`; the geometry is `compose/layouts.json`. Each scene is the animated background loop (12 s, rings and particles, drawn once into `compose/bg.mp4`), the footage in a browser or phone frame with a slow zoom and fades, a left headline (`headline` of the scene, else its first sentence), the chapter ticker, the logo of `D:/PIS-clips-out/brand/brand.json` (`CLIPS_BRAND_DIR`), callout chips at the figures the recorder framed, and `callouts` of the scene (`{ text, anchor: "phone"|"web", x, y, atSec, forSec }`, used by the PWA scene). The title card is the hero still of the brand; other cards are drawn on the background. `showcase` (`screens`, `persona`, `phone`) lets an animatic scene show the real product (the intro scene with the web and the phone side by side).

## What is still needed at record time

1. **The real data.** Apply the dataset named in each scenario `data.dataset` with `node scripts/clip-seed.mjs apply` (see `docs/clip-data.md`; `production/readiness.json` says which groups are proven and which chapters are at risk), with real commands only. Then write the data manifest by reading each figure `source` (`operation` and `select`) from the running stack. The planned screens and operations of `planned.json` must exist (`check --strict`).
2. **Recorder specs.** One Playwright spec per clip that runs the step lists with the `Clip`/`Ui` classes of `apps/web/e2e/hdsd/recorder.ts`, binds `refs.json` to locators, paces each scene to its measured voice (`<clip>.audio.json`), and films at 1920x1080 (the guide recorder films 1280x720). Phone scenes run in the emulator; the approval confirmation sheet uses the reconstructed picture.
3. **Animatics (CLIP-2).** The ids in each scenario `animatics` (titles, problem, platform map, service flow, obligations, no-egress proof, outro). Rendered at 1080p30 with the design tokens and Be Vietnam Pro.
4. **Keys.** `VIENEU_TTS_API_KEY` (and `NGHI_TTS_API_KEY` only if the fallback is wanted) in the environment of the machine that runs `tts.mjs`.
5. **The music decision** of the owner (`music.md`).
6. **Manual review** of every film, and the checks of the plan: ffprobe-style facts through `verify.mjs`, the stamps visible, no customer figure in the enterprise clip.

## Decisions taken here

- One voice for all chapters of both clips: the northern female voice at speed 1.1.
- Narration pace for estimates: 3.0 syllables per second at speed 1 (measured on the cached guide audio of edge-tts, 2.96), so 3.3 at speed 1.1. The estimate only gates the authoring (main 480-720 s with the authored scenes at 590 s and 619 s); the measured audio decides at record time and `verify.mjs` is the last check.
- The two clips share the scenes of analytics, alerts, contractors, the progress tree, the phone and the leader overview, so the footage and the words are recorded once per tenant data set.
- Chapters of the muasamcong management exist only as a chapter cut of the public clip (8 points in the main video); the enterprise clip carries the link in the contractors chapter.

## Feature coverage chapters, waiting scenes and planned seed groups (lane CLIPFEATURES)

Both clips carry, besides the first chapters, one chapter cut for every feature family of the product (contractor controls and portal, claims and early warnings, alert escalation, delegation, audit and red flags, forecasts and risk, documents and AI, correspondence, integration, field work, procurement desk, contract delivery, project life, period reports and close, platform, phone and PWA, and for the public clip also capital control, payments, monitoring reports and the public portal; for the enterprise clip the ENT-3 and ENT-4 cycle). The main video points to all of them with one animatic scene (`tour-more`) and stays at 8 to 12 minutes: a chapter file marked `"mainOptional": true` needs no scene in the main video.

- `requires`: a scene may list lanes (`"requires": ["ENT-3a"]`). `planned.json` `lanes` holds each lane as `pending` or `merged`. While a lane is pending the scene is accepted by `scenario.mjs check` (also with `--strict`), reported as waiting by `clip-scripts-check.mjs report`, and left out by `make.mjs`, `tts.mjs`, `tts-edge.mjs` and `subtitles.mjs` (pass `--include-pending` to force it). Flip the lane to `merged` when it is on main; the scene is then recorded and checked as any other. Screens that a pending lane adds have no catalogue row: they are `planned:<name>` entries of `planned.json` `screens` (lane, title); bind the real screen id at merge.
- `production/readiness.json` `plannedGroups`: seed groups that the chapters need and that do not exist yet (`NOT_DONE`, with what each must create). The recording agents write them in `scripts/clip-seed-lib.mjs` (`DATASET_PHASES`), then move the entry from `plannedGroups` to `groups` with its proof state (the check refuses a planned group that already exists).
- New persona `contractorUser` (a guest contractor member of the portal chapter): add it to `apps/web/e2e/support/docs-people.json`.
