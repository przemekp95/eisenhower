import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/capabilities', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': 'http://127.0.0.1:4173' },
      body: JSON.stringify({
        classification: true,
        reasoned_local_analysis: true,
        knowledge_retrieval: true,
        retrieval_augmented_generation: true,
        langchain_analysis: false,
        ocr: true,
        batch_analysis: true,
        training_management: true,
        providers: { local_model: true, tesseract: true, ocr: true },
        device: {
          type: 'cpu',
          name: 'CI CPU',
          vendor: 'generic',
          runtime: 'cpu',
          runtime_version: null,
          torch_device: 'cpu',
          count: 1,
          cuda_version: null,
          accelerated: false,
        },
      }),
    });
  });
  await page.route('**/v2/knowledge/answer', async (route) => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    const body = request.postDataJSON();
    expect(body).toEqual({
      query: expect.any(String),
      language: 'en',
      project_id: null,
      limit: 5,
    });

    if (body.query === 'Question outside approved knowledge') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'insufficient_evidence',
          answer: null,
          claims: [],
          citations: [],
          retrieval: { hit_count: 0, top_score: null, embedding_version: null },
          generation: null,
          no_answer_reason: 'insufficient_context',
        }),
      });
      return;
    }

    expect(body.query).toBe('Prepare the incident review');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'answered',
        answer: 'The approved incident procedure requires an immediate review.',
        claims: [
          {
            statement: 'The incident procedure requires an immediate review.',
            citation_ids: ['chunk-1'],
          },
        ],
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
        generation: null,
        no_answer_reason: null,
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

test('renders a sourced answer with escaped citations on desktop and mobile', async ({ page }) => {
  test.setTimeout(60_000);

  await page.getByPlaceholder('Task title').fill('Prepare the incident review');
  await page.getByPlaceholder('Description').fill('Existing context');
  const opener = page.getByRole('button', { name: 'Open task assistance', exact: true });
  await opener.click();

  const assistant = page.getByRole('dialog', { name: 'Task assistance' });
  await expect(assistant.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await expect(assistant.getByRole('tab', { name: 'Task assistant' })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await assistant.getByRole('button', { name: 'Check sources' }).click();

  await expect(page.getByText('Answer with sources', { exact: true })).toBeVisible();
  await expect(
    page.getByText('The approved incident procedure requires an immediate review.')
  ).toBeVisible();
  await expect(page.getByText('1 retrieved chunks')).toHaveCount(0);
  await expect(page.getByText('Index minilm-v1')).toHaveCount(0);
  await expect(page.getByText('<img src=x onerror=alert(1)> Incident procedure')).toBeVisible();
  await expect(page.getByText(/<script>window.compromised=true/)).toBeVisible();
  await expect(page.locator('blockquote script')).toHaveCount(0);
  await expect(page.locator('li img[src="x"]')).toHaveCount(0);
  const accessibility = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await page.getByRole('button', { name: 'Use in task description' }).click();
  await expect(page.getByLabel('Description preview')).toHaveValue(
    'Existing context\n\nThe approved incident procedure requires an immediate review.'
  );
  await page.getByRole('button', { name: 'Confirm description update' }).click();
  await expect(page.getByPlaceholder('Description')).toHaveValue(
    'Existing context\n\nThe approved incident procedure requires an immediate review.'
  );

  const box = await assistant.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);

  await assistant.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(opener).toBeFocused();
});

test('renders an honest no-answer without fabricated citations', async ({ page }) => {
  await page.getByPlaceholder('Task title').fill('Question outside approved knowledge');
  await page.getByRole('button', { name: 'Open task assistance', exact: true }).click();
  const assistant = page.getByRole('dialog', { name: 'Task assistance' });
  await assistant.getByRole('button', { name: 'Check sources' }).click();

  await expect(page.getByText('No answer', { exact: true })).toBeVisible();
  await expect(
    page.getByText('There is not enough approved information to answer safely.')
  ).toBeVisible();
  await expect(page.getByText('No sources were cited for this response.')).toBeVisible();
  await expect(page.locator('[data-testid="grounded-result"] li')).toHaveCount(0);
});
