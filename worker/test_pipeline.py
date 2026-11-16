"""Unit tests for the script-building logic (no models needed): python -m unittest test_pipeline"""
import unittest

from pipeline import build_lines, smooth_labels


def words(text: str, seg: int, start: float, step: float = 0.3) -> list[dict]:
    return [{"w": w, "s": start + i * step, "e": start + i * step + step * 0.9, "seg": seg} for i, w in enumerate(text.split())]


class SmoothTest(unittest.TestCase):
    def test_single_word_flicker_is_merged(self):
        ws = words("so here we are one of the elephants", 0, 0.0)
        labels = [0, 0, 1, 0, 0, 0, 0, 0]
        self.assertEqual(smooth_labels(ws, labels), [0] * 8)

    def test_real_turn_inside_a_sentence_is_kept(self):
        ws = words("are you coming yes I am coming right now", 0, 0.0)
        labels = [0, 0, 0, 1, 1, 1, 1, 1, 1]
        self.assertEqual(smooth_labels(ws, labels), labels)

    def test_short_separate_sentence_keeps_its_speaker(self):
        ws = words("where were you last night", 0, 0.0) + words("home", 1, 2.0)
        labels = [0, 0, 0, 0, 0, 1]
        self.assertEqual(smooth_labels(ws, labels), labels)


class BuildLinesTest(unittest.TestCase):
    def test_speakers_follow_diarization_and_are_renumbered(self):
        ws = words("hello there friend", 0, 0.0) + words("hi how are you", 1, 2.0)
        diar = [(0.0, 1.0, 5), (1.9, 3.5, 2)]
        lines = build_lines(ws, diar, 2)
        self.assertEqual([l["speaker"] for l in lines], [0, 1])  # first voice heard is character 1
        self.assertEqual(lines[1]["text"], "hi how are you")

    def test_no_diarization_means_one_character(self):
        lines = build_lines(words("just me talking here", 0, 0.0), [], 1)
        self.assertEqual({l["speaker"] for l in lines}, {0})

    def test_long_pause_starts_a_new_line(self):
        ws = words("first part", 0, 0.0) + words("second part", 0, 3.0)
        self.assertEqual(len(build_lines(ws, [], 1)), 2)


if __name__ == "__main__":
    unittest.main()
