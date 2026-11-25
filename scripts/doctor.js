const path = require('node:path');
const { loadConfig } = require('../lib/config');
const { createAccess } = require('../lib/access');
const { checkedArgs, probe } = require('../lib/providers');

async function main() {
  const config = loadConfig(path.resolve(__dirname, '..'));
  createAccess(config);
  console.log(`Node ${process.versions.node}; localhost port ${config.port}; remote access ${config.remoteAccess ? 'authenticated' : 'off'}`);
  let ready = 0;
  for (const account of config.accounts) {
    try {
      checkedArgs(account.engine, config[`${account.engine}Args`]);
      const command = config[`${account.engine}Path`] || account.engine;
      const result = await probe(command, account.engine === 'claude' ? ['auth', 'status'] : ['login', 'status'], { ...process.env, ...(account.env || {}) });
      if (!result.ready) throw new Error(result.error);
      ready++;
      console.log(`${account.name}: signed in and ready`);
    } catch (error) {
      console.error(`${account.name}: ${error.message}`);
    }
  }
  if (config.chat) {
    const url = config.ollamaUrl || 'http://127.0.0.1:11434';
    try {
      const response = await fetch(url + '/api/tags', { signal: AbortSignal.timeout(3000) });
      const tags = await response.json();
      if (!response.ok || !tags.models?.some((m) => m.name === (config.localModel || 'qwen3.5:9b'))) throw new Error('model is missing');
      console.log('Ollama: configured model is available');
    } catch {
      console.error(`Ollama: start it and run ollama pull ${config.localModel || 'qwen3.5:9b'}, or set chat to false.`);
      process.exitCode = 1;
    }
  }
  if (!ready) { console.error('No provider is ready. Fix the setup above before submitting a task.'); process.exitCode = 1; }
  else console.log(`${ready} provider(s) ready. Start with node server.js, then open http://localhost:${config.port}/#/tasks`);
}

main().catch((error) => { console.error('Kuro setup: ' + error.message); process.exitCode = 1; });
