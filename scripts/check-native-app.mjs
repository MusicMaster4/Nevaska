// Run only against a local Nevaska instance started with WebView2 debugging.
import { chromium, expect } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes('localhost:1420') || page.url().includes('tauri.localhost'));
if (!page) throw new Error('Nevaska WebView not found');
try {
  await page.getByRole('button', { name: 'Análise ao vivo', exact: true }).click();
  await expect(page.locator('#analysis-engine')).toHaveValue('local-stockfish-19');
  await expect(page.locator('.variations article')).toHaveCount(3, { timeout: 30000 });
  await expect(page.locator('.eval-score')).not.toHaveText('—');
  async function drag(from, to, button = 'left') {
    const a = await page.locator(`[data-square="${from}"]`).boundingBox();
    const b = await page.locator(`[data-square="${to}"]`).boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down({ button });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    await page.mouse.up({ button });
  }
  await drag('e2', 'e4');
  await expect(page.locator('[data-square="e4"]')).toHaveAttribute('data-occupied', '1');
  await expect(page.locator('#position-fen')).toHaveValue(/ b KQkq /);
  await expect(page.locator('.variations article')).toHaveCount(3, { timeout: 30000 });
  await drag('d2', 'd4', 'right');
  await drag('g1', 'f3', 'right');
  await expect(page.locator('.arrows line')).toHaveCount(2);
  await page.locator('[data-square="a4"]').click({ button: 'middle' });
  await expect(page.locator('.arrows line')).toHaveCount(0);
  await drag('d2', 'd4', 'right');
  await page.locator('[data-square="e7"]').click();
  await expect(page.locator('.arrows line')).toHaveCount(0);
  await page.locator('#analysis-engine').selectOption('local-lc0-0321');
  await expect(page.locator('.variations article')).toHaveCount(3, { timeout: 30000 });
  await expect(page.locator('.engine-error')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/native-leela.png' });
  await page.locator('#analysis-engine').selectOption('local-stockfish-19');
  await page.getByTitle('Undo', { exact: true }).click();
  await expect(page.locator('[data-square="e2"]')).toHaveAttribute('data-occupied', '1');
  await expect(page.locator('.variations article')).toHaveCount(3, { timeout: 30000 });
  await page.screenshot({ path: 'test-results/native-stockfish.png' });
  await page.getByRole('button', { name: 'Fechar painel' }).click();
  await expect(page.locator('.eval-bar')).toBeVisible();
  console.log('PASS: native IPC, both installed engines, live MultiPV, drag move, arrow clearing, undo and persistent evaluation');
} finally {
  await browser.close();
}
