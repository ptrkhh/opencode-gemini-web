import { RequestError } from './adapter.mjs';

const modePrefix = 'bard-mode-option-';

export function modelChoices(rows) {
  const choices = rows.flatMap(({ key, name, checked, disabled }) => {
    if (disabled || !name || !/^bard-mode-option-[a-z0-9_-]+$/i.test(key)) return [];
    const slug = name.normalize('NFKD').toLowerCase().replace(/\p{Mark}/gu, '')
      .replace(/[^a-z0-9.]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
    const id = slug === '4-hydrogen-thinking' ? 'hydrogen-thinking' : slug || key.slice(modePrefix.length);
    return [{ id, name, key, checked }];
  });
  const counts = new Map();
  for (const { id } of choices) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const option of choices) {
    if (counts.get(option.id) > 1) option.id += '--' + option.key.slice(modePrefix.length);
  }
  return choices;
}

export async function readModelMenu(page) {
  const picker = page.locator('[data-test-id=bard-mode-menu-button]:visible');
  await picker.click();
  const menu = page.locator('[data-test-id=gem-mode-menu]:visible');
  const rows = menu.getByRole('menuitemradio');
  await rows.first().waitFor();
  const choices = modelChoices(await rows.evaluateAll(items => items.map(item => ({
    key: item.getAttribute('data-test-id'),
    name: (item.querySelector('.sublabel') ?? item.querySelector('.label'))?.textContent.trim(),
    checked: item.getAttribute('aria-checked') === 'true',
    disabled: item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true',
  }))));
  if (!choices.length) throw new RequestError(503, 'Gemini did not show any available models.', 'gemini_model_catalog_unavailable');
  return { picker, menu, choices };
}

export async function selectModel(page, id) {
  const { picker, menu, choices } = await readModelMenu(page);
  const choice = choices.find(option => option.id === id);
  if (!choice) {
    throw new RequestError(404, 'That model is unavailable for the signed-in Gemini account. Refresh OpenCode with opencode-gemini-web sync.', 'gemini_model_unavailable');
  }
  if (!choice.checked) {
    const option = menu.locator(`[data-test-id="${choice.key}"]`);
    await option.click();
    await menu.waitFor({ state: 'hidden' });
    await picker.click();
    await option.and(menu.locator('[aria-checked="true"]')).waitFor({ timeout: 3000 });
  }
  await picker.click();
  await menu.waitFor({ state: 'hidden' });
}
