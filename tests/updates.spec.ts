import { test, expect } from '@playwright/test';

for (const scenario of [
  { current: '1.0.0', candidate: '1.0.1', accepted: true },
  { current: '1.0.0', candidate: '2.0.0-testing.1', accepted: false },
  { current: '1.0.1-testing.1', candidate: '1.0.1-testing.2', accepted: true },
  { current: '1.0.1-testing.1', candidate: '1.0.1', accepted: false },
]) {
  test(`update ${scenario.current} to ${scenario.candidate}`, async ({ page }) => {
    await page.addInitScript(({ current, candidate }) => {
      const w = window as any;
      let id = 0;
      w.__updateCalls = [];
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      w.__TAURI_INTERNALS__ = {
        transformCallback: () => ++id,
        unregisterCallback: () => {},
        invoke: async (cmd: string) => {
          if (cmd === 'channel_info') return { version: current };
          if (cmd === 'plugin:app|version') return current;
          if (cmd === 'plugin:updater|check') return {
            rid: 1, currentVersion: current, version: candidate, body: 'Release notes',
          };
          if (cmd === 'plugin:updater|download_and_install' || cmd === 'plugin:process|restart') {
            w.__updateCalls.push(cmd);
            return;
          }
          if (cmd === 'list_engines' || cmd === 'list_arrows') return [];
          if (cmd === 'game_state') throw new Error('No native game in updater test');
          return null;
        },
      };
    }, scenario);
    await page.goto('/');
    await page.getByTitle('Updates', { exact: true }).click();
    await expect(page.locator('.update-status').first()).toContainText(scenario.current);
    await page.getByRole('button', { name: 'Check for updates' }).click();
    const install = page.getByRole('button', { name: 'Download and install' });
    if (scenario.accepted) {
      await expect(install).toBeVisible();
      await expect(page.getByText('Release notes', { exact: true })).toBeVisible();
      await install.click();
      await expect.poll(() => page.evaluate(() => (window as any).__updateCalls)).toEqual([
        'plugin:updater|download_and_install', 'plugin:process|restart',
      ]);
    } else {
      await expect(page.getByRole('status')).toHaveText('You are up to date on this channel.');
      await expect(install).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).__updateCalls)).toEqual([]);
    }
  });
}
