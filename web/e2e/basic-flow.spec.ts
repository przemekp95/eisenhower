import { expect, type Locator, type Page, test } from '@playwright/test';

function quadrant(page: Page, name: string): Locator {
  return page.locator('section').filter({
    has: page.getByRole('heading', { name, exact: true }),
  });
}

function taskCard(scope: Locator | Page, title: string): Locator {
  return scope.locator('article').filter({ hasText: title });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('eisenhower-language', 'pl');
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Eisenhower Matrix' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dodaj zadanie' })).toBeVisible();
});

test('renders the live board shell', async ({ page }) => {
  await expect(quadrant(page, 'Zrób teraz')).toBeVisible();
  await expect(quadrant(page, 'Zaplanuj')).toBeVisible();
  await expect(quadrant(page, 'Deleguj')).toBeVisible();
  await expect(quadrant(page, 'Usuń')).toBeVisible();
  await expect(page.getByText('System priorytetów')).toBeVisible();
});

test('creates, reclassifies and deletes a task through the live API', async ({ page }) => {
  const title = `E2E smoke ${Date.now()}`;
  const description = 'flow through quadrants';

  const doNow = quadrant(page, 'Zrób teraz');
  const schedule = quadrant(page, 'Zaplanuj');
  const remove = quadrant(page, 'Usuń');

  await page.getByPlaceholder('Tytuł zadania').fill(title);
  await page.getByPlaceholder('Opis').fill(description);
  await page.locator('label').filter({ hasText: 'Pilne' }).click();
  await page.locator('label').filter({ hasText: 'Ważne' }).click();
  await page.getByRole('button', { name: 'Dodaj zadanie' }).click();

  const createdCard = taskCard(doNow, title);
  await expect(createdCard).toBeVisible();
  await expect(createdCard.getByText(description)).toBeVisible();

  await createdCard.getByLabel(`toggle important ${title}`).click();

  const scheduledCard = taskCard(schedule, title);
  await expect(scheduledCard).toBeVisible();
  await expect(createdCard).toHaveCount(0);

  await scheduledCard.getByLabel(`toggle urgent ${title}`).click();

  const removableCard = taskCard(remove, title);
  await expect(removableCard).toBeVisible();
  await expect(scheduledCard).toHaveCount(0);

  await removableCard.getByRole('button', { name: 'Usuń', exact: true }).click();

  await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Odśwież' }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
});
