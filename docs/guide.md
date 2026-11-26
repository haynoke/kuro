# Kuro guide

Start with the [quickstart](../README.md#quickstart).

## Use Codex

The example uses **Codex only**. If you do not have its CLI, install it, then sign in:

```powershell
npm install -g @openai/codex
codex login
codex login status
```

Complete sign-in in the browser when asked. The status command should say you are logged in. For coding tasks on Windows, also run `codex` once in a disposable project folder and complete its sandbox setup. Keep its normal protected workspace mode. See the [Codex Windows sandbox guide](https://learn.chatgpt.com/docs/windows/windows-sandbox).

Back in the **kuro folder**, check setup and start it:

```powershell
node scripts/doctor.js
node server.js
```

The check should report `Codex: signed in and ready`. The server should print `Kuro is up: http://localhost:8790`. Keep that terminal open, or use `start.cmd` next time.

Open [localhost:8790](http://localhost:8790), choose **Start a coding task**, then **New task**. Leave Folder empty to get a separate workspace under your home folder's `Kuro Tasks` directory. Choose Low effort and submit:

```text
This is a read-only startup check. Do not use tools or change files. Reply with "kuro is ready" and end with TASK STATUS: DONE.
```

Success is a task marked **Done**, with `kuro is ready` in the latest reply. That checks the page, runner, sign-in, and provider connection without requiring write permissions.

Then try a small coding task in a disposable folder: `Create hello.txt containing kuro works, read it back to check it, and update the progress log.` Success is **Done**, the file in the task's working folder, and a progress entry on its task page. If it says Needs you, read the reply and resolve the permission or Windows sandbox setup in the provider CLI before choosing Resume. Kuro does not present interactive CLI approval prompts in the browser.

## Use Claude Code

Install and sign in following the [Claude Code setup guide](https://code.claude.com/docs/en/setup), including its Windows prerequisites. In `config.json`, replace `accounts` with:

```json
"accounts": [{ "name": "Claude", "engine": "claude", "env": {} }]
```

Run `claude auth login`, then `claude auth status`. Repeat the setup check and startup commands above. Leave `claudeArgs` empty for the first task. Default permission mode can deny edits or commands in a noninteractive run; use a narrowly scoped provider permission rule if needed, then Resume. Do not enable permission bypasses.

## Set it up with your coding agent

Paste this into an agent opened in your Kuro checkout:

```text
Set up this Kuro checkout using its README and docs/guide.md. Read the code and config example first. Check Windows, Node.js 22+, Git, and the installed Claude Code or Codex CLI. Preserve any existing config.json, provider accounts, and data. Configure one available provider using the documented defaults, keeping approval and sandbox protections enabled. Pause if I need to sign in interactively or finish Windows sandbox setup, and tell me the exact command. Run node scripts/doctor.js, start Kuro, open localhost, and complete the documented read-only startup task. Then verify a small file task in a disposable workspace if permissions allow. Report what passed and any remaining manual step. Do not enable remote access or optional integrations unless I ask.
```

## Turn phone access off

To turn phone access off, run `tailscale serve reset`, set `remoteAccess` to `false`, and restart Kuro. Reset clears this device's Serve configuration, so check `tailscale serve status` first if you use Serve for other services.

## What happens to a task

A provider gets your prompt and instructions to keep `PROGRESS.md` current. It ends a turn with `TASK STATUS: DONE`, `CONTINUE`, or `BLOCKED`. Continue starts another turn in the same session; Blocked waits for your reply. Notes sent while a task runs arrive on its next turn.

On a recognized usage-limit response, Kuro puts that account on cooldown and tries another available account. A new provider reads the progress log and checks the working files. This is a handoff between separate sessions, not a transfer of hidden conversation state. If the agent never wrote a progress log before interruption, the next provider has less context.

Reset times are estimates parsed from provider output. Unknown reset times use a 30-minute retry. Usage cards use Claude's run events and Codex's local session files when available; they can be missing or stale. Missing CLI or sign-in blocks with a setup message rather than waiting for a usage reset.

High effort requests a review from the other engine when one is configured and available. With only one engine there is no separate review. If the other engine is unavailable, the event history says review was skipped. An invalid review or unresolved requested changes stops for you rather than claiming a pass. Low and Medium use one agent without a separate reviewer.

After a restart, running tasks return to the queue, interrupted turns are marked, and saved provider session IDs are reused. Waiting tasks keep their cooldowns. Blocked, stopped, and finished tasks stay that way until you act. Keep only one Kuro process per data directory.

Task creation, session IDs, and completed turns save immediately; other updates are briefly debounced, so a hard crash may lose the latest activity. Kuro does not undo partial agent edits. Check the files after a crash before resuming work with side effects.

## Optional setup

### Both coding providers

Add a second signed-in provider to `accounts` and restart:

```json
"accounts": [
  { "name": "Codex", "engine": "codex", "env": {} },
  { "name": "Claude", "engine": "claude", "env": {} }
]
```

Accounts are tried in order, with a task's current session and chosen provider taken into account. Use providers you are authorized to access and follow their account and usage terms.

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
| `accounts` | Provider names, engines, and optional account environment variables. Sign-in is checked at startup. Restart after fixing sign-in. |
| `codexPath`, `claudePath` | Optional full executable paths if a CLI is not on PATH. Standard Windows npm provider shims use their Node entry points. |
| `codexArgs`, `claudeArgs` | Limited model/run options. Kuro rejects permission bypasses and arbitrary security overrides. |
| `workspaceRoot` | Parent for new task folders. Default: `Kuro Tasks` under your home folder. Existing project folders can be selected instead. |
| `projects` | Optional folder shortcuts, each with `name` and full `path`. |
| `maxParallel`, `maxRounds`, `reviewRounds` | Concurrent tasks, maximum work turns, and review-fix attempts. Low and Medium also have smaller turn limits. |
| `KURO_CONFIG`, `KURO_DATA_DIR` | Environment overrides for an isolated config and data directory. Relative paths resolve from the launch directory. |

When updating an older personal install, compare it with the example. Old configs may contain bypass flags; those providers will be unavailable until you remove them. Remote IP access also changes to the authenticated Serve setup. Local config and task data are retained.

Task state lives in `data/tasks.json`, cooldowns in `data/accounts.json`, and chats in `data/chats.json`. Each task has `data/tasks/<id>/PROGRESS.md`, `log.txt`, and a `files/` directory for images. These can contain prompts, source details, local paths, and account metadata. Deleting a task removes its list entry, not its working files or saved logs. A corrupt state file stops startup instead of silently discarding tasks; restore a private backup or move that file aside deliberately.

## Troubleshooting and checks

Run `node scripts/doctor.js` from the Kuro folder. Missing config tells you the copy command. Missing provider or sign-in tells you what to fix. If a port is occupied, startup exits with an explanation; change `port` in local config and match the Serve target if enabled.

Codex runs with workspace-write and approval policy on-request. Claude uses default permission mode. Existing provider policies, project rules, hooks, MCP servers, and platform restrictions still apply. Noninteractive CLIs can deny approval requests instead of displaying them. Resolve the prerequisite or narrowly scoped permission in the provider CLI, then Resume. A chat reply is not a CLI approval. See [Codex noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode) and [Claude permissions](https://code.claude.com/docs/en/permissions).

Run `npm test` to check a change. Tests create temporary copies and use controlled CLI event fixtures for task completion, rate limits, restart recovery, and permissions. They do not contact paid providers or touch your task data.
