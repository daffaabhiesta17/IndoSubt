import { execFileSync } from 'node:child_process';

type Check = { name: string; ok: boolean; detail: string };

function envCheck(name: string): Check {
  const value = process.env[name]?.trim();
  return {
    name: `env:${name}`,
    ok: !!value,
    detail: value ? 'set' : 'missing'
  };
}

function commandCheck(name: string, command: string, args: string[]): Check {
  try {
    execFileSync(command, args, { stdio: 'ignore', timeout: 8000 });
    return { name, ok: true, detail: 'ok' };
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return { name, ok: false, detail: message.slice(0, 120) };
  }
}

async function upstashCheck(): Promise<Check> {
  const url = process.env.KV_REST_API_URL?.trim();
  const token = process.env.KV_REST_API_TOKEN?.trim();
  if (!url || !token) return { name: 'upstash:KV_REST_API_URL+TOKEN', ok: false, detail: 'missing env' };
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['PING'])
    });
    if (!response.ok) return { name: 'upstash:ping', ok: false, detail: `HTTP ${response.status}` };
    return { name: 'upstash:ping', ok: true, detail: 'ok' };
  } catch (error) {
    return { name: 'upstash:ping', ok: false, detail: error instanceof Error ? error.message.slice(0, 120) : String(error) };
  }
}

const checks: Check[] = [
  envCheck('OPENSUBTITLES_API_KEY'),
  envCheck('KV_REST_API_URL'),
  envCheck('KV_REST_API_TOKEN'),
  envCheck('INDOSYNC_CALIBRATED_SYNCHRONIZATION'),
  envCheck('INDOSYNC_SYNCHRONIZATION_NAMESPACE'),
  envCheck('INDOSYNC_EVIDENCE_ENGINE_COMMAND'),
  commandCheck('docker', 'docker', ['version', '--format', '{{.Server.Version}}']),
  commandCheck('docker-image:indosync-asr-worker:feasibility', 'docker', ['image', 'inspect', 'indosync-asr-worker:feasibility']),
  commandCheck('nvidia-smi', 'nvidia-smi', ['-L']),
  commandCheck('docker --gpus', 'docker', ['run', '--rm', '--gpus', 'all', 'nvidia/cuda:12.8.1-base-ubuntu24.04', 'nvidia-smi', '-L'])
];

const upstash = await upstashCheck();
checks.push(upstash);

const ok = checks.every((check) => check.ok);
for (const check of checks) {
  console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
}
console.log(ok ? 'READY: laptop siap mendukung sinkron' : 'NOT READY: perbaiki FAIL di atas');
process.exitCode = ok ? 0 : 1;
