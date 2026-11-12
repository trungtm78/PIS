import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The source of the installed application that the browser runs: every file under src/pwa that is not a test. */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|css)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** What a gesture needs: a touch, pointer, drag or wheel listener, or a swipe or pinch library. */
const GESTURE = /\b(onTouch\w*|onPointer(?:Down|Move|Up|Cancel)|onDrag\w*|onWheel|touchstart|touchmove|touchend|pointerdown|pointermove|swipe\w*|pinch\w*|hammer|use-gesture|touch-action\s*:\s*(?:pan|pinch|none))/i;

describe('PWA A11Y the manager application needs no gesture', () => {
  it('PWA A11Y no file of the application listens for a touch, drag, wheel, swipe or pinch, so every action is a button or a link that the keyboard and a switch reach as well', () => {
    const files = sources(join(__dirname));
    expect(files.length).toBeGreaterThan(20);
    const found = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ file, line: index + 1, text: line }))
        .filter(({ text }) => GESTURE.test(text))
        .map(({ file: path, line, text }) => `${path}:${line}: ${text.trim()}`),
    );
    expect(found).toEqual([]);
  });

  it('negative control: the gesture pattern recognises a swipe handler and a touch listener', () => {
    expect(GESTURE.test('<div onTouchStart={start} />')).toBe(true);
    expect(GESTURE.test("card.addEventListener('touchmove', move)")).toBe(true);
    expect(GESTURE.test('<button onClick={open} />')).toBe(false);
  });
});
