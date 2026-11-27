# Changelog

## 0.6.3

**Collect tasks from anywhere**

No change to what the plugin does, its data or the access it asks for.

- The README and the manifest's description tell what the plugin is for: Orca's own task view
  works with GitHub issues and Linear, and Agent Tasks gathers tasks from every other app into one
  board. An Orca bot collects them on a schedule, you hand each one to a bot or start it in its
  project from the board, and the bot's or agent's state comes back to the task.
- README: a section, **Collect tasks from anywhere**, on how a scheduled Orca automation uses
  `orca-tasks add --source <link> --dedupe` to pull tasks from other apps, with two example
  prompts. The apps are examples the bot reads with its own tools; the plugin has no connectors.
- A flyer, `docs/flyer/flyer.html` (one self-contained page, light and dark, made-up tasks), is
  the plugin page's cover: `docs/flyer/render.sh` renders it to `docs/screenshots/cover.png`. It
  embeds Overpass and Overpass Mono (SIL Open Font License 1.1); `THIRD_PARTY_NOTICES.md` carries
  their licence.
- Links to Orca's site point to `orca.dev`, where `onorca.dev` moved, and the directory listing
  to `https://orca.dev/plugins/rickyking/orca-tasks`.
- Tests: a DevTools command in the browser test that gets no answer fails after 20 s, and CI
  stops a job after 10 minutes, so a lost answer from Chrome no longer holds a run for hours.

## 0.6.2

**Prepared for publishing**

No change to what the plugin does, its data or the access it asks for.

- README for people new to it: what it does, screenshots, `orca plugin install
  rickyking/orca-tasks`, the requirements (Orca 1.4.259, Node 22.18), the access it asks for and
  why, privacy (Suggest merges sends open tasks' fields to Claude Code, which sends them to
  Anthropic's API), the CLI, where the data lives, and how to uninstall. The full reference moved to
  `docs/reference.md`, and loading a checkout, tests and releasing to `docs/development.md`.
- Screenshots from made-up demo data (`src/board/test/demo-data.ts`, taken with
  `AGENT_TASKS_README_SHOTS=docs/screenshots npm run test:browser`), light and dark.
- Manifest: a shorter description, `homepage`, a `cover` image and four `screenshots` for the
  plugin page.
- LICENSE names the copyright holder; `THIRD_PARTY_NOTICES.md` carries Lucide's licence (with
  Feather's) for the board's icons; the credit to ToDos for Orca stays.
- Examples, tests, help text and the quick add placeholder use generic names and sources
  (`online-store`, `chat:<id>`, `issue:<id>`, an issue URL) instead of ones from a real setup.

## 0.6.1

**Quick actions on hover**

- In the sidebar and on the board (list rows and cards), pointing at a task shows small icon
  buttons at its right edge, as Orca's own bot panel does. Moving to it with the keys shows them
  too. They are laid over the row and fade in, so nothing moves, and are hidden otherwise.
- **One icon per status** the task can move to (every one of yours but its own), in your order,
  with your status's name as the tooltip: ✓ done, a clock on hold, ✕ cancelled, ▶ In Progress,
  ○ another open status. A click moves the task (as the status menu does) and does not open it.
  Pending keeps how on hold works: the task is on hold, and **Waiting on** in its details says on
  whom.
- When they do not all fit (a sidebar row 4, a card 3, a board list row 6), your first done,
  on-hold and cancelled statuses come first, and the rest go to **…**. **…** also has **Open**,
  **Send to a bot…**, **Send to the project…**, **Merge…** and **Pick for a merge**.
- **P** moves the task under the cursor (or the open one) to your first on-hold status (Pending),
  and back to your first open one when it is on hold already. **C** does the same with your first
  cancelled status; without one it says so. X and Space stay done and reopen. In the **?** list
  and the README ("Quick actions", "In the panel and on the board").

**Tests**

- `src/board/quick.test.ts`: which icons a task gets in which order, what goes to "…", a deleted
  Cancelled, and where P and C go. `keys.test.ts`: P and C, never in a field.
- In Chrome, with a real mouse: hidden until hovered, shown on hover and on keyboard focus, only
  on the hovered row, nothing moves; the icons and their names; Done and Pending by click, and
  the task does not open; "…" and Send to a bot…; P, C and C again; the board's cards and their
  "…" (Move to In Progress).
- No new access.

## 0.6.0

**Suggest merges**

- A **Suggest merges** button (✦ in the sidebar's header, **Suggest merges** on the board) asks
  Claude Code which open tasks look like duplicates. It answers groups, the surest first, each
  with the task to keep, a one-line reason and a confidence.
- **Review merge…** opens the existing merge confirm step with the group filled in (the task to
  keep, the earliest due day, the highest priority). Nothing merges until you press **Merge into
  …** there. **Dismiss** hides a group, and its pairs of tasks are not suggested again
  (`~/.orca-tasks/merge-dismissed.json`). A group whose tasks were merged since drops out; Esc or
  the mouse back button closes the list.
- `orca-tasks suggest-merges [--json] [--timeout <seconds>]` prints the same groups, each with its
  `orca-tasks merge` command, and merges nothing.
- How it runs: the worker (or the CLI) runs `claude --print` once as a child process, as it runs
  `orca`, with the prompt on standard input. That needs no terminal, no chat and no new Orca
  access, and no temp file is left behind. A bot was the other choice, but its answer would land
  in a chat to be read back, and the tasks would go into the bot's chat history. Claude Code runs
  with no tools (`--tools ""`), no MCP servers, no saved session, from the temp folder, and is
  looked for on PATH and where it installs itself (Orca started from the Dock has a short PATH).
  It may take up to 3 minutes; one run at a time (the sidebar and the board share it).
- Errors say what to do: Claude Code missing (install it and sign in once), an error from it, no
  answer in time, or an answer that is not the JSON asked for. Ids it makes up are dropped, and a
  task is in at most one group.
- **Data**: only open tasks (at most 300), and only their id, title, notes (the first 1000
  characters), sources, tags, project, due day and status. Claude Code sends them to Anthropic's API
  under your own Claude Code sign-in. README: "Suggest merges" and "Access".

**Sending to a bot goes to its Home Chat**

- The send form's **Chat** starts at **The bot's Home Chat** (its main chat, now listed first)
  instead of a new chat; a new chat or the chat it had before are still there. `orca-tasks send`
  without `--chat` sends to the Home Chat too (`--chat new` for a chat of its own). Status
  messages already went there. Sending to the project (a new workspace) is unchanged.
- Remembered choices keep working: a chat chosen from 0.6.0 on is kept (`chatChosen` in
  `~/.orca-tasks/send-prefs.json`). A project whose remembered chat is "a new chat" from 0.5.1 or
  earlier, when that was where the form started, starts at the Home Chat once. "The chat it had
  before" for a task without one now falls back to the Home Chat, not a new chat.

**The mouse back button**

- In the sidebar and on the board, the mouse's **back** button (button 3, the thumb button of a
  Logitech MX Master) goes back: it closes what is on top as Esc does (the status menu, the
  shortcuts, a form, asking first when an instruction was typed, the merge suggestions, the
  details, Statuses, the picked tasks), then goes back to the view before (the Show filter, the
  project, list or board). **Forward** (button 4) goes forward again, and reopens a task Back
  closed. The Browser Back and Browser Forward keys do the same.
- The page keeps that history itself (up to 50 views). It stops the button's own "go back", so
  the panel or the board is never navigated away, and it adds no entries to Orca's history.
- In the **?** list and the README's Shortcuts.

**In Progress pulses**

- The coloured dot of a task in **In Progress** (the status of that name, or the one that started
  as In Progress) pulses softly in its colour, about every 1.8 s, in the sidebar and on the board.
  The other statuses stay still, and so does it when the system asks for less motion
  (`prefers-reduced-motion`).

**Tests**

- `src/core/suggest.test.ts`, with a stand-in for Claude Code (`src/core/test/stub-agent.ts`):
  good JSON, JSON in a fence, bad JSON, an error, a timeout and a missing agent; only open tasks
  and only their fields in the prompt; the arguments (no tools, no MCP); unknown ids and overlaps;
  dismissed pairs; and the CLI. Over Orca's mock host, the worker's `tasks.suggestMerges` (one run
  for two presses) and `tasks.dismissMerge`. In Chrome: the list, Review merge, Dismiss, Esc,
  "not installed", the board's button, and the pulse with and without reduced motion.
- The Home Chat default: the form (`initialChat`, `rememberedChat`, `settleBotForm`), the worker's
  remembered choices including 0.5.1 prefs, and `orca-tasks send` with and without `--chat`.
- The back button: `src/board/history.test.ts` (what Back closes, the view history, Forward, the
  button events), and in Chrome with real button 3/4 presses: the details, the filters, a send
  form with a typed instruction, the board's list or board, the Browser Back key, and that the
  page stays where it was with no history entry added. Without the page stopping it, Chrome does
  go back to the page before, so this test catches it.
- No new access: the plugin's capabilities are unchanged.

## 0.5.1

**Keys in the panel and on the board**

- **Esc closes the open task**, also when the focus is in one of its fields: what you typed there
  is saved first (fields save when they are left, as before). Esc closes what is on top first:
  the status menu, the shortcuts list, a send or merge form, then the details, Statuses, then the
  picked tasks. Before, Esc in a field only left it, so closing took a second Esc.
- Esc never drops typed text without a word: a send form with an instruction typed in it says so
  on the first Esc ("Press Esc again to discard it") and closes on the second. Quick add and search
  keep their text.
- **J/K or ↑/↓ move a cursor** through the tasks without opening them (the sidebar's details
  would cover the list); **Enter** opens the task under it. With the details open they follow, as
  before, unless a send or merge form is open there.
- **X or Space** ticks the task under the cursor (or the open one), **N** goes to quick add (in the
  sidebar **/** too: it has no search box), **/** searches on the board, **V** switches list and
  board there (no longer in the sidebar, which is always a list).
- **Cmd/Ctrl+Enter** saves the field of the details you are in and keeps them open (it did that
  only in the notes), and sends an open send form.
- **?** (and a **?** button in the header) shows the keys. README: "In the panel and on the board"
  under Shortcuts.
- Keys typed in a text field, a select or a checkbox are never taken as shortcuts (except Esc and
  Cmd/Ctrl+Enter); a focused button keeps Enter and Space.
- These are the page's own keys, not Orca keybindings: no new access.

**Sending moves the task to In Progress**

- Sending a task to a bot or to its project now moves it to **In Progress** unless you choose
  otherwise: the send forms' **Then** starts there, and `orca-tasks send` (with or without
  `--to-project`) does the same without `--state`. `--keep-state` leaves the status as it is.
- In Progress is your open status of that name (any case), or the one that started as In Progress
  if you renamed it. If you deleted it, nothing moves: Then starts at "Leave the status as it is"
  and the CLI leaves it.
- Per-project remembered choices keep working: a status chosen last time, or "Leave the status as
  it is", is where the form starts. That choice is now kept as `keepState` in
  `~/.orca-tasks/send-prefs.json`; a project last sent from 0.5.0 or earlier (when leaving it was
  the only default) starts at In Progress.
- The worker runs `orca-tasks send … --keep-state` when the form says to leave the status.
- Scripts that only list, add and complete tasks do not send, so their use of the CLI is unchanged.

**Tests**

- `src/board/keys.test.ts`: every key on the page, in each kind of field (never a shortcut there),
  with modifiers and on buttons; the order Esc closes things in, the typed-instruction warning,
  Cmd/Ctrl+Enter, and the cursor.
- The browser test drives the keys in the sidebar and on the board in Chrome: J/K, Enter, X,
  Space, typing in quick add, Esc in the notes (saved), Cmd+Enter, the send form's warning, ?, and
  the status menu; the send form starts at In Progress.
- The default and its fallbacks (renamed, deleted, remembered, pre-0.5.1 prefs) in
  `src/send-form.test.ts`, the CLI's `send` and `send --to-project` with and without
  `--keep-state`, and, over Orca's mock host, `--keep-state` from the worker and the remembered
  choice.

## 0.5.0

**Fix: Send from the panel and the board**

- Pressing **Send to <bot>** with an empty instruction showed "input: Invalid input" and sent
  nothing (the CLI's `orca-tasks send … --dry-run` of the same send worked). The panel sent the
  instruction as `note: undefined` when it was empty. Orca's `plugin.request` takes only JSON (it
  checks `input` with `z.json()`), and `undefined` is not JSON, so Orca refused the whole request
  before it reached the worker, and printed the first problem as `<path>: <zod message>`. The other
  choices (Home Chat, leave the status, notes on) were fine.
- The send request is now built in one place (`src/core/send-input.ts`) with nothing left
  undefined; every request from the sidebar and the board also drops `undefined` fields first
  (quick add sent `project: undefined` with no project filter set). The worker checks the
  request field by field and names the form's field when it refuses one ("Chat: a status message
  cannot start a new chat", "Then: there is no status reviewing"); a refusal from Orca reads as
  the field and why instead of "input: Invalid input".
- The sidebar records its sends as `by: panel` (it said `board`).

**Send to the project**

- Besides a bot, a task can go to its project: **Send to the project…** in its details starts a
  new Orca workspace (a branch of the task's Git project) with Claude Code (default) or Codex, and
  the agent's first prompt is the task (your instruction, title, due, priority, tags, sources,
  notes, task id). Optionally moves the task to a status. The task records it (`workspaces`), shows
  what the workspace's agent is doing (working, waiting for your permission, done, idle, asleep,
  removed) and has **Open the workspace**. Nothing starts until you press the button.
- CLI: `orca-tasks send <id> --to-project [--agent claude|codex] [--note] [--no-notes] [--state]
  [--open] [--dry-run]`, with `orca worktree create`.

**Merge duplicates**

- Pick tasks with Cmd-, Ctrl- or Shift-click in the sidebar or on the board (or **Merge…** on a
  task), choose the one to keep, check the due day, priority and created date, and merge. The kept
  task keeps its title and status and gets the others' notes (under "Merged from <title> (<id>)"),
  sources, tags, bot and workspace history, the earliest created date, the earliest due day and the
  highest priority. The others move to Cancelled with `merged_into`; they stay findable.
- `orca-tasks merge <keep> <id> [<id>…] [--due] [--priority] [--created] [--dry-run]`, and
  `merge --undo` for the latest merge (when none of its tasks changed since). `get <old id>` points
  to the kept task.
- `add --dedupe` treats a source held by a kept task, or by a task merged into it, as a duplicate
  and answers the kept task, so an agent that adds with `--dedupe` never re-creates a merged task. `list --source`
  finds it too. Every other command and field works as before.

**Data**

- No new schema: `workspaces`, `sources`, `merged_into`, `merged_at` and `merged_from` are only on
  the tasks they apply to, `last_merge` on the file after a merge. 0.4.x keeps them as unknown
  fields.

**Tests**

- `src/send-form.test.ts`: every combination the bot form can produce (each kind, each chat, empty
  and non-empty instruction, every Then, notes on and off, from the sidebar and the board) is plain
  JSON, accepted by the worker as sent, and makes an `orca-tasks send` the CLI takes; the same for
  the project form; the 0.4.2 request is shown to be the one Orca refuses.
- The browser test drives the real send form through every chat, Then, instruction and notes
  choice against a stand-in worker that refuses non-JSON input as Orca does, and picks and merges
  two tasks.
- Merge rules, dedupe after a merge, undo, the CLI's `merge` and `send --to-project`, and, over
  Orca's mock host, the worker's project send (workspace, status, open, missing capabilities),
  merge and field-named refusals.

**Access**

- Two new capabilities, `workspace:create` and `agent:launch`, for Send to the project only. Orca
  asks to approve the update; until then the form says what to approve and sends nothing. Needs
  Orca 1.4.259 or newer (`engines.orca`).

## 0.4.2

**Shortcuts**

- **Agent Tasks: Show or Hide Sidebar**, a new command on Cmd+Shift+U (Ctrl+Shift+U on Windows
  and Linux): it shows or hides the right sidebar, as Orca's Toggle Right Sidebar (Cmd+L) does.
  The sidebar opens on the tab it showed last, so pick Agent Tasks there once and the shortcut
  brings it back. Orca gives plugins no way to select their own panel, so it cannot switch to
  Agent Tasks from another tab such as Files.
- **Agent Tasks: Open Board** gets Cmd+Shift+X (Ctrl+Shift+X).
- Neither chord is one of Orca's own shortcuts or the code editor's. Change or remove them in
  Settings → Shortcuts → Plugins. The README has a [Shortcuts](README.md#shortcuts) section.

**Tests**

- `src/manifest.test.ts` (in `npm test`): every shortcut runs a command of the plugin, none is one
  of Orca's default chords or Ctrl+Alt (AltGr on Windows and Linux), the README lists them, and
  the version agrees across the manifest, `package.json`, the CLI and the worker.

**Access**

- No new capabilities. The sidebar command runs Orca's built-in action without starting the
  worker. Orca may ask to approve the update again, because it adds a command and shortcuts.

## 0.4.1

**Drag and drop that works**

- In 0.4.0 dragging did not work: on the board a card dragged to another column never landed, and
  the sidebar could not drag at all. The board used the browser's drag and drop (`draggable`,
  `dragstart`, `drop`), which does not arrive reliably in the isolated frame Orca shows a custom
  editor in, and the sidebar was an Orca components panel, which has no dragging. (The list
  view's dragging in the 0.4.0 notes was never merged.)
- Dragging now uses pointer events, which reach the frame like any click, in the sidebar and on
  the board:
  - drag a task onto another status section (a collapsed one by its header, which then opens) or
    another column to change its status;
  - drag it up or down within its section or column to put it in order;
  - drag a status by its grip in Statuses to reorder the statuses.
  The target is outlined and a line shows where the task will land; a short move is still a click;
  Escape cancels; the list scrolls near its edges.
- Without dragging: the coloured dot on every task opens a menu of the statuses.
- The sidebar is now the board's page in a narrow mode (an HTML panel): sections per status,
  Show filter, overdue toggle, Group by project, quick add, the Board button, Statuses, and the
  task's details (status, due, priority, project, tags, notes and checklist, the bot and the send
  form, hold, delete) in place of the list. Typing `@` in quick add no longer suggests projects
  there.
- What the sidebar and the board show (open sections, filters) is also kept by the worker
  (`~/.orca-tasks/ui-state.json`), since an isolated frame may not keep its own storage.

**Data**

- Tasks dragged into place get `rank` (their place within their status). Tasks without one come
  first in the sidebar and the board, in the usual order. The CLI's order and every field
  scripts read are unchanged. Changing a task's status another way drops its `rank`.

**Tests**

- `npm run test:browser` (also in CI): the sidebar and the board in headless Chrome, dragged with
  real mouse input, against a stand-in worker with demo tasks. Unit tests for the drag helpers,
  the section order and the store's move.

**Access**

- No new capabilities. The sidebar panel changes from `ui: "components"` to `ui: "html"`, so Orca
  may ask to approve the update again.

## 0.4.0

**Your own statuses**

- Tasks are in statuses you choose: **To Do**, **In Progress**, **Pending**, **Done** and
  **Cancelled** to start with. Add, rename, recolour (gray, blue, purple, teal, green, amber,
  orange, red, pink), reorder and delete them, and give each a kind: open, on hold (open, waiting
  on someone), done or cancelled (both closed). In the sidebar (**Statuses**, at the bottom), on
  the board (the **Statuses** button) or with `orca-tasks statuses`. At least one open, one on-hold
  and one done status always stay; deleting one moves its tasks to another of the same kind.
- The sidebar's sections and the board's columns are the statuses, in your order; closed ones
  start collapsed and are left out when the due filter shows only open work. The editor and the
  details pane have a **Status** field, and dragging a card to a column moves it there. Sending a
  task to a bot no longer moves it to a section by itself (see below); a bot that has answered is
  still marked "answered".
- CLI: `statuses` (list, with counts), `statuses add <name> [--kind] [--color] [--position]`,
  `statuses edit <status> [--name] [--kind] [--color] [--position]`, `statuses rm <status>
  [--move-to]`; `--state <status>` on `add`, `edit` and `list` (a comma list on `list`); `edit --on
  <text>`. Text output names the status only when it is not the first of its kind, and prints a
  cancelled task as `[-]`.

**Send to a bot: options**

- The bot button opens a small form: the bot (the task's project bot first, then Orca, then any
  other), **As** a handoff (the bot owns the job), a question (it only answers) or a status message
  (for its information), **Chat** (a new chat, the Home Chat, or the chat the task was in before),
  an **Instruction** above the task ("check progress"), **Include the notes**, and **Then** (leave
  the status, or move the task to a status; to Pending it waits on the bot). The last choices are
  remembered per project (`~/.orca-tasks/send-prefs.json`), not the instruction.
- `orca-tasks send` has the same: `--type handoff|question|status` (Orca's `--type`), `--chat
  new|home|last|<chat id>`, `--no-notes` and `--state <status>`. A status message goes to the Home
  Chat by default and cannot start a new chat (Orca does not allow it). `--dry-run` shows all of
  it.
- Each handoff records its `type`, and `chat` can be `existing`. A status message does not count
  as the bot having the task (`--with-bot`, the bot's state on the row).

**Data**

- Schema 3: the file has `statuses`, and every task `state` (its status's id), `state_name` and
  `closed_at`. The worker migrates the file when it starts: done → Done, on hold or waiting on
  someone → Pending, the rest → To Do. A test covers it.
- Every 0.3.0 field keeps its meaning: `status` is still `open`, `hold` or `done` (done and
  cancelled statuses both report `done`), `done_at` is set only for a completed task (a cancelled
  one has `closed_at` and no `done_at`, so `--done-since` leaves it out), and on-hold statuses
  keep `waiting_on` and `held_at`. `hold`, `unhold`, `done` and `undone` move a task to the first
  status of the kind they mean. Every command and option of 0.3.0 works as before. `version`
  stays 1; when 0.3.0 changes a task after the migration, its fields win.

**Fixes**

- The panel showed an error from an action (a refused edit, a failed send) only until the list
  reloaded a moment later; it now stays until the next action.

**Access**

- No new capabilities. The worker also keeps `~/.orca-tasks/send-prefs.json`.

## 0.3.0

**Send a task to a bot**

- A task can be handed to an Orca bot: the bot of its project (a bot named after the project, or
  whose "what it is for" names it), the main bot "Orca", or any other. From the panel (the bot
  button on a row), the board (Send to a bot… in the details pane) or the CLI (`orca-tasks send`).
  It goes out with `orca orchestration send --to bot:<name> --type handoff`, in a new chat of its
  own by default (`--chat new`) or the bot's Home Chat. Nothing is sent until you press Send or run
  the command. Orca's mail needs a sender, which only an Orca terminal has, so Send in the panel or
  the board runs `orca-tasks send` in a background terminal of the focused workspace and closes it
  once the handoff is recorded.
- The task records each handoff (`handoffs`: bot, chat, chat id, message id, when, from where) and
  sits under **In progress** while the bot has it. The worker reads the bot's chat every minute
  (`orca agent read`) and shows its state and latest reply; when the bot has finished or waits on
  you, the task is back under **Needs you** with "answered". **Take back** ends a handoff.
- CLI: `bots [<id>]`, `send <id> [--to <bot>] [--chat new|home] [--note <text>] [--dry-run]`,
  `bot-status <id>`, `take-back <id>`, and `list --with-bot` / `--no-bot`.

**The board (center tab)**

- A custom editor for `.agenttasks` files: + in the tab bar → **Open Agent Tasks board**. List and
  board views (columns Needs you, In progress, On hold, Done; drag a card to move it), a details
  pane (title, due day and time, priority, project, tags, notes with a ticking checklist, the bot
  section, source, delete), search, a due filter, a project filter, quick add and keyboard keys
  (J/K, X, V, N, /, Esc). It uses Orca's theme colours, fonts and control sizes.
- The layout ideas (list and board, details pane, chips, quick add, the overdue toggle, the status
  count) come from [uttam-gelot/orca-todos](https://github.com/uttam-gelot/orca-todos) (MIT). No
  code was copied.

**Due dates, reminders, checklists**

- A due day can carry a time (`due_time`, `HH:MM`): `--due fri@15:30`, `--due 2026-11-25T09:00`,
  `--time 9am`, `due:fri@15:30` in a line. A task due today at a time already past is overdue.
- Quick add in the panel and the board also reads `@today`, `@tomorrow`, `@fri`, `@2026-11-25` (and
  `@fri@15:30`) as the due day, and `!u`, `!h`, `!m`, `!l` as priorities. The inbox and
  `add --parse` keep `@` for projects.
- Reminders: the worker shows an Orca notification when an open task comes due, at its time or at
  the reminder time (default 9:00) on its day. Settings **Due reminders** and **Reminder time**.
  Nothing is sent for what was already due when 0.3.0 first ran, and nothing twice.
- `- [ ]` / `- [x]` lines in notes are a checklist: rows and cards show `2/5`, and the editor and
  the details pane tick items in place.

**Sidebar and status bar**

- The sidebar's Today / Upcoming / Inbox / Done tabs are now collapsible sections, as in Orca's bot
  panel: **Needs you**, **In progress**, **On hold**, **Done**, each with a count and "Show N more"
  when long. Which ones are open is remembered; Done starts closed. A **Show** filter (All, Due
  today, Overdue, Upcoming, No due day) and the overdue count button take the place of the tabs.
- The status bar reads `12 open · 3 high · 2 overdue` (high counts urgent and high); its tooltip
  has today's count, on hold and with a bot.

**Data**

- Schema 2: every task has `due_time` (null) and `handoffs` (`[]`), and the file records
  `"schema": 2`. The worker migrates a 0.1.0 or 0.2.0 file when it starts; reading migrates in
  memory before that. `version` stays 1, so 0.2.0 still reads and writes the file and keeps the new
  fields. A test covers the migration.
- The CLI's commands, options and text output are unchanged for tasks without the new fields;
  JSON output has the two new fields. `list --overdue` also counts tasks due earlier today at a
  time already past.

**Access**

- New capabilities: `notifications:show` for reminders, and `terminal:send` and `terminal:read` for
  the terminal Send runs `orca-tasks send` in. Updating asks for approval again.
- The worker runs Orca's CLI (`orca bot list`, `orca orchestration send`, `orca bot chats`, `orca
  agent read`) for bots; it finds `orca` on PATH or in `/Applications/Orca.app`.

## 0.2.0

- Orca projects: a task's project is stored as the Orca project's exact name; group by project;
  a project group opens the project's workspace.
- On hold: a task can wait on someone's input, in its own section, never overdue.

## 0.1.0

- The task panel, the `orca-tasks` CLI, the locked JSON store and the Simple Todo inbox.
