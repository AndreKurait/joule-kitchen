import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function preview(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Diagnose', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Can’t connect to Breville+?' })).toBeVisible();
  await page.getByRole('button', { name: 'Diagnose connection', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Let’s check your Joule.' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Diagnosis only. No settings are changed.')).toBeVisible();
  await expect(
    dialog.getByRole('list', { name: 'Diagnosis progress' }).locator('[aria-current="step"]'),
  ).toContainText('Check');
  await dialog.getByRole('button', { name: 'Preview a diagnosis' }).click();
  await expect(
    page.getByRole('heading', { name: 'A server-address fault was found.' }),
  ).toBeVisible();
  await expect(page.locator('.recovery-simulation')).toContainText('SIMULATION');
  await expect(
    page.getByRole('list', { name: 'Diagnosis progress' }).locator('[aria-current="step"]'),
  ).toContainText('Findings');
  const findings = page.locator('.diagnosis-findings');
  await expect(findings.getByText('Responding', { exact: true })).toBeVisible();
  await expect(findings.getByText('Fault found', { exact: true })).toBeVisible();
  await expect(
    findings.locator(':scope > div').filter({ hasText: 'Wi-Fi & Breville account' }),
  ).toContainText('Not checked');
}
async function scenario(page: Page, value: string) {
  await page.getByText('Try another simulated outcome', { exact: true }).click();
  await page.getByLabel('Simulated scenario', { exact: true }).selectOption(value);
  await page.getByRole('button', { name: 'Run simulated check' }).click();
}
async function repair(page: Page) {
  await page.getByRole('button', { name: 'Review suggested fix', exact: true }).click();
  await expect(
    page.getByRole('list', { name: 'Diagnosis progress' }).locator('[aria-current="step"]'),
  ).toContainText('Next steps');
  await expect(page.getByTestId('recovery-current-address')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore simulated address' })).toBeDisabled();
  await page.getByLabel('This is a simulated repair.', { exact: true }).check();
  await page.getByRole('button', { name: 'Restore simulated address' }).click();
}

test('connection diagnosis shows findings before offering a reviewed fix and a read-only recheck', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await preview(page);
  await expect(page.getByTestId('recovery-current-address')).toHaveText('Hex: 04');
  await expect(page.getByTestId('recovery-current-address')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Restore simulated address' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review suggested fix', exact: true }).click();
  await page.getByRole('button', { name: 'Back to findings', exact: true }).click();
  await expect(page.locator('.diagnosis-findings')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore simulated address' })).toHaveCount(0);
  await repair(page);
  await expect(
    page.getByRole('heading', { name: 'Address restored. Check Breville+ next.' }),
  ).toBeVisible();
  await expect(page.getByTestId('recovery-current-address')).toHaveText(
    'example123-ats.iot.us-west-2.amazonaws.com',
  );
  await expect(
    page.getByText('Breville+ still needs to confirm the cloud connection.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Recheck saved address' }).click();
  await expect(page.getByRole('heading', { name: 'Address still matches.' })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download diagnostic report' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('SIMULATED');
  let json = '';
  for await (const chunk of (await download.createReadStream())!) json += chunk.toString();
  expect(JSON.parse(json)).toMatchObject({
    simulation: true,
    verification: 'readback-matched',
    checkedOnNewConnection: true,
    cloudConnectionVerified: false,
  });
  expect(json).not.toMatch(/SIMULATED000002|serial|password|token/i);
  expect(await page.locator('input[type=password]').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  expect(
    await page
      .getByRole('dialog')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  await page.getByRole('button', { name: 'Back to the kitchen', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('device-state')).toHaveText('Disconnected');
  expect(errors).toEqual([]);
});

test('a healthy server address is explained and offers no repair', async ({ page }) => {
  await preview(page);
  await scenario(page, 'correct');
  await expect(
    page.getByRole('heading', { name: 'The saved server address matches.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review suggested fix', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('heading', { name: 'Next: check Wi-Fi and account setup.' }),
  ).toBeVisible();
  await expect(
    page.locator('.diagnosis-findings > div').filter({ hasText: 'Wi-Fi & Breville account' }),
  ).toContainText('Not checked');
  await expect(
    page.getByText('This diagnosis made no changes. Bluetooth is disconnected.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close diagnosis', exact: true }).click();
  await page.getByRole('button', { name: 'Diagnose connection', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Let’s check your Joule.' })).toBeVisible();
});

test('unsupported firmware and unfamiliar settings cannot reach a repair review', async ({
  page,
}) => {
  await preview(page);
  await scenario(page, 'unsupported');
  await expect(page.getByRole('heading', { name: 'The diagnosis is incomplete.' })).toBeVisible();
  await expect(
    page.locator('.diagnosis-findings > div').filter({ hasText: 'Server address' }),
  ).toContainText('Not checked');
  await expect(page.getByRole('button', { name: 'Review suggested fix', exact: true })).toHaveCount(
    0,
  );
  if (
    !(await page
      .locator('.recovery-demo-controls')
      .evaluate((element) => element.hasAttribute('open')))
  )
    await page.getByText('Try another simulated outcome', { exact: true }).click();
  await page.getByLabel('Simulated scenario', { exact: true }).selectOption('different');
  await page.getByRole('button', { name: 'Run simulated check' }).click();
  await expect(
    page.getByRole('heading', { name: 'This setting needs further diagnosis.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review suggested fix', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByTestId('recovery-current-address')).toHaveText('Hex: 03');
});

test('an interrupted write is uncertain until a read-only recheck confirms the saved address', async ({
  page,
}) => {
  await preview(page);
  await scenario(page, 'lost-ack');
  await repair(page);
  await expect(page.getByRole('heading', { name: 'Write result not confirmed.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore simulated address' })).toHaveCount(0);
  await expect(
    page.getByText('Rechecking only reads settings; it will not repeat the repair.', {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Recheck saved address' }).click();
  await expect(page.getByRole('heading', { name: 'Address still matches.' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('opening diagnosis never interrupts an existing kitchen session', async ({ page }) => {
  await page.goto('/?mock=server');
  await page.getByRole('button', { name: 'Try a simulated Joule' }).click();
  await expect(page.getByTestId('device-state')).toHaveText('Idle');
  await page.getByRole('button', { name: 'Diagnose connection', exact: true }).click();
  await expect(
    page.getByText('The kitchen already has a Bluetooth session open.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start diagnosis' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Preview a diagnosis' })).toBeDisabled();
  await page.getByRole('button', { name: 'Close diagnosis', exact: true }).click();
  await expect(page.getByTestId('device-state')).toHaveText('Idle');
});
