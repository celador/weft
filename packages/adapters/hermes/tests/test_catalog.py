"""Catalog regressions, offline: no credential-file reads, safe routing and visible diagnostics."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PKG = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PKG / 'plugin'))
from weft import adapter as A, pyanalyze, standalone, status, surface
from test_adapter import FakeClient


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'shop'
        self.repo.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        self.meta = {'url': standalone.LOCAL_URL, 'repo': 'shop', 'agent': 'agent-a'}
        (self.repo / '.weft').mkdir()
        (self.repo / '.weft/space.json').write_text(json.dumps(self.meta))
        self.env = patch.dict(os.environ, {'WEFT_HERMES_CACHE': str(self.root / 'cache')})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def links(self, settings=None, secret='scoped-token'):
        return standalone.Links(settings or standalone.Settings(), lambda name: secret, 'test')

    def test_no_secret_means_no_reporting_even_with_cli_token(self):
        (self.repo / '.weft/token').write_text('must-not-read-this')
        self.assertIsNone(self.links(secret=None).link(str(self.repo)))

    def test_secret_comes_only_from_scope(self):
        (self.repo / '.weft/token').write_text('must-not-read-this')
        self.assertEqual(self.links().link(str(self.repo))['token'], 'scoped-token')

    def test_unlinked_checkout_silent(self):
        (self.repo / '.weft/space.json').unlink()
        self.assertIsNone(self.links().link(str(self.repo)))

    def test_untrusted_gateway_rejected(self):
        self.meta['url'] = 'https://attacker.example'
        (self.repo / '.weft/space.json').write_text(json.dumps(self.meta))
        self.assertIsNone(self.links().link(str(self.repo)))
        self.assertIsNotNone(self.links(standalone.Settings(trusted_gateways=[self.meta['url']])).link(str(self.repo)))

    def test_loopback_boundary(self):
        for url in ['http://localhost.attacker.example', 'http://127.0.0.1@attacker.example', 'https://weft-hosted.elier.ai.attacker.example']:
            self.assertFalse(standalone.is_trusted(url, []))
        self.assertTrue(standalone.is_trusted('http://127.0.0.1:7878', []))

    def test_shared_token_does_not_merge_checkout_changes(self):
        opts = {'gateway_url': standalone.LOCAL_URL, 'repo': 'shop', 'project_dirs': [str(self.root)], 'agent': 'same-agent'}
        cfg = A.Config.standalone(lambda k, d: opts.get(k, d), lambda n: 'fixture', 'test')
        other = self.root / 'other'
        other.mkdir()
        subprocess.run(['git', 'init', '-q', str(other)], check=True)
        router = A.WeftRouter(cfg, client_factory=lambda c: FakeClient(), heartbeat=False)
        with patch.dict(os.environ, {'HERMES_KANBAN_TASK': '', 'WEFT_HERMES_TASK': '', 'WEFT_HERMES_CHANGE': ''}):
            a, b = router.adapter_at(str(self.repo)), router.adapter_at(str(other))
        self.assertNotEqual(a.change, b.change)
        self.assertNotEqual(a.task, b.task)
        self.assertEqual(a.cfg.agent, b.cfg.agent)
        router.close()

    def test_settings_reload_before_scope_resolution(self):
        opts = {}
        clock = [0.0]
        def load():
            return A.Config.standalone(lambda k, d: opts.get(k, d), lambda n: 'fixture', 'test')
        (self.repo / '.weft/space.json').unlink()
        router = A.WeftRouter(load(), loader=load, clock=lambda: clock[0], heartbeat=False, client_factory=lambda c: FakeClient())
        self.assertIsNone(router.adapter_at(str(self.repo)))
        opts.update(gateway_url=standalone.LOCAL_URL, repo='shop', project_dirs=[str(self.repo)])
        clock[0] = 61
        self.assertIsNotNone(router.adapter_at(str(self.repo)))
        router.close()

    def test_status_hello_failure_is_unreachable(self):
        cfg = A.Config.standalone(lambda k, d: d, lambda n: 'fixture', 'test')
        client = FakeClient()
        client.hello = lambda *a, **k: (_ for _ in ()).throw(RuntimeError('offline'))
        router = A.WeftRouter(cfg, client_factory=lambda c: client, heartbeat=False)
        data = surface.status_data(router, str(self.repo))
        self.assertIs(data['gateway']['reachable'], False)
        router.close()

    def test_inbox_is_valid_json_without_lost_tail(self):
        class Adapter:
            def inbox_now(self):
                return 'x' * 9000 + 'IMPORTANT END'
        class Router:
            def adapter_at(self, directory):
                return Adapter()
        tool = surface.make_tools(lambda: Router())[1]
        data = json.loads(tool['handler']())
        self.assertTrue(data['messages'].endswith('IMPORTANT END'))

    def test_bad_snapshot_does_not_hide_good_snapshot(self):
        directory = status.status_dir(self.root / 'cache')
        directory.mkdir(parents=True)
        (directory / 'bad.json').write_text('{"updated_at":"bad"}')
        (directory / 'nan.json').write_text('{"updated_at":NaN}')
        rec = status.Recorder(directory, {'route': 'a', 'change': 'c'})
        rec.touch()
        self.assertEqual(len(status.read_all(self.root / 'cache')), 1)
        self.assertEqual(rec.path.stat().st_mode & 0o777, 0o600)

    def test_snapshot_paths_do_not_collide(self):
        a = status.Recorder(self.root, {'route': '/a', 'change': 'same-change-longer-than24'})
        b = status.Recorder(self.root, {'route': '/b', 'change': 'same-change-longer-than24'})
        self.assertNotEqual(a.path, b.path)

    def test_python_nested_method_dependency(self):
        (self.repo / 'provider.py').write_text('class Service:\n    def m(self): pass\n')
        for use in ['from provider import Service\ndef use(): return Service.m()\n', 'import provider\ndef use(): return provider.Service.m()\n']:
            reads, writes = pyanalyze.analyze_file('consumer.py', '', use, str(self.repo))
            self.assertIn('provider.py#Service.m', reads)

    def test_python_src_layout(self):
        pkg = self.repo / 'src/pkg'
        pkg.mkdir(parents=True)
        (pkg / 'util.py').write_text('def f(): pass\n')
        reads, _ = pyanalyze.analyze_file('src/pkg/a.py', '', 'from pkg.util import f\ndef call(): return f()\n', str(self.repo))
        self.assertIn('src/pkg/util.py#f', reads)

    def test_python_signature_and_body(self):
        reads, writes = pyanalyze.analyze_file('pricing.py', 'def f(x):\n return x\n', 'def f(x,y):\n return x+y\n')
        self.assertEqual(writes, [{'key': 'pricing.py#f', 'kind': 'signature'}])
        self.assertIsNone(pyanalyze.analyze_file('pricing.py', '', 'def broken('))

    def test_setup_local_does_not_inherit_previous_hosted_default(self):
        with patch.object(surface.cli, 'run', return_value=(0, 'ready')) as run:
            surface._setup(str(self.repo), hosted=False)
            self.assertIn('--local', run.call_args.args[0])
            surface._setup(str(self.repo), hosted=True)
            self.assertIn('--hosted', run.call_args.args[0])
            self.assertNotIn('--local', run.call_args.args[0])

    def test_cli_scrubs_parent_credentials_and_disables_metrics(self):
        from weft import cli
        from types import SimpleNamespace
        with patch.dict(os.environ, {'DUMMY_API_KEY': 'must-not-inherit', 'HERMES_YOLO': '1'}), patch.object(cli, 'node_problem', return_value=None), patch.object(cli.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='ok', stderr='')) as run:
            self.assertEqual(cli.run(['status'], str(self.repo)), (0, 'ok'))
            env = run.call_args.kwargs['env']
            self.assertNotIn('DUMMY_API_KEY', env)
            self.assertNotIn('HERMES_YOLO', env)
            self.assertEqual(env['WRANGLER_SEND_METRICS'], 'false')
            self.assertIn('@celador/weft@0.3.0', run.call_args.args[0])

    def test_transport_refuses_redirects(self):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from weft.wcp import WcpClient, WcpError
        class Handler(BaseHTTPRequestHandler):
            seen = []
            def log_message(self, *args):
                pass
            def do_GET(self):
                self.seen.append(self.path)
                self.send_response(302)
                self.send_header('Location', '/credential-sink')
                self.end_headers()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = WcpClient(f'http://127.0.0.1:{server.server_port}', 'fixture', 'shop')
            with self.assertRaises(WcpError):
                client._request('GET', '/redirect')
            self.assertEqual(Handler.seen, ['/v1/redirect'])
        finally:
            server.shutdown()
            server.server_close()

    def test_sensitive_files_out_of_edit_scope(self):
        cfg = A.Config.standalone(lambda k, d: d, lambda n: 'fixture', 'test')
        scope = cfg.scope()
        for name in ['.env', '.env.production', '.weft/token', '.hermes/auth.json', '.ssh/id_rsa', 'private.key', 'identity.pem']:
            self.assertIsNone(scope.resolve(str(self.repo / name)), name)

    def test_disabled_setting_retires_existing_router(self):
        import weft.adapter as mod
        class Router:
            closed = False
            def close(self):
                self.closed = True
        router = Router()
        with patch.object(mod, '_ADAPTER', router), patch.object(mod, '_LOADED', True), patch.object(mod, '_GET_CONFIG', lambda k, d: False if k == 'enabled' else d):
            self.assertIsNone(mod.get_adapter())
            import time
            deadline = time.monotonic() + 1
            while not router.closed and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(router.closed)

    def test_installer_copy_set_imports(self):
        # Build only the installer's file set in an isolated directory; no actual install or enable.
        import importlib.util
        spec = importlib.util.spec_from_file_location('weft_install_fixture', PKG / 'scripts/install.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        import shutil
        dest = self.root / 'install/weft'
        dest.mkdir(parents=True)
        for name in mod.PLUGIN_FILES:
            shutil.copy2(PKG / 'plugin/weft' / name, dest / name)
        shutil.copy2(PKG / 'installer/legacy_config.py', dest / 'legacy_config.py')
        p = subprocess.run([sys.executable, '-c', 'import weft; import weft.legacy_config'], cwd=dest.parent, capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)


if __name__ == '__main__':
    unittest.main()
