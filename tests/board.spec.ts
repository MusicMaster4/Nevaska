import { test, expect } from '@playwright/test';
import { EMPTY_GAME } from '../src/lib/types';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((initial) => {
    const callbacks = new Map<number, (value: unknown) => void>();
    let id = 0;
    const game = { ...initial, legal: ['e2e3', 'e2e4', 'g1f3'] };
    let arrows: unknown[] = [];
    const listeners = new Map<string, number>();
    const w = window as unknown as Record<string, unknown>;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__testEmit = (event: string, payload: unknown) => callbacks.get(listeners.get(event)!)?.({ event, payload });
    w.__TAURI_INTERNALS__ = {
      transformCallback: (fn: (value: unknown) => void) => { callbacks.set(++id, fn); return id; },
      unregisterCallback: (key: number) => callbacks.delete(key),
      invoke: async (cmd: string, args: Record<string, any>) => {
        if (cmd === 'plugin:event|listen') { listeners.set(args.event, args.handler); return id; }
        if (cmd === 'list_engines') return [{
          id: 'sf', name: 'Stockfish 19', path: 'stockfish', kind: 'stockfish',
          threads: 4, hash_mb: 128, eval_file: null, weights_file: null,
          limit_strength: false, elo: 1500, multipv: 3, nnue_name: 'nn-1a298aa575a0.nnue',
        }];
        if (cmd === 'update_engine') return [args.config];
        if (cmd === 'configure_play') return game;
        if (cmd === 'set_play_tuning') { w.__tuning = args.tuning; return null; }
        if (cmd === 'list_arrows') return arrows;
        if (cmd === 'clear_arrows') { arrows = []; return arrows; }
        if (cmd === 'add_arrow') { arrows.push({ ...args, source: 'user' }); return [...arrows]; }
        if (cmd === 'play_move') { w.__lastMove = args.uci; return game; }
        if (cmd === 'game_state') return game;
        if (cmd === 'channel_info') return { version: '0.1.0' };
        return null;
      },
    };
  }, EMPTY_GAME);
  await page.goto('/');
  await expect(page.locator('[data-square="e2"]')).toBeVisible();
});

async function gesture(page: import('@playwright/test').Page, from: string, to: string, button: 'left' | 'right' = 'left') {
  const a = (await page.locator(`[data-square="${from}"]`).boundingBox())!;
  const b = (await page.locator(`[data-square="${to}"]`).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down({ button });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up({ button });
}

test('starting pieces are drawn on their squares', async ({ page }) => {
  await expect(page.locator('.piece svg')).toHaveCount(32);
  const drawn = await page.locator('.piece svg').first().evaluate((svg) => {
    const box = svg.getBoundingClientRect();
    return { width: box.width, height: box.height };
  });
  expect(drawn.width).toBeGreaterThan(24);
  expect(drawn.height).toBeGreaterThan(24);
  await page.screenshot({ path: 'test-results/pieces.png' });
});

test('dragging, click moves, illegal drops, and flipped orientation', async ({ page }) => {
  await gesture(page, 'e2', 'e4');
  await expect.poll(() => page.evaluate(() => (window as any).__lastMove)).toBe('e2e4');
  await page.evaluate(() => { (window as any).__lastMove = null; });
  await gesture(page, 'e2', 'e5');
  expect(await page.evaluate(() => (window as any).__lastMove)).toBeNull();
  await page.getByTitle('Flip', { exact: true }).click();
  await gesture(page, 'e2', 'e3');
  await expect.poll(() => page.evaluate(() => (window as any).__lastMove)).toBe('e2e3');
  await page.locator('[data-square="g1"]').click();
  await page.locator('[data-square="f3"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__lastMove)).toBe('g1f3');
});

test('right button accumulates arrows; left and middle buttons clear them', async ({ page }) => {
  await gesture(page, 'e2', 'e4', 'right');
  await gesture(page, 'd2', 'd4', 'right');
  await expect(page.locator('.arrows .arrow')).toHaveCount(2);
  await page.locator('[data-square="a4"]').click({ button: 'middle' });
  await expect(page.locator('.arrows .arrow')).toHaveCount(0);
  await gesture(page, 'e2', 'e4', 'right');
  await page.locator('[data-square="e2"]').click();
  await expect(page.locator('.arrows .arrow')).toHaveCount(0);
  await gesture(page, 'e2', 'e4', 'right');
  await page.locator('.wordmark').click();
  await expect(page.locator('.arrows .arrow')).toHaveCount(0);
});

test('live analysis is separate and evaluation stays visible', async ({ page }) => {
  await page.getByRole('button', { name: 'Análise ao vivo', exact: true }).click();
  await page.evaluate((fen) => (window as any).__testEmit('engine-info', {
    fen, depth: 24, seldepth: 38, multipv: 1, score_cp: 64, score_mate: null,
    nodes: 90000, nps: 30000, time_ms: 3000, hashfull: 123, tbhits: 9,
    wdl: [400, 500, 100], pv: ['e2e4', 'e7e5'], pv_san: ['e4', 'e5'],
  }), EMPTY_GAME.fen);
  await expect(page.getByText('24 meios-lances', { exact: true })).toBeVisible();
  await expect(page.locator('.position-verdict')).toContainText('Vantagem das brancas');
  await expect(page.locator('.eval-bar')).toBeVisible();
  const bar = (await page.locator('.eval-bar').boundingBox())!;
  const panel = (await page.locator('.analysis-panel').boundingBox())!;
  expect(bar.x + bar.width).toBeLessThan(panel.x);
  await expect(page.locator('.eval-score')).toHaveCSS('writing-mode', 'horizontal-tb');
  await expect(page.locator('#analysis-cache')).toBeVisible();
  await expect(page.getByText('nn-1a298aa575a0.nnue')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Setas' }).check();
  await expect(page.locator('.arrows .arrow')).toHaveCount(1);
  await expect(page.locator('.arrow path[stroke="#2EAE6A"]')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/analysis.png' });
  await page.getByRole('button', { name: 'Fechar painel' }).click();
  await expect(page.locator('.eval-score')).toHaveText('0.64');
  await expect(page.locator('.analysis-panel')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/board.png' });
});

test('play menu sets opponent elo and a random think window', async ({ page }) => {
  await page.getByTitle('Play', { exact: true }).click();
  await expect(page.getByText('Limitar o Elo do oponente')).toBeVisible();
  await expect(page.getByLabel('Tempo mínimo da engine')).toHaveValue('2');
  await expect(page.getByLabel('Tempo máximo da engine')).toHaveValue('5');
  await page.getByText('Limitar o Elo do oponente').click();
  await expect(page.locator('#opponent-elo')).toBeVisible();
  await page.getByLabel('Tempo mínimo da engine').fill('5');
  await page.getByLabel('Tempo máximo da engine').fill('10');
  await page.getByLabel('Tempo máximo da engine').blur();
  await expect.poll(() => page.evaluate(() => (window as any).__tuning)).toMatchObject({
    opponent_elo: 1600,
    think_min_ms: 5000,
    think_max_ms: 10000,
  });
});
