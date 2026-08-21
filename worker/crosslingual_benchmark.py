from __future__ import annotations
import argparse, hashlib, json, math, re, resource, statistics, subprocess, time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Sequence

import numpy as np
from faster_whisper import WhisperModel
from sentence_transformers import SentenceTransformer
from silero_vad import get_speech_timestamps, load_silero_vad, read_audio

WHISPER_REVISION = "edaa852ec7e145841d8ffdb056a99866b5f0a478"
LABSE_REVISION = "836121a0533e5664b21c7aacc5d22951f2b8b25b"
METHOD = "labse-monotonic-v2"

# Frozen from the development split (CoVoST2 rows 0-9) before holdout execution.
CALIBRATION = {
    "minimum_similarity": 0.62,
    "minimum_cluster_margin": 0.035,
    "minimum_asr_confidence": 0.72,
    "minimum_evidence_confidence": 0.68,
    "minimum_points": 4,
    "minimum_coverage": 0.55,
    "maximum_offset_residual_ms": 900,
    "minimum_inlier_ratio": 0.70,
    "equivalent_overlap": 0.55,
    "affine_min_scale_delta": 0.003,
    "affine_min_relative_improvement": 0.45,
    "affine_min_absolute_improvement_ms": 250,
}

@dataclass(frozen=True)
class Phrase:
    start: float
    end: float
    text: str
    confidence: float
    first_word: int
    last_word: int
    kind: str

@dataclass(frozen=True)
class Match:
    cue_start: int
    cue_end: int
    phrase: Phrase
    similarity: float
    ambiguity_margin: float
    score: float


def normalize(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text)
    return " ".join(re.findall(r"[^\W_]+(?:['’][^\W_]+)?", text.casefold(), re.UNICODE))


def info_weight(text: str) -> float:
    count = len(normalize(text).split())
    return min(1.0, max(0.0, (count - 1) / 7.0))


def build_asr_phrases(segments: Sequence[dict], max_words: int = 18, stride: int = 2, max_candidates: int = 1200) -> list[Phrase]:
    words=[]
    for segment in segments:
        for word in segment.get("words", []):
            if word["start"] is None or word["end"] is None: continue
            words.append(word)
    phrases=[]; seen=set()
    def add(first,last,kind):
        if len(phrases) >= max_candidates or first<0 or last>len(words) or last<=first: return
        selected=words[first:last]; text="".join(w["word"] for w in selected).strip()
        key=(first,last)
        if key in seen or len(normalize(text).split())<2: return
        seen.add(key)
        probs=[max(0.0,min(1.0,float(w["probability"]))) for w in selected]
        phrases.append(Phrase(float(selected[0]["start"]),float(selected[-1]["end"]),text,float(sum(probs)/len(probs)),first,last-1,kind))
    # Native segment and adjacent-pair boundaries.
    cursor=0; bounds=[]
    for segment in segments:
        n=len(segment.get("words",[])); bounds.append((cursor,cursor+n)); cursor+=n
    for i,(a,b) in enumerate(bounds):
        add(a,b,"segment")
        if i+1<len(bounds): add(a,bounds[i+1][1],"segment-pair")
    # Explicitly bounded word ranges; no timestamp proximity is used.
    for first in range(0,len(words),stride):
        for length in (4,6,8,10,12,15,18): add(first,min(len(words),first+length),"word-range")
    return phrases


def build_subtitle_candidates(cues: Sequence[dict]) -> list[tuple[int,int,str]]:
    result=[]
    for i,cue in enumerate(cues):
        result.append((i,i,normalize(cue["text"])))
        if i+1<len(cues): result.append((i,i+1,normalize(cue["text"]+" "+cues[i+1]["text"])))
    return result


def cosine_matrix(model, subtitles, phrases):
    left=model.encode([x[2] for x in subtitles],normalize_embeddings=True,convert_to_numpy=True)
    right=model.encode([x.text for x in phrases],normalize_embeddings=True,convert_to_numpy=True)
    return np.matmul(left,right.T)


def overlap_coefficient(a: Phrase, b: Phrase) -> float:
    overlap = max(0, min(a.last_word, b.last_word) - max(a.first_word, b.first_word) + 1)
    shorter = min(a.last_word - a.first_word + 1, b.last_word - b.first_word + 1)
    return overlap / shorter if shorter else 0.0


def equivalence_clusters(phrases: Sequence[Phrase], scores: np.ndarray, overlap_threshold: float):
    order = [int(x) for x in np.argsort(-scores)]
    clusters: list[list[int]] = []
    for index in order:
        for cluster in clusters:
            if any(overlap_coefficient(phrases[index], phrases[other]) >= overlap_threshold for other in cluster):
                cluster.append(index)
                break
        else:
            clusters.append([index])
    return clusters


def candidate_matches(subtitles, phrases, similarities, minimum_similarity=None, max_clusters_per_subtitle=8):
    minimum_similarity = CALIBRATION["minimum_similarity"] if minimum_similarity is None else minimum_similarity
    matches=[]
    for si,(cs,ce,_) in enumerate(subtitles):
        clusters=equivalence_clusters(phrases, similarities[si], CALIBRATION["equivalent_overlap"])
        ranked=[]
        for cluster in clusters:
            representative=max(cluster,key=lambda j:float(similarities[si,j]))
            ranked.append((float(similarities[si,representative]),representative,cluster))
        ranked.sort(reverse=True,key=lambda x:x[0])
        ranked=ranked[:max_clusters_per_subtitle]
        for rank,(sim,j,cluster) in enumerate(ranked):
            if sim<minimum_similarity: continue
            competitor=ranked[rank+1][0] if rank+1<len(ranked) else -1.0
            margin=max(0.0,sim-competitor)
            phrase=phrases[j]
            score=(0.67*sim+0.18*phrase.confidence+0.10*info_weight(subtitles[si][2])
                   +0.05*min(1.0,margin/0.15)-0.14*(ce-cs))
            matches.append(Match(cs,ce,phrase,sim,margin,score))
    return matches

def monotonic_align(cue_count: int, matches: Sequence[Match], skip_penalty=0.08) -> list[Match]:
    ordered=sorted(matches,key=lambda m:(m.cue_end,m.phrase.last_word,m.cue_start,m.phrase.first_word))
    best=[]; previous=[]
    for i,m in enumerate(ordered):
        value=m.score-skip_penalty*m.cue_start
        prev=-1
        for j,n in enumerate(ordered[:i]):
            if n.cue_end < m.cue_start and n.phrase.last_word < m.phrase.first_word:
                gap=(m.cue_start-n.cue_end-1)+(m.phrase.first_word-n.phrase.last_word-1)/12.0
                candidate=best[j]+m.score-skip_penalty*gap
                if candidate>value: value=candidate; prev=j
        best.append(value); previous.append(prev)
    if not best:return []
    idx=max(range(len(best)),key=best.__getitem__); path=[]
    while idx>=0: path.append(ordered[idx]); idx=previous[idx]
    return list(reversed(path))


def evidence_from_matches(cues, matches, minimum_similarity=None, minimum_confidence=None, minimum_margin=None):
    minimum_similarity = CALIBRATION["minimum_similarity"] if minimum_similarity is None else minimum_similarity
    minimum_confidence = CALIBRATION["minimum_asr_confidence"] if minimum_confidence is None else minimum_confidence
    minimum_margin = CALIBRATION["minimum_cluster_margin"] if minimum_margin is None else minimum_margin
    evidence=[]; rejected=[]
    for m in matches:
        confidence=max(0.0,min(1.0,0.55*m.similarity+0.30*m.phrase.confidence+0.15*min(1.0,m.ambiguity_margin/0.15)))
        reasons=[]
        if m.similarity<minimum_similarity: reasons.append("similarity")
        if m.phrase.confidence<minimum_confidence: reasons.append("asr_confidence")
        if m.ambiguity_margin<minimum_margin: reasons.append("ambiguity")
        if confidence<CALIBRATION["minimum_evidence_confidence"]: reasons.append("combined_confidence")
        if reasons:
            rejected.append((m,reasons)); continue
        source=cues[m.cue_start:m.cue_end+1]
        item={
          "source":{"cueIndex":m.cue_start,"startMs":source[0]["startMs"],"endMs":source[-1]["endMs"]},
          "reference":{"startMs":round(m.phrase.start*1000),"endMs":round(m.phrase.end*1000)},
          "sourceAnchorMs":round((source[0]["startMs"]+source[-1]["endMs"])/2),
          "referenceAnchorMs":round((m.phrase.start+m.phrase.end)*500),
          "confidence":confidence,"method":METHOD,
          "quality":{"similarity":m.similarity,"ambiguityMargin":m.ambiguity_margin,"asrConfidence":m.phrase.confidence,"candidateKind":m.phrase.kind,"cueEndIndex":m.cue_end,"asrText":m.phrase.text}
        }
        evidence.append(item)
    return evidence,rejected

def robust_accept(evidence, duration_ms, min_points=None, min_coverage=None, max_residual_ms=None, scale_range=(.94,1.06)):
    min_points = CALIBRATION["minimum_points"] if min_points is None else min_points
    min_coverage = CALIBRATION["minimum_coverage"] if min_coverage is None else min_coverage
    max_residual_ms = CALIBRATION["maximum_offset_residual_ms"] if max_residual_ms is None else max_residual_ms
    if len(evidence)<min_points:return {"accepted":False,"reason":"insufficient_points","inliers":[]}
    x=np.array([e["sourceAnchorMs"] for e in evidence],dtype=float); y=np.array([e["referenceAnchorMs"] for e in evidence],dtype=float)
    # Offset-only is the safe default because subtitle and ASR phrase boundaries have
    # heterogeneous lead/lag. A free affine fit can turn that boundary bias into fake drift.
    deltas=y-x; offset0=float(statistics.median(deltas.tolist())); residual0=np.abs(deltas-offset0)
    med0=float(statistics.median(residual0.tolist())); mad0=float(statistics.median(np.abs(residual0-med0).tolist()))
    threshold0=max(350.0,3.0*1.4826*mad0); mask0=residual0<=threshold0
    offset_inliers=[e for e,ok in zip(evidence,mask0) if ok]
    r0=residual0[mask0]; mae0=float(np.mean(r0)) if len(r0) else float('inf')
    coverage0=float((max(x[mask0])-min(x[mask0]))/duration_ms) if sum(mask0)>=2 else 0.0

    slopes=[(y[j]-y[i])/(x[j]-x[i]) for i in range(len(x)) for j in range(i+1,len(x)) if x[j]!=x[i]]
    affine=None
    if slopes:
        scale1=float(statistics.median(slopes)); offset1=float(statistics.median((y-scale1*x).tolist()))
        residual1=np.abs(y-(scale1*x+offset1)); med1=float(statistics.median(residual1.tolist())); mad1=float(statistics.median(np.abs(residual1-med1).tolist()))
        mask1=residual1<=max(350.0,3.0*1.4826*mad1)
        if sum(mask1)>=2:
            scale1,offset1=np.polyfit(x[mask1],y[mask1],1); fitted=np.abs(y[mask1]-(scale1*x[mask1]+offset1)); mae1=float(np.mean(fitted))
            affine={"scale":float(scale1),"offsetMs":float(offset1),"mae":mae1,"mask":mask1}

    use_affine=False
    if affine and scale_range[0]<=affine["scale"]<=scale_range[1]:
        absolute=mae0-affine["mae"]; relative=absolute/mae0 if mae0 else 0.0
        use_affine=(abs(affine["scale"]-1)>=CALIBRATION["affine_min_scale_delta"]
                    and absolute>=CALIBRATION["affine_min_absolute_improvement_ms"]
                    and relative>=CALIBRATION["affine_min_relative_improvement"])
    if use_affine:
        scale=float(affine["scale"]); offset=float(affine["offsetMs"]); mae=float(affine["mae"]); mask=affine["mask"]; model="affine"
    else:
        scale=1.0; offset=offset0; mae=mae0; mask=mask0; model="offset-only"
    inliers=[e for e,ok in zip(evidence,mask) if ok]
    coverage=float((max(x[mask])-min(x[mask]))/duration_ms) if sum(mask)>=2 else 0.0
    reason=None
    if len(inliers)<min_points:reason="insufficient_inliers"
    elif len(inliers)/len(evidence)<CALIBRATION["minimum_inlier_ratio"]:reason="insufficient_inlier_ratio"
    elif mae>max_residual_ms:reason="excessive_residual"
    elif coverage<min_coverage:reason="insufficient_coverage"
    return {"accepted":reason is None,"reason":reason,"selectedModel":model,"scale":scale,"offsetMs":offset,"meanAbsoluteResidualMs":mae,"inlierRatio":len(inliers)/len(evidence),"temporalCoverage":coverage,"inliers":inliers,"diagnostics":{"offsetOnlyMaeMs":mae0,"affine":None if not affine else {k:v for k,v in affine.items() if k!='mask'}}}

def transform_cues(cues, scale=1.0, offset_ms=0):
    return [{**c,"startMs":round(c["startMs"]*scale+offset_ms),"endMs":round(c["endMs"]*scale+offset_ms)} for c in cues]


def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--fixture',default='/fixture'); ap.add_argument('--output',default='/output/result.json'); args=ap.parse_args()
    started=time.perf_counter(); root=Path(args.fixture); timings={}
    t=time.perf_counter(); probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration,size:stream=codec_name,sample_rate,channels','-of','json',str(root/'audio.wav')],text=True)); timings['ffprobe']=time.perf_counter()-t
    duration=float(probe['format']['duration'])
    t=time.perf_counter(); subprocess.run(['ffmpeg','-v','error','-nostdin','-i',str(root/'audio.wav'),'-ac','1','-ar','16000','-c:a','pcm_s16le','-f','wav','-y','/tmp/audio.wav'],check=True); timings['ffmpeg']=time.perf_counter()-t
    t=time.perf_counter(); vad=load_silero_vad(); wave=read_audio('/tmp/audio.wav',sampling_rate=16000); speech=get_speech_timestamps(wave,vad,sampling_rate=16000,return_seconds=True); timings['vad']=time.perf_counter()-t
    t=time.perf_counter(); whisper=WhisperModel('/opt/models/faster-whisper-large-v3',device='cuda',compute_type='float16'); timings['asr_model_load']=time.perf_counter()-t
    t=time.perf_counter(); gen,info=whisper.transcribe('/tmp/audio.wav',beam_size=5,word_timestamps=True,vad_filter=False); segments=[]
    for s in gen: segments.append({'start':s.start,'end':s.end,'text':s.text,'avg_logprob':s.avg_logprob,'no_speech_prob':s.no_speech_prob,'words':[{'start':w.start,'end':w.end,'word':w.word,'probability':w.probability} for w in (s.words or [])]})
    timings['asr']=time.perf_counter()-t
    cues=json.loads((root/'cues.json').read_text(encoding='utf-8'))
    phrases=build_asr_phrases(segments); subtitles=build_subtitle_candidates(cues)
    t=time.perf_counter(); labse=SentenceTransformer('/opt/models/labse',device='cpu',local_files_only=True); matrix=cosine_matrix(labse,subtitles,phrases); timings['labse_load_and_encode']=time.perf_counter()-t
    raw=candidate_matches(subtitles,phrases,matrix); aligned=monotonic_align(len(cues),raw); evidence,rejected=evidence_from_matches(cues,aligned); fit=robust_accept(evidence,round(duration*1000))
    variants={}
    for name,vcues in {'identity':cues,'plus2500':transform_cues(cues,offset_ms=2500),'minus2500':transform_cues(cues,offset_ms=-2500),'scale1.001_plus700':transform_cues(cues,1.001,700),'scale0.999_plus700':transform_cues(cues,.999,700)}.items():
        ve=[{**e,'source':{**e['source'],'startMs':vcues[e['source']['cueIndex']]['startMs'],'endMs':vcues[e['quality']['cueEndIndex']]['endMs']},'sourceAnchorMs':round((vcues[e['source']['cueIndex']]['startMs']+vcues[e['quality']['cueEndIndex']]['endMs'])/2)} for e in evidence]
        variants[name]=robust_accept(ve,round(duration*1000))
    unrelated=[{**c,'text':t} for c,t in zip(cues,['Resep ini menggunakan tepung dan gula.','Cuaca besok diperkirakan hujan.','Kereta berangkat dari stasiun utama.','Tim memenangkan pertandingan terakhir.','Dokter membuka klinik baru.','Gunung itu tertutup salju.','Harga saham turun hari ini.','Kucing tidur di atas sofa.','Mereka menanam padi di sawah.','Pesawat mendarat dengan aman.'])]
    um=cosine_matrix(labse,build_subtitle_candidates(unrelated),phrases); ua=monotonic_align(len(unrelated),candidate_matches(build_subtitle_candidates(unrelated),phrases,um)); ue,_=evidence_from_matches(unrelated,ua); negative={'unrelated':robust_accept(ue,round(duration*1000))}
    output={'fixture':{'sha256':hashlib.sha256((root/'audio.wav').read_bytes()).hexdigest(),'probe':probe,'cueCount':len(cues)},'vad':{'intervals':speech,'speechRatio':sum(x['end']-x['start'] for x in speech)/duration},'asr':{'modelRevision':WHISPER_REVISION,'language':info.language,'languageProbability':info.language_probability,'segments':segments},'labse':{'revision':LABSE_REVISION,'embeddingDimension':int(matrix.shape[1] if False else 768),'similarityMin':float(np.min(matrix)),'similarityMax':float(np.max(matrix))},'alignment':{'subtitleCandidateCount':len(subtitles),'asrCandidateCount':len(phrases),'pairCandidateCount':len(raw),'alignedCount':len(aligned),'aligned':[asdict(x) for x in aligned],'qualityRejected':len(rejected)},'evidence':evidence,'fit':fit,'variants':variants,'negative':negative,'timings':timings|{'total':time.perf_counter()-started},'peakRamMiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024}
    Path(args.output).write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'fit':{k:v for k,v in fit.items() if k!='inliers'},'counts':output['alignment'],'timings':timings,'output':args.output},ensure_ascii=False,default=str))

if __name__=='__main__':main()
