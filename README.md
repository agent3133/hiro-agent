# Hiro Agent (Beta)

**An agent that lives inside Obsidian, works on your notes through your own model, and needs no server of its own,
no subscription, and no terminal window to do it.**

![The chat beside a daily note: the agent's tool calls and its answer, and an agent asked about the open note](images/chat.png)

> **This is a beta.** Hiro Agent is not in Obsidian's community plugin list yet: it is installed through BRAT (see
> [Install](#install)) while a handful of testers try it. Expect rough edges, and please
> [report them](#feedback-and-issues) — the [known issues](#known-issues) are listed below.

## What this is

Hiro Agent puts a chat agent in Obsidian's sidebar that can read, search, write, move and delete notes on your
behalf — through a model you choose, running wherever you choose to run it. Point it at a local llama.cpp server or
any OpenAI-compatible API, and it works. There is nothing else to install to get there, nothing else to keep
running in a terminal window, and nothing leaves your machine except the connections you explicitly turn on.

## Why Hiro, and not Copilot or Claudian?

There are two well-established alternatives — [Copilot](https://github.com/logancyang/obsidian-copilot) and
[Claudian](https://github.com/YishenTu/claudian) — and both are good plugins. The difference is architectural.
As their READMEs described them on 2026-09-30:

| | Hiro Agent | Copilot | Claudian |
|---|---|---|---|
| **Agent reads, writes, moves and deletes notes** | Yes — through any OpenAI-compatible API or a local llama.cpp server | Yes, in Agent Mode, which runs opencode, Claude Code or Codex as a local process | Yes — through an installed agent CLI |
| **Extra software required** | None for a cloud API; llama.cpp only for a local model | opencode, Claude Code or Codex, for Agent Mode | One of Claude Code, Codex CLI, Grok Build, OpenCode or Pi |
| **Shell / bash access** | None — no shell tools, no git | Whatever the CLI running underneath allows | Yes — bash is part of what the agents do |
| **Folder-scoped permissions** | Enforced by the tools — a restricted agent's tools refuse everything outside its folders | Not documented | Not documented in its README |
| **Destructive actions** | Asks first; undo with a diff | Not documented in detail | Approval through the agent CLI |
| **Small and local models** | Tool results cut to a quarter of the context window; long conversations summarised | Local models for chat; no documented small-context handling | Depends on the CLI and provider chosen |
| **Pricing** | Free — the whole agent | Free core; paid Copilot Plus for hosted models, cloud tools and multi-agent | Free and open source; you pay your model provider |
| **Mobile** | Not yet | Agent Mode is desktop only; Quick Chat works on mobile | No |

### No shell, no git

This is worth calling out on its own, not just as a table row. Copilot's Agent Mode runs opencode, Claude Code or
Codex underneath — tools built with full shell access by design. Claudian's agents run bash in your vault as an
advertised feature. Hiro's agent has **no shell tool and no git tool at all**, by design: it can only call the
specific, structured tools it is given — `read_note`, `move_note`, `search_vault`, `web_fetch` and the others
listed below. There is no command line for it to drop into, and no way for a bad tool call, a malformed response,
or a prompt injection buried in a note or a web page to run something outside those tools. That is a smaller,
more auditable attack surface than "an agent with a terminal", not just a different one.

## Requirements

| | |
|---|---|
| **Obsidian** | 1.12.2 or later |
| **Platform** | Desktop — Windows, macOS, Linux |
| **A model** | A llama.cpp server, or an OpenAI-compatible API with a key |
| **Optional** | whisper.cpp and ffmpeg (recordings and videos), MCP servers (more tools — web search among them) |

Tested by hand on Windows; the build and the test suite run on Windows, macOS and Linux for every release. On
macOS, a program installed with Homebrew is found by its name; a full path always works.

## Install

- **With BRAT (the beta):**
  1. Install **BRAT** from Settings → Community plugins → Browse (search for "BRAT") and enable it.
  2. Run **BRAT: Add a beta plugin for testing** from the command palette and enter `agent3133/hiro-agent`.
  3. Enable **Hiro Agent** under Settings → Community plugins. BRAT keeps it up to date with each beta release.
- **From Community plugins:** once it is listed — not yet during the beta.
- **Manually:** download `main.js`, `manifest.json` and `styles.css` from the
  [latest release](https://github.com/agent3133/hiro-agent/releases/latest) into `<vault>/.obsidian/plugins/agent/`,
  then enable **Hiro Agent** under Settings → Community plugins.

## Quick start

1. Open the chat from the ribbon (the bot icon), or run **Hiro Agent: Open the chat**.
2. Set up a connection. The chat offers it on the first start: a llama.cpp server on `127.0.0.1:8080` or `:8090`
   is found and added with one click; any OpenAI-compatible API takes a URL, a model and a key under Settings →
   Hiro Agent → General.
3. Ask it something about your vault. It streams its answer, shows each tool call as it makes it, and asks first
   before deleting, moving or overwriting a note.

## What it can do

- **Chat sidebar** — an agent that reads, searches, writes, moves and deletes notes; each tool call is shown as it
  happens, with its result.
- **Any model you choose** — a local llama.cpp server or any OpenAI-compatible API, several connections side by
  side, switchable per conversation.
- **Agents** — three built in (a general assistant, a daily note, a weekly review), plus your own, written as
  Markdown files in your vault's `.agents/` folder. No proprietary format: they sync and version with the vault
  like any other note.
- **Folder restrictions enforced by the tools**, not just requested in a prompt: a restricted agent's tools refuse
  everything outside its folders, and the agent is told so.
- **Conversations kept as notes**, and an undo button for anything a turn changed — it shows the diff first.
- **Attachments** — images, PDFs page by page, voice recordings and videos, transcribed on your computer with
  whisper.cpp and ffmpeg.
- **Web pages** — the agent can open a page. Off until you switch it on, and marked as sending data off your
  machine. Web search comes from an MCP server of your choice.
- **MCP servers** — tools from other programs on your computer or from HTTP services, if you want to extend what
  the agent can reach.
- **Commands and a CLI** — ask an agent about the open note or the selection from the command palette, or run the
  agent from a terminal with `obsidian agent:ask` while Obsidian is running.

The tools, grouped as the Agents tab shows them — each agent gets only the ones it lists:

| Group | Tools |
|---|---|
| Read notes | `read_note`, `read_notes`, `list_notes`, `find_notes`, `search_vault`, `list_tags`, `note_outline`, `get_backlinks`, `get_outlinks`, `get_metadata`, `find_broken_links`, `read_attachment` |
| Write notes | `create_note`, `edit_note`, `append_to_note`, `update_note`, `update_metadata`, `create_from_template` |
| Delete and move | `delete_note`, `move_note` |
| Tasks | `list_tasks`, `list_tasknotes`, `create_tasknote`, `complete_tasknote` |
| Obsidian | `daily_note`, `list_templates`, `open_in_obsidian` |
| Web | `web_fetch` |
| Memory (when on) | `read_user_memory`, `update_user_memory` |

Everything in detail: **[the guide](docs/guide.md)**.

![Taking a turn back: the undo dialog shows the diff of what the agent changed](images/undo.png)

![The Agents tab: an agent's prompt, and below it the folders and tools it may use](images/agents.png)

## Privacy and security

- **Keys live only in Obsidian's keychain.** A setting names a key as `${NAME}`; a key typed into a settings field
  is refused, and none is ever written to the plugin's saved settings.
- **Nothing leaves your machine except what you configure:** the model connection you chose, web pages when you
  switched them on, and HTTP MCP servers you added. No telemetry, ever.
- **Programs outside Obsidian** run only as you configure them: whisper.cpp and ffmpeg for recordings, and MCP
  servers you add — a program-based (stdio) MCP server starts only after you approve its exact command line on
  that device. Apart from those — and a temporary folder the audio programs work in — the plugin reads and writes
  only your vault.
- **No shell tools, no git** — see above. This is not a permission you can grant later; the tools do not exist.
- **Destructive actions ask first.** Deleting, moving or overwriting a note shows a dialog naming exactly what will
  happen; dismissing it means no.
- **Undo is real.** A turn that changed notes gets an undo button showing the diff, and it will not touch a file
  you have edited since.
- **Folder restrictions are structural**, enforced by the tools themselves, not by asking the model nicely.
- **Desktop only**, because it runs those programs and streams the model's answer over Node's `http` — Obsidian's
  own `requestUrl` cannot stream.

## Free, forever

The full feature set in this release — chat, agents, tools, MCP, attachments, undo, memory, everything above — is
free, with no subscription and no paid tier gating any of it. If a paid tier is added later, it will be for
services that cost real money to run on an ongoing basis (for example, hosted model access with no separate
provider account to set up), never for functionality that is free today.

## Not in this release

- **Mobile** — desktop only for now; the plugin runs local programs and streams over Node's `http`.
- **Shell tools and git** — left out by design, and not on the roadmap.
- **Undo for turns run from the terminal** — the undo button belongs to turns run in the chat view.
- **Self-signed certificates** — only certificates your system already trusts.

## Known issues

Kept current during the beta; an issue listed here does not need reporting again.

- The plugin is tested by hand on Windows only. On macOS and Linux the build and the tests pass, but nobody has
  clicked through it yet — reports from those systems are especially welcome.

## Feedback and issues

Open an [issue](https://github.com/agent3133/hiro-agent/issues). Please include your Obsidian version, your
platform, and — if relevant — which model or connection you were using. **Hiro Agent: Show the agent's log** in
the command palette shows what the plugin logged; the last lines often say what went wrong.

## License

[GNU Affero General Public License v3.0 or later](LICENSE) — Copyright (C) 2026 Alex M. The packages bundled into
`main.js` keep their own licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
