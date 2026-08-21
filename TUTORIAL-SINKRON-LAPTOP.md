# Tutorial sinkron IndoSync di laptop

Nama add-on tetap **IndoSync Local**. Subtitle tetap dari OpenSubtitles. Sinkron GPU hanya jalan jika laptop + Docker + poller hidup.

## 1. Prasyarat

- Docker Desktop nyala
- Image `indosync-asr-worker:feasibility` sudah ada
- Node.js 20+
- GPU NVIDIA (RTX 3080 sudah teruji)
- Project: `C:\Users\daffa\Downloads\project ai`

## 2. Set environment (PowerShell, folder project)

Jangan commit nilai secret. Isi dari Vercel / `.env.production.local`.

```powershell
cd "C:\Users\daffa\Downloads\project ai"

$env:OPENSUBTITLES_API_KEY = '<isi>'
$env:OPENSUBTITLES_USER_AGENT = 'IndoSync/0.1.0'
$env:KV_REST_API_URL = 'https://<host>.upstash.io'
$env:KV_REST_API_TOKEN = '<isi>'

$env:INDOSYNC_CALIBRATED_SYNCHRONIZATION = 'true'
$env:INDOSYNC_CALIBRATED_TARGET = 'staging'
$env:INDOSYNC_RUNTIME_ENV = 'staging'
$env:INDOSYNC_SYNCHRONIZATION_NAMESPACE = 'indosync-sync-staging-smoke-da1'
$env:INDOSYNC_REDIS_CREDENTIAL_ENV = 'staging'
$env:INDOSYNC_EVIDENCE_ENGINE_COMMAND = 'docker'
$env:INDOSYNC_EVIDENCE_ENGINE_ARGS = '["run","--rm","-i","--gpus","all","--entrypoint","python","-v","C:\\Users\\daffa\\Downloads\\project ai\\worker:/engine:ro","-v","C:\\Users\\daffa\\Downloads\\project ai\\benchmark-output\\engine-jobs:/job","indosync-asr-worker:feasibility","/engine/evidence_engine_process.py"]'
$env:INDOSYNC_ALLOWED_MEDIA_HOSTS = '<host-video-yang-diizinkan>'
```

`INDOSYNC_ALLOWED_MEDIA_HOSTS` wajib host HTTP(S) publik. Magnet dan IP privat ditolak.

## 3. Jalankan poller

```powershell
cd "C:\Users\daffa\Downloads\project ai"
npm run worker
```

Sukses jika muncul:

```text
{"event":"poller_started","environment":"staging","namespace":"indosync-sync-staging-smoke-da1"}
```

Biarkan jendela ini terbuka. `Ctrl+C` untuk berhenti.

Laptop harus **nyala**, **Docker Desktop nyala**, dan **`npm run worker` jalan**. Sleep/hibernate mematikan sinkron.

## 4. Pakai di Stremio

1. Install add-on: `https://indo-subt.vercel.app/manifest.json`
2. Pilih film, lalu pilih **source** (baru ada `videoUrl`)
3. Tunggu ~30 detik jika ingin auto-sync di pemutaran pertama
4. Pilih varian IndoSync Local, atau `-2s` / `+2s` jika timing masih bergeser

Jika poller mati, subtitle OpenSubtitles tetap muncul (versi asli).

## 5. Cek cepat

```powershell
cd "C:\Users\daffa\Downloads\project ai"
npm test
npm run typecheck
```
