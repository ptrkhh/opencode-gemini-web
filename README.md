# Gemini Web for OpenCode

Use the models available in your signed-in Gemini web account from OpenCode
through a local, OpenAI-compatible adapter. You need Node.js 22 or newer,
Google Chrome, and access to Gemini and Temporary Chat.

## Sign in and start

```sh
npm ci
npm run login
npm start
```

Sign in through the Chrome window opened by the login command. The adapter
keeps the session in a dedicated browser profile. On a headless host, run the
login command on the host and use its existing remote desktop or browser
dashboard. The command prints the loopback Chrome debug port for dashboards
that attach through DevTools. If the host has a virtual desktop, run the
command with that desktop's display environment.

The state directory defaults to `~/.local/state/opencode-hydrogen`. Set
`XDG_STATE_HOME` before running both commands to use a different state root.
Set `CHROME_PATH` if Chrome is installed outside its usual location. The
adapter and Chrome's debug port listen on loopback. Give access to the browser
profile and its debugger only to people who should control that Gemini session.

## Connect OpenCode

With the adapter running and Gemini signed in, sync the model list and reload
OpenCode.

```sh
npm run sync-models
opencode reload
```

The sync command reads Gemini's live Temporary Chat model picker through the
adapter's `GET /v1/models` endpoint. It updates the `gemini-web` entry in your
OpenCode user config, then prints the IDs you can select in `/models`. Run it
again when you switch accounts or Gemini changes the available models. The
original `gemini-web/hydrogen-thinking` ID is preserved when that option exists.

To target a different JSON config, use `npm run sync-models -- path/to/opencode.json`.
If your config uses JSONC comments or trailing commas, print the provider block
with `npm run --silent sync-models -- --print` and merge it into your config.

If OpenCode reports that your Gemini session expired, run `npm run login` again,
finish sign-in, and retry in the same conversation. If OpenCode reports an
invalid local adapter key, check that the provider references the key path
printed at startup. If a selected model is unavailable, refresh the provider
catalog with the sync command.

## Behavior

Each request selects the requested model and sends the OpenCode transcript
through a fresh Gemini Temporary Chat. The adapter supports text and one tool call per reply. OpenCode can run
more tool calls in subsequent replies and applies its own tool permissions.
Streaming clients receive the completed reply as SSE.

Run `npm test` to check the adapter protocol and login-state handling.
