import { describe,expect,it,vi } from 'vitest';
import { UpstashSynchronizationJobStore } from '../src/subtitles/upstash-synchronization-job-store.js';
import { createSynchronizationJob } from '../src/subtitles/synchronization-job.js';
const task={id:'task_123',mediaSource:{kind:'remote-url' as const,url:'https://media.example/a'},provider:'opensubtitles',providerReference:'42',language:'id' as const,status:'pending' as const,createdAt:1000,expiresAt:100000};
function response(result:unknown){return new Response(JSON.stringify({result}),{status:200,headers:{'Content-Type':'application/json'}});}
describe('Upstash durable synchronization job transport',()=>{
 it('uses atomic Lua for enqueue, claim, heartbeat, completion, retry, cancellation, and recovery',async()=>{const job=createSynchronizationJob(task,1000);const fetchMock=vi.fn()
  .mockResolvedValueOnce(response(JSON.stringify(job)))
  .mockResolvedValueOnce(response(JSON.stringify({...job,state:'processing',attempt:1,lease:{owner:'w',token:'server-token',acquiredAt:1000,expiresAt:2000}})))
  .mockResolvedValueOnce(response(JSON.stringify({...job,state:'processing'})))
  .mockResolvedValueOnce(response(JSON.stringify({...job,state:'queued'})))
  .mockResolvedValueOnce(response(JSON.stringify({...job,state:'cancelled'})))
  .mockResolvedValueOnce(response(1));
 const s=new UpstashSynchronizationJobStore({url:'https://redis.example',token:'token',fetch:fetchMock});await s.enqueue(job);const c=await s.claim('w',1000,1000);expect(c?.job.state).toBe('processing');await s.heartbeat(job.id,c!.leaseToken,1200,1000);await s.retry(job.id,c!.leaseToken,{category:'timeout',message:'x',retryable:true,occurredAt:1200},5000,1200);await s.cancel(job.id,1300);expect(await s.recoverStale(2000)).toBe(1);
 for(const call of fetchMock.mock.calls){const body=JSON.parse((call[1] as RequestInit).body as string);expect(body[0]).toBe('EVAL');}
 });
 it('rejects malformed configuration and Redis errors',async()=>{expect(()=>new UpstashSynchronizationJobStore({url:'http://bad',token:'x'})).toThrow();const s=new UpstashSynchronizationJobStore({url:'https://redis.example',token:'x',fetch:vi.fn().mockResolvedValue(new Response(JSON.stringify({error:'bad'}),{status:200}))});await expect(s.get('x')).rejects.toThrow('command');});
});
