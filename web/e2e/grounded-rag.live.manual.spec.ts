import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const aiApiUrl = process.env.LIVE_AI_API_URL;
const accessToken = process.env.LIVE_ACCESS_TOKEN;
const query = process.env.LIVE_RAG_QUERY;
const evidenceDir = process.env.LIVE_EVIDENCE_DIR;

if (!aiApiUrl || !accessToken || !query || !evidenceDir) {
  throw new Error('The live RAG runtime environment is incomplete');
}

test('real browser reaches governed RAG and renders cited explicit mode', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('eisenhower-language', 'en');
  });
  await page.goto('/');
  await page.getByLabel('Access code').fill(accessToken);
  await page.getByRole('button', { name: 'Enter the system' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Eisenhower Matrix' })).toBeVisible();

  await page.getByPlaceholder('Task title').fill(query);
  await page.getByRole('button', { name: 'Open AI assistant' }).click();

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${aiApiUrl}/v2/knowledge/answer` && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Check sources' }).click();
  const response = await responsePromise;
  const requestBody = response.request().postDataJSON();
  const responseBody = await response.json();

  expect(response.status()).toBe(200);
  expect(requestBody).toEqual({ query, language: 'en', project_id: null, limit: 5 });
  expect(responseBody.status).toBe('answered');
  expect(responseBody.retrieval.hit_count).toBeGreaterThan(0);
  expect(responseBody.retrieval.embedding_version).toBe('minilm-v1');
  expect(responseBody.citations.length).toBeGreaterThan(0);
  expect(
    responseBody.citations.every(
      (citation: { source_uri: string }) =>
        citation.source_uri.startsWith('eisenhower://projects/p1/') &&
        !citation.source_uri.endsWith('/deleted')
    )
  ).toBe(true);

  const result = page.getByTestId('grounded-result');
  await expect(result.getByText('Answer with sources', { exact: true })).toBeVisible();
  await expect(result.getByText(responseBody.citations[0].title, { exact: true })).toBeVisible();

  const dialog = page.getByRole('dialog');
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);

  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(
    path.join(evidenceDir, `${testInfo.project.name}.json`),
    `${JSON.stringify(
      {
        project: testInfo.project.name,
        viewport,
        user_agent: await page.evaluate(() => navigator.userAgent),
        network: {
          request: {
            url: response.request().url(),
            method: response.request().method(),
            body: requestBody,
            origin: await response.request().headerValue('origin'),
            authorization_present: Boolean(await response.request().headerValue('authorization')),
          },
          response: responseBody,
          status: response.status(),
          server: response.headers()['server'] ?? null,
        },
        dom: {
          explicit_mode: await result.getByText('RAG', { exact: true }).innerText(),
          citation_title: responseBody.citations[0].title,
          citation_source_uri: responseBody.citations[0].source_uri,
          dialog_inside_viewport: true,
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
});
