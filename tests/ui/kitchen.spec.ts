import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function pairMock(page: Page) {
  await page.goto('/?mock=server');
  await page.getByRole('button', { name: 'Try a simulated Joule' }).click();
  await expect(page.getByTestId('device-state')).toHaveText('Idle');
  await expect(page.getByTestId('bath-temperature')).toHaveText('22.0');
  await page.locator('.mock-controls summary').click();
}
async function enableCooking(page: Page) {
  await page.getByRole('button', { name: 'Enable cooking', exact: true }).click();
  await page.getByRole('button', { name: 'Press simulated top button' }).click();
  await expect(page.getByRole('button', { name: 'Review manual cook' })).toBeEnabled();
}
async function start(page: Page) {
  await page.getByRole('button', { name: 'Review manual cook' }).click();
  await page.getByLabel('I understand this is a simulated device.').check();
  await page.getByRole('button', { name: 'Start simulated cook', exact: true }).click();
}

test('static landing does not connect or start anything; mobile layout stays inside viewport', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Keep an eye on the bath.' })).toBeVisible();
  await expect(page.getByTestId('device-state')).toHaveText('Disconnected');
  await expect(page.getByRole('button', { name: 'Stop Joule', exact: true })).toBeDisabled();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await page.getByRole('button', { name: 'About Wi-Fi access' }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'Wi-Fi sign-in is not available in this static build',
  );
  expect(await page.locator('input[type=password]').count()).toBe(0);
  expect(errors).toEqual([]);
});

test('pairs over the Docker GATT mock and records live bath and separate target', async ({
  page,
}) => {
  await pairMock(page);
  await expect(page.locator('.simulation-banner')).toContainText(
    'All temperatures and commands are simulated',
  );
  await expect(page.getByRole('button', { name: 'Review manual cook' })).toBeDisabled();
  await page.getByRole('button', { name: 'Simulate Turbo status' }).click();
  await expect(page.getByTestId('device-state')).toHaveText('Turbo');
  await expect(page.getByTestId('target-temperature')).toHaveText('68.0°C');
  await expect(page.getByTestId('temperature-path')).toHaveAttribute('d', /M/);
  await expect(page.getByTestId('target-path')).toHaveAttribute('d', /M/);
  await page.getByRole('button', { name: '°F', exact: true }).click();
  await expect(page.getByTestId('target-temperature')).toHaveText('154.4°F');
  await page.getByLabel('Show target').uncheck();
  await expect(page.getByTestId('target-path')).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop Joule', exact: true }).click();
  await expect(page.getByTestId('device-state')).toHaveText('Idle');
});

test('requires review and confirmation, runs the cook, and observes Stop', async ({ page }) => {
  await pairMock(page);
  await enableCooking(page);
  await page.getByLabel('Bath temperature').fill('30');
  await page.getByLabel('Run time', { exact: false }).first().fill('1');
  await page.getByRole('button', { name: 'Review manual cook' }).click();
  await expect(page.getByRole('button', { name: 'Start simulated cook' })).toBeDisabled();
  await page.getByLabel('I understand this is a simulated device.').check();
  await page.getByRole('button', { name: 'Start simulated cook' }).click();
  await expect(page.getByTestId('device-state')).toHaveText('Cooking');
  await expect(page.getByTestId('target-temperature')).toHaveText('30.0°C');
  await expect(page.getByRole('button', { name: 'Review manual cook' })).toBeDisabled();
  await page.getByRole('button', { name: 'Stop Joule', exact: true }).click();
  await expect(page.getByTestId('device-state')).toHaveText('Idle');
  await expect(page.getByTestId('target-temperature')).toHaveText('—°C');
});

test('Stop during a slow recipe upload prevents a later Start', async ({ page }) => {
  await pairMock(page);
  await enableCooking(page);
  await page.getByRole('button', { name: 'Slow recipe upload' }).click();
  await start(page);
  await expect(page.getByText('Sending the timed cook…')).toBeVisible();
  await page.getByRole('button', { name: 'Stop Joule', exact: true }).click();
  await expect(page.getByText('Joule reports idle.')).toBeVisible();
  // Allow enough time for the mock upload to have finished if it weren't
  // cancelled. No late commit may change the reported state.
  await page.waitForTimeout(4500);
  await expect(page.getByTestId('device-state')).toHaveText('Idle');
  await expect(page.getByTestId('target-temperature')).toHaveText('—°C');
});

test('recordings survive a full page reload and export complete, labelled CSV', async ({
  page,
}) => {
  await pairMock(page);
  await expect(page.getByTestId('sample-count')).toHaveText(/[1-9]\d* readings saved/);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recording as CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('SIMULATED');
  const stream = await download.createReadStream();
  let csv = '';
  for await (const chunk of stream!) csv += chunk.toString();
  expect(csv).toContain('"temperature_c"');
  expect(csv).toContain('"SIMULATED"');
  expect(csv).not.toMatch(/serial|password|Bearer/);
  await page.reload();
  await expect(page.getByTestId('device-state')).toHaveText('Disconnected');
  const select = page.getByLabel('Recording', { exact: true });
  await expect(select.locator('option')).toHaveCount(2);
  await select.selectOption({ index: 1 });
  await expect(page.getByTestId('temperature-path')).toHaveAttribute('d', /M/);
  await expect(page.getByText('SIMULATED RECORDING', { exact: true })).toBeVisible();
});

test('a dropped connection freezes the last reading and reconnect never restarts a cook', async ({
  page,
}) => {
  await pairMock(page);
  await enableCooking(page);
  await start(page);
  await expect(page.getByTestId('device-state')).toHaveText('Cooking');
  await page.getByRole('button', { name: 'Drop connection', exact: true }).click();
  await expect(page.getByTestId('device-state')).toHaveText('Disconnected');
  await expect(page.getByText('Reading paused · reconnect to update')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review manual cook' })).toBeDisabled();
  await page.getByRole('button', { name: 'Try a simulated Joule' }).click();
  await expect(page.getByTestId('device-state')).toHaveText('Idle');
  await expect(page.getByRole('button', { name: 'Review manual cook' })).toBeDisabled();
});

test('malformed frames are rejected and the next valid frame restores monitoring', async ({
  page,
}) => {
  await pairMock(page);
  await page.getByRole('button', { name: 'Send truncated frame' }).click();
  await expect(page.getByRole('alert')).toContainText('incomplete Bluetooth frame');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('device-state')).toHaveText('Idle');
});

test('the appliance timer ends a ten-second manual run without a browser Stop', async ({
  page,
}) => {
  await pairMock(page);
  await enableCooking(page);
  await page.getByLabel('Bath temperature').fill('30');
  await page.locator('#duration').fill('0.166666667');
  await start(page);
  await expect(page.getByTestId('device-state')).toHaveText('Cooking');
  await expect(page.getByTestId('device-state')).toHaveText('Idle', { timeout: 13000 });
  await expect(page.getByTestId('target-temperature')).toHaveText('—°C');
});

test('stale data disables Start and the graph marks the resumed observation gap', async ({
  page,
}) => {
  await pairMock(page);
  await enableCooking(page);
  await page.getByRole('button', { name: 'Pause readings' }).click();
  await expect(page.getByText('Reading paused · reconnect to update')).toBeVisible({
    timeout: 19000,
  });
  await expect(page.getByRole('button', { name: 'Review manual cook' })).toBeDisabled();
  await page.getByRole('button', { name: 'Resume readings' }).click();
  await expect(page.getByRole('button', { name: 'Review manual cook' })).toBeEnabled();
  const path = await page.getByTestId('temperature-path').getAttribute('d');
  expect(path!.split('M').length).toBeGreaterThan(2);
});

test('mock service rejects cross-origin WebSocket access', async ({ page }) => {
  await page.goto('/?mock=server');
  const result = await page.request.get('/__mock/gatt', {
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      Origin: 'https://unrelated.example',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  });
  expect(result.status()).toBe(403);
});
