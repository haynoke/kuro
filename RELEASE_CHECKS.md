# Release candidate checks

Checked on Windows on November 24, 2026, using Node.js 24.14.0 and Codex CLI 0.145.0. No public repository, push, tag, or release was created.

## Passed

- Made a clean Git clone containing only committed source and examples. Copied `config.example.json` to `config.json` and ran `node scripts/doctor.js`. The default single Codex provider was signed in and ready.
- Started that clone on the public default `localhost:8790`, with an isolated home and provider sign-in copy to protect the working installation. Chat, voice, and desktop control stayed off.
- Opened it in Chromium at 1440 x 1000 and 390 x 844. Home led to Tasks, the form worked, disabled chat controls stayed hidden, there was no horizontal overflow, and there were no JavaScript page errors.
- Submitted the README's read-only startup task through the desktop UI to the **live Codex provider**. It returned `kuro is ready` and reached Done. This used real provider access, not a fixture. The phone-width check used a desktop browser viewport, not a physical phone.
- All **16 automated tests** passed from the clean clone. Controlled CLI fixtures cover file-writing completion, provider permission denial, missing executables, malformed config and requests, occupied ports, corrupt saved state, crash recovery with saved sessions, rate-limit handoff, waiting for reset, and invalid review output.
- Auth checks covered the page, API, uploads, and task images. Missing credentials returned 401; wrong Host or Origin and writes without the required header were rejected. Remote configuration fails closed without a sufficiently long token and HTTPS origin.
- Tested rate-limit handoff with simulated provider events. The second provider received the progress-log path. Simulated cooldown expiry resumed waiting work. No real provider quota was deliberately exhausted.
- The history auditor examined all reachable commits and their file contents. A regression test confirms it detects a private config removed from a later commit. Private config, runtime data, screenshots, and local review artifacts are excluded from the published tree and history.
- Verified original `config.json`, `mcp.json`, and all 3,930 original data files against pre-change SHA-256 hashes: none changed. Checked PowerShell helper and Python transcription source syntax.

The GitHub Actions workflow is configured for Windows and Linux with Node 22 and 24. Those hosted jobs have not run because nothing has been pushed. The checks performed here used Windows and Node 24 only.

## Remaining before publishing

1. **Choose a license.** There was no existing license to preserve. No license was invented. Add the license you want before describing Kuro as open source.
2. **Verify a real coding task with your Windows provider setup.** The isolated live Codex file-writing task returned BLOCKED because its effective environment was read-only. No bypass was enabled. In a disposable folder, run `codex`, finish Windows sandbox setup with protected workspace writes, then run Kuro and submit: `Create hello.txt containing kuro works, read it back to check it, and update the progress log.` Success means Done, the expected file, and a progress entry. If still blocked, read the provider's reply and log and resolve that specific restriction in the CLI. This is distinct from the live read-only completion and simulated file-writing test that passed.
3. **Check your physical phone.** Follow the README's Tailscale Serve setup. Confirm a fresh browser session asks for username `kuro` and the token, wrong credentials cannot read tasks, and a read-only task reaches Done. Confirm direct access to the PC's port 8790 from another device is unavailable. Check Safari Add to Home Screen if you use it.
4. **Verify optional integrations you intend to advertise as working on your setup.** Ollama chat should answer and start a task; Whisper should report ready and transcribe a short recording over HTTPS; the provider should list and use the tools from your installed Roblox Studio bridge against a disposable place. These services were not started or modified during release testing. Desktop control remains off by default.
5. **Migrate the existing personal config before running this version against your saved tasks.** The file was preserved. Its old provider bypass flags will now be rejected; remove those flags, explicitly enable any optional features you want, and use the authenticated phone setup. Back up `config.json`, `mcp.json`, and `data/` privately first.
6. **Create `haynoke/kuro` and publish when ready.** GitHub authentication was verified as `haynoke`. The destination did not yet exist when checked. The local `origin` points there, and commits use `haynoke` with its verified GitHub no-reply address. Review `git status`, run `npm test` and `node scripts/audit-release.js`, then create the repository and push yourself. Keep the local `.release-local/` test copies and screenshots private.
