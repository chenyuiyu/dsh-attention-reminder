# dsh-attention-reminder

Sound and on-screen alerts for DeepSeek Harness: when the agent needs **your approval** (an `approval/request`) or **an answer** (`ask_user_question`), the plugin strikes a short chime, raises the DSH window, and floats a card above the page.

Two independent toggles — **sound** and **popup** — both remembered across reloads and restarts.

## Install

```sh
dsh plugin --profile <profile> add github:OWNER/dsh-attention-reminder
```

On DSH Desktop, install it from **Settings → Plugins**. The plugin is plain JavaScript: no build step, no dependencies.

## The two toggles

Both live behind the 🔔 button at the right end of the session header.

- **Sound** — one bell strike (WebAudio, ~0.5 s). While something is still waiting it repeats every 4 s, up to 6 times, then stops.
- **Popup** — `window.focus()` to put DSH in front, a floating card above the page naming what is waiting (up to 3 cards, the rest folded into “+N more”), and a system notification where the browser allows one.

The panel also has **Send a test reminder**, which travels the same path as a real alert.

Toggles are stored in `$DSH_HOME/plugin-data/dsh-attention-reminder/state.json` (default `~/.dsh/plugin-data/...`).

## How it works

- **Host half** ([index.js](index.js)) listens to the waterfall events `approval/request` and `user-questions/request` and keeps the unanswered ones in a bounded queue (24 entries). An entry leaves the queue when the promise returned by `next()` settles or the request's `AbortSignal` aborts. It only observes: every handler delegates with `return next()`, so approvals and questions behave exactly as before. The queue and the toggles are served as `GET/POST /api/attention-reminder` through `connection.fetch.register`.
- **Web half** ([client.js](client.js)) polls that route once a second and announces only ids it has not seen yet. Cards register into `shell.overlay`; the 🔔 panel into `conversation.session.header.utilities`.

Plugins have no host-to-page push channel, which is why the page polls; `@deepseek-ai/dsh-deja` uses the same HTTP route pattern.

## Notes

- Audio starts after one interaction with the page — a browser rule, not this plugin. If DSH was just opened and an alert fires before you touched anything, one click on the page fixes it and the next alert is audible.
- `window.focus()` cannot always beat the Windows foreground lock; the floating card and the system notification still appear.
- The system notification needs the browser's notification permission, requested the first time you enable popup or press the test button (both are user gestures).

## License

MIT
