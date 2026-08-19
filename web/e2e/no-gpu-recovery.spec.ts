import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('keeps manual task flow available when optional AI capabilities are offline', async ({
  page,
}) => {
  test.setTimeout(60_000);

  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('eisenhower-language', 'pl');
  });
  await page.route('**/capabilities', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Optional AI boundary is unavailable',
        code: 'dependency_unavailable',
      }),
    });
  });
  await page.goto('/');
  await page.getByLabel('Kod dostępu').fill('test-api-token');
  await page.getByRole('button', { name: 'Wejdź do systemu' }).click();

  const title = `Ręcznie bez GPU ${Date.now()}`;
  await page.getByLabel('Tytuł zadania').fill(title);
  await page.getByRole('button', { name: 'Dodaj zadanie' }).click();
  const task = page.locator('article').filter({ hasText: title });
  await task.getByRole('button', { name: `Pomoc przy zadaniu ${title}`, exact: true }).click();

  const assistant = page.getByRole('dialog', { name: 'Pomoc w porządkowaniu' });
  await expect(assistant.getByText('Nie udało się sprawdzić dostępności pomocy.')).toBeVisible();
  await expect(assistant.getByRole('button', { name: 'Zasugeruj kwadrant' })).toHaveCount(0);
  await expect(assistant.getByRole('button', { name: 'Sprawdź źródła' })).toHaveCount(0);
  await expect(
    assistant.getByText(/zadanie jest bezpieczne.*ręcznie wybrać kwadrant/i)
  ).toBeVisible();
  const accessibility = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await assistant.getByRole('button', { name: 'Zamknij i wybierz kwadrant ręcznie' }).click();
  const urgent = task.getByRole('button', { name: `Przełącz pilność zadania ${title}` });
  await urgent.click();
  await expect(urgent).toHaveAttribute('aria-pressed', 'true');
  const important = task.getByRole('button', { name: `Przełącz ważność zadania ${title}` });
  await important.click();
  await expect(important).toHaveAttribute('aria-pressed', 'true');
});
