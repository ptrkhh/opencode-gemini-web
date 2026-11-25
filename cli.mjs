#!/usr/bin/env node
// Published bin entry. npm scripts run the target files directly for development.
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'login') await import('./login.mjs');
else if (cmd === 'smoke') await import('./smoke.mjs');
else if (cmd === 'start') await import('./serve.mjs');
else if (cmd === 'sync') await import('./sync-models.mjs').then(({ main }) => main(rest));
else {
  console.error('Usage: opencode-gemini-web <login|start|smoke|sync [config.json|--print]>');
  process.exitCode = 1;
}
