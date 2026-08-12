import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/v2/ai/analyze', async (route) => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    expect(request.postDataJSON()).toEqual({ task: 'Prepare the incident review' });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'rag',
        quadrant: 0,
        quadrant_name: 'Do Now',
        confidence: 0.91,
        explanation: 'The approved incident procedure supports this priority.',
        citations: [
          {
            chunk_id: 'chunk-1',
            document_id: 'document-1',
            source_uri: 'eisenhower://repository/<script>alert(1)</script>',
            title: '<img src=x onerror=alert(1)> Incident procedure',
            excerpt: '<script>window.compromised=true</script> Follow the reviewed procedure.',
            score: 0.87,
            content_version: 'v1',
          },
        ],
        retrieval: { hit_count: 1, top_score: 0.87, embedding_version: 'minilm-v1' },
        fallback_reason: null,
      }),
    });
  });

  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('eisenhower-language', 'en');
  });
  await page.goto('/');
  await page.getByLabel('Access code').fill('test-api-token');
  await page.getByRole('button', { name: 'Enter the system' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Eisenhower Matrix' })).toBeVisible();
});

test('renders a sourced answer with escaped citations on desktop and mobile', async ({
  page,
}) => {
  await page.getByPlaceholder('Task title').fill('Prepare the incident review');
  const opener = page.getByRole('button', { name: 'Open AI tools' });
  await opener.click();

  await expect(page.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.getByRole('tab', { name: 'Answers with sources' }).click();
  await page.getByRole('button', { name: 'Check sources' }).click();

  await expect(page.getByText('Answer with sources', { exact: true })).toBeVisible();
  await expect(page.getByText('1 retrieved chunks')).toHaveCount(0);
  await expect(page.getByText('Index minilm-v1')).toHaveCount(0);
  await expect(page.getByText('<img src=x onerror=alert(1)> Incident procedure')).toBeVisible();
  await expect(page.getByText(/<script>window.compromised=true/)).toBeVisible();
  await expect(page.locator('blockquote script')).toHaveCount(0);
  await expect(page.locator('li img[src="x"]')).toHaveCount(0);

  const dialog = page.getByRole('dialog');
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);

  await page.getByRole('button', { name: 'Close' }).click();
  await expect(opener).toBeFocused();
});
