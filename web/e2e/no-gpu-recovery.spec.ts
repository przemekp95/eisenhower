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
  await page.getByRole('button', { name: 'Otwórz asystenta AI', exact: true }).click();

  const assistant = page.getByRole('dialog', { name: 'Asystent AI zadania' });
  await expect(assistant.getByText('Nie udało się sprawdzić dostępności AI.')).toBeVisible();
  await expect(assistant.getByRole('button', { name: 'Zasugeruj kwadrant' })).toHaveCount(0);
  await expect(assistant.getByRole('button', { name: 'Sprawdź źródła' })).toHaveCount(0);
  await expect(
    assistant.getByText(/możesz kontynuować bez AI i ręcznie wybrać kwadrant/i)
  ).toBeVisible();
  const accessibility = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await assistant.getByRole('button', { name: 'Zamknij i wybierz kwadrant ręcznie' }).click();
  await page.getByText('Pilne', { exact: true }).click();
  await page.getByText('Ważne', { exact: true }).click();
  await expect(page.getByLabel('Pilne')).toBeChecked();
  await expect(page.getByLabel('Ważne')).toBeChecked();
  await page.getByRole('button', { name: 'Dodaj zadanie' }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
});
