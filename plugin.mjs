import { Plugin } from '@opencode/plugin';
import { ensureServer } from './autostart.mjs';

export default Plugin.define({
  id: 'opencode-gemini-web',
  async setup() {
    await ensureServer().catch(() => {});
  },
});
