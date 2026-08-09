import { expect, test } from '@playwright/test';

const aiApiUrl = process.env.PLAYWRIGHT_AI_API_URL ?? 'http://127.0.0.1:8000';
const apiToken = process.env.PLAYWRIGHT_API_TOKEN;
const adminToken = process.env.PLAYWRIGHT_ADMIN_TOKEN;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('eisenhower-language', 'en');
  });
});

test('opens AI tools and runs advanced analysis against the live AI service', async ({
  page,
  request,
}) => {
  test.slow();

  expect(apiToken, 'PLAYWRIGHT_API_TOKEN is required for the live AI smoke').toBeTruthy();
  expect(adminToken, 'PLAYWRIGHT_ADMIN_TOKEN is required for the credential gate').toBeTruthy();

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
  await page.getByLabel('Token dostępu').fill(apiToken!);
  await page.getByLabel('Token administratora AI').fill(adminToken!);
  await page.getByRole('button', { name: /odblokuj|unlock/i }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Eisenhower Matrix' })).toBeVisible();

  await page.getByPlaceholder('Task title').fill(taskTitle);

  const openTools = page.getByRole('button', { name: 'Open AI tools' });
  await expect(openTools).toBeEnabled();
  await openTools.click();

  await expect(page.getByRole('heading', { level: 2, name: 'AI tools' })).toBeVisible();

  const runAnalysis = page.getByRole('button', { name: 'Run advanced analysis' });
  await expect(runAnalysis).toBeVisible();

  const analysisResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/analyze-langchain') &&
      response.request().method() === 'POST' &&
      response.ok()
  );

  await runAnalysis.click();

  const analysisResponse = await analysisResponsePromise;
  const analysisPayload = await analysisResponse.json();

  expect(analysisPayload.langchain_analysis.method).toBe('local-analysis');
  expect(analysisPayload.langchain_analysis.reasoning).toBeTruthy();

  await expect(page.getByText(/Suggested quadrant:/i)).toBeVisible();
  await expect(page.getByText(analysisPayload.langchain_analysis.reasoning)).toBeVisible();
});
