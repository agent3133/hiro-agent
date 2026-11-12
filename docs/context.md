# How the chat stays inside the model's context window

[The guide](guide.md#the-chat) says what you see and do: the bar in the status bar, the divider where a conversation
was summarised, and what to do when the window is small. This page has the details: the thresholds, and the order
things happen in.

## Within one answer

One answer can read a lot — every note in a folder, say — and all of it goes along with each further step of that
answer. So before each step the plugin checks the size of what it is about to send:

- When less than 2,048 tokens of the model's window would be left for the answer — or 15 % of a larger window: at
  8k that is past 75 %, at 32k past 85 % — the oldest results of that answer are set aside, well below that. The same
  model first writes down in a few lines what each said that matters for the request, and those lines stay in its
  place, so the agent does not read it all again to remember it. The answer says how many were set aside.
- Each new result gets its share of the room left (at most a quarter of the window).
- With most of that room gone even so, the agent answers with what it has, without further tools, and says what it
  could not cover — an answer rather than an overflow.
- A tool call cut off halfway (the model ran out of room while writing it) is not run; the agent is told to ask for
  less at a time.

With a small window this is where the tools weigh in: their descriptions go with every request. With 8,192 tokens
and 50 tools, about half the window is gone before anything is read; a larger window (llama-server's `-c`), or an
agent with fewer tools, reads more in one answer.

## Across a conversation

A long conversation is summarised rather than allowed to overflow the model's context. Once the conversation — your
messages and the agent's answers; tool results are not kept after an answer — takes more than 60 % of the
model's window, the older exchanges are replaced by a summary after the answer; the newest that fit in a fifth of the
window stay word for word. The same happens before a message when the conversation no longer fits well (after
switching to a model with a smaller window, say), and when the server refuses a request as too long before anything
ran — then the message is sent again once. A kept conversation gets the summary in its note; one that is not kept, in
memory. The chat marks the place with a dashed divider — "12 earlier exchanges summarised here" — and the summary
unfolds when clicked. The messages above stay on screen, but the agent's memory of them is the summary from then on.
A reopened conversation starts with the same divider. A kept conversation is also summarised past 50 exchanges, so
its note does not grow without end.

## The bar

In Obsidian's status bar, beside the backlinks count, a small bar shows how much of the model's context window the
conversation takes after each answer: "≈ 12.3k of 32.8k tokens · 38%" — what the next message carries, your
messages and the agent's answers, estimated from their length. A chat in a window of its own has no status bar, so
there the bar is above the input. It grows as the conversation does, turns orange from 50 % and red from 80 %, and
drops when the conversation is summarised at 60 %. While an answer runs, the bar follows each request to the model,
with the notes and pages the agent read; those are not kept after the answer, so the bar drops back when it is done,
and the tooltip says how far the answer went with them. The window is the one the server says it has, or the
connection's *context window* setting for a cloud API.
