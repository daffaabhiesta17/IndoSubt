import importlib.metadata
import json
import os
import platform
import resource
import subprocess
import time

import ctranslate2
import torch
from faster_whisper import WhisperModel
from sentence_transformers import SentenceTransformer
from silero_vad import load_silero_vad

WHISPER_PATH = "/opt/models/faster-whisper-large-v3"
LABSE_PATH = "/opt/models/labse"
WHISPER_REVISION = "edaa852ec7e145841d8ffdb056a99866b5f0a478"
LABSE_REVISION = "836121a0533e5664b21c7aacc5d22951f2b8b25b"


def command_version(command: str) -> str:
    result = subprocess.run(
        [command, "-version"], check=True, capture_output=True, text=True
    )
    return result.stdout.splitlines()[0]


def gpu_memory_mib() -> int:
    result = subprocess.run(
        [
            "nvidia-smi",
            "--query-compute-apps=used_memory",
            "--format=csv,noheader,nounits",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    values = [int(line.strip()) for line in result.stdout.splitlines() if line.strip()]
    return sum(values)


def package_version(name: str) -> str:
    return importlib.metadata.version(name)


def timed_load(name: str, loader):
    before_gpu = gpu_memory_mib()
    before = time.perf_counter()
    value = loader()
    elapsed = time.perf_counter() - before
    after_gpu = gpu_memory_mib()
    return value, {
        "component": name,
        "load_seconds": round(elapsed, 3),
        "gpu_memory_before_mib": before_gpu,
        "gpu_memory_after_mib": after_gpu,
    }


def main() -> None:
    if os.geteuid() == 0:
        raise RuntimeError("Smoke test must run as the non-root worker user.")
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not visible to PyTorch.")
    if ctranslate2.get_cuda_device_count() < 1:
        raise RuntimeError("CUDA is not visible to CTranslate2.")

    loads = []
    vad_model, metric = timed_load("silero-vad", load_silero_vad)
    loads.append(metric)
    whisper_model, metric = timed_load(
        "faster-whisper-large-v3",
        lambda: WhisperModel(WHISPER_PATH, device="cuda", compute_type="float16"),
    )
    loads.append(metric)
    labse_model, metric = timed_load(
        "labse",
        lambda: SentenceTransformer(LABSE_PATH, device="cpu", local_files_only=True),
    )
    loads.append(metric)

    embedding = labse_model.encode(
        ["Ini adalah uji embedding lokal."],
        normalize_embeddings=True,
        convert_to_numpy=True,
    )

    # Keep strong references alive through final measurements.
    assert vad_model is not None and whisper_model is not None
    output = {
        "status": "PASS",
        "user": {"uid": os.geteuid(), "gid": os.getegid()},
        "python": platform.python_version(),
        "packages": {
            name: package_version(name)
            for name in [
                "faster-whisper",
                "ctranslate2",
                "silero-vad",
                "sentence-transformers",
                "torch",
                "transformers",
            ]
        },
        "cuda": {
            "torch_runtime": torch.version.cuda,
            "cudnn": torch.backends.cudnn.version(),
            "torch_device": torch.cuda.get_device_name(0),
            "ctranslate2_devices": ctranslate2.get_cuda_device_count(),
        },
        "ffmpeg": command_version("ffmpeg"),
        "ffprobe": command_version("ffprobe"),
        "models": {
            "faster_whisper_revision": WHISPER_REVISION,
            "labse_revision": LABSE_REVISION,
        },
        "loads": loads,
        "final_gpu_memory_mib": gpu_memory_mib(),
        "peak_process_ram_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        "labse_embedding": {
            "shape": list(embedding.shape),
            "finite": bool(torch.isfinite(torch.from_numpy(embedding)).all()),
            "l2_norm": round(float((embedding[0] ** 2).sum() ** 0.5), 6),
        },
        "media_processed": False,
    }
    print(json.dumps(output, sort_keys=True))


if __name__ == "__main__":
    main()
