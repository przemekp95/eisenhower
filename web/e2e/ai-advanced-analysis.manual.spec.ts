import { expect, test } from '@playwright/test';

const aiApiUrl = process.env.PLAYWRIGHT_AI_API_URL ?? 'http://127.0.0.1:8000';

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

  const capabilitiesResponse = await request.get(`${aiApiUrl}/capabilities`);
  expect(capabilitiesResponse.ok()).toBeTruthy();

  const capabilities = await capabilitiesResponse.json();
  test.skip(
    !capabilities?.providers?.openai,
    `OpenAI provider is disabled on ${aiApiUrl}; enable it before running the manual AI smoke.`
  );

  const taskTitle = `Prepare board meeting agenda for Q${new Date().getUTCMonth() + 1}`;

  await page.goto('/');
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

  expect(analysisPayload.langchain_analysis.method).toBe('openai-reasoning');
  expect(analysisPayload.langchain_analysis.reasoning).toBeTruthy();

  await expect(page.getByText(/Suggested quadrant:/i)).toBeVisible();
  await expect(page.getByText(analysisPayload.langchain_analysis.reasoning)).toBeVisible();
});
