import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelChoices, verifyModel } from './models.mjs';

test('turns enabled Gemini menu choices into distinct IDs and preserves the original ID', () => {
  const rows = [
    { key: 'bard-mode-option-default', name: '4 Hydrogen', checked: false },
    { key: 'bard-mode-option-thinking', name: '4 Hydrogen Thinking', checked: true },
    { key: 'bard-mode-option-pro', name: '3.1 Pro', checked: false },
    { key: 'bard-mode-option-other', name: '4 Neon', checked: false },
    { key: 'bard-mode-option-disabled', name: '4 Carbon', disabled: true },
    { key: 'bad', name: 'Unsupported control' },
  ];
  assert.deepEqual(modelChoices(rows).map(({ id, name, checked }) => [id, name, checked]), [
    ['4-hydrogen', '4 Hydrogen', false],
    ['hydrogen-thinking', '4 Hydrogen Thinking', true],
    ['3.1-pro', '3.1 Pro', false],
    ['4-neon', '4 Neon', false],
  ]);
});

test('disambiguates labels that normalize to the same ID', () => {
  const rows = [
    { key: 'bard-mode-option-a', name: 'Test +' },
    { key: 'bard-mode-option-b', name: 'Test -' },
  ];
  assert.deepEqual(modelChoices(rows).map(({ id }) => id), ['test--a', 'test--b']);
});

test('rejects a reply when the requested model is no longer active in Gemini', async () => {
  const expected = { id: 'hydrogen', key: 'bard-mode-option-hydrogen', name: 'Hydrogen' };
  let state = [{ ...expected, checked: true }];
  let toggles = 0;
  const picker = { click: async () => { toggles++; } };
  const menu = {
    getByRole: () => ({ first: () => ({ waitFor: async () => {} }), evaluateAll: async () => state }),
    waitFor: async () => {},
  };
  const page = { locator: selector => selector.includes('mode-menu-button') ? picker : menu };
  await verifyModel(page, expected);
  state = [
    { ...expected, checked: false },
    { key: 'bard-mode-option-default', name: 'Auto', checked: true },
  ];
  await assert.rejects(verifyModel(page, expected), { status: 422, code: 'gemini_model_changed' });
  assert.equal(toggles, 4);
});
