"""Hands-free voice input: mic -> local Whisper (faster-whisper) -> `SAID (whisper): "..."` events.

Started by `trainer-coach serve --voice` (or run alone: `trainer-coach voice`). Needs the [voice]
extra (faster-whisper, sounddevice, numpy). Speech is cut into phrases by an adaptive energy gate
that learns the fan/trainer noise floor. Transcripts are dropped when Whisper doubts them
(no_speech_prob >= 0.5 or avg_logprob <= -0.9), when they are silence hallucinations ("Thank you.",
"Thanks for watching!"), fragments under 3 words without a command (easier, harder, stop, pause,
skip, help), or an echo of a coach message read aloud by the page, so the mic can stay open.
"""
from __future__ import annotations

import re
import sys
import time
from typing import Callable

RATE = 16000
BLOCK = 480  # 30 ms

# Whisper says these on silence, breathing and fan noise. Compared after normalize().
HALLUCINATIONS = {
    "", "you", "thank you", "thank you very much", "thank you so much", "thanks", "thanks a lot",
    "thanks for watching", "thank you for watching", "thanks for listening", "bye", "bye bye", "goodbye",
    "please subscribe", "subscribe", "like and subscribe", "music", "applause", "silence", "the end",
    "so", "oh", "uh", "um", "hmm", "mm", "ah", "i", "a", "the",
}
# short utterances are kept only when they carry a command
COMMAND_WORDS = {"easier", "harder", "stop", "pause", "skip", "help"}
MIN_WORDS = 3
# per-segment confidence gates (faster-whisper Segment fields)
MAX_NO_SPEECH_PROB = 0.5
MIN_AVG_LOGPROB = -0.9
_BRACKETED = re.compile(r"^[\[\(\*].*[\]\)\*]$")  # [Music], (silence), *breathing*


def normalize(text: str) -> str:
    return " ".join("".join(ch.lower() if ch.isalnum() or ch == "'" else " " for ch in text).split())


def words(text: str) -> list[str]:
    return [w for w in normalize(text).replace("'", "").split() if len(w) > 1]


def is_hallucination(text: str) -> bool:
    t = text.strip()
    if not t or _BRACKETED.match(t):
        return True
    n = normalize(t)
    if n in HALLUCINATIONS:
        return True
    # the same short phrase repeated ("thank you thank you thank you")
    ws = n.split()
    if ws and len(set(ws)) <= 2 and " ".join(dict.fromkeys(ws)) in HALLUCINATIONS:
        return True
    return False


def is_fragment(text: str) -> bool:
    """Under 3 words and no command word: breath, grunt or half a phrase."""
    ws = normalize(text).replace("'", "").split()
    return len(ws) < MIN_WORDS and not any(w in COMMAND_WORDS for w in ws)


def keep_segment(seg) -> bool:
    """Drop segments Whisper itself doubts: likely silence, or low-confidence decoding."""
    nsp = getattr(seg, "no_speech_prob", 0.0) or 0.0
    alp = getattr(seg, "avg_logprob", 0.0) or 0.0
    return nsp < MAX_NO_SPEECH_PROB and alp > MIN_AVG_LOGPROB


def accept(segments, echo: "CoachEcho | None" = None) -> str | None:
    """Full transcript filter: segment confidence, hallucinations, fragments, speaker echo."""
    text = " ".join(s.text.strip() for s in segments if keep_segment(s)).strip().replace('"', "'")
    if not text or is_hallucination(text) or is_fragment(text):
        return None
    if echo is not None and echo.is_echo(text):
        return None
    return text


class CoachEcho:
    """Remembers recent coach messages; a transcript sharing 60%+ of its words with one is echo."""

    def __init__(self, fetch_cmds: Callable[[int], list[dict]], window_s: float = 60, clock=time.time):
        self.fetch = fetch_cmds
        self.window = window_s
        self.clock = clock
        self.seq = 0
        self.recent: list[tuple[float, set]] = []
        self.next_check = 0.0

    def poll(self) -> None:
        now = self.clock()
        if now < self.next_check:
            return
        self.next_check = now + 1.0
        try:
            cmds = self.fetch(self.seq)
        except Exception:  # noqa: BLE001 - server briefly down
            return
        for c in cmds:
            self.seq = max(self.seq, c["seq"])
            if c.get("msg"):
                self.recent.append((now, set(words(c["msg"]))))
        self.recent = [(t, w) for t, w in self.recent if now - t < self.window]

    def is_echo(self, text: str) -> bool:
        ws = words(text)
        if not ws:
            return True
        return any(sum(w in rw for w in ws) / len(ws) >= 0.6 for _, rw in self.recent)


class PhraseGate:
    """Adaptive energy gate. feed(block, rms) returns the phrase's blocks when a phrase ends.

    A phrase starts above START_FACTOR x the learned noise floor (fans and trainers are loud) and
    ends after 750 ms below 2.2x the floor, or at 20 s.
    """

    START_FACTOR = 4.0

    def __init__(self, rate: int = RATE, block: int = BLOCK, floor: float = 0.004):
        self.block_s = block / rate
        self.noise = floor
        self.voiced = False
        self.phrase: list = []
        self.silence = 0

    def feed(self, blk, rms: float):
        if not self.voiced:
            if rms < self.noise * self.START_FACTOR:
                self.noise = 0.98 * self.noise + 0.02 * rms
            if rms > max(self.noise * self.START_FACTOR, 0.006):
                self.voiced, self.phrase, self.silence = True, [blk], 0
            return None
        self.phrase.append(blk)
        self.silence = self.silence + 1 if rms < self.noise * 2.2 else 0
        dur = len(self.phrase) * self.block_s
        if self.silence >= 25 or dur > 20:  # 750 ms pause ends a phrase
            self.voiced = False
            speech = (len(self.phrase) - self.silence) * self.block_s  # without the trailing pause
            if dur < 0.6 or speech < 0.25:  # a click or a single breath
                return None
            return self.phrase
        return None


def main(argv: list[str] | None = None) -> int:
    import argparse
    import queue

    from .client import CoachClient

    ap = argparse.ArgumentParser(prog="trainer-coach voice")
    ap.add_argument("--model", default="small.en")
    ap.add_argument("--device", default=None, help="sounddevice input device name or index")
    args = ap.parse_args(argv)
    try:
        import numpy as np
        import sounddevice as sd
        from faster_whisper import WhisperModel
    except ImportError as e:
        print(f"voice needs the [voice] extra ({e}): pip install 'trainer-coach[voice]'", file=sys.stderr)
        return 1
    c = CoachClient()
    print(f"voice: loading {args.model}...", flush=True)
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    audio: queue.Queue = queue.Queue()
    echo = CoachEcho(c.commands)
    gate = PhraseGate()
    dev = int(args.device) if args.device and args.device.isdigit() else args.device

    def cb(indata, frames, t, status):
        audio.put(indata[:, 0].copy())

    def post(line: str) -> None:
        try:
            c.event(line)
        except Exception as e:  # noqa: BLE001
            print("voice: post failed:", e, file=sys.stderr, flush=True)

    with sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=BLOCK, callback=cb, device=dev):
        print("voice: listening", flush=True)
        post("VOICE ON (whisper)")
        try:
            while True:
                blk = audio.get()
                echo.poll()
                phrase = gate.feed(blk, float(np.sqrt(np.mean(blk ** 2))))
                if phrase is None:
                    continue
                segs, _ = model.transcribe(np.concatenate(phrase), language="en", beam_size=1, vad_filter=True,
                                           condition_on_previous_text=False)
                text = accept(list(segs), echo)
                if text is None:
                    continue
                print("voice: SAID", text, flush=True)
                post(f'SAID (whisper): "{text}"')
        except KeyboardInterrupt:
            pass
        finally:
            post("VOICE OFF (whisper)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
