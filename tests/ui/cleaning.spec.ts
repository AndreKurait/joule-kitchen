import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function connect(page: Page, demo = false) {
  await page.goto(demo ? '/' : '/?mock=server');
  await page.getByRole('button', { name: 'Try a simulated Joule' }).click();
  await expect(page.getByTestId('device-state')).toHaveText('Idle');
}
async function review(page: Page) {
  await page.getByRole('button', { name: 'Clean Joule', exact: true }).click();
  await page.getByRole('button', { name: 'Enable cleaning controls' }).click();
  await page.getByRole('button', { name: 'Press simulated cleaning button' }).click();
  await page.getByRole('button', { name: 'Review cleaning cycle' }).click();
}
async function start(page: Page) {
  await page.getByLabel('I understand this cleaning cycle is simulated.').check();
  await page.getByRole('button', { name: 'Start simulated cleaning', exact: true }).click();
  await expect(page.getByText('The Joule is running the cleaning bath.')).toBeVisible();
}

test('cleaning instructions open without connecting or starting, and link to manufacturer guidance', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Clean', exact: true }).click();
  await page.getByRole('button', { name: 'Clean Joule', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Clean your Joule.' })).toBeVisible();
  await expect(
    page.getByText(
      'Use equal parts water and distilled white vinegar in a small pot. Leave food out.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review cleaning cycle' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Turbo manual' })).toHaveAttribute(
    'href',
    /BSV600.*pdf#page=36/,
  );
  await page.getByRole('button', { name: 'Go to kitchen to connect' }).click();
  await expect(page.getByTestId('device-state')).toHaveText('Disconnected');
  await expect(page.getByRole('button', { name: 'Pair Joule', exact: true })).toBeVisible();
});

test('reviews a fixed cleaning preset, resets confirmation, and requires finishing the rinse guide', async ({
  page,
}) => {
  await connect(page);
  await page.getByRole('button', { name: '°F', exact: true }).click();
  await page.getByLabel('Bath temperature').fill('100');
  await page.locator('#duration').fill('1');
  await review(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('140.0°F', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start simulated cleaning' })).toBeDisabled();
  await page.getByLabel('I understand this cleaning cycle is simulated.').check();
  await page.getByRole('button', { name: 'Back to preparation' }).click();
  await page.getByRole('button', { name: 'Review cleaning cycle' }).click();
  await expect(page.getByRole('button', { name: 'Start simulated cleaning' })).toBeDisabled();
  await start(page);
  await expect(page.getByTestId('target-temperature')).toHaveText('140.0°F');
  await expect(dialog.getByText(/remaining on Joule/)).toBeVisible();
  await page.getByRole('button', { name: 'Stop cleaning', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cool, rinse, dry.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finish cleaning' })).toBeDisabled();
  await page.getByLabel('I have finished this simulated cleaning guide.').check();
  await page.getByRole('button', { name: 'Finish cleaning' }).click();
  await expect(page.getByTestId('device-state')).toHaveText('Idle');
  await expect(page.getByRole('button', { name: 'Clean Joule', exact: true })).toBeVisible();
});

test('a lost connection during cleaning cannot claim completion or restart a cycle', async ({
  page,
}) => {
  await connect(page);
  await review(page);
  await start(page);
  await page.getByRole('button', { name: 'Close cleaning guide' }).click();
  await page.locator('.mock-controls summary').click();
  await page.getByRole('button', { name: 'Drop connection', exact: true }).click();
  await page.getByRole('button', { name: 'View cleaning cycle' }).click();
  await expect(page.getByText('Status unavailable. The Joule may still be running.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cool, rinse, dry.' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start simulated cleaning' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop cleaning' })).toBeDisabled();
});

test('a different program cannot be labelled as the cleaning cycle', async ({ page }) => {
  await connect(page);
  await review(page);
  await start(page);
  await page.getByRole('button', { name: 'Close cleaning guide' }).click();
  await page.locator('.mock-controls summary').click();
  await page.getByRole('button', { name: 'Simulate Turbo status' }).click();
  await page.getByRole('button', { name: 'View cleaning cycle' }).click();
  await expect(
    page.getByText('Another program was observed. This cleaning cycle is no longer being tracked.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop cleaning' })).toHaveCount(0);
  await page.getByRole('button', { name: 'End cleaning guide' }).click();
  await expect(page.getByTestId('device-state')).toHaveText('Turbo');
  await page.getByRole('button', { name: 'Stop Joule', exact: true }).click();
});

test('the device timer ends cleaning and the guide waits for the resulting idle reading', async ({
  page,
}) => {
  await page.clock.install();
  await connect(page, true);
  await review(page);
  await start(page);
  await page.clock.fastForward(30 * 60000 + 1000);
  await expect(page.getByRole('heading', { name: 'Cool, rinse, dry.' })).toBeVisible();
  await expect(page.getByTestId('device-state')).toHaveText('Idle');
  await expect(page.getByTestId('target-temperature')).toHaveText('—°C');
});

test('reopening during upload keeps Stop available and cancellation requires fresh confirmation', async ({
  page,
}) => {
  await connect(page);
  await page.locator('.mock-controls summary').click();
  await page.getByRole('button', { name: 'Slow recipe upload' }).click();
  await review(page);
  await page.getByLabel('I understand this cleaning cycle is simulated.').check();
  await page.getByRole('button', { name: 'Start simulated cleaning', exact: true }).click();
  await page.getByRole('button', { name: 'Close cleaning guide' }).click();
  await page.getByRole('button', { name: 'View cleaning cycle' }).click();
  await page.getByRole('button', { name: 'Stop cleaning', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start simulated cleaning' })).toBeDisabled();
  await page.waitForTimeout(4500);
  await expect(page.getByTestId('device-state')).toHaveText('Idle');
  await expect(page.getByTestId('target-temperature')).toHaveText('—°C');
  await expect(page.getByLabel('I understand this cleaning cycle is simulated.')).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Start simulated cleaning' })).toBeDisabled();
});
