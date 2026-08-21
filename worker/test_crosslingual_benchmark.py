from crosslingual_benchmark import *

def phrase(a,b,text='hello world',confidence=.9,first=0,last=1,kind='word-range'):
    return Phrase(a,b,text,confidence,first,last,kind)

def test_bounded_candidates():
    seg=[{'words':[{'start':i,'end':i+.5,'word':f' w{i}','probability':.9} for i in range(100)]}]
    assert len(build_asr_phrases(seg,max_candidates=50)) <= 50

def test_monotonic_alignment():
    matches=[Match(0,0,phrase(0,1,first=0,last=1),.8,.1,.8),Match(1,1,phrase(2,3,first=2,last=3),.8,.1,.8),Match(1,1,phrase(.5,1.5,first=0,last=1),.9,.1,.9)]
    out=monotonic_align(2,matches); assert len(out)==2; assert out[0].phrase.last_word<out[1].phrase.first_word

def test_low_confidence_rejected():
    cues=[{'text':'x','startMs':0,'endMs':1000}]; m=Match(0,0,phrase(0,1,confidence=.1),.8,.1,.8)
    evidence,rejected=evidence_from_matches(cues,[m]); assert not evidence and rejected

def test_insufficient_rejected():
    assert robust_accept([],10000)['reason']=='insufficient_points'

def test_outlier_rejected():
    ev=[]
    for i,(s,r) in enumerate([(1000,2000),(5000,6000),(9000,10000),(13000,40000)]):
      ev.append({'sourceAnchorMs':s,'referenceAnchorMs':r})
    result=robust_accept(ev,14000,min_points=3,min_coverage=.4); assert result['accepted']; assert result['inlierRatio']==.75

def test_piecewise_rejected():
    ev=[]
    for i,(s,r) in enumerate([(1000,1000),(5000,5000),(9000,14000),(13000,18000)]):ev.append({'sourceAnchorMs':s,'referenceAnchorMs':r})
    result=robust_accept(ev,14000,min_points=3,max_residual_ms=300); assert not result['accepted']

def test_transforms():
    cues=[{'text':'x','startMs':1000,'endMs':2000}]
    assert transform_cues(cues,offset_ms=2500)[0]['startMs']==3500
    assert transform_cues(cues,1.001,700)[0]['startMs']==1701


def test_equivalence_clustering_removes_overlapping_margin_competition():
    phrases=[phrase(0,2,first=0,last=5),phrase(.2,2.1,first=1,last=5),phrase(8,10,first=20,last=25)]
    clusters=equivalence_clusters(phrases,np.array([.80,.79,.60]),.55)
    assert len(clusters)==2
    matches=candidate_matches([(0,0,'teks cukup informatif')],phrases,np.array([[.80,.79,.60]]),minimum_similarity=.5)
    assert matches[0].ambiguity_margin > .15

def test_repeated_generic_dialogue_rejected_by_ambiguity():
    cues=[{'text':'Ya','startMs':0,'endMs':1000}]
    m=Match(0,0,phrase(0,1,text='yes',first=0,last=0),.70,.005,.7)
    evidence,rejected=evidence_from_matches(cues,[m]); assert not evidence; assert 'ambiguity' in rejected[0][1]

def test_missing_middle_can_pass_with_sufficient_coverage():
    ev=[]
    for s,r in [(1000,1100),(8000,8100),(22000,22100),(29000,29100)]:
      ev.append({'sourceAnchorMs':s,'referenceAnchorMs':r})
    result=robust_accept(ev,30000); assert result['accepted']; assert result['temporalCoverage']>.9

def test_unmatched_subtitle_rejected():
    assert robust_accept([{'sourceAnchorMs':1000,'referenceAnchorMs':1000}],30000)['reason']=='insufficient_points'

def test_different_cut_rejected_by_residual_or_inlier_policy():
    ev=[]
    for s,r in [(1000,1000),(6000,6000),(11000,16000),(16000,21000),(21000,31000),(26000,36000)]:
      ev.append({'sourceAnchorMs':s,'referenceAnchorMs':r})
    result=robust_accept(ev,30000,max_residual_ms=300); assert not result['accepted']

def test_offset_only_selected_for_boundary_bias():
    ev=[]
    for s,r in [(1000,600),(6000,5800),(11000,11300),(16000,15800),(21000,20500)]:ev.append({'sourceAnchorMs':s,'referenceAnchorMs':r})
    result=robust_accept(ev,22000,min_points=4,min_coverage=.5); assert result['selectedModel']=='offset-only'; assert result['scale']==1.0
