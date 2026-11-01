import { useEffect, useRef, useState } from 'react';

/** The position the device gave, as the text the forms keep. */
export interface Fix {
  lat: string;
  lng: string;
  accuracy: string;
}

export type Locating = 'idle' | 'busy' | 'failed';

/**
 * Asks the device where it is, for a form that keeps the position only with the consent of the person. An answer is applied only if it still answers the latest request: taking the consent back, asking again, or leaving
 * the screen cancels the request in flight, so a position that arrives late is dropped and never brings back what the person took away. `apply` must merge the fix into the current state of the form, never write over it.
 */
export function useLocate(consent: boolean, apply: (fix: Fix) => void): { locating: Locating; locate(): void } {
  const [locating, setLocating] = useState<Locating>('idle');
  const request = useRef(0);

  useEffect(() => {
    if (consent) return;
    request.current += 1;
    setLocating('idle');
  }, [consent]);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );

  const locate = (): void => {
    const geolocation = globalThis.navigator?.geolocation;
    if (geolocation === undefined) {
      setLocating('failed');
      return;
    }
    request.current += 1;
    const mine = request.current;
    setLocating('busy');
    geolocation.getCurrentPosition(
      (position) => {
        if (mine !== request.current) return;
        apply({ lat: position.coords.latitude.toFixed(6), lng: position.coords.longitude.toFixed(6), accuracy: position.coords.accuracy.toFixed(2) });
        setLocating('idle');
      },
      () => {
        if (mine === request.current) setLocating('failed');
      },
    );
  };

  return { locating, locate };
}
