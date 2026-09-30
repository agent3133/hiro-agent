# Hiro Agent — the guide

Everything the plugin does, in more detail than the [README](../README.md).

## The chat

Open the chat from the ribbon (the bot icon) or the command palette (**Hiro Agent: Open the chat**). Enter sends,
Shift+Enter starts a line, Escape stops a running turn. A typed message tells the agent which note is open, and
what is selected in it. A destructive tool — `update_note`, `delete_note`, `move_note` — opens a dialog naming
the note it will touch; dismissing it means no.

A turn that changed files gets an undo button in its footer. It shows the diff first and restores only files
that still hold what the agent wrote, so anything you edited since is named and left alone. The journal holds
the last 20 turns while Obsidian runs, so reloading the plugin clears it. It records what the agent's tools
wrote, moved or deleted — including the links Obsidian rewrote on a move — but not what an MCP server did.

Conversations are kept. The first turn names one after what you asked (`2026-09-23 1432 move-ideas-to-archive`)
and the plugin writes it to `<vault>/.sessions/`; the picker beside the agent picker reopens any of them, and
the view comes back to whichever you had open. **A session note holds the whole conversation**, including the
content of notes the agent read, and it syncs wherever your vault syncs. Credentials that look like credentials
— `sk-…`, `ghp_…`, `AKIA…`, a private key block, an `api_key: …` line — are replaced by a marker before the note
is written, but that is a net and not a guarantee: anything without a recognisable shape goes through.

Beside the agent picker is the **connection** — the `llm_profiles` entry this turn runs against. Leave it on
*Agent's choice* and the agent's own `llm_profile` decides, falling back to `default_llm_profile`; pick one and
it overrides both, for this and every later turn until you change it. It is hidden when the config names no
profiles. Hovering an agent shows the model it asks for.

Which endpoint a note is sent to is your decision and never the model's, so an agent cannot override the
choice — and a profile name the config does not have is an error rather than a quiet fall back to another one.

The **Keep** box decides whether a conversation is written to the vault at all. Untick it and the turn carries
no name, so the conversation is held in memory and nothing reaches a note. Tick it part-way through and
what has already been said goes into the note too, rather than only what comes next; unticking stops the saving
and leaves the note where it is.

The trash icon deletes the open conversation's note. It asks first, there is no undo, and notes the agent
changed are not touched — only the transcript goes.

A long conversation is summarised rather than allowed to overflow the model's context: past 50 exchanges the
oldest are replaced by a summary in the note, and the chat says how many went. The agent's memory of those
exchanges is the summary from then on.

The agent answers through whatever endpoint the default connection (Settings → General) points at, so start
your `llama-server` first — without one a turn ends with a message saying the server does not answer.

## Commands

Every command starts with **Hiro Agent:** in the command palette.

| Command | What it does |
|---|---|
| **Hiro Agent: Ask *daily-note*…** (one per agent) | Asks that agent about the open note |
| **Hiro Agent: Ask an agent…** | The same, choosing the agent from a list |
| **Hiro Agent: Ask about the selection** | Asks the default agent about the selected text; also *Ask the agent about this* in the editor's right-click menu |
| **Hiro Agent: Open the chat** · **Show the agent's log** | |

Each "Ask" command opens a box first: say what the agent should do, and untick *Include* to leave the note out.
With text selected, the agent gets the selection and the note's name; otherwise just the note's name, which it
reads with its own tools — so an agent limited to some folders is still limited. The request then runs as a new
conversation in the chat view, where its progress, confirmations and undo work as usual.

None has a hotkey by default; assign one under Settings → Hotkeys.

## From the terminal

With Obsidian 1.12.2 or later running, the Obsidian CLI reaches the agent as `obsidian agent:<action>`:

```bash
obsidian agent:status                 # version, default agent and connection, MCP servers
obsidian agent:list                   # the agents; * marks the one used when none is chosen
obsidian agent:sessions               # saved conversations, newest first
obsidian agent:list format=json       # any of them as JSON, for scripts

obsidian agent:ask prompt="What is due this week?"
obsidian agent:ask prompt="Summarise this" note=Projects/Plan.md agent=research connection=cloud
obsidian agent:ask prompt="Tidy the inbox" allow=destructive timeout=900 format=json
```

`agent:ask` runs one turn and prints the reply when it ends — nothing shows meanwhile. Each call is a new
conversation, saved in `.sessions/` like a chat one (the chat's picker opens it); `session=<name>` continues one.
`connection=` wins over the agent's own, as the chat header's picker does.

- **Ctrl+C does not stop the turn**: it ends the terminal, and the turn runs on inside Obsidian — a notice there
  says a turn from the terminal is running, and when it ends. `timeout=` (seconds, default 600) stops it; the
  reply then says so and keeps what was said.
- **Deleting, moving or overwriting a note is refused** unless the call says `allow=destructive`; then the usual
  dialog asks in the Obsidian window while the terminal waits. With Settings → Hiro Agent → Advanced → *Developer* on,
  `allow=destructive` runs them without asking — for unattended runs such as the benchmark.

The CLI always exits 0; an error is a line starting with `Error:`, and `format=json` answers `"ok": false` with the
error. `obsidian help agent:ask` lists every flag.

## Secrets

Settings → **Hiro Agent** → Secrets binds a variable name to a secret in Obsidian's keychain, so a connection's key
can say

```yaml
llm:
  api_key: ${LLM_API_KEY}
```

and the settings hold no secret of their own. **This plugin stores only the name.** The value lives in Obsidian's own secret
store — DPAPI on Windows, the Keychain on macOS, libsecret or KWallet on Linux — so it is never written to
`data.json`, which sits inside the vault and syncs with it.

The keychain id is derived from the variable name, with underscores turned into dashes — `LLM_API_KEY` becomes
`llm-api-key`, because Obsidian's ids take only lowercase letters, digits and dashes. If you created the secret
in Obsidian's own Keychain dialog under some other name, pick it from the dropdown on the row instead.

The variable name is yours to choose, and nothing infers it: whatever you bind has to be referenced from a
setting to be used. **The keychain is the only place a key comes from:** a name with no binding has no value
(the environment is not read, and there is no `OPENAI_API_KEY` fallback), and a key typed into a setting is
refused — it would sit in `data.json`.

A secret is read when a turn or an MCP server needs it, so a changed key applies from the next turn.

## Settings

Most of the tab is the agent's own configuration, kept in this plugin's settings for this vault; a vault
without any starts from the defaults. Each change is checked against the schema before saving;
a refused value shows its reason beside the field. A change applies from the next turn, in open conversations
too.

Five tabs:

- **General** — *Connections*: where the agent sends your notes (`llm_profiles`). Choose the default, add,
  remove, test that one answers, and edit its provider, URL, model and key reference (the pencil; sampling
  settings are under *More settings*). A llama.cpp server answering on `127.0.0.1:8080` or `:8090` is offered with
  one click.
- **Agents** — which agent is *used when none is chosen*, and an editor for any agent: pick it at the top (with
  *New*, *Duplicate*, *Delete* or *Reset*), then its description and prompt, the **folders** it may work in, and
  its **tools** — one switch per group, unfolding to single tools. Connection, step limit and model settings are
  folded under *More*. Nothing saves until *Save*.
  - Folders are enforced by the tools, not asked for in the prompt. While any are set, the tools that could reach
    past them are greyed out, with the reason: they are withheld from that agent.
  - Changing a built-in agent saves your own copy in this vault's `.agents/` folder; *Reset* drops it. *New*
    and *Duplicate* save there too, so the agent travels with the vault; those can be deleted. Built-in agents
    cannot.
  - MCP tools appear in one *MCP* group, as "server: tool", with *All MCP tools* (`mcp:*`) first, once the
    server can be reached (see Features). Switching one tool off while *All MCP tools* is on lists the others by name. There are no shell tools and no `git`: the plugin has no tool that runs a shell.
- **Features** — switches for web pages, undo, memory and audio transcription. Once audio is on, it
  shows the paths it needs — whisper.cpp, its model, and ffmpeg. Each program's path says which file it runs;
  when the one set is not found but one is on PATH, *Use it* takes that one. *Test* runs the program once and
  says whether it works. There is no web search of its own: add a search engine's MCP server for that.
  - **MCP servers** — add, edit, switch on and off, remove, and *Test* (connect and list the tools). A `stdio`
    server is a program started on this computer: saving one shows its exact command line and asks, and it runs
    only once approved **on this device** — the approval is kept outside the vault, so a server that arrives by
    sync, or whose command, arguments or environment changed, waits for a new yes. It gets PATH and the like plus
    its own `env`, nothing else of Obsidian's environment. An `http` server needs no approval. Keys in `env` or a
    header are `${NAME}` references to Secrets (`Authorization: Bearer ${NAME}`); a key written out is refused.
    A server is started on first use and kept while Obsidian runs; every start is in the plugin's log.
- **Secrets** — see below.
- **Advanced** — every other setting, one card per block, with each field's help text. *Developer* switches on `obsidian agent:tool`, which runs one of the agent's tools from
  the command line to test it inside Obsidian.

API key fields take a reference such as `${LLM_API_KEY}`, never the key: put the key under Secrets.
