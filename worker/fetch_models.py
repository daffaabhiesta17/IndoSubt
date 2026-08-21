from huggingface_hub import snapshot_download

WHISPER_REPO = "Systran/faster-whisper-large-v3"
WHISPER_REVISION = "edaa852ec7e145841d8ffdb056a99866b5f0a478"
LABSE_REPO = "sentence-transformers/LaBSE"
LABSE_REVISION = "836121a0533e5664b21c7aacc5d22951f2b8b25b"

snapshot_download(
    repo_id=WHISPER_REPO,
    revision=WHISPER_REVISION,
    local_dir="/opt/models/faster-whisper-large-v3",
    max_workers=1,
)

snapshot_download(
    repo_id=LABSE_REPO,
    revision=LABSE_REVISION,
    local_dir="/opt/models/labse",
    max_workers=1,
    allow_patterns=[
        "config.json",
        "config_sentence_transformers.json",
        "modules.json",
        "sentence_bert_config.json",
        "special_tokens_map.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "vocab.txt",
        "model.safetensors",
        "1_Pooling/config.json",
        "2_Dense/config.json",
        "2_Dense/model.safetensors",
    ],
)
