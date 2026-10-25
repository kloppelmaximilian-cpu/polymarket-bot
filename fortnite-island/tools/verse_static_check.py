#!/usr/bin/env python3
"""Static checker for the Sky Heist Verse files against Epic's Verse API digests.

This is NOT the Verse compiler. UEFN (and its compiler) only runs on Windows
and is not available in the environment this project was built in. What this
tool does instead:

  1. Parses Epic's generated digest files (Fortnite.digest.verse,
     Verse.digest.verse, UnrealEngine.digest.verse) into a symbol table:
     modules, classes/interfaces/structs/enums with parents and members,
     free functions, extension methods, effect specifiers and annotations
     (@experimental, @deprecated, @available).
  2. Parses the project's .verse files (classes, fields, methods, locals).
  3. For every expression chain in every function body it resolves the type of
     the receiver step by step and reports:
       - members that do not exist on the resolved type (or its parents),
       - <decides> functions called with () instead of [] and vice versa,
       - failable calls / indexing outside a failure context,
       - <suspends> calls from non-suspending functions,
       - calls without rollback support from <transacts>/<computes> code,
       - experimental or deprecated APIs,
       - digest symbols whose module is not imported with `using`,
       - wrong argument counts for digest functions,
       - names that cannot be resolved at all,
     plus formatting checks (tabs, indentation, unbalanced brackets).

Anything the checker cannot resolve is listed explicitly as UNRESOLVED so a
human can review it. A clean run means "consistent with the digest API and
with the checked rules", not "compiles".

Usage:
    python3 verse_static_check.py <digest-dir> <verse-dir> [--report out.md]

<digest-dir> must contain Fortnite/Fortnite.digest.verse,
Verse/Verse.digest.verse and UnrealEngine/UnrealEngine.digest.verse, e.g.
https://github.com/vz-creates/uefn/tree/main/Modules/FortniteGame
"""
import os
import re
import sys
from collections import defaultdict

ROOT_MODULES = {"/Verse.org/Verse"}
ROLLBACK_EFFECTS = {"transacts", "computes", "converges", "reads", "allocates", "writes"}
KEYWORDS = {
    "if", "else", "then", "for", "loop", "break", "return", "set", "var", "not", "and", "or",
    "spawn", "sync", "race", "rush", "branch", "block", "option", "array", "map", "true", "false",
    "Self", "external", "using", "class", "struct", "enum", "interface", "module", "where",
    "defer", "case", "continue",
}
BUILTIN_TYPES = {"int", "float", "logic", "string", "message", "char", "void", "any", "comparable",
                 "type", "rational", "char8", "char32", "tuple", "subtype", "castable_subtype"}
# Language intrinsics that are not declared in any digest.
INTRINSIC_FUNCTIONS = {"option", "array", "map"}
INTRINSIC_TYPES = {"weak_map", "event", "listenable", "cancelable", "awaitable", "task", "generator"}


# ---------------------------------------------------------------------------
# Generic helpers
# ---------------------------------------------------------------------------

def strip_qualifier(text):
    """'(/Verse.org/SpatialMath:)vector3' -> 'vector3' (also inside types)."""
    return re.sub(r"\(/[^():]*:\)", "", text)


def matching(text, start, open_ch, close_ch):
    """Index of the bracket closing text[start] (which is open_ch), or -1."""
    depth = 0
    i = start
    in_str = False
    while i < len(text):
        ch = text[i]
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def split_top(text, sep=","):
    parts, depth, current, in_str = [], 0, [], False
    for ch in text:
        if in_str:
            current.append(ch)
            if ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == sep and depth == 0:
            parts.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
    tail = "".join(current).strip()
    if tail:
        parts.append(tail)
    return parts


def paren_balance(text):
    balance, in_str = 0, False
    for ch in text:
        if in_str:
            if ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "(":
            balance += 1
        elif ch == ")":
            balance -= 1
    return balance


def strip_comment(line):
    """Remove a trailing '# comment' that is not inside a string."""
    in_str = False
    for i, ch in enumerate(line):
        if in_str:
            if ch == "\\":
                continue
            if ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch == "#":
            return line[:i]
    return line


def mask_strings(line):
    """Replace string contents by spaces, but keep {interpolations} visible."""
    out, i, in_str = [], 0, False
    while i < len(line):
        ch = line[i]
        if not in_str:
            out.append(ch)
            if ch == '"':
                in_str = True
            i += 1
            continue
        if ch == "\\" and i + 1 < len(line):
            out.append("  ")
            i += 2
            continue
        if ch == '"':
            out.append(ch)
            in_str = False
            i += 1
            continue
        if ch == "{":
            end = matching(line, i, "{", "}")
            if end > 0:
                out.append("(" + line[i + 1:end] + ")")
                i = end + 1
                continue
        out.append(" ")
        i += 1
    return "".join(out)


def parse_effects(spec):
    return set(re.findall(r"<([a-z_]+)>", spec or ""))


def parse_params(text):
    """'A:int, ?B:float = x' -> [(name, type, optional)]"""
    params = []
    for part in split_top(text):
        if not part:
            continue
        optional = part.startswith("?")
        part = part.lstrip("?")
        if ":" in part:
            name, _, rest = part.partition(":")
            ptype = rest.split("=")[0].strip()
            params.append((name.strip(), strip_qualifier(ptype), optional or "=" in rest))
        else:
            params.append((part.strip(), "", optional))
    return params


# ---------------------------------------------------------------------------
# Digest model
# ---------------------------------------------------------------------------

class Symbol:
    def __init__(self, name, kind, module, owner=None, params=None, effects=None, rtype="",
                 annotations=None, line=0, source=""):
        self.name = name
        self.kind = kind            # method | field | function | extension | constant | enumvalue
        self.module = module
        self.owner = owner          # owning type name (methods/fields) or receiver type (extensions)
        self.params = params or []  # list of (name, type, optional)
        self.has_params = params is not None
        self.effects = effects or set()
        self.rtype = rtype
        self.annotations = annotations or set()
        self.line = line
        self.source = source


class TypeDef:
    def __init__(self, name, kind, module, parents, annotations, line, source, specs=""):
        self.name = name
        self.kind = kind
        self.module = module
        self.parents = parents
        self.annotations = annotations
        self.line = line
        self.source = source
        self.specs = specs
        self.members = defaultdict(list)
        self.enum_values = set()


class Digest:
    def __init__(self):
        self.types = defaultdict(list)       # name -> [TypeDef]
        self.functions = defaultdict(list)   # name -> [Symbol]
        self.extensions = defaultdict(list)  # name -> [Symbol]
        self.constants = defaultdict(list)   # name -> [Symbol] (module-level values)
        self.modules = {}                    # path -> short name

    # -- parsing -----------------------------------------------------------

    def load(self, path, root):
        with open(path, encoding="utf-8") as handle:
            lines = handle.read().split("\n")
        source = os.path.basename(path)
        self.root = root
        stack = []  # (kind, name, module_path, typedef, depth_when_opened)
        depth = 0
        pending_path = None
        pending_ann = set()
        i = 0
        while i < len(lines):
            raw = lines[i]
            stripped = raw.strip()
            lineno = i + 1
            if not stripped:
                i += 1
                continue
            if stripped.startswith("#") or stripped.startswith("<#") or stripped.startswith("#>"):
                m = re.match(r"#\s*Module import path:\s*(\S+)", stripped)
                if m:
                    pending_path = m.group(1)
                i += 1
                continue
            if stripped.startswith("@"):
                if stripped.startswith("@experimental"):
                    pending_ann.add("experimental")
                elif stripped.startswith("@deprecated"):
                    pending_ann.add("deprecated")
                elif stripped.startswith("@available"):
                    m = re.search(r"MinUploadedAtFNVersion\s*:=\s*(\d+)", stripped)
                    if m:
                        pending_ann.add("available:" + m.group(1))
                i += 1
                continue
            stmt = raw
            while paren_balance(stmt) > 0 and i + 1 < len(lines):
                i += 1
                stmt += " " + lines[i].strip()
            current_module = stack[-1][2] if stack else ""
            current_type = None
            for entry in reversed(stack):
                if entry[3] is not None:
                    current_type = entry[3]
                    break
            in_type_body = bool(stack) and stack[-1][3] is not None
            opened = self._classify(stmt.strip(), current_module, current_type if in_type_body else None,
                                    pending_path, pending_ann, lineno, source, stack, depth)
            if opened == "module":
                pending_path = None
            pending_ann = set()
            depth += stmt.count("{") - stmt.count("}")
            while stack and depth <= stack[-1][4]:
                stack.pop()
            i += 1

    def _classify(self, stmt, module, current_type, pending_path, ann, lineno, source, stack, depth):
        # enum value lines
        if current_type is not None and current_type.kind == "enum":
            if re.fullmatch(r"[A-Za-z_]\w*", stmt):
                current_type.enum_values.add(stmt)
                return None
        # type / module definitions: [(/qual:)]Name<specs>[(generic params)] := kind<specs>[(parents)] {
        m = None
        hm = re.match(r"(\(/[^():]*:\))?([A-Za-z_]\w*)((?:<[^<>]*>)*)\s*", stmt)
        if hm:
            pos = hm.end()
            if pos < len(stmt) and stmt[pos] == "(":
                gend = matching(stmt, pos, "(", ")")
                pos = gend + 1 if gend > 0 else pos
            km = re.match(r"\s*:=\s*(class|interface|struct|enum|module)((?:<[^<>]*>)*)\s*(.*)$", stmt[pos:])
            if km:
                m = (hm.group(1), hm.group(2), hm.group(3), km.group(1), km.group(2), km.group(3))
        if m and not (stmt.startswith("(") and not m[0]):
            qualifier, name, specs, kind, kspecs, rest = m
            parents = []
            rest = rest.strip()
            if rest.startswith("("):
                end = matching(rest, 0, "(", ")")
                parents = [strip_qualifier(p).split("(")[0].strip() for p in split_top(rest[1:end])]
            if kind == "module":
                if qualifier:
                    path = qualifier[1:-2] + "/" + name
                elif pending_path and pending_path.rstrip("/").split("/")[-1] == name:
                    path = pending_path
                else:
                    path = (module if module else self.root) + "/" + name
                self.modules[path] = name
                if "{" in stmt:
                    stack.append(("module", name, path, None, depth))
                return "module"
            tdef = TypeDef(name, kind, module, parents, set(ann), lineno, source, specs + kspecs)
            self.types[name].append(tdef)
            if "{" in stmt and "}" not in stmt.split("{", 1)[1]:
                stack.append(("type", name, module, tdef, depth))
            return "type"
        # extension method: (Recv: type).Name<...>(params)<effects>: rtype
        if stmt.startswith("("):
            end = matching(stmt, 0, "(", ")")
            if end > 0 and stmt[end + 1:end + 2] == ".":
                recv = stmt[1:end]
                recv_type = strip_qualifier(recv.partition(":")[2]).strip()
                sig = self._parse_signature(stmt[end + 2:])
                if sig:
                    name, params, effects, rtype = sig
                    sym = Symbol(name, "extension", module, owner=recv_type, params=params, effects=effects,
                                 rtype=rtype, annotations=set(ann), line=lineno, source=source)
                    self.extensions[name].append(sym)
                    if current_type is not None:
                        current_type.members[name].append(sym)
                    return "extension"
        # members / functions / constants
        is_var = False
        body = stmt
        if body.startswith("var"):
            mm = re.match(r"var(?:<[^<>]*>)?\s+(.*)$", body)
            if mm:
                is_var = True
                body = mm.group(1)
        if body.startswith("using") or body.startswith("}"):
            return None
        sig = self._parse_signature(body)
        if not sig:
            return None
        name, params, effects, rtype = sig
        if current_type is not None:
            kind = "method" if params is not None else ("var" if is_var else "field")
            sym = Symbol(name, kind, module, owner=current_type.name, params=params, effects=effects,
                         rtype=rtype, annotations=set(ann), line=lineno, source=source)
            current_type.members[name].append(sym)
            return "member"
        kind = "function" if params is not None else "constant"
        sym = Symbol(name, kind, module, params=params, effects=effects, rtype=rtype,
                     annotations=set(ann), line=lineno, source=source)
        (self.functions if params is not None else self.constants)[name].append(sym)
        return kind

    @staticmethod
    def _parse_signature(text):
        """Name<spec>(params)<effects>: type [= ...]  or  Name<spec>: type [= ...]"""
        text = strip_qualifier(text.strip())
        m = re.match(r"([A-Za-z_]\w*|operator'[^']+')((?:<[^<>]*>)*)", text)
        if not m:
            return None
        name = m.group(1)
        pos = m.end()
        params = None
        if pos < len(text) and text[pos] == "(":
            end = matching(text, pos, "(", ")")
            if end < 0:
                return None
            params = parse_params(text[pos + 1:end])
            pos = end + 1
        em = re.match(r"((?:<[^<>]*>)*)\s*:\s*", text[pos:])
        if not em:
            return None
        effects = parse_effects(em.group(1))
        rest = text[pos + em.end():]
        rtype = rest.split(" = ")[0].strip()
        if rtype.endswith("= external {}"):
            rtype = rtype[: -len("= external {}")].strip()
        return name, params, effects, rtype

    # -- queries -------------------------------------------------------------

    def type_defs(self, name):
        return self.types.get(name, [])

    def ancestors(self, name, seen=None):
        """Yield name and all ancestor type names (digest only)."""
        seen = seen if seen is not None else set()
        if name in seen:
            return
        seen.add(name)
        yield name
        for tdef in self.type_defs(name):
            for parent in tdef.parents:
                yield from self.ancestors(parent, seen)


# ---------------------------------------------------------------------------
# Project model (lightweight parser for the project's own Verse subset)
# ---------------------------------------------------------------------------

class Func:
    def __init__(self, name, params, effects, rtype, owner, file, line, body, inline_body=""):
        self.name = name
        self.params = params
        self.effects = effects
        self.rtype = rtype
        self.owner = owner
        self.file = file
        self.line = line
        self.body = body              # list of (lineno, text)
        self.inline_body = inline_body


class ProjClass:
    def __init__(self, name, kind, parents, file, line):
        self.name = name
        self.kind = kind
        self.parents = parents
        self.file = file
        self.line = line
        self.fields = {}      # name -> type
        self.var_fields = set()
        self.methods = defaultdict(list)
        self.enum_values = set()


class Project:
    def __init__(self):
        self.classes = {}
        self.functions = defaultdict(list)
        self.constants = {}
        self.usings = defaultdict(set)
        self.files = {}

    def load(self, path):
        fname = os.path.basename(path)
        with open(path, encoding="utf-8") as handle:
            lines = handle.read().split("\n")
        self.files[fname] = lines
        current_class = None
        pending_func = None
        i = 0
        while i < len(lines):
            raw = lines[i]
            lineno = i + 1
            code = strip_comment(raw).rstrip()
            stripped = code.strip()
            indent = len(code) - len(code.lstrip(" "))
            if not stripped:
                i += 1
                continue
            m = re.match(r"using\s*\{\s*(\S+)\s*\}", stripped)
            if m and indent == 0:
                self.usings[fname].add(m.group(1))
                i += 1
                continue
            if stripped.startswith("@editable"):
                rest = stripped[len("@editable"):].strip()
                if not rest:
                    i += 1
                    continue
                stripped = rest
            if indent == 0:
                current_class = None
                m = re.match(r"([A-Za-z_]\w*)\s*:=\s*(class|struct|enum|interface)((?:<[^<>]*>)*)\s*(\(([^)]*)\))?\s*:\s*$", stripped)
                if m:
                    name, kind, _spec, _p, parents = m.groups()
                    pcls = ProjClass(name, kind, [p.strip() for p in (parents or "").split(",") if p.strip()], fname, lineno)
                    self.classes[name] = pcls
                    current_class = pcls
                    i += 1
                    continue
                func, consumed = self._parse_func(lines, i, None, fname, 0)
                if func:
                    self.functions[func.name].append(func)
                    i = consumed
                    continue
                m = re.match(r"(?:var\s+)?([A-Za-z_]\w*)\s*:\s*([^=]+?)\s*=", stripped)
                if m:
                    self.constants[m.group(1)] = m.group(2).strip()
                i += 1
                continue
            if current_class is not None and indent == 4:
                if current_class.kind == "enum" and re.fullmatch(r"[A-Za-z_]\w*", stripped):
                    current_class.enum_values.add(stripped)
                    i += 1
                    continue
                func, consumed = self._parse_func(lines, i, current_class.name, fname, 4)
                if func:
                    current_class.methods[func.name].append(func)
                    i = consumed
                    continue
                m = re.match(r"(?:@editable\s+)?(var\s+)?([A-Za-z_]\w*)\s*:\s*(.+?)\s*(?:=.*)?$", stripped)
                if m:
                    current_class.fields[m.group(2)] = m.group(3).strip()
                    if m.group(1):
                        current_class.var_fields.add(m.group(2))
            i += 1

    @staticmethod
    def _parse_func(lines, i, owner, fname, indent):
        code = strip_comment(lines[i]).rstrip()
        stripped = code.strip()
        m = re.match(r"([A-Za-z_]\w*)((?:<[a-z_]+>)*)\(", stripped)
        if not m:
            return None, i
        start = m.end() - 1
        end = matching(stripped, start, "(", ")")
        if end < 0:
            return None, i
        after = stripped[end + 1:]
        em = re.match(r"((?:<[a-z_]+>)*)\s*:\s*(.+?)\s*=\s*(.*)$", after)
        if not em:
            return None, i
        name = m.group(1)
        specs = parse_effects(m.group(2))
        effects = parse_effects(em.group(1))
        rtype = em.group(2).strip()
        inline = em.group(3).strip()
        params = parse_params(stripped[start + 1:end])
        body = []
        j = i + 1
        while j < len(lines):
            line = lines[j]
            if line.strip() == "":
                j += 1
                continue
            ind = len(line) - len(line.lstrip(" "))
            if ind <= indent:
                break
            body.append((j + 1, line))
            j += 1
        func = Func(name, params, effects | (specs & {"localizes"}), rtype, owner, fname, i + 1, body, inline)
        return func, j


# ---------------------------------------------------------------------------
# Checker
# ---------------------------------------------------------------------------

class Finding:
    def __init__(self, severity, file, line, message):
        self.severity = severity
        self.file = file
        self.line = line
        self.message = message

    def __str__(self):
        return f"{self.severity:10s} {self.file}:{self.line}: {self.message}"


class Checker:
    def __init__(self, digest, project):
        self.d = digest
        self.p = project
        self.findings = []
        self.verified = defaultdict(set)   # api symbol -> files
        self.stats = defaultdict(int)

    def add(self, severity, file, line, message):
        self.findings.append(Finding(severity, file, line, message))

    # -- type helpers ----------------------------------------------------------

    def is_known_type(self, name, fname):
        base = name.strip()
        if base in BUILTIN_TYPES or base in INTRINSIC_TYPES or base in self.p.classes:
            return True
        return bool(self.d.type_defs(base))

    def type_modules(self, name):
        return {t.module for t in self.d.type_defs(name)}

    def parse_type(self, t):
        """Returns (kind, inner...) for '[]T', '[K]V', '?T', 'name(args)', 'name'."""
        t = strip_qualifier((t or "").strip())
        if t.startswith("[]"):
            return ("array", t[2:].strip())
        if t.startswith("["):
            end = matching(t, 0, "[", "]")
            return ("map", t[1:end].strip(), t[end + 1:].strip())
        if t.startswith("?"):
            return ("option", t[1:].strip())
        if t.startswith("type"):
            return ("named", "type", "")
        m = re.match(r"([A-Za-z_]\w*)\s*(\((.*)\))?$", t)
        if m:
            return ("named", m.group(1), m.group(3) or "")
        return ("unknown", t)

    def ancestors_any(self, name):
        """Project + digest ancestors of a type name."""
        seen, queue, out = set(), [name], []
        while queue:
            cur = queue.pop(0)
            if cur in seen:
                continue
            seen.add(cur)
            out.append(cur)
            if cur in self.p.classes:
                queue.extend(self.p.classes[cur].parents)
            for tdef in self.d.type_defs(cur):
                queue.extend(tdef.parents)
        return out

    def find_member(self, type_name, member):
        """Returns ('proj', Func|type) or ('digest', [Symbol]) or None."""
        for anc in self.ancestors_any(type_name):
            if anc in self.p.classes:
                pc = self.p.classes[anc]
                if member in pc.methods:
                    return ("projmethod", pc.methods[member], anc)
                if member in pc.fields:
                    return ("projfield", pc.fields[member], anc)
            for tdef in self.d.type_defs(anc):
                if member in tdef.members:
                    return ("digest", tdef.members[member], anc)
        # extension methods applicable to any ancestor
        exts = [e for e in self.d.extensions.get(member, []) if e.owner in self.ancestors_any(type_name)]
        if exts:
            return ("extension", exts, type_name)
        return None

    def enum_has(self, type_name, value):
        if type_name in self.p.classes:
            return value in self.p.classes[type_name].enum_values
        return any(value in t.enum_values for t in self.d.type_defs(type_name))

    # -- environment -------------------------------------------------------------

    def build_env(self, func):
        env = {}
        for pname, ptype, _opt in func.params:
            env[pname] = ptype
        if func.owner:
            env["Self"] = func.owner
            for anc in self.ancestors_any(func.owner):
                if anc in self.p.classes:
                    for fname_, ftype in self.p.classes[anc].fields.items():
                        env.setdefault(fname_, ftype)
        # two passes so later bindings can use earlier ones
        for _ in range(3):
            for lineno, raw in func.body:
                code = mask_strings(strip_comment(raw))
                self._collect_bindings(code, env, func)
        return env

    def _collect_bindings(self, code, env, func):
        # explicit typed locals: Name:Type = ...
        for m in re.finditer(r"(?:^|[\s(,])(?:var\s+)?([A-Z][A-Za-z0-9_]*)\s*:\s*((?:\[[^\]]*\]|\?)*[a-z_][A-Za-z0-9_]*(?:\([^)]*\))?)\s*=(?!=)", code):
            env[m.group(1)] = m.group(2)
        # for-bindings: (K -> V : Expr) and (X : Expr)
        fm = re.search(r"\bfor\s*\((.*)\)", code)
        if fm:
            for clause in split_top(fm.group(1)):
                cm = re.match(r"([A-Z]\w*)\s*->\s*([A-Z]\w*)\s*:\s*(.+)$", clause)
                if cm:
                    ctype = self.resolve_chain_type(cm.group(3).strip(), env, func)
                    if ctype:
                        k = self.parse_type(ctype)
                        if k[0] == "array":
                            env[cm.group(1)] = "int"
                            env[cm.group(2)] = k[1]
                        elif k[0] == "map":
                            env[cm.group(1)] = k[1]
                            env[cm.group(2)] = k[2]
                    continue
                cm = re.match(r"([A-Z]\w*)\s*:\s*([^=].*)$", clause)
                if cm and not re.match(r"\s*[a-z]", cm.group(2)):
                    ctype = self.resolve_chain_type(cm.group(2).strip(), env, func)
                    if ctype:
                        k = self.parse_type(ctype)
                        if k[0] == "array":
                            env[cm.group(1)] = k[1]
                    continue
                cm = re.match(r"([A-Z]\w*)\s*:=\s*(.+)$", clause)
                if cm:
                    self._bind(cm.group(1), cm.group(2), env, func)
        # := bindings anywhere (if conditions, plain locals)
        for m in re.finditer(r"(?:^|[\s(,])([A-Z][A-Za-z0-9_]*)\s*:=\s*", code):
            rhs = code[m.end():]
            rhs = self._take_expr(rhs)
            self._bind(m.group(1), rhs, env, func)

    @staticmethod
    def _take_expr(text):
        out, depth = [], 0
        for ch in text:
            if ch in "([{":
                depth += 1
            elif ch in ")]}":
                if depth == 0:
                    break
                depth -= 1
            elif ch == "," and depth == 0:
                break
            elif ch == ":" and depth == 0:
                break
            out.append(ch)
        return "".join(out).strip()

    def _bind(self, name, rhs, env, func):
        rhs = rhs.strip()
        if name in env and env[name]:
            return
        if rhs.startswith("if ") or rhs.startswith("if("):
            m = re.search(r"\bthen\s+(.+?)\s+else\b", rhs)
            if m:
                t = self.resolve_chain_type(m.group(1).strip(), env, func)
                if t:
                    env[name] = t
            return
        t = self.resolve_chain_type(rhs, env, func)
        if t:
            env[name] = t

    # -- chain resolution -----------------------------------------------------

    def tokenize_chain(self, expr):
        """'A.B(x)[y]?.C' -> [('id','A'),('member','B'),('call','x'),('fcall','y'),('opt',''),('member','C')]"""
        expr = expr.strip()
        m = re.match(r"([A-Za-z_]\w*)", expr)
        if not m:
            return None, 0
        toks = [("id", m.group(1))]
        pos = m.end()
        while pos < len(expr):
            ch = expr[pos]
            if ch == ".":
                mm = re.match(r"\.([A-Za-z_]\w*)", expr[pos:])
                if not mm:
                    break
                toks.append(("member", mm.group(1)))
                pos += mm.end()
            elif ch == "(":
                end = matching(expr, pos, "(", ")")
                if end < 0:
                    break
                toks.append(("call", expr[pos + 1:end]))
                pos = end + 1
            elif ch == "[":
                end = matching(expr, pos, "[", "]")
                if end < 0:
                    break
                toks.append(("fcall", expr[pos + 1:end]))
                pos = end + 1
            elif ch == "{":
                end = matching(expr, pos, "{", "}")
                if end < 0:
                    break
                toks.append(("archetype", expr[pos + 1:end]))
                pos = end + 1
            elif ch == "?":
                toks.append(("opt", ""))
                pos += 1
            else:
                break
        return toks, pos

    def resolve_chain_type(self, expr, env, func, report=None):
        toks, _ = self.tokenize_chain(expr)
        if not toks:
            if expr.startswith('"'):
                return "string"
            if re.fullmatch(r"-?\d+", expr):
                return "int"
            if re.fullmatch(r"-?\d+\.\d+", expr):
                return "float"
            return None
        return self._walk(toks, env, func, report)

    def _walk(self, toks, env, func, report):
        kind, name = toks[0]
        cur = None
        idx = 1
        fname = func.file if func else ""
        # base identifier
        if name in env:
            cur = env[name]
        elif name in ("true", "false"):
            cur = "logic"
        elif name == "option" and len(toks) > 1 and toks[1][0] == "archetype":
            inner = self.resolve_chain_type(toks[1][1], env, func)
            return "?" + inner if inner else None
        elif name == "array":
            return None
        elif name in self.p.classes and len(toks) > 1 and toks[1][0] == "archetype":
            cur = name
            idx = 2
        elif name in self.p.classes and len(toks) == 1:
            # bare type name, e.g. the indented archetype form 'heist_save:'
            return name
        elif name in self.p.classes and len(toks) > 1 and toks[1][0] == "member" and self.p.classes[name].kind == "enum":
            if report is not None:
                if not self.enum_has(name, toks[1][1]):
                    report("ERROR", f"enum {name} has no value {toks[1][1]}")
            return name
        elif self.d.type_defs(name) and len(toks) > 1 and toks[1][0] == "archetype":
            cur = name
            idx = 2
            if report is not None:
                self.check_type_import(name, func, report)
        elif self.d.type_defs(name) and len(toks) > 1 and toks[1][0] == "member":
            # enum value or static access like orientation.Vertical
            tdefs = self.d.type_defs(name)
            if report is not None:
                self.check_type_import(name, func, report)
                if any(t.kind == "enum" for t in tdefs) and not self.enum_has(name, toks[1][1]):
                    report("ERROR", f"enum {name} has no value {toks[1][1]}")
                self.check_annotations(tdefs[0].annotations, name, report)
            return name
        elif self.d.type_defs(name) and len(toks) > 1 and toks[1][0] == "fcall":
            # cast: player[Agent]
            if report is not None:
                self.check_type_import(name, func, report)
                report("FAILABLE", "")
            cur = name
            idx = 2
        elif name in self.p.functions or (func and func.owner and self.find_member(func.owner, name)) or name in self.d.functions or name in self.d.extensions:
            # call of a free function / own method / implicit-Self extension
            if len(toks) > 1 and toks[1][0] in ("call", "fcall"):
                rtype = self.check_call(name, None, toks[1], func, report, implicit_self=True)
                cur = rtype
                idx = 2
            else:
                # method reference (e.g. passed to Subscribe)
                return "function"
        elif name in self.p.constants:
            cur = self.p.constants[name]
        elif name in self.d.constants:
            syms = self.d.constants[name]
            if report is not None:
                self.check_symbol_import(syms[0], func, report)
                self.check_annotations(syms[0].annotations, name, report)
            cur = syms[0].rtype
        elif name in self.d.modules.values():
            # module access, e.g. NamedColors.White
            if len(toks) > 1 and toks[1][0] == "member":
                member = toks[1][1]
                syms = [s for s in self.d.constants.get(member, []) if s.module.endswith("/" + name)]
                if report is not None:
                    if not syms:
                        report("ERROR", f"module {name} has no member {member}")
                    else:
                        parent = syms[0].module.rsplit("/", 1)[0]
                        imported = self.p.usings.get(fname, set())
                        if syms[0].module not in imported and parent not in imported:
                            report("ERROR", f"{name}.{member}: module {syms[0].module} (or its parent) is not imported")
                        self.verified[f"{name}.{member}"].add(fname)
                return syms[0].rtype if syms else None
            return None
        else:
            if report is not None and name not in KEYWORDS and name not in BUILTIN_TYPES and name not in INTRINSIC_TYPES:
                report("UNRESOLVED", f"name '{name}' could not be resolved")
            return None
        # walk the rest
        while idx < len(toks) and cur is not None:
            tkind, tval = toks[idx]
            ptype = self.parse_type(cur)
            if tkind == "opt":
                if ptype[0] == "option":
                    cur = ptype[1]
                elif ptype[0] == "named" and ptype[1] == "logic":
                    cur = "logic"
                else:
                    if report is not None:
                        report("WARNING", f"'?' applied to non-option type {cur}")
                idx += 1
                continue
            if tkind == "fcall" and ptype[0] in ("array", "map"):
                if report is not None:
                    report("FAILABLE", "")
                cur = ptype[1] if ptype[0] == "array" else ptype[2]
                idx += 1
                continue
            if tkind == "member":
                base_name = ptype[1] if ptype[0] == "named" else None
                if ptype[0] == "array" and tval == "Length":
                    cur = "int"
                    idx += 1
                    continue
                if base_name is None:
                    if report is not None:
                        report("UNRESOLVED", f"member '{tval}' on non-class type {cur}")
                    return None
                found = self.find_member(base_name, tval)
                if not found:
                    if report is not None:
                        report("ERROR", f"type '{base_name}' has no member '{tval}'")
                    return None
                fkind, payload, owner = found
                nxt = toks[idx + 1] if idx + 1 < len(toks) else None
                if fkind in ("projmethod", "digest", "extension") and nxt and nxt[0] in ("call", "fcall"):
                    cur = self.check_call(tval, base_name, nxt, func, report, found=found)
                    idx += 2
                    continue
                if fkind == "projfield":
                    cur = payload
                elif fkind == "digest":
                    syms = payload
                    sym = syms[0]
                    if report is not None:
                        self.check_annotations(sym.annotations, f"{owner}.{tval}", report)
                        self.verified[f"{owner}.{tval}"].add(fname)
                    if sym.kind == "method" and not (nxt and nxt[0] in ("call", "fcall")):
                        cur = "function"
                    else:
                        cur = sym.rtype
                elif fkind == "projmethod":
                    cur = "function"
                else:
                    cur = "function"
                idx += 1
                continue
            if tkind in ("call", "fcall"):
                # calling the result of an expression (rare)
                idx += 1
                continue
            if tkind == "archetype":
                idx += 1
                continue
            break
        return cur

    # -- call checks ---------------------------------------------------------

    def check_call(self, name, recv_type, tok, func, report, implicit_self=False, found=None):
        call_kind, args = tok
        fname = func.file if func else ""
        candidates = []   # (source, effects, params, rtype, annotations, module, label)
        if found is None and implicit_self:
            if func and func.owner:
                found = self.find_member(func.owner, name)
            if not found and name in self.p.functions:
                found = ("projfunc", self.p.functions[name], None)
            if not found and name in self.d.functions:
                found = ("digestfunc", self.d.functions[name], None)
        if not found:
            if report is not None:
                report("UNRESOLVED", f"call '{name}' could not be resolved")
            return None
        fkind, payload, owner = found
        if fkind in ("projmethod", "projfunc"):
            for f in payload:
                candidates.append(("proj", f.effects, f.params, f.rtype, set(), "", f.name))
        elif fkind in ("digest", "digestfunc", "extension"):
            for s in payload:
                if s.has_params:
                    candidates.append(("digest", s.effects, s.params, s.rtype, s.annotations, s.module, s))
            if not candidates:
                # field holding a function type, e.g. events are fields of listenable type
                candidates.append(("digest", set(), [], payload[0].rtype, payload[0].annotations, payload[0].module, payload[0]))
        elif fkind == "projfield":
            return None
        if report is None:
            return strip_qualifier(candidates[0][3]) if candidates else None
        nargs = len(split_top(args)) if args.strip() else 0
        named = len([a for a in split_top(args) if a.strip().startswith("?")])
        positional = nargs - named
        ok = []
        for cand in candidates:
            _src, effects, params, rtype, ann, module, sym = cand
            required = len([p for p in params if not p[2]])
            total = len(params)
            if cand[0] == "digest" and isinstance(sym, Symbol) and not sym.has_params:
                ok.append(cand)
                continue
            if required <= positional <= total or (positional == 0 and required == 0):
                ok.append(cand)
        if not ok:
            label = f"{recv_type + '.' if recv_type else ''}{name}"
            report("ERROR", f"no overload of {label} takes {positional} positional argument(s)")
            ok = candidates
        cand = ok[0]
        _src, effects, params, rtype, ann, module, sym = cand
        label = f"{(owner or recv_type) + '.' if (owner or recv_type) else ''}{name}"
        decides = "decides" in effects
        if call_kind == "fcall" and not decides:
            report("ERROR", f"{label} is not <decides> but is called with []")
        if call_kind == "call" and decides:
            report("ERROR", f"{label} is <decides> and must be called with []")
        if decides:
            report("FAILABLE", "")
        if "suspends" in effects:
            report("SUSPENDS", label)
        if not (effects & ROLLBACK_EFFECTS or "decides" in effects and effects & ROLLBACK_EFFECTS):
            report("NO_ROLLBACK", label)
        if isinstance(sym, Symbol):
            self.check_annotations(ann, label, report)
            if fkind in ("digestfunc", "extension"):
                self.check_symbol_import(sym, func, report)
            self.verified[label].add(fname)
            self.stats["digest_calls"] += 1
        else:
            self.stats["project_calls"] += 1
        return strip_qualifier(rtype)

    def check_symbol_import(self, sym, func, report):
        fname = func.file if func else ""
        module = sym.module
        if not module or module in ROOT_MODULES:
            return
        if module not in self.p.usings.get(fname, set()):
            report("ERROR", f"'{sym.name}' lives in {module}, which is not imported in {fname}")

    def check_type_import(self, name, func, report):
        fname = func.file if func else ""
        if name in self.p.classes or name in BUILTIN_TYPES or name in INTRINSIC_TYPES:
            return
        mods = self.type_modules(name)
        if not mods or mods & ROOT_MODULES:
            return
        if not mods & self.p.usings.get(fname, set()):
            report("ERROR", f"type '{name}' lives in {sorted(mods)}, none imported in {fname}")

    def check_annotations(self, ann, label, report):
        if "experimental" in ann:
            report("ERROR", f"{label} is @experimental (blocks publishing)")
        if "deprecated" in ann:
            report("WARNING", f"{label} is @deprecated")

    # -- line-level analysis ----------------------------------------------------

    def chains_in(self, code):
        """Yield (start, expr) for every postfix chain starting with an identifier."""
        i = 0
        while i < len(code):
            m = re.compile(r"[A-Za-z_]\w*").match(code, i)
            if m and (i == 0 or not (code[i - 1].isalnum() or code[i - 1] in "_.'")):
                toks, length = self.tokenize_chain(code[i:])
                if toks:
                    yield i, code[i:i + length]
                    # continue right after the head identifier so chains nested
                    # inside call arguments / indices are analysed as well
                    i = m.end()
                    continue
            i += 1

    def failure_context_spans(self, code):
        """Character spans of if(...)/for(...) conditions and failure-context
        bodies on this line."""
        spans = []
        for m in re.finditer(r"\b(if|for)\s*\(", code):
            start = m.end() - 1
            end = matching(code, start, "(", ")")
            if end > 0:
                spans.append((start, end))
        return spans

    def check_function(self, func):
        env = self.build_env(func)
        decides_fn = "decides" in func.effects
        suspends_fn = "suspends" in func.effects
        rollback_fn = bool(func.effects & ROLLBACK_EFFECTS)
        body = list(func.body)
        if func.inline_body:
            body = [(func.line, " " * 99 + func.inline_body)] + body
        self.check_set_targets(func, body, env)
        for lineno, raw in body:
            code = mask_strings(strip_comment(raw)).rstrip()
            if not code.strip():
                continue
            code = self.check_and_mask_annotations(code, func, lineno)
            spans = self.failure_context_spans(code)
            in_spawn = "spawn" in code
            for start, expr in self.chains_in(code):
                head = re.match(r"[A-Za-z_]\w*", expr).group(0)
                if head in KEYWORDS and head not in ("option", "Self"):
                    continue
                # skip the declared name in 'Name:Type =' and 'Name :=' and named args
                after = code[start + len(expr):].lstrip()
                if after.startswith(":=") or (after.startswith(":") and not after.startswith(":=") and re.match(r":\s*[\[\?a-z]", after)):
                    if "." not in expr and "(" not in expr and "[" not in expr:
                        continue
                if code[:start].rstrip().endswith("?") and code[max(0, start - 1)] == "?":
                    continue
                before = code[:start]
                if re.search(r"\?\s*$", before):
                    continue
                problems = []

                def report(sev, msg, _p=problems):
                    _p.append((sev, msg))

                self.resolve_chain_type(expr, env, func, report)
                for sev, msg in problems:
                    if sev == "FAILABLE":
                        inside = any(s <= start <= e for s, e in spans)
                        is_set_target = re.search(r"\bset\s+$", before) is not None
                        if not (inside or decides_fn):
                            if is_set_target:
                                self.add("ERROR", func.file, lineno, f"'set {expr}' indexes a container outside a failure context")
                            else:
                                self.add("ERROR", func.file, lineno, f"failable expression '{expr}' outside a failure context")
                    elif sev == "SUSPENDS":
                        if not suspends_fn and not in_spawn:
                            self.add("ERROR", func.file, lineno, f"<suspends> call {msg} in non-suspending function {func.name}")
                    elif sev == "NO_ROLLBACK":
                        inside = any(s <= start <= e for s, e in spans)
                        if rollback_fn or decides_fn:
                            self.add("ERROR", func.file, lineno, f"{msg} has no rollback-safe effect but is called from <{'/'.join(sorted(func.effects))}> function {func.name}")
                        elif inside:
                            self.add("ERROR", func.file, lineno, f"{msg} has no rollback-safe effect but is called inside a failure context")
                    else:
                        self.add(sev, func.file, lineno, msg)
                self.stats["chains"] += 1

    def check_set_targets(self, func, body, env):
        """'set X = ...' needs X to be a var local or var field."""
        local_vars, local_consts = set(), set()
        for lineno, raw in body:
            code = mask_strings(strip_comment(raw))
            for m in re.finditer(r"\bvar\s+([A-Z]\w*)\s*:", code):
                local_vars.add(m.group(1))
            for m in re.finditer(r"(?:^|[\s(,])([A-Z]\w*)\s*(?::\s*[^=]+?)?\s*:?=(?!=)", code):
                if not re.search(r"\bvar\s+" + m.group(1) + r"\b", code) and not re.search(r"\bset\s+" + m.group(1) + r"\b", code):
                    local_consts.add(m.group(1))
        param_names = {p[0] for p in func.params}
        for lineno, raw in body:
            code = mask_strings(strip_comment(raw))
            for m in re.finditer(r"\bset\s+([A-Za-z_][\w.]*)(\[[^\]]*\])?\s*(\+=|-=|\*=|=)", code):
                target = m.group(1)
                parts = target.split(".")
                if len(parts) == 1:
                    name = parts[0]
                    if name in local_vars:
                        continue
                    if name in param_names:
                        self.add("ERROR", func.file, lineno, f"cannot 'set' parameter {name}")
                        continue
                    owner = self.field_owner(func.owner, name) if func.owner else None
                    if owner is not None:
                        if name not in self.p.classes[owner].var_fields:
                            self.add("ERROR", func.file, lineno, f"'set {name}' but field {owner}.{name} is not declared var")
                        continue
                    if name in self.p.constants:
                        decl = [l for l in self.p.files.get(func.file, []) if re.match(r"var\s+" + name + r"\b", l)]
                        if not decl and not any(re.match(r"var\s+" + name + r"\b", l) for lines in self.p.files.values() for l in lines):
                            self.add("ERROR", func.file, lineno, f"'set {name}' but module constant {name} is not var")
                        continue
                    if name in local_consts:
                        self.add("ERROR", func.file, lineno, f"'set {name}' but local {name} is not declared var")
                    else:
                        self.add("UNRESOLVED", func.file, lineno, f"'set {name}': declaration not found")
                else:
                    base_type = self.resolve_chain_type(".".join(parts[:-1]), env, func)
                    base = self.parse_type(base_type)[1] if base_type else None
                    owner = self.field_owner(base, parts[-1]) if base else None
                    if owner is None:
                        if base and self.d.type_defs(base):
                            syms = [sym for t in self.d.ancestors(base) for td in self.d.type_defs(t) for sym in td.members.get(parts[-1], [])]
                            if syms and not any(sym.kind == "var" for sym in syms):
                                self.add("ERROR", func.file, lineno, f"'set {target}' but {base}.{parts[-1]} is not var")
                            continue
                        self.add("UNRESOLVED", func.file, lineno, f"'set {target}': field not found")
                    elif parts[-1] not in self.p.classes[owner].var_fields:
                        self.add("ERROR", func.file, lineno, f"'set {target}' but field {owner}.{parts[-1]} is not declared var")

    def field_owner(self, type_name, field):
        for anc in self.ancestors_any(type_name or ""):
            if anc in self.p.classes and field in self.p.classes[anc].fields:
                return anc
        return None

    TYPE_ANNOTATION = re.compile(r"(\b[A-Z]\w*\s*:\s*)((?:\[[^\]]*\]|\?)*[a-z_][A-Za-z0-9_]*(?:\([^)]*\))?)(?=\s*=(?!=))")

    def check_and_mask_annotations(self, code, func, lineno):
        """Validate the type in 'Name:type =' and blank it out so the type name
        is not mistaken for an expression."""
        def repl(m):
            ttext = m.group(2)
            for name in re.findall(r"[a-z_][a-z0-9_]*", strip_qualifier(ttext)):
                if not self.is_known_type(name, func.file):
                    self.add("ERROR", func.file, lineno, f"unknown type '{name}' in local declaration")
                elif self.d.type_defs(name) and name not in self.p.classes and name not in BUILTIN_TYPES:
                    mods = self.type_modules(name)
                    if not (mods & ROOT_MODULES) and not (mods & self.p.usings.get(func.file, set())):
                        self.add("ERROR", func.file, lineno, f"type '{name}' needs one of {sorted(mods)} imported")
                    self.verified[name].add(func.file)
            return m.group(1) + " " * len(ttext)
        return self.TYPE_ANNOTATION.sub(repl, code)

    # -- formatting ------------------------------------------------------------

    def check_format(self, fname, lines):
        in_block_comment = False
        for idx, raw in enumerate(lines, start=1):
            if "\t" in raw:
                self.add("ERROR", fname, idx, "tab character (use 4 spaces)")
            if raw.rstrip() != raw:
                self.add("STYLE", fname, idx, "trailing whitespace")
            if raw.strip().startswith("<#"):
                in_block_comment = True
            if in_block_comment:
                if "#>" in raw:
                    in_block_comment = False
                continue
            code = strip_comment(raw)
            if not code.strip():
                continue
            indent = len(code) - len(code.lstrip(" "))
            if indent % 4 != 0:
                self.add("ERROR", fname, idx, f"indentation of {indent} spaces is not a multiple of 4")
            masked = mask_strings(code)
            if masked.count('"') % 2:
                self.add("ERROR", fname, idx, "unbalanced string quotes")
            for o, c in ("()", "[]", "{}"):
                if masked.count(o) != masked.count(c):
                    self.add("ERROR", fname, idx, f"unbalanced '{o}{c}' on line")
            stripped = masked.strip()
            if re.match(r"(else\s+)?if\s*\(", stripped):
                end = matching(stripped, stripped.index("("), "(", ")")
                tail = stripped[end + 1:].strip()
                if not (tail.startswith(":") or tail.startswith("then") or tail.startswith("{")):
                    self.add("ERROR", fname, idx, "if (...) must be followed by ':', 'then' or '{'")
            if re.match(r"for\s*\(", stripped):
                end = matching(stripped, stripped.index("("), "(", ")")
                tail = stripped[end + 1:].strip()
                if not (tail.startswith(":") or tail.startswith("{")):
                    self.add("ERROR", fname, idx, "for (...) must be followed by ':' or '{'")

    # -- declarations ------------------------------------------------------------

    def check_declarations(self):
        seen = {}
        for name, funcs in self.p.functions.items():
            if len(funcs) > 1:
                sigs = {len(f.params) for f in funcs}
                if len(sigs) < len(funcs):
                    self.add("ERROR", funcs[1].file, funcs[1].line, f"duplicate top-level function {name}")
            seen[name] = funcs[0].file
        for cname, pcls in self.p.classes.items():
            for parent in pcls.parents:
                if not self.is_known_type(parent, pcls.file):
                    self.add("ERROR", pcls.file, pcls.line, f"unknown parent type {parent}")
            for field, ftype in pcls.fields.items():
                for t in re.findall(r"[a-z_][a-z0-9_]*", strip_qualifier(ftype)):
                    if t in ("external",):
                        continue
                    if not self.is_known_type(t, pcls.file):
                        self.add("UNRESOLVED", pcls.file, pcls.line, f"{cname}.{field}: unknown type '{t}'")
                    elif self.d.type_defs(t) and t not in self.p.classes:
                        mods = self.type_modules(t)
                        if not (mods & ROOT_MODULES) and not (mods & self.p.usings.get(pcls.file, set())):
                            self.add("ERROR", pcls.file, pcls.line, f"{cname}.{field}: type '{t}' needs one of {sorted(mods)} imported")
                        for tdef in self.d.type_defs(t):
                            if "experimental" in tdef.annotations:
                                self.add("ERROR", pcls.file, pcls.line, f"{cname}.{field}: type '{t}' is @experimental")
                        self.verified[t].add(pcls.file)
            for mname, funcs in pcls.methods.items():
                for f in funcs:
                    self._check_signature_types(f)
        for funcs in self.p.functions.values():
            for f in funcs:
                self._check_signature_types(f)

    def _check_signature_types(self, f):
        types = [p[1] for p in f.params] + [f.rtype]
        for t in types:
            for name in re.findall(r"[a-z_][a-z0-9_]*", strip_qualifier(t or "")):
                if not self.is_known_type(name, f.file):
                    self.add("UNRESOLVED", f.file, f.line, f"{f.name}: unknown type '{name}' in signature")
                elif self.d.type_defs(name) and name not in self.p.classes:
                    mods = self.type_modules(name)
                    if not (mods & ROOT_MODULES) and not (mods & self.p.usings.get(f.file, set())):
                        self.add("ERROR", f.file, f.line, f"{f.name}: type '{name}' needs one of {sorted(mods)} imported")
                    self.verified[name].add(f.file)

    def run(self):
        for fname, lines in self.p.files.items():
            self.check_format(fname, lines)
        self.check_declarations()
        for funcs in self.p.functions.values():
            for f in funcs:
                self.check_function(f)
        for pcls in self.p.classes.values():
            for funcs in pcls.methods.values():
                for f in funcs:
                    self.check_function(f)
        # de-duplicate
        unique, seen = [], set()
        for f in self.findings:
            key = (f.severity, f.file, f.line, f.message)
            if key not in seen:
                seen.add(key)
                unique.append(f)
        self.findings = sorted(unique, key=lambda f: (f.file, f.line, f.severity))
        return self.findings


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    digest_dir, verse_dir = sys.argv[1], sys.argv[2]
    report_path = None
    if "--report" in sys.argv:
        report_path = sys.argv[sys.argv.index("--report") + 1]
    digest = Digest()
    for rel, root in (("Verse/Verse.digest.verse", "/Verse.org"),
                      ("UnrealEngine/UnrealEngine.digest.verse", "/UnrealEngine.com"),
                      ("Fortnite/Fortnite.digest.verse", "/Fortnite.com")):
        digest.load(os.path.join(digest_dir, rel), root)
    build = ""
    with open(os.path.join(digest_dir, "Fortnite/Fortnite.digest.verse"), encoding="utf-8") as handle:
        for line in handle:
            if "Generated from build" in line:
                build = line.split(":", 1)[1].strip()
                break
    project = Project()
    for fname in sorted(os.listdir(verse_dir)):
        if fname.endswith(".verse"):
            project.load(os.path.join(verse_dir, fname))
    checker = Checker(digest, project)
    findings = checker.run()
    counts = defaultdict(int)
    for f in findings:
        counts[f.severity] += 1
    lines = []
    lines.append(f"Digest build: {build}")
    lines.append(f"Digest symbols: {sum(len(v) for v in digest.types.values())} types, "
                 f"{sum(len(v) for v in digest.functions.values())} functions, "
                 f"{sum(len(v) for v in digest.extensions.values())} extension methods, "
                 f"{len(digest.modules)} modules")
    lines.append(f"Project: {len(project.files)} files, {len(project.classes)} classes, "
                 f"{sum(len(v) for v in project.functions.values())} top-level functions, "
                 f"{sum(len(m) for c in project.classes.values() for m in c.methods.values())} methods")
    lines.append(f"Expression chains analysed: {checker.stats['chains']}, digest calls verified: "
                 f"{checker.stats['digest_calls']}, project calls verified: {checker.stats['project_calls']}")
    lines.append(f"Distinct digest APIs referenced: {len(checker.verified)}")
    lines.append("Findings: " + (", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "none"))
    lines.append("")
    for f in findings:
        lines.append(str(f))
    output = "\n".join(lines)
    print(output)
    if report_path:
        with open(report_path, "w", encoding="utf-8") as handle:
            handle.write("# Verse static check report\n\n```\n" + output + "\n```\n\n")
            handle.write("## Digest APIs referenced by the project\n\n")
            for api in sorted(checker.verified):
                handle.write(f"- `{api}`\n")
    sys.exit(1 if counts.get("ERROR") else 0)


if __name__ == "__main__":
    main()
