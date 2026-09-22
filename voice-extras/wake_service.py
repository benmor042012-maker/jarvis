#!/usr/bin/env python3
"""A background listener for the wake phrase, using openWakeWord.

It does one thing: it listens to the microphone for the phrase and, when it
hears it, wakes JARVIS. It never records anything to disk, never transcribes,
and never opens a network connection to anywhere but 127.0.0.1. The model runs
on this computer, is a few hundred kilobytes, and is free.

  python wake_service.py             listen until stopped (Ctrl-C)
  python wake_service.py --check     check the microphone, the model and JARVIS
  python wake_service.py --once      wake once, then exit (handy for testing)
  python wake_service.py --fire      skip the listening and just wake JARVIS
  python wake_service.py --devices   list the microphones this computer has

Why "hey jarvis" and not "jarvis": openWakeWord's free pre-trained set has a
model for the two-word phrase. A single short word is a poor wake word anyway
- it fires on half of ordinary speech. Train your own and point `wake.model`
at the file if you want a different phrase.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, time as time_of_day
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import jarvis_link as link  # noqa: E402

CHUNK = 1280  # 80 ms at 16 kHz — the frame size openWakeWord expects
RATE = 16000

MISSING = """
The Python packages for the wake service are not installed in this interpreter.

  Windows:  double-click voice-extras\\INSTALL-EXTRAS.bat
  Anywhere: python -m pip install -r voice-extras/requirements.txt

Missing: {what}
""".strip()


# --- quiet hours ---------------------------------------------------------------


def _parse_hhmm(value: str) -> time_of_day | None:
    try:
        hh, mm = str(value).split(":")
        return time_of_day(int(hh), int(mm))
    except (ValueError, TypeError):
        return None


def in_quiet_hours(quiet: dict, now: datetime | None = None) -> bool:
    """True inside the configured window, including one that crosses midnight."""
    if not quiet or not quiet.get("enabled"):
        return False
    start = _parse_hhmm(quiet.get("start", ""))
    end = _parse_hhmm(quiet.get("end", ""))
    if not start or not end:
        return False
    current = (now or datetime.now()).time()
    if start == end:
        return False
    if start < end:
        return start <= current < end
    return current >= start or current < end


# --- waking --------------------------------------------------------------------


def wake_jarvis(cfg: dict, logger) -> None:
    """Everything that happens once the phrase has been heard.

    Three things can happen, and which ones apply is a matter of what is
    actually on this computer:

      1. A command from config, if one is set. Yours; run as given.
      2. A signed voice/wake to the running agent, so it starts listening
         without the window having to hear the phrase a second time. Only
         possible when the owner secret is readable here.
      3. Launching JARVIS, which starts it when it is closed and brings the
         window up out of the tray when it is running.

    2 and 3 are not alternatives. Even when the signed wake works, the window
    is still brought up, because a person who says the phrase wants to see it.
    """
    wake = cfg.get("wake", {})

    command = wake.get("command") or []
    if command:
        logger.info("Running the configured command: %s", " ".join(map(str, command)))
        link.run_detached([str(c) for c in command], logger)

    post = wake.get("post")
    if isinstance(post, dict) and post.get("url"):
        status, body = link.post_json(str(post["url"]), post.get("body") or {}, 4.0)
        logger.info("POST %s -> %s %s", post["url"], status, (body or {}).get("error", "ok"))

    running = link.health(cfg) is not None
    if running:
        worked, why = link.signed_wake(cfg)
        logger.info("Signed wake: %s — %s", "listening" if worked else "not listening", why)
    else:
        logger.info("JARVIS is not answering on %s — starting it.", link.agent_base(cfg))

    if wake.get("launch", True):
        cmd = link.launch_command()
        if not cmd:
            logger.error(
                "Cannot find JARVIS to launch. Install it, or set wake.command in config.json."
            )
        elif link.run_detached(cmd, logger):
            logger.info("%s JARVIS.", "Brought up" if running else "Started")


# --- the listener ---------------------------------------------------------------


def load_model(cfg: dict, logger):
    """The openWakeWord model, downloading the free pre-trained files once."""
    try:
        import openwakeword.utils
        from openwakeword.model import Model
    except ImportError as exc:
        raise SystemExit(MISSING.format(what=f"openwakeword ({exc})")) from exc

    wake = cfg.get("wake", {})
    name = str(wake.get("model") or "hey_jarvis")
    framework = str(wake.get("inference_framework") or "onnx")

    # The melspectrogram and embedding models are shared by every wake word and
    # are needed whichever phrase is used. Downloaded once, then never again.
    try:
        openwakeword.utils.download_models()
    except Exception as exc:  # noqa: BLE001 - offline with the files already here is fine
        logger.warning("Could not check for model downloads (%s). Using what is here.", exc)

    as_path = Path(name).expanduser()
    reference = str(as_path) if as_path.is_file() else name
    options: dict = {"wakeword_models": [reference], "inference_framework": framework}
    vad = link.number(wake.get("vad_threshold"), 0.0)
    if vad > 0:
        options["vad_threshold"] = vad
    try:
        model = Model(**options)
    except Exception as exc:  # noqa: BLE001 - the message matters more than the type
        raise SystemExit(
            f"Could not load the wake-word model {reference!r}: {exc}\n"
            "Pre-trained names include: hey_jarvis, alexa, hey_mycroft, hey_rhasspy.\n"
            "A path to your own .onnx or .tflite file works too."
        ) from exc
    logger.info("Model ready: %s (%s)", ", ".join(model.models.keys()), framework)
    return model


def open_microphone(cfg: dict):
    try:
        import sounddevice as sd
    except ImportError as exc:
        raise SystemExit(MISSING.format(what=f"sounddevice ({exc})")) from exc
    device = (cfg.get("wake") or {}).get("input_device")
    return sd.InputStream(
        samplerate=RATE,
        blocksize=CHUNK,
        dtype="int16",
        channels=1,
        device=device if device not in ("", None) else None,
    )


def listen(cfg: dict, logger, once: bool = False) -> int:
    model = load_model(cfg, logger)
    wake = cfg.get("wake", {})
    threshold = link.number(wake.get("threshold"), 0.5)
    cooldown = link.number(wake.get("cooldown_seconds"), 3.0)
    needed = max(1, int(link.number(wake.get("frames_to_trigger"), 1)))
    quiet = wake.get("quiet_hours") or {}

    last_wake = 0.0
    hot_frames = 0

    logger.info(
        "Listening for the wake phrase. Threshold %.2f, %d frame(s) to trigger. Ctrl-C to stop.",
        threshold,
        needed,
    )
    try:
        with open_microphone(cfg) as stream:
            while True:
                frame, overflowed = stream.read(CHUNK)
                if overflowed:
                    logger.debug("Audio overflow — a frame was dropped.")
                scores = model.predict(frame[:, 0])
                best = max(scores.values()) if scores else 0.0
                if best < threshold:
                    hot_frames = 0
                    continue
                hot_frames += 1
                if hot_frames < needed:
                    continue
                hot_frames = 0
                now = time.monotonic()
                if now - last_wake < cooldown:
                    continue
                last_wake = now
                if in_quiet_hours(quiet, None):
                    logger.info("Heard the phrase (%.2f) during quiet hours — ignored.", best)
                    continue
                logger.info("Heard the wake phrase (%.2f).", best)
                # Whatever openWakeWord thought it was hearing before this
                # point is spent; without the reset the next few frames can
                # fire again on the same sound.
                model.reset()
                wake_jarvis(cfg, logger)
                if once:
                    return 0
    except KeyboardInterrupt:
        logger.info("Stopped.")
        return 0
    except Exception as exc:  # noqa: BLE001 - a service must say why it died
        logger.error("The wake service stopped: %s", exc)
        return 1


# --- checks ---------------------------------------------------------------------


def list_devices() -> int:
    try:
        import sounddevice as sd
    except ImportError as exc:
        print(MISSING.format(what=f"sounddevice ({exc})"))
        return 1
    for index, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] > 0:
            print(f"  {index:>3}  {dev['name']}  ({dev['max_input_channels']} ch)")
    print("\nPut the number, or the name, in config.json as wake.input_device.")
    return 0


def check(cfg: dict, logger) -> int:
    """Say plainly which of the four things this needs are actually here."""
    problems = 0

    try:
        import numpy  # noqa: F401
        import sounddevice as sd

        default_in = sd.query_devices(kind="input")
        print(f"  microphone   OK      {default_in['name']}")
    except ImportError as exc:
        print(f"  microphone   MISSING {exc}")
        problems += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  microphone   FAILED  {exc}")
        problems += 1

    try:
        load_model(cfg, logger)
        print(f"  wake model   OK      {cfg['wake']['model']}")
    except SystemExit as exc:
        print(f"  wake model   MISSING {str(exc).splitlines()[0]}")
        problems += 1

    info = link.health(cfg)
    if info:
        print(f"  JARVIS       OK      running on {link.agent_base(cfg)}, state {info.get('state')}")
    else:
        cmd = link.launch_command()
        print(f"  JARVIS       IDLE    not running; would start it with: {' '.join(cmd) if cmd else '(nothing found — set wake.command)'}")
        if not cmd:
            problems += 1

    owner = link.owner_device()
    if owner:
        print("  signed wake  OK      the agent will start listening by itself")
    else:
        print("  signed wake  N/A     the owner secret is encrypted here; waking opens the window instead")

    print("\nAll good." if problems == 0 else f"\n{problems} thing(s) need attention.")
    return 0 if problems == 0 else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="JARVIS wake-word service (openWakeWord, local and free).")
    parser.add_argument("--config", help="path to config.json (default: next to this file)")
    parser.add_argument("--check", action="store_true", help="check microphone, model and JARVIS, then exit")
    parser.add_argument("--devices", action="store_true", help="list input devices and exit")
    parser.add_argument("--once", action="store_true", help="exit after the first wake")
    parser.add_argument("--fire", action="store_true", help="wake JARVIS now, without listening")
    parser.add_argument("--threshold", type=float, help="override wake.threshold")
    parser.add_argument("--verbose", action="store_true", help="log every decision")
    args = parser.parse_args(argv)

    cfg = link.load_config(args.config)
    if args.threshold is not None:
        cfg["wake"]["threshold"] = args.threshold
    logger = link.setup_logging("jarvis-wake", "DEBUG" if args.verbose else cfg.get("log_level", "INFO"))

    if args.devices:
        return list_devices()
    if args.check:
        return check(cfg, logger)
    if args.fire:
        wake_jarvis(cfg, logger)
        return 0
    return listen(cfg, logger, once=args.once)


if __name__ == "__main__":
    raise SystemExit(main())
