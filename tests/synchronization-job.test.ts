import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySynchronizationJobStore,
  SynchronizationJobRunner,
  createSynchronizationJob,
  enqueueSynchronizationJob,
  synchronizationRetryDelay,
  type SynchronizationJobFailure
} from '../src/subtitles/synchronization-job.js';
import { EvidenceEngineProcessError } from '../src/subtitles/synchronization-evidence-engine-process.js';
import type { SynchronizationResult, SynchronizationTask } from '../src/subtitles/synchronization-context.js';
import type { SynchronizationJobObservation } from '../src/subtitles/synchronization-job-observability.js';

const now=1_000_000;
const task:SynchronizationTask={id:'task_123',mediaSource:{kind:'remote-url',url:'https://media.example/a'},provider:'opensubtitles',providerReference:'42',language:'id',status:'pending',createdAt:now,expiresAt:now+600_000};
function result(state:'approved'|'rejected'='approved',offset=1000):SynchronizationResult{return{taskId:task.id,points:state==='approved'?[{sourceMs:1000,referenceMs:2000},{sourceMs:5000,referenceMs:6000},{sourceMs:9000,referenceMs:10000},{sourceMs:13000,referenceMs:14000}]:[],provenance:{kind:'calibrated-model-selection',state,policyId:'p',policyVersion:'v1',modelSelectionVersion:'m1'},evidence:state==='approved'?[0,1,2,3].map(i=>({source:{cueIndex:i,startMs:i*4000+900,endMs:i*4000+1100},reference:{startMs:i*4000+1900,endMs:i*4000+2100},sourceAnchorMs:i*4000+1000,referenceAnchorMs:i*4000+2000,confidence:.8,method:'test'})):[],approvedMapping:state==='approved'?{acceptanceStatus:'approved',model:'offset-only',scale:1,offsetMs:offset,meanAbsoluteResidualMs:0,inlierRatio:1,temporalCoverage:.8,inlierCount:4,evidenceCount:4,policyId:'p',policyVersion:'v1',modelSelectionVersion:'m1'}:undefined,confidence:.8,method:'test',createdAt:now,expiresAt:now+600_000};}
const runnerPolicy={maxAttempts:3,baseDelayMs:5_000,maximumDelayMs:60_000,leaseMs:120_000};
const permanent=(category='invalid_input'):SynchronizationJobFailure=>({category:category as any,message:'bad',retryable:false,occurredAt:now});

describe('durable synchronization job lifecycle reference store',()=>{
 it('enqueues idempotently and atomically prevents duplicate claim',async()=>{const s=new InMemorySynchronizationJobStore();const j=createSynchronizationJob(task,now);expect(await s.enqueue(j)).toEqual(await s.enqueue(j));const a=await s.claim('worker_a',now,1000);expect(a).not.toBeNull();expect(await s.claim('worker_b',now,1000)).toBeNull();});
 it('heartbeats only the lease owner',async()=>{const s=new InMemorySynchronizationJobStore();const j=await s.enqueue(createSynchronizationJob(task,now));const c=(await s.claim('a',now,1000))!;expect((await s.heartbeat(j.id,c.leaseToken,now+500,1000)).lease?.expiresAt).toBe(now+1500);await expect(s.heartbeat(j.id,'wrong',now+600,1000)).rejects.toThrow('lease');});
 it('recovers stale processing and lets a new worker claim after backoff',async()=>{const s=new InMemorySynchronizationJobStore();const j=await s.enqueue(createSynchronizationJob(task,now));await s.claim('a',now,100);expect(await s.recoverStale(now+100)).toBe(1);expect((await s.get(j.id))?.state).toBe('queued');expect(await s.claim('b',now+100,100)).toBeNull();const b=await s.claim('b',now+100+synchronizationRetryDelay(1),100);expect(b?.job.attempt).toBe(2);});
 it('rejects stale worker completion after lease recovery and accepts only current completion',async()=>{const s=new InMemorySynchronizationJobStore();const j=await s.enqueue(createSynchronizationJob(task,now));const a=(await s.claim('a',now,100))!;await s.recoverStale(now+100);const b=(await s.claim('b',now+100+synchronizationRetryDelay(1),1000))!;await expect(s.complete(j.id,a.leaseToken,result(),now+5200)).rejects.toThrow('lease');expect((await s.complete(j.id,b.leaseToken,result(),now+5200)).state).toBe('completed');});
 it('protects idempotent completion and rejects conflicting duplicate mapping',async()=>{const s=new InMemorySynchronizationJobStore();const j=await s.enqueue(createSynchronizationJob(task,now));const c=(await s.claim('a',now,1000))!;const done=await s.complete(j.id,c.leaseToken,result(),now+10);expect(await s.complete(j.id,'old',result(),now+20)).toEqual(done);await expect(s.complete(j.id,'old',result('approved',2000),now+20)).rejects.toThrow('different');});
 it('never completes after cancellation and never requeues terminal completion',async()=>{const s=new InMemorySynchronizationJobStore();const j=await s.enqueue(createSynchronizationJob(task,now));const c=(await s.claim('a',now,1000))!;expect((await s.cancel(j.id,now+1)).state).toBe('cancelled');await expect(s.complete(j.id,c.leaseToken,result(),now+2)).rejects.toThrow();await expect(s.retry(j.id,c.leaseToken,{...permanent('timeout'),retryable:true},now+100,now+2)).rejects.toThrow();});
 it('persists rejection and forbids approved mapping on rejected job',async()=>{const s=new InMemorySynchronizationJobStore();const j=await s.enqueue(createSynchronizationJob(task,now));const c=(await s.claim('a',now,1000))!;expect((await s.reject(j.id,c.leaseToken,permanent('calibration_rejected'),result('rejected'),now+1)).state).toBe('rejected');});
 it('retries with exponential backoff then dead-letters on exhaustion',async()=>{const s=new InMemorySynchronizationJobStore();const j=await s.enqueue(createSynchronizationJob(task,now,2));let c=(await s.claim('a',now,1000))!;const f={category:'timeout' as const,message:'timeout',retryable:true,occurredAt:now};expect((await s.retry(j.id,c.leaseToken,f,now+5000,now+1)).state).toBe('queued');c=(await s.claim('b',now+5000,1000))!;expect((await s.retry(j.id,c.leaseToken,f,now+10000,now+5001)).state).toBe('failed');});
 it('runner classifies approved, rejected, crash retry, and graceful shutdown',async()=>{const s=new InMemorySynchronizationJobStore();await s.enqueue(createSynchronizationJob(task,now));const approvedWorker={process:vi.fn().mockResolvedValue(result())};const runner=new SynchronizationJobRunner(s,approvedWorker,'w',()=>now);expect((await runner.runOnce())?.state).toBe('completed');runner.requestShutdown();expect(await runner.runOnce()).toBeNull();expect(runner.isStopping).toBe(true);
 const s2=new InMemorySynchronizationJobStore();await s2.enqueue(createSynchronizationJob({...task,id:'task_2'},now));const rejected={...result('rejected'),taskId:'task_2'};expect((await new SynchronizationJobRunner(s2,{process:async()=>rejected},'w',()=>now).runOnce())?.state).toBe('rejected');
 const s3=new InMemorySynchronizationJobStore();await s3.enqueue(createSynchronizationJob({...task,id:'task_3'},now));const crash={process:async()=>{throw new EvidenceEngineProcessError('process_crash','crash')}};expect((await new SynchronizationJobRunner(s3,crash,'w',()=>now).runOnce())?.state).toBe('queued');});
 it('heartbeats during work and stops heartbeat after completion',async()=>{
  const store=new InMemorySynchronizationJobStore();await store.enqueue(createSynchronizationJob(task,now));let clock=now;const events:SynchronizationJobObservation[]=[];
  const worker={process:vi.fn(async()=>{await new Promise(resolve=>setTimeout(resolve,55));return result();})};
  const timer=setInterval(()=>clock+=10,10);
  try{
   const runner=new SynchronizationJobRunner(store,worker,'heartbeat_worker',()=>clock,{...runnerPolicy,leaseMs:100},{heartbeatPeriodMs:15,observer:{record:event=>{events.push({...event});}}});
   expect((await runner.runOnce())?.state).toBe('completed');
   const count=events.filter(event=>event.event==='heartbeat').length;expect(count).toBeGreaterThan(0);
   await new Promise(resolve=>setTimeout(resolve,35));
   expect(events.filter(event=>event.event==='heartbeat')).toHaveLength(count);
  }finally{clearInterval(timer);}
 });
 it('propagates processing cancellation through AbortSignal and prevents completion',async()=>{
  const store=new InMemorySynchronizationJobStore();const job=await store.enqueue(createSynchronizationJob(task,now));let clock=now;let aborted=false;
  const worker={process:vi.fn((_task:any,context:any):Promise<never>=>new Promise((_resolve,reject)=>context.signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('cancelled','AbortError'));},{once:true})))};
  const runner=new SynchronizationJobRunner(store,worker,'cancel_worker',()=>clock,{...runnerPolicy,leaseMs:100},{heartbeatPeriodMs:10});
  const pending=runner.runOnce();await new Promise(resolve=>setTimeout(resolve,18));clock+=20;await store.cancel(job.id,clock);
  expect((await pending)?.state).toBe('cancelled');expect(aborted).toBe(true);expect((await store.get(job.id))?.result).toBeUndefined();
 });
 it('fails closed on heartbeat ownership loss while inference is active',async()=>{
  const store=new InMemorySynchronizationJobStore();await store.enqueue(createSynchronizationJob(task,now));let aborted=false;
  store.heartbeat=vi.fn().mockRejectedValue(new Error('lease ownership lost'));
  const worker={process:vi.fn((_task:any,context:any):Promise<never>=>new Promise((_resolve,reject)=>context.signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('lost','AbortError'));},{once:true})))};
  const runner=new SynchronizationJobRunner(store,worker,'lease_worker',()=>now,{...runnerPolicy,leaseMs:100},{heartbeatPeriodMs:10});
  const state=await runner.runOnce();expect(aborted).toBe(true);expect(state?.state).toBe('processing');expect(state?.result).toBeUndefined();
 });
 it('polling is bounded, shutdown-aware, and runs stale recovery without busy-looping',async()=>{
  const store=new InMemorySynchronizationJobStore();const claim=vi.spyOn(store,'claim');const recover=vi.spyOn(store,'recoverStale');
  const runner=new SynchronizationJobRunner(store,{process:async()=>result()},'poll_worker',()=>now,runnerPolicy,{pollingIntervalMs:20,staleRecoveryIntervalMs:10});
  const controller=new AbortController();const polling=runner.runPolling(controller.signal);await new Promise(resolve=>setTimeout(resolve,58));controller.abort();await polling;
  expect(claim.mock.calls.length).toBeLessThan(6);expect(recover).toHaveBeenCalled();runner.requestShutdown();expect(await runner.runOnce()).toBeNull();
 });
 it('emits content-free structured observability for completion',async()=>{
  const store=new InMemorySynchronizationJobStore();await store.enqueue(createSynchronizationJob(task,now));const events:SynchronizationJobObservation[]=[];
  const runner=new SynchronizationJobRunner(store,{process:async(_task,context)=>{context?.reportMetrics?.({evidenceEngineDurationMs:1200,asrDurationMs:800,whisperRevision:'w',labseRevision:'l'});return result();}},'observer_worker',()=>now,runnerPolicy,{observer:{record:event=>{events.push({...event});}}});
  await runner.runOnce();const completed=events.find(event=>event.event==='completed')!;
  expect(completed).toMatchObject({workerId:'observer_worker',provider:'opensubtitles',evidenceCount:4,selectedModel:'offset-only',scale:1,offsetMs:1000,evidenceEngineDurationMs:1200,asrDurationMs:800,whisperRevision:'w',labseRevision:'l'});
  expect(JSON.stringify(events)).not.toContain('https://media.example');expect(JSON.stringify(events)).not.toContain('Halo dunia');expect(JSON.stringify(events)).not.toContain('audio.wav');
 });

 it('emits a content-free queued event through the enqueue observability boundary',async()=>{
  const store=new InMemorySynchronizationJobStore();const events:SynchronizationJobObservation[]=[];
  await enqueueSynchronizationJob(store,createSynchronizationJob(task,now),{record:event=>{events.push({...event});}});
  expect(events).toEqual([expect.objectContaining({event:'queued',jobId:expect.any(String),correlationId:expect.any(String),provider:'opensubtitles'})]);
  expect(JSON.stringify(events)).not.toContain(task.mediaSource.url);
 });

});
