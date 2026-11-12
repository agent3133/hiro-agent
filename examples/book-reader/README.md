# Book reader — an example agent

An agent that turns a book in your vault into notes: one note per chapter, with the chapter's text copied exactly as
the book has it, a summary and tags of the agent's choosing, links to the neighbouring chapters, and a central note
that maps the book. It is an example, not one of Hiro Agent's built-in agents: copy it into a vault to use it, and
change it as you like.

It works with EPUB books best — their chapters come from the book's table of contents — and with any attachment
`read_attachment` reads as text in parts: Word and OpenDocument files, a PDF's text.

## Install

1. Copy `book-reader.md` into your vault's `.agents/` folder (create it if it is not there). The chat's agent
   picker lists **book-reader** the next time you click into the chat.
2. Copy the two files in `Templates/` into your vault's templates folder (`Templates/` in most vaults):
   - `Book Chapter.md` — a chapter note: frontmatter pointing to the book, the summary, then *Content* for the
     chapter's text and *Related* with the neighbouring chapters;
   - `Book MOC.md` — the book's central note: its author, source file, summary and chapter list.

   Change their layout freely. The words in single braces — `{book}`, `{summary}`, `{chapter_title}`, … — are what
   the agent fills in; keep the ones you want filled. (Single braces, because the agent's own prompt fills
   `{{…}}` itself, and Obsidian's Templates plugin would fill `{{title}}` and `{{date}}`.)

It needs Hiro Agent with `import_attachment` (after 0.9.3).

## Use

Pick **book-reader** in the chat and ask, for example: *"Make chapter notes for The Art of Money Getting.epub in my
Inbox."* It writes into `Notes/<book title>/` unless you name a folder, and asks before replacing notes that exist.

How it works, from its instructions:
- It reads the chapter list and writes a plan — which entry goes into which note — and keeps to it.
- For each chapter: it reads the chapter (for the summary and tags), checks that the heading it read is the one the
  plan names, creates the note from the template, and puts the text in with `import_attachment`. It never types a
  chapter's text itself, so nothing is shortened or reworded.
- At the end it writes the book's summary into the central note, checks the folder against the plan, and reports
  what it left out (a publisher's title page, a licence).

A whole book is many steps: the agent may take 150 (`max_iterations`). Project Gutenberg's *The Art of Money
Getting* (21 chapters) took 88 calls and about 10 minutes on Qwen3.6-35B on a local llama-server.

## Good to know

- **Ask for corrections in the same conversation, with the chapter list read again.** What tools returned in earlier
  answers is not kept between messages unless *Remember tool results between messages* is on (*Settings → Hiro
  Agent → Features*); the agent's instructions tell it to read the list again before it uses a chapter number.
- **It cannot delete notes.** If something goes wrong, it says which notes to delete.
