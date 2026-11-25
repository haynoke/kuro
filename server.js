// Task Runner: hands big tasks to Claude Code and Codex, keeps them going
// through usage limits, and shows progress on a small web page.
// No npm packages needed. Start with: node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const { loadConfig } = require('./lib/config');
const { readJson, writeJson } = require('./lib/storage');
const { createAccess } = require('./lib/access');
const { checkedArgs, cliArgs, probe } = require('./lib/providers');
const { commandSpec } = require('./lib/commands');

const ROOT = __dirname;
let config;
let checkAccess;
try {
  config = loadConfig(ROOT);
  checkAccess = createAccess(config);
} catch (error) {
  console.error('Kuro could not start: ' + error.message);
  process.exit(1);
}
const DATA = process.env.KURO_DATA_DIR ? path.resolve(process.env.KURO_DATA_DIR) : path.join(ROOT, 'data');
const TASKS_FILE = path.join(DATA, 'tasks.json');
const ACCOUNTS_FILE = path.join(DATA, 'accounts.json');
fs.mkdirSync(DATA, { recursive: true });

// ---------- state ----------

let tasks = readJson(TASKS_FILE, []);
let accountState = readJson(ACCOUNTS_FILE, {}); // name -> { limitedUntil, note }
const running = new Map(); // taskId -> child process
let saveTimer = null;
let shuttingDown = false;
let providersReady = false;
const providerHealth = new Map();

// Tasks that were mid-round when the runner stopped get picked back up.
for (const t of tasks) {
  const last = (t.turns || []).at(-1);
  if (last && !last.ended) { last.ended = Date.now(); last.outcome = 'interrupted'; }
  // Tasks from before effort levels keep working the way they did (reviewed = high).
  if (!t.effort) t.effort = t.review === false ? 'medium' : 'high';
  if (t.status === 'running') {
    t.status = 'queued';
    addEvent(t, 'Runner restarted, picking the task back up.');
  }
}

function flushState() {
  writeJson(TASKS_FILE, tasks);
  writeJson(ACCOUNTS_FILE, accountState);
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushState, 300);
}

function addEvent(task, text) {
  task.events = task.events || [];
  task.events.push({ t: Date.now(), text });
  if (task.events.length > 300) task.events.splice(0, task.events.length - 300);
  task.updated = Date.now();
  save();
  // Runs before the chats are set up when the server restarts; skip it then.
  try {
    if (CHAT_WORTHY.test(text)) {
      const c = findChat(task.chatId);
      if (c) addChat('note', `#${task.num} ${task.title}: ${text}`, undefined, c);
    }
  } catch {}
}

function taskDir(task) {
  const dir = path.join(DATA, 'tasks', task.id);
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  return dir;
}
const progressPath = (task) => path.join(taskDir(task), 'PROGRESS.md');
const filesDir = (task) => path.join(taskDir(task), 'files');

function appendLog(task, text) {
  fs.appendFileSync(path.join(taskDir(task), 'log.txt'), text);
}

// ---------- accounts ----------

function accountAvailable(acc) {
  if (!providerHealth.get(acc.name)?.ready) return false;
  const s = accountState[acc.name];
  return !s || !s.limitedUntil || s.limitedUntil <= Date.now();
}

function markLimited(acc, until, note) {
  accountState[acc.name] = { ...(accountState[acc.name] || {}), limitedUntil: until, note };
  save();
}

// ---------- usage windows (5-hour and weekly) ----------
// Claude reports them in every run's rate_limit_event; Codex writes them to its
// session files (the Codex app does too), so they stay fresh whenever either is used.

function recordUsage(acc, fiveHour, weekly) {
  const s = accountState[acc.name] = accountState[acc.name] || {};
  s.usage = { fiveHour, weekly, at: Date.now() };
  save();
}

let codexUsageCache = { at: 0, value: null };
function codexUsage(acc) {
  if (Date.now() - codexUsageCache.at < 20000) return codexUsageCache.value;
  let value = null;
  try {
    const home = (acc.env && acc.env.CODEX_HOME) || process.env.CODEX_HOME || path.join(process.env.USERPROFILE || '', '.codex');
    const root = path.join(home, 'sessions');
    // Newest day folder first (sessions/YYYY/MM/DD), newest file in it.
    const newest = (dir) => fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort().reverse();
    const files = [];
    for (const y of newest(root).slice(0, 2)) for (const m of newest(path.join(root, y)).slice(0, 2)) for (const d of newest(path.join(root, y, m)).slice(0, 3)) {
      for (const f of fs.readdirSync(path.join(root, y, m, d))) if (f.endsWith('.jsonl')) {
        const full = path.join(root, y, m, d, f);
        files.push([full, fs.statSync(full).mtimeMs]);
      }
    }
    files.sort((a, b) => b[1] - a[1]);
    for (const [file, mtime] of files.slice(0, 5)) {
      const text = fs.readFileSync(file, 'utf8');
      const i = text.lastIndexOf('"rate_limits":{');
      if (i < 0) continue;
      const lineStart = text.lastIndexOf('\n', i) + 1;
      const lineEnd = text.indexOf('\n', i);
      const ev = JSON.parse(text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd));
      const rl = (ev.payload && ev.payload.rate_limits) || ev.rate_limits;
      if (!rl) continue;
      const win = (w) => (w ? { used: (w.used_percent || 0) / 100, resetsAt: w.resets_at ? w.resets_at * 1000 : (w.resets_in_seconds ? mtime + w.resets_in_seconds * 1000 : null) } : null);
      const pick = (mins) => [rl.primary, rl.secondary].find((w) => w && w.window_minutes === mins);
      value = { fiveHour: win(pick(300) || rl.primary), weekly: win(pick(10080) || rl.secondary), at: Date.parse(ev.timestamp) || mtime };
      break;
    }
  } catch { value = null; }
  codexUsageCache = { at: Date.now(), value };
  return value;
}

// On first start, take Claude's latest numbers from the task logs already on disk.
function seedClaudeUsage() {
  const acc = config.accounts.find((a) => a.engine === 'claude');
  if (!acc || ((accountState[acc.name] || {}).usage)) return;
  let best = null;
  try {
    for (const id of fs.readdirSync(path.join(DATA, 'tasks'))) {
      const file = path.join(DATA, 'tasks', id, 'log.txt');
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const i = text.lastIndexOf('{"type":"rate_limit_event"');
      if (i < 0) continue;
      const at = fs.statSync(file).mtimeMs;
      if (best && best.at > at) continue;
      const ev = JSON.parse(text.slice(i, text.indexOf('\n', i)));
      const w = (ev.rate_limit_info || {}).unifiedWindows;
      if (w) best = { at, w };
    }
  } catch {}
  if (!best) return;
  const win = (x) => (x ? { used: x.utilization || 0, resetsAt: x.resetsAt ? x.resetsAt * 1000 : null } : null);
  accountState[acc.name] = { ...(accountState[acc.name] || {}), usage: { fiveHour: win(best.w.five_hour), weekly: win(best.w.seven_day), at: best.at } };
  save();
}

function usageOf(acc) {
  const stored = (accountState[acc.name] || {}).usage || null;
  if (acc.engine !== 'codex') return stored;
  const fromFiles = codexUsage(acc);
  return !stored || (fromFiles && fromFiles.at > stored.at) ? fromFiles : stored;
}

function pickAccount(task, { engineNot } = {}) {
  let list = config.accounts.filter(accountAvailable);
  if (engineNot) list = list.filter((a) => a.engine !== engineNot);
  if (!list.length) return null;
  const current = list.find((a) => a.name === task.account);
  if (current && !engineNot) return current;
  if (task.prefer && task.prefer !== 'auto') {
    const preferred = list.find((a) => a.engine === task.prefer);
    if (preferred) return preferred;
  }
  // Prefer an account that already has a session for this task.
  const withSession = list.find((a) => task.sessions && task.sessions[a.name]);
  return withSession || list[0];
}

function earliestReset() {
  const times = config.accounts.filter((a) => providerHealth.get(a.name)?.ready)
    .map((a) => (accountState[a.name] || {}).limitedUntil)
    .filter((time) => time > Date.now());
  return times.length ? Math.min(...times) : null;
}

// ---------- usage-limit detection ----------

const LIMIT_RE = /usage limit|hit your [\w -]{0,24}limit|(5-hour|weekly|daily|monthly) limit|out of usage|usage credits|limit reached|limit will reset|rate.?limit|quota|out of (extra )?usage|credits? (have )?(run|ran) out|insufficient (credits|quota)|too many requests|\b429\b/i;

function parseReset(text) {
  const now = Date.now();
  const buffer = 2 * 60 * 1000;
  let m = text.match(/\|(\d{10})\b/);
  if (m) return Number(m[1]) * 1000 + buffer;

  m = text.match(/(?:try again|resets?|available again)\s+in\s+([0-9a-z ,.]+)/i);
  if (m) {
    let ms = 0;
    const re = /(\d+(?:\.\d+)?)\s*(days?|d\b|hours?|hrs?|h\b|minutes?|mins?|m\b|seconds?|secs?|s\b)/gi;
    let p;
    while ((p = re.exec(m[1]))) {
      const n = parseFloat(p[1]);
      const u = p[2][0].toLowerCase();
      ms += n * (u === 'd' ? 864e5 : u === 'h' ? 36e5 : u === 'm' ? 6e4 : 1e3);
    }
    if (ms > 0) return now + ms + buffer;
  }

  m = text.match(/(?:try again|resets?|reset|available again)\s+(?:at\s+|on\s+)?(?:[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:\d{4},?\s+)?)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)/i);
  if (m) {
    let h = Number(m[1]) % 12;
    if (/p/i.test(m[3])) h += 12;
    const d = new Date();
    d.setHours(h, Number(m[2] || 0), 0, 0);
    let t = d.getTime();
    while (t < now) t += 864e5;
    return t + buffer;
  }
  return now + 30 * 60 * 1000; // unknown: check again in 30 minutes
}

// ---------- running the CLIs ----------

function childEnv(acc) {
  const env = { ...process.env };
  // Drop variables from whatever launched this server (for example a Claude
  // desktop session), so the workers start like a normal terminal would.
  for (const k of Object.keys(env)) {
    if (/^CLAUDE/i.test(k) || k === 'ANTHROPIC_BASE_URL' || k === 'KURO_AUTH_TOKEN') delete env[k];
  }
  const result = { ...env, ...(acc.env || {}) };
  delete result.KURO_AUTH_TOKEN;
  return result;
}

// Use the installed CLI, or an explicit path, without guessing from personal settings.
function codexCommand() {
  return config.codexPath || 'codex';
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else child.kill('SIGTERM');
}

async function checkProviders() {
  await Promise.all(config.accounts.map(async (acc) => {
    try {
      checkedArgs(acc.engine, acc.engine === 'codex' ? config.codexArgs : config.claudeArgs);
      const command = acc.engine === 'codex' ? codexCommand() : (config.claudePath || 'claude');
      const health = await probe(command, acc.engine === 'claude' ? ['auth', 'status'] : ['login', 'status'], childEnv(acc));
      providerHealth.set(acc.name, health);
      if (!health.ready) console.warn(`${acc.name}: ${health.error}`);
    } catch (error) {
      providerHealth.set(acc.name, { ready: false, error: error.message });
      console.warn(`${acc.name}: ${error.message}`);
    }
  }));
  providersReady = true;
}

// Runs one turn of a CLI. Resolves with
// { text, sessionId, isError, errorText, limitHit }.
function runCli(task, acc, prompt, sessionId, { onActivity, onSession }) {
  return new Promise((resolve) => {
    const args = cliArgs(acc.engine, {
      ...config,
      claudeMcpConfig: config.claudeMcpConfig ? path.resolve(ROOT, config.claudeMcpConfig) : undefined,
    }, { cwd: task.cwd, sessionId, effort: effortOf(task.effort),
      model: task.model?.engine === acc.engine ? task.model.id : undefined, progressDir: taskDir(task) });

    const command = acc.engine === 'codex' ? codexCommand() : (config.claudePath || 'claude');
    const env = childEnv(acc);
    const spec = commandSpec(command, env);
    const child = spawn(spec.file, [...spec.args, ...args], { cwd: task.cwd, env, windowsHide: true });
    running.set(task.id, child);
    appendLog(task, `\n===== ${new Date().toISOString()} ${acc.name} ${sessionId ? 'resume ' + sessionId : 'new session'} =====\n${prompt}\n----- output -----\n`);

    const out = { text: '', sessionId, isError: false, errorText: '', limitHit: false, permissionDenied: false };
    let stderr = '';
    let buf = '';

    const handleLine = (line) => {
      line = line.trim();
      if (!line) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      const hadSession = out.sessionId;
      const reportSession = () => { if (out.sessionId && out.sessionId !== hadSession && onSession) onSession(out.sessionId); };
      if (acc.engine === 'claude') {
        if (ev.session_id) { out.sessionId = ev.session_id; reportSession(); }
        if (ev.type === 'rate_limit_event' && ev.rate_limit_info && ev.rate_limit_info.status === 'rejected' && ev.rate_limit_info.resetsAt) {
          out.resetAt = ev.rate_limit_info.resetsAt * 1000 + 2 * 60 * 1000;
        }
        if (ev.type === 'rate_limit_event' && ev.rate_limit_info && ev.rate_limit_info.unifiedWindows) {
          const w = ev.rate_limit_info.unifiedWindows;
          const win = (x) => (x ? { used: x.utilization || 0, resetsAt: x.resetsAt ? x.resetsAt * 1000 : null } : null);
          recordUsage(acc, win(w.five_hour), win(w.seven_day));
        }
        if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          for (const c of ev.message.content) {
            if (c.type === 'text' && c.text.trim()) { out.text = c.text; onActivity('says: ' + c.text.slice(0, 300)); }
            if (c.type === 'tool_use') onActivity('using ' + toolLabel(c.name, c.input));
          }
        }
        if (ev.type === 'result') {
          if (typeof ev.result === 'string' && ev.result.trim()) out.text = ev.result;
          if (ev.is_error) { out.isError = true; out.errorText = String(ev.result || ev.subtype || 'error'); }
          if (ev.permission_denials?.length) out.permissionDenied = true;
        }
      } else {
        if (ev.type === 'thread.started' && ev.thread_id) { out.sessionId = ev.thread_id; reportSession(); }
        const item = ev.item || {};
        if (ev.type === 'item.completed' && item.type === 'agent_message' && item.text) {
          out.text = item.text; onActivity('says: ' + item.text.slice(0, 300));
        }
        if (ev.type === 'item.started' && item.type === 'command_execution') onActivity('running ' + String(item.command || '').slice(0, 160));
        if (ev.type === 'item.started' && item.type === 'mcp_tool_call') onActivity('using ' + (item.server || '') + ' ' + (item.tool || ''));
        if (ev.type === 'item.completed' && item.type === 'file_change') onActivity('edited files');
        if (ev.type === 'turn.failed' || ev.type === 'error') {
          out.isError = true;
          out.errorText = (ev.error && ev.error.message) || ev.message || JSON.stringify(ev);
        }
      }
    };

    child.stdout.on('data', (d) => {
      const s = d.toString();
      appendLog(task, s);
      buf += s;
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(handleLine);
    });
    child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; appendLog(task, s); });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);

    child.on('close', (code) => {
      handleLine(buf);
      running.delete(task.id);
      if (code !== 0 && !out.isError) {
        out.isError = true;
        out.errorText = (stderr || out.text || `exited with code ${code}`).slice(-2000);
      }
      const errorish = out.isError ? out.errorText + '\n' + stderr : stderr;
      out.permissionDenied ||= /approval (is )?required|permission denied|not allowed.*permission|sandbox (denied|violation)/i.test(errorish);
      out.limitHit = (out.isError && LIMIT_RE.test(errorish)) || (out.isError && !!out.resetAt);
      // A short final reply that is only a limit notice also counts.
      if (!out.limitHit && out.text.length < 400 && LIMIT_RE.test(out.text) && !/TASK STATUS|REVIEW:/i.test(out.text)) {
        out.limitHit = true;
        out.errorText = out.text;
      }
      out.code = code;
      resolve(out);
    });
    child.on('error', (err) => {
      running.delete(task.id);
      resolve({ ...out, isError: true, errorText: 'Could not start ' + acc.engine + ': ' + err.message, code: -1 });
    });
  });
}

function toolLabel(name, input) {
  input = input || {};
  const detail = input.command || input.file_path || input.description || input.pattern || '';
  return (name || 'tool') + (detail ? ': ' + String(detail).slice(0, 140) : '');
}

// ---------- prompts ----------

function runnerRules(task) {
  return `
---
Notes from the task runner (you are running unattended; the user checks progress from their phone):
- Working folder: ${task.cwd}
- Keep a progress log at ${progressPath(task)}: what is done, what is next, and anything the user should know. Update it after each meaningful step, so another agent could take over from it if you run out of usage.
- Save screenshots or images the user should see into ${filesDir(task)} (PNG or JPG).
- Work until the whole task is finished and checked. Do not stop to ask unless you truly cannot continue.
- Provider approvals and sandbox restrictions remain enabled. If a permission or sign-in step blocks you, explain exactly what the user must do and end with TASK STATUS: BLOCKED. Do not bypass protections.
- ${EFFORT[effortOf(task.effort)].note}
- End your final message with exactly one of these lines:
  TASK STATUS: DONE      (finished and checked)
  TASK STATUS: CONTINUE  (more work is left; say what)
  TASK STATUS: BLOCKED   (you need the user; ask your question above this line)`;
}

function takeInbox(task) {
  if (!task.inbox || !task.inbox.length) return '';
  const msgs = task.inbox.map((m) => '- ' + m).join('\n');
  task.inbox = [];
  return `\nMessages from the user since your last turn:\n${msgs}\n`;
}

function workPrompt(task, acc) {
  const inbox = takeInbox(task);
  const hasSession = task.sessions && task.sessions[acc.name];
  if (task.reviewNotes) {
    const notes = task.reviewNotes;
    task.reviewNotes = null;
    const intro = hasSession ? '' : `You are taking over this task from another agent. Read ${progressPath(task)} first.\n\nThe task:\n${task.prompt}\n`;
    return `${intro}A reviewer checked the work and asked for these changes:\n${notes}\n${inbox}\nMake the changes, check them, and update the progress log.${runnerRules(task)}`;
  }
  if (hasSession) {
    return `Continue the task from where you left off.${inbox}${runnerRules(task)}`;
  }
  if (task.rounds > 0 || fs.existsSync(progressPath(task))) {
    return `You are taking over a task that another agent started but could not finish (it ran out of usage or was interrupted). Read ${progressPath(task)} first to see what is done, check the real state of the files, then carry on.\n\nThe task:\n${task.prompt}\n${inbox}${runnerRules(task)}`;
  }
  return `${task.prompt}\n${inbox}${runnerRules(task)}`;
}

function reviewPrompt(task) {
  return `Review the work another agent did for this task.

The task:
${task.prompt}

Working folder: ${task.cwd}
The agent's progress log: ${progressPath(task)}

Check the real results (open files, run tests or the game, take screenshots as needed) against the task. Do not redo the work yourself; tiny obvious fixes are fine. Save any screenshots into ${filesDir(task)}.

End your message with exactly one line:
REVIEW: PASS
or
REVIEW: CHANGES
followed by a numbered list of what must change.`;
}

// ---------- the step loop ----------

async function step(task) {
  task.status = 'running';
  task.waitUntil = null;
  save();

  const reviewing = task.phase === 'review';
  let acc;
  if (reviewing) {
    acc = pickAccount(task, { engineNot: engineOf(task.account) });
    if (!acc) {
      const anyOther = config.accounts.some((a) => a.engine !== engineOf(task.account));
      task.status = 'done';
      task.phase = 'work';
      addEvent(task, anyOther ? 'Finished. Review skipped: the other model is out of usage.' : 'Finished.');
      return;
    }
  } else {
    acc = pickAccount(task);
    if (!acc) {
      task.waitUntil = earliestReset();
      task.status = task.waitUntil ? 'waiting' : 'blocked';
      addEvent(task, task.waitUntil
        ? 'Every available account is out of usage. Waiting until ' + new Date(task.waitUntil).toLocaleString() + '.'
        : 'No provider is ready. ' + config.accounts.map((a) => `${a.name}: ${providerHealth.get(a.name)?.error || 'check sign-in'}`).join(' ') + ' Restart Kuro after fixing setup, then press Resume.');
      return;
    }
  }

  if (!reviewing && task.account && task.account !== acc.name) addEvent(task, `Switching from ${task.account} to ${acc.name}.`);
  if (!reviewing) task.account = acc.name;
  task.sessions = task.sessions || {};
  const sessionId = reviewing ? null : task.sessions[acc.name];
  const prompt = reviewing ? reviewPrompt(task) : workPrompt(task, acc);
  addEvent(task, reviewing ? `${acc.name} is reviewing the work.` : `${acc.name} ${sessionId ? 'continues' : 'starts'} (round ${task.rounds + 1}).`);
  task.activity = '';
  task.activityAccount = acc.name;
  task.activitySince = Date.now();
  task.activityLog = task.activityLog || [];

  // Every round is kept: what the runner sent the agent, and what came back.
  task.turns = task.turns || [];
  const turn = { n: task.turns.length + 1, kind: reviewing ? 'review' : 'work', account: acc.name, resumed: !!sessionId, at: Date.now(), prompt: prompt.slice(0, 20000), reply: null, ended: null, outcome: null };
  task.turns.push(turn);
  if (task.turns.length > 40) task.turns.splice(0, task.turns.length - 40);
  save();

  const res = await runCli(task, acc, prompt, sessionId, {
    onActivity: (a) => {
      if (a !== task.activity) {
        task.activity = a;
        task.activitySince = Date.now();
        task.activityLog.push({ t: Date.now(), text: a.slice(0, 300), account: acc.name });
        if (task.activityLog.length > 40) task.activityLog.splice(0, task.activityLog.length - 40);
      }
      task.updated = Date.now();
    },
    // Keep the session as soon as the agent reports it, so a restart mid-round can resume it.
    onSession: (id) => { if (!reviewing) { task.sessions[acc.name] = id; flushState(); } },
  });
  turn.ended = Date.now();
  turn.reply = (res.text || res.errorText || '').slice(0, 20000);
  const statusLine = (res.text.match(/(TASK STATUS|REVIEW):\s*(\w+)/gi) || []).pop();
  turn.outcome = res.limitHit ? 'out of usage' : res.isError ? 'error' : statusLine ? statusLine.split(':')[1].trim().toLowerCase() : 'continue';

  if (shuttingDown || task.deleted) return;
  if (task.status === 'stopped') { task.finished = Date.now(); addEvent(task, 'Stopped by you.'); return; }
  if (!reviewing && res.sessionId) task.sessions[acc.name] = res.sessionId;

  if (res.limitHit) {
    const until = res.resetAt || parseReset(res.errorText + '\n' + res.text);
    markLimited(acc, until, res.errorText.slice(0, 300));
    addEvent(task, `${acc.name} is out of usage until about ${new Date(until).toLocaleString()}.`);
    task.status = 'queued';
    return;
  }

  if (res.permissionDenied) {
    task.status = 'blocked';
    task.lastText = res.text || res.errorText;
    task.lastFrom = acc.name;
    addEvent(task, `${acc.name} needs you: a provider permission or sandbox restriction blocked this turn. Read the reply and log, resolve it in the provider CLI, then Resume.`);
    return;
  }

  if (res.isError) {
    task.errors = (task.errors || 0) + 1;
    addEvent(task, `${acc.name} failed: ${res.errorText.slice(0, 500)}`);
    if (task.errors >= 3) {
      // Try the other engine before giving up.
      const other = config.accounts.find((a) => a.name !== acc.name && accountAvailable(a));
      if (other && !task.triedOther) {
        task.triedOther = true;
        task.errors = 0;
        task.account = other.name;
        task.status = 'queued';
        addEvent(task, `Trying ${other.name} instead.`);
      } else {
        task.status = 'failed';
        addEvent(task, 'Stopped after repeated errors. Press Resume to try again.');
      }
    } else {
      task.status = 'waiting';
      task.waitUntil = Date.now() + 60 * 1000 * task.errors;
    }
    return;
  }

  task.errors = 0;
  task.lastText = res.text;
  task.lastFrom = acc.name;

  if (reviewing) {
    const m = res.text.match(/REVIEW:\s*(PASS|CHANGES)/i);
    if (!m) {
      task.status = 'blocked';
      addEvent(task, 'The reviewer did not return REVIEW: PASS or REVIEW: CHANGES. Read the review before resuming.');
    } else if (m[1].toUpperCase() === 'PASS') {
      task.status = 'done';
      task.phase = 'work';
      addEvent(task, `${acc.name} reviewed the work: passed. Task finished.`);
    } else {
      task.reviewCount = (task.reviewCount || 0) + 1;
      if (task.reviewCount > (config.reviewRounds ?? 2)) {
        task.status = 'blocked';
        task.phase = 'work';
        addEvent(task, `${acc.name} still asked for changes after ${task.reviewCount - 1} fix rounds. Needs you: read the last review.`);
      } else {
        task.reviewNotes = res.text.slice(res.text.search(/REVIEW:/i));
        task.phase = 'work';
        task.status = 'queued';
        addEvent(task, `${acc.name} asked for changes. Sending them back.`);
      }
    }
    return;
  }

  task.rounds += 1;
  const marks = [...res.text.matchAll(/TASK STATUS:\s*(DONE|CONTINUE|BLOCKED)/gi)];
  const mark = marks.length ? marks[marks.length - 1][1].toUpperCase() : 'CONTINUE';

  if (task.inbox && task.inbox.length && mark !== 'BLOCKED') {
    task.status = 'queued';
    addEvent(task, `${acc.name} finished a round; passing on your new message.`);
  } else if (mark === 'DONE') {
    if (task.review && config.accounts.some((a) => a.engine !== acc.engine)) {
      task.phase = 'review';
      task.status = 'queued';
      addEvent(task, `${acc.name} says the task is done. Sending it for review.`);
    } else {
      task.status = 'done';
      addEvent(task, `${acc.name} says the task is done.`);
    }
  } else if (mark === 'BLOCKED') {
    task.status = 'blocked';
    addEvent(task, `${acc.name} needs you. Reply on the task to continue.`);
  } else if (task.rounds >= roundLimit(task)) {
    task.status = 'failed';
    addEvent(task, `Reached ${task.rounds} rounds without finishing. Press Resume to keep going.`);
  } else {
    task.status = 'queued';
    addEvent(task, `${acc.name} paused with more to do. Continuing.`);
  }
}

function engineOf(accountName) {
  const a = config.accounts.find((x) => x.name === accountName);
  return a ? a.engine : null;
}

function tick() {
  if (shuttingDown || !providersReady) return;
  const now = Date.now();
  // Remember when a task finished, so its total time stops counting.
  for (const t of tasks) {
    const over = ['done', 'failed', 'stopped'].includes(t.status);
    // A task's last event is when it actually finished (older tasks have no finish time yet).
    if (over && (!t.finished || (t.updated && t.finished - t.updated > 60000))) { t.finished = t.updated || now; save(); }
    if (!over && t.finished) t.finished = null;
  }
  for (const t of tasks) {
    if (t.status === 'waiting' && t.waitUntil && t.waitUntil <= now) t.status = 'queued';
  }
  let busy = tasks.filter((t) => t.status === 'running').length;
  for (const t of tasks) {
    if (busy >= (config.maxParallel || 2)) break;
    if (t.status !== 'queued') continue;
    busy++;
    step(t).catch((err) => {
      t.status = 'failed';
      addEvent(t, 'Runner error: ' + err.message);
    }).finally(flushState);
  }
}
setInterval(tick, 3000);

// Tasks get short numbers (#1, #2, ...) so they are easy to talk about.
function nextTaskNumber() {
  return tasks.reduce((n, t) => Math.max(n, t.num || 0), 0) + 1;
}
for (const t of tasks) if (!t.num) t.num = nextTaskNumber();

// Tasks without a folder get a fresh one of their own, e.g. "Kuro Tasks\3 melody refresh".
function newWorkspace(num, title) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 6).join(' ').slice(0, 40) || 'task';
  const dir = path.join(config.workspaceRoot || path.join(process.env.USERPROFILE || ROOT, 'Kuro Tasks'), `${num} ${slug}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- models ----------
// Kuro picks the model itself from this list (it's in its instructions); the runner
// only needs to know which engine runs each one.
const CLAUDE_MODELS = [
  { id: 'opus', label: 'Claude Opus', note: 'strongest, the default for Claude' },
  { id: 'sonnet', label: 'Claude Sonnet', note: 'fast and capable, uses less of the limits' },
  { id: 'haiku', label: 'Claude Haiku', note: 'quickest and lightest' },
];
const codexHome = () => process.env.CODEX_HOME || path.join(process.env.USERPROFILE || '', '.codex');
function codexModels() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(codexHome(), 'models_cache.json'), 'utf8'));
    return (j.models || []).filter((m) => m.visibility === 'list').map((m) => ({ id: m.slug, label: m.display_name || m.slug }));
  } catch { return []; }
}
function codexDefaultModel() {
  try { return (fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8').match(/^\s*model\s*=\s*"([^"]+)"/m) || [])[1] || null; } catch { return null; }
}
function allModels() {
  return [...CLAUDE_MODELS.map((m) => ({ ...m, engine: 'claude' })), ...codexModels().map((m) => ({ ...m, engine: 'codex' }))];
}

// How hard tasks work. Low: one agent, quickest path. Medium: one agent that checks
// its own work. High: thorough, and the other model reviews the result.
const EFFORT = {
  low: { review: false, rounds: 8, note: 'Effort: LOW. Get the result the simplest, quickest way. One quick check is enough; skip extra polish and long verification.' },
  medium: { review: false, rounds: 20, note: 'Effort: MEDIUM. Do it properly but efficiently: check once that it works, and do not gold-plate.' },
  high: { review: true, rounds: null, note: 'Effort: HIGH. Be thorough: test it, look at the result, and fix anything that is off before you say it is done. Another model will review your work.' },
};
const effortOf = (v) => (EFFORT[v] ? v : 'medium');
const roundLimit = (task) => Math.min(config.maxRounds || 40, EFFORT[effortOf(task.effort)].rounds || Infinity);

function createTask(b) {
  if (!b.prompt || !b.prompt.trim()) throw new Error('Write what the task is.');
  const effort = effortOf(b.effort || (findChat(b.chatId) || {}).effort);
  let model = null;
  if (b.model && String(b.model).trim()) {
    model = allModels().find((m) => m.id === String(b.model).trim());
    if (!model) throw new Error(`Unknown model "${b.model}". Use one of: ${allModels().map((m) => m.id).join(', ')}.`);
  }
  const num = nextTaskNumber();
  const title = (b.title && b.title.trim()) || b.prompt.trim().split('\n')[0].slice(0, 70);
  const cwd = b.cwd && b.cwd.trim() ? b.cwd.trim() : newWorkspace(num, title);
  if (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('Choose an existing folder using its full path: ' + cwd);
  const t = {
    id: crypto.randomBytes(5).toString('hex'),
    num,
    chatId: b.chatId || null,
    title,
    prompt: b.prompt.trim(), cwd, effort, review: EFFORT[effort].review,
    // A chosen model decides which engine starts the task.
    model: model ? { id: model.id, label: model.label, engine: model.engine } : null,
    prefer: model ? model.engine : (b.prefer || 'auto'),
    status: 'queued', phase: 'work', rounds: 0, sessions: {}, inbox: [], events: [],
    created: Date.now(), updated: Date.now(),
  };
  tasks.push(t);
  addEvent(t, 'Task added.');
  flushState();
  setTimeout(tick, 50);
  return t;
}

// ---------- chat: the local assistant you talk to ----------
// Runs on this PC through Ollama, so it keeps working when every subscription
// is out of usage. It looks at files and manages tasks through the tools
// below; the heavy work goes to Claude Code / Codex as tasks.

const CHATS_FILE = path.join(DATA, 'chats.json');
// Images the user attaches in chat.
const UPLOADS = path.join(DATA, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
const uploadNames = (list) => (Array.isArray(list) ? list : [])
  .map((n) => path.basename(String(n)))
  .filter((n) => /^img-[\w-]+\.(png|jpg|webp|gif)$/.test(n) && fs.existsSync(path.join(UPLOADS, n)))
  .slice(0, 6);
const OLLAMA = config.ollamaUrl || 'http://127.0.0.1:11434';
const NAME = config.assistantName || 'Kuro';

function newChatObject(title, messages) {
  return { id: crypto.randomBytes(4).toString('hex'), title: title || 'New chat', created: Date.now(), updated: Date.now(), messages: messages || [], pending: [] };
}

let chats = readJson(CHATS_FILE, null);
if (!chats) {
  // Carry over the single chat from the earlier version.
  const old = readJson(path.join(DATA, 'chat.json'), null);
  chats = old && old.messages && old.messages.length ? [newChatObject('First chat', old.messages)] : [];
}
for (const c of chats) { c.busy = false; c.activity = ''; c.pending = c.pending || []; }

let chat = null; // the chat Kuro is answering right now
let chatAbort = null;
let brainBusy = false;

const findChat = (id) => chats.find((c) => c.id === id) || null;

function createChat(title) {
  const c = newChatObject(title);
  c.busy = false;
  c.activity = '';
  chats.push(c);
  saveChats();
  return c;
}

let chatsSaveTimer = null;
function saveChats() {
  clearTimeout(chatsSaveTimer);
  chatsSaveTimer = setTimeout(() => {
    const out = chats.map(({ busy, busySince, activity, stopRequested, ...rest }) => rest);
    writeJson(CHATS_FILE, out);
  }, 200);
}

// Adds a message to a chat (by default the one Kuro is answering right now).
function addChat(role, text, from, target) {
  const c = target || chat;
  if (!c) return null;
  const m = { id: crypto.randomBytes(4).toString('hex'), t: Date.now(), role, text, from };
  c.messages.push(m);
  if (c.messages.length > 400) c.messages.splice(0, c.messages.length - 400);
  c.updated = Date.now();
  saveChats();
  return m;
}

const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const stamp = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// --- file helpers for the tools ---

const SKIP_DIRS = new Set(['node_modules', '.git', 'AppData', '$Recycle.Bin', 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', '__pycache__', 'Library', 'Temp']);
const defaultSearchRoot = () => path.join(process.env.USERPROFILE || 'C:\\Users', 'Projects');

function walk(root, visit, maxDepth = 7, limit = 40000) {
  let count = 0;
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++count > limit) return;
      const full = path.join(dir, e.name);
      visit(full, e);
      if (e.isDirectory() && depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push([full, depth + 1]);
    }
  }
}

function statLine(full) {
  try {
    const s = fs.statSync(full);
    return `${s.isDirectory() ? '[folder]' : '[file]  '} ${full}  (${stamp(s.mtimeMs)}${s.isDirectory() ? '' : ', ' + Math.max(1, Math.round(s.size / 1024)) + ' KB'})`;
  } catch { return full; }
}

function nameMatcher(pattern) {
  pattern = String(pattern || '').trim().toLowerCase();
  if (pattern.includes('*') || pattern.includes('?')) {
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return (n) => re.test(n);
  }
  return (n) => n.toLowerCase().includes(pattern);
}

function findTask(id) {
  const s = String(id).trim().replace(/^#/, '');
  const t = tasks.find((x) => x.id === s) || tasks.find((x) => String(x.num) === s)
    || tasks.find((x) => x.title.toLowerCase().includes(s.toLowerCase()));
  if (!t) throw new Error(`No task "${id}". Use list_tasks to see the ids.`);
  return t;
}

// --- desktop control (desktop.ps1) ---

const SCREENS = path.join(DATA, 'screens');
fs.mkdirSync(SCREENS, { recursive: true });
let lastShot = null; // { width, height, screenWidth, screenHeight }

function desktop(args) {
  if (!config.desktopControl) return Promise.reject(new Error('Desktop control is disabled. Set desktopControl to true in config.json only if you want the local model to control this PC.'));
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'desktop.ps1'), ...args],
      { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')));
        try { resolve(JSON.parse(stdout.trim().split('\n').pop())); } catch { reject(new Error('desktop helper: ' + stdout.slice(0, 200))); }
      });
  });
}

function toScreen(x, y) {
  if (!lastShot) throw new Error('Take a screenshot first, then use coordinates from it.');
  const sx = Math.round(Number(x) * lastShot.screenWidth / lastShot.width);
  const sy = Math.round(Number(y) * lastShot.screenHeight / lastShot.height);
  if (!(sx >= 0 && sy >= 0 && sx < lastShot.screenWidth && sy < lastShot.screenHeight)) throw new Error(`(${x}, ${y}) is outside the screenshot (${lastShot.width}x${lastShot.height}).`);
  return [sx, sy];
}

const KEY_NAMES = {
  enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', backspace: '{BACKSPACE}',
  delete: '{DELETE}', del: '{DELETE}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}',
  end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', space: ' ', insert: '{INSERT}',
};
// "ctrl+s", "alt+tab", "ctrl+shift+n", "enter" -> SendKeys form
function toSendKeys(combo) {
  return String(combo).trim().split(/\s+/).map((chord) => {
    const parts = chord.toLowerCase().split('+').filter(Boolean);
    const key = parts.pop();
    const mods = parts.map((m) => ({ ctrl: '^', control: '^', alt: '%', shift: '+' }[m] || '')).join('');
    let k = KEY_NAMES[key] || (/^f([1-9]|1[0-6])$/.test(key) ? `{${key.toUpperCase()}}` : key);
    if (k.length === 1 && '+^%~(){}[]'.includes(k)) k = `{${k}}`;
    return mods + k;
  }).join('');
}

async function takeScreenshot() {
  const file = `shot-${Date.now()}.png`;
  const out = path.join(SCREENS, file);
  const info = await desktop(['-Action', 'screenshot', '-Out', out, '-Width', String(config.screenshotWidth || 1280)]);
  lastShot = info;
  // Keep the newest 60 screenshots.
  const old = fs.readdirSync(SCREENS).filter((f) => f.startsWith('shot-')).sort().slice(0, -60);
  for (const f of old) { try { fs.unlinkSync(path.join(SCREENS, f)); } catch {} }
  addChat('image', '/screens/' + file);
  return {
    text: `Screenshot taken (${info.width}x${info.height}). Active window: "${info.window}". Use x,y from this image for click and scroll.`,
    image: out,
  };
}

// --- the tools the local brain can call ---

const brainTools = {
  list_tasks: {
    description: 'List every task with its id, status, which model is on it, and the latest event.',
    params: {},
    run: () => (tasks.length ? tasks.slice().sort((a, b) => b.created - a.created).map((t) => {
      const last = (t.events || []).slice(-1)[0];
      return `#${t.num} (id ${t.id}) | ${t.status}${t.phase === 'review' ? ' (review)' : ''} | ${t.account || '-'} | round ${t.rounds} | ${t.title}\n   last: ${last ? last.text + ' (' + stamp(last.t) + ')' : '-'}`;
    }).join('\n') : 'No tasks yet.'),
  },
  show_task: {
    description: 'Full details of one task: description, working folder, progress log, latest message from the agent, history, images, and the folder holding its logs.',
    params: { id: ['string', 'Task id (or part of its title)'] },
    required: ['id'],
    run: ({ id }) => {
      const t = findTask(id);
      const p = publicTask(t, true);
      return [
        `Task ${t.id}: ${t.title}`,
        `Status: ${t.status}${t.phase === 'review' ? ' (review)' : ''}, model: ${t.account || '-'}, round ${t.rounds}${t.waitUntil ? ', waiting until ' + stamp(t.waitUntil) : ''}`,
        `Working folder: ${t.cwd}`,
        `Logs and images folder: ${taskDir(t)}`,
        t.status === 'running' && t.activity ? `Doing now: ${t.activity}` : '',
        `Description:\n${t.prompt}`,
        `Progress log:\n${p.progress || '(empty)'}`,
        t.lastText ? `Latest message from ${t.lastFrom}:\n${t.lastText.slice(-1500)}` : '',
        `History:\n${(t.events || []).slice(-12).map((e) => stamp(e.t) + '  ' + e.text).join('\n')}`,
        p.files.length ? `Images: ${p.files.join(', ')}` : '',
      ].filter(Boolean).join('\n');
    },
  },
  start_task: {
    description: 'Start a new task. Claude Code or Codex does the work unattended on this PC, keeps going until done, and switches between them when one runs out of usage. The prompt must be a complete, clear task description.',
    params: {
      prompt: ['string', 'Full task description: goal, what done looks like, how to check it, limits'],
      folder: ['string', 'Working folder (full path). Leave it out unless the task is about one of the known projects or the user named a folder; then the runner makes a fresh folder for the task.'],
      prefer: ['string', 'claude, codex or auto (default auto). Use codex for clicking around the desktop.'],
      model: ['string', `Only when the user's message names a model; never "claude" or "codex" (that is prefer). REQUIRED whenever the user's message names a model. Exact id, one of: ${CLAUDE_MODELS.map((m) => m.id).join(', ')} (Claude), ${codexModels().map((m) => `${m.id} (${m.label})`).join(', ')} (Codex/GPT). Examples: "astra" -> the newest astra id, "sol" -> the newest sol id, "sonnet 5.5" -> sonnet. Leave it out only when no model was named.`],
    },
    required: ['prompt'],
    run: ({ prompt, folder, prefer, model }) => {
      // The user's own recent words travel with the task, so no detail gets lost in Kuro's summary.
      // Everything the user said since the previous task was started in this chat (the whole
      // chat if none), newest kept first when it's long.
      let said = [];
      if (chat) {
        const msgs = chat.messages;
        const starts = msgs.map((m, i) => (m.role === 'tool' && m.text.startsWith('start_task(') ? i : -1)).filter((i) => i >= 0);
        const from = starts.length > 1 ? starts[starts.length - 2] + 1 : 0; // the last one is this call
        let budget = 4000;
        for (const m of msgs.slice(from).filter((x) => x.role === 'user' && x.text).reverse()) {
          if (budget <= 0) break;
          said.unshift(m.text.slice(0, budget));
          budget -= m.text.length;
        }
      }
      // A model only applies when the user actually named one; otherwise the defaults stay.
      const words = said.join(' ').toLowerCase();
      const named = model && allModels().find((m) => m.id === model);
      const keepModel = named && (words.includes(named.id) || named.id.split('-').some((p) => p.length > 2 && !/^gpt$|^\d/.test(p) && words.includes(p)));
      const full = said.length ? `${prompt}\n\nThe user's own words, for every detail:\n${said.map((s) => '> ' + s.replace(/\n/g, '\n> ')).join('\n\n')}` : prompt;
      const t = createTask({ prompt: full, title: prompt.split('\n')[0].slice(0, 70), cwd: folder, prefer: prefer || 'auto', model: keepModel ? model : undefined, chatId: chat && chat.id });
      return `Started task #${t.num} (id ${t.id}): ${t.title}. Effort: ${t.effort} (the chat's setting). Model: ${t.model ? t.model.label : 'default'}${model && !keepModel ? ' (the model you passed was ignored because the user did not name one)' : ''}. The agent does the work; tell the user in a line or two that it's started.`;
    },
  },
  message_task: {
    description: 'Send a note or instruction to a task. The agent gets it on its next turn. Also wakes up a finished, stopped or blocked task.',
    params: { id: ['string', 'Task id'], text: ['string', 'The message'] },
    required: ['id', 'text'],
    run: ({ id, text }) => {
      const t = findTask(id);
      t.inbox = t.inbox || [];
      t.inbox.push(text);
      addEvent(t, 'Note from the assistant: ' + text);
      if (['blocked', 'done', 'failed', 'stopped'].includes(t.status)) { t.status = 'queued'; t.phase = 'work'; }
      return 'Sent to ' + t.id;
    },
  },
  rewrite_task: {
    description: 'Replace a task\'s description with a new one (for example an improved prompt). The agent follows the new version from its next turn.',
    params: { id: ['string', 'Task id'], prompt: ['string', 'The new full task description'] },
    required: ['id', 'prompt'],
    run: ({ id, prompt }) => {
      const t = findTask(id);
      t.prompt = prompt;
      t.inbox = t.inbox || [];
      t.inbox.push('The task description was rewritten. Follow this version from now on:\n' + prompt);
      addEvent(t, 'Task description updated.');
      if (['done', 'failed', 'stopped', 'blocked'].includes(t.status)) { t.status = 'queued'; t.phase = 'work'; }
      return 'Updated ' + t.id;
    },
  },
  stop_task: {
    description: 'Stop a task. Only when the user asks.',
    params: { id: ['string', 'Task id'] },
    required: ['id'],
    run: ({ id }) => { const t = findTask(id); t.status = 'stopped'; killTree(running.get(t.id)); addEvent(t, 'Stopped by the assistant.'); return 'Stopped ' + t.id; },
  },
  resume_task: {
    description: 'Resume a stopped or failed task.',
    params: { id: ['string', 'Task id'] },
    required: ['id'],
    run: ({ id }) => { const t = findTask(id); if (t.status !== 'running') { t.status = 'queued'; t.errors = 0; t.triedOther = false; if (t.rounds >= roundLimit(t)) t.rounds = 0; addEvent(t, 'Resumed by the assistant.'); } return 'Resumed ' + t.id; },
  },
  accounts: {
    description: 'Show whether Claude and Codex have usage left, and when they come back.',
    params: {},
    run: () => accountsView().map((a) => `${a.name}: ${a.limitedUntil ? 'out of usage until ' + stamp(a.limitedUntil) : 'ready'}`).join('\n'),
  },
  find_files: {
    description: 'Search for files or folders by name. Returns full paths, newest first.',
    params: {
      name: ['string', 'Part of the name, or a pattern like *.png'],
      folder: ['string', 'Where to search (default: the user\'s Projects folder)'],
      kind: ['string', 'file, folder or any (default any)'],
    },
    required: ['name'],
    run: ({ name, folder, kind }) => {
      const root = folder || defaultSearchRoot();
      const match = nameMatcher(name);
      const hits = [];
      walk(root, (full, e) => {
        if (kind === 'file' && !e.isFile()) return;
        if (kind === 'folder' && !e.isDirectory()) return;
        if (match(e.name)) hits.push(full);
      });
      if (!hits.length) return `Nothing named like "${name}" under ${root}.`;
      return hits.map((h) => [h, (() => { try { return fs.statSync(h).mtimeMs; } catch { return 0; } })()])
        .sort((a, b) => b[1] - a[1]).slice(0, 40).map(([h]) => statLine(h)).join('\n')
        + (hits.length > 40 ? `\n(${hits.length - 40} more)` : '');
    },
  },
  recent_changes: {
    description: 'List files and folders created or changed recently, newest first. Good for "find what the task made".',
    params: { folder: ['string', 'Where to look (default: the user\'s Projects folder)'], hours: ['number', 'How far back (default 24)'] },
    run: ({ folder, hours }) => {
      const root = folder || defaultSearchRoot();
      const since = Date.now() - (Number(hours) || 24) * 3600e3;
      const hits = [];
      walk(root, (full) => {
        try { const s = fs.statSync(full); if (s.mtimeMs >= since) hits.push([full, s.mtimeMs]); } catch {}
      });
      if (!hits.length) return `Nothing changed under ${root} in the last ${Number(hours) || 24} hours.`;
      return hits.sort((a, b) => b[1] - a[1]).slice(0, 50).map(([h]) => statLine(h)).join('\n');
    },
  },
  list_folder: {
    description: 'List what is inside a folder.',
    params: { folder: ['string', 'Full path'] },
    required: ['folder'],
    run: ({ folder }) => {
      const entries = fs.readdirSync(folder);
      return entries.slice(0, 200).map((n) => statLine(path.join(folder, n))).join('\n') + (entries.length > 200 ? `\n(${entries.length - 200} more)` : '') || '(empty)';
    },
  },
  screenshot: {
    description: 'Look at the main screen. Returns the image; the user sees it too. Do this before clicking, and again after acting to check what happened.',
    params: {},
    run: () => takeScreenshot(),
  },
  click: {
    description: 'Click at x,y on the latest screenshot (image pixels).',
    params: { x: ['number', 'x in the screenshot'], y: ['number', 'y in the screenshot'], button: ['string', 'left or right (default left)'], double: ['boolean', 'Double-click'] },
    required: ['x', 'y'],
    run: async ({ x, y, button, double }) => {
      const [sx, sy] = toScreen(x, y);
      const r = await desktop(['-Action', 'click', '-X', String(sx), '-Y', String(sy), '-Button', button === 'right' ? 'right' : 'left', ...(double ? ['-Double'] : [])]);
      return `Clicked. Active window is now "${r.window}". Take a screenshot to check the result.`;
    },
  },
  type_text: {
    description: 'Type text into whatever has keyboard focus. Never type passwords.',
    params: { text: ['string', 'Text to type; a newline presses Enter'] },
    required: ['text'],
    run: async ({ text }) => { const r = await desktop(['-Action', 'type', '-Text', String(text)]); return `Typed into "${r.window}".`; },
  },
  press_keys: {
    description: 'Press keys or shortcuts, like "enter", "ctrl+s", "alt+tab", "ctrl+shift+n", "f5". Several separated by spaces run in order.',
    params: { keys: ['string', 'The keys'] },
    required: ['keys'],
    run: async ({ keys }) => { const r = await desktop(['-Action', 'keys', '-Text', toSendKeys(keys)]); return `Pressed ${keys}. Active window: "${r.window}".`; },
  },
  scroll: {
    description: 'Scroll at x,y on the latest screenshot. Positive amount scrolls down, negative up.',
    params: { x: ['number', 'x'], y: ['number', 'y'], amount: ['number', 'Notches (default 3)'] },
    required: ['x', 'y'],
    run: async ({ x, y, amount }) => { const [sx, sy] = toScreen(x, y); await desktop(['-Action', 'scroll', '-X', String(sx), '-Y', String(sy), '-Amount', String(Math.round(Number(amount) || 3))]); return 'Scrolled.'; },
  },
  open: {
    description: 'Open an installed app by name (like "FL Studio", "Roblox Studio", "Discord", "Notepad"), a file, a folder, or a web address. If the app is already open, use focus_window instead.',
    params: { target: ['string', 'App name, full path, or URL'] },
    required: ['target'],
    run: async ({ target }) => {
      target = String(target).trim();
      let hint = target;
      if (fs.existsSync(target) || /^https?:\/\//i.test(target)) {
        spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
        hint = path.basename(target).replace(/\.(exe|lnk|bat|cmd)$/i, '');
      } else {
        // Installed apps by their Start menu name first, then plain program names on PATH.
        const r = await desktop(['-Action', 'launch', '-Text', target]);
        if (r.ok) {
          hint = r.name.replace(/\s+\d{4}$/, '');
        } else {
          await new Promise((resolve, reject) => {
            const p = spawn(target, [], { detached: true, stdio: 'ignore' });
            p.on('error', () => reject(new Error(`No installed app called "${target}".${r.near && r.near.length ? ' Close matches: ' + r.near.join(', ') + '.' : ''}`)));
            p.on('spawn', () => { p.unref(); resolve(); });
          });
        }
      }
      // Big apps (FL Studio, Studio) take a few seconds to show a window.
      await new Promise((r) => setTimeout(r, 4000));
      // Windows opened from here start behind the window the user is in; bring it forward.
      let note = '';
      if (!/^https?:\/\//i.test(target)) {
        try {
          const r = await desktop(['-Action', 'focus', '-Text', hint]);
          note = r.ok ? ` Brought "${r.matched}" to the front.` : ` Could not find its window to bring forward; active window is "${r.window}".`;
        } catch {}
      }
      return `Opened ${target}.${note} Take a screenshot to see it.`;
    },
  },
  list_windows: {
    description: 'List the apps and windows open on this PC right now (titles and program names), and which one is in front. Use it to find an app before focus_window or a screenshot.',
    params: {},
    run: async () => {
      const r = await desktop(['-Action', 'windows']);
      const lines = (r.windows || []).slice(0, 40).map((w) => `- ${w.title}${w.app ? ` (${w.app})` : ''}`);
      return `In front: "${r.active}"\nOpen windows:\n${lines.join('\n') || '(none)'}`;
    },
  },
  focus_window: {
    description: 'Bring an open window to the front by part of its title (for example "Notepad", "Roblox Studio", "TaskRunner").',
    params: { title: ['string', 'Part of the window title'] },
    required: ['title'],
    run: async ({ title }) => {
      const r = await desktop(['-Action', 'focus', '-Text', String(title)]);
      return r.ok ? `"${r.matched}" is now in front.` : `No open window has "${title}" in its title. Active window: "${r.window}".`;
    },
  },
  read_file: {
    description: 'Read a text file (code, notes, logs).',
    params: { path: ['string', 'Full path'], from_line: ['number', 'First line (default 1; use a negative number to read the end)'], lines: ['number', 'How many lines (default 150)'] },
    required: ['path'],
    run: ({ path: file, from_line, lines }) => {
      const all = fs.readFileSync(file, 'utf8').split('\n');
      const n = Math.min(Number(lines) || 150, 400);
      let start = Number(from_line) || 1;
      if (start < 0) start = Math.max(1, all.length + start + 1);
      return `${file} (${all.length} lines)\n` + all.slice(start - 1, start - 1 + n).map((l, i) => `${start + i}: ${l}`).join('\n');
    },
  },
};

const DESKTOP_TOOLS = new Set(['screenshot', 'click', 'type_text', 'press_keys', 'scroll', 'open', 'list_windows', 'focus_window']);
const toolList = Object.entries(brainTools).filter(([name]) => config.desktopControl || !DESKTOP_TOOLS.has(name)).map(([name, t]) => ({
  type: 'function',
  function: {
    name,
    description: t.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(t.params).map(([k, [type, description]]) => [k, { type, description }])),
      required: t.required || [],
    },
  },
}));

function systemPrompt() {
  const folders = (config.projects || []).map((p) => `- ${p.name}: ${p.path}`).join('\n');
  const here = chat ? tasks.filter((t) => t.chatId === chat.id) : [];
  return `Desktop control is ${config.desktopControl ? 'enabled' : 'DISABLED. Do not attempt screen, keyboard, app or mouse actions. Explain that desktopControl must be enabled in config.json.'}.
You are ${NAME}, the user's assistant, running locally on their Windows PC. The user talks to you from their phone or the PC.
This chat is "${chat ? chat.title : ''}". Tasks started in this chat: ${here.length ? here.map((t) => `#${t.num} ${t.title} [${t.status}]`).join('; ') : 'none yet'}. Tasks you start here belong to this chat. Refer to tasks by their number, like #3.

FIRST, DECIDE: IS THIS REAL WORK? (the most important rule)
Real work = anything that creates or changes files, code, scripts, plugins, game content, Roblox Studio places, animations, assets, music projects; any research; anything that takes more than a couple of minutes.
Real work ALWAYS goes to start_task, in this same turn. You never do it yourself, not even the first step: don't explore the files, don't take screenshots to "get oriented", don't plan it out loud. The agent explores and figures out the details.
The agents (Claude Code and Codex) are far more capable than you: they read and edit the whole project, run scripts and tests, and control Roblox Studio directly through its Studio tools (the open place, Workspace, scripts, animations, playtests), plus the desktop. Anything inside Roblox Studio is theirs.
If a big request is a bit vague, start the task anyway: put everything the user said into the description, add your best reading of the goal, and let the agent decide the specifics. Don't ask the user first.
Your own tools are only for quick things: answering questions, looking at the screen, opening or switching apps, one screenshot, finding a file, checking or steering tasks.

HOW YOU WORK: act, don't ask.
The user wants a capable assistant that gets things done, not one that checks in. When the request is clear enough that a sensible person would know what to do, do it right away, all the way to the end, in this same turn. Pick the obvious reading and the obvious defaults yourself, and mention the choice in one short line afterwards. Never end a reply by asking permission for the next obvious step ("Should I click it?", "Would you like me to…?", "Do you want me to start it?", "Which model?"). Just take that step.

Ask a question only when one of these is true:
1. The request has two or more readings that lead to clearly different results, and nothing on screen, in the files or in this chat settles it.
2. The action sends, posts, buys, pays, deletes something the user made, or can't be undone.
3. You need something only the user knows (a password is never typed by you; ask the user to do that part).
Before asking, look first: a screenshot, list_windows, list_tasks or find_files usually answers the question. If you do ask, ask one short question, after doing everything you can.

Defaults (use them, don't ask): folder = leave it out, and the task gets a fresh folder of its own; only pass a project folder when the task is about a known project listed below or the user names a folder; model = auto; effort = this chat's setting (it decides how thorough tasks are and whether another model reviews them; don't ask about it); "the agents" = Claude Code / Codex tasks.

IMAGES. The user can attach images; you see them, and their file paths are written next to the message. Look at them and answer about them directly; don't read the file paths out to the user unless they ask. When you start a task that involves an image (a reference, a screenshot of a bug, a mockup), put the image's full file path in the task description and say what it shows, so the agent can open it.

MODELS. Use only model ids from the lists below. Whenever the user's message names a listed model, pass the matching exact id as start_task's "model" (it also decides whether Claude Code or Codex runs the task).
- Claude Code models: ${CLAUDE_MODELS.map((m) => `"${m.id}" = ${m.label}, ${m.note}`).join('; ')}
- Codex / GPT models (newest first): ${codexModels().map((m) => `"${m.id}" = ${m.label}${m.id === codexDefaultModel() ? ' (the default)' : ''}`).join('; ') || '(list unavailable)'}
- Examples: "use astra" -> model "${(codexModels().find((m) => /astra/.test(m.id)) || {}).id || 'gpt-…-astra'}"; "with sol" -> "${(codexModels().find((m) => /sol/.test(m.id)) || {}).id || 'gpt-…-sol'}"; "sonnet 5.5" -> "sonnet"; "use opus" -> "opus".
- In your reply, name the model the task uses. If a model id is rejected, the error lists the valid ids: pick from those.

This chat's effort is ${chat ? effortOf(chat.effort).toUpperCase() : 'MEDIUM'} (the user sets it with the effort button). Low: quick, one agent, no review. Medium: one agent that checks its own work. High: thorough, and another model reviews the result. Match your own replies to it too: on low, keep things brief and fast.

Examples of the right behaviour:
- "take a photo of FL Studio" → list_windows; if FL Studio is open, focus_window it, otherwise open "FL Studio" and wait; then screenshot. Reply: "Here's FL Studio." The screenshot already shows in the chat.
- "send one of the agents to take a photo of X" → a screenshot is quick, so do it yourself the same way; no task needed.
- "check on ChatGPT" → list_windows, focus the ChatGPT window, screenshot, and say what it shows.
- "fix this project's tests" → start_task right away with a full description and the named project folder; reply with the task number.
- "make my FL Studio melody better" → start_task with no folder (it has nothing to do with the game).

What you do yourself vs. hand off:
- Yourself (seconds to a few minutes): looking at the screen, opening and switching apps, clicking, typing, screenshots, finding files and folders, reading logs, answering questions, checking and steering tasks.
- Hand off with start_task (long or deep work): coding, building, fixing, testing in Roblox Studio, making assets, research. Tasks run for hours, switch between Claude and Codex when one runs out of usage, and wait for resets. Write the task description in full: the goal, the folder, what "done" looks like, how to check it (tests, a Studio playtest, screenshots), and anything to avoid.
- Improving a prompt: rewrite it and show it; start it if the user said to, or use rewrite_task on an existing task.
- Progress questions: list_tasks or show_task, then sum up in a few lines. Notes or corrections for a running task: message_task.

The PC is yours to drive: you have its screen, mouse and keyboard. screenshot shows you the screen (the user sees it too). list_windows shows what is open, focus_window brings a window forward, open starts any installed app by name (like "FL Studio"), file, folder or website, and click / type_text / press_keys / scroll act on it. Never say you can't see or control the computer and never ask the user to describe their screen. Work in a loop: screenshot, act, screenshot to check, until it's done. Click coordinates come from the latest screenshot.

Rules:
- Never type passwords or payment details.
- Before type_text, check the latest screenshot that the right window and field have focus. Apps like Notepad reopen old files: don't type into an existing document unless asked; open a new blank one first (ctrl+n).
- Use the tools; never invent task ids, paths, file contents or results.
- Replies are short and plain: a phone screen, no tables, no list of what you "can" do unless asked.
- Don't stop or delete tasks unless the user asks.
- Lines starting with [Runner] are automatic updates about tasks, not the user.

Known project folders:
${folders || '- (none)'}
The user's home folder is ${process.env.USERPROFILE}.
Now: ${new Date().toLocaleString()}.
Accounts: ${accountsView().map((a) => `${a.name} ${a.limitedUntil ? 'out until ' + timeOf(a.limitedUntil) : 'ready'}`).join(', ')}.`;
}

function chatHistory() {
  // Images from the message(s) being answered right now are sent as pixels; older ones only as paths.
  const answering = new Set(chat.pending);
  return chat.messages.filter((m) => m.role !== 'tool' && m.role !== 'image').slice(-(config.chatHistory || 14)).map((m) => {
    let text = m.text.length > 2500 ? m.text.slice(0, 2500) + ' …' : m.text;
    if (m.role === 'user' && m.images && m.images.length) {
      const paths = m.images.map((n) => path.join(UPLOADS, n));
      text = `${text || '(no text, just the image)'}\n[The user attached ${paths.length > 1 ? 'these images' : 'an image'}: ${paths.join(', ')}]`;
      if (answering.has(m.id)) {
        const images = m.images.map((n) => { try { return fs.readFileSync(path.join(UPLOADS, n)).toString('base64'); } catch { return null; } }).filter(Boolean);
        return { role: 'user', content: text, images };
      }
    }
    if (m.role === 'user') return { role: 'user', content: text };
    if (m.role === 'assistant') return { role: 'assistant', content: text };
    return { role: 'user', content: '[Runner] ' + text };
  });
}

// Ollama normally starts with Windows, but it can be quit from the tray or
// stop during an update. If it is not answering, start the Ollama app and wait
// for it, so Kuro keeps working without the owner having to notice.
async function ollamaUp() {
  try {
    const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

let ollamaStarting = null;
function startOllama() {
  if (!config.chat || shuttingDown) return Promise.resolve(false);
  if (ollamaStarting) return ollamaStarting;
  ollamaStarting = (async () => {
    if (await ollamaUp()) return true;
    if (!/\/\/(127\.0\.0\.1|localhost)[:/]/.test(OLLAMA)) return false;
    const dir = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama');
    const app = config.ollamaPath || path.join(dir, 'ollama app.exe');
    const cli = path.join(dir, 'ollama.exe');
    const [cmd, args] = fs.existsSync(app) ? [app, []]
      : fs.existsSync(cli) ? [cli, ['serve']] : ['ollama', ['serve']];
    console.log(`Ollama is not answering; starting ${cmd}`);
    try {
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', (e) => console.log('Could not start Ollama: ' + e.message));
      p.unref();
    } catch (e) {
      console.log('Could not start Ollama: ' + e.message);
      return false;
    }
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 750));
      if (await ollamaUp()) { console.log('Ollama is up.'); return true; }
    }
    return false;
  })().finally(() => { ollamaStarting = null; });
  return ollamaStarting;
}

async function ollamaChat(messages) {
  await startOllama();
  chatAbort = new AbortController();
  const timer = setTimeout(() => chatAbort.abort(), 300000);
  try {
    const body = {
      model: config.localModel || 'qwen2.5:7b',
      messages,
      tools: toolList,
      stream: false,
      keep_alive: '30m',
      options: { num_ctx: config.localContext || 16384, temperature: 0.3 },
    };
    if (config.localThink !== undefined) body.think = config.localThink;
    // Ollama sometimes fails to read a tool call the model wrote ("XML syntax
    // error"). Asking again, a little less predictably, usually works.
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetch(OLLAMA + '/api/chat', { method: 'POST', body: JSON.stringify(body), signal: chatAbort.signal });
      } catch (e) {
        // Connection refused: Ollama stopped. Start it and ask once more.
        if (attempt < 3 && !chatAbort.signal.aborted && await startOllama()) continue;
        throw e;
      }
      if (r.ok) return (await r.json()).message || {};
      const err = (await r.text()).slice(0, 300);
      if (attempt < 3 && r.status === 500 && /syntax|parse|unexpected|closed by/i.test(err)) {
        body.options.temperature = 0.5 + attempt * 0.2;
        continue;
      }
      throw new Error(`Ollama: ${r.status} ${err}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

const CANT_SEE = /(can(no|')t|unable to|don'?t have (the )?(ability|access)|no (way|ability) to) (see|view|access|control|look at|interact with|use)[^.]{0,40}(screen|computer|pc|desktop|app|window|browser)|what('?s| is) (visible|on (your|the) screen|in (the|your) .{0,20}window)|can you (tell|describe|show) me what/i;
const PLANS_WORK = /(here'?s (my|the) plan|\b(i'?ll|i will|i'?m going to|i am going to|let me|going to)\b[^.!?\n]{0,140}\b(extract|build|create|make|write|fix|edit|implement|export|split|set up|generate|refactor|add|update|start|open|take a (fresh )?screenshot|look (at|through|into)|explore|go through|organi[sz]e|clean)|still getting oriented|before (we|i) start)/i;
const QUESTION_LIST = /\b(couple|few|some|quick|several) (of )?(quick )?questions\b/i;
const ASKS_PERMISSION = /(would you like|do you want|should i|shall i|want me to|let me know if|which (one|model|folder|app|option)|do you prefer|what (do|would) you (want|like)( me to do)?|is that (ok|okay|alright|fine)|can i go ahead|any (other )?preference|ready (for me )?to)[^?]{0,180}\?\s*$/i;
const RISKY = /\b(delete|remove|erase|send|post|publish|buy|pay|purchase|password|overwrite|uninstall|format|sign in|log in)\b/i;
const CLAIMS_ACTION = /\b(i('ve| have)? (clicked|opened|closed|typed|pressed|started|stopped|sent|created|took|found|checked|scrolled)|successfully|has been (closed|opened|started|sent|created)|window (is|has been) closed|done!)/i;

// Some small models write a tool call as JSON text instead of a real call.
function toolCallsFromText(content) {
  const m = String(content || '').match(/\{[\s\S]*"name"\s*:\s*"(\w+)"[\s\S]*\}/);
  if (!m || !brainTools[m[1]]) return null;
  try {
    const j = JSON.parse(m[0]);
    return [{ function: { name: j.name, arguments: j.arguments || j.parameters || {} } }];
  } catch { return null; }
}

async function brainTurn() {
  const messages = [{ role: 'system', content: systemPrompt() }, ...chatHistory()];
  let toolsUsed = 0;
  let caught = false;
  let pushedBack = false;
  let nudged = false;
  let plannedNudge = false;
  let startedTask = false;
  for (let i = 0; i < 12; i++) {
    if (chat.stopRequested) return null;
    chat.activity = 'Thinking…';
    const reply = await ollamaChat(messages);
    let calls = reply.tool_calls && reply.tool_calls.length ? reply.tool_calls : toolCallsFromText(reply.content);
    if (!calls) {
      const text = String(reply.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      // Small models sometimes describe actions they never took, copying an
      // earlier answer. If it claims to have acted but called no tools this
      // turn, call that out once and make it actually do the steps.
      if (!toolsUsed && !caught && CLAIMS_ACTION.test(text)) {
        caught = true;
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'user', content: '[Runner check] You called no tools this turn, so none of that happened. Do the steps now with the tools, or say plainly that you did not do them.' });
        chat.activity = 'Checking its answer…';
        continue;
      }
      // Small models fall back to "I can't see your screen" or ask the user to describe it.
      if (!pushedBack && CANT_SEE.test(text)) {
        pushedBack = true;
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'user', content: '[Runner check] You do have screen access on this PC. Do not ask the user what is on screen. Use list_windows, focus_window and screenshot to look yourself, then do what they asked.' });
        chat.activity = 'Looking at the screen…';
        continue;
      }
      // Announcing work ("I'll extract…", "Here's my plan") without starting a task does nothing.
      if (!plannedNudge && !startedTask && PLANS_WORK.test(text)) {
        plannedNudge = true;
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'user', content: '[Runner check] You described work but did not start it, so nothing is happening. If this is real work (building, editing, extracting, anything in Roblox Studio, code or files), call start_task now with a full description that includes everything the user said; the agent works out the details. If it is only a quick look, do it now with your tools. Then reply in a line or two with what you started.' });
        chat.activity = 'Starting it…';
        continue;
      }
      // Small models end with "Would you like me to…?" for things that are obvious.
      // Send it back once; a question that is genuinely needed survives the second pass.
      const tail = text.slice(-260);
      if (!nudged && (ASKS_PERMISSION.test(tail) || QUESTION_LIST.test(text)) && !RISKY.test(tail)) {
        nudged = true;
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'user', content: '[Runner check] You ended by asking the user something. If it has an obvious answer or a sensible default, do not ask: do it now with the tools, then report what you did in a line or two. Keep the question only if the request is genuinely ambiguous with clearly different outcomes, or the step is risky (sending, buying, deleting).' });
        chat.activity = 'Getting on with it…';
        continue;
      }
      return text;
    }
    toolsUsed += calls.length;
    if (calls.some((c) => c.function && c.function.name === 'start_task')) startedTask = true;
    messages.push({ role: 'assistant', content: reply.content || '', tool_calls: calls });
    for (const c of calls) {
      const name = c.function && c.function.name;
      let args = (c.function && c.function.arguments) || {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      const shown = Object.values(args).map((v) => String(v).slice(0, 60)).join(', ');
      chat.activity = `Using ${name}${shown ? ': ' + shown : ''}`;
      addChat('tool', `${name}(${shown})`);
      let out;
      try {
        if (!brainTools[name]) throw new Error('No tool called ' + name);
        if (!config.desktopControl && DESKTOP_TOOLS.has(name)) throw new Error('Desktop control is disabled in config.json.');
        out = await brainTools[name].run(args);
      } catch (err) {
        out = 'Error: ' + err.message;
        // Show failures to the user too, so a broken tool is never invisible.
        console.error(`[tool ${name}] ${err.stack || err.message}`);
        addChat('note', `${name} failed: ${err.message.slice(0, 200)}`);
      }
      let image = null;
      if (out && typeof out === 'object') { image = out.image; out = out.text; }
      messages.push({ role: 'tool', content: String(out).slice(0, config.toolOutputLimit || 3000), tool_name: name });
      if (image) {
        // Only the newest screenshot stays in context; older ones cost too much room.
        for (const m of messages) delete m.images;
        messages.push({ role: 'user', content: '[The screenshot you just took]', images: [fs.readFileSync(image).toString('base64')] });
      }
    }
  }
  return 'I kept calling tools without finishing. Ask me again, maybe more directly.';
}

function postToChat(c, text, images) {
  text = String(text || '').trim();
  const m = addChat('user', text, undefined, c);
  const pics = uploadNames(images);
  if (pics.length) { m.images = pics; saveChats(); }
  // Name a new chat after its first message until the user renames it.
  if (!c.titled && c.messages.filter((x) => x.role === 'user').length === 1) {
    c.title = text ? text.split('\n')[0].replace(/\s+/g, ' ').slice(0, 48) + (text.length > 48 ? '…' : '') : (pics.length > 1 ? 'Images' : 'Image');
  }
  c.pending.push(m.id);
  if (!c.pendingSince) c.pendingSince = Date.now();
  saveChats();
  setTimeout(chatLoop, 10);
  return m;
}

// One local model answers one chat at a time; chats wait their turn in order.
async function chatLoop() {
  if (!config.chat || shuttingDown) return;
  if (brainBusy) return;
  const next = chats.filter((c) => c.pending.length).sort((a, b) => (a.pendingSince || 0) - (b.pendingSince || 0))[0];
  if (!next) return;
  brainBusy = true;
  chat = next;
  chat.busy = true;
  chat.busySince = Date.now();
  chat.stopRequested = false;
  try {
    while (chat.pending.length && !chat.stopRequested) {
      const batch = chat.pending.slice();
      let text;
      try {
        text = await brainTurn();
      } catch (err) {
        text = null;
        if (!chat.stopRequested) {
          addChat('note', `The local model did not answer: ${err.message}. Ollama could not be started or did not respond.`);
        }
      }
      if (text) addChat('assistant', text, NAME);
      chat.pending = chat.pending.filter((id) => !batch.includes(id));
      saveChats();
    }
    if (chat.stopRequested) { chat.pending = []; addChat('note', 'Stopped.'); }
  } finally {
    chat.busy = false;
    chat.activity = '';
    chat.pendingSince = chat.pending.length ? Date.now() : null;
    saveChats();
    chat = null;
    brainBusy = false;
    setTimeout(chatLoop, 10);
  }
}
setInterval(chatLoop, 5000);

// Important task events also show up in the chat.
const CHAT_WORTHY = /says the task is done|reviewed the work|asked for changes|needs you|Stopped after|Reached \d+ rounds|Every account is out|out of usage until|Switching from|Review skipped|Runner error/;

// ---------- web server ----------

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'; object-src 'none'" });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => { size += d.length; if (size > limit) { req.destroy(); reject(new Error('Recording is too long.')); } else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- voice: local Whisper (whisper_server.py) ----------

const WHISPER_PORT = config.whisperPort || 8792;
let whisperProc = null;
function startWhisper() {
  if (!config.voice) return;
  whisperProc = spawn(config.pythonPath || 'python', [path.join(ROOT, 'whisper_server.py')], {
    cwd: ROOT, windowsHide: true,
    env: { ...process.env, WHISPER_PORT: String(WHISPER_PORT), WHISPER_MODEL: config.whisperModel || 'small.en' },
  });
  whisperProc.stdout.on('data', (d) => process.stdout.write(d));
  whisperProc.stderr.on('data', (d) => { const s = d.toString(); if (!/Warning|warn\(/i.test(s)) process.stderr.write(s); });
  whisperProc.on('error', (err) => console.error('[whisper] could not start Python:', err.message));
  whisperProc.on('exit', (code) => {
    whisperProc = null;
    // Exit right away usually means another copy already holds the port; that copy keeps serving.
    if (code && code !== 0) console.error(`[whisper] stopped (code ${code}).`);
  });
}

function whisperRequest(method, urlPath, body, type) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: WHISPER_PORT, path: urlPath, method,
      headers: body ? { 'Content-Type': type || 'audio/webm', 'Content-Length': body.length } : {} }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(s) }); } catch { reject(new Error('Bad reply from the speech service.')); } });
    });
    req.on('error', () => reject(new Error('The speech service is not running.')));
    req.setTimeout(120000, () => req.destroy(new Error('Transcription took too long.')));
    if (body) req.write(body);
    req.end();
  });
}

function readBody(req) {
  return readRaw(req, 1024 * 1024).then((raw) => {
    let body;
    try { body = JSON.parse(raw.toString('utf8') || '{}'); }
    catch { throw Object.assign(new Error('Request body must contain valid JSON.'), { status: 400 }); }
    if (!body || Array.isArray(body) || typeof body !== 'object') throw Object.assign(new Error('Request body must contain a JSON object.'), { status: 400 });
    for (const key of ['prompt', 'title', 'text', 'cwd', 'prefer', 'model', 'effort', 'chatId']) {
      if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') throw Object.assign(new Error(`${key} must be a string.`), { status: 400 });
    }
    return body;
  });
}

function publicTask(t, full) {
  let progress = '';
  let files = [];
  try { progress = fs.readFileSync(progressPath(t), 'utf8'); } catch {}
  try {
    files = fs.readdirSync(filesDir(t))
      .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
      .map((f) => ({ name: f, time: fs.statSync(path.join(filesDir(t), f)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
      .map((f) => f.name);
  } catch {}
  const owner = findChat(t.chatId);
  const base = {
    id: t.id, num: t.num, effort: t.effort || 'high', model: t.model || null, chatId: owner ? owner.id : null, chatTitle: owner ? owner.title : null,
    title: t.title, status: t.status, phase: t.phase, account: t.account,
    rounds: t.rounds, created: t.created, updated: t.updated, finished: t.finished || null, waitUntil: t.waitUntil,
    activity: t.status === 'running' ? t.activity : '', activityAccount: t.activityAccount,
    lastEvent: (t.events || []).slice(-1)[0], fileCount: files.length,
  };
  if (!full) return base;
  return {
    ...base, prompt: t.prompt, cwd: t.cwd, review: t.review, prefer: t.prefer,
    activitySince: t.activitySince || null, activityLog: (t.activityLog || []).slice(-12),
    turns: (t.turns || []).slice(-15),
    events: (t.events || []).slice(-80), lastText: t.lastText, lastFrom: t.lastFrom,
    progress, files, inbox: t.inbox || [],
  };
}

// Who each CLI is signed in as: read from its own login file. Only the email and plan
// are taken; tokens are never read out or sent anywhere. Re-read every 30 s so a
// switched account shows up without restarting.
const identityCache = new Map();
function accountIdentity(acc) {
  const hit = identityCache.get(acc.name);
  if (hit && Date.now() - hit.at < 30000) return hit.value;
  let value = null;
  try {
    const env = { ...process.env, ...(acc.env || {}) };
    if (acc.engine === 'claude') {
      const dir = env.CLAUDE_CONFIG_DIR || process.env.USERPROFILE;
      const file = path.join(dir, '.claude.json');
      const a = (JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount) || {};
      const plan = String(a.organizationType || a.billingType || '').replace(/^claude_/, '').replace(/_/g, ' ');
      value = { email: a.emailAddress || null, plan: plan ? plan[0].toUpperCase() + plan.slice(1) : null };
    } else {
      const home = env.CODEX_HOME || path.join(process.env.USERPROFILE || '', '.codex');
      const auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
      const idt = auth.tokens && auth.tokens.id_token;
      if (idt) {
        const p = JSON.parse(Buffer.from(idt.split('.')[1], 'base64url').toString());
        const plan = (p['https://api.openai.com/auth'] || {}).chatgpt_plan_type || '';
        value = { email: p.email || null, plan: plan ? plan[0].toUpperCase() + plan.slice(1) : null };
      } else if (auth.OPENAI_API_KEY) {
        value = { email: null, plan: 'API key' };
      }
    }
  } catch { value = null; }
  identityCache.set(acc.name, { at: Date.now(), value });
  return value;
}

function accountsView() {
  return config.accounts.map((a) => {
    const s = accountState[a.name] || {};
    const limited = s.limitedUntil && s.limitedUntil > Date.now();
    return { name: a.name, engine: a.engine, ready: providerHealth.get(a.name)?.ready || false,
      setupError: providerHealth.get(a.name)?.error || (!providersReady ? 'Checking provider sign-in…' : ''),
      limitedUntil: limited ? s.limitedUntil : null, note: limited ? s.note : '', who: accountIdentity(a), usage: usageOf(a) };
  });
}

const server = http.createServer(async (req, res) => {
  if (!checkAccess(req, res)) return;
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (!config.chat && url.pathname.startsWith('/api/chats') && req.method === 'POST' && !/\/(stop|delete|rename|effort)$/.test(url.pathname)) return send(res, 503, { error: 'Chat is disabled. Use Tasks, or enable chat and install Ollama. See README.md.' });
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html')), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return send(res, 200, {
        name: NAME,
        features: { chat: !!config.chat, voice: !!config.voice, desktopControl: !!config.desktopControl },
        models: allModels().map(({ id, label, engine }) => ({ id, label, engine })),
        tasks: tasks.slice().sort((a, b) => b.created - a.created).map((t) => publicTask(t, false)),
        accounts: accountsView(),
        projects: config.projects || [],
        chats: chats.slice().sort((a, b) => b.updated - a.updated).map((c) => {
          const last = [...c.messages].reverse().find((m) => m.role === 'user' || m.role === 'assistant');
          const mine = tasks.filter((t) => t.chatId === c.id);
          return {
            id: c.id, title: c.title, updated: c.updated, busy: c.busy, pending: c.pending.length,
            last: last ? { role: last.role, text: last.text.slice(0, 120) } : null,
            running: mine.filter((t) => t.status === 'running').length,
            needsYou: mine.filter((t) => ['blocked', 'failed'].includes(t.status)).length,
          };
        }),
      });
    }
    if (parts[0] === 'api' && parts[1] === 'tasks' && parts[2]) {
      const t = tasks.find((x) => x.id === parts[2]);
      if (!t) return send(res, 404, { error: 'no such task' });
      if (req.method === 'GET' && !parts[3]) return send(res, 200, publicTask(t, true));
      if (req.method === 'POST' && parts[3] === 'message') {
        const { text } = await readBody(req);
        if (!text || !text.trim()) return send(res, 400, { error: 'empty' });
        t.inbox = t.inbox || [];
        t.inbox.push(text.trim());
        addEvent(t, 'You: ' + text.trim());
        if (['blocked', 'done', 'failed', 'stopped'].includes(t.status)) { t.status = 'queued'; t.phase = 'work'; }
        if (t.status === 'waiting') t.status = 'queued';
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts[3] === 'stop') {
        t.status = 'stopped';
        killTree(running.get(t.id));
        addEvent(t, 'Stopping.');
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts[3] === 'resume') {
        if (t.status !== 'running') {
          t.status = 'queued';
          t.errors = 0;
          t.triedOther = false;
          if (t.rounds >= roundLimit(t)) t.rounds = 0;
          addEvent(t, 'Resumed by you.');
        }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts[3] === 'prompt') {
        const { prompt } = await readBody(req);
        if (!prompt || !prompt.trim()) return send(res, 400, { error: 'empty' });
        t.prompt = prompt.trim();
        t.inbox = t.inbox || [];
        t.inbox.push('The task description was rewritten. The new version is below; follow it from now on.\n' + t.prompt);
        addEvent(t, 'Task description updated.');
        if (['done', 'failed', 'stopped', 'blocked'].includes(t.status)) { t.status = 'queued'; t.phase = 'work'; }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts[3] === 'delete') {
        t.deleted = true;
        t.status = 'stopped';
        killTree(running.get(t.id));
        tasks = tasks.filter((x) => x !== t);
        save();
        return send(res, 200, { ok: true });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      try {
        const t = createTask(await readBody(req));
        return send(res, 200, { id: t.id });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    if (url.pathname === '/api/uploads' && req.method === 'POST') {
      const type = String(req.headers['content-type'] || '');
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[type.split(';')[0]];
      if (!ext) return send(res, 400, { error: 'Only PNG, JPG, WebP or GIF images.' });
      try {
        const data = await readRaw(req, 15 * 1024 * 1024);
        if (!data.length) return send(res, 400, { error: 'Empty image.' });
        const name = `img-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
        fs.writeFileSync(path.join(UPLOADS, name), data);
        return send(res, 200, { name, url: '/uploads/' + name });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    if (req.method === 'GET' && parts[0] === 'uploads' && parts.length === 2) {
      const name = path.basename(decodeURIComponent(parts[1]));
      const file = path.join(UPLOADS, name);
      const ext = path.extname(name).slice(1).toLowerCase();
      if (!/^img-[\w-]+\.(png|jpg|webp|gif)$/.test(name) || !fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(file), 'image/' + (ext === 'jpg' ? 'jpeg' : ext));
    }
    if (url.pathname === '/api/voice' && req.method === 'GET') {
      if (!config.voice) return send(res, 200, { ready: false, error: 'Voice is disabled. See README.md to set it up.' });
      try {
        const r = await whisperRequest('GET', '/health');
        return send(res, 200, r.json);
      } catch (err) {
        return send(res, 200, { ready: false, error: err.message });
      }
    }
    if (url.pathname === '/api/transcribe' && req.method === 'POST') {
      if (!config.voice) return send(res, 503, { error: 'Voice is disabled. See README.md to set it up.' });
      try {
        const audio = await readRaw(req, 25 * 1024 * 1024);
        const r = await whisperRequest('POST', '/transcribe', audio, req.headers['content-type']);
        return send(res, r.status, r.json);
      } catch (err) {
        return send(res, 503, { error: err.message });
      }
    }
    if (url.pathname === '/api/chats' && req.method === 'POST') {
      const b = await readBody(req);
      const c = createChat(b.title && String(b.title).trim().slice(0, 60));
      c.effort = effortOf(b.effort);
      if ((b.text && String(b.text).trim()) || uploadNames(b.images).length) postToChat(c, b.text, b.images);
      return send(res, 200, { id: c.id });
    }
    if (parts[0] === 'api' && parts[1] === 'chats' && parts[2]) {
      const c = findChat(parts[2]);
      if (!c) return send(res, 404, { error: 'no such chat' });
      if (req.method === 'GET' && !parts[3]) {
        return send(res, 200, {
          id: c.id, title: c.title, effort: effortOf(c.effort), busy: c.busy, busySince: c.busy ? c.busySince : null, activity: c.activity, pending: c.pending.length,
          waitingForBrain: c.pending.length > 0 && !c.busy && brainBusy,
          messages: c.messages.slice(-150),
          tasks: tasks.filter((t) => t.chatId === c.id).sort((a, b) => b.created - a.created).map((t) => publicTask(t, false)),
        });
      }
      if (req.method === 'POST' && parts[3] === 'message') {
        const { text, images } = await readBody(req);
        if ((!text || !text.trim()) && !uploadNames(images).length) return send(res, 400, { error: 'empty' });
        postToChat(c, text, images);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts[3] === 'stop') {
        if (chat === c) { c.stopRequested = true; if (chatAbort) chatAbort.abort(); }
        else { c.pending = []; c.pendingSince = null; saveChats(); }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts[3] === 'effort') {
        const { effort } = await readBody(req);
        if (!EFFORT[effort]) return send(res, 400, { error: 'Effort is low, medium or high.' });
        c.effort = effort;
        saveChats();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts[3] === 'rename') {
        const { title } = await readBody(req);
        if (title && title.trim()) { c.title = title.trim().slice(0, 60); c.titled = true; saveChats(); }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts[3] === 'delete') {
        if (chat === c) { c.stopRequested = true; if (chatAbort) chatAbort.abort(); }
        fs.mkdirSync(path.join(DATA, 'deleted-chats'), { recursive: true });
        const { busy, busySince, activity, stopRequested, ...rest } = c;
        fs.writeFileSync(path.join(DATA, 'deleted-chats', `${c.id}.json`), JSON.stringify(rest, null, 1));
        chats = chats.filter((x) => x !== c);
        saveChats();
        return send(res, 200, { ok: true });
      }
    }
    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'accounts' && parts[3] === 'clear') {
      const name = decodeURIComponent(parts[2]);
      if (accountState[name]) { delete accountState[name].limitedUntil; delete accountState[name].note; }
      save();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && parts[0] === 'screens' && parts.length === 2) {
      const name = path.basename(decodeURIComponent(parts[1]));
      const file = path.join(SCREENS, name);
      if (!/^shot-\d+\.png$/.test(name) || !fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(file), 'image/png');
    }
    if (req.method === 'GET' && parts[0] === 'files' && parts.length === 3) {
      const t = tasks.find((x) => x.id === parts[1]);
      const name = path.basename(decodeURIComponent(parts[2]));
      if (!t || !/\.(png|jpe?g|gif|webp)$/i.test(name)) return send(res, 404, 'not found', 'text/plain');
      const file = path.join(filesDir(t), name);
      if (!fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain');
      const ext = path.extname(name).slice(1).toLowerCase();
      return send(res, 200, fs.readFileSync(file), 'image/' + (ext === 'jpg' ? 'jpeg' : ext));
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, err.status || 500, { error: err.message });
  }
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `Port ${config.port} is already used by another program (or Kuro is already running). Change "port" in config.json.`
    : err.message);
  process.exit(1);
});

server.listen(config.port, '127.0.0.1', async () => {
  console.log(`Kuro is up: http://localhost:${config.port}`);
  console.log(config.remoteAccess ? `Authenticated phone access: ${config.publicOrigin}` : 'Localhost only. See README.md for authenticated phone access.');
  await checkProviders();
  seedClaudeUsage();
  tick();
  startWhisper();
  startOllama();
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(saveTimer);
  clearTimeout(chatsSaveTimer);
  if (chatAbort) chatAbort.abort();
  flushState();
  writeJson(CHATS_FILE, chats.map(({ busy, busySince, activity, stopRequested, ...rest }) => rest));
  for (const c of running.values()) killTree(c);
  if (whisperProc) killTree(whisperProc);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
