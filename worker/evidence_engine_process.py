from __future__ import annotations
import json, os, resource, sys, time, traceback
from pathlib import Path

sys.path.insert(0, '/engine')
from crosslingual_benchmark import (
    LABSE_REVISION, WHISPER_REVISION, METHOD, build_asr_phrases,
    build_subtitle_candidates, candidate_matches, cosine_matrix,
    evidence_from_matches, monotonic_align,
)
from faster_whisper import WhisperModel
from sentence_transformers import SentenceTransformer
from silero_vad import get_speech_timestamps, load_silero_vad, read_audio

PROTOCOL='indosync-evidence-v1'
MAX_CUES=2000
MAX_TEXT=4096

def emit(value):
    print(json.dumps(value,ensure_ascii=False,separators=(',',':')),flush=True)

def fail(request_id,category,message,code=1):
    emit({'type':'error','protocolVersion':PROTOCOL,'requestId':request_id,'category':category,'message':message[:512]})
    raise SystemExit(code)

def main():
    raw=sys.stdin.readline()
    try: request=json.loads(raw)
    except Exception: fail('unknown','invalid_request','Request must be one JSON object.')
    request_id=request.get('requestId','unknown')
    if request.get('protocolVersion')!=PROTOCOL: fail(request_id,'invalid_request','Unsupported protocol version.')
    if not isinstance(request_id,str) or not request_id or len(request_id)>128: fail('unknown','invalid_request','Invalid request id.')
    media=request.get('mediaPath'); cues=request.get('cues')
    if not isinstance(media,str) or not media.startswith('/job/') or '..' in Path(media).parts: fail(request_id,'invalid_request','Invalid media path.')
    if not isinstance(cues,list) or not cues or len(cues)>MAX_CUES: fail(request_id,'invalid_request','Invalid cue count.')
    previous=-1
    for cue in cues:
      if not isinstance(cue,dict) or not isinstance(cue.get('cueIndex'),int) or cue['cueIndex']<0 or cue['cueIndex']<=previous: fail(request_id,'invalid_request','Cue indices must increase.')
      if not isinstance(cue.get('startMs'),int) or not isinstance(cue.get('endMs'),int) or cue['startMs']<0 or cue['endMs']<=cue['startMs']: fail(request_id,'invalid_request','Invalid cue interval.')
      if not isinstance(cue.get('text'),str) or not cue['text'].strip() or len(cue['text'])>MAX_TEXT: fail(request_id,'invalid_request','Invalid cue text.')
      previous=cue['cueIndex']
    if not Path(media).is_file(): fail(request_id,'media_failure','Media artifact not found.')
    try:
      started=time.perf_counter(); vad=load_silero_vad(); whisper=WhisperModel('/opt/models/faster-whisper-large-v3',device='cuda',compute_type='float16'); labse=SentenceTransformer('/opt/models/labse',device='cpu',local_files_only=True)
      emit({'type':'ready','protocolVersion':PROTOCOL,'requestId':request_id,'models':{'whisperRevision':WHISPER_REVISION,'labseRevision':LABSE_REVISION,'device':'cuda','computeType':'float16'}})
      t=time.perf_counter(); wave=read_audio(media,sampling_rate=16000); speech=get_speech_timestamps(wave,vad,sampling_rate=16000,return_seconds=True); vad_s=time.perf_counter()-t
      t=time.perf_counter(); gen,info=whisper.transcribe(media,beam_size=5,word_timestamps=True,vad_filter=False); segments=[]
      for s in gen: segments.append({'start':s.start,'end':s.end,'text':s.text,'avg_logprob':s.avg_logprob,'no_speech_prob':s.no_speech_prob,'words':[{'start':w.start,'end':w.end,'word':w.word,'probability':w.probability} for w in (s.words or [])]})
      asr_s=time.perf_counter()-t
      phrases=build_asr_phrases(segments); subtitles=build_subtitle_candidates(cues)
      t=time.perf_counter(); matrix=cosine_matrix(labse,subtitles,phrases); raw_matches=candidate_matches(subtitles,phrases,matrix); aligned=monotonic_align(len(cues),raw_matches); evidence,rejected=evidence_from_matches(cues,aligned); labse_s=time.perf_counter()-t
      confidence=min((x['confidence'] for x in evidence),default=0.0)
      emit({'type':'result','protocolVersion':PROTOCOL,'requestId':request_id,'evidence':evidence,'confidence':confidence,'method':METHOD,'metrics':{'totalSeconds':time.perf_counter()-started,'vadSeconds':vad_s,'asrSeconds':asr_s,'labseAlignmentSeconds':labse_s,'speechIntervals':len(speech),'asrCandidates':len(phrases),'pairCandidates':len(raw_matches),'alignedMatches':len(aligned),'qualityRejected':len(rejected),'peakRamMiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024}})
    except SystemExit: raise
    except Exception as error: fail(request_id,'inference_failure',f'{type(error).__name__}: {error}')

if __name__=='__main__': main()
