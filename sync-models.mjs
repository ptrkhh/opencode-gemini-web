import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './browser.mjs';

const providerId = 'gemini-web';
const baseURL = 'http://127.0.0.1:19323/v1';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function syncConfig(config, catalog, keyPath) {
  if (!isObject(config)) throw new Error('OpenCode configuration must be a JSON object.');
  if (!Array.isArray(catalog) || !catalog.length) throw new Error('Gemini returned an empty model list.');
  if (catalog.some(model => !model || typeof model.id !== 'string' || !model.id || typeof model.name !== 'string' || !model.name)) {
    throw new Error('Gemini returned an invalid model list.');
  }
  const legacy = config.provider?.[providerId] !== undefined;
  if (legacy && config.providers?.[providerId] !== undefined) {
    throw new Error('OpenCode has gemini-web in both provider sections. Keep a single gemini-web entry before syncing.');
  }
  const section = legacy ? 'provider' : 'providers';
  const connection = legacy ? 'options' : 'settings';
  const previous = config[section]?.[providerId];
  if ((config[section] !== undefined && !isObject(config[section])) ||
      (previous !== undefined && !isObject(previous))) {
    throw new Error('OpenCode configuration has an invalid provider section.');
  }
  const previousURL = previous?.[connection]?.baseURL;
  if (previousURL && previousURL !== baseURL) {
    throw new Error('The existing gemini-web provider uses a different endpoint.');
  }
  const models = Object.fromEntries(catalog.map(({ id, name }) => {
    const prior = Object.hasOwn(previous?.models ?? {}, id) ? previous.models[id] : {};
    return [id, legacy
      ? { tool_call: true, ...prior, name }
      : { ...prior, name, capabilities: { tools: true, ...prior?.capabilities } }];
  }));
  const provider = {
    ...previous,
    name: previous?.name ?? 'Gemini Web',
    ...(legacy
      ? { npm: previous?.npm ?? '@ai-sdk/openai-compatible' }
      : { package: previous?.package ?? '@opencode/ai/providers/openai-compatible' }),
    [connection]: { ...previous?.[connection], baseURL, apiKey: `{file:${keyPath}}` },
    models,
  };
  return {
    ...config,
    [section]: { ...config[section], [providerId]: provider },
    ...(Array.isArray(config.enabled_providers)
      ? { enabled_providers: [...new Set([...config.enabled_providers, providerId])] }
      : {}),
  };
}

function readConfig(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function main() {
  const [argument] = process.argv.slice(2);
  const keyPath = join(stateDir, 'key');
  const key = readConfig(keyPath)?.trim();
  if (!key) throw new Error('Start the adapter with npm start before syncing OpenCode.');
  const response = await fetch(baseURL + '/models', {
    headers: { Authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(45_000),
  }).catch(error => { throw new Error('Could not reach the running Gemini Web adapter.', { cause: error }); });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? 'Could not read the Gemini models.');
  const catalog = result.data;
  if (argument === '--print') {
    console.log(JSON.stringify(syncConfig({}, catalog, keyPath), null, 2));
    return;
  }

  const directory = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
  const jsonc = join(directory, 'opencode.jsonc');
  const target = resolve(argument ?? (existsSync(jsonc) ? jsonc : join(directory, 'opencode.json')));
  const path = existsSync(target) ? realpathSync(target) : target;
  const original = readConfig(path);
  let config;
  try {
    config = original === undefined ? {} : JSON.parse(original);
  } catch {
    throw new Error(`Could not parse ${target} as JSON. Run npm run --silent sync-models -- --print and merge the provider into that file.`);
  }
  const updated = JSON.stringify(syncConfig(config, catalog, keyPath), null, 2) + '\n';
  if (updated !== original) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = path + '.' + randomUUID();
    writeFileSync(temporary, updated, { flag: 'wx', mode: 0o600 });
    try {
      if (readConfig(path) !== original) throw new Error('OpenCode configuration changed during the sync. Run the command again.');
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  console.log(`Synced ${catalog.length} Gemini models to ${target}.`);
  console.log(catalog.map(({ id, name }) => `gemini-web/${id}  ${name}`).join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
