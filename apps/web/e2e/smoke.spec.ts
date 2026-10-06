import { expect, test, type Page } from '@playwright/test';

/** Every page renders without errors and shows the safety chrome. SCREENSHOTS=dir saves full-page images. */
const PAGES = ['/', '/opportunities', '/experiments', '/strategies', '/compare', '/research', '/research?tab=sources', '/portfolio', '/performance', '/risk', '/logs', '/logs?kind=events', '/system', '/settings'];

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function shot(page: Page, name: string) {
  if (!process.env.SCREENSHOTS) return;
  await page.screenshot({ path: `${process.env.SCREENSHOTS}/${name}.png`, fullPage: true });
}

for (const path of PAGES) {
  test(`renders ${path}`, async ({ page }) => {
    const errors = watchErrors(page);
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    await expect(page.getByText('Paper mode', { exact: true })).toBeVisible();
    await expect(page.getByText('Live disabled', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /emergency stop|stop engaged/i })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/guaranteed profit|garantiert/i);
    await shot(page, path.replace(/[/?=]/g, '_') || 'dashboard');
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

test('dashboard shows every required KPI', async ({ page }) => {
  await page.goto('/');
  for (const label of ['Total experiments', 'Active experiments', 'Paper portfolio', 'Total simulated profit', 'Best strategy', 'Best business model', 'Average score', 'Total capital simulated', 'Risk status']) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: 'Top opportunities' })).toBeVisible();
});

test('experiment detail renders charts, versions, risk and compliance', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/experiments');
  const first = page.locator('table a[href^="/experiments/"]').first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page.getByRole('heading', { name: 'Versions' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Risk limits' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Compliance review' })).toBeVisible();
  await shot(page, 'experiment_detail');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('emergency stop asks for a reason before it acts', async ({ page }) => {
  await page.goto('/');
  const button = page.getByRole('button', { name: /^emergency stop$/i });
  test.skip(!(await button.isVisible()), 'the stop is already engaged');
  await button.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByPlaceholder(/reason/i)).toHaveAttribute('required', '');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

// Changes state (pauses every automated experiment): only against a throwaway stack.
test('engages and releases the emergency stop end to end (E2E_MUTATE=1)', async ({ page }) => {
  test.skip(process.env.E2E_MUTATE !== '1', 'set E2E_MUTATE=1 to run state-changing tests');
  await page.goto('/');
  await page.getByRole('button', { name: /^emergency stop$/i }).click();
  await page.getByRole('dialog').getByPlaceholder(/reason/i).fill('e2e drill');
  await page.getByRole('dialog').getByRole('button', { name: 'Stop everything' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'EMERGENCY STOP ENGAGED' })).toBeVisible();
  await page.goto('/risk');
  await expect(page.getByText('ENGAGED', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /stop engaged/i }).click();
  await page.getByRole('dialog').getByPlaceholder(/safe to continue/i).fill('e2e drill over');
  await page.getByRole('dialog').getByLabel(/resume the experiments/i).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Release' }).click();
  await expect(page.getByRole('button', { name: /^emergency stop$/i })).toBeVisible();
  await page.goto('/logs?kind=audit&action=EMERGENCY_STOP_RELEASED');
  await expect(page.getByText('EMERGENCY_STOP_RELEASED').first()).toBeVisible();
});
