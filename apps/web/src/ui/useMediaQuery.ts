import { useEffect, useState } from 'react';

const supported = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

/** Whether a media query matches now and after it changes; false where `matchMedia` is not available. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => (supported() ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (!supported()) return undefined;
    const list = window.matchMedia(query);
    const update = (): void => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}
