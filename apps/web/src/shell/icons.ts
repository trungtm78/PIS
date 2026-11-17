// SVG symbol paths of the icons the shell uses, copied from `workspaceSymbols` in
// Design/MACHVON_Design/02_Prototype/workspace-navigation.js; icons.test.ts keeps them equal to that source.
export const ICON_PATHS = {
  overview: "<rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1.5\"/><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\" rx=\"1.5\"/>",
  investment: "<path d=\"M3 21h18M5 21V9l7-5 7 5v12M9 21v-7h6v7M9 10h6\"/>",
  insights: "<path d=\"M4 19V5m0 14h16M8 15l4-5 4 2 5-7\"/>",
  engagement: "<path d=\"M20 12a8 8 0 0 1-8 8H4l1.7-4A8 8 0 1 1 20 12Z\"/><path d=\"M8 10h8m-8 4h5\"/>",
  data: "<ellipse cx=\"12\" cy=\"5\" rx=\"8\" ry=\"3\"/><path d=\"M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7\"/>",
  admin: "<path d=\"m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z\"/><path d=\"m8 12 3 3 5-6\"/>",
  home: "<path d=\"m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10\"/>",
  task: "<rect x=\"4\" y=\"3\" width=\"16\" height=\"18\" rx=\"3\"/><path d=\"m8 12 3 3 5-6\"/>",
  inbox: "<path d=\"M4 4h16l2 13v3H2v-3L4 4Z\"/><path d=\"M2 15h6l2 3h4l2-3h6\"/>",
  chevron: "<path d=\"m9 5 7 7-7 7\"/>",
  close: "<path d=\"m6 6 12 12M6 18 18 6\"/>",
  grid: "<rect x=\"3\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"14\" y=\"3\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"3\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"14\" y=\"14\" width=\"7\" height=\"7\" rx=\"1\"/>",
  pin: "<path d=\"m8 3 8 0-1 6 4 4v2H5v-2l4-4-1-6ZM12 15v7\"/>",
  menu: "<path d=\"M4 6h16M4 12h16M4 18h16\"/>",
  star: "<path d=\"m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z\"/>",
  help: "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01\"/>",
  search: "<circle cx=\"10\" cy=\"10\" r=\"6\"/><path d=\"m15 15 5 5\"/>",
  wallet: "<rect x=\"3\" y=\"5\" width=\"18\" height=\"15\" rx=\"3\"/><path d=\"M16 11h5v5h-5a2.5 2.5 0 0 1 0-5ZM5 5V3h13\"/>",
  agreement: "<path d=\"M6 2h9l4 4v8M6 2v20h6M9 8h5M9 12h4\"/><circle cx=\"17\" cy=\"18\" r=\"3\"/><path d=\"m15.5 20.5-.5 2 2-1 2 1-.5-2\"/>",
  contract: "<path d=\"M6 2h9l4 4v16H6V2Z M14 2v5h5M9 11h7m-7 4h7m-7 4h4\"/>",
  spark: "<path d=\"M11 4l1.8 5.2L18 11l-5.2 1.8L11 18l-1.8-5.2L4 11l5.2-1.8L11 4Z\"/><path d=\"M19 2v4m-2-2h4M19 17v4m-2-2h4\"/>",
  chip: "<rect x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"2\"/><path d=\"M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4\"/><path d=\"m12 8.5 1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5Z\"/>",
  expert: "<circle cx=\"12\" cy=\"7\" r=\"4\"/><path d=\"M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7\"/><path d=\"m12 14-1.5 3 1.5 3 1.5-3-1.5-3Z\"/>",
  compass: "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"m15.5 8.5-2 5-5 2 2-5 5-2Z\"/>",
  flowEdit: "<rect x=\"3\" y=\"3\" width=\"6\" height=\"6\" rx=\"1.5\"/><rect x=\"3\" y=\"15\" width=\"6\" height=\"6\" rx=\"1.5\"/><path d=\"M6 9v6M9 6h5a3 3 0 0 1 3 3v1\"/><path d=\"m13 20 .5-3 5.5-5.5 2.5 2.5-5.5 5.5-3 .5Z\"/>",
  graduation: "<path d=\"m2 9 10-5 10 5-10 5L2 9Z\"/><path d=\"M6 11.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5M22 9v6\"/>",
} as const;

export type IconName = keyof typeof ICON_PATHS;
