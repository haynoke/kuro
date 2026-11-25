// Controlled CLI fixture. Started only by the test CLI adapter.
// It emits the same event envelopes as the real CLIs without contacting a provider.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(1);
const claude = args.includes('auth') || args.includes('--output-format');
if (args.includes('status')) {
  if (process.env.KURO_FIXTURE_SCENARIO === 'signed-out') process.exit(1);
  console.log(claude ? JSON.stringify({ loggedIn: true }) : 'Logged in using test fixture');
  process.exit(0);
}
const prompt = fs.readFileSync(0, 'utf8');
const cwd = process.cwd();
fs.appendFileSync(path.join(cwd, 'calls.jsonl'), JSON.stringify({ args, prompt, tokenLeaked: !!process.env.KURO_AUTH_TOKEN }) + '\n');
const progress = prompt.match(/Keep a progress log at (.*?): what is done/);
const emit = (value) => console.log(JSON.stringify(value));
emit(claude ? { type: 'system', session_id: 'fixture-claude' } : { type: 'thread.started', thread_id: 'fixture-codex' });
const scenario = process.env.KURO_FIXTURE_SCENARIO || 'done';
if (scenario === 'hold' && !args.includes('resume')) {
  if (progress) fs.writeFileSync(progress[1], 'Started before restart. Continue from this checkpoint.');
  // stdout is a pipe. Flush the session event and let the parent save it.
  process.stdin.resume();
  process.stdout.on('error', () => process.exit(0));
  setInterval(() => process.stdout.write('\n'), 500).unref();
  setTimeout(() => process.exit(0), 15000);
} else {
  if (scenario === 'limit') {
    if (progress) fs.writeFileSync(progress[1], 'Fixture provider completed step one before hitting its usage limit.');
    emit(claude ? { type: 'result', is_error: true, result: 'Usage limit reached. Try again in 1 minute.' }
      : { type: 'turn.failed', error: { message: 'Usage limit reached. Try again in 1 minute.' } });
    process.exit(1);
  }
  if (progress) fs.writeFileSync(progress[1], 'Completed and checked by a controlled provider fixture.');
  const reply = scenario === 'blocked' ? 'Please resolve the missing prerequisite.\nTASK STATUS: BLOCKED'
    : /Review the work another agent/.test(prompt) ? (scenario === 'bad-review' ? 'Looks fine to me.' : 'REVIEW: PASS')
    : 'Created the requested fixture result.\nTASK STATUS: DONE';
  fs.writeFileSync(path.join(cwd, 'result.txt'), 'kuro fixture task complete\n');
  if (claude) emit({ type: 'result', result: reply, ...(scenario === 'permission' ? { permission_denials: [{ tool_name: 'Bash' }] } : {}) });
  else emit({ type: 'item.completed', item: { type: 'agent_message', text: reply } });
  process.exit(0);
}
