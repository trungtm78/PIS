// _canary.spec.ts — CHỨNG ÂM của lượt chạy. SINH TỰ ĐỘNG, KHÔNG sửa tay.
//
// Ba mệnh đề dưới đây PHẢI đỏ. Nếu một mệnh đề xanh thì thước đo của lượt này hỏng và
// canary.py đánh cả báo cáo là VÔ HIỆU — vì khi ấy màu xanh của các ca thật không còn
// chứng minh được điều gì.
//
// Các ca này KHÔNG mang tag @TC- nào, chạy ở project riêng "canary", nên không vào mẫu số
// và không bị lượt chạy lại --grep đụng tới.
import { test, expect } from '@playwright/test';

const NONCE = 'a8702530567ab65b3c0c5080fa3ca4ab';

test('CANARY-TITLE tieu de trang khong the bang nonce', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(NONCE, { timeout: 3000 });
});

test('CANARY-HTTP khong may chu nao tra ma 599', async ({ request }) => {
  const r = await request.get('/');
  expect(r.status()).toBe(599);
});

test('CANARY-DOM testid ngau nhien khong the ton tai', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId(NONCE)).toBeVisible({ timeout: 3000 });
});
