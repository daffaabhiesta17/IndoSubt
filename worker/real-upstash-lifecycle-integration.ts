import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  UpstashSynchronizationJobStore
} from '../src/subtitles/upstash-synchronization-job-store.js';
import {
  createSynchronizationJob,
  type SynchronizationJobFailure
} from '../src/subtitles/synchronization-job.js';
import type { SynchronizationResult, SynchronizationTask } from '../src/subtitles/synchronization-context.js';

function loadEnv(file:string){
  const environment:Record<string,string>={};
  for(const line of readFileSync(file,'utf8').split(/\r?\n/)){
    if(!line||line.trimStart().startsWith('#'))continue;
    const separator=line.indexOf('=');if(separator<1)continue;
    const key=line.slice(0,separator).trim();let value=line.slice(separator+1).trim();
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    environment[key]=value;
  }
  return environment;
}
const env={...loadEnv('.env.production.local'),...process.env};
const url=env.KV_REST_API_URL,token=env.KV_REST_API_TOKEN;
if(!url||!token){console.error('REAL_UPSTASH_LIFECYCLE=NOT_RUN credentials unavailable');process.exit(2);}
const runId=`staging_${Date.now()}_${randomBytes(5).toString('hex')}`;
const prefix=`indosync_staging_${runId}`;
const store=new UpstashSynchronizationJobStore({url,token,keyPrefix:prefix});
const now=Date.now();
const ids:string[]=[];
function task(id:string):SynchronizationTask{return{id,mediaSource:{kind:'remote-url',url:`https://staging.invalid/${id}`},provider:'staging-provider',providerReference:id,language:'id',status:'pending',createdAt:now,expiresAt:now+300_000};}
function result(taskId:string,offset=1000):SynchronizationResult{const evidence=[0,1,2,3].map(i=>({source:{cueIndex:i,startMs:i*4000+900,endMs:i*4000+1100},reference:{startMs:i*4000+1900,endMs:i*4000+2100},sourceAnchorMs:i*4000+1000,referenceAnchorMs:i*4000+2000,confidence:.8,method:'staging'}));return{taskId,points:evidence.map(e=>({sourceMs:e.sourceAnchorMs,referenceMs:e.referenceAnchorMs})),provenance:{kind:'calibrated-model-selection',state:'approved',policyId:'staging',policyVersion:'v1',modelSelectionVersion:'m1'},evidence,approvedMapping:{acceptanceStatus:'approved',model:'offset-only',scale:1,offsetMs:offset,meanAbsoluteResidualMs:0,inlierRatio:1,temporalCoverage:.8,inlierCount:4,evidenceCount:4,policyId:'staging',policyVersion:'v1',modelSelectionVersion:'m1'},confidence:.8,method:'staging',createdAt:now,expiresAt:now+240_000};}
const retryable:SynchronizationJobFailure={category:'timeout',message:'staging timeout',retryable:true,occurredAt:now};
const permanent:SynchronizationJobFailure={category:'calibration_rejected',message:'staging reject',retryable:false,occurredAt:now};
const assert=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
try{
  const first=createSynchronizationJob(task(`task_${runId}_a`),now,3);ids.push(first.id);
  assert((await store.enqueue(first)).id===(await store.enqueue(first)).id,'duplicate enqueue');
  const [claimA,claimB]=await Promise.all([store.claim('worker_a',now,5000),store.claim('worker_b',now,5000)]);
  const owner=claimA??claimB;assert(owner&&!(claimA&&claimB),'concurrent claim');
  await store.heartbeat(first.id,owner!.leaseToken,now+100,5000);
  await store.retry(first.id,owner!.leaseToken,retryable,now+500,now+200);
  assert(await store.claim('early',now+300,5000)===null,'backoff early claim');
  const retried=await store.claim('retry_worker',now+500,5000);assert(retried?.job.attempt===2,'retry claim');
  const completed=await store.complete(first.id,retried!.leaseToken,result(first.task.id),now+600);assert(completed.state==='completed','completion');
  await store.complete(first.id,'duplicate',result(first.task.id),now+700);
  let conflict=false;try{await store.complete(first.id,'duplicate',result(first.task.id,2000),now+700);}catch{conflict=true;}assert(conflict,'conflicting completion');
  let terminalRetry=false;try{await store.retry(first.id,'duplicate',retryable,now+2000,now+800);}catch{terminalRetry=true;}assert(terminalRetry,'completed requeue');

  const cancelJob=createSynchronizationJob(task(`task_${runId}_cancel`),now,3);ids.push(cancelJob.id);await store.enqueue(cancelJob);const cancelClaim=await store.claim('cancel_worker',now,5000);await store.cancel(cancelJob.id,now+1);let cancelComplete=false;try{await store.complete(cancelJob.id,cancelClaim!.leaseToken,result(cancelJob.task.id),now+2);}catch{cancelComplete=true;}assert(cancelComplete,'cancel completion');

  const staleJob=createSynchronizationJob(task(`task_${runId}_stale`),now,3);ids.push(staleJob.id);await store.enqueue(staleJob);const staleA=await store.claim('stale_a',now,100);assert(await store.recoverStale(now+100)===1,'stale recovery');assert(await store.claim('stale_early',now+100,1000)===null,'stale backoff');const staleB=await store.claim('stale_b',now+5100,1000);let staleComplete=false;try{await store.complete(staleJob.id,staleA!.leaseToken,result(staleJob.task.id),now+5200);}catch{staleComplete=true;}assert(staleComplete,'stale worker complete');await store.complete(staleJob.id,staleB!.leaseToken,result(staleJob.task.id),now+5200);

  const rejectedJob=createSynchronizationJob(task(`task_${runId}_reject`),now,1);ids.push(rejectedJob.id);await store.enqueue(rejectedJob);const rejectedClaim=await store.claim('reject_worker',now,1000);await store.reject(rejectedJob.id,rejectedClaim!.leaseToken,permanent,undefined,now+1);assert((await store.get(rejectedJob.id))?.state==='rejected','rejected persistence');

  const exhaustedJob=createSynchronizationJob(task(`task_${runId}_exhaust`),now,1);ids.push(exhaustedJob.id);await store.enqueue(exhaustedJob);const exhaustedClaim=await store.claim('exhaust_worker',now,1000);await store.retry(exhaustedJob.id,exhaustedClaim!.leaseToken,retryable,now+5000,now+1);assert((await store.get(exhaustedJob.id))?.state==='failed','retry exhaustion');
  console.log(JSON.stringify({status:'PASS',prefix,ids,checks:18}));
}catch(error){console.error(JSON.stringify({status:'FAIL',prefix,ids,error:error instanceof Error?error.message:String(error)}));process.exitCode=1;}
finally{
  try{await store.cleanup(ids);const indexes=await store.indexMembers();const remaining=ids.filter(id=>indexes.queued.includes(id)||indexes.processing.includes(id)||false);const keys=[];for(const id of ids)if(await store.get(id))keys.push(id);if(remaining.length||keys.length){console.error(JSON.stringify({cleanup:'FAIL',remainingIndexes:remaining,remainingKeys:keys}));process.exitCode=1;}else console.log(JSON.stringify({cleanup:'PASS',remaining:[]}));}catch(error){console.error(JSON.stringify({cleanup:'FAIL',error:error instanceof Error?error.message:String(error),prefix,ids}));process.exitCode=1;}
}
