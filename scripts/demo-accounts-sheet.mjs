#!/usr/bin/env node
// Writes the sheet of the demo accounts that is handed to the owner of the demonstration, from the credentials the server holds:
//   ssh <server> "type C:\ProgramData\MACHVON\secrets\admin\demo-credentials.json" | node scripts/demo-accounts-sheet.mjs --credentials - --out <file outside git>
// The sheet holds passwords: `--out` must be a path git ignores (it is refused inside a tracked directory of this repository unless the path is ignored).
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readCredentials } from './clip-seed-auth.mjs';

/** The sheet, in Vietnamese: the sample accounts first, then the others. Pure. */
export function sheetOf(credentials, { date, singleFactor = true }) {
  const people = Object.entries(credentials.people).map(([person, account]) => ({ person, ...account }));
  const row = (account) => `| \`${account.username}\` | \`${account.password}\` | ${account.displayName ?? ''} | ${account.title ?? ''} |`;
  const head = '| Tên đăng nhập | Mật khẩu | Tên hiển thị (minh họa) | Vai |\n|---|---|---|---|';
  const sample = people.filter((account) => account.sample === true);
  const others = people.filter((account) => account.sample !== true);
  return [
    '# Tài khoản demo: Hệ thống quản lý đầu tư công (dữ liệu minh họa tỉnh Cà Mau)',
    '',
    `Lập ngày ${date}. **Tệp này chứa mật khẩu: không đưa vào git, không gửi qua kênh công khai.**`,
    '',
    `- Địa chỉ: ${credentials.origin}`,
    `- Đăng nhập: ${singleFactor ? 'tên đăng nhập và mật khẩu (bản demo đang ở chế độ một yếu tố, không hỏi mã OTP)' : 'tên đăng nhập, mật khẩu và mã OTP'}`,
    new Set(people.map((account) => account.password)).size === 1 ? `- Mật khẩu chung cho mọi tài khoản demo: \`${people[0].password}\` (phân biệt chữ hoa, chữ thường).` : '- Mỗi tài khoản một mật khẩu gồm 13 chữ và số, không có ký tự dễ nhầm (không có 0, O, 1, l, I); phân biệt chữ hoa, chữ thường.',
    '- Sai mật khẩu 5 lần liên tiếp thì tài khoản bị khóa tạm.',
    '- Toàn bộ dự án, số liệu và tên người trong bản demo là dữ liệu minh họa, không phải số liệu thật của tỉnh Cà Mau.',
    '',
    '## Tài khoản dùng cho buổi demo',
    '',
    head,
    ...sample.map(row),
    '',
    '`demo` là chủ sở hữu tenant "UBND tỉnh Cà Mau": đủ mọi quyền của tenant.',
    '',
    '## Tài khoản khác của bộ dữ liệu (để xem theo vai)',
    '',
    head,
    ...others.map(row),
    '',
    'Trên máy chủ, cùng nội dung này (kèm mã bí mật OTP để dùng khi bật lại hai yếu tố) nằm ở `C:\\ProgramData\\MACHVON\\secrets\\admin\\demo-credentials.json`.',
    'Tài khoản quản trị hệ thống (`quantri.hethong`, mặt điều khiển) ở `C:\\ProgramData\\MACHVON\\secrets\\admin\\first-accounts.json`; không dùng cho buổi demo.',
    '',
  ].join('\n');
}

/** True when git ignores the path, or the path is outside every repository. */
export function ignoredByGit(path, run = spawnSync) {
  const result = run('git', ['check-ignore', '-q', path], { cwd: dirname(path) });
  // 0: ignored; 1: not ignored; 128: not in a repository.
  return result.status === 0 || result.status === 128;
}

export function main(argv, { log = (line) => process.stdout.write(`${line}\n`), read, ignored = ignoredByGit, write = (path, text) => writeFileSync(path, text, 'utf8'), now = () => new Date() } = {}) {
  const { values } = parseArgs({ args: argv, options: { credentials: { type: 'string' }, out: { type: 'string' }, 'two-factor': { type: 'boolean', default: false } }, allowPositionals: false });
  if (typeof values.credentials !== 'string' || typeof values.out !== 'string') {
    log('demo-accounts-sheet: --credentials <file|-> and --out <file> are required');
    return 2;
  }
  const out = resolve(values.out);
  mkdirSync(dirname(out), { recursive: true });
  if (!ignored(out)) {
    log(`demo-accounts-sheet: ${out} is not ignored by git: a sheet with passwords is not written there`);
    return 1;
  }
  const credentials = read === undefined ? readCredentials(values.credentials) : readCredentials(values.credentials, read);
  write(out, sheetOf(credentials, { date: now().toISOString().slice(0, 10), singleFactor: !values['two-factor'] }));
  log(`demo-accounts-sheet: ${Object.keys(credentials.people).length} accounts written to ${out}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
