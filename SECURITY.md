# Security and access

Kuro is a single-user tool for a trusted PC and its owner's devices. It runs coding CLIs in folders you choose. It is not a multi-user hosting service.

## Defaults

The HTTP server binds only to `127.0.0.1`. It checks the Host header to reject DNS rebinding and rejects foreign browser Origins, common proxy headers in local-only mode, and POST requests without `X-Task-Runner: 1`. No CORS access is enabled. Pages cannot be embedded in another site's frame.

Localhost mode has no password. Other processes and people already using your Windows account can access it. Do not proxy or tunnel that mode. A proxy that deliberately removes all evidence of forwarding is indistinguishable from a local process.

## Remote mode

The supported phone setup is tailnet-only Tailscale Serve over HTTPS. Kuro continues to bind to loopback. Remote mode requires an explicit HTTPS `publicOrigin` and a private `KURO_AUTH_TOKEN` of at least 32 bytes. The browser uses HTTP Basic authentication, with username `kuro`, on every route. The token is compared using constant-time hashes and is not written by Kuro or passed into coding-provider environments.

Tailscale Serve terminates TLS. Kuro trusts that local proxy and the tailnet access policy. Do not enable Funnel, public reverse proxies, router forwarding, or direct internet exposure. Basic authentication is a shared password, not per-device accounts, and has no lockout or browser logout endpoint. To revoke access, change the token and restart Kuro; close browser sessions or clear saved credentials. Restrict your tailnet and keep the PC account secure.

Host, Origin, and forwarding checks add protection but do not authenticate a local process. A process running as your user can also read Kuro's private files and operate the provider CLIs directly.

## Provider permissions

Codex receives `--sandbox workspace-write` and approval policy `on-request` on both new and resumed sessions. Its task folder and task-specific progress directory are writable roots. Claude receives `--permission-mode default` and access to the task-specific progress directory. Kuro rejects bypass flags and unsupported security overrides in provider argument arrays.

These settings do not replace provider policies or Windows sandbox setup. Claude's permission checks are not an operating-system sandbox on Windows. Provider configs can include hooks, plugins, MCP servers, broad existing allow rules, and other capabilities with their own access boundaries. Inspect them before using an unfamiliar project.

Interactive sign-in and approval dialogs are not relayed to the phone. A denied permission or a BLOCKED reply stops the task for you. Resolve it with the provider CLI and a narrow permission rule, then Resume. Kuro does not approve it automatically.

## Optional local model and desktop control

Chat, voice, and desktop control are off in the example config. When enabled, the local model's file-reading tools can inspect files available to your Windows user. Desktop control can type, click, launch apps, and capture the screen outside provider sandboxes. The model's instruction to ask before consequential actions is not an enforced approval boundary. Keep desktop control disabled unless you accept that access.

Ollama runs locally by default. A custom remote `ollamaUrl` sends chat content to that endpoint. Whisper transcribes on the PC after its model download; browser dictation and speech synthesis may use the device's own services. Coding prompts still go to the chosen coding provider.

## Private files and release hygiene

`config.json`, `mcp.json`, `data/`, local review files, credentials, and environment files are excluded from Git. Runtime data includes task prompts, CLI output, chats, screenshots, local paths, and account metadata. Keep backups private. Git ignore rules do not protect files someone deliberately force-adds, and do not remove secrets already committed.

Run `node scripts/audit-release.js` before pushing changes to check tracked files and all reachable commits. Images are rejected everywhere except `docs/screenshots/`, so look at anything you add there for private details. The audit is a heuristic check, not proof that arbitrary source contains no secret.

## Reporting a problem

Report access-control issues privately through [a GitHub security advisory](https://github.com/haynoke/kuro/security/advisories/new). Do not post credentials, private logs, or a working exploit against someone's PC in a public issue.
