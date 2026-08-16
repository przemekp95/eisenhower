import { expect, test } from '@playwright/test';

const aiApiUrl = process.env.PLAYWRIGHT_AI_API_URL ?? 'http://127.0.0.1:8000';
const apiToken = process.env.PLAYWRIGHT_API_TOKEN;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('eisenhower-language', 'en');
  });
});

test('opens the task assistant and gets a live classifier suggestion', async ({
  page,
  request,
}) => {
  test.slow();

  expect(apiToken, 'PLAYWRIGHT_API_TOKEN is required for the live AI smoke').toBeTruthy();

  const capabilitiesResponse = await request.get(`${aiApiUrl}/capabilities`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  expect(capabilitiesResponse.ok()).toBeTruthy();

  const capabilities = await capabilitiesResponse.json();
  test.skip(
    !capabilities?.providers?.local_model,
    `Local model is disabled on ${aiApiUrl}; bootstrap the AI service before running the manual AI smoke.`
  );

  const taskTitle = `Prepare board meeting agenda for Q${new Date().getUTCMonth() + 1}`;

  await page.goto('/');
  await page.getByLabel('Access code').fill(apiToken!);
  await page.getByRole('button', { name: 'Enter the system' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Eisenhower Matrix' })).toBeVisible();

  await page.getByPlaceholder('Task title').fill(taskTitle);

  const openTools = page.getByRole('button', { name: 'Open AI assistant' });
  await expect(openTools).toBeEnabled();
  await openTools.click();

  await expect(page.getByRole('heading', { level: 2, name: 'AI task assistant' })).toBeVisible();

  const runAnalysis = page.getByRole('button', { name: 'Suggest quadrant' });
  await expect(runAnalysis).toBeVisible();

  const analysisResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/classify') &&
      response.request().method() === 'POST' &&
      response.ok()
  );

  await runAnalysis.click();

  const analysisResponse = await analysisResponsePromise;
  const analysisPayload = await analysisResponse.json();

  expect(analysisPayload.quadrant).toBeGreaterThanOrEqual(0);
  await expect(page.getByText(/Suggested quadrant:/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review quadrant change' })).toBeVisible();
});
