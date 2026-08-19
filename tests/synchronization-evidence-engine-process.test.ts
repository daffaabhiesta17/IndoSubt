import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceEngineProcessAdapter, EvidenceEngineProcessError } from '../src/subtitles/synchronization-evidence-engine-process.js';
import type { SynchronizationEvidenceEngineInput } from '../src/subtitles/synchronization-worker.js';

const input: SynchronizationEvidenceEngineInput = {
  task: { id: 'task_123', mediaSource: { kind: 'remote-url', url: 'https://example/media' }, provider: 'opensubtitles', providerReference: '42', language: 'id', status: 'processing', createdAt: 1, expiresAt: 9999999999999 },
  cues: [{ text: 'Halo dunia', startMs: 1000, endMs: 2000 }],
  media: { durationMs: 3000, hasAudio: true, audioStreams: [{ sampleRateHz: 16000, channels: 1 }] },
  audio: { contentType: 'audio/wav', sampleRateHz: 16000, channels: 1, durationMs: 3000, bytes: new Uint8Array(100) }
};
async function helper(source: string) {
  const directory = await mkdtemp(path.join(tmpdir(), 'indosync-helper-'));
  const file = path.join(directory, 'helper.cjs');
  await writeFile(file, source); await chmod(file, 0o755);
  return { file, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
function resultScript(result = true) {
  return `let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{const r=JSON.parse(raw);console.log(JSON.stringify({type:'ready',protocolVersion:r.protocolVersion,requestId:r.requestId,models:{whisperRevision:'w',labseRevision:'l',device:'cuda',computeType:'float16'}}));${result ? `console.log(JSON.stringify({type:'result',protocolVersion:r.protocolVersion,requestId:r.requestId,evidence:[{source:{cueIndex:0,startMs:1000,endMs:2000},reference:{startMs:1200,endMs:2200},sourceAnchorMs:1500,referenceAnchorMs:1700,confidence:.8,method:'test'}],confidence:.8,method:'test',metrics:{}}));` : ''}});`;
}
describe('evidence engine process boundary', () => {
  it('correlates a successful ready/result exchange and validates evidence', async () => {
    const h=await helper(resultScript()); try {
      const adapter=new EvidenceEngineProcessAdapter({ command: process.execPath, args:[h.file] });
      await expect(adapter.generate(input)).resolves.toMatchObject({ confidence:.8, method:'test', evidence:[{sourceAnchorMs:1500,referenceAnchorMs:1700}] });
    } finally { await h.cleanup(); }
  });
  it('rejects malformed request inputs before spawning', async () => {
    const adapter=new EvidenceEngineProcessAdapter({ command: process.execPath, maxAudioBytes:44 });
    await expect(adapter.generate(input)).rejects.toMatchObject({ category:'invalid_input' });
  });
  it.each([
    ['malformed response', `process.stdin.resume();process.stdin.on('end',()=>console.log('no-json'))`, 'malformed_response'],
    ['process crash', `process.stdin.resume();process.stdin.on('end',()=>process.exit(7))`, 'process_crash'],
    ['oversized output', `process.stdin.resume();process.stdin.on('end',()=>console.log('x'.repeat(10000)))`, 'output_too_large']
  ])('handles %s', async (_label,source,category) => {
    const h=await helper(source); try {
      const adapter=new EvidenceEngineProcessAdapter({ command:process.execPath,args:[h.file],maxOutputBytes:500 });
      await expect(adapter.generate(input)).rejects.toMatchObject({ category });
    } finally { await h.cleanup(); }
  });
  it('times out and kills a hung process', async () => {
    const h=await helper(`process.stdin.resume();setInterval(()=>{},1000)`); try {
      const adapter=new EvidenceEngineProcessAdapter({ command:process.execPath,args:[h.file],timeoutMs:50 });
      await expect(adapter.generate(input)).rejects.toMatchObject({ category:'timeout' });
    } finally { await h.cleanup(); }
  });
  it('supports cancellation', async () => {
    const h=await helper(`process.stdin.resume();setInterval(()=>{},1000)`); const controller=new AbortController(); try {
      const adapter=new EvidenceEngineProcessAdapter({ command:process.execPath,args:[h.file],timeoutMs:5000,signal:controller.signal });
      const pending=adapter.generate(input); setTimeout(()=>controller.abort(),30);
      await expect(pending).rejects.toMatchObject({ category:'cancelled' });
    } finally { await h.cleanup(); }
  });
  it('rejects malformed evidence and correlation mismatch', async () => {
    const h=await helper(`let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{const r=JSON.parse(raw);console.log(JSON.stringify({type:'ready',protocolVersion:r.protocolVersion,requestId:'wrong',models:{whisperRevision:'w',labseRevision:'l',device:'cuda',computeType:'float16'}}))})`); try {
      const adapter=new EvidenceEngineProcessAdapter({command:process.execPath,args:[h.file]});
      await expect(adapter.generate(input)).rejects.toMatchObject({category:'malformed_response'});
    } finally {await h.cleanup();}
  });
  it('cancels before process spawn without creating a child', async () => {
    const controller=new AbortController();controller.abort();
    const spawnProcess=(()=>{throw new Error('must not spawn')}) as any;
    const adapter=new EvidenceEngineProcessAdapter({command:process.execPath,signal:controller.signal,spawnProcess});
    await expect(adapter.generate(input)).rejects.toMatchObject({category:'cancelled'});
  });
  it('cancels while waiting for the GPU semaphore and releases it afterward', async () => {
    const h=await helper(resultScript());
    const controller=new AbortController();
    const firstController=new AbortController();
    const slow=await helper(`process.stdin.resume();setInterval(()=>{},1000)`);
    try {
      const adapter=new EvidenceEngineProcessAdapter({command:process.execPath,args:[slow.file],timeoutMs:5000,signal:firstController.signal});
      const first=adapter.generate(input);await new Promise(resolve=>setTimeout(resolve,20));
      const secondAdapter=adapter as any;secondAdapter.options.signal=controller.signal;
      const second=adapter.generate(input);controller.abort();
      await expect(second).rejects.toMatchObject({category:'cancelled'});
      firstController.abort();await expect(first).rejects.toMatchObject({category:'cancelled'});
    } finally {await h.cleanup();await slow.cleanup();}
  });
  it('cleans isolated temporary artifacts after timeout, cancellation, crash, malformed, and oversized failures', async () => {
    const temp=await mkdtemp(path.join(tmpdir(),'indosync-temp-audit-'));
    const cases=[
      {source:`process.stdin.resume();setInterval(()=>{},1000)`,options:{timeoutMs:30},category:'timeout'},
      {source:`process.stdin.resume();process.stdin.on('end',()=>process.exit(9))`,options:{},category:'process_crash'},
      {source:`process.stdin.resume();process.stdin.on('end',()=>console.log('bad'))`,options:{},category:'malformed_response'},
      {source:`process.stdin.resume();process.stdin.on('end',()=>console.log('x'.repeat(10000)))`,options:{maxOutputBytes:500},category:'output_too_large'}
    ];
    try {
      for(const c of cases){const h=await helper(c.source);try{const adapter=new EvidenceEngineProcessAdapter({command:process.execPath,args:[h.file],temporaryRoot:temp,...c.options});await expect(adapter.generate(input)).rejects.toMatchObject({category:c.category});expect(await import('node:fs/promises').then(fs=>fs.readdir(temp))).toEqual([]);}finally{await h.cleanup();}}
    } finally {await rm(temp,{recursive:true,force:true});}
  });

});
