# Gemini Web for OpenCode

Use the models available in your signed-in Gemini web account from OpenCode
through a local, OpenAI-compatible adapter.

## Requirements

- Node.js 22 or newer
- Google Chrome (set `CHROME_PATH` if it is outside its usual location)
- Access to Gemini and Temporary Chat on the account you sign in with

## Install

1. Install the CLI from npm. No git, no browser download, and no OpenCode
   config to hand-edit: the CLI drives the Chrome you already have, and step
   4 writes the config for you.

   ```sh
   npm install -g opencode-gemini-web
   ```

2. Sign in to Gemini. This opens Chrome with a dedicated browser profile that
   stores the session:

   ```sh
   opencode-gemini-web login
   ```

   Finish sign-in in the opened window. On a headless host, run the command on
   the host and use its existing remote desktop or browser dashboard. The
   command prints the loopback Chrome debug port for dashboards that attach
   through DevTools. If the host has a virtual desktop, run the command with
   that desktop's display environment.

3. Start the adapter once. It writes the local key file, listens on
   `127.0.0.1:19323`, and prints the key path. After step 5, OpenCode
   autostarts it for you:

   ```sh
   opencode-gemini-web start
   ```

4. In a second terminal, write the `gemini-web` provider and the autostart
   plugin into your OpenCode user config
   (`~/.config/opencode/opencode.json`) and print the model IDs:

   ```sh
   opencode-gemini-web sync
   ```

   The command reads Gemini's live Temporary Chat model picker. Run it again
   when you switch accounts or Gemini changes the available models. The
   original `gemini-web/hydrogen-thinking` ID is preserved when that option
   exists.

5. Restart OpenCode, open `/models`, and select a `gemini-web/...` model.
   On the first start after syncing, OpenCode installs the plugin in the
   background, so autostart kicks in from the next start.

Instead of a global install you can run any command without installing:
`npx opencode-gemini-web login` and so on.

If you used an earlier name of this repo, move your saved session to the new
state directory so you do not have to sign in again:

```sh
mv ~/.local/state/opencode-hydrogen ~/.local/state/opencode-gemini-web
```

## Configuration notes

The state directory defaults to `~/.local/state/opencode-gemini-web`. Set
`XDG_STATE_HOME` before running the commands to use a different state root.
The adapter and Chrome's debug port listen on loopback. Give access to the
browser profile and its debugger only to people who should control that Gemini
session.

To target a different JSON config, use
`opencode-gemini-web sync path/to/opencode.json`. If your config uses JSONC
comments or trailing commas, print the provider block with
`opencode-gemini-web sync --print` and merge it into your config.

## Troubleshooting

If OpenCode reports that your Gemini session expired, run
`opencode-gemini-web login` again, finish sign-in, and retry in the same
conversation. If OpenCode reports an invalid local adapter key, check that the
provider references the key path printed at startup. If a selected model is
unavailable, refresh the provider catalog with the sync command. If OpenCode
keeps retrying and failing, Gemini may be throttling sustained automation on
your account for a few minutes; wait between sessions.

## Behavior

Each request selects the requested model and sends the OpenCode transcript
through a fresh Gemini Temporary Chat. The adapter supports text and one tool call per reply. OpenCode can
run more tool calls in subsequent replies and applies its own tool permissions.
Streaming clients receive the completed reply as SSE.

Each reply costs a full Gemini web round-trip, so tool-heavy tasks take
minutes. If Gemini returns its own error page or claims it ran out of tool
calls, the adapter reports it as a retryable error and OpenCode retries the
request automatically.

While the plugin from step 4 is enabled, OpenCode checks on every start
whether the adapter answers on `127.0.0.1:19323` and spawns it detached when
it does not, so the models are ready as soon as OpenCode opens. The adapter
then keeps running after OpenCode exits; stop it with
`pkill -f "cli.mjs start"`. To turn autostart off, run the sync step again
after adding `"-opencode-gemini-web"` to the `plugins` list in your config.

## Working on the source

Clone the repository, run `npm ci`, and use `npm run login`, `npm start`,
`npm run sync-models`, and `npm test` in place of the global CLI. The `npm`
scripts run the same code as the CLI.
