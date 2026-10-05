# Hiro Agent — the guide

Everything the plugin does, in more detail than the [README](../README.md).

## The chat

Open the chat from the ribbon (the bot icon) or the command palette (**Hiro Agent: Open the chat**). Enter sends,
Shift+Enter starts a line, Escape stops a running turn. A typed message tells the agent which note is open, and
what is selected in it. The selection stays highlighted in the note while you type in the chat, and the line above
the input says what goes along. A destructive tool — `update_note`, `delete_note`, `move_note` — opens a dialog naming
the note it will touch; dismissing it means no. `move_note` and `delete_note` also move and delete attachments
(images, PDFs, …), their embeds following a move; undo does not cover those, so move one back to undo a move, and
restore a deleted one from the trash. Text in the chat can be selected and copied with Ctrl+C, or with **Copy** in
the right-click menu; the copy button under an answer copies all of it.

**Hiro Agent: New chat window** opens another chat beside the first, with a conversation of its own. The commands
and the context meter in the status bar follow the chat you used last; picking a conversation that is open in
another chat switches to that chat. Answers still come one at a time: a message sent in one chat while the other is
answering waits for it.

To give the agent something that is not in the vault yet — a photo, a scanned PDF, a voice memo, a short video, a
Word, Excel or PowerPoint file —
drop the files onto the chat, or press **+** above *Send*. They show above the input until you send, and you can
take one out again with its ✕. Sending saves them in the vault, where Obsidian puts new attachments (Settings →
Files and links → Default location for new attachments), and the message embeds them, so a kept conversation's
note shows them too. The agent reads them with `read_attachment`: images as images, PDFs as their text (page by page as images when they are scans), recordings
and videos transcribed on your computer, Word documents as text with their headings, lists and tables, Excel
sheets as tables, PowerPoint slides with their notes, the same from LibreOffice's `.odt`, `.ods` and `.odp`, EPUB
books chapter by chapter (first the list of chapters), canvases as their cards, groups and arrows, and text
files (`.csv`, `.json`, `.txt`, …) as they are.
Files already in the vault are found with `list_attachments`, which lists everything that is not a note with its
type and size, by folder or by name ("the invoice in my Inbox"). `list_notes` says how many attachments a folder
has, and `find_notes` names the attachments that match when no note does.
The old `.doc`, `.xls` and `.ppt` formats can't be read: save them as `.docx`, `.xlsx` or `.pptx`. Images may be up
to 20 MB, PDFs and documents 50 MB, recordings and videos 100 MB.

The agent can run your **Bases** too, with `query_base`: a `.base` file, or a Base embedded in a note as a ```` ```base ````
block. Obsidian computes the rows, with the Base's filters, formulas, sorting and grouping, and the agent gets them as
a table. While it runs, a temporary Base opens in a background tab for a moment. A Base's view menu also offers
"Hiro Agent (reads rows)": that view type is for the agent and shows nothing to read. An agent
limited to some folders doesn't get `query_base`, since a Base can reach the whole vault.

A turn that changed files gets an undo button in its footer. It shows the diff first and restores only files
that still hold what the agent wrote, so anything you edited since is named and left alone. The journal holds
the last 20 turns while Obsidian runs, so reloading the plugin clears it. It records what the agent's tools
wrote, moved or deleted — including the links Obsidian rewrote on a move — but not what an MCP server did.

Conversations are kept. The first turn names one after what you asked (`2026-09-23 1432 move-ideas-to-archive`)
and the plugin writes it to `<vault>/.sessions/`; the picker beside the agent picker reopens any of them, and
the view comes back to whichever you had open. The picker shows each conversation's title — what you called it — or
else the start of its first message. The **⋯** button beside it renames the open conversation or deletes it, and
*Hiro Agent: Rename conversation* renames it from the command palette. The title is kept as you type it, in the
note's `title:`; the note keeps its file name, so links to it and its place in `.sessions/` do not change.
Renaming a conversation that is not kept yet keeps it. **A session note holds the whole conversation**, including the
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

A kept conversation's note holds the questions and answers. To check later what the agent did, switch on **Save
tool calls with conversations** (*Settings → Hiro Agent → Features*): each answer in the note then starts with its
tool calls, folded, each with its arguments and the first 500 characters of its result, and a reopened
conversation shows them in the chat again. The model never gets them back; what it remembers of a conversation is
the same either way.

The trash icon deletes the open conversation's note. It asks first, there is no undo, and notes the agent
changed are not touched — only the transcript goes.

One answer can read a lot — every note in a folder, say — and all of it goes along with each further step of that
answer. So before each step the plugin checks the size of what it is about to send:

- When less than 2,048 tokens of the model's window would be left for the answer — or 15 % of a larger window: at
  8k that is past 75 %, at 32k past 85 % — the oldest results of that answer are set aside, well below that. The same model
  first writes down in a few lines what each said that matters for your request, and those lines stay in its
  place, so the agent does not read it all again to remember it. The answer says how many were set aside.
- Each new result gets its share of the room left (at most a quarter of the window).
- With most of that room gone even so, the agent answers with what it has, without further tools, and says what it could not
  cover — an answer rather than an overflow.
- A tool call cut off halfway (the model ran out of room while writing it) is not run; the agent is told to ask
  for less at a time.

With a small window this is where the tools weigh in: their descriptions go with every request. With 8,192 tokens
and 50 tools, about half the window is gone before anything is read; a larger window (llama-server's `-c`), or
an agent with fewer tools, reads more in one answer.

A long conversation is summarised rather than allowed to overflow the model's context. Once the conversation — your
messages and the agent's answers; tool results are not kept after an answer — takes more than 60 % of the model's
window, the older exchanges are replaced by a summary after the answer; the newest that
fit in a fifth of the window stay word for word. The same happens before a message when the conversation no
longer fits well (after switching to a model with a smaller window, say), and when the server refuses a request as
too long before anything ran — then the message is sent again once. A kept conversation gets the summary in its
note; one that is not kept, in memory. The chat marks the place with a dashed divider — "12 earlier exchanges
summarised here" — and the summary unfolds when you click it. The messages above stay on screen, but the agent's
memory of them is the summary from then on. A reopened conversation starts with the same divider. A kept conversation is also summarised past 50 exchanges, so its note does not grow
without end.

In Obsidian's status bar, beside the backlinks count, a small bar shows how much of the model's context window the
conversation takes after each answer: "≈ 12.3k of 32.8k tokens · 38%" — what the next message carries, your
messages and the agent's answers, estimated from their length. It grows as the conversation does, turns orange from
50 % and red from 80 %, and drops when the conversation is summarised at 60 %. The notes and pages the agent read
while answering are not kept after the answer, so they are not in the bar; the tooltip says how far the last
answer went with them. The window is the one the server says it has, or the connection's *context window* setting
for a cloud API.

The agent answers through whatever endpoint the default connection (Settings → Connections) points at, so start
your `llama-server` first — without one an answer ends with a message saying the server does not answer.

## Commands

Every command starts with **Hiro Agent:** in the command palette.

| Command | What it does |
|---|---|
| **Hiro Agent: Ask *daily-note*…** (one per agent) | Asks that agent about the open note |
| **Hiro Agent: Ask an agent…** | The same, choosing the agent from a list |
| **Hiro Agent: Ask about the selection** | Asks the default agent about the selected text; also *Ask the agent about this* in the editor's right-click menu |
| **Hiro Agent: Open the chat** · **New chat window** · **Show the agent's log** | |

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
`connection=` wins over the agent's own, as the chat header's picker does. `selection=<text>` sends text as if it were
selected in that note, as the chat does.

- **Ctrl+C does not stop the turn**: it ends the terminal, and the turn runs on inside Obsidian — a notice there
  says a turn from the terminal is running, and when it ends. `timeout=` (seconds, default 600) stops it; the
  reply then says so and keeps what was said.
- **Deleting, moving or overwriting a note is refused** unless the call says `allow=destructive`; then the usual
  dialog asks in the Obsidian window while the terminal waits. With Settings → Hiro Agent → Advanced → *Developer* on,
  `allow=destructive` runs them without asking — for unattended runs such as the benchmark.
- **Keep the Obsidian window open, not minimized**: while it is minimized, Obsidian does not finish moving a note
  and updating the links to it, so `move_note` refuses and says so.

The CLI always exits 0; an error is a line starting with `Error:`, and `format=json` answers `"ok": false` with the
error. `obsidian help agent:ask` lists every flag.

## Keys

Keys live in **Obsidian's keychain** (Settings → **Keychain**), never in the plugin's settings. A setting names
the keychain entry it means:

```yaml
llm_profiles:
  cloud:
    api_key: ${openai-api-key}
```

— you rarely type that: a connection's **API key** (Connections → Add connection, or the pencil) is Obsidian's own keychain
picker, where you choose an entry or add one. **The plugin stores only the name.** The value stays in Obsidian's
secret store — DPAPI on Windows, the Keychain on macOS, libsecret or KWallet on Linux — so it is never written to
`data.json`, which sits inside the vault and syncs with it.

In an MCP server's environment or headers a key is written the same way, by its keychain name:
`GITHUB_TOKEN=${github-token}`, `Authorization: Bearer ${service-key}`. Keychain names are lowercase letters,
digits and dashes.

**The keychain is the only place a key comes from:** a name the keychain does not have gives no key (the
environment is not read, and there is no `OPENAI_API_KEY` fallback), and a key typed into a setting is refused —
it would sit in `data.json`. A key is read when a turn or an MCP server needs it, so a changed key applies from the
next turn.

Before 0.9.1 a **Secrets** tab bound names such as `${OPENAI_API_KEY}` to keychain entries. The first start of
0.9.1 renames every such reference to the entry it stood for (`${openai-api-key}`) and drops the tab (#147).

## Settings

Most of the tab is the agent's own configuration, kept in this plugin's settings for this vault; a vault
without any starts from the defaults. Each change is checked against the schema before saving;
a stored value shows a short *Saved* beside the field, and a refused one its reason there and in a notice. Lists
save as you type. A change applies from the next message, in open conversations too.

Four tabs, in the order setting up meets them:

- **Connections** — where the agent sends your notes. Each connection's row says what it is (model, address,
  key), with *Test*, the pencil and the bin. *Add connection* opens one form: a name, the address (empty for
  OpenAI), the model and a key from Obsidian's keychain, with *Test* — which sends the key as a message would, so a
  refused key shows here, and lists the server's models as suggestions — and *Save*. There is no kind to pick: every
  server speaks the same API, and the plugin finds out from the address whether llama.cpp, Ollama, LM Studio or vLLM
  answers there, which tells it the loaded model and the context window. The row names what it found. An address
  without a path (`http://127.0.0.1:11434`) gets `/v1` added. Sampling, context window, output
  length, reasoning effort and service tier are folded under *More for …* on each row. *Reasoning effort* tells
  an OpenAI reasoning model how much to think — less is faster and cheaper; left empty, nothing is sent. For a
  llama.cpp model, *Enable thinking* does that instead. *Service tier* is OpenAI's: **flex** costs
  about half and answers more slowly, **priority** answers faster at a higher price; left empty, nothing is sent.
  When OpenAI has no flex capacity it refuses the request, and *Service tier fallback* (on) sends it once more at
  tier *auto*, at the normal price; switched off, the answer fails instead. *API* says how the plugin talks to
  the model: OpenAI's current reasoning models take tools only through OpenAI's **Responses** API, which *auto*
  uses for `api.openai.com`; every other address gets **chat completions**, which local servers and most other
  providers speak. Through the Responses API nothing is stored at OpenAI: the model's encrypted reasoning goes back
  with each tool result, and the thinking shown is OpenAI's summary of it. A server answering on this computer's usual ports — llama.cpp
  8080 and 8090, vLLM 8000, LM Studio 1234, Ollama 11434 — is offered with one click. A connection whose key and address came from another device says so, and *Approve*
  asks in a dialog where the key would go.
- **Features** — switches for web pages, undo, memory and audio transcription; each one's own settings are folded
  under it while it is on (*More for …*). See below.
- **Agents** — the *Default agent*, and an editor for any *Agent*: pick it at the top (with *New*, *Duplicate*,
  *Delete* or *Reset*), then its description and prompt, the **folders** it may work in, and its **tools** — one
  switch per group, unfolding to single tools. Connection, step limit and model settings are folded under *More*.
  The built-in assistant works as it is. Nothing saves until *Save*: while there are changes, *Save* and *Discard*
  stay at the top of the editor, and closing the settings asks whether to save them, drop them, or keep them for
  later.
  - Folders are enforced by the tools, not asked for in the prompt. While any are set, the tools that could reach
    past them are greyed out, with the reason: they are withheld from that agent.
  - Changing a built-in agent saves your own copy in this vault's `.agents/` folder; *Reset* drops it. *New*
    and *Duplicate* save there too, so the agent travels with the vault; those can be deleted. Built-in agents
    cannot.
  - MCP tools appear in one *MCP* group, as "server: tool", with *All MCP tools* (`mcp:*`) first, once the
    server has been listed on this device — by its *Test* under Features, or by an answer that used it. Opening
    the tab starts no server. Switching one tool off while *All MCP tools* is on lists the others by name. There are no shell tools and no `git`: the plugin has no tool that runs a shell.
- **Features** (details) — once audio is on, it shows the paths it needs — whisper.cpp, its model, and ffmpeg. Each program's path says which file it runs;
  when the one set is not found but one is on PATH, *Use it* takes that one. *Test* runs the program once and
  says whether it works. There is no web search of its own: add a search engine's MCP server for that.
  - **MCP servers** — add, edit, switch on and off, remove, and *Test* (connect and list the tools). A `stdio`
    server is a program started on this computer: saving one shows its exact command line and asks, and it runs
    only once approved **on this device** — the approval is kept outside the vault, so a server that arrives by
    sync, or whose command, arguments or environment changed, waits for a new yes. It gets PATH and the like plus
    its own `env`, nothing else of Obsidian's environment. An `http` server needs approval only when it sends a
    key. Keys in `env` or a header name a keychain entry (`Authorization: Bearer ${service-key}`); a key written
    out is refused.
    A server is started on first use and kept while Obsidian runs; every start is in the plugin's log.
- **Advanced** — *Developer* (kept on this device only; it does not sync), for testing the plugin: it switches on
  `obsidian agent:tool`, which runs one of the agent's tools from the command line, and lets `agent:ask` change
  notes without the dialog. Leave it off otherwise. Any setting no other tab shows would appear here too.

A connection's API key is picked from Obsidian's keychain; nowhere does a setting take the key itself — see
[Keys](#keys).
