# Kuro guide

Start with the [quickstart](../README.md#quickstart).

## Install with your coding agent

Send your agent this:

```text
Install Kuro from https://github.com/haynoke/kuro securely and safely.
```

If you are the agent doing the install, follow these steps.

1. Check for Windows, [Node.js 22+](https://nodejs.org/), Git, and which coding agent CLIs are installed ([below](#install-a-coding-agent)). Ask before installing anything that is missing.
2. Clone the repository, or use the existing checkout. Keep any `config.json`, `data` folder and provider sign-ins that are already there.
3. Read the code and `config.example.json` before running it. Kuro has no npm packages, so there is nothing to `npm install`.
4. Ask which accounts to add. Check for existing ones with `node scripts/accounts.js list`, then add each with `node scripts/accounts.js add <claude|codex> [name] --no-login`.
5. Sign-in is the user's step. For an account that needs it, give them the command `node scripts/accounts.js login '<name>'` to run in their own terminal. Do not read, copy or print credential files, tokens or API keys.
6. Keep approval and sandbox protections on. Do not add permission-bypass flags. Pause if the user needs to finish Windows sandbox setup.
7. Leave remote access, chat, voice and desktop control off unless the user asks for them.
8. Run `node scripts/doctor.js`, start `node server.js`, and complete the startup task under [First task](#first-task).
9. Report what passed, any step still waiting on the user, and how to start Kuro next time.

## Install a coding agent

Kuro needs at least one of these CLIs. Install either, or both.

| Agent | Install | Add an account |
| --- | --- | --- |
| Claude Code | [Setup guide](https://code.claude.com/docs/en/setup), including its Windows prerequisites | `node scripts/accounts.js add claude` |
| Codex | `npm install -g @openai/codex` | `node scripts/accounts.js add codex` |

For coding tasks with Codex on Windows, also run `codex` once in a disposable project folder and complete its sandbox setup. Keep its normal protected workspace mode. See the [Codex Windows sandbox guide](https://learn.chatgpt.com/docs/windows/windows-sandbox). Claude Code's default permission mode can deny edits or commands in a noninteractive run; add a narrowly scoped permission rule if needed. Do not enable permission bypasses.

## Accounts

An account is one sign-in to one provider. The list can be any length, and its order is the priority order.

- **Add** one on the Accounts page, or with `node scripts/accounts.js add <claude|codex> [name]`. The command creates `config.json` from the example if it is missing.
- **Sign in.** The first account of a provider reuses the sign-in already on your PC. Each further one gets a profile folder under `.kuro\accounts` in your home folder (change it with `accountsRoot`), and the command opens the provider's sign-in for it. Choose the right login in the browser. Add `--new` to give even the first account its own folder, or `--no-login` to sign in later with `node scripts/accounts.js login <name>`.
- **From the web page**, a new account that needs sign-in shows the command to run on your PC. Interactive sign-in is not relayed to the phone. The page notices within about 30 seconds, or press **Check again**.
- **Reorder** with **Move up** and **Move down**, or `node scripts/accounts.js move <name> <position>`.
- **Remove** one on the page or with `node scripts/accounts.js remove <name>`. A round already running on it finishes first. Its profile folder and sign-in stay on disk until you delete them.

Changes apply to a running Kuro without a restart. A profile folder starts with fresh provider settings, so user-level permission rules, MCP servers and Codex sandbox setup from your main profile may need repeating there. Rules saved in a project folder apply to every account.

Accounts are stored in `config.json`, and you can edit the list by hand:

```json
"accounts": [
  { "name": "Claude", "engine": "claude", "env": {} },
  { "name": "Claude work", "engine": "claude", "env": { "CLAUDE_CONFIG_DIR": "D:\\agents\\claude-work" } },
  { "name": "Codex", "engine": "codex", "env": {} }
]
```

`CLAUDE_CONFIG_DIR` and `CODEX_HOME` point an account at its own sign-in. Use accounts you are authorized to access and follow each provider's terms.

## First task

```powershell
node scripts/doctor.js
node server.js
```

The check lists each account and should report at least one as `signed in and ready`. The server should print `Kuro is up: http://localhost:8790`. Keep that terminal open, or use `start.cmd` next time.

Open [localhost:8790](http://localhost:8790), choose **Start a coding task**, then **New task**. Leave Folder empty to get a separate workspace under your home folder's `Kuro Tasks` directory. Choose Low effort and submit:

```text
This is a read-only startup check. Do not use tools or change files. Reply with "kuro is ready" and end with TASK STATUS: DONE.
```

Success is a task marked **Done**, with `kuro is ready` in the latest reply. That checks the page, runner, sign-in, and provider connection without requiring write permissions.

Then try a small coding task in a disposable folder: `Create hello.txt containing kuro works, read it back to check it, and update the progress log.` Success is **Done**, the file in the task's working folder, and a progress entry on its task page. If it says Needs you, read the reply and resolve the permission or sandbox setup in the provider CLI before choosing Resume. Kuro does not present interactive CLI approval prompts in the browser.

## Turn phone access off

To turn phone access off, run `tailscale serve reset`, set `remoteAccess` to `false`, and restart Kuro. Reset clears this device's Serve configuration, so check `tailscale serve status` first if you use Serve for other services.

## What happens to a task

A provider gets your prompt and instructions to keep `PROGRESS.md` current. It ends a turn with `TASK STATUS: DONE`, `CONTINUE`, or `BLOCKED`. Continue starts another turn in the same session; Blocked waits for your reply. Notes sent while a task runs arrive on its next turn.

A task stays on its account while that works. A new task starts on what **Start with** names, otherwise the first free account in the list. On a recognized usage-limit response, Kuro puts that account on cooldown and tries another available one, preferring the task's chosen account or provider, then an account that already worked on it, then list order. After three failed turns in a row, the account is set aside for that task and another is tried. If every account is out of usage, the task waits for the earliest reset, and continues sooner if you add, sign in or mark ready another account. The new account reads the progress log and checks the working files. This is a handoff between separate sessions, not a transfer of hidden conversation state. If the agent never wrote a progress log before interruption, the next provider has less context.

Reset times are estimates parsed from provider output. Unknown reset times use a 30-minute retry. Usage cards use Claude's run events and Codex's local session files when available; they can be missing or stale. Missing CLI or sign-in blocks with a setup message rather than waiting for a usage reset.

High effort requests a review from a different provider when one has an available account. With accounts from only one provider there is no separate review. If no other provider is available, the event history says review was skipped. An invalid review or unresolved requested changes stops for you rather than claiming a pass. Low and Medium use one agent without a separate reviewer.

After a restart, running tasks return to the queue, interrupted turns are marked, and saved provider session IDs are reused. Waiting tasks keep their cooldowns. Blocked, stopped, and finished tasks stay that way until you act. Keep only one Kuro process per data directory.

Task creation, session IDs, and completed turns save immediately; other updates are briefly debounced, so a hard crash may lose the latest activity. Kuro does not undo partial agent edits. Check the files after a crash before resuming work with side effects.

## Optional setup

### Ollama chat

Tasks work without Ollama. The optional chat uses a local model to answer questions, find files, manage tasks, and pass coding work to a provider.

Install [Ollama](https://ollama.com/), then run:

```powershell
ollama pull qwen3.5:9b
```

Set `chat` to `true` in `config.json`, leave `localModel` at `qwen3.5:9b`, and restart Kuro. Run `node scripts/doctor.js` to check the model and connection. The model needs enough RAM or VRAM for your context; choose a smaller model or context on smaller machines. The first download requires internet.

If Ollama is not running, Kuro tries to start its local installation. Set `ollamaPath` for an unusual install location, or `ollamaUrl` for a different endpoint. A remote Ollama URL sends chat content there.

### Desktop control

With chat enabled, setting `desktopControl` to `true` lets the local model take screenshots and operate Windows through `desktop.ps1`. It starts disabled. This is desktop automation with your logged-in user's access, outside the coding providers' sandbox. It requires an interactive desktop, not a locked or headless session.

The model is instructed to ask before sending, buying, or deleting, but that instruction is not an enforced approval dialog. Enable this only if you accept that access. Desktop control is independent of provider MCP tools.

### Voice

Voice starts disabled. The microphone lives in the optional chat, so enable chat and Ollama first. Install Python and faster-whisper in the Python environment Kuro will use:

```powershell
python -m pip install faster-whisper
```

Set `voice` to `true` and restart. Set `pythonPath` to the full Python executable path if needed. `whisper_server.py` listens on localhost port 8792 and loads `small.en` on the CPU by default. Its first run downloads model files. Browser recordings go to this PC for transcription. Sending the resulting text to a coding provider still sends that text to the provider.

In chat, use the mic button or Ctrl+D. A second press or a pause sends the recording; Esc cancels. Read aloud uses the browser's speech service and available voices. Phone microphone access requires the Tailscale HTTPS URL; keyboard dictation also works. Check `/api/voice` while signed in for model readiness or load errors. Change `whisperPort` if 8792 is occupied.

### Roblox Studio

Kuro does not ship or install the Studio bridge. If your Roblox Studio setup already supplies `%LOCALAPPDATA%\Roblox\mcp.bat`, copy the example in the **kuro folder**:

```powershell
Copy-Item mcp.example.json mcp.json
```

Set `claudeMcpConfig` to `mcp.json` in `config.json`. Adjust the ignored local file for your installed bridge. Claude receives it through `--mcp-config`; Codex uses MCP servers in its own CLI configuration. Open the intended Studio place and verify tools from the provider CLI first. Provider tool approvals still apply. This is not needed for the first task.

## Configuration and private files

`config.example.json` is the portable starting point. `config.json`, `mcp.json`, `data/`, and local review artifacts are ignored by Git. Do not force-add them. Back them up privately before upgrading; an existing config is never overwritten automatically.

| Setting | Purpose |
| --- | --- |
| `accounts` | Any number of accounts, in priority order, each with a name, engine and optional environment variables. Changes apply without a restart. |
| `accountsRoot` | Parent for new account profile folders. Default: `.kuro\accounts` under your home folder. |
| `codexPath`, `claudePath` | Optional full executable paths if a CLI is not on PATH. Standard Windows npm provider shims use their Node entry points. |
| `codexArgs`, `claudeArgs` | Limited model/run options. Kuro rejects permission bypasses and arbitrary security overrides. |
| `workspaceRoot` | Parent for new task folders. Default: `Kuro Tasks` under your home folder. Existing project folders can be selected instead. |
| `projects` | Optional folder shortcuts, each with `name` and full `path`. |
| `maxParallel`, `maxRounds`, `reviewRounds` | Concurrent tasks, maximum work turns, and review-fix attempts. Low and Medium also have smaller turn limits. |
| `KURO_CONFIG`, `KURO_DATA_DIR` | Environment overrides for an isolated config and data directory. Relative paths resolve from the launch directory. |

When updating an older personal install, compare it with the example. Old configs may contain bypass flags; those providers will be unavailable until you remove them. Remote IP access also changes to the authenticated Serve setup. Local config and task data are retained.

Task state lives in `data/tasks.json`, account cooldowns and usage in `data/accounts.json`, and chats in `data/chats.json`. Each task has `data/tasks/<id>/PROGRESS.md`, `log.txt`, and a `files/` directory for images. These can contain prompts, source details, local paths, and account metadata. Deleting a task removes its list entry, not its working files or saved logs. A corrupt state file stops startup instead of silently discarding tasks; restore a private backup or move that file aside deliberately.

## Troubleshooting and checks

Run `node scripts/doctor.js` from the Kuro folder. Missing config tells you the copy command. Missing provider or sign-in tells you what to fix. An API key in the environment Kuro starts from, such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, can take priority over an account's own sign-in; remove it if accounts appear to share usage. If a port is occupied, startup exits with an explanation; change `port` in local config and match the Serve target if enabled.

Codex runs with workspace-write and approval policy on-request. Claude uses default permission mode. Existing provider policies, project rules, hooks, MCP servers, and platform restrictions still apply. Noninteractive CLIs can deny approval requests instead of displaying them. Resolve the prerequisite or narrowly scoped permission in the provider CLI, then Resume. A chat reply is not a CLI approval. See [Codex noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode) and [Claude permissions](https://code.claude.com/docs/en/permissions).

Run `npm test` to check a change. Tests create temporary copies and use controlled CLI event fixtures for task completion, rate limits, restart recovery, and permissions. They do not contact paid providers or touch your task data.
