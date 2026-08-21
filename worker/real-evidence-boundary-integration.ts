import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvidenceEngineProcessAdapter } from '../src/subtitles/synchronization-evidence-engine-process.js';
import { CalibratedSynchronizationWorker } from '../src/subtitles/synchronization-worker.js';
import { approvedMappingFromResult } from '../src/subtitles/synchronization-result-provenance.js';
import type { SubtitleProvider } from '../src/subtitles/provider.js';
import type { MediaProbe } from '../src/media/types.js';
import type { AudioExtractor } from '../src/media/audio-extractor.js';
import type { SynchronizationTask } from '../src/subtitles/synchronization-context.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const image='indosync-asr-worker:feasibility'; const now=1_000_000;
async function run(name:string, relative:string){
 const fixture=path.resolve(root,relative); const subtitle=readFileSync(path.join(fixture,'subtitle-id.vtt'),'utf8');
 const provider:SubtitleProvider={name:'fixture-provider',search:async()=>[],download:async()=>({content:subtitle,contentType:'text/vtt; charset=utf-8'})};
 const mediaProbe:MediaProbe={probe:async()=>{const d=JSON.parse(execFileSync('docker',['run','--rm','--entrypoint','ffprobe','-v',`${fixture}:/fixture:ro`,image,'-v','error','-show_entries','format=duration:stream=codec_name,codec_type,sample_rate,channels','-of','json','/fixture/audio.wav'],{encoding:'utf8'}));const a=d.streams.filter((x:any)=>x.codec_type==='audio');return{durationMs:Math.round(+d.format.duration*1000),hasAudio:!!a.length,audioStreams:a.map((x:any)=>({codec:x.codec_name,sampleRateHz:+x.sample_rate,channels:x.channels}))}}};
 const audioExtractor:AudioExtractor={extract:async()=>{const b=execFileSync('docker',['run','--rm','--entrypoint','ffmpeg','-v',`${fixture}:/fixture:ro`,image,'-v','error','-nostdin','-i','/fixture/audio.wav','-ac','1','-ar','16000','-c:a','pcm_s16le','-f','wav','pipe:1'],{encoding:'buffer',maxBuffer:16*1024*1024});return{contentType:'audio/wav',sampleRateHz:16000,channels:1,bytes:new Uint8Array(b)}}};
 const jobRoot=path.resolve(root,'benchmark-output','engine-jobs');
 const adapter=new EvidenceEngineProcessAdapter({command:'docker',args:['run','--rm','-i','--gpus','all','--entrypoint','python','-v',`${path.resolve(root,'worker')}:/engine:ro`,'-v',`${jobRoot}:/job`,image,'/engine/evidence_engine_process.py'],temporaryRoot:jobRoot,protocolMediaPath:'/job/{tempDirectory}/audio.wav',timeoutMs:180000,maxOutputBytes:16*1024*1024});
 const worker=new CalibratedSynchronizationWorker({provider,mediaProbe,audioExtractor,evidenceEngine:adapter,now:()=>now});
 const task:SynchronizationTask={id:`boundary_${name}`,mediaSource:{kind:'remote-url',url:`https://fixture.invalid/${name}`},provider:provider.name,providerReference:name,language:'id',status:'processing',createdAt:now-1,expiresAt:now+300000};
 const t=performance.now();const result=await worker.process(task);return{name,seconds:(performance.now()-t)/1000,state:result.provenance?.kind==='calibrated-model-selection'?result.provenance.state:null,evidence:result.evidence?.length,approved:result.approvedMapping,downstream:approvedMappingFromResult(result),legacy:Object.hasOwn(result,'mapping')};
}
console.log(JSON.stringify([await run('development','fixture/covost2-en-id'),await run('holdout','fixture/covost2-en-id-holdout')],null,2));
