"""counteroke processing worker.

Serve mode (default) polls the game server for jobs:
    python worker.py --server http://localhost:3100 --token <WORKER_TOKEN>

Test mode processes one clip locally and prints how long each step took:
    python worker.py test "https://youtu.be/..." --start 10 --end 40 --lang en --speakers 2
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path

import requests

import pipeline

HINTS = {
    "Sign in to confirm": "YouTube bu bağlantıdan bot kontrolü istedi; biraz sonra tekrar dene ya da başka video seç.",
    "Video unavailable": "Video kaldırılmış ya da erişilemiyor.",
    "playlist does not exist": "Böyle bir oynatma listesi yok ya da gizli.",
    "The playlist does not exist": "Böyle bir oynatma listesi yok ya da gizli.",
    "Private video": "Video gizli.",
    "age": "Video yaş kısıtlamalı, indirilemiyor.",
}


def friendly(e: Exception) -> str:
    stage = getattr(e, "stage", "")
    text = str(e).strip() or e.__class__.__name__
    for needle, hint in HINTS.items():
        if needle in text:
            return hint
    prefix = {
        "download": "İndirme hatası",
        "separate": "Ses ayırma hatası",
        "transcribe": "Yazıya çevirme hatası",
        "diarize": "Konuşmacı ayırma hatası",
        "finalize": "Video hazırlama hatası",
        "playlist": "Liste okunamadı",
    }.get(stage, "Hata")
    return f"{prefix}: {text[-400:]}"


class Cancelled(Exception):
    """The server dropped the job (e.g. a different video won the vote)."""


GONE = 410  # the server's answer for a job it no longer wants


def handle(session: requests.Session, server: str, job: dict) -> None:
    base = f"{server}/api/worker/jobs/{job['id']}"
    last = {"stage": None, "t": 0.0}

    def progress(stage: str, value: float) -> None:
        now = time.time()
        if stage == last["stage"] and now - last["t"] < 1.0:
            return
        last.update(stage=stage, t=now)
        try:
            r = session.post(f"{base}/progress", json={"stage": stage, "progress": value}, timeout=10)
        except requests.RequestException:
            return
        if r.status_code == GONE:
            raise Cancelled()

    print(f"[worker] iş alındı: {job['url']} {job['start']}-{job['end']} sn, {job['speakers']} kişi, {job['lang']}")
    work = Path(tempfile.mkdtemp(prefix=f"counteroke-{job['id'][:8]}-"))
    try:
        clip, script, timings = pipeline.process(job, work, progress)
        progress("upload", 0.97)
        with open(clip, "rb") as f:
            r = session.put(f"{base}/clip", data=f, headers={"content-type": "video/mp4"}, timeout=900)
        if r.status_code == GONE:
            raise Cancelled()
        r.raise_for_status()
        r = session.post(f"{base}/done", json={"script": script}, timeout=60)
        if r.status_code == GONE:
            raise Cancelled()
        r.raise_for_status()
        print(f"[worker] bitti: {len(script['lines'])} replik, süreler {timings}")
    except Cancelled:
        print("[worker] iş iptal edildi (başka video seçildi)")
    except Exception as e:
        traceback.print_exc()
        try:
            session.post(f"{base}/fail", json={"error": friendly(e)}, timeout=10)
        except requests.RequestException:
            pass
    finally:
        shutil.rmtree(work, ignore_errors=True)


def handle_playlist(session: requests.Session, server: str, task: dict) -> None:
    print(f"[worker] öneri listesi okunuyor: {task['url']}")
    try:
        body = pipeline.list_playlist(task["url"])
        print(f"[worker] listede {len(body['items'])} video bulundu")
    except Exception as e:
        traceback.print_exc()
        body = {"error": friendly(e)}
    try:
        session.post(f"{server}/api/worker/playlist/{task['id']}", json=body, timeout=30).raise_for_status()
    except requests.RequestException as e:
        print(f"[worker] liste sunucuya gönderilemedi: {e}")


def _warmup() -> None:
    try:
        pipeline.warmup()
    except Exception as e:  # the first job will try again and report a proper error
        print(f"[worker] modeller önceden yüklenemedi: {e}")


def clean_temp(max_age_hours: float = 6) -> None:
    """Removes working folders left behind by jobs that were cut off (crash, closed window)."""
    cutoff = time.time() - max_age_hours * 3600
    removed = 0
    for p in Path(tempfile.gettempdir()).glob("counteroke-*"):
        try:
            if p.is_dir() and p.stat().st_mtime < cutoff:
                shutil.rmtree(p, ignore_errors=True)
                removed += 1
        except OSError:
            pass
    if removed:
        print(f"[worker] yarım kalmış işlerden {removed} geçici klasör silindi")


def serve(args: argparse.Namespace) -> None:
    clean_temp()
    server = args.server.rstrip("/")
    fast = args.fast if args.fast is not None else pipeline.device() == "cuda"
    session = requests.Session()
    session.headers["x-worker-token"] = args.token
    print(f"[worker] '{args.name}' {server} adresine bağlanıyor (cihaz: {pipeline.device()}, hızlı: {fast})")
    threading.Thread(target=_warmup, daemon=True).start()
    warned = False
    while True:
        asked = time.time()
        try:
            # the server holds the request until there is work (up to `wait` seconds)
            params = {"name": args.name, "fast": "1" if fast else "0", "caps": "playlist", "wait": "25"}
            r = session.get(f"{server}/api/worker/next", params=params, timeout=45)
        except requests.RequestException as e:
            if not warned:
                print(f"[worker] sunucuya ulaşılamıyor, tekrar denenecek: {e}")
                warned = True
            time.sleep(5)
            continue
        if warned:
            print("[worker] sunucuya bağlandı")
            warned = False
        if r.status_code == 204:
            if time.time() - asked < 1:  # server answered at once (no long polling): don't hammer it
                time.sleep(args.poll)
            continue
        if r.status_code == 401:
            sys.exit("[worker] WORKER_TOKEN sunucudakiyle aynı değil")
        if not r.ok:
            print(f"[worker] sunucu hatası {r.status_code}: {r.text[:200]}")
            time.sleep(5)
            continue
        task = r.json()
        if task.get("kind") == "playlist":
            handle_playlist(session, server, task)
        else:
            handle(session, server, task)


def test(args: argparse.Namespace) -> None:
    job = {"id": "test", "url": args.url, "start": args.start, "end": args.end, "lang": args.lang, "speakers": args.speakers}
    out = Path(args.out or (pipeline.REPO / "data" / "test-output"))
    out.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="counteroke-test-"))
    t0 = time.perf_counter()
    try:
        clip, script, timings = pipeline.process(job, work, lambda stage, p: print(f"  -> {stage} ({p:.0%})"))
        shutil.copy(clip, out / "clip.mp4")
        for name in ("speech.wav", "music.wav"):
            if (work / name).exists():
                shutil.copy(work / name, out / name)
        (out / "script.json").write_text(json.dumps(script, ensure_ascii=False, indent=2), encoding="utf-8")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    total = time.perf_counter() - t0
    print(f"\nKlip süresi: {script['duration']} sn, toplam işlem: {total:.1f} sn, cihaz: {timings.pop('device')}")
    for k, v in timings.items():
        print(f"  {k:<11} {v} sn")
    print(f"\n{len(script['lines'])} replik:")
    for line in script["lines"]:
        print(f"  [{line['start']:6.2f}-{line['end']:6.2f}] K{line['speaker'] + 1}: {line['text']}")
    print(f"\nÇıktılar: {out}")


def main() -> None:
    for stream in (sys.stdout, sys.stderr):  # Turkish characters on the Windows console
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    p = argparse.ArgumentParser(description="counteroke ses işleme worker'ı")
    sub = p.add_subparsers(dest="cmd")
    p.add_argument("--server", default=os.environ.get("COUNTEROKE_SERVER", "http://localhost:3100"))
    p.add_argument("--token", default=os.environ.get("WORKER_TOKEN", "counteroke-dev"))
    p.add_argument("--name", default=os.environ.get("WORKER_NAME", platform.node() or "worker"))
    p.add_argument("--poll", type=float, default=2.0)
    speed = p.add_mutually_exclusive_group()
    speed.add_argument("--fast", dest="fast", action="store_true", default=None,
                       help="bu makineye öncelik ver (GPU varsa otomatik)")
    speed.add_argument("--slow", dest="fast", action="store_false",
                       help="hızlı bir worker bağlıysa işleri ona bırak (telefon için)")

    t = sub.add_parser("test", help="tek bir klibi işle ve süreleri göster")
    t.add_argument("url")
    t.add_argument("--start", type=float, default=0)
    t.add_argument("--end", type=float, default=30)
    t.add_argument("--lang", choices=["tr", "en"], default="tr")
    t.add_argument("--speakers", type=int, default=2)
    t.add_argument("--out")

    args = p.parse_args()
    if args.cmd == "test":
        test(args)
    else:
        serve(args)


if __name__ == "__main__":
    main()
