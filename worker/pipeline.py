"""Turns a YouTube clip into a speech-free video (music and sound effects kept)
plus a timed, speaker-labelled script.

Steps: download (yt-dlp) -> separate speech (Demucs) -> transcribe the speech
stem (faster-whisper) -> split speakers (sherpa-onnx) -> build script lines.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path
from typing import Callable

REPO = Path(__file__).resolve().parent.parent
MODELS = Path(os.environ.get("COUNTEROKE_MODELS", REPO / "models"))
os.environ.setdefault("TORCH_HOME", str(MODELS / "torch"))
os.environ.setdefault("HF_HOME", str(MODELS / "huggingface"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")  # the xet downloader can stall on big model files

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")

Progress = Callable[[str, float], None]

SEGMENTATION_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
)
EMBEDDING_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx"
)


class StageError(RuntimeError):
    def __init__(self, stage: str, message: str):
        super().__init__(message)
        self.stage = stage


def _run(stage: str, args: list[str]) -> str:
    proc = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or proc.stdout).strip().splitlines()[-6:])
        raise StageError(stage, tail or f"{args[0]} çıkış kodu {proc.returncode}")
    return proc.stdout


def _threads() -> int | None:
    n = int(os.environ.get("WORKER_THREADS", "0") or 0)
    return n if n > 0 else None


# ----------------------------------------------------------------------------- device

_device: str | None = None


def device() -> str:
    global _device
    if _device is None:
        forced = os.environ.get("WORKER_DEVICE")
        if forced:
            _device = forced
        else:
            import torch

            _device = "cuda" if torch.cuda.is_available() else "cpu"
        if _device == "cpu" and _threads():
            import torch

            torch.set_num_threads(_threads())
    return _device


# ----------------------------------------------------------------------------- download

def download(job: dict, work: Path) -> Path:
    args = [
        sys.executable, "-m", "yt_dlp",
        "--no-playlist", "--no-progress", "--no-warnings",
        "-f", "bv*[height<=480][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=480]+ba/b[height<=480]/b",
        "--merge-output-format", "mp4",
        "--download-sections", f"*{float(job['start']):.2f}-{float(job['end']):.2f}",
        "--force-keyframes-at-cuts",
        "-o", str(work / "source.%(ext)s"),
    ]
    # yt-dlp needs a JavaScript runtime for YouTube; deno is used automatically, node must be enabled.
    if not shutil.which("deno") and shutil.which("node"):
        args += ["--js-runtimes", "node"]
    if os.path.sep in FFMPEG:
        args += ["--ffmpeg-location", str(Path(FFMPEG).parent)]
    args.append(job["url"])
    _run("download", args)
    found = sorted(p for p in work.glob("source.*") if p.suffix not in (".part", ".ytdl"))
    if not found:
        raise StageError("download", "yt-dlp dosya üretmedi")
    return found[0]


def probe(path: Path) -> dict:
    out = _run("probe", [FFPROBE, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)])
    return json.loads(out)


# ----------------------------------------------------------------------------- separation

_demucs = None


def _demucs_model():
    global _demucs
    if _demucs is None:
        from demucs.pretrained import get_model

        model = get_model(os.environ.get("DEMUCS_MODEL", "htdemucs"))
        model.eval()
        _demucs = model
    return _demucs


def separate(mix_wav: Path, work: Path) -> tuple[Path, Path]:
    """Returns (speech.wav, music_and_effects.wav)."""
    import numpy as np
    import soundfile as sf
    import torch
    from demucs.apply import apply_model

    model = _demucs_model()
    wav, sr = sf.read(str(mix_wav), dtype="float32", always_2d=True)
    if sr != model.samplerate:
        raise StageError("separate", f"beklenmeyen örnekleme hızı {sr}")
    mix = torch.from_numpy(np.ascontiguousarray(wav.T))
    ref = mix.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        sources = apply_model(
            model, ((mix - mean) / std)[None], device=device(),
            shifts=1, split=True, overlap=0.25, progress=False,
        )[0]
    sources = sources * std + mean
    vi = model.sources.index("vocals")
    vocals = sources[vi]
    music = sum(sources[i] for i in range(len(model.sources)) if i != vi)
    speech_path, music_path = work / "speech.wav", work / "music.wav"
    sf.write(str(speech_path), vocals.T.cpu().numpy(), sr)
    sf.write(str(music_path), np.clip(music.T.cpu().numpy(), -1.0, 1.0), sr)
    return speech_path, music_path


# ----------------------------------------------------------------------------- transcription

_whisper = None


def _whisper_model(force_cpu: bool = False):
    global _whisper
    if _whisper is not None and not force_cpu:
        return _whisper
    import torch  # loads CUDA/cuDNN DLLs that CTranslate2 reuses on Windows

    lib = Path(torch.__file__).parent / "lib"
    if os.name == "nt" and lib.exists():
        os.add_dll_directory(str(lib))
    from faster_whisper import WhisperModel

    on_gpu = device() == "cuda" and not force_cpu
    name = os.environ.get("WHISPER_MODEL") or ("large-v3-turbo" if on_gpu else "small")
    _whisper = WhisperModel(
        name,
        device="cuda" if on_gpu else "cpu",
        compute_type="float16" if on_gpu else "int8",
        cpu_threads=_threads() or 0,
        download_root=str(MODELS / "whisper"),
    )
    return _whisper


def load_16k(speech_wav: Path, work: Path):
    """Mono 16 kHz float32 samples, decoded by ffmpeg (avoids PyAV version issues)."""
    import soundfile as sf

    wav16 = work / "speech16k.wav"
    _run("transcribe", [FFMPEG, "-y", "-v", "error", "-i", str(speech_wav), "-ac", "1", "-ar", "16000", str(wav16)])
    audio, _sr = sf.read(str(wav16), dtype="float32")
    return audio


def transcribe(audio16k, lang: str | None) -> list[dict]:
    def go(model) -> list[dict]:
        segments, _info = model.transcribe(
            audio16k, language=lang or None, word_timestamps=True, vad_filter=True,
            beam_size=5, condition_on_previous_text=False,
        )
        words = []
        for si, seg in enumerate(segments):
            for w in seg.words or []:
                text = w.word.strip()
                if text:
                    words.append({"w": text, "s": float(w.start), "e": float(w.end), "seg": si})
        return words

    try:
        return go(_whisper_model())
    except Exception as e:  # GPU runtime problems (missing cuDNN etc.): fall back to the CPU
        if device() != "cuda":
            raise
        print(f"[worker] Whisper GPU'da çalışmadı, CPU'ya geçiliyor: {e}", file=sys.stderr)
        return go(_whisper_model(force_cpu=True))


# ----------------------------------------------------------------------------- diarization

def _fetch(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    tmp.replace(dest)


def diarization_models() -> tuple[Path, Path]:
    root = MODELS / "diarization"
    seg = root / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
    if not seg.exists():
        archive = root / "segmentation.tar.bz2"
        _fetch(SEGMENTATION_URL, archive)
        with tarfile.open(archive, "r:bz2") as t:
            t.extractall(root, filter="data")
        archive.unlink()
    emb = root / EMBEDDING_URL.rsplit("/", 1)[1]
    if not emb.exists():
        _fetch(EMBEDDING_URL, emb)
    return seg, emb


def diarize(audio16k, speakers: int) -> list[tuple[float, float, int]]:
    import sherpa_onnx

    seg_model, emb_model = diarization_models()
    audio = audio16k
    n = _threads() or 2
    cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(seg_model)),
            num_threads=n,
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(emb_model), num_threads=n),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=speakers),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not cfg.validate():
        raise StageError("diarize", "konuşmacı ayırma ayarları geçersiz")
    sd = sherpa_onnx.OfflineSpeakerDiarization(cfg)
    result = sd.process(audio).sort_by_start_time()
    return [(float(r.start), float(r.end), int(r.speaker)) for r in result]


# ----------------------------------------------------------------------------- script

def smooth_labels(words: list[dict], labels: list[int], min_words: int = 3, min_seconds: float = 1.0) -> list[int]:
    """Speaker diarization flickers on single words. Inside one transcribed sentence, a speaker
    run shorter than `min_words` words and `min_seconds` seconds is given to its neighbour."""
    labels = list(labels)
    while True:
        runs: list[tuple[int, int]] = []
        i = 0
        while i < len(words):
            j = i
            while j < len(words) and labels[j] == labels[i] and words[j]["seg"] == words[i]["seg"]:
                j += 1
            runs.append((i, j))
            i = j
        # candidates: short runs that share a sentence with a neighbouring run; shortest goes first
        best: tuple[int, int, tuple[int, int]] | None = None
        for k, (a, b) in enumerate(runs):
            if b - a >= min_words or words[b - 1]["e"] - words[a]["s"] >= min_seconds:
                continue
            seg = words[a]["seg"]
            prev = runs[k - 1] if k > 0 and words[runs[k - 1][0]]["seg"] == seg else None
            nxt = runs[k + 1] if k + 1 < len(runs) and words[runs[k + 1][0]]["seg"] == seg else None
            options = [r for r in (prev, nxt) if r]
            if not options:
                continue
            target = max(options, key=lambda r: r[1] - r[0])  # the longer neighbour wins
            if best is None or b - a < best[1] - best[0]:
                best = (a, b, target)
        if best is None:
            return labels
        a, b, target = best
        for x in range(a, b):
            labels[x] = labels[target[0]]


def build_lines(words: list[dict], diar: list[tuple[float, float, int]], speakers: int) -> list[dict]:
    def speaker_of(s: float, e: float) -> int:
        if not diar:
            return 0
        best, best_overlap = None, 0.0
        for ds, de, spk in diar:
            overlap = min(e, de) - max(s, ds)
            if overlap > best_overlap:
                best, best_overlap = spk, overlap
        if best is not None:
            return best
        mid = (s + e) / 2
        return min(diar, key=lambda d: min(abs(mid - d[0]), abs(mid - d[1])))[2]

    labels = smooth_labels(words, [speaker_of(w["s"], w["e"]) for w in words])
    lines: list[dict] = []
    cur: dict | None = None
    for w, spk in zip(words, labels):
        if cur is not None:
            last = cur["words"][-1]
            long_line = cur["words"][-1]["e"] - cur["start"] > 5 and last["w"][-1:] in ".?!…"
            if (
                spk != cur["raw"]
                or w["seg"] != cur["seg"]
                or w["s"] - last["e"] > 1.0
                or long_line
                or len(cur["words"]) >= 18
            ):
                lines.append(cur)
                cur = None
        if cur is None:
            cur = {"raw": spk, "seg": w["seg"], "start": w["s"], "words": []}
        cur["words"].append({"w": w["w"], "s": round(w["s"], 2), "e": round(w["e"], 2)})
    if cur is not None:
        lines.append(cur)

    # Speaker labels in order of first appearance: the first voice heard is "Karakter 1".
    order: dict[int, int] = {}
    for line in lines:
        if line["raw"] not in order:
            order[line["raw"]] = len(order)
    out = []
    for line in lines:
        out.append({
            "start": round(line["start"], 2),
            "end": round(line["words"][-1]["e"], 2),
            "speaker": order[line["raw"]] % max(1, speakers),
            "text": " ".join(x["w"] for x in line["words"]),
            "words": line["words"],
        })
    return out


# ----------------------------------------------------------------------------- whole job

def process(job: dict, work: Path, progress: Progress) -> tuple[Path, dict, dict]:
    """Runs every step. Returns (clip.mp4, script, seconds spent per step)."""
    timings: dict[str, float] = {}

    def step(name: str, at: float):
        progress(name, at)
        timings[name] = time.perf_counter()

    def done(name: str):
        timings[name] = round(time.perf_counter() - timings[name], 1)

    speakers = max(1, int(job.get("speakers", 1)))
    lang = job.get("lang") or None

    step("download", 0.02)
    source = download(job, work)
    mix = work / "mix.wav"
    _run("download", [FFMPEG, "-y", "-v", "error", "-i", str(source), "-vn", "-ac", "2", "-ar", "44100", str(mix)])
    done("download")

    step("separate", 0.2)
    try:
        speech, music = separate(mix, work)
    except StageError:
        raise
    except Exception as e:
        raise StageError("separate", str(e)) from e
    done("separate")

    step("transcribe", 0.55)
    audio16k = load_16k(speech, work)
    try:
        words = transcribe(audio16k, lang)
    except Exception as e:
        raise StageError("transcribe", str(e)) from e
    done("transcribe")

    step("diarize", 0.8)
    diar: list[tuple[float, float, int]] = []
    if speakers > 1 and words:
        try:
            diar = diarize(audio16k, speakers)
        except Exception as e:  # players can still fix speakers by hand
            print(f"[worker] konuşmacı ayırma başarısız, herkes Karakter 1: {e}", file=sys.stderr)
    done("diarize")

    step("finalize", 0.9)
    info = probe(source)
    video = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    if video is None:
        raise StageError("finalize", "videoda görüntü yok")
    if video.get("codec_name") == "h264" and int(video.get("height") or 0) <= 720:
        vargs = ["-c:v", "copy"]
    else:
        vargs = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
                 "-vf", "scale=-2:'min(480,ih)'"]
    clip = work / "clip.mp4"
    _run("finalize", [
        FFMPEG, "-y", "-v", "error", "-i", str(source), "-i", str(music),
        "-map", "0:v:0", "-map", "1:a:0", *vargs,
        "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", str(clip),
    ])
    duration = float(probe(clip).get("format", {}).get("duration") or 0)
    script = {
        "language": lang or "",
        "duration": round(duration, 2),
        "characters": [{"id": i, "name": f"Karakter {i + 1}"} for i in range(speakers)],
        "lines": build_lines(words, diar, speakers),
    }
    done("finalize")
    timings["device"] = device()  # type: ignore[assignment]
    return clip, script, timings
