# Hiro Agent — the guide

Everything the plugin does, in more detail than the [README](../README.md).

## The chat

Open the chat from the ribbon (the bot icon) or the command palette (**Hiro Agent: Open the chat**). An empty chat
shows a few requests to start from; a click puts one into the box. Enter sends, Shift+Enter starts a line, Escape
stops a running answer. Closing the chat stops it too: a notice says so, and offers *Undo its changes* when the
answer had already changed notes. While an input method is composing (Japanese, Chinese, Korean), Enter picks the word and
sends nothing. Type `[[` to name another note: a list of notes opens above the box, narrowed as you type; arrow keys
and Enter or Tab (or a click) put `[[Folder/Note]]` into the message, Escape closes the list. A typed message tells
the agent which note is open, and
what is selected in it. The selection stays highlighted in the note while you type in the chat, and the line above
the input says what goes along. A destructive tool — `update_note`, `delete_note`, `move_note` — opens a dialog naming
the note it will touch — for `update_note` the lines it would remove and add, for `delete_note` the note's length
and first lines; dismissing it means no. **Allow for this answer** lets the rest of the answer's calls of that
tool run without asking — reorganising thirty notes is one question, not thirty; the next answer asks again. An edit (`edit_note`) asks the same way when it would take away half or
more of a note's text, showing what would go; small notes of a few lines are edited without asking. Writing a note
asks too when the new text would load something from
the web or run another plugin's code once the note is shown — an image from the web, HTML with a web address, a
`dataviewjs` block — and the dialog says what. In the chat, another plugin's code block in an answer is shown as
code and not run; Obsidian's own (Bases, Mermaid, math, search queries) are drawn. `move_note` and `delete_note` also move and delete attachments
(images, PDFs, …), their embeds following a move; undo does not cover those, so move one back to undo a move, and
restore a deleted one from the trash. What the agent deletes goes where Obsidian is set to put deleted files
(Settings → Files and links → Deleted files): the system trash, the vault's `.trash` folder, or gone for good. Text in the chat can be selected and copied with Ctrl+C, or with **Copy** in
the right-click menu; the copy button under an answer copies all of it.

The header holds the conversation: its picker, *Keep* and the **⋯** menu. Everything about the next message is
in the input box below — **+** for files, the agent and the connection pickers, and the send arrow, which turns
into a stop button while an answer runs. Pull the box's top edge up or down to make it taller or shorter; a
double-click on the edge goes back to the default height, and the height you chose is kept on this device.

Another chat beside the first, with a conversation of its own, opens from the chat's **⋯** menu (*Open a new chat
window*), with Ctrl-click (Cmd-click on a Mac) on the ribbon icon, or with **Hiro Agent: New chat window**. Holding
Ctrl/Cmd while picking a conversation in the header opens it in another chat and leaves this one as it is. The commands
and the context meter in the status bar follow the chat you used last; picking a conversation that is open in
another chat switches to that chat. The chats answer at the same time where the connection's server can: a cloud API
or a vLLM server up to four answers at once, a llama.cpp server as many as it has slots (`--parallel`). A llama.cpp
server with one slot, Ollama and LM Studio answer one at a time; a message sent while another chat is answering then
says *Waiting for another chat's answer to finish* until its turn comes. Each answer keeps its own changes for
*Undo*, also when they ran side by side.

To give the agent something that is not in the vault yet — a photo, a scanned PDF, a voice memo, a short video, a
Word, Excel or PowerPoint file —
drop the files onto the chat, or press **+** in the input box. They show at the top of the box until you send, and you can
take one out again with its ✕. Sending saves them in the vault, where Obsidian puts new attachments (Settings →
Files and links → Default location for new attachments), and the message embeds them, so a kept conversation's
note shows them too. The agent reads them with `read_attachment`: images as images, PDFs as their text (page by page as images when they are scans), recordings
and videos transcribed on your computer, Word documents as text with their headings, lists and tables, Excel
sheets as tables, PowerPoint slides with their notes, the same from LibreOffice's `.odt`, `.ods` and `.odp`, EPUB
books chapter by chapter (first the list of chapters, from the book's table of contents; a long chapter in parts),
with bold and italic kept, canvases as their cards, groups and arrows, and text
files (`.csv`, `.json`, `.txt`, …) as they are, whether Windows saved them as UTF-16 or in its older encoding.
PNG, JPEG, GIF and WebP images go to the model as they are; BMP, ICO and AVIF are converted to PNG first, and an SVG
is read as its code. A TIFF or HEIC photo cannot be shown to the model: the agent asks you to save it as PNG or JPEG.
Files already in the vault are found with `list_attachments`, which lists everything that is not a note with its
type and size, by folder or by name ("the invoice in my Inbox"). `list_notes` says how many attachments a folder
has, and `find_notes` names the attachments that match when no note does.
To put a file's text into a note — "copy chapter 3 of the book into the Content section of my chapter note" — the
agent uses `import_attachment`, which writes the text exactly as the file has it instead of having the model retype
it: the chapters, pages, sheets or slides you name, into one section of the note or at its end. It asks first when
that section already holds text, and a book's images go to your folder for new attachments (Settings → Files and
links). Undo takes the note and the images back.
The old `.doc`, `.xls` and `.ppt` formats can't be read: save them as `.docx`, `.xlsx` or `.pptx`. Images may be up
to 20 MB, PDFs and documents 50 MB, recordings and videos 100 MB.

The agent can run your **Bases** too, with `query_base`: a `.base` file, or a Base embedded in a note as a ```` ```base ````
block. Obsidian computes the rows, with the Base's filters, formulas, sorting and grouping, and the agent gets them as
a table. While it runs, a temporary Base opens in a background tab for a moment. A Base's view menu also offers
"Hiro Agent (reads rows)": that view type is for the agent and shows nothing to read. An agent
limited to some folders doesn't get `query_base`, since a Base can reach the whole vault.

An answer's footer says how long it took, how many tools it called and, where the server counts them (a cloud API,
llama.cpp), the tokens it sent and got back: what a cloud connection charges by. Hover over them for the whole
conversation's total since the chat opened it. An answer that opened web pages or called an MCP server says so on a
line of its own under it: "Besides the model, this answer reached a page on example.com" — what left your
machine besides the message to the model itself.

An answer that changed files gets an undo button in its footer. It shows the diff first and restores only files
that still hold what the agent wrote, so anything you edited since is named and left alone. The journal holds
the last 20 answers, kept on this device across restarts and reloads. After a restart an answer's footer is gone
with its chat; the command **Hiro Agent: Undo an earlier answer** lists the answers the journal holds, to take one
back in the same dialog (from the terminal: `agent:undo`). It records what the agent's tools
wrote, moved or deleted — including the links Obsidian rewrote on a move — but not what an MCP server did.

**Going back to an earlier message:** each of your messages has a clock button at its top right (*Go back
to before this message*). It removes that message and everything after it from the conversation — from its note too,
when it is kept — and takes back what those answers changed in the vault, newest first, after showing all of it as
one diff. The message goes back into the input box, to send again or change. As with undo, a file edited since is
named and left alone, and an answer from before Obsidian started the plugin cannot be taken back. It does not go back
past a summary of the conversation: those exchanges are only in the summary now.

Conversations are kept. The first message names one after what you asked (`2026-09-23 1432 move-ideas-to-archive`)
and the plugin writes it to `<vault>/.sessions/`; the picker in the header reopens any of them, and
the view comes back to whichever you had open. The picker shows each conversation's title — what you called it — or
else the start of its first message. The **⋯** button beside it renames the open conversation or deletes it, and
*Hiro Agent: Rename conversation* renames it from the command palette. The title is kept as you type it, in the
note's `title:`; the note keeps its file name, so links to it and its place in `.sessions/` do not change.
Renaming a conversation that is not kept yet keeps it. **A session note holds the whole conversation**, including the
content of notes the agent read, and it syncs wherever your vault syncs. Credentials that look like credentials
— `sk-…`, `ghp_…`, `AKIA…`, a private key block, an `api_key: …` line — are replaced by a marker before the note
is written, but that is a net and not a guarantee: anything without a recognisable shape goes through.

Beside the agent picker, in the input box, is the **connection** — the model connection the next messages run against. Leave it on
*Agent's choice* and the connection set for the agent decides, falling back to the default connection; pick one and
it overrides both, for this and every later message until you change it. It is hidden when no connection is
set up. Hovering an agent shows the model it asks for.

Which endpoint a note is sent to is your decision and never the model's, so an agent cannot override the
choice — and a profile name the config does not have is an error rather than a quiet fall back to another one.

The **Keep** box decides whether a conversation is written to the vault at all. Untick it and the answer carries
no name, so the conversation is held in memory and nothing reaches a note. Tick it part-way through and
what has already been said goes into the note too, rather than only what comes next; unticking stops the saving
and leaves the note where it is.

A kept conversation's note holds the questions and answers. To check later what the agent did, switch on **Save
tool calls with conversations** (*Settings → Hiro Agent → Features*): each answer in the note then starts with its
tool calls, folded, each with its arguments and the first 500 characters of its result, and a reopened
conversation shows them in the chat again. The model never gets them back; what it remembers of a conversation is
the same either way.

What the model remembers is a separate switch: **Remember tool results between messages** (*Settings → Hiro Agent
→ Features*, off by default). Normally each answer keeps only your message and its reply, so a follow-up such as
"now quote that paragraph" has the agent read the note again — or, worse, write from memory. Switched on, the
answers' tool calls and results go along with the next messages, and the agent can use what it read. The
conversation fills the model's context window sooner and is summarised earlier, which drops them, as does
reopening a conversation. Images that a tool returned are not kept.

Kept conversations live in `.sessions/`, which Obsidian's file explorer, search and links do not see. *Export as
note* in the **⋯** menu writes a copy to read, link and search — a heading for each message, the summary of earlier
messages as a callout — where Obsidian puts new notes, and opens it; the conversation itself stays where it is.
*Find a conversation…* lists the kept conversations by title and narrows them as you type.

*Delete conversation* in the **⋯** menu deletes the open conversation's note. It asks first, and the note goes where Obsidian keeps
deleted files, so it can be restored from there; notes the agent changed are not touched — only the transcript
goes. Deleting or resetting an agent in the settings sends its file there too.

**When a conversation grows long.** The model reads a conversation within its *context window*, a fixed amount of
text. A small bar in Obsidian's status bar, beside the backlinks count (above the input in a chat window of its own),
shows how full it is: "≈ 12.3k of 32.8k tokens · 38%". It turns orange, then red, as the conversation grows. You
need not watch it:

- A long conversation is summarised by itself before it overflows. A dashed divider — "12 earlier exchanges
  summarised here" — marks the place; click it to read the summary. The messages above stay on screen, but from then
  on the agent remembers them only as that summary. For a new topic, a new conversation is better than a summary.
- An answer that reads a lot — every note in a folder, say — sets the oldest of what it read aside to make room, and
  says so; with no room left, it answers with what it has and says what it could not cover.
- With a local model, a small window fills fast: the tools' descriptions alone take a good part of 8k tokens. Start
  `llama-server` with a larger `-c`, or give the agent fewer tools.

How and when each of these happens, with the numbers, is in [the details on the context window](context.md).

The agent answers through whatever endpoint the default connection (*Settings → Hiro Agent → Connections*) points at, so start
your `llama-server` first — without one an answer ends with a message saying the server does not answer.
Your message is not lost: under the error, **Try again** sends it once more when the server is up, and
**Edit** puts it back into the input to change it first.

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

With Obsidian running, the Obsidian CLI reaches the agent as `obsidian agent:<action>`:

```bash
obsidian agent:status                 # version, default agent and connection, MCP servers
obsidian agent:list                   # the agents; * marks the one used when none is chosen
obsidian agent:sessions               # saved conversations, newest first
obsidian agent:list format=json       # any of them as JSON, for scripts

obsidian agent:ask prompt="What is due this week?"
obsidian agent:ask prompt="Summarise this" note=Projects/Plan.md agent=research connection=cloud
obsidian agent:ask prompt="Tidy the inbox" allow=destructive timeout=900 format=json
obsidian agent:stop                       # stop what agent:ask is running; session=<name> for one, list to see them

obsidian agent:undo list                  # the answers that can be undone, newest first
obsidian agent:undo turn=3f9a0c1d2e4b dry # what undo would take back, changing nothing
obsidian agent:undo turn=3f9a0c1d2e4b     # take it back; without turn=, the newest answer not undone
```

`agent:ask` sends one message and prints the answer when it ends — nothing shows meanwhile. Each call is a new
conversation, saved in `.sessions/` like a chat one (the chat's picker opens it); `session=<name>` continues one.
`connection=` wins over the agent's own, as the chat's connection picker does. `selection=<text>` sends text as if it were
selected in that note, as the chat does.

- **Ctrl+C does not stop the answer**: it ends the terminal, and the answer runs on inside Obsidian — a notice there
  says an answer for the terminal is running, under which conversation name, and when it ends. `obsidian
  agent:stop` stops it from another terminal, and `timeout=` (seconds, default 600) at the latest; the reply then
  says so and keeps what was said.
- **Everything that asks first in the chat is refused** unless the call says `allow=destructive`: deleting, moving
  or overwriting a note, an edit that removes half of one, the first web page on each site, an MCP tool set to *Ask
  first*. With `allow=destructive` the usual dialog asks in the Obsidian window while the terminal waits. With
  *Settings → Hiro Agent → Advanced → Developer* on, `allow=destructive` runs them without asking — for unattended
  runs such as the benchmark — and the reply lists what ran unasked.
- **Undo from the terminal** (`agent:undo`): an answer that changed files ends with
  `[undo: obsidian agent:undo turn=<id>]`. Undo works as the chat's button does, on the same journal: files edited
  since are named and left alone, and an answer undone in the chat is undone here too. Without `turn=` it takes back
  the newest answer not undone yet, from the chat or the terminal. The journal holds the last 20 answers, kept on
  this device across restarts.
- **Keep the Obsidian window open, not minimized**: while it is minimized, Obsidian does not finish moving a note
  and updating the links to it, so `move_note` refuses and says so.

The CLI always exits 0; an error is a line starting with `Error:`, and `format=json` answers `"ok": false` with the
error. `obsidian help agent:ask` lists every flag.

## Keys

Keys live in **Obsidian's keychain** (Settings → **Keychain**), never in the plugin's settings. A setting names
the keychain entry it means, written `${openai-api-key}`. You rarely type that: a connection's **API key** (Connections → Add connection, or the pencil) is Obsidian's own keychain
picker, where you choose an entry or add one. **The plugin stores only the name.** The value stays in Obsidian's
secret store — DPAPI on Windows, the Keychain on macOS, libsecret or KWallet on Linux — so it is never written to
`data.json`, which sits inside the vault and syncs with it.

In an MCP server's environment or headers a key is written the same way, by its keychain name:
`GITHUB_TOKEN=${github-token}`, `Authorization: Bearer ${service-key}`. Keychain names are lowercase letters,
digits and dashes.

**The keychain is the only place a key comes from:** a name the keychain does not have gives no key (the
environment is not read, and there is no `OPENAI_API_KEY` fallback), and a key typed into a setting is refused —
it would sit in `data.json`. A key is read when a message or an MCP server needs it, so a changed key applies from the
next message.

Before 0.9.1 a **Secrets** tab bound names such as `${OPENAI_API_KEY}` to keychain entries. The first start of
0.9.1 renames every such reference to the entry it stood for (`${openai-api-key}`) and drops the tab (#147).

## Settings

Most of the settings are the agent's own configuration, kept in this plugin's settings for this vault; a vault
without any starts from the defaults. Each change is checked against the schema before saving;
a stored value shows a short *Saved* beside the field, and a refused one its reason there and in a notice. Lists
save as you type. A change applies from the next message, in open conversations too.

Four pages, in the order setting up meets them. Each opens from its entry, with a back arrow, as Obsidian's own
settings do, and Obsidian's settings search (*Search settings…* at the top of the list) finds every setting on them
by its name or description — "reasoning effort", "whisper", "default agent" — and leads to the page it is on:

![Settings → Hiro Agent: the four pages, Connections, Features, Agents and Advanced, each with what it holds](../images/settings-pages.png)

- **Connections** — where the agent sends your notes. Each connection's row says what it is (model, address,
  key), with *Test*, the pencil and the bin. *Add connection* opens one form: a name, the address (empty for
  OpenAI), the model and a key from Obsidian's keychain, with *Test* — which sends the key as a message would, so a
  refused key shows here, and lists the server's models as suggestions — and *Save*. There is no kind to pick: every
  server speaks the same API, and the plugin finds out from the address whether llama.cpp, Ollama, LM Studio or vLLM
  answers there, which tells it the loaded model and the context window. The row names what it found. An address
  without a path (`http://127.0.0.1:11434`) gets `/v1` added. A key with a plain `http://` address on another
  computer gets a warning in the form and under *Test*: the key would cross the network readable. Sampling, context window, output
  length, reasoning effort, service tier and API are on a page of their own under each row, *More for …*. *Reasoning effort* tells
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
  asks in a dialog where the key would go. That holds on a new computer too: opening a synced vault there approves
  nothing by itself. Settings changed on another device show here as soon as sync brings them, without a restart.

  ![The Connections page: the default connection, a cloud connection and a local llama.cpp server, each with Test, edit and delete, and Add connection](../images/settings-connections.png)
- **Features** — switches for web pages, undo, memory and audio transcription; each one's own settings are on a
  page of its own under it while it is on (*More for …*). See below. With web pages on, the first page on each site
  in a conversation asks first ("Open a page on example.com"), since its address carries whatever the agent put in
  it; once allowed, the conversation opens that site's other pages without asking. With *Memory* on, the built-in assistant keeps
  a profile of you and reads it in every conversation; another agent does when its tools include the memory tools.
  The command **Edit the memory profile** shows what it keeps, to change or remove.

  ![The Features page: what the agent may do, one switch each, and below it the MCP servers](../images/settings-features.png)
- **Agents** — the *Default agent*, and an editor for any *Agent*: pick it at the top (with *New*, *Duplicate*,
  *Delete* or *Reset*), then its description and prompt, the **folders** it may work in, and its **tools** — one
  switch per group, unfolding to single tools. Connection, step limit and model settings are folded under *More*.
  The built-in assistant works as it is. Nothing saves until *Save*: while there are changes, *Save* and *Discard*
  stay at the top of the editor, and closing the settings asks whether to save them, drop them, or keep them for
  later.

  ![The Agents page: the default agent, the agent picker with New and Duplicate, the prompt, its folders and its tool groups](../images/settings-agents.png)

  - Folders are enforced by the tools, not asked for in the prompt. While any are set, the tools that could reach
    past them are greyed out, with the reason: they are withheld from that agent.
  - Changing a built-in agent saves your own copy in this vault's `.agents/` folder; *Reset* drops it. *New*
    and *Duplicate* save there too, so the agent travels with the vault; those can be deleted. Built-in agents
    cannot.
  - An agent file copied into `.agents/` works the same way. [`examples/book-reader`](../examples/book-reader/README.md)
    is one to copy: it turns a book into notes, one per chapter with the chapter's exact text, from two templates of
    its own.
  - MCP tools appear in one *MCP* group, as "server: tool", with *All MCP tools* (`mcp:*`) first. An `http`
    server's tools are listed when the page opens; a `stdio` server's once it has been listed on this device — by its
    *Test* under Features, or by an answer that used it — since opening the page starts no program. Switching one
    tool off while *All MCP tools* is on lists the others by name. Each MCP tool's shield is its **Ask first**, for
    every agent: on, each call asks before it runs, even for a tool its server calls read-only — a search tool
    still sends what it searches for to that service. An `http` server's tools ask first until you switch it off;
    a `stdio` server's ask unless the server says they only read. There are no shell tools and no `git`: the plugin has no tool that runs a shell.
- **Features** (details) — once audio is on, its page shows the paths it needs — whisper.cpp, its model, and ffmpeg. Each program's path says which file it runs;
  when the one set is not found but one is on PATH, *Use it* takes that one. *Test* runs the program once and
  says whether it works. The model is a file you download once: *Get a model* beside its path opens whisper.cpp's
  list of models — `ggml-base.bin` (about 150 MB) is a good start, `ggml-small.bin` understands more but is slower,
  and the `.en` ones are for English only. Save it anywhere and put its path in the field. There is no web search of its own: add a search engine's MCP server for that.
  - **MCP servers** — add, edit, switch on and off, remove, and *Test* (connect and list the tools). A `stdio`
    server is a program started on this computer: saving one shows its exact command line and asks, and it runs
    only once approved **on this device** — the approval is kept outside the vault, so a server that arrives by
    sync, or whose command, arguments or environment changed, waits for a new yes. It gets PATH and the like plus
    its own `env`, nothing else of Obsidian's environment. A command written without a folder, such as `npx`, is
    the program of that name on PATH, never a file of that name in the vault. An `http` server needs approval when it sends a
    key or is on another computer — what its tools are called with goes there — not when it runs on this one. Keys in `env` or a header name a keychain entry (`Authorization: Bearer ${service-key}`); a key written
    out is refused.
    A server is started on first use and kept while Obsidian runs; every start is in the plugin's log.
- **Advanced** — *Developer* (kept on this device only; it does not sync), for testing the plugin: it switches on
  `obsidian agent:tool`, which runs one of the agent's tools from the command line, and lets `agent:ask` change
  notes without the dialog. Leave it off otherwise. Any setting no other page shows would appear here too.

A connection's API key is picked from Obsidian's keychain; nowhere does a setting take the key itself — see
[Keys](#keys).
