// The pure side of the recorder: how long a step lasts, where its voice begins, and the timeline file the assembly reads.
// The shape of the timeline is the one of the user guide (scripts/hdsd/mux.mjs): { flow, timeline: [{ id, heading, screens, startMs, endMs, voiceMs, shot }] }.

/** The voice starts a moment after the step does, so that the viewer sees the screen before hearing about it. */
export const VOICE_DELAY_MS = 400;
/** A pause after the voice has finished, before the next step. */
export const TAIL_MS = 700;
/** What a step lasts at least when no voice paces it. */
export const MIN_STEP_MS = 1500;
export const FPS = 30;

/** A delay made longer for slow motion (`slowMo` 1 is real time, 2 is twice as slow); always a whole number of milliseconds. */
export function scaleMs(ms, slowMo = 1) {
  if (!(slowMo >= 1)) throw new Error(`slowMo must be 1 or more, got ${slowMo}`);
  return Math.round(ms * slowMo);
}

/**
 * When a step has to end: after its voice (which begins VOICE_DELAY_MS into the step) and the tail, and never sooner than `minMs`.
 * `budgetMs` is the length of the voice of the step, 0 or undefined when the step has none.
 */
export function stepSchedule({ startMs, budgetMs = 0, minMs = MIN_STEP_MS, voiceDelayMs = VOICE_DELAY_MS, tailMs = TAIL_MS }) {
  const voiceMs = startMs + voiceDelayMs;
  const afterVoice = budgetMs > 0 ? voiceMs + budgetMs + tailMs : 0;
  return { voiceMs, wantedEndMs: Math.max(startMs + minMs, afterVoice) };
}

/** How long to wait now so that the step ends no sooner than it wants; never negative. */
export const waitUntil = (wantedEndMs, nowMs) => Math.max(0, wantedEndMs - nowMs);

export function makeEntry({ id, heading = '', screens = [], startMs, endMs, voiceMs, shot = null, error = null }) {
  const entry = { id, heading, screens, startMs, endMs, voiceMs, shot };
  return error === null ? entry : { ...entry, error };
}

/** What is wrong with a timeline (an empty list when it can be used): ids once each, steps in order, no overlap, voice inside its step. */
export function timelineProblems(entries) {
  const found = [];
  const seen = new Set();
  let previousEnd = 0;
  for (const entry of entries) {
    if (seen.has(entry.id)) found.push(`the step ${entry.id} is twice`);
    seen.add(entry.id);
    if (!(entry.endMs > entry.startMs)) found.push(`the step ${entry.id} ends (${entry.endMs}) before it starts (${entry.startMs})`);
    if (entry.startMs < previousEnd) found.push(`the step ${entry.id} starts at ${entry.startMs} before the step before it ends at ${previousEnd}`);
    if (entry.voiceMs < entry.startMs || entry.voiceMs > entry.endMs) found.push(`the voice of ${entry.id} is outside the step`);
    previousEnd = Math.max(previousEnd, entry.endMs);
  }
  return found;
}

/** The same timeline moved by `offsetMs` (the assembly puts a title card in front of a recording). */
export const shiftTimeline = (entries, offsetMs) => entries.map((entry) => ({ ...entry, startMs: entry.startMs + offsetMs, endMs: entry.endMs + offsetMs, voiceMs: entry.voiceMs + offsetMs }));

export const totalMs = (entries) => entries.reduce((last, entry) => Math.max(last, entry.endMs), 0);

/** The file the assembly reads. */
export function timelineDocument({ sceneId, platform, slowMo = 1, entries, video = 'video.mp4' }) {
  const problems = timelineProblems(entries);
  if (problems.length > 0) throw new Error(`the timeline of ${sceneId} is not valid: ${problems.join('; ')}`);
  return { flow: sceneId, platform, slowMo, fps: FPS, video, durationMs: totalMs(entries), timeline: entries };
}

/** The frame a moment of the recording falls in, at the constant frame rate the recording is converted to. */
export const frameOfMs = (ms, fps = FPS) => Math.floor((ms * fps) / 1000);

/** The ffmpeg arguments that make a constant-frame-rate H.264 file of 1920x1080 from the webm Playwright writes (its frame rate varies). */
export function constantRateArgs({ input, output, fps = FPS, crf = 17 }) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-vf', `fps=${fps},scale=1920:1080:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-r', String(fps),
    '-an', '-movflags', '+faststart', output,
  ];
}
