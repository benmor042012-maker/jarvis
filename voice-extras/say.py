#!/usr/bin/env python3
"""A human-sounding voice for JARVIS, using Microsoft's free neural voices.

Read this before wiring it in
-----------------------------
`edge-tts` is free of charge, needs no account and no API key. It is **not**
local: the text to be spoken is sent to Microsoft's Edge Read-Aloud service and
the audio comes back from there. It needs an internet connection, and it is an
undocumented endpoint that Microsoft can change without notice. Everything else
in JARVIS runs on this computer; this one does not. That is the whole trade —
much better voices, in exchange for the text of the reply leaving the machine.
Which is why nothing here is switched on by default and nothing else in the
project imports this file.

Speaking starts before the sentence is finished
-----------------------------------------------
The slow part of answering out loud is not synthesis, it is waiting for the
whole reply to be written. `speak_stream` takes text as it arrives, cuts it at
the first sentence end (or after `first_chunk_chars` characters), and starts
speaking that while the rest is still being written. Audio for sentence two is
fetched while sentence one is playing, so there is no gap between them.

Usage
-----
  python say.py "שלום, אני ג'רביס"          speak once
  python say.py --stdin                     speak text as it arrives on stdin
  python say.py --out reply.mp3 "hello"     write a file instead of playing
  python say.py --serve                     stay warm, listen on 127.0.0.1
  python say.py --list-voices he            the Hebrew voices on offer
  python say.py --self-test                 check the pieces without speaking
"""

from __future__ import annotations

import argparse
import array
import asyncio
import json
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import AsyncIterator, Iterable

sys.path.insert(0, str(Path(__file__).resolve().parent))

import jarvis_link as link  # noqa: E402

SAMPLE_RATE = 24000  # what the Edge service returns
CHANNELS = 1

MISSING_EDGE = (
    "edge-tts is not installed in this interpreter.\n"
    "  Windows:  double-click voice-extras\\INSTALL-EXTRAS.bat\n"
    "  Anywhere: python -m pip install -r voice-extras/requirements.txt"
)

# Sentence ends, for Latin and Hebrew text alike. A number like "3.5" is not a
# sentence end, so a full stop only counts when something non-digit follows.
_SENTENCE_END = re.compile(r"(?<=[.!?…:;׃])\s|(?<=[.!?…])$|\n")


def split_sentences(text: str) -> tuple[list[str], str]:
    """(complete sentences, the unfinished remainder)."""
    out: list[str] = []
    rest = text
    while True:
        match = _SENTENCE_END.search(rest)
        if not match:
            break
        cut = match.end()
        piece = rest[:cut].strip()
        if piece:
            out.append(piece)
        rest = rest[cut:]
    return out, rest


class Chunker:
    """Turns a trickle of text into speakable pieces, as early as is sensible.

    The first piece is cut early — at the first sentence end, or once
    `first_chars` characters have arrived — because the first piece is the one
    the person is waiting for. Later pieces wait for a real sentence end, which
    sounds better and costs nothing, since the voice is still busy.
    """

    def __init__(self, first_chars: int = 60, later_chars: int = 400):
        self.first_chars = max(1, int(first_chars))
        self.later_chars = max(self.first_chars, int(later_chars))
        self.buffer = ""
        self.spoken_any = False

    def _limit(self) -> int:
        return self.later_chars if self.spoken_any else self.first_chars

    def feed(self, text: str) -> list[str]:
        self.buffer += text
        pieces, self.buffer = split_sentences(self.buffer)
        limit = self._limit()
        if not pieces and len(self.buffer) >= limit:
            # No sentence end in sight. Break on the last space at or near the
            # limit, so a word is never cut in half and the piece is not much
            # longer than it has to be.
            cut = self.buffer.rfind(" ", 0, limit + 20)
            if cut <= 0:
                cut = limit
            piece = self.buffer[:cut].strip()
            self.buffer = self.buffer[cut:]
            if piece:
                pieces = [piece]
        if pieces:
            self.spoken_any = True
        return pieces

    def flush(self) -> list[str]:
        rest = self.buffer.strip()
        self.buffer = ""
        if rest:
            self.spoken_any = True
            return [rest]
        return []


# --- synthesis -----------------------------------------------------------------


async def synth(text: str, voice: str, rate: str = "+0%", volume: str = "+0%", pitch: str = "+0Hz") -> AsyncIterator[bytes]:
    """MP3 chunks for one piece of text, as they arrive from the service."""
    try:
        import edge_tts
    except ImportError as exc:  # pragma: no cover - environment, not logic
        raise SystemExit(MISSING_EDGE) from exc
    communicate = edge_tts.Communicate(text, voice, rate=rate, volume=volume, pitch=pitch)
    try:
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                yield chunk["data"]
    except (GeneratorExit, asyncio.CancelledError):
        raise
    except Exception as exc:  # noqa: BLE001 - every failure here is "no voice", said plainly
        raise VoiceUnavailable(explain(exc)) from exc


class VoiceUnavailable(RuntimeError):
    """The Edge service could not be reached, or refused the request."""


def explain(exc: BaseException) -> str:
    """One sentence a person can act on, instead of a stack trace.

    The three ways this actually fails in practice are no internet, a proxy or
    firewall in the way (a company network, or a TLS-inspecting proxy whose
    certificate Python does not trust), and Microsoft changing or rate-limiting
    the endpoint. Each of those has a different answer, so each gets said.
    """
    name = type(exc).__name__
    text = str(exc)
    if "Certificate" in name or "CERTIFICATE_VERIFY_FAILED" in text:
        return (
            "The connection to Microsoft's voice service was refused by certificate checking, "
            "which usually means a proxy or antivirus is inspecting HTTPS on this network. "
            "The Edge voices cannot be used here; the local voice in Settings still works."
        )
    if "Connector" in name or "ClientConnection" in name or isinstance(exc, (OSError, TimeoutError)):
        return (
            "Could not reach Microsoft's voice service (speech.platform.bing.com). "
            "These voices need an internet connection - that is the trade-off for using them. "
            "Check the connection, or use the local voice in Settings."
        )
    if "403" in text or "401" in text or "429" in text:
        return f"Microsoft's voice service refused the request ({text.strip()[:120]}). It rate-limits, and it can change without notice."
    return f"Speaking failed: {name}: {text.strip()[:200]}"


async def list_voices(prefix: str = "") -> list[dict]:
    try:
        import edge_tts
    except ImportError as exc:  # pragma: no cover
        raise SystemExit(MISSING_EDGE) from exc
    voices = await edge_tts.list_voices()
    wanted = prefix.lower()
    return [v for v in voices if not wanted or str(v.get("ShortName", "")).lower().startswith(wanted)]


# --- playback -------------------------------------------------------------------


class Speaker:
    """Plays a continuous MP3 stream while it is still being fetched.

    Three stages, each on its own thread, so nothing ever blocks the audio
    callback: the fetcher pushes MP3 bytes in, a decoder thread turns them into
    PCM, and the sound device pulls PCM out. When the decoder falls behind the
    device is handed silence rather than a stall, which is the difference
    between a short gap and a click.
    """

    def __init__(self) -> None:
        self._mp3: queue.Queue[bytes | None] = queue.Queue()
        self._pcm: queue.Queue[array.array | None] = queue.Queue(maxsize=64)
        self._device = None
        self._decoder: threading.Thread | None = None
        self._finished = threading.Event()
        self._stop = threading.Event()
        self._started = False
        self._error: str | None = None

    # -- the MP3 side ----------------------------------------------------------
    def feed(self, data: bytes) -> None:
        if self._stop.is_set():
            return
        self._mp3.put(data)
        if not self._started:
            self._start()

    def done_feeding(self) -> None:
        self._mp3.put(None)

    def _read_mp3(self, num_bytes: int) -> bytes:
        out = bytearray()
        while len(out) < num_bytes:
            if self._stop.is_set():
                return bytes(out)
            try:
                item = self._mp3.get(timeout=10)
            except queue.Empty:
                break
            if item is None:
                self._mp3.put(None)  # leave the end marker for the next read
                break
            out.extend(item)
        return bytes(out)

    # -- the PCM side ----------------------------------------------------------
    def _start(self) -> None:
        try:
            import miniaudio
        except ImportError:
            self._error = "miniaudio"
            return
        self._started = True

        outer = self

        class Source(miniaudio.StreamableSource):  # type: ignore[misc]
            def read(self, num_bytes: int) -> bytes:
                return outer._read_mp3(num_bytes)

        def decode() -> None:
            try:
                stream = miniaudio.stream_any(
                    Source(),
                    source_format=miniaudio.FileFormat.MP3,
                    output_format=miniaudio.SampleFormat.SIGNED16,
                    nchannels=CHANNELS,
                    sample_rate=SAMPLE_RATE,
                    frames_to_read=2048,
                )
                for frames in stream:
                    if self._stop.is_set():
                        break
                    self._pcm.put(frames)
            except Exception as exc:  # noqa: BLE001 - surfaced to the caller
                self._error = str(exc)
            finally:
                self._pcm.put(None)

        self._decoder = threading.Thread(target=decode, name="tts-decode", daemon=True)
        self._decoder.start()

        device = miniaudio.PlaybackDevice(
            output_format=miniaudio.SampleFormat.SIGNED16,
            nchannels=CHANNELS,
            sample_rate=SAMPLE_RATE,
        )
        self._device = device
        device.start(self._playback())

    def _playback(self):
        required = yield array.array("h")
        pending = array.array("h")
        ended = False
        while not self._stop.is_set():
            while len(pending) < required and not ended:
                try:
                    frames = self._pcm.get(timeout=0.05)
                except queue.Empty:
                    break
                if frames is None:
                    ended = True
                    break
                pending.extend(frames)
            if ended and not pending:
                self._finished.set()
                return
            take = min(len(pending), required)
            out = pending[:take]
            del pending[:take]
            if take < required:
                out.extend(array.array("h", bytes(2 * (required - take))))  # silence, never a stall
            required = yield out
        self._finished.set()

    # -- lifecycle -------------------------------------------------------------
    def wait(self, timeout: float | None = None) -> bool:
        if not self._started:
            return False
        return self._finished.wait(timeout)

    def stop(self) -> None:
        self._stop.set()
        self._finished.set()
        if self._device is not None:
            try:
                self._device.stop()
                self._device.close()
            except Exception:  # noqa: BLE001 - closing a closed device is not news
                pass
            self._device = None

    @property
    def error(self) -> str | None:
        return self._error


def _have_miniaudio() -> bool:
    try:
        import miniaudio  # noqa: F401
    except ImportError:
        return False
    return True


def play_file(path: Path) -> bool:
    """Last resort when miniaudio is not installed: hand the file to the system."""
    if link.IS_WINDOWS:
        script = (
            "Add-Type -AssemblyName presentationCore;"
            "$p=New-Object System.Windows.Media.MediaPlayer;"
            f"$p.Open([uri]'{path}');"
            "Start-Sleep -Milliseconds 400;"
            "$p.Play();"
            "while($p.NaturalDuration.HasTimeSpan -eq $false){Start-Sleep -Milliseconds 100};"
            "Start-Sleep -Seconds ($p.NaturalDuration.TimeSpan.TotalSeconds);"
            "$p.Close();"
        )
        players: list[list[str]] = [["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script]]
    else:
        players = [["afplay", str(path)], ["mpv", "--no-video", str(path)], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", str(path)]]
    for cmd in players:
        try:
            return subprocess.run(cmd, check=False).returncode == 0  # noqa: S603 - fixed player names
        except FileNotFoundError:
            continue
    return False


# --- the two entry points --------------------------------------------------------


async def speak_stream(chunks: AsyncIterator[str] | Iterable[str], cfg: dict | None = None, voice: str | None = None, on_first_audio=None, on_speaker=None) -> dict:
    """Speak text as it arrives. Returns what happened, for the caller to log."""
    settings = (cfg or link.load_config()).get("tts", {})
    voice = voice or settings.get("voice") or "he-IL-AvriNeural"
    chunker = Chunker(first_chars=int(link.number(settings.get("first_chunk_chars"), 60)))
    started = time.monotonic()
    first_audio_at: float | None = None
    pieces_spoken = 0
    said: list[str] = []
    options = {
        "rate": str(settings.get("rate") or "+0%"),
        "volume": str(settings.get("volume") or "+0%"),
        "pitch": str(settings.get("pitch") or "+0Hz"),
    }

    # With miniaudio the whole reply is one continuous audio stream and
    # sentence two is fetched while sentence one plays. Without it, each
    # sentence is written to a file and handed to the system player, which
    # still starts speaking at the first sentence — it just cannot overlap.
    speaker: Speaker | None = Speaker() if _have_miniaudio() else None
    unplayable: str | None = None
    if on_speaker:
        on_speaker(speaker)

    async def say_piece(piece: str) -> None:
        nonlocal first_audio_at, pieces_spoken, unplayable
        buffered = bytearray()
        async for data in synth(piece, voice, **options):
            if first_audio_at is None:
                first_audio_at = time.monotonic() - started
                if on_first_audio:
                    on_first_audio(first_audio_at)
            if speaker is not None:
                speaker.feed(data)
            else:
                buffered.extend(data)
        if speaker is None and buffered:
            temp = Path(tempfile.gettempdir()) / f"jarvis-say-{int(time.time() * 1000)}.mp3"
            try:
                temp.write_bytes(bytes(buffered))
                if not await asyncio.get_running_loop().run_in_executor(None, play_file, temp):
                    unplayable = (
                        "No way to play audio here: miniaudio is not installed and no system player answered. "
                        "Install miniaudio (pip install miniaudio), or use --out to write a file."
                    )
            finally:
                temp.unlink(missing_ok=True)
        pieces_spoken += 1
        said.append(piece)

    try:
        if hasattr(chunks, "__aiter__"):
            async for text in chunks:  # type: ignore[union-attr]
                for piece in chunker.feed(text):
                    await say_piece(piece)
        else:
            for text in chunks:  # type: ignore[union-attr]
                for piece in chunker.feed(text):
                    await say_piece(piece)
        for piece in chunker.flush():
            await say_piece(piece)
    except VoiceUnavailable as exc:
        unplayable = str(exc)
    finally:
        if speaker is not None:
            speaker.done_feeding()

    if speaker is not None:
        speaker.wait(timeout=180)
        speaker.stop()
    return {
        "spoken": pieces_spoken > 0 and not unplayable,
        "pieces": pieces_spoken,
        "voice": voice,
        "first_audio_seconds": round(first_audio_at, 3) if first_audio_at is not None else None,
        "text": " ".join(said),
        "reason": unplayable or (speaker.error if speaker is not None else None),
    }


async def speak(text: str, cfg: dict | None = None, voice: str | None = None, on_speaker=None) -> dict:
    return await speak_stream([text], cfg=cfg, voice=voice, on_speaker=on_speaker)


async def to_file(text: str, out: Path, cfg: dict | None = None, voice: str | None = None) -> dict:
    settings = (cfg or link.load_config()).get("tts", {})
    voice = voice or settings.get("voice") or "he-IL-AvriNeural"
    written = 0
    partial = out.with_suffix(out.suffix + ".part")
    try:
        with partial.open("wb") as handle:
            async for data in synth(text, voice, rate=str(settings.get("rate") or "+0%"), volume=str(settings.get("volume") or "+0%"), pitch=str(settings.get("pitch") or "+0Hz")):
                handle.write(data)
                written += len(data)
        if written == 0:
            raise VoiceUnavailable("The service returned no audio for that text.")
        partial.replace(out)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    return {"spoken": False, "written": written, "path": str(out), "voice": voice}


# --- warm server ------------------------------------------------------------------


def serve(cfg: dict, port: int | None = None) -> int:
    """Stay running so the first word comes back fast.

    Starting Python, importing edge-tts and opening the socket costs the better
    part of a second every time. Doing it once and keeping it warm is the
    difference between answering in a second and answering in two. Bound to
    127.0.0.1 only.
    """
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    settings = cfg.get("tts", {})
    port = int(port or link.number(settings.get("serve_port"), 8771))
    logger = link.setup_logging("jarvis-say", cfg.get("log_level", "INFO"))
    loop = asyncio.new_event_loop()
    threading.Thread(target=loop.run_forever, name="tts-loop", daemon=True).start()
    current: dict[str, Speaker | None] = {"speaker": None}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):  # quiet: the logger below says what matters
            return

        def _json(self, status: int, body: dict) -> None:
            raw = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802 - the name the server requires
            if self.path == "/health":
                return self._json(200, {"ok": True, "service": "jarvis-say", "voice": settings.get("voice")})
            return self._json(404, {"error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("content-length") or 0)
            if length > 64 * 1024:
                return self._json(413, {"error": "too_long"})
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            except ValueError:
                return self._json(400, {"error": "malformed"})
            if self.path == "/stop":
                speaker = current.get("speaker")
                if speaker:
                    speaker.stop()
                return self._json(200, {"ok": True, "stopped": bool(speaker)})
            if self.path != "/say":
                return self._json(404, {"error": "not_found"})
            text = str(body.get("text") or "").strip()
            if not text:
                return self._json(400, {"error": "text is required"})
            previous = current.get("speaker")
            if previous:
                previous.stop()
            future = asyncio.run_coroutine_threadsafe(
                speak(text, cfg=cfg, voice=body.get("voice"), on_speaker=lambda sp: current.__setitem__("speaker", sp)),
                loop,
            )
            if body.get("wait") is False:
                return self._json(200, {"ok": True, "queued": True})
            try:
                result = future.result(timeout=180)
            except Exception as exc:  # noqa: BLE001 - the caller deserves the reason
                detail = explain(exc)
                logger.error("Speaking failed: %s", detail)
                return self._json(503, {"error": "voice_unavailable", "detail": detail})
            if not result.get("spoken"):
                # 200 with "spoken": false reads as success to anything that
                # only looks at the status code, and the caller would think the
                # reply had been said out loud when it had not.
                logger.error("Did not speak: %s", result.get("reason"))
                return self._json(503, {"error": "voice_unavailable", "detail": result.get("reason"), **result})
            logger.info("Spoke %d piece(s), first audio in %ss", result.get("pieces", 0), result.get("first_audio_seconds"))
            return self._json(200, {"ok": True, **result})

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    logger.info("Voice server ready on http://127.0.0.1:%d  (POST /say {\"text\": \"...\"})", port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Stopped.")
    finally:
        server.server_close()
    return 0


# --- checks --------------------------------------------------------------------


def self_test() -> int:
    """Everything that can be checked without sending a word to Microsoft."""
    problems = 0
    chunker = Chunker(first_chars=10)
    got = chunker.feed("שלום, אני ג'רביס. מה שלומך")
    if not got:
        print("  chunking     FAILED  no piece came out of a finished sentence")
        problems += 1
    else:
        print(f"  chunking     OK      first piece: {got[0]!r}")

    for name in ("edge_tts", "miniaudio"):
        try:
            __import__(name)
            print(f"  {name:<12} OK")
        except ImportError as exc:
            print(f"  {name:<12} MISSING {exc}")
            problems += 1

    cfg = link.load_config()
    print(f"  voice        {cfg['tts']['voice']}")
    print("\nAll good." if problems == 0 else f"\n{problems} thing(s) need attention.")
    return 0 if problems == 0 else 1


async def _stdin_chunks() -> AsyncIterator[str]:
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            return
        yield line


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Speak with Microsoft's free neural voices (online, no account).")
    parser.add_argument("text", nargs="*", help="what to say")
    parser.add_argument("--config", help="path to config.json")
    parser.add_argument("--voice", help="voice short name, e.g. he-IL-AvriNeural")
    parser.add_argument("--out", help="write an MP3 here instead of playing it")
    parser.add_argument("--stdin", action="store_true", help="speak text as it arrives on standard input")
    parser.add_argument("--serve", action="store_true", help="stay warm and answer POST /say on 127.0.0.1")
    parser.add_argument("--port", type=int, help="port for --serve")
    parser.add_argument("--list-voices", nargs="?", const="", metavar="PREFIX", help="list voices, optionally filtered (e.g. he)")
    parser.add_argument("--self-test", action="store_true", help="check the pieces without speaking")
    parser.add_argument("--demo", action="store_true", help="say one Hebrew and one English sentence")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    cfg = link.load_config(args.config)

    if args.list_voices is not None:
        try:
            voices = asyncio.run(list_voices(args.list_voices))
        except Exception as exc:  # noqa: BLE001 - one sentence, not a stack trace
            print(explain(exc), file=sys.stderr)
            return 1
        for v in voices:
            print(f"  {v['ShortName']:<28} {v.get('Gender', ''):<8} {v.get('FriendlyName', '')}")
        return 0
    if args.serve:
        return serve(cfg, args.port)
    if args.demo:
        # Kept here rather than in TEST-VOICE.bat: Hebrew in a batch file
        # depends on the console code page and arrives mangled often enough.
        for voice, line in (
            (cfg["tts"]["voice"], "שלום בן, אני ג'רביס. הכול מוכן, ואני מדבר עברית."),
            (cfg["tts"]["fallback_voice"], "Good evening. Everything is ready."),
        ):
            try:
                result = asyncio.run(speak(line, cfg=cfg, voice=voice))
            except VoiceUnavailable as exc:
                print(f"  {voice:<24} {exc}")
                continue
            state = result.get("reason") or f"first sound after {result.get('first_audio_seconds')}s"
            print(f"  {voice:<24} {state}")
        return 0

    try:
        if args.stdin:
            result = asyncio.run(speak_stream(_stdin_chunks(), cfg=cfg, voice=args.voice))
        else:
            text = " ".join(args.text).strip()
            if not text:
                parser.error("give it something to say, or use --stdin")
            if args.out:
                result = asyncio.run(to_file(text, Path(args.out), cfg=cfg, voice=args.voice))
            else:
                result = asyncio.run(speak(text, cfg=cfg, voice=args.voice))
    except VoiceUnavailable as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130

    if result.get("reason"):
        print(result["reason"], file=sys.stderr)
        return 1
    if result.get("path"):
        print(f"Wrote {result['path']} ({result['written']} bytes) in {result['voice']}.")
    elif result.get("first_audio_seconds") is not None:
        print(f"Spoke {result['pieces']} piece(s); first sound after {result['first_audio_seconds']}s.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
