"""Device selection without importing torch, loading weights or using a GPU."""
import os
from pathlib import Path
import runpy
from types import SimpleNamespace
import unittest
from unittest.mock import patch

with patch.dict(os.environ, {"GENTLE_VOICE_VIBEVOICE_HOME": "/unused"}):
    resolve_dtype = runpy.run_path(str(Path(__file__).parents[1] / "scripts/vibevoice-lab-worker.py"))["_resolve_dtype"]

class DtypeTests(unittest.TestCase):
    def torch(self, major):
        return SimpleNamespace(float32="fp32", float16="fp16", bfloat16="bf16",
                               cuda=SimpleNamespace(get_device_capability=lambda: (major, 5)))

    def test_turing_uses_bf16(self):
        self.assertEqual(resolve_dtype(self.torch(7), "cuda", "auto"), ("bf16", "bfloat16"))

    def test_ampere_uses_bf16(self):
        self.assertEqual(resolve_dtype(self.torch(8), "cuda", "auto"), ("bf16", "bfloat16"))

    def test_cpu_uses_fp32(self):
        self.assertEqual(resolve_dtype(self.torch(7), "cpu", "auto"), ("fp32", "float32"))

    def test_override_is_preserved(self):
        self.assertEqual(resolve_dtype(self.torch(8), "cuda", "float16"), ("fp16", "float16"))

    def test_install_probe_runs_synthesis_before_success(self):
        namespace = resolve_dtype.__globals__
        events = []
        loads = []
        def load():
            loads.append(True)
            return {}, {"warmup_ok": True}
        with patch.dict(os.environ, {"GENTLE_VOICE_VIBEVOICE_PROBE": "synthesize"}):
            with patch.dict(namespace, {"_load": load, "_emit": events.append}):
                self.assertEqual(namespace["main"](), 0)
        self.assertEqual(loads, [True])
        self.assertTrue(events[0]["synthesized"])

    def test_invalid_override_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unsupported_dtype"):
            resolve_dtype(self.torch(8), "cuda", "invalid")

if __name__ == "__main__":
    unittest.main()
