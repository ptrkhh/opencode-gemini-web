# OpenCode Hydrogen Thinking

Use Gemini's **Hydrogen Thinking** web mode from OpenCode through a local,
OpenAI-compatible adapter. You need Node.js 22 or newer, Google Chrome, and a
Google account that offers **Hydrogen Thinking** in Gemini.

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

Merge this provider into your `opencode.json`:

```json
{
  "providers": {
    "gemini-web": {
      "name": "Gemini Web",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:19323/v1",
        "apiKey": "{file:~/.local/state/opencode-hydrogen/key}"
      },
      "models": {
        "hydrogen-thinking": {
          "name": "Hydrogen Thinking",
          "capabilities": { "tools": true }
        }
      }
    }
  }
}
```

Use the key path printed by `npm start` if you changed the state directory. If
your existing configuration has a provider allowlist, add `gemini-web` to it.
Run `opencode reload` and select `gemini-web/hydrogen-thinking` in `/models`.

```sh
opencode run -m gemini-web/hydrogen-thinking "Reply with one sentence."
```

If OpenCode reports that your Gemini session expired, run `npm run login` again,
finish sign-in, and retry in the same OpenCode session. If OpenCode reports an
invalid local adapter key, check that the provider references the key path
printed at startup. If the signed-in account lacks Hydrogen Thinking, the
adapter reports that the model is unavailable.

## Behavior

Each request sends the OpenCode transcript through a fresh Gemini Temporary
Chat. The adapter supports text and one tool call per reply. OpenCode can run
more tool calls in subsequent replies and applies its own tool permissions.
Streaming clients receive the completed reply as SSE.

Run `npm test` to check the adapter protocol and login-state handling.
