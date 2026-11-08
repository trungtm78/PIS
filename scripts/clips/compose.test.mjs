import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CLIPS_DIR } from './common.mjs';
import { LAYOUT_NAMES, backgroundHtml, barHtml, brandOf, cardHtml, chipHtml, frames, headlineOf, keyTerm, layoutOf, layouts, mapBox, overlayHtml, splitKey, tickerOf } from './compose/design.mjs';
import { cardArgs, chipsFor, segmentArgs } from './compose/plan.mjs';
import { loadScenario } from './scenario.mjs';
import { buildFilterGraph, buildMixArgs } from './mix.mjs';

const spec = layouts();

test('every layout keeps its frames inside the canvas and clear of the ticker; windows and phones have the shape of a screen', () => {
  for (const name of LAYOUT_NAMES) {
    const geometry = frames(name, spec);
    for (const part of [geometry.web, geometry.phone].filter(Boolean)) {
      const { outer, hole } = part;
      assert.ok(outer.x >= 0 && outer.y >= spec.tickerHeight - 10 && outer.x + outer.width <= 1920 && outer.y + outer.height <= 1080, `${name} outer`);
      assert.ok(hole.x > outer.x && hole.y > outer.y && hole.x + hole.width < outer.x + outer.width && hole.y + hole.height <= outer.y + outer.height, `${name} hole`);
    }
    if (geometry.web !== undefined) assert.ok(Math.abs(geometry.web.hole.width / geometry.web.hole.height - 16 / 9) < 0.01, `${name}: the browser screen is 16:9 so that no footage is cut`);
    if (geometry.phone !== undefined) assert.ok(geometry.phone.hole.height / geometry.phone.hole.width > 2, `${name}: a phone screen is tall`);
  }
  assert.throws(() => frames('nope', spec), /unknown layout/u);
  assert.ok(frames('split', spec).web && frames('split', spec).phone, 'split shows the web and the phone side by side');
});

test('a scene is laid out by its layout field, else by its platform; an unknown layout is an error', () => {
  assert.equal(layoutOf({ id: 'a', screen: { platform: 'web' } }), 'web+callouts');
  assert.equal(layoutOf({ id: 'a', screen: { platform: 'phone' } }), 'phone-right');
  assert.equal(layoutOf({ id: 'a', screen: { platform: 'title' } }), 'title');
  assert.equal(layoutOf({ id: 'a', screen: { platform: 'animatic' } }), null);
  assert.equal(layoutOf({ id: 'a', layout: 'split', screen: { platform: 'animatic' } }), 'split');
  assert.throws(() => layoutOf({ id: 'a', layout: 'diagonal', screen: {} }), /unknown layout/u);
});

test('the headline is the first sentence without figure placeholders, cut at a comma or a word; a headline field wins', () => {
  assert.equal(headlineOf({ id: 'a', headline: 'Một dòng', narration: 'x' }), 'Một dòng');
  assert.equal(headlineOf({ id: 'a', narration: 'Đã giải ngân {{figure:x}} trong năm. Câu hai.' }), 'Câu hai');
  const long = headlineOf({ id: 'a', narration: 'Bấm vào một con số để truy nguồn ba bước: chỉ tiêu, đơn vị hoặc dự án, hồ sơ gốc và nhiều điều khác nữa.' });
  assert.ok(long.length <= 64 && !long.endsWith(','));
  assert.ok(headlineOf({ id: 'a', narration: 'Một hai ba bốn năm sáu bảy tám chín mười mười một mười hai mười ba mười bốn mười lăm mười sáu mười bảy.' }).endsWith('…'));
});

test('the key term of a cue is its first number with the unit, else a capitalised term, else the longest word', () => {
  assert.deepEqual(splitKey('Đã giải ngân 1.234 tỷ đồng trong năm'), ['Đã giải ngân ', '1.234 tỷ đồng', ' trong năm']);
  assert.equal(keyTerm('Số liệu cập nhật đến Kho bạc Nhà nước hôm nay'), 'Kho');
  assert.equal(keyTerm('quản trị thông minh'), 'thông');
  assert.deepEqual(splitKey('a b'), ['a b', '', '']);
});

test('the pages are plain HTML with the font and no stray markup from the text', () => {
  const fonts = "@font-face{font-family:'Be Vietnam Pro'}";
  const bar = barHtml('Giải ngân <b>6%</b> & hơn', { fonts });
  assert.match(bar, /<em>6%/u);
  assert.doesNotMatch(bar, /<b>/u);
  assert.match(backgroundHtml(fonts), /__setT/u);
  const brand = brandOf('public', undefined, spec.productNames);
  const overlay = overlayHtml({ layout: 'split', headline: 'Một nền tảng', kicker: 'Giới thiệu', ticker: tickerOf([{ title: 'A', scenes: 1 }, { title: 'B', scenes: 2 }], undefined, 0, 1), brand: { ...brand, logo: 'D:/x/logo.svg' }, fonts });
  assert.match(overlay, /class="win"/u);
  assert.match(overlay, /class="phone"/u);
  assert.match(overlay, /file:\/\/\/D:\/x\/logo\.svg/u);
  assert.match(cardHtml({ title: 'Tên', subtitle: 'Mô tả', brand, fonts }), /<hr>/u);
  assert.match(chipHtml({ x: 400, y: 300, label: '86,4%', fonts }), /86,4%/u);
});

test('brand.json of the logo lane is read in the shapes it may have, and a missing one gives a text mark', () => {
  assert.deepEqual(brandOf('public', undefined, { public: 'Tên' }), { name: 'Tên', tagline: '', logo: null, accent: '#E0AA52' });
  const shaped = brandOf('enterprise', { colours: { accent: '#112233' }, taglines: { enterprise: 'Khẩu hiệu' }, editions: { enterprise: { name: 'Tên khác', logo: 'enterprise/logo.svg' } } });
  assert.deepEqual(shaped, { name: 'Tên khác', tagline: 'Khẩu hiệu', logo: 'enterprise/logo.svg', accent: '#112233' });
  assert.equal(brandOf('public', { public: { file: 'p.png' } }).logo, 'p.png');
});

test('a box of the footage lands in the hole of the frame in proportion', () => {
  assert.deepEqual(mapBox({ x: 960, y: 540, width: 192, height: 108 }, { x: 100, y: 200, width: 960, height: 540 }), { x: 580, y: 470, width: 96, height: 54 });
});

test('the web scene is put together in the order: background, footage in its hole, frame layer, chips, stamps', () => {
  const args = segmentArgs({ layout: 'web+callouts', bg: { file: 'bg.mp4', offsetSec: 3 }, web: { file: 'w.webm', startSec: 2 }, overlay: 'o.png', chips: [{ png: 'c.png', fromSec: 2, toSec: 5 }], seconds: 10, assFilter: "subtitles=filename='a.ass'", out: 'o.mp4', spec });
  const text = args.join(' ');
  assert.deepEqual(args.filter((word, index) => args[index - 1] === '-i'), ['bg.mp4', 'w.webm', 'o.png', 'c.png']);
  assert.match(text, /-stream_loop -1 -ss 3\.000 -i bg\.mp4/u);
  assert.match(text, /-ss 2\.000 -i w\.webm/u);
  const graph = args[args.indexOf('-filter_complex') + 1];
  const hole = frames('web+callouts', spec).web.hole;
  assert.match(graph, new RegExp(`overlay=x=${hole.x}:y=${hole.y}`, 'u'));
  assert.match(graph, /scale=w='trunc\(1216\*\(1\+0\.035\*t\/10\.000\)\/2\)\*2'.*eval=frame/u, 'slow zoom on the footage');
  assert.match(graph, /tpad=stop_mode=clone/u, 'short footage is held on its last picture');
  assert.match(graph, /fade=t=in:st=0:d=0\.4:alpha=1/u);
  assert.match(graph, /fade=t=out:st=9\.600/u);
  assert.match(graph, /\[3:v\]format=rgba,fade=t=in:st=2\.000/u, 'the chip appears at its time');
  assert.ok(graph.endsWith("[c0]subtitles=filename='a.ass',format=yuv420p[vout]"));
  assert.ok(graph.indexOf('[web]') < graph.indexOf('[frame]'), 'the frame layer is above the footage');
});

test('the split layout takes the film of the phone into its screen without a slow zoom', () => {
  const args = segmentArgs({ layout: 'split', bg: { file: 'bg.mp4', offsetSec: 0 }, web: { file: 'w.mp4', startSec: 0 }, phone: { file: 'p.mp4', startSec: 1 }, overlay: 'o.png', seconds: 8, out: 'o.mp4', spec });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /\[2:v\]fps=30,tpad=stop_mode=clone:stop_duration=8,scale=380:820:force_original_aspect_ratio=increase/u);
  assert.doesNotMatch(graph.split('[phone]')[0].split(';').at(-1), /eval=frame/u);
  const inputs = args.filter((word, index) => args[index - 1] === '-i');
  assert.deepEqual(inputs, ['bg.mp4', 'w.mp4', 'p.mp4', 'o.png']);
});

test('a card is the background with the card layer fading in; chips follow the spots, never outside the scene', () => {
  const args = cardArgs({ bg: { file: 'bg.mp4', offsetSec: 1 }, overlay: 'card.png', seconds: 6, out: 'c.mp4' });
  assert.match(args[args.indexOf('-filter_complex') + 1], /fade=t=in:st=0\.2:d=0\.7/u);
  const chips = chipsFor({ spots: [{ atSec: 0.1, holdSec: 1, box: { x: 100, y: 50, width: 400, height: 100 } }, { atSec: 9.8, holdSec: 3, box: { x: 0, y: 0, width: 10, height: 10 } }, { atSec: 3, holdSec: 4, box: { x: 10, y: 10, width: 10, height: 10 } }], labels: ['Một', 'Hai'], hole: { x: 600, y: 120 }, seconds: 10 });
  assert.deepEqual(chips.map((chip) => chip.label), ['Một', 'Hai']);
  assert.ok(chips[0].fromSec >= 0.6 && chips[0].toSec - chips[0].fromSec >= 2.2);
  assert.ok(chips.every((chip) => chip.toSec <= 9.8));
  assert.deepEqual(chipsFor({ spots: [], labels: ['a'], hole: { x: 0, y: 0 }, seconds: 5 }), []);
});

test('the subtitle bar is one more picture input of the mix, and the soft subtitle track stays last', () => {
  const narration = [{ file: 'a.wav', startMs: 0 }];
  const graph = buildFilterGraph({ narration, totalMs: 8000, music: 'm.ogg', barInput: 3 });
  assert.match(graph, /\[3:v\]fps=30,format=rgba\[bar\]/u);
  assert.match(graph, /\[base\]\[bar\]overlay=0:944/u);
  assert.doesNotMatch(graph, /subtitles=filename/u);
  const args = buildMixArgs({ video: 'v.mp4', narration, music: 'm.ogg', bar: 'bar.txt', subtitlesSrt: 's.srt', graphFile: 'g', out: 'o.mp4', totalMs: 8000 });
  assert.deepEqual(args.filter((word, index) => ['-i'].includes(args[index - 1])), ['v.mp4', 'a.wav', 'm.ogg', 'bar.txt', 's.srt']);
  assert.ok(args.includes('4:0'), 'subtitle input is the fifth input');
  assert.match(buildFilterGraph({ narration, totalMs: 8000, subtitlesFile: 's.srt', fontsDir: 'f' }), /subtitles=filename/u);
});

test('no source file of the composition holds a Vietnamese letter, and the scenario layouts are known', () => {
  for (const name of readdirSync(join(CLIPS_DIR, 'compose')).filter((file) => file.endsWith('.mjs'))) {
    assert.doesNotMatch(readFileSync(join(CLIPS_DIR, 'compose', name), 'utf8'), /[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/u, name);
  }
  for (const clip of ['public-investment', 'enterprise-phu-my']) {
    for (const scene of loadScenario(clip).scenes) {
      if (scene.layout !== undefined) assert.ok(LAYOUT_NAMES.includes(scene.layout), `${clip} ${scene.id}: layout ${scene.layout}`);
    }
  }
});

test('the brand.json of the logo lane gives the name, tagline, accent and the logo files of the edition', async () => {
  const raw = { editions: { enterprise: { productName: { vi: 'Phần mềm quản lý đầu tư xây dựng' }, tagline: { vi: 'Vốn đến đúng công trình, việc đúng tiến độ' }, colors: { onDark: { accent: '#F28C3A' } }, files: { icon: { png: 'logo-enterprise-icon.png' }, horizontalOnDark: { png: 'logo-enterprise-horizontal-ondark.png' }, hero: { png: 'logo-enterprise-hero.png' } } } } };
  const brand = brandOf('enterprise', raw, spec.productNames);
  assert.equal(brand.name, 'Phần mềm quản lý đầu tư xây dựng');
  assert.match(brand.tagline, /công trình/u);
  assert.equal(brand.logo, 'logo-enterprise-icon.png');
  assert.equal(brand.logoWide, 'logo-enterprise-horizontal-ondark.png');
  assert.equal(brand.hero, 'logo-enterprise-hero.png');
  assert.equal(brand.accent, '#F28C3A');
  const { heroArgs } = await import('./compose/plan.mjs');
  const args = heroArgs({ hero: 'h.png', seconds: 5, out: 'o.mp4' });
  assert.ok(args.includes('-loop') && args[args.indexOf('-vf') + 1].includes('fade=t=in'));
});
