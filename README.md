# Hiro Agent (Beta)

**An agent that lives inside Obsidian, works on your notes through your own model, and needs no server of its own,
no subscription, and no terminal window to do it.**

![The chat beside a daily note: the agent's tool calls and its answer, and an agent asked about the open note](images/chat.png)

> **This is a beta.** Hiro Agent is not in Obsidian's community plugin list yet: it is installed through BRAT (see
> [Install](#install)) while a handful of testers try it. It works well already; if you run into problems, please
> [report them](#feedback-and-issues) — the [known limitations](#known-limitations) are listed below.

## What this is

Hiro Agent puts a chat agent in Obsidian's sidebar that can read, search, write, move and delete notes on your
behalf — through a model you choose, running wherever you choose to run it. Point it at a model server on your computer
(llama.cpp, Ollama, LM Studio, vLLM) or any OpenAI-compatible API, and it works. There is nothing else to install to get there, nothing else to keep
running in a terminal window, and nothing leaves your machine except the connections you explicitly turn on.

This project grew out of the lack of privacy and flexibility in other AI plugins, and their heavy token use on
small tasks.

Hiro is built for small local models and small context windows. It is tested extensively with Ornith 1.5 9B (a
fine-tune of Qwen3.5-9B) with 8k to 64k of context. Larger models do better still: in our benchmark, a 27B model
(Qwen3.8-27B) passed about 85% of the tasks.

## Why Hiro, and not Copilot or Claudian?

There are two well-established alternatives — [Copilot](https://github.com/logancyang/obsidian-copilot) and
[Claudian](https://github.com/YishenTu/claudian) — and both are good plugins. The difference is architectural.
As their READMEs described them on 2026-09-30:

| | Hiro Agent | Copilot | Claudian |
|---|---|---|---|
| **Agent reads, writes, moves and deletes notes** | Yes — through any OpenAI-compatible API or a local server (llama.cpp, Ollama, LM Studio, vLLM) | Yes, in Agent Mode, which runs opencode, Claude Code or Codex as a local process | Yes — through an installed agent CLI |
| **Extra software required** | None for a cloud API; a model server (llama.cpp, Ollama …) only for a local model | opencode, Claude Code or Codex, for Agent Mode | One of Claude Code, Codex CLI, Grok Build, OpenCode or Pi |
| **Shell / bash access** | None — no shell tools, no git | Whatever the CLI running underneath allows | Yes — bash is part of what the agents do |
| **Folder-scoped permissions** | Enforced by the tools — a restricted agent's tools refuse everything outside its folders | Not documented | Not documented in its README |
| **Small and local models** | Tool results cut to a quarter of the context window; long conversations summarised | Local models for chat; no documented small-context handling | Depends on the CLI and provider chosen |

### No shell

This is worth calling out on its own, not just as a table row. Copilot's Agent Mode runs opencode, Claude Code or
Codex underneath — tools built with full shell access by design. Claudian's agents run bash in your vault as an
advertised feature. Hiro's agent has **no shell tool at all**, by design: it can only call the
specific, structured tools it is given — `read_note`, `move_note`, `search_vault`, `web_fetch` and the others
listed below. There is no command line for it to drop into, and no way for a bad tool call, a malformed response,
or a prompt injection buried in a note or a web page to run something outside those tools. That is a smaller,
more auditable attack surface than "an agent with a terminal", not just a different one.

Advanced users can add shell access on purpose, through an MCP server that provides it. A program-based MCP server
runs only after you approve its exact command line on each device — see [the guide](docs/guide.md#settings).

## Requirements

| | |
|---|---|
| **Obsidian** | 1.12.2 or later |
| **Platform** | Desktop — Windows, macOS, Linux |
| **A model** | A model server on your computer — llama.cpp, Ollama, LM Studio or vLLM — or an OpenAI-compatible API with a key. llama.cpp is the one tested most; the others speak the same API. |
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
2. Set up a connection. The chat offers it on the first start: a server on this computer's usual ports
   (llama.cpp 8080, Ollama 11434, LM Studio 1234, vLLM 8000) is found and added with one click; any OpenAI-compatible API takes a URL, a model and a key under Settings →
   Hiro Agent → Connections → Add connection.
3. Ask it something about your vault. It streams its answer, shows each tool call as it makes it, and asks first
   before deleting, moving or overwriting a note.

## What it can do

- **Chat sidebar** — an agent that reads, searches, writes, moves and deletes notes; each tool call is shown as it
  happens, with its arguments and its result.
- **Any model you choose** — a local server (llama.cpp, Ollama, LM Studio, vLLM) or any OpenAI-compatible API, several connections side by
  side, switchable per conversation.
- **Agents** — three built in (a general assistant, a daily note, a weekly review), plus your own, written as
  Markdown files in your vault's `.agents/` folder. No proprietary format: they sync and version with the vault
  like any other note.
- **Folder restrictions enforced by the tools**, not just requested in a prompt: a restricted agent's tools refuse
  everything outside its folders, and the agent is told so.
- **Conversations kept as notes** — several chats at once, each conversation renamed as you like and listed newest
  first, optionally with the tool calls of each answer so you can check later what the agent did — and an undo
  button for anything an answer changed, which shows the diff first.
- **Attachments** — images, PDFs (as text, or page by page when scanned), Word, Excel, PowerPoint and OpenDocument
  files, EPUB books, canvases and text files as text, voice recordings and videos, transcribed on your computer with
  whisper.cpp and ffmpeg. The agent lists, moves and deletes the files in your vault that are not notes. Drop files
  onto the chat, or press **+**, to give the agent something that is not in the vault yet.
- **Bases** — the agent runs a Base and reads its rows as Obsidian computes them: a `.base` file, a Base embedded in
  a note, or one it writes for the question. Needs the Bases core plugin.
- **Web pages** — the agent can open a page. Off until you switch it on, and marked as sending data off your
  machine. Web search comes from an MCP server of your choice.
- **MCP servers** — tools from other programs on your computer or from HTTP services, if you want to extend what
  the agent can reach.
- **Commands and a CLI** — ask an agent about the open note or the selection from the command palette, or run the
  agent from a terminal with `obsidian agent:ask` while Obsidian is running.

The tools, grouped as the Agents tab shows them — each agent gets only the ones it lists:

| Group | Tools |
|---|---|
| Read notes | `read_note`, `read_notes`, `list_notes`, `find_notes`, `search_vault`, `list_tags`, `note_outline`, `get_backlinks`, `get_outlinks`, `get_metadata`, `find_broken_links`, `list_attachments`, `read_attachment` |
| Write notes | `create_note`, `edit_note`, `append_to_note`, `update_note`, `update_metadata`, `create_from_template` |
| Delete and move | `delete_note`, `move_note` |
| Tasks | `list_tasks`, `list_tasknotes`, `create_tasknote`, `complete_tasknote` |
| Obsidian | `daily_note`, `list_templates`, `open_in_obsidian`, `query_base` |
| Web | `web_fetch` |
| Memory (when on) | `read_user_memory`, `update_user_memory` |

Everything in detail: **[the guide](docs/guide.md)**.

![Taking a turn back: the undo dialog shows the diff of what the agent changed](images/undo.png)

![The Agents tab: an agent's prompt, and below it the folders and tools it may use](images/agents.png)

## Privacy and security

- **Keys live only in Obsidian's keychain** (Settings → Keychain). A connection's key is picked from there, a setting
  names it (`${openai-api-key}`), a key typed into a settings field is refused, and none is ever written to the
  plugin's saved settings.
- **Settings that sync cannot redirect a key or run a program on another device.** A connection's key goes only to
  the address you approved on this device, an MCP server that receives a key needs approving here too, and the
  audio programs run only once approved here. A change made on this device approves itself; one that arrives by
  sync waits for **Approve** in the settings. The *Developer* switch is kept on this device only.
- **Nothing leaves your machine except what you configure:** the model connection you chose, web pages when you
  switched them on, and HTTP MCP servers you added. No telemetry. An image from the web in an answer is
  shown as a link and not loaded, so an answer cannot send anything out by itself.
- **Programs outside Obsidian** run only as you configure them: whisper.cpp and ffmpeg for recordings, and MCP
  servers you add — a program-based (stdio) MCP server starts only after you approve its exact command line on
  that device, and the audio programs, when set to anything but the plain `whisper-cli` and `ffmpeg`, likewise. Apart from those — and a temporary folder the audio programs work in — the plugin reads and writes
  only your vault.
- **No shell tools in Hiro itself** — see above. An MCP server you add can bring some, and runs only once approved
  on this device.
- **Destructive actions ask first.** Deleting, moving or overwriting a note shows a dialog naming exactly what will
  happen; dismissing it means no. There is no "allow forever".
- **Undo is real.** A turn that changed notes gets an undo button showing the diff, and it will not touch a file
  you have edited since.
- **Folder restrictions are structural**, enforced by the tools themselves, not by asking the model nicely.
- **Desktop only**, because it runs those programs and streams the model's answer over Node's `http` — Obsidian's
  own `requestUrl` cannot stream.

## Free

The full feature set in this release — chat, agents, tools, MCP, attachments, undo, memory, everything above — is
free, with no subscription and no paid tier gating any of it. What is free today stays free.

## Not in this release

- **Mobile** — desktop only for now; the plugin runs local programs and streams over Node's `http`.
- **Shell tools and git** — left out by design, and not on the roadmap.
- **Undo for turns run from the terminal** — the undo button belongs to turns run in the chat view.

## Known limitations

Kept current during the beta; a limitation listed here does not need reporting again.

- The plugin is tested by hand on Windows only. On macOS and Linux the build and the tests pass, but nobody has
  clicked through it yet — reports from those systems are especially welcome.
- Bases run only while the Obsidian window is not minimized: Obsidian does not compute a Base in a minimized
  window, and the agent says so instead of answering.
- A conversation note written by this version can hold a `title:` and, with *Save tool calls with conversations*
  on, the answers' tool calls. An older version of the plugin shows those calls as text in the answer.
- OpenAI's Responses API, which a connection to OpenAI now uses, has been tried with gpt-6.1-sol only. If another
  OpenAI model misbehaves, set *API* to *chat completions* under the connection's *More for …* and report it.

## Feedback and issues

Open an [issue](https://github.com/agent3133/hiro-agent/issues). Please include your Obsidian version, your
platform, and — if relevant — which model or connection you were using. **Hiro Agent: Show the agent's log** in
the command palette shows what the plugin logged; the last lines often say what went wrong.

## License

[GNU Affero General Public License v3.0 or later](LICENSE) — Copyright (C) 2026 Alex M. The packages bundled into
`main.js` keep their own licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
