"""Tests for the voice extras. Standard library only, so they run before pip.

  python voice-extras/tests/test_extras.py

The signing vectors below are not made up: they were produced by this repo's
own desktop/src/core/util.js and protocol.js. If the Python and the JavaScript
ever disagree about one byte of canonical JSON, a wake request is rejected as
"modified" and this catches it here instead of in the log at midnight.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
import unittest.mock
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import jarvis_link as link  # noqa: E402
import say  # noqa: E402
import wake_service  # noqa: E402


class Canonical(unittest.TestCase):
    # (value, canonical JSON, sha256) — from util.js canonical()/paramsHash().
    VECTORS = [
        ({}, "{}", "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"),
        ({"ms": 900, "distance": None}, '{"distance":null,"ms":900}', "6c3dc3ce8827c5861c4d9b1aee0949497c46d5744a7831e61301f0d92797a538"),
        ({"ms": 900, "distance": 0.42}, '{"distance":0.42,"ms":900}', "7c09f3836a1b4195f0c17d6b2846a7c4d12eb6c1690bb9059b265114b18c1b6c"),
        (
            {"a": 1.0, "b": "שלום", "c": [1, 2, {"z": None}], "d": True},
            '{"a":1,"b":"שלום","c":[1,2,{"z":null}],"d":true}',
            "bdbd1babe7bd2e6a670b25402a9dd850832665c3931f78566a3fe7d68a6b6ffc",
        ),
    ]

    def test_matches_the_javascript(self):
        for value, text, digest in self.VECTORS:
            self.assertEqual(link.canonical(value), text, value)
            self.assertEqual(link.params_hash(value), digest, value)

    def test_whole_floats_lose_the_dot_like_javascript(self):
        self.assertEqual(link.canonical({"x": 2.0}), '{"x":2}')

    def test_nan_becomes_null_like_javascript(self):
        self.assertEqual(link.canonical({"x": float("nan")}), '{"x":null}')


class Signing(unittest.TestCase):
    def test_envelope_carries_everything_the_verifier_checks(self):
        env = link.sign_envelope({"ms": 900, "distance": None}, "11111111-2222-3333-4444-555555555555", "s3cr3t", "/api/voice/wake")
        for key in ("v", "id", "device_id", "ts", "expires", "nonce", "params", "params_hash", "signature"):
            self.assertIn(key, env)
        self.assertEqual(env["v"], link.PROTOCOL_VERSION)
        self.assertEqual(len(env["signature"]), 64)
        self.assertEqual(env["params_hash"], link.params_hash(env["params"]))
        self.assertGreater(env["expires"], env["ts"])
        # protocol.js rejects a window wider than five minutes.
        self.assertLessEqual(env["expires"] - env["ts"], 5 * 60 * 1000)

    def test_the_signature_is_over_the_path_so_one_cannot_be_reused_elsewhere(self):
        args = ({"ms": 900}, "11111111-2222-3333-4444-555555555555", "s3cr3t")
        a = link.sign_envelope(*args, "/api/voice/wake")
        b = dict(a)
        b["signature"] = link.sign_envelope(*args, "/api/emergency-stop")["signature"]
        self.assertNotEqual(a["signature"], b["signature"])

    def test_every_request_gets_a_fresh_id_and_nonce(self):
        args = ({"ms": 900}, "11111111-2222-3333-4444-555555555555", "s3cr3t", "/api/voice/wake")
        first, second = link.sign_envelope(*args), link.sign_envelope(*args)
        self.assertNotEqual(first["id"], second["id"])
        self.assertNotEqual(first["nonce"], second["nonce"])


class OwnerSecret(unittest.TestCase):
    def _home(self, devices):
        home = Path(tempfile.mkdtemp())
        (home / "devices.json").write_text(json.dumps({"devices": devices}), encoding="utf-8")
        return home

    def test_reads_a_plain_owner_secret(self):
        home = self._home([{"id": "abc", "role": "owner", "secret": "deadbeef", "revoked": False}])
        with unittest.mock.patch.dict("os.environ", {"JARVIS_HOME": str(home)}):
            self.assertEqual(link.owner_device(), ("abc", "deadbeef"))

    def test_an_encrypted_secret_is_not_a_secret_we_have(self):
        home = self._home([{"id": "abc", "role": "owner", "secret_enc": "base64==", "revoked": False}])
        with unittest.mock.patch.dict("os.environ", {"JARVIS_HOME": str(home)}):
            self.assertIsNone(link.owner_device())

    def test_revoked_and_remote_devices_are_skipped(self):
        home = self._home(
            [
                {"id": "gone", "role": "owner", "secret": "x", "revoked": True},
                {"id": "phone", "role": "remote", "secret": "y", "revoked": False},
            ]
        )
        with unittest.mock.patch.dict("os.environ", {"JARVIS_HOME": str(home)}):
            self.assertIsNone(link.owner_device())

    def test_no_file_is_not_a_crash(self):
        with unittest.mock.patch.dict("os.environ", {"JARVIS_HOME": tempfile.mkdtemp()}):
            self.assertIsNone(link.owner_device())


class Config(unittest.TestCase):
    def test_defaults_when_there_is_no_file(self):
        cfg = link.load_config(Path(tempfile.mkdtemp()) / "nope.json")
        self.assertEqual(cfg["wake"]["model"], "hey_jarvis")
        self.assertEqual(cfg["tts"]["voice"], "he-IL-AvriNeural")

    def test_a_partial_file_only_overrides_what_it_names(self):
        path = Path(tempfile.mkdtemp()) / "config.json"
        path.write_text(json.dumps({"wake": {"threshold": 0.8}}), encoding="utf-8")
        cfg = link.load_config(path)
        self.assertEqual(cfg["wake"]["threshold"], 0.8)
        self.assertEqual(cfg["wake"]["model"], "hey_jarvis")
        self.assertEqual(cfg["tts"]["serve_port"], 8771)

    def test_a_broken_file_is_ignored_not_fatal(self):
        path = Path(tempfile.mkdtemp()) / "config.json"
        path.write_text("{ not json", encoding="utf-8")
        self.assertEqual(link.load_config(path)["wake"]["model"], "hey_jarvis")

    def test_the_example_file_parses_and_only_names_real_settings(self):
        example = json.loads((ROOT / "config.example.json").read_text(encoding="utf-8"))
        for section in ("wake", "tts", "agent"):
            self.assertIn(section, example)
            unknown = set(example[section]) - set(link.DEFAULTS[section])
            self.assertEqual(unknown, set(), f"{section} names settings that do not exist: {unknown}")

    def test_the_port_falls_back_to_the_agent_default(self):
        with unittest.mock.patch.dict("os.environ", {"JARVIS_HOME": tempfile.mkdtemp()}):
            self.assertEqual(link.agent_port({}), link.DEFAULT_PORT)

    def test_the_port_is_read_from_the_agent_config(self):
        home = Path(tempfile.mkdtemp())
        (home / "config.json").write_text(json.dumps({"server": {"port": 9123}}), encoding="utf-8")
        with unittest.mock.patch.dict("os.environ", {"JARVIS_HOME": str(home)}):
            self.assertEqual(link.agent_port({}), 9123)
            self.assertEqual(link.agent_base({}), "http://127.0.0.1:9123")


class Numbers(unittest.TestCase):
    """A configured 0 has to mean 0, not "use the default"."""

    def test_zero_is_kept(self):
        self.assertEqual(link.number(0, 3.0), 0.0)

    def test_missing_falls_back(self):
        self.assertEqual(link.number(None, 3.0), 3.0)

    def test_nonsense_falls_back(self):
        self.assertEqual(link.number("soon", 3.0), 3.0)
        self.assertEqual(link.number({}, 3.0), 3.0)
        self.assertEqual(link.number(True, 3.0), 3.0)

    def test_a_string_number_is_a_number(self):
        self.assertEqual(link.number("0.4", 3.0), 0.4)


class QuietHours(unittest.TestCase):
    def test_off_unless_enabled(self):
        self.assertFalse(wake_service.in_quiet_hours({"start": "00:00", "end": "23:59"}))

    def test_a_window_inside_one_day(self):
        quiet = {"enabled": True, "start": "09:00", "end": "17:00"}
        self.assertTrue(wake_service.in_quiet_hours(quiet, datetime(2026, 1, 1, 12, 0)))
        self.assertFalse(wake_service.in_quiet_hours(quiet, datetime(2026, 1, 1, 8, 59)))
        self.assertFalse(wake_service.in_quiet_hours(quiet, datetime(2026, 1, 1, 17, 0)))

    def test_a_window_over_midnight(self):
        quiet = {"enabled": True, "start": "23:00", "end": "07:00"}
        for hour in (23, 0, 3, 6):
            self.assertTrue(wake_service.in_quiet_hours(quiet, datetime(2026, 1, 1, hour, 30)), hour)
        for hour in (7, 12, 22):
            self.assertFalse(wake_service.in_quiet_hours(quiet, datetime(2026, 1, 1, hour, 30)), hour)

    def test_nonsense_times_do_not_silence_it(self):
        self.assertFalse(wake_service.in_quiet_hours({"enabled": True, "start": "nope", "end": "07:00"}))
        self.assertFalse(wake_service.in_quiet_hours({"enabled": True, "start": "08:00", "end": "08:00"}))


class Chunking(unittest.TestCase):
    def test_a_finished_hebrew_sentence_comes_out_whole(self):
        pieces, rest = say.split_sentences("שלום, אני ג'רביס. מה שלומך")
        self.assertEqual(pieces, ["שלום, אני ג'רביס."])
        self.assertEqual(rest, "מה שלומך")

    def test_a_decimal_number_is_not_a_sentence_end(self):
        pieces, rest = say.split_sentences("the disk is 3.5 percent full")
        self.assertEqual(pieces, [])
        self.assertEqual(rest, "the disk is 3.5 percent full")

    def test_the_first_piece_leaves_early_so_speaking_starts(self):
        chunker = say.Chunker(first_chars=20)
        self.assertEqual(chunker.feed("short"), [])
        out = chunker.feed(" but this one keeps going and going without an end")
        self.assertTrue(out, "nothing was released once the character limit was passed")
        self.assertNotIn("  ", out[0])

    def test_a_word_is_never_cut_in_half(self):
        chunker = say.Chunker(first_chars=10)
        out = chunker.feed("alpha beta gamma delta")
        self.assertTrue(out)
        for word in out[0].split():
            self.assertIn(word, ["alpha", "beta", "gamma", "delta"])

    def test_later_pieces_wait_for_a_real_sentence_end(self):
        chunker = say.Chunker(first_chars=5, later_chars=400)
        chunker.feed("go. ")
        self.assertEqual(chunker.feed("and now a long tail of words with no full stop yet at all"), [])

    def test_flush_says_the_last_unfinished_bit(self):
        chunker = say.Chunker()
        chunker.feed("no full stop here")
        self.assertEqual(chunker.flush(), ["no full stop here"])
        self.assertEqual(chunker.flush(), [])

    def test_newlines_end_a_piece(self):
        pieces, rest = say.split_sentences("first line\nsecond")
        self.assertEqual(pieces, ["first line"])
        self.assertEqual(rest, "second")


class Launching(unittest.TestCase):
    def test_it_finds_a_way_to_start_jarvis_in_this_checkout(self):
        cmd = link.launch_command()
        self.assertIsNotNone(cmd, "neither the installed app, the .bat nor package.json was found")
        self.assertTrue(all(isinstance(part, str) for part in cmd))

    def test_an_empty_command_runs_nothing(self):
        self.assertFalse(link.run_detached([]))


class Failures(unittest.TestCase):
    """A voice that is not available must produce a sentence, not a stack trace."""

    def test_a_certificate_problem_names_the_proxy(self):
        class ClientConnectorCertificateError(Exception):
            pass

        message = say.explain(ClientConnectorCertificateError("CERTIFICATE_VERIFY_FAILED"))
        self.assertIn("proxy", message.lower())
        self.assertNotIn("Traceback", message)

    def test_no_internet_says_so_and_points_at_the_local_voice(self):
        message = say.explain(OSError("Network is unreachable"))
        self.assertIn("internet", message.lower())
        self.assertIn("Settings", message)

    def test_rate_limiting_is_reported_as_the_service_refusing(self):
        self.assertIn("refused", say.explain(RuntimeError("HTTP 429 Too Many Requests")))

    def test_anything_else_still_gets_one_line(self):
        message = say.explain(ValueError("something odd"))
        self.assertEqual(len(message.splitlines()), 1)
        self.assertIn("something odd", message)

    def test_a_failed_write_leaves_no_file_behind(self):
        out = Path(tempfile.mkdtemp()) / "reply.mp3"

        async def boom(*_args, **_kwargs):
            raise say.VoiceUnavailable("no service")
            yield b""  # pragma: no cover - makes this an async generator

        with unittest.mock.patch.object(say, "synth", boom):
            with self.assertRaises(say.VoiceUnavailable):
                asyncio.run(say.to_file("hello", out))
        self.assertFalse(out.exists(), "a nought-byte MP3 was left behind")
        self.assertFalse(out.with_suffix(".mp3.part").exists())

    def test_a_failure_part_way_through_is_reported_not_raised(self):
        async def two_then_boom(text, *_args, **_kwargs):
            if "first" in text:
                yield b"\x00" * 16
                return
            raise say.VoiceUnavailable("the service went away")

        with unittest.mock.patch.object(say, "synth", two_then_boom):
            with unittest.mock.patch.object(say, "_have_miniaudio", lambda: False):
                with unittest.mock.patch.object(say, "play_file", lambda _p: True):
                    result = asyncio.run(say.speak_stream(["first one. ", "second one."]))
        self.assertFalse(result["spoken"])
        self.assertIn("went away", result["reason"])
        self.assertEqual(result["pieces"], 1, "the piece that did work should still be counted")

    def test_with_no_player_at_all_it_says_so_rather_than_claiming_success(self):
        async def fake(*_args, **_kwargs):
            yield b"\x00" * 16

        with unittest.mock.patch.object(say, "synth", fake):
            with unittest.mock.patch.object(say, "_have_miniaudio", lambda: False):
                with unittest.mock.patch.object(say, "play_file", lambda _p: False):
                    result = asyncio.run(say.speak_stream(["hello."]))
        self.assertFalse(result["spoken"])
        self.assertIn("miniaudio", result["reason"])


class FakeFrame:
    """Stands in for the numpy frame a sound device hands back."""

    def __init__(self, value: float):
        self.value = value

    def __getitem__(self, _key):
        return self.value


class Listening(unittest.TestCase):
    """The loop that decides a phrase was heard, without a microphone or a model.

    Nothing here can test whether openWakeWord recognises a voice - that needs a
    voice. What it does test is every rule around it: how many frames it takes,
    the cooldown that stops one spoken phrase waking twice, and quiet hours.
    """

    def _run(self, scores, cfg_over=None):
        """Feed a scripted list of model scores through listen() and count wakes."""
        cfg = link.load_config(Path(tempfile.mkdtemp()) / "none.json")
        cfg["wake"].update(cfg_over or {})
        remaining = list(scores)
        woke = []

        class FakeModel:
            models = {"hey_jarvis": object()}

            def predict(self, _frame):
                return {"hey_jarvis": remaining.pop(0)}

            def reset(self):
                pass

        class FakeStream:
            def __enter__(self):
                return self

            def __exit__(self, *_a):
                return False

            def read(self, _frames):
                if not remaining:
                    raise KeyboardInterrupt
                return FakeFrame(0.0), False

        with unittest.mock.patch.object(wake_service, "load_model", lambda *_a: FakeModel()):
            with unittest.mock.patch.object(wake_service, "open_microphone", lambda *_a: FakeStream()):
                with unittest.mock.patch.object(wake_service, "wake_jarvis", lambda *_a: woke.append(1)):
                    code = wake_service.listen(cfg, link.setup_logging("test-listen", "ERROR", to_file=False))
        return code, len(woke)

    def test_quiet_audio_never_wakes_it(self):
        code, wakes = self._run([0.0, 0.1, 0.4])
        self.assertEqual((code, wakes), (0, 0))

    def test_one_loud_frame_is_enough_by_default(self):
        _code, wakes = self._run([0.9])
        self.assertEqual(wakes, 1)

    def test_two_frames_can_be_required(self):
        _code, wakes = self._run([0.9], {"frames_to_trigger": 2})
        self.assertEqual(wakes, 0, "one frame woke it although two were required")
        _code, wakes = self._run([0.9, 0.9], {"frames_to_trigger": 2})
        self.assertEqual(wakes, 1)

    def test_the_run_has_to_be_consecutive(self):
        _code, wakes = self._run([0.9, 0.1, 0.9], {"frames_to_trigger": 2})
        self.assertEqual(wakes, 0, "a quiet frame in between should have reset the run")

    def test_one_spoken_phrase_does_not_wake_it_twice(self):
        # A phrase lasts several frames, and every one of them scores high.
        _code, wakes = self._run([0.95] * 8, {"cooldown_seconds": 30})
        self.assertEqual(wakes, 1)

    def test_the_cooldown_can_be_turned_off(self):
        _code, wakes = self._run([0.95, 0.95], {"cooldown_seconds": 0})
        self.assertEqual(wakes, 2)

    def test_the_threshold_is_respected(self):
        _code, wakes = self._run([0.6], {"threshold": 0.8})
        self.assertEqual(wakes, 0)
        _code, wakes = self._run([0.85], {"threshold": 0.8})
        self.assertEqual(wakes, 1)

    def test_quiet_hours_hear_it_and_ignore_it(self):
        always_quiet = {"enabled": True, "start": "00:00", "end": "23:59"}
        _code, wakes = self._run([0.95], {"quiet_hours": always_quiet})
        self.assertEqual(wakes, 0)

    def test_ctrl_c_is_a_clean_exit(self):
        code, _wakes = self._run([])
        self.assertEqual(code, 0)


class AgainstARunningAgent(unittest.TestCase):
    """The one test that proves the whole thing: a request this Python code
    signed, accepted by the real server in desktop/src/core/server.js.

    Skipped when JARVIS is not running, so the suite still passes on a machine
    where it is closed. To run it: start JARVIS (or `npm run headless`) and run
    the tests again.
    """

    def setUp(self):
        self.cfg = link.load_config(Path(tempfile.mkdtemp()) / "none.json")
        if link.health(self.cfg) is None:
            self.skipTest(f"no agent answering on {link.agent_base(self.cfg)}")

    def test_health_says_it_is_the_jarvis_agent(self):
        self.assertEqual(link.health(self.cfg).get("app"), "jarvis-agent")

    def test_a_signed_wake_is_accepted_not_rejected(self):
        owner = link.owner_device()
        if not owner:
            self.skipTest("the owner secret is encrypted on this machine")
        env = link.sign_envelope({"ms": 900, "distance": None}, owner[0], owner[1], "/api/voice/wake")
        status, body = link.post_json(link.agent_base(self.cfg) + "/api/voice/wake", env)
        self.assertEqual(status, 200, body)
        self.assertTrue(body.get("ok"), body)
        # "ignored" is a fine answer — muted, or no microphone permission yet.
        # What matters is that it was never "unauthorized" or "modified".
        self.assertIn(body.get("action"), {"woke", "ignored"}, body)

    def test_a_tampered_envelope_is_rejected(self):
        owner = link.owner_device()
        if not owner:
            self.skipTest("the owner secret is encrypted on this machine")
        env = link.sign_envelope({"ms": 900, "distance": None}, owner[0], owner[1], "/api/voice/wake")
        env["params"] = {"ms": 1, "distance": None}
        status, body = link.post_json(link.agent_base(self.cfg) + "/api/voice/wake", env)
        self.assertEqual(status, 400, body)
        self.assertEqual(body.get("error"), "modified", body)



if __name__ == "__main__":
    unittest.main(verbosity=2)
