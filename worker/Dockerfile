FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04@sha256:ac55d124da4882b497f732d8dfd9a702d5447a5f29d08d56da6f64f0a1eb34bc

ARG DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HUB_DOWNLOAD_TIMEOUT=600 \
    HF_HUB_ETAG_TIMEOUT=60 \
    TRANSFORMERS_OFFLINE=1 \
    HF_HUB_OFFLINE=1 \
    TOKENIZERS_PARALLELISM=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates ffmpeg python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

COPY requirements.txt /tmp/requirements.txt
RUN pip install --upgrade pip==26.2.1 \
    && pip install --extra-index-url https://download.pytorch.org/whl/cu128 \
       -r /tmp/requirements.txt

COPY fetch_models.py /tmp/fetch_models.py
RUN mkdir -p /opt/models \
    && HF_HUB_OFFLINE=0 TRANSFORMERS_OFFLINE=0 python /tmp/fetch_models.py \
    && find /opt/models -type f -exec sha256sum {} + | sort -k2 > /opt/models/SHA256SUMS \
    && rm -rf /root/.cache/huggingface /tmp/fetch_models.py /tmp/requirements.txt

RUN groupadd --gid 10001 worker \
    && useradd --uid 10001 --gid worker --create-home --shell /usr/sbin/nologin worker \
    && chown -R worker:worker /opt/models

WORKDIR /worker
COPY smoke.py /worker/smoke.py
USER 10001:10001

ENTRYPOINT ["python", "/worker/smoke.py"]

