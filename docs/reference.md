# Agent Tasks reference

Everything about [Agent Tasks](../README.md) in detail: the `orca-tasks` CLI, statuses, projects,
sending to a bot or a project, merging, the board, keys, reminders and the data file. For
installing, the access the plugin asks for and privacy, see the [README](../README.md); for
working on the plugin itself, [development.md](development.md).

- [For agents: the CLI](#for-agents)
- [Statuses](#statuses) · [Projects](#projects) · [Bots](#bots) · [Send to the project](#send-to-the-project) · [Merging](#merging) · [Suggest merges](#suggest-merges) · [The inbox](#the-inbox-simple-todos-format)
- [The board](#the-board) · [Quick actions](#quick-actions) · [Shortcuts](#shortcuts) · [Dragging](#dragging) · [Reminders](#reminders)
- [Data format](#data-format)

## For agents

When the plugin starts it installs the CLI at `~/.orca-tasks/bin/orca-tasks` (rewritten on
every start, so it follows plugin updates). From a checkout, `bin/orca-tasks` is the same
program. Add `~/.orca-tasks/bin` to `PATH`, or call it by its full path.

Every command takes `--json`. Output is then one JSON object on stdout: `{ "today", "tasks": [...] }`
for `list`, `{ "tasks": [...] }` for bulk changes (`done`, `undone`, `hold`, `unhold`, `rm`,
`import`), `{ "task": {...} }` for one task (plus `"created"` for `add`), `{ "today", "groups":
[...] }` for `list --group project`, `{ "from", "updated_at", "projects": [...] }` for `projects`,
`{ "bots", "unreachable", "default" }` for `bots`, `{ "task", "handoff" }` for `send`, `{ "task",
"handoff", "status" }` for `bot-status`, `{ "statuses": [...] }` for `statuses` (each with a
`tasks` count), and `{ "error": { "code", "message" } }` on failure. Exit codes: `0` ok, `1` error, `2` bad usage,
`3` no such task. Ids are stable; any unique prefix of 3 or more characters also works.

```sh
# Read
orca-tasks list --json                          # open tasks
orca-tasks list --view today --json             # due today or overdue, plus done today
orca-tasks list --due-to today --json           # open and due today or earlier
orca-tasks list --due-from tomorrow --due-to +7d --json
orca-tasks list --overdue --json                # open and past due (a time already past today counts)
orca-tasks list --no-due --json                 # the Inbox
orca-tasks list --done-since today --json       # finished today (local midnight)
orca-tasks list --done-since 2026-11-23T08:00:00+09:00 --json
orca-tasks list --done-since -24h --project ops --tag chat --json
orca-tasks list --source "chat:msg_123" --all --json
orca-tasks list --status hold --json            # on hold (also --hold); --status open,hold for both
orca-tasks list --state "In Progress" --json    # in one of your statuses (name or id; comma list)
orca-tasks statuses --json                      # your statuses, in order, with counts
orca-tasks list --view today --group project --json
orca-tasks projects --json                      # Orca projects, then other projects in use, with counts
orca-tasks get t-k3m9x2pa --json

# Write
orca-tasks add "Reply to Alice about the budget" --due tomorrow --priority high \
  --project ops --tag chat --source "chat:msg_123" --notes "She asked in #finance" --json
orca-tasks add "Review Q4 plan" --source "https://tracker.example.com/tasks/abc" \
  --dedupe --json                               # once per source: a second call returns the same task
orca-tasks add "Ship v1 !urgent @orca #release due:fri@16:00" --parse --json
orca-tasks add "Call Alice" --due tomorrow@9:30 --json   # or --due tomorrow --time 9:30am
orca-tasks edit t-k3m9x2pa --time none --json   # keep the day, drop the time
orca-tasks done t-k3m9x2pa --json               # completes it now; --at <time> to backdate
orca-tasks undone t-k3m9x2pa --json
orca-tasks hold t-k3m9x2pa --on "Bob's review" --json   # waiting on someone; again to change the text
orca-tasks unhold t-k3m9x2pa --json             # back to open; `done` also works on a held task
orca-tasks edit t-k3m9x2pa --due +3d --add-tag waiting --project none --json
orca-tasks edit t-k3m9x2pa --state "In Progress" --json   # move it to another status
orca-tasks edit t-k3m9x2pa --state Cancelled --json       # closed, not completed: no done_at
orca-tasks add "Draft the memo" --state "In Progress" --json
orca-tasks rm t-k3m9x2pa --json

# Statuses (see Statuses below)
orca-tasks statuses add Review --kind hold --color purple --position 3 --json
orca-tasks statuses edit Review --name "In review" --color teal --json
orca-tasks statuses rm "In review" --move-to Pending --json

# Bots (see Bots below); nothing is sent unless you run send
orca-tasks bots t-k3m9x2pa --json               # Orca's bots; "default" is the one send picks
orca-tasks send t-k3m9x2pa --dry-run            # what would be sent, sending nothing
orca-tasks send t-k3m9x2pa --to Orca --note "Before Friday" --json      # to its Home Chat (the default)
orca-tasks send t-k3m9x2pa --chat new --json            # a new chat of its own
orca-tasks send t-k3m9x2pa --state Pending --json      # a handoff, then Pending, waiting on the bot
orca-tasks send t-k3m9x2pa --keep-state --json         # leave the status (default: In Progress)
orca-tasks send t-k3m9x2pa --type question --chat last --note "Check progress" --no-notes --json
orca-tasks send t-k3m9x2pa --type status --note "Moved to next week" --json   # to its Home Chat
orca-tasks bot-status t-k3m9x2pa --json         # the bot chat's state and latest reply
orca-tasks list --with-bot --json               # tasks a bot has (--no-bot: the others)
orca-tasks take-back t-k3m9x2pa --json

# Send to the project (see Send to the project below); nothing starts unless you run it
orca-tasks send t-k3m9x2pa --to-project --dry-run       # the workspace name and the first prompt
orca-tasks send t-k3m9x2pa --to-project --agent codex --note "Write a test first" --json

# Merge duplicates (see Merging below)
orca-tasks merge t-k3m9x2pa t-8fh2kq7c --dry-run       # what the kept task would look like
orca-tasks merge t-k3m9x2pa t-8fh2kq7c t-2ec27hs8 --priority keep --json
orca-tasks merge --undo --json
orca-tasks suggest-merges --json                       # Claude Code's likely duplicates; merges nothing

# Bring in Simple Todo lines
orca-tasks import ~/notes/todo.md --source simple-todo --json
printf -- '- [ ] Call the bank !high due:tomorrow\n' | orca-tasks import - --json
```

`orca-tasks help` lists every command and option. Days accept `YYYY-MM-DD`, `today`, `tomorrow`,
`yesterday`, `+3d`, `-1d`, `+2w` and weekday names (the next one, not today); `none` clears.
`--due` also takes a time after the day: `fri@15:30`, `2026-11-25T09:00`, `tomorrow 9am`; a day
without a time clears the time. `--time` takes `15:30`, `9:05`, `9am`, `9:30pm`, `noon`, `none`.
Times for `--done-since` and `--at` accept ISO 8601, a day (its local midnight), `now`, `-30m`,
`-24h`, `-7d`.

A typical loop for a bot that keeps a daily note and closes linked items:

```sh
# 1. Create tasks from issues, chat messages and meeting notes, once each.
orca-tasks add "<title>" --source "<issue URL | chat:<id> | mail:<id>>" --due <day> --dedupe --json
# 2. See what was finished since the last run, for the daily note.
orca-tasks list --done-since "<last run time>" --json
# 3. For each finished task with an issue as its source, close that issue there.
```

### Statuses

Each task is in one of your statuses (`state`, its id, and `state_name`). Every status has a
**kind**, which says what it means wherever the 0.3.0 fields are read:

| Kind | Default statuses | `status` | `done_at` | `held_at`, `waiting_on` | `closed_at` |
| --- | --- | --- | --- | --- | --- |
| `open` | To Do, In Progress | `open` | null | null | null |
| `hold` (open, waiting on someone) | Pending | `hold` | null | set | null |
| `done` (closed) | Done | `done` | when it was completed | null | = `done_at` |
| `cancelled` (closed) | Cancelled | `done` | **null** | null | when it was closed |

So `status` is still `open`, `hold` or `done`, `done_at` is still "when it was completed" (a
cancelled task was not, so `list --done-since` leaves it out) and an on-hold status still has
`waiting_on` and `held_at`. The 0.3.0 commands keep their meaning: `hold` moves a task to the
first on-hold status (Pending), `unhold` and `undone` to the first open one (To Do), `done` to
the first done one (Done); a task already in a status of that kind stays in it. `add` puts a task
in the first open status unless `--state`, `--done` or a hold says otherwise.

`orca-tasks statuses` lists them in order; `statuses add <name> [--kind open|hold|done|cancelled]
[--color <c>] [--position <n>]`, `statuses edit <status> [--name] [--kind] [--color]
[--position]` and `statuses rm <status> [--move-to <status>]` change them (a status is named by
its name in any case, or its id). Colours: gray, blue, purple, teal, green, amber, orange, red,
pink. Deleting a status moves its tasks to `--move-to`, else to the first other status of its
kind, else to the first open one; renaming one renames it on every task; changing its kind
changes what its tasks report. At least one open, one on-hold and one done status always stay,
so `hold`, `unhold`, `done` and `undone` always have somewhere to go. Names are unique (ignoring
case and punctuation).

`list` shows open tasks unless told otherwise: `--status open|hold|done|all`, or several joined
by commas (`--status open,hold`); `--open`, `--hold`, `--done` and `--all` are short forms;
`done` there means closed (done or cancelled). `--state <status>[,<status>...]` lists the tasks in
those statuses (open or closed, unless `--status` also narrows it). `--done-since` means
completed; `--view` (today, upcoming, inbox, done: the 0.2.0 panel's tabs) means every status the
view shows. A held task is never `--overdue`. `hold <id> --on <text>` needs the text (it is what
the task waits on); holding a held task again changes the text and keeps `held_at`; `unhold` makes
it open; `done` completes it and clears both hold fields; a closed task cannot be put on hold
(reopen it first). `edit --state <status>` moves a task to any status, and `edit --on <text>`
sets what it waits on (putting an open task on hold).

Text output names the status only when it is not the first of its kind (`(status In Progress,
…)`), so tasks in To Do, Pending and Done print as before; a cancelled task prints as `[-]`.

### Projects

`--project <name>` on `add`, `edit` and `list` matches an Orca project in any case and with `-`,
`_` or spaces, and stores or filters by that project's exact name; a name that is not an Orca
project is kept as typed.

`list --group project --json` answers groups in display order (most open first, "No project"
last):

```json
{ "today": "2026-11-23", "groups": [
  { "project": "online-store", "orca": true, "open": 2, "hold": 1, "total": 3, "tasks": [ ... ] },
  { "project": null, "orca": false, "open": 1, "hold": 0, "total": 1, "tasks": [ ... ] } ] }
```

`open` counts open tasks only; `hold` counts tasks on hold. `projects --json` lists every Orca
project, then every other project tasks use:

```json
{ "from": "host-api", "updated_at": "2026-11-23T08:00:00.000Z", "projects": [
  { "name": "online-store", "orca": true, "id": "…", "kind": "git", "path": "/home/me/…",
    "hidden": false, "open": 2, "hold": 0, "done": 1, "total": 3 },
  { "name": "Personal", "orca": false, "id": null, "kind": null, "path": null,
    "hidden": false, "open": 1, "hold": 0, "done": 0, "total": 1 } ] }
```

The CLI learns your Orca projects from `~/.orca-tasks/orca-projects.json`, which the plugin
keeps current from Orca (`from: "host-api"`, refreshed every minute). Before the plugin has run,
or with `projects --refresh`, it asks `orca repo list --json` instead (`from: "orca-cli"`).

### Bots

`orca-tasks send <id>` hands a task to an Orca bot with Orca's own CLI:

```sh
orca orchestration send --to bot:<name> --type handoff --subject "<title>" --body "<the task>"
```

- **Which bot**: `--to <name>`, else the bot of the task's project, else the main bot "Orca". A
  bot is a project's bot when its name is the project's (in any case, with `-`, `_` or spaces), or
  when what it is for (`orca bot list`, the first paragraph of its SOUL.md) names the project.
  `orca-tasks bots <id>` shows the choice.
- **What it asks** (`--type`, Orca's own message types): `handoff` (the default: the bot owns the
  job and says what it did when it has finished), `question` (it answers in its reply and does
  not take the task on unless asked; the subject starts `Question:`) or `status` (for its
  information, nothing back; `FYI:`).
- **Which chat**: the bot's Home Chat, its main chat (`--chat home`, the default since 0.6.0; it
  was a new chat before), a new chat of its own (`--chat new`; not for `--type status`, which
  cannot start a chat), the chat the task was last sent to (`--chat last`, for "check progress"
  on earlier work) or any chat by its id.
- **What it gets**: the title, due, priority, project, tags, status, source and task id, the notes
  unless `--no-notes`, and your `--note` (an instruction such as "check progress") above them.
  For a handoff the bot is told that you tick the task off after reading its reply.
- **Afterwards** (`--state <status>`): the task moves to that status once the message is
  recorded; to an on-hold status (Pending) it waits on the bot (`waiting_on` is the bot's name).
  Without `--state` it moves to **In Progress** (since 0.5.1): your open status named In Progress,
  or the one that started as In Progress if you renamed it. `--keep-state` leaves the status as it
  is, and so does a send when you deleted In Progress.
- **What is kept**: a `handoffs` entry on the task (below), with its type, the chat and message id Orca
  answered. Orca's answer names the message but not the chat, so the bot's chats are searched for
  the new one (Orca titles it "your owner's agent: <subject>"); if it is not there yet, the worker
  looks again on its next round and fills in `chat_id`. `list` shows "with bot <name>" and `get` every handoff.
- **Status**: `bot-status <id>` reads the chat with `orca agent read orca_session_id:<chat> --json`:
  `working`, `done`, `waiting`, `blocked` or `unknown`, and the bot's latest reply. In the panel
  and the board the task shows the bot and its state, and "answered" once the bot is done or
  waits on you; the task stays in the status the send put it in.
  `take-back <id>` ends the handoff. A status message is not a handoff: the bot does not "have"
  the task, so it is not under `--with-bot`.

**In the panel and the board**, **Send to a bot…** in a task's details opens the send form:
**Send to** (the project's bot first, then Orca, then the rest), **As** (handoff, question, status), **Chat** (the bot's Home Chat, a new chat, or the chat it had before when
it has one), **Instruction**, **Include the notes**, and **Then** (move to an open or on-hold
status, or leave the status as it is). **Chat** starts at **The bot's Home Chat** (since 0.6.0).
**Then** starts at **In Progress** (since 0.5.1), or at
"Leave the status as it is" when you deleted In Progress. A line under it says what will happen.
Nothing is sent until you press Send. The choices (not the instruction) are remembered per
project in `~/.orca-tasks/send-prefs.json` and are where the form starts next time for a task of
that project (the bot only while it exists, the status only while it exists; a project with
nothing remembered for Then, including one last sent from 0.5.0 or earlier, starts at In
Progress; a project whose remembered chat is "a new chat" from 0.5.1 or earlier, when that was
where the form started, starts at the Home Chat once, and what you choose then is remembered).

**It needs a sender.** Orca's mail names who sent it, so `orchestration send` works only in an
Orca terminal (`ORCA_TERMINAL_HANDLE` is set there): run `orca-tasks send` in one, yours or an
agent's. When you press Send in the panel or the board, the worker opens a terminal in the
focused workspace (in the background, titled "Agent Tasks: send to <bot>"), runs `orca-tasks send
<id> --to <bot> --type <type> --chat <new|home|last> --by panel [--note …] [--no-notes] [--state …
| --keep-state]`
in it, waits until the message is on the task (and the task in the chosen status), and closes the
terminal; an error it prints shows in the panel.

The CLI and the plugin's worker look for `orca` on PATH (or `$ORCA_CLI`), then in
`/Applications/Orca.app/Contents/Resources/bin/orca`.

### Send to the project

Besides a bot, a task can go to its **project**: Orca starts a new workspace there (a new branch
and worktree of the project) with a coding agent, and the agent's first prompt is the task.

- **Where**: the task's project must be one of your Orca projects, and a Git one (Orca starts
  workspaces only in Git projects). The send menu (▶ on a task, see
  [The send menu](#the-send-menu)) can also start it in any other of your Orca Git projects; the
  task keeps its own project, and the choices are remembered for the project it went to. The workspace is named after the task: its title in a few
  words and the start of its id (`fix-the-login-bug-2ec2`).
- **Which agent**: Claude Code (`claude`, the default) or Codex (`codex`).
- **What it gets**: your instruction, then the title, due, priority, tags, source(s) and task id,
  the notes unless you leave them out, and how to read the task again (`orca-tasks get <id>`). Orca
  takes at most 4096 characters, so very long notes are cut, with a pointer to the rest.
- **Afterwards**: moves the task to a status, In Progress unless you choose another or to leave
  it, as for a bot (an on-hold one waits on "<agent> in <workspace>"). The task records the
  workspace (`workspaces`, below).
- **In the panel and the board**, **Send to the project…** in a task's details (shown when the task
  has a project) opens a small form: the project, **Agent**, **Then**, an **Instruction**, **Include
  the notes** and **Show the workspace in Orca** (off: it starts in the background). Nothing starts
  until you press **Send to <project>**. The choices (not the instruction) are remembered per
  project. Afterwards the details show the workspace, what its agent is doing (working, waiting for
  your permission, done, idle, asleep, or "workspace removed"), **Open the workspace** and
  **Check**; rows and cards show the agent and its state. The worker reads it every minute with
  `workspace.list` (and when you press Check).
- **How**: the worker calls Orca's host API `workspace.create` with the project, the name, the
  agent and the prompt. That needs two capabilities, `workspace:create` and `agent:launch`, which
  0.5.0 adds: Orca asks you to approve the update. Until you do, the form says what to approve and
  sends nothing. No terminal is opened for it (a bot send needs one only because Orca's mail needs
  a sender).
- **CLI**: `orca-tasks send <id> --to-project [--agent claude|codex] [--note …] [--no-notes]
  [--state … | --keep-state] [--open] [--dry-run]` runs `orca worktree create --project <project> --name <name>
  --agent <agent> --prompt <the task> --no-parent` (`--open` adds `--activate`) and records the
  workspace the same way.

### Merging

Duplicates come in from different places: an agent that collects tasks can pick up the same ask
from a chat message and from a meeting's notes. Merging keeps one task and folds the others into it.

- **The kept task** keeps its title and status, and gets from the others:
  - their notes, each under a `## Merged from <title> (<id>)` heading (with its source);
  - their sources (`sources` lists them all, its own `source` first) and tags, each once;
  - their bot handoffs and project workspaces, in time order;
  - the earliest created date, the earliest due day (with its time) and the highest priority.
    The confirm step shows these and lets you choose otherwise (its own, none, another task's due
    day, any priority).
- **The others** are not deleted: they move to the first cancelled status (Cancelled) with
  `merged_into` set to the kept task and `merged_at`. `orca-tasks get <old id>` prints the task
  and the kept one (JSON: `merged_into` is the kept task). `add --dedupe --source <s>` answers the
  kept task when `<s>` belongs to it or to a task merged into it, so a merged duplicate is never
  added again; `list --source <s>` finds the kept task too.
- **Undo**: the latest merge can be undone (the notice's **Undo**, or `orca-tasks merge --undo`)
  as long as none of its tasks changed since; the file keeps what they were (`last_merge`).
- **In the sidebar and on the board**: Cmd-click (Ctrl-click) or Shift-click tasks to pick them; a
  bar shows how many are picked, with **Merge…** and **Clear** (Esc clears). **Merge…** on a task's
  details starts from that task (and any picked ones) and lets you add others. The confirm step
  lists them with the one to keep (the oldest to start with), Due, Priority and Created.
- **CLI**: `orca-tasks merge <keep> <id> [<id>…] [--due earliest|keep|none|<day>] [--priority
  highest|keep|<p>] [--created earliest|keep] [--dry-run]`, and `orca-tasks merge --undo`.

### Suggest merges

Since 0.6.0, **Suggest merges** (the ✦ button in the sidebar's header, the **Suggest merges**
button on the board) asks an AI agent which open tasks look like duplicates.

- **What you get**: a list of groups, the surest first, each with the task to keep, the others, a
  one-line reason and a confidence. **Review merge…** opens the merge confirm step above with
  that group filled in (the task to keep, the earliest due day, the highest priority); nothing
  merges until you press **Merge into …** there. **Dismiss** hides a group, and its pairs of tasks
  are not suggested again (kept in `~/.orca-tasks/merge-dismissed.json`). Esc (or the mouse's back
  button) closes the list; a group whose tasks were merged since drops out.
- **CLI**: `orca-tasks suggest-merges [--json] [--timeout <seconds>]` prints the same groups with
  the `orca-tasks merge` command for each, and merges nothing.
- **The agent** is Claude Code, run once on this computer without a terminal or a chat:
  `claude --print --output-format text --no-session-persistence --strict-mcp-config --tools ""`,
  from the temp folder, with the prompt on its standard input. The worker (or the CLI) runs it
  directly, as it runs `orca`, so it needs no Orca access beyond what the plugin has. It looks for
  `claude` on PATH, then in `~/.claude/local/`, `~/.local/bin/`, `/opt/homebrew/bin/` and
  `/usr/local/bin/` (`$ORCA_TASKS_SUGGEST_AGENT` names another program that takes the same
  arguments). It may take up to 3 minutes. Without Claude Code it says to install it (`npm install
  -g @anthropic-ai/claude-code`) and sign in once with `claude`; an answer that is not the JSON
  asked for, an error, or no answer in time says so, and nothing changes.
- **Where your data goes**: only the open tasks (at most 300, the most recently changed), and
  only their id, title, notes (the first 1000 characters), sources, tags, project, due day and
  status. No other files, no settings, no secrets: the agent has no tools and no MCP servers, so it
  can read nothing but the prompt, and nothing of the session is saved. Claude Code sends the
  prompt to Anthropic's API, as any prompt you give it, under your own Claude Code sign-in and
  its settings. Nothing is sent until you press the button (or run the command).

### The inbox (Simple Todo's format)

Agents that only append text can keep doing so: one line per task, appended to
`~/.orca-tasks/inbox.md` (create it if it is missing). The plugin takes lines in within a few
seconds, and every CLI command takes them in first, then the file is emptied.

```
- [ ] Text of the task !high @project-name #tag due:2026-01-31
```

Markers are optional and may sit anywhere: `!urgent`, `!high`, `!medium`, `!low` (or `!u`, `!h`,
`!m`, `!l`) for priority, `@name` for the project, `#name` for tags, `due:YYYY-MM-DD` (or
`due:today`, `due:tomorrow`, `due:fri`, `due:+3d`, and a time: `due:fri@15:30`,
`due:2026-01-31T09:00`). `source:<text-without-spaces>` sets the source. `- [x]` adds it as done.

This is the format of Simple Todo's `~/.simple-todo/inbox.md`. To keep existing agent
instructions working without editing them, turn on **Also take in Simple Todo's agent inbox** in
the plugin's settings: lines appended there then come into this list instead. Leave it off while
you still use Simple Todo, or the two plugins race for the same file.

## The board

The board is a custom editor for files ending in `.agenttasks`. Press **+** in the tab bar (or
run it from the command palette) and choose **Open Agent Tasks board**: Orca opens an untitled
`.agenttasks` tab with the board in it. The file stays empty; the tasks come from the worker. To
reopen it from the sidebar's **Board** button, save that tab as `Agent Tasks.agenttasks` at the
top of a workspace: the button opens it in the focused workspace. (Orca opens editor tabs only for
files inside a workspace, and the plugin never writes into one.)

- **List**: a group per status (its colour, name, a chevron, a count and "Show N more"); rows show
  the status dot (a menu of the statuses), the priority, on hold, the bot, the due chip (red when
  overdue, amber today), checklist progress, the project (an Orca project opens its workspace)
  and tags.
- **Board**: a column per status. Drag a card to another column, or within its own.
- **Details**: title, status, due day and time, priority, project, tags, what it waits on, notes
  with the checklist, the bot (the send form, its state and reply, Check the bot, Take back), the
  source link, the id, Put on hold and Delete. Fields save when you leave them.
- **Statuses** (the header button): each status with its colour, name, kind and task count; drag
  it by its grip (or use the arrows) to put it elsewhere in the order, delete it (its tasks move to the first other status of its kind), or add one.
  Closed statuses are left out when the due filter shows only open work (Overdue, Upcoming, No
  due day).
- **Header**: List / Board, search, Show (due filter), project filter, `open · high` counts and
  the overdue toggle, Statuses, and quick add (it adds to the project filter's project when the
  line names none).

## Quick actions

In the sidebar and on the board (list rows and cards), pointing at a task, or giving it the
keyboard focus, shows small icon buttons at its right edge, laid over it so nothing moves:

- **One icon per status** the task can move to (all of yours but its own), in your order, with
  your status's name as its tooltip: ✓ for a done status, a clock for an on-hold one, ✕ for a
  cancelled one, ▶ for In Progress and ○ for another open one. A click moves the task there, as
  the status menu does, and never opens it; ▶ on an open task no bot has opens the send menu
  instead (below). Moving to an on-hold status (Pending) puts it on hold
  as before, waiting on nobody yet: **Waiting on** in its details says on whom.
- **When they do not all fit** (a sidebar row takes 4, a card 3, a board list row 6), your first
  done, on-hold and cancelled statuses (Done, Pending, Cancelled) come first, with ▶ right after
  Done when it opens the send menu; the others go to **…**.
- **…** lists those statuses and the other actions: **Open**, **Send to a bot…**, **Send to the
  project…** (a task with a project), **Merge…** and **Pick for a merge**.
- Keys for the same, on the task under the cursor (or the open one): **X** or **Space** done,
  **P** Pending (your first on-hold status; P again takes it off hold), **C** Cancelled (your
  first cancelled status; C again reopens it). Without a cancelled status, C says so.

### The send menu

▶ (In Progress) on an open task that no bot has opens a menu by the button; the task stays
closed. It lists:

- **Bots**: the one the send form would pick first (the bot chosen last for this project, else
  the project's bot, else Orca), then the others, as `orca bot list` gives them. A paused bot is
  greyed out. They come from Orca a moment after the menu opens.
- **Projects**: the task's own project first when it is one of your Orca Git projects, then your
  other Orca Git projects (folder projects take no workspaces; hidden ones are left out).
- **Only move to In Progress**: the move ▶ made before, without sending.

A click, or the arrows (Home, End) and Enter, sends at once with the forms' usual choices: to a
bot's Home Chat as a handoff, with the notes unless this project's last send left them out; or to
a project as a workspace of its own with the agent, notes and **Show the workspace in Orca**
chosen there last (Claude Code at first). The task moves to In Progress, and the bar at the top
says "Sending…" and then what happened, or why not. Esc or a click elsewhere closes the menu, and
the keyboard goes back to the row or card. For an instruction, a question, a status message or
another chat, use the forms in the task's details.

A task a bot has (a handoff not taken back) and a closed task keep the plain ▶: it moves the task
to In Progress.

## Shortcuts

| Command (palette) | macOS | Windows and Linux |
| --- | --- | --- |
| **Agent Tasks: Show or Hide Sidebar** | Cmd+Shift+U | Ctrl+Shift+U |
| **Agent Tasks: Open Board** | Cmd+Shift+X | Ctrl+Shift+X |

- **Show or Hide Sidebar** opens the right sidebar on the tab it showed last, or hides it when it
  is open; it is Orca's own **Toggle Right Sidebar** (Cmd+L / Ctrl+L) under a name of its own.
  Orca gives plugins no way to select their own panel, so it cannot switch the sidebar to Agent
  Tasks from another tab such as Files: pick the Agent Tasks tab once (its check icon in the
  sidebar's activity bar), and from then on the shortcut brings it back there.
- **Open Board** opens the board file in the focused workspace, like the sidebar's **Board**
  button (see [The board](#the-board)); without one it says how to make it.
- Neither chord is one of Orca's own shortcuts or the code editor's. To change or remove one:
  Settings → **Shortcuts**, group **Plugins** (or search for "Agent Tasks"); its **Conflicts**
  filter shows a chord bound twice.

### In the panel and on the board

These keys belong to the page itself, so they work while the sidebar panel or the board has the
focus (click in it first), and Orca's Settings → Shortcuts does not list them. Press **?** (or the
**?** button in the header) to see them there.

| Key | What it does |
| --- | --- |
| ↑ ↓ or J K | Move between the tasks shown. With the details closed a cursor moves (an outlined row or card); with them open the details follow, unless a send or merge form is open there |
| Enter | Open the task under the cursor |
| X or Space | Done, or reopen, the task under the cursor (else the open one) |
| P | Pending: the task under the cursor (else the open one) to your first on-hold status; on hold already, back to your first open status |
| C | Cancelled: to your first cancelled status; cancelled already, reopened (your first open status) |
| N | Put the cursor in quick add (in the sidebar, / too) |
| / | Search (the board) |
| V | List or board (the board) |
| Cmd+Enter (Ctrl+Enter) | In a field of the details (notes, title, tags): save it and stay. In a send form: send |
| Esc | Close what is on top: the status menu, the shortcuts list, a send or merge form, the merge suggestions, the details, Statuses; then clear the picked tasks |
| Mouse back button, Cmd+[ | Back: close what is on top, as Esc does (the details first, then a form or menu on top of them); then go back to the view before: the Show filter, the project, list or board (the board). A Logitech MX Master's thumb button, or any mouse's button 4 ("back"), whichever of its pointer, mouse or `auxclick` events arrive (one step per press); the Browser Back key, Cmd+[ (also in a field) and Cmd+Left (not in a field) too |
| Mouse forward button, Cmd+] | Forward again: the view Back left, or the task it closed; Cmd+Right too (not in a field) |
| ? | Show or hide the list of these keys |

- **When the mouse's back button does nothing**: mouse software can send it as a key, a mouse
  button or a swipe, and a swipe never reaches the page. The page logs a line starting
  `agent-tasks nav` to the console of its frame for buttons 3 and up and for every key it takes as
  Back or Forward; run `agentTasksDebugNav(true)` in that console (or open it with `?debug-nav`)
  to log every mouse button and every key with Cmd, Ctrl or Alt, and `agentTasksDebugNav(false)`
  to stop.
- **Typing is never a shortcut**: while the focus is in a text field, a select or a checkbox, every
  key is the field's, except Esc and Cmd/Ctrl+Enter. A focused button takes Enter and Space.
- **Esc does not lose what you typed**: in a field of the details (title, notes, tags, waiting on)
  Esc saves it, as leaving it always does, and closes the details. In quick add, search or
  Statuses it only leaves the box and keeps the text. On a send form with an instruction typed in
  it, the first Esc says it has not been sent and the second discards it; with none, one Esc
  closes the form.
- **Back is the page's own**: the panel and the board keep the views you went through (up to 50)
  and go back through them; they never navigate the frame or add entries to Orca's history, and
  the button's own "go back" is stopped there, so it never takes the panel or the board away.
  Forward is dropped when you change the view yourself, as in a browser.
- They need no access: they are not Orca keybindings, only the page listening to its own keys and
  mouse buttons.

## Dragging

The sidebar and the board are the same page (`src/board/`), so they drag the same way:

- **To another status**: drag a task onto another section (a collapsed one by its header; it
  opens) or another column. It lands where the line shows (above the task under the pointer, or
  at the end), and its fields change as with the Status field: to a done status it is completed
  (`done_at`), to an on-hold one it goes on hold (`held_at`), and so on.
- **Within a status**: drag it up or down to put the section in your order. Tasks you never
  dragged come first, in the usual order (due day, priority, age); the ones you placed follow in
  your order. The order is kept on the tasks (`rank`) and shows in the sidebar and the board; the
  CLI's `list` keeps its own order (due day, priority) and scripts using the CLI see no change.
- **Statuses**: in Statuses, drag a status by its grip (⋮⋮) to another place in the order.
- A press only becomes a drag after the pointer moves a few pixels, so a click still opens the
  task. Escape cancels a drag. Near the top or bottom of the list (or a column) it scrolls.
- **Without dragging**: the coloured dot on each task opens a menu of the statuses (arrow keys
  and Enter work in it); the details have a Status field.

Dragging uses pointer events, not the browser's drag and drop (`draggable`, `dragstart`,
`drop`): Orca shows the board and the sidebar in isolated frames, where that drag and drop does
not arrive reliably (in 0.4.0 a dragged card did not land), while pointer events are plain mouse
input there. The sidebar was an Orca components panel up to 0.4.0, which has no dragging at all;
since 0.4.1 it is this page as an HTML panel.

## Reminders

While the plugin is enabled its worker checks every few seconds for open tasks that came due: at
their time, or at **Reminder time** (Settings → Plugins → Agent Tasks, default 9:00) on their day
when they have none. Several at once make one notification. It keeps what it reminded about in
`~/.orca-tasks/reminders.json`, so a restart does not repeat them; a new due day reminds again.
Tasks that were already due when 0.3.0 first ran, and reminders more than 12 hours late (Orca was
closed), are not sent. Turn **Due reminders** off to stop them.

## Data format

`~/.orca-tasks/tasks.json` (or `$ORCA_TASKS_HOME/tasks.json`; that variable is for tests and
scripts, the panel always uses `~/.orca-tasks`):

```json
{
  "format": "orca-tasks",
  "version": 1,
  "schema": 3,
  "revision": 42,
  "updated_at": "2026-11-23T06:12:09.120Z",
  "statuses": [
    { "id": "todo", "name": "To Do", "color": "gray", "kind": "open", "closed": false },
    { "id": "in-progress", "name": "In Progress", "color": "blue", "kind": "open", "closed": false },
    { "id": "pending", "name": "Pending", "color": "amber", "kind": "hold", "closed": false },
    { "id": "done", "name": "Done", "color": "green", "kind": "done", "closed": true },
    { "id": "cancelled", "name": "Cancelled", "color": "red", "kind": "cancelled", "closed": true }
  ],
  "tasks": [
    {
      "id": "t-k3m9x2pa",
      "title": "Reply to Alice about the budget",
      "notes": "She asked in #finance",
      "created_at": "2026-11-23T01:02:03.000Z",
      "updated_at": "2026-11-23T06:12:09.120Z",
      "due": "2026-11-24",
      "due_time": "15:30",
      "priority": "high",
      "project": "ops",
      "tags": ["chat"],
      "source": "chat:msg_123",
      "done_at": null,
      "status": "hold",
      "waiting_on": "Bob's review",
      "held_at": "2026-11-23T05:00:00.000Z",
      "state": "pending",
      "state_name": "Pending",
      "closed_at": null,
      "handoffs": [
        {
          "bot": "Orca",
          "bot_id": "aab02357-…",
          "type": "handoff",
          "chat": "new",
          "chat_id": "3540ecf3-47c3-4876-b825-81bf5d6b3595",
          "message_id": "msg_…",
          "subject": "Reply to Alice about the budget",
          "sent_at": "2026-11-23T06:00:00.000Z",
          "by": "panel",
          "returned_at": null
        }
      ]
    }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | `t-` and 8 lowercase letters or digits. Never changes or gets reused. |
| `title` | string | One line, not empty. |
| `notes` | string | Free text, `""` when none. |
| `created_at`, `updated_at` | string | ISO 8601 in UTC. |
| `due` | string or null | A local calendar day, `YYYY-MM-DD`; null means no due day (Inbox). |
| `priority` | string | `urgent`, `high`, `medium`, `low` or `none`. |
| `project` | string or null | Free name; an Orca project's exact name when it names one. |
| `tags` | string[] | Without `#`. |
| `source` | string or null | Free text: an issue URL, `chat:<id>`, `issue:<id>`... |
| `done_at` | string or null | ISO 8601 in UTC when completed (a done status); null otherwise, also for a cancelled task. |
| `status` | string | `open`, `hold` or `done`, from the kind of the task's status: open → `open`, hold → `hold`, done and cancelled → `done`. Always agrees with the next fields: `done` when `done_at` or `closed_at` is set, else `hold` when `held_at` is set, else `open`. |
| `waiting_on` | string or null | On hold: who or what it waits on. null otherwise. |
| `held_at` | string or null | On hold: ISO 8601 in UTC when it went on hold. null otherwise. |
| `due_time` | string or null | A local time on the due day, `HH:MM` (24-hour); null means due by the end of the day. Only set when `due` is. Since 0.3.0. |
| `handoffs` | object[] | Each time the task was sent to a bot, oldest first: `bot`, `bot_id`, `type` (`handoff`, `question` or `status`; since 0.4.0, `handoff` when missing), `chat` (`new`, `home`, or `existing` for an earlier chat; since 0.4.0), `chat_id` (the chat's Orca session id), `message_id`, `subject`, `sent_at`, `by` (`panel`, `board` or `cli`), `returned_at` (when it was taken back, else null). The latest handoff or question without `returned_at`, on a task not closed, is the bot it is with now. Since 0.3.0. |
| `state` | string | The id of its status, one of the file's `statuses`. Since 0.4.0. |
| `state_name` | string | That status's name, kept up to date when the status is renamed. Since 0.4.0. |
| `closed_at` | string or null | ISO 8601 in UTC when it was closed (done or cancelled); equal to `done_at` for a done task; null while open. Since 0.4.0. |
| `workspaces` | object[] | Only on tasks sent to their project: each time, oldest first: `project`, `project_id`, `workspace_id` (the id `workspace.list` gives it), `workspace_name`, `terminal_id` (the agent's terminal, when known), `agent` (`claude` or `codex`), `sent_at`, `by`. Since 0.5.0. |
| `sources` | string[] | Only on a task others were merged into: every source it holds, its own `source` first. Since 0.5.0. |
| `merged_into`, `merged_at` | string | Only on a task merged into another: the kept task's id, and when. Such a task is cancelled. Since 0.5.0. |
| `merged_from` | string[] | Only on a kept task: the ids merged into it. Since 0.5.0. |
| `rank` | number | Only on tasks dragged into place: their place within their status (1 first). Tasks without it come first in the sidebar and the board; the CLI does not use it. Dropped when the task changes status another way. Since 0.4.1. |

The file's `statuses` (since 0.4.0) lists the statuses in the order shown: `id` (lowercase
letters, digits and `-`; never changes), `name`, `color`, `kind` (`open`, `hold`, `done` or
`cancelled`) and `closed` (true for done and cancelled).

`status`, `waiting_on` and `held_at` arrived in 0.2.0 without a format change: a task written
before has none and reads as `open` (or `done`), and older versions keep the fields as they are.

**Schema 2 (0.3.0).** `due_time` and `handoffs` are on every task, and the file records
`"schema": 2` (a file without `schema` is schema 1). Reading an older file fills them in (null and
`[]`) in memory; the worker writes the migrated file once when it starts, and any write does too.
`version` stays 1: 0.2.0 still reads the file, and its writes keep `due_time` and `handoffs` as
unknown fields. `due` is still a plain day, so readers that only know `due` see the same day.

**Schema 3 (0.4.0).** The file has `statuses` and every task `state`, `state_name` and
`closed_at`. A file without them gets the default statuses, and each task: done (`done_at` set)
→ Done; on hold (`held_at` set) or waiting on someone (`waiting_on` set) → Pending; otherwise →
To Do. `status`, `done_at`, `held_at` and `waiting_on` are kept as they were. The worker writes the
migrated file once when it starts. `version` stays 1, so 0.3.0 still reads the file. When an older
version changes a task after that (completes, reopens, holds or unholds it), its fields win: the
task is put in the first status of the kind they describe when its `state` no longer agrees.

**0.5.0** adds no schema: `workspaces`, `sources`, `merged_into`, `merged_at` and `merged_from`
are only on the tasks they apply to, and the file's `last_merge` (what undoing the latest merge
puts back) only after a merge. Older versions keep them as unknown fields. Every field that scripts
using the CLI read keeps its meaning; a merged task reads as a closed (`done` status, no `done_at`) task.

`revision` goes up by one on every write, so a reader can tell cheaply whether anything changed.
Fields this version does not know, on the file or on a task, are kept when it writes.
`version` changes only for a change older readers cannot read; they then refuse the file
rather than damage it.

**Writing safely.** Use the CLI (or `TaskStore` in `src/core/store.ts`) rather than editing the
file. Every write takes `~/.orca-tasks/tasks.json.lock` (created exclusively), reads the file,
writes a temporary file beside it and renames it over `tasks.json`, then removes the lock. Readers
take no lock: the rename swaps the file in one step, so they see the old list or the new one. A
lock whose process has died, or that is older than 30 seconds, is cleared by the next writer. The
panel, the worker and any number of CLI processes can write at once without losing a change (the
tests run six processes writing together).

