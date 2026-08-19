import { createHash, randomBytes } from 'node:crypto';
import { MediaProbeError } from '../media/types.js';
import { ProviderError } from './provider.js';
import type { SynchronizationResult, SynchronizationTask } from './synchronization-context.js';
import { EvidenceEngineProcessError } from './synchronization-evidence-engine-process.js';
import type { SynchronizationWorker } from './synchronization-orchestrator.js';
import { approvedMappingFromResult } from './synchronization-result-provenance.js';
import {
  disabledSynchronizationJobObserver,
  type SynchronizationJobObserver
} from './synchronization-job-observability.js';

export type SynchronizationJobState = 'queued' | 'processing' | 'completed' | 'rejected' | 'failed' | 'cancelled';
export type SynchronizationJobFailureCategory = 'invalid_input' | 'invalid_media' | 'insufficient_evidence' | 'calibration_rejected' | 'timeout' | 'process_crash' | 'infrastructure' | 'cancelled' | 'retry_exhausted';
export interface SynchronizationJobFailure { category: SynchronizationJobFailureCategory; message: string; retryable: boolean; occurredAt: number; }
export interface SynchronizationJobLease { owner: string; token: string; acquiredAt: number; expiresAt: number; }
export interface SynchronizationJob {
  id: string; correlationId: string; task: SynchronizationTask; state: SynchronizationJobState;
  attempt: number; maxAttempts: number; nextAttemptAt: number; lease?: SynchronizationJobLease;
  result?: SynchronizationResult; failure?: SynchronizationJobFailure;
  createdAt: number; updatedAt: number; expiresAt: number;
}
export interface ClaimedSynchronizationJob { job: SynchronizationJob; leaseToken: string; }
export interface SynchronizationJobStore {
  enqueue(job: SynchronizationJob): Promise<SynchronizationJob>;
  get(id: string): Promise<SynchronizationJob | null>;
  claim(workerId: string, now: number, leaseMs: number): Promise<ClaimedSynchronizationJob | null>;
  heartbeat(id: string, leaseToken: string, now: number, leaseMs: number): Promise<SynchronizationJob>;
  complete(id: string, leaseToken: string, result: SynchronizationResult, now: number): Promise<SynchronizationJob>;
  retry(id: string, leaseToken: string, failure: SynchronizationJobFailure, nextAttemptAt: number, now: number): Promise<SynchronizationJob>;
  reject(id: string, leaseToken: string, failure: SynchronizationJobFailure, result: SynchronizationResult | undefined, now: number): Promise<SynchronizationJob>;
  fail(id: string, leaseToken: string, failure: SynchronizationJobFailure, now: number): Promise<SynchronizationJob>;
  cancel(id: string, now: number): Promise<SynchronizationJob>;
  recoverStale(now: number): Promise<number>;
}
export interface SynchronizationRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maximumDelayMs: number;
  leaseMs: number;
}
export const defaultSynchronizationRetryPolicy: Readonly<SynchronizationRetryPolicy> = Object.freeze({ maxAttempts: 3, baseDelayMs: 5_000, maximumDelayMs: 60_000, leaseMs: 120_000 });
export function synchronizationRetryDelay(attempt: number, base=5_000, maximum=60_000): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Synchronization retry attempt is invalid.');
  return Math.min(maximum, base * 2 ** (attempt - 1));
}
export function createSynchronizationJob(task: SynchronizationTask, now: number, maxAttempts=3): SynchronizationJob {
  validateTime(now); if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error('Synchronization max attempts is invalid.');
  const id = createSynchronizationJobId(task);
  return { id, correlationId: id, task: structuredClone(task), state:'queued', attempt:0, maxAttempts, nextAttemptAt:now, createdAt:now, updatedAt:now, expiresAt:task.expiresAt };
}
export function createSynchronizationJobId(task: SynchronizationTask): string {
  return createHash('sha256').update(task.id).update('\0').update(task.provider).update('\0').update(task.providerReference).update('\0').update(task.mediaSource.url).digest('base64url').slice(0,36);
}
export async function enqueueSynchronizationJob(
  store: SynchronizationJobStore,
  job: SynchronizationJob,
  observer: SynchronizationJobObserver = disabledSynchronizationJobObserver
): Promise<SynchronizationJob> {
  const stored = await store.enqueue(job);
  await observer.record({
    event: 'queued', timestamp: stored.updatedAt, jobId: stored.id,
    correlationId: stored.correlationId, attempt: stored.attempt,
    retryCount: Math.max(0, stored.attempt - 1), workerId: 'enqueue',
    provider: stored.task.provider, resultState: stored.state
  });
  return stored;
}

export class InMemorySynchronizationJobStore implements SynchronizationJobStore {
  private readonly jobs=new Map<string,SynchronizationJob>();
  async enqueue(job:SynchronizationJob){ validateJob(job); const existing=this.jobs.get(job.id); if(existing){ if(existing.correlationId!==job.correlationId) throw new Error('Synchronization job identity collision.'); return clone(existing); } this.jobs.set(job.id,clone(job)); return clone(job); }
  async get(id:string){const v=this.jobs.get(id);return v?clone(v):null;}
  async claim(workerId:string,now:number,leaseMs:number){ validateWorker(workerId);validateTime(now);positive(leaseMs,'lease'); const job=[...this.jobs.values()].filter(j=>j.state==='queued'&&j.nextAttemptAt<=now&&j.expiresAt>now).sort((a,b)=>a.nextAttemptAt-b.nextAttemptAt||a.createdAt-b.createdAt)[0]; if(!job)return null; job.state='processing';job.attempt+=1;job.updatedAt=now;job.failure=undefined;job.lease={owner:workerId,token:randomBytes(18).toString('base64url'),acquiredAt:now,expiresAt:now+leaseMs};return{job:clone(job),leaseToken:job.lease.token}; }
  async heartbeat(id:string,token:string,now:number,leaseMs:number){const j=this.processing(id,token,now);j.lease!.expiresAt=now+positive(leaseMs,'lease');j.updatedAt=now;return clone(j);}
  async complete(id:string,token:string,result:SynchronizationResult,now:number){const existing=this.required(id);if(existing.state==='completed'){if(JSON.stringify(existing.result)===JSON.stringify(result))return clone(existing);throw new Error('Synchronization job already completed with a different result.');}const j=this.processing(id,token,now);if(!approvedMappingFromResult(result))throw new Error('Synchronization job completion requires a calibrated approved mapping.');if(result.taskId!==j.task.id)throw new Error('Synchronization job result task does not match.');j.state='completed';j.result=clone(result);j.lease=undefined;j.failure=undefined;j.updatedAt=now;return clone(j);}
  async retry(id:string,token:string,f:SynchronizationJobFailure,next:number,now:number){const j=this.processing(id,token,now);if(!f.retryable)throw new Error('Synchronization retry requires retryable failure.');if(j.attempt>=j.maxAttempts)return this.terminal(j,'failed',{...f,category:'retry_exhausted',retryable:false},undefined,now);if(!Number.isSafeInteger(next)||next<=now||next>=j.expiresAt) return this.terminal(j,'failed',{...f,category:'retry_exhausted',retryable:false},undefined,now);j.state='queued';j.nextAttemptAt=next;j.failure=clone(f);j.lease=undefined;j.updatedAt=now;return clone(j);}
  async reject(id:string,token:string,f:SynchronizationJobFailure,result:SynchronizationResult|undefined,now:number){const j=this.processing(id,token,now);if(f.retryable)throw new Error('Synchronization rejection must be permanent.');if(result&&approvedMappingFromResult(result))throw new Error('Rejected synchronization job cannot contain approved mapping.');return this.terminal(j,'rejected',f,result,now);}
  async fail(id:string,token:string,f:SynchronizationJobFailure,now:number){const j=this.processing(id,token,now);return this.terminal(j,'failed',{...f,retryable:false},undefined,now);}
  async cancel(id:string,now:number){validateTime(now);const j=this.required(id);if(j.state==='completed'||j.state==='rejected'||j.state==='failed')throw new Error('Terminal synchronization job cannot be cancelled.');if(j.state==='cancelled')return clone(j);return this.terminal(j,'cancelled',{category:'cancelled',message:'Synchronization job was cancelled.',retryable:false,occurredAt:now},undefined,now);}
  async recoverStale(now:number){validateTime(now);let count=0;for(const j of this.jobs.values()){if(j.state==='processing'&&j.lease!.expiresAt<=now){count++;const f={category:'process_crash' as const,message:'Synchronization worker lease expired.',retryable:true,occurredAt:now};if(j.attempt>=j.maxAttempts)this.terminal(j,'failed',{...f,category:'retry_exhausted',retryable:false},undefined,now);else{j.state='queued';j.nextAttemptAt=now+synchronizationRetryDelay(j.attempt);j.failure=f;j.lease=undefined;j.updatedAt=now;}}}return count;}
  private terminal(j:SynchronizationJob,state:'rejected'|'failed'|'cancelled',f:SynchronizationJobFailure,result:SynchronizationResult|undefined,now:number){j.state=state;j.failure=clone(f);j.result=result?clone(result):undefined;j.lease=undefined;j.updatedAt=now;return clone(j);}
  private processing(id:string,token:string,now:number){validateTime(now);const j=this.required(id);if(j.state!=='processing'||!j.lease||j.lease.token!==token)throw new Error('Synchronization job lease is invalid.');if(j.lease.expiresAt<=now)throw new Error('Synchronization job lease has expired.');return j;}
  private required(id:string){const j=this.jobs.get(id);if(!j)throw new Error('Synchronization job was not found.');return j;}
}
export interface SynchronizationJobRunnerOptions {
  heartbeatPeriodMs?: number;
  pollingIntervalMs?: number;
  staleRecoveryIntervalMs?: number;
  observer?: SynchronizationJobObserver;
}

export class SynchronizationJobRunner {
  private stopping=false;
  private active=0;
  private readonly heartbeatPeriodMs:number;
  private readonly pollingIntervalMs:number;
  private readonly staleRecoveryIntervalMs:number;
  private readonly observer:SynchronizationJobObserver;

  constructor(
    private readonly store:SynchronizationJobStore,
    private readonly worker:SynchronizationWorker,
    private readonly workerId:string,
    private readonly now=Date.now,
    private readonly policy:Readonly<SynchronizationRetryPolicy>=defaultSynchronizationRetryPolicy,
    options:SynchronizationJobRunnerOptions={}
  ) {
    validateWorker(workerId);
    this.heartbeatPeriodMs=positive(options.heartbeatPeriodMs??Math.max(1_000,Math.floor(policy.leaseMs/3)),'heartbeat period');
    if(this.heartbeatPeriodMs>=policy.leaseMs)throw new Error('Synchronization heartbeat period must be shorter than the lease.');
    this.pollingIntervalMs=positive(options.pollingIntervalMs??1_000,'polling interval');
    this.staleRecoveryIntervalMs=positive(options.staleRecoveryIntervalMs??10_000,'stale recovery interval');
    this.observer=options.observer??disabledSynchronizationJobObserver;
  }

  async runOnce():Promise<SynchronizationJob|null>{
    if(this.stopping)return null;
    const claimedAt=this.now();
    const claim=await this.store.claim(this.workerId,claimedAt,this.policy.leaseMs);
    if(!claim)return null;
    this.active++;
    const controller=new AbortController();
    let workerMetrics:import('./synchronization-orchestrator.js').SynchronizationWorkerMetrics={};
    let monitorError:unknown;
    let heartbeatRunning=false;
    let heartbeatPromise:Promise<void>=Promise.resolve();
    const observe=(event:Parameters<SynchronizationJobObserver['record']>[0])=>Promise.resolve(this.observer.record(event)).catch(()=>undefined);
    const base=()=>({timestamp:this.now(),jobId:claim.job.id,correlationId:claim.job.correlationId,attempt:claim.job.attempt,retryCount:Math.max(0,claim.job.attempt-1),workerId:this.workerId,provider:claim.job.task.provider});
    await observe({event:'claimed',...base(),leaseDurationMs:this.policy.leaseMs});
    const tick=async()=>{
      if(heartbeatRunning||controller.signal.aborted)return;
      heartbeatRunning=true;
      try{
        const current=await this.store.get(claim.job.id);
        if(!current||current.state==='cancelled'){
          controller.abort(new EvidenceEngineProcessError('cancelled','Synchronization job was cancelled.'));
          await observe({event:'cancelled',...base(),failureCategory:'cancelled'});
          return;
        }
        if(current.state!=='processing'||current.lease?.token!==claim.leaseToken){
          monitorError=new Error('Synchronization job lease ownership was lost.');
          controller.abort(monitorError);
          await observe({event:'lease_lost',...base(),failureCategory:'infrastructure'});
          return;
        }
        await this.store.heartbeat(claim.job.id,claim.leaseToken,this.now(),this.policy.leaseMs);
        await observe({event:'heartbeat',...base(),leaseDurationMs:this.policy.leaseMs});
      }catch(error){monitorError=error;controller.abort(error);await observe({event:'lease_lost',...base(),failureCategory:'infrastructure'});}
      finally{heartbeatRunning=false;}
    };
    const timer=setInterval(()=>{heartbeatPromise=heartbeatPromise.then(tick);},this.heartbeatPeriodMs);timer.unref();
    try{
      const result=await this.worker.process(
        {...claim.job.task,status:'processing'},
        {
          signal:controller.signal,
          reportMetrics:(metrics)=>{workerMetrics={...workerMetrics,...metrics};}
        }
      );
      await heartbeatPromise;
      if(monitorError)throw monitorError;
      const current=await this.store.get(claim.job.id);
      if(!current||current.state!=='processing'||current.lease?.token!==claim.leaseToken){
        return current;
      }
      const state=result.provenance?.kind==='calibrated-model-selection'?result.provenance.state:undefined;
      if(state==='approved'&&approvedMappingFromResult(result)){
        const completed=await this.store.complete(claim.job.id,claim.leaseToken,result,this.now());
        const mapping=result.approvedMapping!;
        await observe({event:'completed',...base(),jobDurationMs:this.now()-claimedAt,resultState:'completed',evidenceCount:result.evidence?.length,selectedModel:mapping.model,scale:mapping.scale,offsetMs:mapping.offsetMs,residualMs:mapping.meanAbsoluteResidualMs,inlierRatio:mapping.inlierRatio,temporalCoverage:mapping.temporalCoverage,evidenceEngineDurationMs:workerMetrics.evidenceEngineDurationMs,asrDurationMs:workerMetrics.asrDurationMs,whisperRevision:workerMetrics.whisperRevision,labseRevision:workerMetrics.labseRevision});
        return completed;
      }
      const failure:SynchronizationJobFailure={category:state==='rejected'?'calibration_rejected':'insufficient_evidence',message:'Calibrated synchronization was not approved.',retryable:false,occurredAt:this.now()};
      const rejected=await this.store.reject(claim.job.id,claim.leaseToken,failure,result,this.now());
      await observe({event:'rejected',...base(),jobDurationMs:this.now()-claimedAt,resultState:'rejected',failureCategory:failure.category,evidenceCount:result.evidence?.length});
      return rejected;
    }catch(error){
      const current=await this.store.get(claim.job.id);
      if(!current)return null;
      if(current.state==='cancelled')return current;
      if(monitorError)return current;
      if(current.state!=='processing'||current.lease?.token!==claim.leaseToken)return current;
      const failure=classifySynchronizationFailure(error,this.now());
      await observe({event:'worker_error',...base(),failureCategory:failure.category});
      if(failure.category==='cancelled'){
        const cancelled=await this.store.cancel(claim.job.id,this.now());
        await observe({event:'cancelled',...base(),resultState:'cancelled',failureCategory:'cancelled'});
        return cancelled;
      }
      if(!failure.retryable){
        const rejected=await this.store.reject(claim.job.id,claim.leaseToken,failure,undefined,this.now());
        await observe({event:'rejected',...base(),resultState:'rejected',failureCategory:failure.category});
        return rejected;
      }
      const next=this.now()+synchronizationRetryDelay(current.attempt,this.policy.baseDelayMs,this.policy.maximumDelayMs);
      const retried=await this.store.retry(claim.job.id,claim.leaseToken,failure,next,this.now());
      await observe({event:retried.state==='failed'?'failed':'retry_scheduled',...base(),resultState:retried.state,failureCategory:retried.failure?.category});
      return retried;
    }finally{
      clearInterval(timer);
      await heartbeatPromise;
      controller.abort();
      this.active--;
    }
  }

  async runPolling(signal?:AbortSignal):Promise<void>{
    let lastRecovery=0;
    while(!this.stopping&&!signal?.aborted){
      const now=this.now();
      if(now-lastRecovery>=this.staleRecoveryIntervalMs){await this.store.recoverStale(now);lastRecovery=now;}
      const result=await this.runOnce();
      if(!result)await delay(this.pollingIntervalMs,signal);
    }
  }

  requestShutdown(){this.stopping=true;}
  get isStopping(){return this.stopping;}
  get activeJobs(){return this.active;}
}

function delay(milliseconds:number,signal?:AbortSignal):Promise<void>{
  if(signal?.aborted)return Promise.resolve();
  return new Promise((resolve)=>{const timer=setTimeout(done,milliseconds);timer.unref();const abort=()=>done();function done(){clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve();}signal?.addEventListener('abort',abort,{once:true});});
}

export function classifySynchronizationFailure(error:unknown,now:number):SynchronizationJobFailure {validateTime(now);if(error instanceof DOMException&&error.name==='AbortError')return{category:'cancelled',message:error.message,retryable:false,occurredAt:now};if(error instanceof EvidenceEngineProcessError){if(error.category==='cancelled')return{category:'cancelled',message:error.message,retryable:false,occurredAt:now};if(error.category==='timeout')return{category:'timeout',message:error.message,retryable:true,occurredAt:now};if(['process_crash','spawn_failure'].includes(error.category))return{category:'process_crash',message:error.message,retryable:true,occurredAt:now};if(error.category==='engine_error'&&/(invalid_request|media_failure)/.test(error.message))return{category:error.message.includes('media_failure')?'invalid_media':'invalid_input',message:error.message,retryable:false,occurredAt:now};return{category:'infrastructure',message:error.message,retryable:true,occurredAt:now};}if(error instanceof MediaProbeError)return{category:'invalid_media',message:error.message,retryable:false,occurredAt:now};if(error instanceof ProviderError){const retryable=['timeout','rate_limited','unavailable'].includes(error.code);return{category:retryable?'infrastructure':'invalid_input',message:error.message,retryable,occurredAt:now};}return{category:'infrastructure',message:'Synchronization worker failed.',retryable:true,occurredAt:now};}
function validateJob(j:SynchronizationJob){if(!/^[A-Za-z0-9_-]{1,128}$/.test(j.id)||j.id!==j.correlationId)throw new Error('Synchronization job identity is invalid.');}
function validateWorker(v:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(v))throw new Error('Synchronization worker id is invalid.');}
function validateTime(v:number){if(!Number.isSafeInteger(v)||v<0)throw new Error('Current time is invalid.');}
function positive(v:number,l:string){if(!Number.isSafeInteger(v)||v<=0)throw new Error(`Synchronization ${l} is invalid.`);return v;}
function clone<T>(v:T):T{return structuredClone(v);}
