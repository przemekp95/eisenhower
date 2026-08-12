import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

function quadrant(page: Page, name: string): Locator {
  return page.locator('section').filter({
    has: page.getByRole('heading', { name, exact: true }),
  });
}

function taskCard(scope: Locator | Page, title: string): Locator {
  return scope.locator('article').filter({ hasText: title });
}

function taskHeading(scope: Locator | Page, title: string): Locator {
  return scope.getByRole('heading', { name: title, exact: true });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('eisenhower-language', 'pl');
  });

  await page.goto('/');
  await page.getByLabel('Token dostępu').fill('test-api-token');
  await page.getByRole('button', { name: 'Odblokuj' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Eisenhower Matrix' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dodaj zadanie' })).toBeVisible();
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true
  );
  await expect(page.locator('main')).toHaveAttribute('data-app-intro', 'ready');
});

test('renders the live board shell', async ({ page }) => {
  await expect(quadrant(page, 'Zrób teraz')).toBeVisible();
  await expect(quadrant(page, 'Zaplanuj')).toBeVisible();
  await expect(quadrant(page, 'Deleguj')).toBeVisible();
  await expect(quadrant(page, 'Usuń')).toBeVisible();
  await expect(page.getByText('System priorytetów')).toBeVisible();

  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

test('creates, reclassifies and deletes a task through the live API', async ({ page }) => {
  const title = `E2E smoke ${Date.now()}`;
  const description = 'flow through quadrants';

  const doNow = quadrant(page, 'Zrób teraz');
  const delegate = quadrant(page, 'Deleguj');
  const remove = quadrant(page, 'Usuń');

  await page.getByPlaceholder('Tytuł zadania').fill(title);
  await page.getByPlaceholder('Opis').fill(description);
  await page.locator('label').filter({ hasText: 'Pilne' }).click();
  await page.locator('label').filter({ hasText: 'Ważne' }).click();
  await page.getByRole('button', { name: 'Dodaj zadanie' }).click();

  const createdCard = taskCard(doNow, title);
  await expect(createdCard).toBeVisible();
  await expect(createdCard.getByText(description)).toBeVisible();

  const populatedBoardAccessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(populatedBoardAccessibility.violations).toEqual([]);

  await createdCard.getByLabel(`Przełącz ważność zadania ${title}`).click({ force: true });

  const delegatedCard = taskCard(delegate, title);
  await expect(delegatedCard).toBeVisible();
  await expect(taskHeading(doNow, title)).toHaveCount(0);

  await delegatedCard.getByLabel(`Przełącz pilność zadania ${title}`).click({ force: true });

  const removableCard = taskCard(remove, title);
  await expect(removableCard).toBeVisible();
  await expect(taskHeading(delegate, title)).toHaveCount(0);

  await removableCard.getByRole('button', { name: `Usuń ${title}`, exact: true }).click();
  await removableCard
    .getByRole('button', { name: 'Potwierdź trwałe usunięcie', exact: true })
    .click();

  await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Odśwież' }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
});
