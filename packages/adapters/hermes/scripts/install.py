#!/usr/bin/env python3
"""Install / sync / uninstall the Weft Hermes adapter on Hermes profiles.

    python3 packages/adapters/hermes/scripts/install.py                  # every profile, every project
    python3 packages/adapters/hermes/scripts/install.py --sync           # re-scan projects: new repos + tokens
    python3 packages/adapters/hermes/scripts/install.py --profiles backend,arq
    python3 packages/adapters/hermes/scripts/install.py --status
    python3 packages/adapters/hermes/scripts/install.py --uninstall      # undo everything

Projects: every git repo directly under ``--project-dirs`` (default ~/github,~/code) is one Weft
repo named after its directory (sanitized; see ``discover_projects`` in plugin/weft/adapter.py,
which the plugin uses too). Modes are per repo: ``--enforce weft`` (default) blocks on conflicts in
weft; every other repo is ``advise`` (never blocks, never waits on the gateway).

What install does (idempotent):
  1. builds dist/analyze.mjs (bundled @weft/analyzer + typescript; node >= 22) + dist/grammars/
  2. sync: discovers projects, creates each missing Weft repo (POST /v1/admin/repos, admin token
     from --admin-token-file), and issues one agent token per (profile, repo), agent id
     ``hermes-<profile>`` (POST /v1/admin/tokens; agent tokens are single-repo by protocol §3)
  3. writes ~/.config/weft/hermes-adapter.json (mode 600): url, projects, modes, per-profile tokens
  4. backs up each profile's config.yaml to ~/.hermes/cache/backups/weft-plugins-<date>/
  5. copies plugin/weft/* + analyze.mjs + grammars/ into <profile home>/plugins/weft/ (+ INSTALLED.json, no secrets)
  6. enables the plugin: ``hermes [-p <profile>] plugins enable weft --no-allow-tool-override``;
     when it was already enabled and the code changed, ``plugins disable weft`` first, so the
     running gateway (where every ``hermes chat`` turn runs) force-reloads the new code

Sync also issues one system *land* token per repo (``land_tokens.<repo>``, scopes system+observe,
principal weft-pm-land) for auto-land: only the land script the plugin spawns (land.py) and
weft_land.py read it, and drops (revoking) the tokens of projects that no longer exist.
``--trunk REPO=BRANCH`` records a trunk override (``trunks``) for repos whose trunk is not
origin/HEAD / main / master.

``--sync`` runs step 2-3 only (the plugin re-reads the config in every new Hermes process; the
admin token never leaves this script). Projects without a repo are skipped by the plugin.
Uninstall reverses 6 -> 2 for the selected profiles (disables + removes the plugin dir, revokes
the profile's tokens, drops it from the config; deletes the config when empty, after revoking
weft_land.py's system token). Repos are kept. Secrets are never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent
PLUGIN_SRC = PKG / "plugin" / "weft"
PLUGIN_FILES = ["plugin.yaml", "__init__.py", "adapter.py", "wcp.py", "land.py"]
DEFAULT_URL = "https://weft-gateway-preview.elier.ai"
DEFAULT_ADMIN = "~/.config/weft/preview-admin-token"
DEFAULT_PROJECT_DIRS = "~/github,~/code"
CONFIG = Path(os.environ.get("WEFT_HERMES_CONFIG", "~/.config/weft/hermes-adapter.json")).expanduser()

sys.path.insert(0, str(PLUGIN_SRC.parent))
from weft.adapter import discover_projects  # noqa: E402


def hermes_root() -> Path:
    return Path(os.environ.get("HERMES_REAL_HOME", str(Path.home()))) / ".hermes"


def profile_home(profile: str) -> Path:
    root = hermes_root()
    return root if profile == "default" else root / "profiles" / profile


def all_profiles() -> list:
    out = ["default"] if (hermes_root() / "config.yaml").exists() else []
    pdir = hermes_root() / "profiles"
    if pdir.is_dir():
        out += sorted(p.name for p in pdir.iterdir() if (p / "config.yaml").exists())
    return out


def node_bin() -> str:
    for c in ("/opt/homebrew/opt/node@24/bin/node", shutil.which("node") or ""):
        if c and os.path.exists(c):
            return c
    sys.exit("node >= 22 not found")


def admin_call(url: str, admin: str, method: str, path: str, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url.rstrip("/") + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {admin}")
    req.add_header("Content-Type", "application/json")
    req.add_header("WCP-Version", "0.1")
    req.add_header("User-Agent", "weft-hermes-installer/0.2")  # Cloudflare 403s Python-urllib
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as err:
            if err.code >= 500 and attempt < 2:
                time.sleep(1 + attempt)
                continue
            try:
                return err.code, json.loads(err.read() or b"{}")
            except Exception:
                return err.code, None
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            if attempt < 2:
                time.sleep(1 + attempt)
                continue
            return 0, {"error": str(err)}
    return 0, None


def load_config() -> dict:
    try:
        return json.loads(CONFIG.read_text())
    except Exception:
        return {}


def save_config(cfg: dict) -> None:
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(CONFIG.parent, 0o700)
    tmp = CONFIG.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    os.replace(tmp, CONFIG)
    os.chmod(CONFIG, stat.S_IRUSR | stat.S_IWUSR)


LAND_PRINCIPAL = "weft-pm-land"
_SAVE_LOCK = threading.Lock()


def issue_land_token(url: str, admin: str, repo: str):
    """Mint the repo's system land token (scopes system+observe, repos [repo]) and save it under
    ``land_tokens.<repo>``. Returns (entry, None) or (None, error). Used by --sync for every
    project repo and by weft_land.py on first use; the admin token stays in these two scripts."""
    status, body = admin_call(url, admin, "POST", "/v1/admin/tokens",
                              {"principal": LAND_PRINCIPAL, "scopes": ["system", "observe"], "repos": [repo],
                               "label": f"auto-land + PM landings ({repo})"})
    if status != 201 or not isinstance(body, dict):
        return None, f"HTTP {status}"
    entry = {"url": url, "repo": repo, "principal": LAND_PRINCIPAL, "token": body["token"], "token_id": body["info"]["id"]}
    with _SAVE_LOCK:  # --sync mints in parallel
        cfg = load_config()  # re-read: never clobber a concurrent write
        cfg.setdefault("land_tokens", {})[repo] = entry
        save_config(cfg)
    return entry, None


def has_land_token(cfg: dict, url: str, repo: str) -> bool:
    entry = (cfg.get("land_tokens") or {}).get(repo) or {}
    legacy = cfg.get("land") or {}
    return bool((entry.get("token") and entry.get("url") == url)
                or (legacy.get("token") and legacy.get("url") == url and legacy.get("repo") == repo))


def hermes(profile: str, *args: str) -> subprocess.CompletedProcess:
    cmd = ["hermes"] + ([] if profile == "default" else ["-p", profile]) + list(args)
    env = {k: v for k, v in os.environ.items() if not k.startswith("HERMES_KANBAN")}
    env.pop("HERMES_PROFILE", None)
    env["HERMES_HOME"] = str(profile_home(profile))
    return subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=120)


def code_changed(dest: Path, bundle: Path) -> bool:
    """True when the installed plugin code differs from what install is about to copy."""
    pairs = [(PLUGIN_SRC / n, dest / n) for n in PLUGIN_FILES] + [(bundle, dest / "analyze.mjs")]
    try:
        return any(not d.exists() or s.read_bytes() != d.read_bytes() for s, d in pairs)
    except OSError:
        return True


def enabled_in_config(profile: str) -> bool:
    text = (profile_home(profile) / "config.yaml").read_text()
    try:
        import yaml  # type: ignore
        cfg = yaml.safe_load(text) or {}
        return "weft" in ((cfg.get("plugins") or {}).get("enabled") or [])
    except ImportError:
        return "- weft" in text


def build() -> Path:
    out = PKG / "dist" / "analyze.mjs"
    env = dict(os.environ, PATH=f"{Path(node_bin()).parent}:{os.environ.get('PATH', '')}")
    subprocess.run([node_bin(), str(PKG / "scripts" / "build.mjs"), str(out)], check=True, env=env,
                   capture_output=True)
    probe = subprocess.run([node_bin(), str(out)], input='{"files":[{"path":"a.ts","before":"","after":"export const a = 1;"},'
                           '{"path":"b.py","before":"","after":"def b():\\n    return 1\\n"}]}',
                           capture_output=True, text=True, timeout=30)
    if '"ok":true' not in probe.stdout or "b.py#b" not in probe.stdout:
        sys.exit(f"analyzer bundle probe failed (TS + tree-sitter): {probe.stdout} {probe.stderr}")
    return out


def read_admin(args) -> str:
    p = Path(args.admin_token_file).expanduser()
    return p.read_text().strip() if p.exists() else ""


def migrate_entry(entry: dict, legacy_repo: str) -> dict:
    """0.1 entries held one token (for the single repo); 0.2 keeps tokens per repo."""
    tokens = entry.setdefault("tokens", {})
    if entry.get("token") and legacy_repo and legacy_repo not in tokens:
        tokens[legacy_repo] = {"token": entry["token"], "token_id": entry.get("token_id")}
    return entry


def sync(args, cfg: dict) -> dict:
    """Discover projects; create missing repos; issue missing (profile, repo) tokens."""
    admin = read_admin(args)
    if cfg.get("url") and cfg["url"] != args.url:
        print(f"note: switching gateway {cfg['url']} -> {args.url}; existing tokens are dropped")
        cfg["agents"] = {}
    legacy_repo = cfg.get("repo") or "weft"
    dirs = [d.strip() for d in args.project_dirs.split(",") if d.strip()]
    explicit = {r["path"]: r["repo"] for r in (cfg.get("roots") or []) if r.get("repo")}
    projects = discover_projects(dirs, explicit)
    modes = dict(cfg.get("modes") or {})
    if cfg.get("mode") and legacy_repo not in modes:
        modes[legacy_repo] = cfg["mode"]
    for r in args.enforce:
        modes[r] = "enforce"
    trunks = dict(cfg.get("trunks") or {})
    for pair in args.trunk:
        repo_name, _, branch = pair.partition("=")
        if repo_name and branch:
            trunks[repo_name.strip()] = branch.strip()
    cfg.update({
        "url": args.url, "repo": legacy_repo,
        # 0.1 roots (weft + the hermes-ios weft-feed worktree under prefix ios/) are replaced by
        # discovery; only explicit {path, prefix, repo} overrides survive.
        "roots": [r for r in (cfg.get("roots") or []) if r.get("repo")],
        "projects": {"dirs": dirs, "repos": {p: r for p, r in sorted(projects.items())}},
        "exclude": cfg.get("exclude") or ["~/.hermes"],
        "modes": modes, "default_mode": "advise", "node": node_bin(),
        "breaker_cooldown_s": cfg.get("breaker_cooldown_s", 300), "timeout": cfg.get("timeout", 4.0),
        "trunks": trunks,
    })
    cfg.pop("mode", None)
    cfg.setdefault("agents", {})
    repos = sorted(set(projects.values()))
    if not admin:
        sys.exit(f"admin token not found at {args.admin_token_file}")
    status, body = admin_call(args.url, admin, "GET", "/v1/admin/repos")
    if status != 200:
        sys.exit(f"listing repos failed: HTTP {status}")
    existing = {r["repo"] for r in body.get("repos", [])}
    created = []
    for repo in repos:
        if repo in existing:
            continue
        status, body = admin_call(args.url, admin, "POST", "/v1/admin/repos", {"repo": repo})
        if status not in (200, 201):
            sys.exit(f"repo registration failed for {repo}: HTTP {status} {body}")
        created.append(repo)
    print(f"projects: {len(projects)} -> repos: {len(repos)} ({len(created)} created: {', '.join(created) or '-'})")

    jobs = []
    for profile in args.profiles:
        entry = migrate_entry(cfg["agents"].setdefault(profile, {"agent": f"hermes-{profile}"}), legacy_repo)
        entry.setdefault("agent", f"hermes-{profile}")
        for repo in repos:
            if not (entry["tokens"].get(repo) or {}).get("token"):
                jobs.append((profile, repo))

    def issue(job):
        profile, repo = job
        agent = cfg["agents"][profile]["agent"]
        return job, admin_call(args.url, admin, "POST", "/v1/admin/tokens", {
            "principal": agent, "scopes": ["agent"], "repos": [repo], "agent": agent,
            "label": f"hermes adapter ({profile} profile, {repo})"})

    failed = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for n, ((profile, repo), (status, body)) in enumerate(pool.map(issue, jobs), 1):
            if status != 201:
                failed.append(f"{profile}/{repo}: HTTP {status}")
                continue
            cfg["agents"][profile]["tokens"][repo] = {"token": body["token"], "token_id": body["info"]["id"]}
            if n % 50 == 0:
                save_config(cfg)
    for profile in args.profiles:  # keep the 0.1 single-token field for weft (weft_land/verify scripts)
        entry = cfg["agents"][profile]
        legacy = entry["tokens"].get(legacy_repo) or {}
        if legacy.get("token"):
            entry["token"], entry["token_id"] = legacy["token"], legacy.get("token_id")
    save_config(cfg)
    print(f"tokens: issued {len(jobs) - len(failed)} for {len(args.profiles)} profile(s)"
          + (f"; FAILED {len(failed)}: {failed[:5]}" if failed else ""))
    # Auto-land: one system land token per repo, used only by the land script the plugin spawns
    # (plugin/weft/land.py) and weft_land.py. Agent tokens keep scope [agent].
    missing = [r for r in repos if not has_land_token(cfg, args.url, r)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        minted = list(pool.map(lambda r: (r, issue_land_token(args.url, admin, r)), missing))
    land_failed = [f"{r}: {err}" for r, (entry, err) in minted if not entry]
    cfg = load_config()  # issue_land_token saved each token; pick them up
    print(f"land tokens: issued {len(missing) - len(land_failed)} (repos with one: "
          f"{sum(has_land_token(cfg, args.url, r) for r in repos)}/{len(repos)})"
          + (f"; FAILED {len(land_failed)}: {land_failed[:5]}" if land_failed else ""))
    cfg = prune(args, cfg, admin, set(repos) | {legacy_repo}, dirs)
    if failed or land_failed:
        sys.exit(1)
    return cfg


def prune(args, cfg: dict, admin: str, keep: set, dirs: list) -> dict:
    """Revoke and drop the agent + land tokens of repos whose project is gone (a deleted
    throwaway repo). Skipped when a projects dir is missing (unmounted disk): absence proves
    nothing then. The Weft repo itself and its log are kept."""
    if any(not Path(d).expanduser().is_dir() for d in dirs):
        print("prune: skipped (a projects dir is missing)")
        return cfg
    gone = set()
    for entry in (cfg.get("agents") or {}).values():
        gone |= set((entry.get("tokens") or {})) - keep
    gone |= set(cfg.get("land_tokens") or {}) - keep
    gone -= {r.get("repo") for r in (cfg.get("roots") or []) if r.get("repo")}
    revoked = 0
    for repo in sorted(gone):
        ids = []
        for entry in (cfg.get("agents") or {}).values():
            tok = (entry.get("tokens") or {}).pop(repo, None)
            if isinstance(tok, dict) and tok.get("token_id"):
                ids.append(tok["token_id"])
        land = (cfg.get("land_tokens") or {}).pop(repo, None) or {}
        if land.get("token_id"):
            ids.append(land["token_id"])
        (cfg.get("modes") or {}).pop(repo, None)
        (cfg.get("trunks") or {}).pop(repo, None)
        for tid in ids:
            status, _ = admin_call(args.url, admin, "DELETE", f"/v1/admin/tokens/{tid}")
            revoked += status in (200, 204, 404)
    if gone:
        save_config(cfg)
        print(f"prune: {len(gone)} vanished project repo(s) ({', '.join(sorted(gone))}); {revoked} token(s) revoked")
    return cfg


def install(args) -> None:
    cfg = load_config()
    bundle = build()
    print(f"built analyzer bundle ({bundle.stat().st_size // 1024} KiB)")
    cfg = sync(args, cfg)
    backups = hermes_root() / "cache" / "backups" / f"weft-plugins-{time.strftime('%Y%m%d-%H%M%S')}"
    for profile in args.profiles:
        home = profile_home(profile)
        if not (home / "config.yaml").exists():
            sys.exit(f"profile '{profile}' not found at {home}")
        backups.mkdir(parents=True, exist_ok=True)
        shutil.copy2(home / "config.yaml", backups / f"{profile}.config.yaml")
        agent = cfg["agents"][profile]["agent"]
        dest = home / "plugins" / "weft"
        dest.mkdir(parents=True, exist_ok=True)
        was_enabled = enabled_in_config(profile)
        changed = code_changed(dest, bundle)
        for name in PLUGIN_FILES:
            shutil.copy2(PLUGIN_SRC / name, dest / name)
        shutil.copy2(bundle, dest / "analyze.mjs")
        # tree-sitter runtime + grammars: the bundle looks for ./grammars/*.wasm next to itself.
        if (dest / "grammars").exists():
            shutil.rmtree(dest / "grammars")
        shutil.copytree(bundle.parent / "grammars", dest / "grammars")
        grammars = sorted(f"grammars/{p.name}" for p in (dest / "grammars").glob("*.wasm"))
        manifest = {
            "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "source": str(PKG), "profile": profile, "agent": agent, "gateway": args.url,
            "repos": len(cfg["agents"][profile]["tokens"]), "config": str(CONFIG),
            "config_backup": str(backups / f"{profile}.config.yaml"),
            "files": PLUGIN_FILES + ["analyze.mjs"] + grammars,
            "sync": f"python3 {PKG / 'scripts' / 'install.py'} --sync",
            "uninstall": f"python3 {PKG / 'scripts' / 'install.py'} --uninstall --profiles {profile}",
        }
        (dest / "INSTALLED.json").write_text(json.dumps(manifest, indent=2) + "\n")
        reload_note = ""
        if was_enabled and changed:
            # `enable` on an enabled plugin is a no-op, so the running gateway (which runs every
            # `hermes chat` turn, -q included) would keep the old code until it restarts. A
            # disable+enable pair makes it force-reload plugins now (Hermes `reload-plugins`).
            hermes(profile, "plugins", "disable", "weft")
            reload_note = " ; gateway reloaded (disable+enable)"
        res = hermes(profile, "plugins", "enable", "weft", "--no-allow-tool-override")
        ok = enabled_in_config(profile)
        print(f"[{profile}] plugin -> {dest} ; enabled={ok}{reload_note}"
              + ("" if ok else f" ({res.stdout.strip()} {res.stderr.strip()})"))
    print(f"config: {CONFIG} (mode 600); config.yaml backups: {backups}")


def uninstall(args) -> None:
    cfg = load_config()
    admin = read_admin(args)
    for profile in args.profiles:
        res = hermes(profile, "plugins", "disable", "weft")
        dest = profile_home(profile) / "plugins" / "weft"
        if dest.exists():
            shutil.rmtree(dest)
        entry = (cfg.get("agents") or {}).pop(profile, None) or {}
        ids = {t.get("token_id") for t in (entry.get("tokens") or {}).values()} | {entry.get("token_id")}
        ids.discard(None)
        revoked = 0
        if admin and cfg.get("url"):
            for tid in ids:
                status, _ = admin_call(cfg["url"], admin, "DELETE", f"/v1/admin/tokens/{tid}")
                revoked += status == 204
        print(f"[{profile}] disabled ({res.returncode}), removed {dest}; {revoked}/{len(ids)} tokens revoked")
    lands = [cfg.get("land") or {}] + list((cfg.get("land_tokens") or {}).values())
    if not cfg.get("agents") and any(lands):  # last profile gone: also revoke weft_land.py's system tokens
        cfg.pop("land", None)
        cfg.pop("land_tokens", None)
        for land in lands:
            if land.get("token_id") and admin:
                status, _ = admin_call(land.get("url") or cfg.get("url") or args.url, admin, "DELETE",
                                       f"/v1/admin/tokens/{land['token_id']}")
                print(f"land system token {land['token_id']} revoked (HTTP {status})")
    if cfg.get("agents"):
        save_config(cfg)
    elif CONFIG.exists():
        CONFIG.unlink()
        print(f"removed {CONFIG}")


def status(args) -> None:
    cfg = load_config()
    repos = sorted(set(((cfg.get("projects") or {}).get("repos") or {}).values()))
    print(f"config {CONFIG}: {'present' if cfg else 'absent'}; gateway {cfg.get('url')}; "
          f"{len(repos)} project repos; modes {cfg.get('modes')} (default {cfg.get('default_mode')})")
    for profile in args.profiles:
        dest = profile_home(profile) / "plugins" / "weft"
        entry = (cfg.get("agents") or {}).get(profile) or {}
        missing = [r for r in repos if r not in (entry.get("tokens") or {})]
        print(f"[{profile}] plugin dir {'present' if dest.exists() else 'absent'}; enabled={enabled_in_config(profile)}; "
              f"agent={entry.get('agent')} tokens={len(entry.get('tokens') or {})}"
              + (f" missing={missing}" if missing else ""))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--profiles", default="all", help="comma list, or 'all' (default + ~/.hermes/profiles/*)")
    p.add_argument("--url", default=DEFAULT_URL)
    p.add_argument("--project-dirs", default=DEFAULT_PROJECT_DIRS)
    p.add_argument("--enforce", default="weft", help="comma list of repos in enforce mode (others: advise)")
    p.add_argument("--admin-token-file", default=DEFAULT_ADMIN)
    p.add_argument("--trunk", action="append", default=[],
                   help="REPO=BRANCH trunk override for auto-land (default: origin/HEAD, else main, else master)")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--sync", action="store_true", help="re-scan projects: create repos + tokens only")
    g.add_argument("--uninstall", action="store_true")
    g.add_argument("--status", action="store_true")
    args = p.parse_args()
    if args.profiles == "all":
        args.profiles = all_profiles() if not args.uninstall else sorted((load_config().get("agents") or {}))
    else:
        args.profiles = [x.strip() for x in args.profiles.split(",") if x.strip()]
    args.enforce = [x.strip() for x in args.enforce.split(",") if x.strip()]
    if args.sync:
        sync(args, load_config())
    elif args.uninstall:
        uninstall(args)
    elif args.status:
        status(args)
    else:
        install(args)


if __name__ == "__main__":
    main()
