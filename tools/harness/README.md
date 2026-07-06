# Offline harness

Mirrors the matching/eviction logic of `src/contents/ui/main.qml` for offline
TDD and regression testing (there is no QML test infrastructure). Functions are
manual mirrors — when you change one in main.qml, update its mirror here.

- `node tools/harness/replay.mjs` — run all tests (exit 0 = pass).
- `python3 tools/harness/decode.py` — inspect the real persisted state in
  `~/.config/kde.org/kwin.conf` (current blob, version history, crash flag).
