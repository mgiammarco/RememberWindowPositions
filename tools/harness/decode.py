#!/usr/bin/env python3
"""Decode RememberWindowPositions blobs from ~/.config/kde.org/kwin.conf.

QSettings quoting: value wrapped in "...", with \" and \\ escaping.
Decode order matters: strip quotes, then \\ -> \, \" -> ", THEN json.loads.
"""
import json, os, re, sys

conf = os.path.expanduser("~/.config/kde.org/kwin.conf")

def get_raw(key):
    text = open(conf, encoding="utf-8", errors="replace").read()
    m = re.search(r'^' + re.escape(key) + r'=(.*)$', text, re.MULTILINE)
    return m.group(1) if m else None

def unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        v = v[1:-1]
    return v.replace('\\\\', '\x00').replace('\\"', '"').replace('\x00', '\\')

def load(key):
    v = get_raw(key)
    return json.loads(unquote(v)) if v is not None else None

if __name__ == "__main__":
    cur = load("rememberwindowpositions_windows") or {}
    hist = load("rememberwindowpositions_windowsHistory") or []
    clean = get_raw("rememberwindowpositions_cleanShutdown")
    print(f"cleanShutdown raw: {clean!r}")
    total = sum(len(w.get('s', [])) for w in cur.values())
    print(f"current: {len(cur)} apps, {total} windows")
    for n, v in enumerate(hist):
        blob = json.loads(v['d']) if isinstance(v.get('d'), str) else v.get('d', {})
        wins = sum(len(w.get('s', [])) for w in blob.values())
        print(f"v-{n+1}: t={v.get('t')} session={v.get('s', '(none)')} windows={wins}")
