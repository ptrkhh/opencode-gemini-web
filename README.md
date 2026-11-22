# Gemini Web for OpenCode

Use the models available in your signed-in Gemini web account from OpenCode
through a local, OpenAI-compatible adapter.

## Requirements

- Node.js 22 or newer
- Google Chrome (set `CHROME_PATH` if it is outside its usual location)
- Access to Gemini and Temporary Chat on the account you sign in with

## Install

1. Clone the repository and install its dependencies:

   ```sh
   git clone https://github.com/ptrkhh/opencode-gemini-web.git
   cd opencode-gemini-web
   npm ci
   ```

   This only installs `playwright-core`. There is no browser to download and
   no OpenCode config to hand-edit: the adapter drives the Chrome you already
   have, and step 4 writes the config for you.

2. Sign in to Gemini. This opens Chrome with a dedicated browser profile that
   stores the session:

   ```sh
   npm run login
   ```

   Finish sign-in in the opened window. On a headless host, run the command on
   the host and use its existing remote desktop or browser dashboard. The
   command prints the loopback Chrome debug port for dashboards that attach
   through DevTools. If the host has a virtual desktop, run the command with
   that desktop's display environment.

3. Start the adapter. It listens on `127.0.0.1:19323` and prints the path of
   its key file; keep it running:

   ```sh
   npm start
   ```

4. In a second terminal, write the `gemini-web` provider into your OpenCode
   user config (`~/.config/opencode/opencode.json`) and print the model IDs:

   ```sh
   npm run sync-models
   ```

   The command reads Gemini's live Temporary Chat model picker. Run it again
   when you switch accounts or Gemini changes the available models. The
   original `gemini-web/hydrogen-thinking` ID is preserved when that option
   exists.

5. Restart OpenCode, open `/models`, and select a `gemini-web/...` model.

If you used an earlier name of this repo, move your saved session to the new
state directory so you do not have to sign in again:

```sh
mv ~/.local/state/opencode-hydrogen ~/.local/state/opencode-gemini-web
```

## Configuration notes

The state directory defaults to `~/.local/state/opencode-gemini-web`. Set
`XDG_STATE_HOME` before running both commands to use a different state root.
The adapter and Chrome's debug port listen on loopback. Give access to the
browser profile and its debugger only to people who should control that Gemini
session.

To target a different JSON config, use `npm run sync-models -- path/to/opencode.json`.
If your config uses JSONC comments or trailing commas, print the provider block
with `npm run --silent sync-models -- --print` and merge it into your config.

## Troubleshooting

If OpenCode reports that your Gemini session expired, run `npm run login` again,
finish sign-in, and retry in the same conversation. If OpenCode reports an
invalid local adapter key, check that the provider references the key path
printed at startup. If a selected model is unavailable, refresh the provider
catalog with the sync command.

## Behavior

Each request selects the requested model and sends the OpenCode transcript
through a fresh Gemini Temporary Chat. The adapter supports text and one tool call per reply. OpenCode can
run more tool calls in subsequent replies and applies its own tool permissions.
Streaming clients receive the completed reply as SSE.

Run `npm test` to check the adapter protocol and login-state handling.
