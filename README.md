# Gemini Web for OpenCode

Use the models available in your signed-in Gemini web account from OpenCode
through a local, OpenAI-compatible adapter.

## Requirements

- Node.js 22 or newer
- Python 3.11 or newer for direct HTTP
- Google Chrome for sign-in (set `CHROME_PATH` if it is outside its usual location)
- Access to Gemini and Temporary Chat on the account you sign in with

## Install

1. Install the CLI and set up the direct client in its own Python environment.
   Run these commands on Linux or macOS.

   ```sh
   npm install -g opencode-gemini-web
   adapter_state="${XDG_STATE_HOME:-$HOME/.local/state}/opencode-gemini-web"
   python3 -m venv "$adapter_state/python"
   "$adapter_state/python/bin/python" -m pip install 'gemini-webapi==2.1.1'
   ```

   On Windows, use `python -m venv <path>` and
   `<path>\Scripts\python.exe -m pip install gemini-webapi==2.1.1`. Set
   `GEMINI_PYTHON` to the interpreter if the environment is outside the adapter's
   state directory.

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

   The command reads the models available to the adapter's Gemini session.
   Restart the adapter after intentionally switching Google accounts and run
   sync again when Gemini changes the available models. The
   original `gemini-web/hydrogen-thinking` ID is preserved when that option
   exists.

5. Restart OpenCode, open `/models`, and select a `gemini-web/...` model.
   On the first start after syncing, OpenCode installs the plugin in the
   background, so autostart kicks in from the next start.

Instead of a global install you can run any command without installing:
`npx opencode-gemini-web login` and so on.

## Upgrading from 1.1.4 or earlier

Set up the Python environment from step 1 before starting the new direct
backend. To keep using the Chrome backend, start it with
`GEMINI_TRANSPORT=browser opencode-gemini-web start`.

Stop the previous adapter first, then run `opencode-gemini-web start` and
`opencode-gemini-web sync`. If OpenCode started the old adapter in the
background, find the adapter process listening on port `19323` and stop that
process. You can reuse your existing Chrome profile and adapter key.

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

The default transport uses HanaokaYuzu's `gemini-webapi` Python client. Set
`GEMINI_PYTHON` to select an existing environment with the pinned version.
Start the adapter with `GEMINI_TRANSPORT=browser` to use Chrome for generation
and model discovery.

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

The direct worker starts with the session cookies from the dedicated Chrome
profile. HanaokaYuzu refreshes Google's short-lived `__Secure-1PSIDTS` cookie
about every ten minutes while the session is authenticated. The adapter keeps
the worker's cookie cache in a private temporary directory and deletes it
when the worker exits. If Google rejects the session, the next request starts a
new worker from Chrome's current cookies. If Chrome also needs sign-in, use
the login command.

Run `opencode-gemini-web login` if Google shows a challenge in Chrome. Finish
the challenge manually before retrying. When Gemini rate-limits requests,
the adapter pauses work for at least the reported retry interval or for a
minute if Gemini provides no interval. The direct backend pauses only the
requested model when Gemini reports a model usage limit.

`opencode-gemini-web smoke [model]` sends a synthetic request of about 40 KB
and checks for the expected reply. Pass a model ID to use it directly or omit
it to choose from Gemini's current menu. The command uses one real Gemini
reply.

## Behavior

The direct backend starts a Gemini Temporary Chat with the full OpenCode
transcript. For tool-enabled requests carrying an exact
`x-opencode-session-id`, it sends only the new messages when the incoming
transcript extends the previous one and the model and tool instructions still
match. The adapter starts a fresh chat for a repeated request, a transcript rewrite
such as compaction, or a model or tool change. If Gemini loses a retained chat,
the adapter resends the full transcript once. The cache holds up to 32 chats
in memory and reuses a chat for at most 40 turns or 30 minutes of inactivity.
Other requests and the Chrome fallback use fresh chats.

Chrome provides the signed-in session at worker startup and after an
authentication failure. Clients can
request a batch of independent tool calls with `parallel_tool_calls: true`.
OpenCode applies its own tool
permissions. The direct backend streams text as Gemini produces it for
requests without active tools. Replies that can contain tool calls are
validated in full before the adapter sends them as SSE. The Chrome fallback
sends complete replies as SSE.

When a reply contains an unusable tool call, claims its tool budget ran out, or
asks for “reply to continue” before an available action, the adapter tries one
short correction in the same Temporary Chat. The operation has a five-minute
limit. The adapter processes one request at a time and removes
queued requests when their clients disconnect.

While the plugin from step 4 is enabled, OpenCode checks the adapter's local
health endpoint at startup and spawns it detached if the port is unreachable.
The health check uses no Gemini browser session. The adapter keeps running
after OpenCode exits. To turn autostart off, run the sync step again after
adding `"-opencode-gemini-web"` to the `plugins` list in your config.

## Working on the source

Clone the repository, run `npm ci`, and install `requirements.txt` into the
adapter's Python environment. Use `npm run login`, `npm start`,
`npm run sync-models`, and `npm test` in place of the global CLI.
Run `python -m unittest direct_worker_test` from that environment to test the
Python worker.
