# pi-ask-user-question

> **Fork of [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) v2.12.0** by [juicesharp](https://github.com/juicesharp) (MIT).
> Upstream project: [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono). All credit for the
> questionnaire tool, dialog UI, state machine, and docs goes to the upstream author.
>
> **This fork adds one feature: unattended auto-advance.** When the questionnaire has been
> waiting for user input longer than a configurable timeout (default 5 minutes), the run is
> presumed unattended and the tool stops blocking — it auto-selects an answer (the
> `"(Recommended)"` option, or the first) or treats the questionnaire as declined, so the
> agent can keep making progress without a human at the terminal. See
> [Unattended timeout](#unattended-timeout-fork-addition).
>
> Fork changes are marked in the source with `Fork addition` comments to keep upstream merges easy.

[![npm version](https://img.shields.io/npm/v/@juicesharp/rpiv-ask-user-question.svg)](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<div align="center">
  <a href="https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question">
    <img src="https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/cover.png" alt="rpiv-ask-user-question cover: a tabbed terminal questionnaire asking Which real development task are we planning right now?, with numbered options — Bug fix, New feature, Refactor — each under a one-line description, and a footer of key hints" width="50%">
  </a>
</div>

Let the model ask you instead of guessing. This extension gives [Pi Agent](https://github.com/badlogic/pi-mono) one tool — `ask_user_question` — that opens a terminal dialog of up to four questions with written-out options, and hands your choices back as structured data. Install it if you would rather spend fifteen seconds picking than an hour undoing a wrong assumption.

## Install

```sh
# this fork (from GitHub)
pi install git:github.com/SomeTestZero/pi-ask-user-question

# upstream original (no auto-advance)
pi install npm:@juicesharp/rpiv-ask-user-question
```

Restart your Pi session.

## Quick start

Nothing to set up — the tool is live as soon as Pi restarts. Hand the model a task with a real decision buried in it:

> Add caching to the API client.

Rather than picking a strategy on your behalf, the model calls `ask_user_question` and a dialog takes over the bottom of your terminal. Move with `↑`/`↓`, choose with `Enter`, press `n` to attach a note to a question — or a global note to the whole questionnaire from the Submit tab — or land on the `Type something.` row to answer in your own words. While typing, `Shift+Enter` adds a line, `Ctrl+G` opens Pi's configured external editor, and `Ctrl+U` clears the draft; browsing another option and returning keeps what you wrote. `Esc` abandons the questionnaire entirely.

When the questionnaire begins waiting in an interactive TTY, it emits one standard terminal BEL (`\x07`). Your terminal configuration determines whether that appears as an audible alert, a visual alert, or nothing; redirected and non-TTY output is untouched.

![Single question in the dialog: the tab strip reads Feature Type, Design Tab, Testing, Release, Submit; the question Which real development task are we planning right now? sits above four numbered options — Bug fix (Recommended), New feature, Refactor, Perf tuning — each with a one-line description, followed by the appended Type something. row](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/single-question.jpg)

When the model asks several things at once, `Tab` moves between them and a Submit tab reviews everything before it goes back:

![Submit tab of a four-question dialog: a Review your answers list showing Feature Type set to Bug fix and Testing set to Unit tests plus Integration tests, a warning naming Design Tab and Release as still unanswered, a picker offering Submit answers or Cancel, and a dim bottom key-hint row including n to add a note](https://raw.githubusercontent.com/juicesharp/rpiv-mono/main/packages/rpiv-ask-user-question/docs/submit-tab.jpg)

## What you get

- **Typed options instead of a wall of prose** — each question carries 2-4 authored choices, and every choice comes with a description of what it means or what it costs you.
- **You can always answer in your own words** — a `Type something.` row is appended to every question, single- or multi-select, widens to the full pane while you type, keeps its multiline draft visible in that row while you browse, and supports Pi's `Shift+Enter` newline and `Ctrl+G` external-editor flows.
- **Compare real artifacts, not just labels** — an option can carry a markdown `preview` (ASCII mockup, code, diagram, config) that renders in a bordered box beside the option list.
- **One interruption, not five** — up to four questions arrive in a single tabbed dialog, and the Submit tab lists your answers and names anything still blank before you commit.
- **Notes on any answer — or on all of them** — `n` opens a multiline note editor on any question tab, and on the Submit tab it opens one global note for the whole questionnaire. Per-question notes reach the model as `user notes: <text>`, the global note as `global note: <text>`; neither marks a question answered.
- **Read the transcript behind the dialog** — the mouse wheel and the transcript scroll keys (`PageUp`/`PageDown`, `Home`/`End`, and the `tui.altScreen.*` bindings) scroll the conversation while the dialog is up; `Ctrl+]` collapses the overlay entirely when you want it out of the way, and brings it back with your answers intact.
- **Works outside the terminal too** — in RPC and ACP hosts such as the VS Code pendant or Zed the questionnaire walks through the host's native dialogs (notes are terminal-only and do not carry over), and in non-interactive runs the tool is removed from the model's tool list instead of failing every call.

## Configuration

Optional. Settings live in `~/.config/rpiv-ask-user-question/config.json`; the file is read, never written.

| Setting | What it does | Default |
| --- | --- | --- |
| `collapseKey` | Key that collapses and expands the dialog. Accepts Pi keybinding ids such as `alt+o`; `"off"` disables the shortcut. | `"ctrl+]"` |
| `guidance.description` | Full replacement for the tool description the model sees. A non-empty string replaces the built-in text entirely — no merging. | built-in description |
| `guidance.promptSnippet` | One-line description of the tool in the system prompt — tune how eagerly the model asks. | built-in snippet |
| `guidance.promptGuidelines` | Usage guidelines given to the model, as a list of strings. | 4 built-in guidelines |
| `timeout.minutes` | Unattended timeout — minutes of unanswered input before auto-advance fires. `0` (or any non-positive value) disables it and restores the upstream block-until-answered behavior. Values are clamped to [0.25, 240]. | `5` |
| `timeout.action` | What auto-advance does on timeout: `"recommended"` picks the "(Recommended)"-marked option (else the first), `"first"` always picks the first option, `"decline"` treats it as declined so the model decides itself. | `"recommended"` |

```json
{ "collapseKey": "alt+o", "timeout": { "minutes": 5, "action": "recommended" } }
```

Malformed JSON falls back to the defaults with a warning; an individual unusable value is silently dropped back to its default. Never an error.

### Unattended timeout (fork addition)

Without this fork, `ask_user_question` blocks the agent until a human answers — walk away from
the keyboard mid-questionnaire and the task stalls indefinitely. With auto-advance:

- After `timeout.minutes` (default 5) with no input, the dialog completes itself through Pi's
  normal completion path (the overlay is disposed cleanly — no orphaned UI) and the agent
  continues.
- The tool result is explicitly labelled `AUTO-ADVANCED`, every auto-selected answer carries
  `user notes: auto-selected after <n> minutes timeout (unattended run)`, and the text tells
  the model to *treat the choices as defaults*, so automatic picks are never mistaken for
  user ground truth.
- The model is nudged to surface the automatic choices in its reply, so you can review and
  override them when you return.
- `timeout.action: "decline"` returns the canonical `User declined to answer questions`
  envelope instead — the model then decides everything itself. Pick this if you prefer full
  autonomy over default-picking.
- On RPC/ACP hosts (VS Code pendant, Zed) the timeout applies too, but native dialogs the
  walker already opened cannot be withdrawn — they may linger on screen until dismissed.
- Everything is pure TypeScript, same as upstream: no native dependencies, no model calls,
  no network. The timer is `unref`'d so it never holds a process open.

## Reference

- [Tool schema](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/tool-schema.md) — parameters, limits, reserved labels, validation errors, the result envelope, and the `rpiv:ask-user:prompt` event.
- [Keyboard and layout](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/keyboard.md) — every key, the rows the dialog appends, notes, collapse mode, and how previews and overflow adapt to terminal size.
- [Configuration](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/configuration.md) — file lookup and `XDG_CONFIG_HOME`, the `collapseKey` grammar, the `guidance.*` prompt overrides, and how invalid values are handled.
- [Hosts and runtime behavior](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/hosts.md) — terminal vs RPC vs non-interactive, what degrades in each, and the load-failure envelopes.
- [Localization](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/docs/localization.md) — the nine shipped languages, how the locale is chosen, and how to add one.

## Requirements

- Node.js 22 or newer.
- Pi Agent, with an interactive terminal or an RPC/ACP host. Non-interactive runs never see the tool.
- A terminal at least 100 columns wide for side-by-side previews; narrower terminals stack the preview under the options.

No native dependencies, no compiler, no API keys — the extension makes no model calls of its own.

## Troubleshooting

**The model says the questionnaire UI failed to load and asks its questions as chat text.** The dialog's modules were replaced on disk while Pi was running, usually by a package-manager install touching the store. Repair the install if it is broken, then restart Pi; the failure is not recoverable inside the running process.

**`Ctrl+]` does nothing.** On keyboard layouts where `]` sits on the shifted layer (Latin American among them) the default is unreachable. Set `collapseKey` to something you can type, for example `"alt+o"`.

## Related

- [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n) — optional; installing it renders the dialog chrome in your language and adds `/languages`.
- [`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi) — the umbrella package whose workflow skills use `ask_user_question` as their developer checkpoint. `/rpiv-setup` offers to install this extension.

## License

MIT — see [LICENSE](./LICENSE). Upstream license: [juicesharp/rpiv-mono](https://github.com/juicesharp/rpiv-mono/blob/main/packages/rpiv-ask-user-question/LICENSE).
