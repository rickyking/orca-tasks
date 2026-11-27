# Developing Agent Tasks

Orca loads the TypeScript as written; there is no build step and nothing to install. You need
Orca 1.4.259 or newer, Node 22.18 or newer on `PATH`, and Chrome for the browser tests.

## Load a checkout into Orca

```sh
git clone https://github.com/rickyking/orca-tasks.git
cd orca-tasks
orca plugin dev load .
```

**A development copy uses your real task list.** Its worker reads and writes `~/.orca-tasks`,
migrates the file to its own schema when it starts, and installs its CLI at
`~/.orca-tasks/bin/orca-tasks`, like the installed plugin. Copy `~/.orca-tasks` somewhere first
if you are trying out unreleased changes.

The first load stops with `approval_required`: the plugin runs a worker (`trusted-worker`), so
Orca lists what it would be granted and prints a fingerprint. Read it, then approve:

```sh
orca plugin dev load . --approve <fingerprint>
orca plugin open local.agent-tasks    # show the panel in the right sidebar
```

The folder loads as `local.agent-tasks`, beside (not instead of) an installed
`rickyking.agent-tasks`; disable one of them while you use the other, or both act on the same
files. Orca reloads it when files change. To take it out again: `orca plugin dev unload .`, or
Settings → Plugins → **Development folders…**. `orca plugin dev watch .` loads the folder and
streams its logs and reloads until Ctrl-C.

## Tests

```sh
npm test                    # store, CLI, merge, project send, send form and drag helper tests,
                            # plain Node (CI runs it)
npm run test:browser        # the sidebar and the board in headless Chrome, dragged with real
                            # mouse input over the DevTools protocol (CI runs it; skipped without
                            # Chrome; AGENT_TASKS_SHOTS=<dir> saves screenshots)
orca plugin test .          # all tests, including the worker over Orca's mock host
orca plugin types . && npx -p typescript tsc -p .   # type-check against Orca's typings
orca plugin validate .
ORCA_TASKS_HOME=$(mktemp -d) orca plugin check .    # check the board's page
```

`orca plugin check` and `orca plugin test` start the worker; give `ORCA_TASKS_HOME` a temporary
folder so they leave `~/.orca-tasks` alone (the tests already do). Keep `.orca/` (generated
typings) out of commits; it is in `.gitignore`.

## Layout

```
assets/icon.png         the plugin icon
bin/orca-tasks          the CLI, run from a checkout
docs/                   this file, the reference, the screenshots, and the flyer (flyer/)
src/
├── core/               shared by everything: types, days and times, the Simple Todo line
│                       format, pure task operations, statuses, checklists, sections, bots
│                       (Orca's CLI), sending to a project, merging, what the send forms
│                       send (send-input.ts), and the locked file store with its migration
├── cli.ts, cli-bin.ts  the CLI
├── worker.ts           requests from the sidebar and the board, file watching, inbox, status bar,
│                       reminders, bot chats, CLI install
├── board/              the sidebar panel (sidebar.html) and the board tab (board.html, a custom
│                       editor): one page, board.ts, in an isolated frame; drag.ts drags with
│                       pointer events; test/ has the stand-in worker the browser test uses and
│                       the demo data for the screenshots
├── protocol.ts         the sidebar/board <-> worker requests
└── *.test.ts
```

## Screenshots

The README's screenshots and the plugin page's cover and screenshots (`docs/screenshots/`) come
from made-up tasks (`src/board/test/demo-data.ts`) shown by the stand-in worker in headless
Chrome, never from a real task list:

```sh
AGENT_TASKS_README_SHOTS=docs/screenshots npm run test:browser
```

The cover (`docs/screenshots/cover.png`) is the flyer, `docs/flyer/flyer.html`: one self-contained
page with made-up tasks, drawn at 1600 × 1000. After changing it, render the cover again in
headless Chrome:

```sh
docs/flyer/render.sh
```

## Releasing

1. Bump `version` in `orca-plugin.json` and `package.json`, and `VERSION` in `src/cli.ts` and
   `src/worker.ts` (`npm test` checks they agree and that `CHANGELOG.md` has the version).
2. Add the changes to `CHANGELOG.md`.
3. `orca plugin validate .` passes, and `orca plugin inspect . --json` shows the access you expect.
   An update that adds a capability, command, panel, status bar item or event, or raises the
   execution profile, asks every user to approve it again.
4. Merge to `main`, then tag that commit and push the tag:
   `git tag -a v0.6.3 -m v0.6.3 && git push origin v0.6.3`. `orca plugin install
   rickyking/orca-tasks` installs the highest `vX.Y.Z` tag.
5. The repository needs the `orca-plugin` topic once
   (`gh repo edit rickyking/orca-tasks --add-topic orca-plugin`); the listing is at
   <https://orca.dev/plugins/rickyking/orca-tasks>.

The id is `agent-tasks` (ids starting `orca-` are reserved for Orca's own plugins), so it installs
as `rickyking.agent-tasks`. The manifest leaves out `publisher`: Orca takes it from the
repository owner.
