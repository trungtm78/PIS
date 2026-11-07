/** The semantic tones of the component kit (design.md: five semantic colours plus the primary one). */
export type Tone = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
/** The severities of the alert centre and of a table row stripe. */
export type Severity = 'URGENT' | 'ACTION' | 'WATCH';
/** The states of a component that holds data; `loading` never shows a number. */
export type UiState = 'ready' | 'loading' | 'error' | 'empty';

/** The class that sets the tone variables (`--ui-tone`, `--ui-tone-soft`) of a component. */
export const toneClass = (tone: Tone | undefined): string => `ui-tone-${tone ?? 'default'}`;
