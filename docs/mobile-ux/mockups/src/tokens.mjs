// mobile.v2 tokens used by the mockups (proposal: they would live in a `mobile.v2` group of design_tokens.json, R31; the web tokens are not touched).
// Every colour and size used by a direction comes from here; the directions only compose them.
export const TOKENS_CSS = `
:root {
  /* surfaces and ink (the brand "Xanh dầu điều hành": same hues as today, one more step of grey) */
  --mv2-bg: #F3F6F5; --mv2-surface: #FFFFFF; --mv2-sunken: #EAF0EF;
  --mv2-ink: #122D3B; --mv2-ink-2: #4A5E68; --mv2-ink-3: #5B6E77;
  --mv2-line: #DDE6E7; --mv2-line-strong: #B9C8CC; --mv2-outline: #7A8F99;
  --mv2-header: #102E3B; --mv2-header-2: #1C3B48; --mv2-on-header: #FFFFFF; --mv2-on-header-2: #C4D5DC;
  --mv2-primary: #007D77; --mv2-primary-strong: #00635E; --mv2-primary-soft: #E3F3F1; --mv2-on-primary: #FFFFFF;
  --mv2-accent-on-dark: #2FB5A8; --mv2-focus: #007D77;
  /* the three deadline bands: text, soft fill, solid mark (rail, icon, border). Shape and words always travel with the colour. */
  --mv2-late-fg: #9C1C14; --mv2-late-bg: #FDECEA; --mv2-late-mark: #B3261E;
  --mv2-soon-fg: #7A4B00; --mv2-soon-bg: #FFF3D6; --mv2-soon-mark: #B26A00;
  --mv2-ok-fg: #14633A;   --mv2-ok-bg: #E4F4EA;   --mv2-ok-mark: #2E7D4F;
  --mv2-info-fg: #1F5680; --mv2-info-bg: #E6F0F8;
  /* spacing 4 8 12 16 24 32 */
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px;
  /* radius and elevation */
  --r-chip: 8px; --r-ctl: 12px; --r-card: 16px; --r-pill: 999px;
  --e0: none; --e1: 0 1px 2px rgba(16,46,59,.08), 0 1px 1px rgba(16,46,59,.04); --e2: 0 -8px 28px rgba(16,46,59,.18);
  /* type scale: size / line-height (Vietnamese marks need at least 1.35); two weights, 400 and 600 */
  --t-display: 600 32px/40px 'Be Vietnam Pro', sans-serif;
  --t-title: 600 22px/30px 'Be Vietnam Pro', sans-serif;
  --t-heading: 600 16px/24px 'Be Vietnam Pro', sans-serif;
  --t-body: 400 15px/22px 'Be Vietnam Pro', sans-serif;
  --t-label: 600 13px/20px 'Be Vietnam Pro', sans-serif;
  --t-caption: 400 12px/18px 'Be Vietnam Pro', sans-serif;
  --t-body-strong: 600 15px/22px 'Be Vietnam Pro', sans-serif;
  --t-caption-strong: 600 12px/16px 'Be Vietnam Pro', sans-serif;
  --ease: cubic-bezier(.2,.7,.2,1);
}
[data-theme="dark"] {
  --mv2-bg: #0B1A21; --mv2-surface: #112630; --mv2-sunken: #0E202A;
  --mv2-ink: #E6EEF1; --mv2-ink-2: #B3C4CB; --mv2-ink-3: #9DB1BA;
  --mv2-line: #24404C; --mv2-line-strong: #38596A; --mv2-outline: #6C8A99;
  --mv2-header: #0A2029; --mv2-header-2: #14313D; --mv2-on-header: #FFFFFF; --mv2-on-header-2: #B3C4CB;
  --mv2-primary: #4FD1C5; --mv2-primary-strong: #7FE0D6; --mv2-primary-soft: #123A3C; --mv2-on-primary: #04211F;
  --mv2-late-fg: #FFB4AB; --mv2-late-bg: #3D1714; --mv2-late-mark: #FF8A7D;
  --mv2-soon-fg: #FFD58A; --mv2-soon-bg: #3B2A07; --mv2-soon-mark: #F2B84B;
  --mv2-ok-fg: #8FE0B0;   --mv2-ok-bg: #0F3321;   --mv2-ok-mark: #57C285;
  --mv2-info-fg: #A8D1F0; --mv2-info-bg: #12303F;
  --e1: 0 0 0 1px rgba(255,255,255,.04); --e2: 0 -8px 28px rgba(0,0,0,.5);
}
`;

export const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{overflow-x:clip}
body{background:#DCE4E3;color:var(--mv2-ink);font:var(--t-body);-webkit-font-smoothing:antialiased}
.ic{flex:none;display:inline-block;vertical-align:middle}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.gallery{display:flex;gap:40px;padding:32px;width:max-content}
.cell{width:390px}
.cap{font:600 13px/20px 'Be Vietnam Pro',sans-serif;color:#33505C;margin:0 0 8px 4px;letter-spacing:.01em}
.screen{position:relative;width:390px;height:844px;overflow:hidden;background:var(--mv2-bg);border-radius:28px;border:1px solid #A9BCC0;display:flex;flex-direction:column}
.inset-top{height:24px;flex:none}
.inset-bottom{height:14px;flex:none}
.scroll{flex:1;min-height:0;overflow:hidden;position:relative}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.num{font-variant-numeric:tabular-nums}
.clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.clamp1{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;
