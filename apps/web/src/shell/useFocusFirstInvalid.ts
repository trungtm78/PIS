import { useEffect } from 'react';

/**
 * Sending a form that has a problem puts the focus on the first control the form marks `aria-invalid` (WCAG 3.3.1, 3.3.3): a person who cannot see the screen is told where the problem is, not left on the button they pressed.
 * The forms of the screens validate in their own handlers and show the errors with the `Field` family (`wireControl` marks the control and ties its error to it), so the move is made once the screen has drawn them. A form
 * without a problem is left alone, and so is a control that already has the focus.
 */
export function useFocusFirstInvalid(): void {
  useEffect(() => {
    const onSubmit = (event: Event): void => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      window.setTimeout(() => {
        const first = form.querySelector<HTMLElement>('[aria-invalid="true"]');
        if (first !== null && document.activeElement !== first) first.focus();
      }, 0);
    };
    document.addEventListener('submit', onSubmit);
    return () => document.removeEventListener('submit', onSubmit);
  }, []);
}
