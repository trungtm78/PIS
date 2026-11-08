// The pointer a viewer follows: an arrow with a ring that travels with the mouse and a ripple that spreads at a click.
// It is drawn in the page itself, so that it is in the recording (Playwright's video does not show the real pointer).
// The animatic renderer draws the same cue (scripts/clips/animatic/stage.css: .pointer, .ripple).

export const CURSOR_SCRIPT = `(() => {
  if (window.__clipsCursor) return;
  window.__clipsCursor = true;
  const install = () => {
    const style = document.createElement('style');
    style.textContent = [
      '#clips-pointer{position:fixed;z-index:2147483647;left:0;top:0;width:34px;height:34px;margin:-2px 0 0 -2px;pointer-events:none;',
      'background:url("data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 32 32\\'%3E%3Cpath d=\\'M3 2v22l6-5.5 4 9.5 4-1.8-4-9.2h8.5z\\' fill=\\'%23122D3B\\' stroke=\\'%23fff\\' stroke-width=\\'2\\' stroke-linejoin=\\'round\\'/%3E%3C/svg%3E") no-repeat;}',
      '#clips-pointer.down{transform:scale(.88)}',
      '.clips-ripple{position:fixed;z-index:2147483646;width:70px;height:70px;margin:-35px 0 0 -35px;border-radius:50%;pointer-events:none;',
      'border:5px solid var(--mv-color-primary-hover,#00635E);background:rgba(0,125,119,.18);animation:clips-ripple .7s ease-out forwards}',
      '@keyframes clips-ripple{from{transform:scale(.4);opacity:1}to{transform:scale(2);opacity:0}}',
      '.clips-spot{position:fixed;z-index:2147483645;pointer-events:none;border:4px solid var(--mv-color-selected-bar,#2FB5A8);border-radius:12px;box-shadow:0 0 0 8px rgba(47,181,168,.25)}',
    ].join('');
    document.head.appendChild(style);
    const pointer = document.createElement('div');
    pointer.id = 'clips-pointer';
    document.body.appendChild(pointer);
    window.addEventListener('mousemove', (event) => { pointer.style.left = event.clientX + 'px'; pointer.style.top = event.clientY + 'px'; }, true);
    window.addEventListener('mousedown', (event) => {
      pointer.classList.add('down');
      const ripple = document.createElement('div');
      ripple.className = 'clips-ripple';
      ripple.style.left = event.clientX + 'px';
      ripple.style.top = event.clientY + 'px';
      document.body.appendChild(ripple);
      window.setTimeout(() => ripple.remove(), 800);
    }, true);
    window.addEventListener('mouseup', () => pointer.classList.remove('down'), true);
  };
  if (document.body) install(); else window.addEventListener('DOMContentLoaded', install);
})();`;
