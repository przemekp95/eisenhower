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

async function enter(page: Page, code = 'test-api-token') {
  await page.getByLabel('Kod dostępu').fill(code);
  await page.getByRole('button', { name: 'Wejdź do systemu' }).click();
}

async function expectAccessible(page: Page) {
  const accessibility = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('eisenhower-language', 'pl');
  });
  await page.goto('/');
});

test('explains access and rejects an incorrect code without losing focus', async ({ page }) => {
  await expect(page.getByText(/kod dostępu, który otrzymasz od administratora/i)).toBeVisible();
  await enter(page, 'wrong-code');

  const alert = page.getByRole('alert');
  await expect(alert).toContainText(/nieprawidłowy lub wygasł/i);
  await expect(page.getByLabel('Kod dostępu')).toBeFocused();
  await expect(page.getByText(/przechowywany tylko do zamknięcia tej karty/i)).toBeVisible();
});

test('shows a task-first, honest and accessible board at the current viewport', async ({
  page,
}) => {
  await enter(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Eisenhower Matrix' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dodaj zadanie' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Administracja' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Dane są aktualne');
  await expect(quadrant(page, 'Zrób teraz')).toBeVisible();
  await expect(quadrant(page, 'Zaplanuj')).toBeVisible();
  await expect(quadrant(page, 'Deleguj')).toBeVisible();
  await expect(quadrant(page, 'Usuń')).toBeVisible();

  const formBox = await page.getByRole('button', { name: 'Dodaj zadanie' }).boundingBox();
  const viewport = page.viewportSize();
  expect(formBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(formBox!.y).toBeLessThan(viewport!.height);
  await expect(page.getByText(/CRUD|backend|Pixi|GSAP|Lenis|runtime|provider/i)).toHaveCount(0);
  await expectAccessible(page);
});

test('shows offline state, never claims current data, and recovers locally', async ({ page }) => {
  await enter(page);
  await expect(page.getByRole('status')).toContainText('Dane są aktualne');

  let failTaskLoad = true;
  await page.route('**/tasks', async (route) => {
    if (failTaskLoad && route.request().method() === 'GET') {
      await route.abort('internetdisconnected');
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Odśwież tablicę' }).click();
  await expect(page.getByRole('alert')).toContainText('Brak połączenia');
  await expect(page.getByText('Dane są aktualne')).toHaveCount(0);

  failTaskLoad = false;
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click();
  await expect(page.getByRole('status')).toContainText('Dane są aktualne');
});

test('opens administration independently and explains the separate credential', async ({
  page,
}) => {
  await enter(page);
  await expect(page.getByLabel('Tytuł zadania')).toHaveValue('');
  await page.getByRole('button', { name: 'Administracja' }).click();

  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Kod administratora')).toBeVisible();
  await expect(page.getByLabel('Kod administratora')).toBeFocused();
  await expect(page.getByText(/osobny kod administratora/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Otwórz administrację' })).toBeDisabled();
  await expectAccessible(page);
});

test('creates, edits, classifies and permanently deletes a task with keyboard controls', async ({
  page,
}) => {
  test.setTimeout(45_000);
  await enter(page);

  const title = `E2E smoke ${Date.now()}`;
  const editedTitle = `${title} edited`;
  const description = 'flow through decisions';

  await page.getByLabel('Tytuł zadania').fill(title);
  await page.getByLabel('Opis').fill(description);
  await page.getByLabel('Pilne').focus();
  await page.keyboard.press('Space');
  await page.getByLabel('Ważne').focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Dodaj zadanie' }).focus();
  await page.keyboard.press('Enter');

  const createdCard = taskCard(quadrant(page, 'Zrób teraz'), title);
  await expect(createdCard).toBeVisible();
  await expect(createdCard.getByText(description)).toBeVisible();

  await createdCard.getByRole('button', { name: `Edytuj ${title}` }).focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Tytuł edytowanego zadania').fill(editedTitle);
  await page.getByLabel('Opis edytowanego zadania').fill('opis po edycji');
  await page.getByRole('button', { name: 'Zapisz zmiany' }).focus();
  await page.keyboard.press('Enter');
  const editedCard = taskCard(quadrant(page, 'Zrób teraz'), editedTitle);
  await expect(editedCard).toBeVisible();
  await expect(editedCard.getByText('opis po edycji')).toBeVisible();

  await editedCard.getByLabel(`Przełącz ważność zadania ${editedTitle}`).focus();
  await page.keyboard.press('Enter');
  const delegatedCard = taskCard(quadrant(page, 'Deleguj'), editedTitle);
  await expect(delegatedCard).toBeVisible();
  await delegatedCard.getByLabel(`Przełącz pilność zadania ${editedTitle}`).focus();
  await page.keyboard.press('Enter');

  const removableCard = taskCard(quadrant(page, 'Usuń'), editedTitle);
  await expect(removableCard).toBeVisible();
  await removableCard
    .getByRole('button', { name: `Przenieś do kosza ${editedTitle}`, exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: editedTitle, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Kosz', exact: true }).click();
  const trashedCard = taskCard(page, editedTitle);
  await trashedCard
    .getByRole('button', { name: `Usuń trwale ${editedTitle}`, exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await trashedCard.getByRole('button', { name: 'Potwierdź trwałe usunięcie' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: editedTitle, exact: true })).toHaveCount(0);
  await expectAccessible(page);
});
