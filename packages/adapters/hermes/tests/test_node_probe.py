"""The analyzer's node binary is probed, not just found (2026-11-17: a `brew upgrade` of simdjson
left /opt/homebrew/opt/node@24/bin/node aborting in dyld; every analyzer call failed for 3h and the
adapter silently fell back to whole-file keys). Fake broken nodes are shell scripts that exit 1
with a dyld-like message.

Run: python3 -m unittest tests.test_node_probe -v   (from packages/adapters/hermes)
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
sys.path.insert(0, str(PKG / "installer"))
sys.path.insert(0, str(PKG / "plugin"))

import weft.adapter as A  # noqa: E402

DYLD = "dyld[4242]: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.33.dylib"


def real_node() -> str:
    for c in ("/opt/homebrew/opt/node@24/bin/node", shutil.which("node") or "", "/opt/homebrew/bin/node"):
        if c and os.path.exists(c) and subprocess.run([c, "-e", "0"], capture_output=True).returncode == 0:
            return c
    raise unittest.SkipTest("no working node to wrap")


REAL = real_node()

# A stand-in for analyze.mjs: --languages, and a --serve loop that answers every request.
SERVE = r"""
import { createInterface } from "node:readline";
if (process.argv.includes("--languages")) {
  console.log(JSON.stringify({ ok: true, extensions: [".ts"], languages: [{ id: "fake" }] }));
  process.exit(0);
}
createInterface({ input: process.stdin }).on("line", (l) => {
  const r = JSON.parse(l);
  console.log(JSON.stringify({ id: r.id, ok: true, analyzed: r.files.map((f) => f.path), reads: [],
    writes: r.files.map((f) => ({ key: `${f.path}#fake`, kind: "body" })) }));
});
"""

CHANGE = [("a.ts", "export const a = 1;\n", "export const a = 2;\n")]


class NodeProbeCase(unittest.TestCase):
    def setUp(self) -> None:
        A._node_probes.clear()
        self.dir = Path(tempfile.mkdtemp(prefix="weft-node-probe-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.lines: list = []
        # Only the test's fakes are candidates; no real node on PATH either.
        self.empty = self.dir / "empty-path"
        self.empty.mkdir()
        for patcher in (mock.patch.object(A, "NODE_CANDIDATES", ()),
                        mock.patch.dict(os.environ, {"PATH": str(self.empty)})):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.script = self.dir / "serve.mjs"
        self.script.write_text(SERVE)

    def log(self, message: str) -> None:
        self.lines.append(message)

    def fake(self, name: str, broken_if: str = "", always_broken: bool = False) -> str:
        """A node wrapper that counts its starts; dies like dyld when ``always_broken`` or when
        the file ``broken_if`` exists, else execs the real node."""
        path = self.dir / name
        count = self.dir / f"{name}.calls"
        cond = "true" if always_broken else f"[ -e '{broken_if}' ]" if broken_if else "false"
        path.write_text(f"#!/bin/sh\necho x >> '{count}'\nif {cond}; then echo '{DYLD}' >&2; exit 1; fi\n"
                        f"exec '{REAL}' \"$@\"\n")
        path.chmod(0o755)
        return str(path)

    def calls(self, name: str) -> int:
        p = self.dir / f"{name}.calls"
        return len(p.read_text().split()) if p.exists() else 0

    def broken_lines(self) -> list:
        return [l for l in self.lines if " is broken: " in l]


class ResolveNodeTests(NodeProbeCase):
    def test_broken_configured_node_falls_back_with_one_log_line(self) -> None:
        bad, good = self.fake("bad", always_broken=True), self.fake("good")
        with mock.patch.object(A, "NODE_CANDIDATES", (good,)):
            self.assertEqual(A.resolve_node(bad, self.log), good)
            self.assertEqual(A.resolve_node(bad, self.log), good)  # cached: no new probe
        self.assertEqual(self.broken_lines(), [f"node {bad} is broken: {DYLD}; using {good}",
                                               f"node {bad} is broken: {DYLD}; using {good}"])
        self.assertEqual(self.calls("bad"), 1, "probe result is cached per process")
        self.assertEqual(self.calls("good"), 1)

    def test_find_node_skips_an_existing_but_broken_first_candidate(self) -> None:
        bad, good = self.fake("bad", always_broken=True), self.fake("good")
        with mock.patch.object(A, "NODE_CANDIDATES", (bad, good)):
            self.assertEqual(A._find_node(self.log), good)
        self.assertEqual(self.broken_lines(), [f"node {bad} is broken: {DYLD}; using {good}"])

    def test_working_configured_node_is_kept_silently(self) -> None:
        good, other = self.fake("good"), self.fake("other")
        with mock.patch.object(A, "NODE_CANDIDATES", (other,)):
            self.assertEqual(A.resolve_node(good, self.log), good)
        self.assertEqual(self.lines, [])
        self.assertEqual(self.calls("other"), 0)

    def test_no_working_node_keeps_the_configured_one_and_says_so(self) -> None:
        bad = self.fake("bad", always_broken=True)
        self.assertEqual(A.resolve_node(bad, self.log), bad)
        self.assertEqual(len(self.broken_lines()), 1)
        self.assertIn("no working node >= 22 found", self.lines[0])

    def test_missing_and_too_old_nodes_are_rejected(self) -> None:
        self.assertEqual(A.probe_node(str(self.dir / "nope")), "not found")
        old = self.dir / "old"
        old.write_text("#!/bin/sh\necho 18.20.4\n")
        old.chmod(0o755)
        self.assertEqual(A.probe_node(str(old)), "version 18.20.4 is older than 22")
        self.assertIsNone(A.probe_node(self.fake("good")))


class AnalyzerFallbackTests(NodeProbeCase):
    def analyzer(self, node: str) -> A.Analyzer:
        an = A.Analyzer(node, str(self.script), timeout=10.0, log=self.log)
        self.addCleanup(an.close)
        return an

    def test_broken_configured_node_is_replaced_before_first_use(self) -> None:
        bad, good = self.fake("bad", always_broken=True), self.fake("good")
        with mock.patch.object(A, "NODE_CANDIDATES", (good,)):
            an = self.analyzer(bad)
            _reads, writes = an.analyze(CHANGE)
            _reads, writes2 = an.analyze(CHANGE)
        self.assertEqual([w["key"] for w in writes], ["a.ts#fake"])
        self.assertEqual([w["key"] for w in writes2], ["a.ts#fake"])
        self.assertEqual(an.node, good)
        self.assertEqual(self.broken_lines(), [f"node {bad} is broken: {DYLD}; using {good}"])
        self.assertEqual(self.calls("bad"), 1, "the dead binary is probed once and never run again")

    def test_node_that_breaks_mid_process_is_switched_after_two_early_exits(self) -> None:
        flag = self.dir / "simdjson-upgraded"
        flaky, good = self.fake("flaky", broken_if=str(flag)), self.fake("good")
        with mock.patch.object(A, "NODE_CANDIDATES", (good,)):
            an = self.analyzer(flaky)
            self.assertEqual([w["key"] for w in an.analyze(CHANGE)[1]], ["a.ts#fake"])
            flag.touch()          # brew upgrade under the running gateway
            an.close()            # ... and the analyzer child goes away
            # Failed calls fall back to whole-file keys (the analyzer is best-effort).
            self.assertEqual([w["key"] for w in an.analyze(CHANGE)[1]], ["a.ts#*"])
            self.assertEqual([w["key"] for w in an.analyze(CHANGE)[1]], ["a.ts#*"])
            self.assertEqual(an.node, good, "two early exits: re-probed and switched")
            self.assertEqual([w["key"] for w in an.analyze(CHANGE)[1]], ["a.ts#fake"])
        exits = [l for l in self.lines if l.startswith("analyzer failed:")]
        self.assertEqual(len(exits), 2)
        for line in exits:
            self.assertIn(DYLD, line, "the child's stderr first line is logged")
            self.assertIn("(exit 1)", line)
        self.assertEqual(self.broken_lines(), [f"node {flaky} is broken: {DYLD}; using {good}"])

    def test_no_working_node_pauses_instead_of_respawning_forever(self) -> None:
        bad = self.fake("bad", always_broken=True)
        an = self.analyzer(bad)
        for _ in range(6):
            self.assertEqual([w["key"] for w in an.analyze(CHANGE)[1]], ["a.ts#*"])
        # 1 probe + --languages once + 2 serve starts, then paused; refresh probe on the 2nd exit.
        self.assertLessEqual(self.calls("bad"), 5)
        paused = [l for l in self.lines if l.startswith("analyzer paused")]
        self.assertEqual(len(paused), 1)
        self.assertIn(f"node {bad} is broken", paused[0])
        # After the pause the node is re-probed (a brew fix needs no gateway restart).
        before = self.calls("bad")
        an._paused_until = time.monotonic() - 1
        an.analyze(CHANGE)
        self.assertGreater(self.calls("bad"), before)

    def test_bundle_that_dies_at_start_with_a_good_node_pauses(self) -> None:
        good = self.fake("good")
        self.script.write_text('console.error("SyntaxError: Unexpected token"); process.exit(1);\n')
        an = self.analyzer(good)
        for _ in range(4):
            an.analyze(CHANGE)
        paused = [l for l in self.lines if l.startswith("analyzer paused")]
        self.assertEqual(len(paused), 1)
        self.assertIn(f"node {good} runs, but the bundle exits at start (SyntaxError: Unexpected token)", paused[0])
        self.assertEqual(an.node, good)


class InstallNodeBinTests(NodeProbeCase):
    def load_install(self):
        sys.path.insert(0, str(PKG / "scripts"))
        self.addCleanup(sys.path.remove, str(PKG / "scripts"))
        import install  # noqa: WPS433
        install._NODE.clear()
        self.addCleanup(install._NODE.clear)
        return install

    def test_writes_only_a_node_that_passes_the_probe(self) -> None:
        install = self.load_install()
        bad, good = self.fake("bad", always_broken=True), self.fake("good")
        out = io.StringIO()
        with mock.patch.object(A, "NODE_CANDIDATES", (bad, good)), redirect_stdout(out):
            self.assertEqual(install.node_bin(), good)
            self.assertEqual(install.node_bin(), good)
        self.assertEqual(out.getvalue(), f"note: node {bad} is broken: {DYLD}; using {good}\n")

    def test_refuses_when_no_node_runs(self) -> None:
        install = self.load_install()
        bad = self.fake("bad", always_broken=True)
        with mock.patch.object(A, "NODE_CANDIDATES", (bad,)), redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as ctx:
                install.node_bin()
        self.assertIn("no working node >= 22 found", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
