import { randomBytes } from 'node:crypto';
import { approvedMappingFromResult } from './synchronization-result-provenance.js';
import type { SynchronizationResult } from './synchronization-context.js';
import {
  type ClaimedSynchronizationJob, type SynchronizationJob, type SynchronizationJobFailure,
  type SynchronizationJobStore, synchronizationRetryDelay
} from './synchronization-job.js';
import type { UpstashRedisOptions } from './upstash-synchronization-store.js';

const SCRIPT=`
local op=ARGV[1]
local function decode(raw) if not raw then return nil end return cjson.decode(raw) end
local function save(job) redis.call('SET',KEYS[1],cjson.encode(job),'PXAT',job.expiresAt) end
if op=='enqueue' then
 local existing=redis.call('GET',KEYS[1]); if existing then return existing end
 local job=decode(ARGV[2]); save(job); redis.call('ZADD',KEYS[2],job.nextAttemptAt,job.id); return cjson.encode(job)
end
local raw=redis.call('GET',KEYS[1]); local job=decode(raw); if not job then return 'err:missing' end
if op=='heartbeat' then
 if job.state~='processing' or not job.lease or job.lease.token~=ARGV[2] then return 'err:lease' end
 if tonumber(job.lease.expiresAt)<=tonumber(ARGV[3]) then return 'err:expired-lease' end
 job.lease.expiresAt=tonumber(ARGV[4]);job.updatedAt=tonumber(ARGV[3]);save(job);redis.call('ZADD',KEYS[3],job.lease.expiresAt,job.id);return cjson.encode(job)
end
if op=='cancel' then
 if job.state=='completed' or job.state=='rejected' or job.state=='failed' then return 'err:terminal' end
 if job.state=='cancelled' then return cjson.encode(job) end
 job.state='cancelled';job.lease=nil;job.result=nil;job.failure=decode(ARGV[2]);job.updatedAt=tonumber(ARGV[3]);save(job);redis.call('ZREM',KEYS[2],job.id);redis.call('ZREM',KEYS[3],job.id);return cjson.encode(job)
end
if job.state=='completed' and op=='complete' then
 local incoming=decode(ARGV[4]);if cjson.encode(job.result)==cjson.encode(incoming) then return cjson.encode(job) end;return 'err:different'
end
if job.state~='processing' or not job.lease or job.lease.token~=ARGV[2] then return 'err:lease' end
if tonumber(job.lease.expiresAt)<=tonumber(ARGV[3]) then return 'err:expired-lease' end
if op=='complete' then job.state='completed';job.result=decode(ARGV[4]);job.failure=nil
elseif op=='reject' then job.state='rejected';job.failure=decode(ARGV[4]);job.result=decode(ARGV[5])
elseif op=='fail' then job.state='failed';job.failure=decode(ARGV[4]);job.result=nil
elseif op=='retry' then local nextAt=tonumber(ARGV[5]);local failure=decode(ARGV[4]);if job.attempt>=job.maxAttempts or nextAt>=job.expiresAt then job.state='failed';job.failure={category='retry_exhausted',message=failure.message,retryable=false,occurredAt=tonumber(ARGV[3])};job.result=nil else job.state='queued';job.failure=failure;job.nextAttemptAt=nextAt;redis.call('ZADD',KEYS[2],job.nextAttemptAt,job.id) end
else return 'err:operation' end
job.lease=nil;job.updatedAt=tonumber(ARGV[3]);save(job);redis.call('ZREM',KEYS[3],job.id);return cjson.encode(job)
`;
const CLAIM=`
local ids=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',ARGV[1],'LIMIT',0,50)
for _,id in ipairs(ids) do local key=ARGV[5]..id;local raw=redis.call('GET',key);if raw then local job=cjson.decode(raw);if job.state=='queued' and tonumber(job.nextAttemptAt)<=tonumber(ARGV[1]) and tonumber(job.expiresAt)>tonumber(ARGV[1]) then job.state='processing';job.attempt=job.attempt+1;job.updatedAt=tonumber(ARGV[1]);job.failure=nil;job.lease={owner=ARGV[2],token=ARGV[3],acquiredAt=tonumber(ARGV[1]),expiresAt=tonumber(ARGV[4])};redis.call('SET',key,cjson.encode(job),'PXAT',job.expiresAt);redis.call('ZREM',KEYS[1],id);redis.call('ZADD',KEYS[2],job.lease.expiresAt,id);return cjson.encode(job) elseif job.state~='queued' or tonumber(job.expiresAt)<=tonumber(ARGV[1]) then redis.call('ZREM',KEYS[1],id) end else redis.call('ZREM',KEYS[1],id) end end
return nil
`;
const RECOVER=`
local ids=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]) local count=0
for _,id in ipairs(ids) do local key=ARGV[3]..id;local raw=redis.call('GET',key);if raw then local job=cjson.decode(raw);if job.state=='processing' and job.lease and tonumber(job.lease.expiresAt)<=tonumber(ARGV[1]) then count=count+1;job.lease=nil;job.updatedAt=tonumber(ARGV[1]);if job.attempt>=job.maxAttempts then job.state='failed';job.failure={category='retry_exhausted',message='Synchronization worker lease expired.',retryable=false,occurredAt=tonumber(ARGV[1])} else job.state='queued';job.nextAttemptAt=tonumber(ARGV[1])+tonumber(ARGV[2])*(2^(job.attempt-1));job.failure={category='process_crash',message='Synchronization worker lease expired.',retryable=true,occurredAt=tonumber(ARGV[1])};redis.call('ZADD',KEYS[2],job.nextAttemptAt,id) end;redis.call('SET',key,cjson.encode(job),'PXAT',job.expiresAt) end end;redis.call('ZREM',KEYS[1],id) end return count
`;
export class UpstashSynchronizationJobStore implements SynchronizationJobStore {
 private readonly url:string;private readonly token:string;private readonly prefix:string;private readonly fetcher:typeof fetch;
 constructor(options:UpstashRedisOptions){this.url=options.url;this.token=options.token;this.prefix=clusterPrefix(options.keyPrefix??'indosync:synchronization:jobs:v1');this.fetcher=options.fetch??fetch;if(!/^https:\/\//.test(this.url)||!this.token)throw new Error('Upstash job storage configuration is invalid.');}
 async enqueue(j:SynchronizationJob){return this.action(j.id,'enqueue',[JSON.stringify(j)]);}
 async get(id:string){const v=await this.command<string|null>(['GET',this.key(id)]);return v?JSON.parse(v):null;}
 async claim(worker:string,now:number,leaseMs:number){const token=randomToken();const raw=await this.eval<string|null>(CLAIM,[this.queue(),this.processing()],[String(now),worker,token,String(now+leaseMs),this.keyPrefix()]);if(!raw)return null;return{job:JSON.parse(raw),leaseToken:token};}
 heartbeat(id:string,t:string,n:number,l:number){return this.action(id,'heartbeat',[t,String(n),String(n+l)]);}
 async complete(id:string,t:string,r:SynchronizationResult,n:number){if(!approvedMappingFromResult(r))throw new Error('Synchronization job completion requires approved mapping.');return this.action(id,'complete',[t,String(n),JSON.stringify(r)]);}
 retry(id:string,t:string,f:SynchronizationJobFailure,next:number,n:number){return this.action(id,'retry',[t,String(n),JSON.stringify(f),String(next)]);}
 reject(id:string,t:string,f:SynchronizationJobFailure,r:SynchronizationResult|undefined,n:number){if(r&&approvedMappingFromResult(r))return Promise.reject(new Error('Rejected job cannot contain approved mapping.'));return this.action(id,'reject',[t,String(n),JSON.stringify(f),r?JSON.stringify(r):'null']);}
 fail(id:string,t:string,f:SynchronizationJobFailure,n:number){return this.action(id,'fail',[t,String(n),JSON.stringify(f)]);}
 cancel(id:string,n:number){return this.action(id,'cancel',[JSON.stringify({category:'cancelled',message:'Synchronization job was cancelled.',retryable:false,occurredAt:n}),String(n)]);}
 recoverStale(n:number){return this.eval<number>(RECOVER,[this.processing(),this.queue()],[String(n),'5000',this.keyPrefix()]);}
 async cleanup(ids:readonly string[]){if(!ids.length)return;await this.command<number>(['DEL',...ids.map(id=>this.key(id))]);await this.command<number>(['ZREM',this.queue(),...ids]);await this.command<number>(['ZREM',this.processing(),...ids]);}
 async indexMembers(){const queued=await this.command<string[]>(['ZRANGE',this.queue(),'0','-1']);const processing=await this.command<string[]>(['ZRANGE',this.processing(),'0','-1']);return{queued,processing};}
 private async action(id:string,op:string,args:string[]){const raw=await this.eval<string>(SCRIPT,[this.key(id),this.queue(),this.processing()],[op,...args]);if(raw.startsWith('err:'))throw new Error(`Synchronization job storage ${raw.slice(4)}.`);return JSON.parse(raw);}
 private eval<T>(script:string,keys:string[],args:string[]){return this.command<T>(['EVAL',script,String(keys.length),...keys,...args]);}
 private async command<T>(cmd:string[]){const r=await this.fetcher(this.url,{method:'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:JSON.stringify(cmd)});if(!r.ok)throw new Error(`Upstash job request failed with status ${r.status}.`);const p=await r.json() as {result?:T,error?:string};if(p.error||!Object.hasOwn(p,'result'))throw new Error('Upstash job command failed.');return p.result as T;}
 private keyPrefix(){return `${this.prefix}:job:`;}private key(id:string){return this.keyPrefix()+id;}private queue(){return `${this.prefix}:queued`;}private processing(){return `${this.prefix}:processing`;}
}
function randomToken(){return randomBytes(18).toString('base64url');}

function clusterPrefix(value:string){if(!/^[A-Za-z0-9:_-]{1,96}$/.test(value))throw new Error('Upstash job key prefix is invalid.');return `{${value}}`; }
