// Inline stroke icons (24 x 24 grid, 2 px stroke, round caps). Hand drawn, no external set, so the mockups are self-contained.
const P = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10M10 20v-6h4v6',
  building: 'M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M3 21h18M8 8h2M8 12h2M8 16h2',
  clipcheck: 'M9 4h6v3H9zM7 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1M8.5 14l2.5 2.5 4.5-4.5',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8M4 21a8 8 0 0 1 16 0',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M21 21l-4.3-4.3',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  calendar: 'M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2M16 2v4M8 2v4M3 10h18',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2',
  flag: 'M5 21V4M5 4h12l-2 4 2 4H5',
  chevR: 'M9 6l6 6-6 6',
  chevL: 'M15 6l-6 6 6 6',
  chevD: 'M6 9l6 6 6-6',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  paperclip: 'M21 11l-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  check: 'M5 12l5 5 9-10',
  x: 'M6 6l12 12M18 6L6 18',
  more: 'M12 6h.01M12 12h.01M12 18h.01',
  plus: 'M12 5v14M5 12h14',
  wifioff: 'M2 2l20 20M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5-2.7M2 8.8a15 15 0 0 1 4.2-2.6M19 12.9a10 10 0 0 0-2.4-1.6M22 8.8a15 15 0 0 0-8.3-3.3M12 20h.01',
  refresh: 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6',
  alertOctagon: 'M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9zM12 8v5M12 16h.01',
  alertTriangle: 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  checkCircle: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M8 12l3 3 5-6',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2M16 14h2',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M12 16v-4M12 8h.01',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  dot: 'M12 12h.01',
  circle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18',
  mapPin: 'M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12M12 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
  camera: 'M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1M12 10a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
};

export function icon(name, size = 20, extra = '') {
  const d = P[name];
  if (!d) throw new Error(`unknown icon ${name}`);
  return `<svg class="ic ${extra}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}
