// playwright.config.ts — cấu hình của lượt UAT chỉ-báo-cáo. Chép vào <OUT>/ rồi KHÔNG sửa.
//
// Khác cấu hình của runner:
//  * retries 0 — một ca chỉ ĐẠT khi đạt ngay lần đầu; chạy lại riêng là để đo độ tái hiện.
//  * forbidOnly — `.only` làm trượt cả bộ.
//  * E2E KHÔNG phụ thuộc dự án API: một ca API hỏng không được làm biến mất toàn bộ bằng chứng
//    E2E. Cổng quyết ở báo cáo (build_report.py), không phải ở cơ chế bỏ qua của Playwright.
//  * Tệp JSON kết quả đặt tên theo biến UAT_JSON_OUT → mỗi lượt một tệp MỚI (bản runner đọc lại
//    tệp của lượt trước khi chạy lại).
//  * trace/screenshot/video luôn bật: hồ sơ ký duyệt cần bằng chứng cả khi đạt. Đặt
//    UAT_EVIDENCE_PROFILE=ci để hạ xuống mức nhẹ cho vòng CI (khi ấy G12 sẽ hạ trần).
import { defineConfig, devices } from '@playwright/test';

const STORAGE = process.env.UAT_STORAGE_STATE || '';
const CI_PROFILE = process.env.UAT_EVIDENCE_PROFILE === 'ci';

export default defineConfig({
  testDir: './tests',
  outputDir: './artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['line'],
    ['json', { outputFile: process.env.UAT_JSON_OUT || './results/pw-main.json' }],
    ['html', { outputFolder: './report-html', open: 'never' }],
  ],
  use: {
    baseURL: process.env.UAT_BASE_URL,
    trace: CI_PROFILE ? 'on-first-retry' : 'on',
    screenshot: CI_PROFILE ? 'only-on-failure' : 'on',
    video: CI_PROFILE ? 'off' : 'on',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    ignoreHTTPSErrors: process.env.UAT_INSECURE_TLS === '1',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },
    // Chứng âm: ba mệnh đề chắc chắn sai, chạy cùng cấu hình và cùng reporter với các ca
    // thật. Project riêng nên không vào mẫu số và không bị lượt chạy lại --grep đụng tới.
    { name: 'canary', testMatch: /_canary\.spec\.ts$/, use: { ...devices['Desktop Chrome'] } },
    { name: 'api-smoke', testMatch: /.*\.api\.spec\.ts$/ },
    {
      name: 'e2e',
      testMatch: /.*\.e2e\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], ...(STORAGE ? { storageState: STORAGE } : {}) },
      dependencies: STORAGE ? ['setup'] : [],
    },
  ],
});
