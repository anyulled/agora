import { spawn } from 'node:child_process';

const apiPort = process.env.AGORA_API_PORT || '8787';
const webPort = process.env.AGORA_WEB_PORT || '5173';
const commands = [
  ['api', ['scripts/local-api.mjs']],
  [
    'web',
    [
      'exec',
      'vite',
      'local',
      '--config',
      'local/vite.config.js',
      '--host',
      '127.0.0.1',
      '--port',
      webPort,
      '--strictPort',
    ],
  ],
];
const children = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}

for (const [name, args] of commands) {
  const child = spawn(name === 'api' ? 'node' : 'pnpm', args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, AGORA_API_PORT: apiPort, AGORA_WEB_PORT: webPort },
  });
  children.push(child);
  child.on('error', (error) => {
    console.error(`${name} failed to start:`, error);
    stop(1);
  });
  child.on('exit', (code) => {
    if (!stopping) stop(code || 1);
  });
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log(`Agora local console: http://127.0.0.1:${webPort}`);
