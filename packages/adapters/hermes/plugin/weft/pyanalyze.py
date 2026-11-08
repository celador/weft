"""Built-in Python analyzer: declaration keys from the standard library's ``ast`` (no Node needed).

The Weft sequencer coordinates agents through *symbol keys* (``shop/pricing.py#calc_total``): an
edit WRITES the declarations it changed and READS the cross-file symbols it uses. The full
analyzer (``analyze.mjs``: TypeScript backend plus tree-sitter grammars for 12 languages) is a
build artifact that a catalog install does not contain, so this module gives Python projects the
same symbol-level precision out of the box. Other languages fall back to whole-file keys
(``path#*``) unless a bundle is configured (see ``adapter.Analyzer``).

The output mirrors ``analyze.mjs --serve`` for Python (the tests compare the two when a bundle is
built): the same key shape, the same ``kind`` words (``new`` / ``deleted`` / ``signature`` /
``body``), nested declarations keyed ``Class.method`` / ``func.inner``, a container (class or
function) reported as ``body`` when anything inside it changed, and ``reads`` = in-checkout
symbols a changed declaration uses through ``import`` / ``from ... import``.

Pure functions; never raises (a file that does not parse yields ``None`` and the caller falls back
to a whole-file key).
"""

from __future__ import annotations

import ast
import os
from typing import Dict, List, Optional, Set, Tuple

Decl = Tuple[str, str, str]  # (qualified name, signature fingerprint, body fingerprint)

_FUNCS = (ast.FunctionDef, ast.AsyncFunctionDef)


def _dump(node: Optional[ast.AST]) -> str:
    return "" if node is None else ast.dump(node, include_attributes=False)


def _signature(node: ast.AST) -> str:
    if isinstance(node, _FUNCS):
        return "|".join([_dump(node.args), _dump(node.returns), *(_dump(d) for d in node.decorator_list),
                         type(node).__name__])
    if isinstance(node, ast.ClassDef):
        return "|".join([*(_dump(b) for b in node.bases), *(_dump(k) for k in node.keywords),
                         *(_dump(d) for d in node.decorator_list)])
    return ""


def _body_fp(node: ast.AST) -> str:
    return _dump(node)


def _targets(stmt: ast.stmt) -> List[str]:
    out: List[str] = []
    nodes: List[ast.AST] = []
    if isinstance(stmt, ast.Assign):
        nodes = list(stmt.targets)
    elif isinstance(stmt, (ast.AnnAssign, ast.AugAssign)):
        nodes = [stmt.target]
    for n in nodes:
        if isinstance(n, ast.Name):
            out.append(n.id)
        elif isinstance(n, (ast.Tuple, ast.List)):
            out += [e.id for e in n.elts if isinstance(e, ast.Name)]
    return out


def declarations(tree: ast.Module) -> Dict[str, Tuple[str, str, ast.AST]]:
    """{qualified name: (signature fp, body fp, node)} for module-level variables, functions and
    classes, with class members and nested functions as ``Outer.inner``."""
    out: Dict[str, Tuple[str, str, ast.AST]] = {}

    def walk(body: List[ast.stmt], prefix: str, top: bool) -> None:
        for stmt in body:
            if isinstance(stmt, _FUNCS) or isinstance(stmt, ast.ClassDef):
                name = prefix + stmt.name
                out[name] = (_signature(stmt), _body_fp(stmt), stmt)
                walk(stmt.body, name + ".", False)
            elif top:
                for target in _targets(stmt):
                    out[target] = ("", _dump(stmt), stmt)
                if isinstance(stmt, (ast.If, ast.Try, ast.With)):  # conditional definitions
                    for attr in ("body", "orelse", "finalbody"):
                        walk(getattr(stmt, attr, []) or [], prefix, True)
                    for handler in getattr(stmt, "handlers", []) or []:
                        walk(handler.body, prefix, True)

    walk(tree.body, "", True)
    return out


# ----------------------------------------------------------------------------- imports

class _Imports:
    """Names a file binds through imports that resolve to files inside the checkout."""

    def __init__(self, tree: ast.Module, rel: str, root: str, prefix: str):
        self.symbols: Dict[str, str] = {}   # local name -> "<path>#<name>"
        self.modules: Dict[str, str] = {}   # local name -> module path (attribute access resolves)
        self.imported: Set[str] = set()     # every symbol key an import statement binds
        here = os.path.dirname(rel[len(prefix):]) if prefix and rel.startswith(prefix) else os.path.dirname(rel)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    path = self._module_path(alias.name, 0, here, root)
                    if alias.asname and path:
                        self.modules[alias.asname] = path
                    elif path:  # `import a.b.c` binds `a`; attribute chains resolve the rest
                        self.modules[alias.name.split(".")[0]] = self._module_path(
                            alias.name.split(".")[0], 0, here, root) or ""
                        self.modules[alias.name] = path
            elif isinstance(node, ast.ImportFrom):
                base = self._module_path(node.module or "", node.level, here, root, allow_empty=True)
                for alias in node.names:
                    local = alias.asname or alias.name
                    sub = self._module_path((node.module + "." if node.module else "") + alias.name,
                                            node.level, here, root)
                    if sub:  # `from . import pricing` / `from pkg import util`: a module, not a symbol
                        self.modules[local] = sub
                    elif base:
                        key = f"{self._with_prefix(base, prefix)}#{alias.name}"
                        self.symbols[local] = key
                        self.imported.add(key)

    @staticmethod
    def _with_prefix(path: str, prefix: str) -> str:
        return prefix + path

    @staticmethod
    def _module_path(module: str, level: int, here: str, root: str, allow_empty: bool = False) -> Optional[str]:
        parts = [p for p in module.split(".") if p] if module else []
        if level:
            base = here
            for _ in range(level - 1):
                base = os.path.dirname(base)
        else:
            base = ""
        if not parts and not allow_empty:
            return None
        bases = [base] if level else ["", "src", here]
        if not level:
            parent = here
            while parent:
                parent = os.path.dirname(parent)
                bases.append(parent)
        for base in dict.fromkeys(bases):
            rel = os.path.join(base, *parts) if (base or parts) else ""
            for candidate in (rel + ".py", rel + ".pyi", os.path.join(rel, "__init__.py")):
                full = os.path.realpath(os.path.join(root, candidate))
                if full.startswith(os.path.realpath(root) + os.sep) and os.path.isfile(full):
                    return candidate.replace(os.sep, "/")
        return None


def _used_reads(node: ast.AST, imports: _Imports, prefix: str) -> Set[str]:
    reads: Set[str] = set()

    def chain(n: ast.AST) -> Optional[List[str]]:
        parts: List[str] = []
        while isinstance(n, ast.Attribute):
            parts.append(n.attr)
            n = n.value
        if isinstance(n, ast.Name):
            parts.append(n.id)
            return list(reversed(parts))
        return None

    for n in ast.walk(node):
        if isinstance(n, ast.Name) and n.id in imports.symbols:
            reads.add(imports.symbols[n.id])
        elif isinstance(n, ast.Attribute):
            parts = chain(n)
            if parts and len(parts) >= 2:
                if parts[0] in imports.symbols:
                    reads.add(imports.symbols[parts[0]] + "." + ".".join(parts[1:]))
                # longest module prefix: a.b.c.f -> module a.b.c, name f
                for cut in range(len(parts) - 1, 0, -1):
                    dotted = ".".join(parts[:cut])
                    mod = imports.modules.get(dotted)
                    if mod:
                        reads.add(f"{prefix}{mod}#{'.'.join(parts[cut:])}")
                        break
    return reads


# ----------------------------------------------------------------------------- analysis

def analyze_file(rel: str, before: Optional[str], after: Optional[str], root: Optional[str] = None,
                 prefix: str = "") -> Optional[Tuple[List[str], List[dict]]]:
    """(reads, writes) for one Python file change, or None when it cannot be parsed."""
    try:
        t_before = ast.parse(before or "")
        t_after = ast.parse(after or "")
    except (SyntaxError, ValueError, RecursionError, MemoryError):
        return None
    old, new = declarations(t_before), declarations(t_after)
    writes: List[dict] = []
    changed: List[str] = []
    for name in sorted(set(old) | set(new)):
        if name not in old:
            kind = "new"
        elif name not in new:
            kind = "deleted"
        elif old[name][0] != new[name][0]:
            kind = "signature"
        elif old[name][1] != new[name][1]:
            kind = "body"
        else:
            continue
        writes.append({"key": f"{rel}#{name}", "kind": kind})
        if name in new:
            changed.append(name)
    reads: Set[str] = set()
    if root and t_after.body:
        imports = _Imports(t_after, rel, root, prefix)
        old_imports = _Imports(t_before, rel, root, prefix).imported
        for name in changed:
            reads |= _used_reads(new[name][2], imports, prefix)
        reads |= imports.imported - old_imports  # a newly added import is itself a dependency
    reads -= {w["key"] for w in writes}
    reads = {r for r in reads if not r.startswith(f"{rel}#")}
    return sorted(reads), writes
