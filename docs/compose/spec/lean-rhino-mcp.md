---
feature: lean-rhino-mcp
status: delivered
updated: 2026-10-05
branch: none (working in place, no git — user decision)
commits: n/a (no git — user decision)
---

# Lean Rhino MCP: cleanup + latency optimization

## Report

**What was built** — The rhino-mcp folder went from 775 MB to ~0.07 MB: the
.NET SDK, NuGet caches, the one-off C# plugin, ~70 experiment scripts, old
specs and captures were purged; only the live MCP (server.js, rhino/bridge.py,
bootstrap.py, capture_window.ps1, ping.js, lessons.json, LAYERS.md) plus
scripts/selftest.js remain. The tool registry was lean-ed from 25 to 15 tools.
After two in-flight transport redesigns forced by live crash testing (see
S2.2/S2.4 amendments), the delivered architecture is: server.js (v1.2.0,
MCP stdio ⇄ file queue) and bridge.py (30 ms UI-thread timer polling the
queue; zero background threads, zero sockets inside Rhino). The GitHub
research (jingcheng-chen/rhinomcp, 1127★) is validated and now fully
explained: its C# plugin hosts sockets safely because compiled RhinoCommon
plugins run as native .NET code — IronPython cannot (see S2.2 root cause);
its speed comes from immediate UI-thread dispatch, batching, and persistent
framing, of which batching (one `run_python` call = N objects) transfers to
our design for free.

**Verification** — `node --check server.js` PASS; `ast.parse` bridge.py PASS;
`node scripts/selftest.js` 11/11 PASS (handshake, 15-tool registry, dropped
tools absent, round-trip ~32 ms/call over mock, friendly timeout error at
3 s, recovery, clean queue). Live on Rhino 8.35: status 92 ms, setup_layers
47 ms (29 AIA layers), 25-object tower in one exec 375 ms, get_document
61 ms, zoom 47 ms, screenshot OK; 5-minute idle stability watch PASS with the
bridge still serving in 31 ms afterwards — every socket-based variant crashed
within 30 s–5 min under the same watch. Root-cause bisection table in S2.2.

**Journey log**

- IronPython socket threads inside Rhino = coreclr stack overflow (0xc00000fd,
  both Rhino 8 stable and 9 WIP): a TCP-ONLY bisect (no timer/Idle/invoke)
  crashed Rhino in ~30 s while imports-only and bare Rhino survived. This was
  the real culprit all along — including the twelve 2026-09-26 "WIP
  instability" crashes.
- `RhinoApp.InvokeOnUiThread` from a background thread silently no-ops on
  Rhino 8 (UI-thread probe passes!) — never trust an API probe that doesn't
  run in the real calling context.
- WinForms Timers must be created on a thread with a message loop (review
  catch); `os.replace` is Python 3-only — IronPython 2.7 needs `os.rename`.
- Bisection beats theory: five controlled Rhino launches isolated the culprit
  in one evening after three wrong theories (Idle hook, RhinoCycles, timer).
- Review subagents cannot read outside the session directory; mirror the
  project into the session dir when delegating file review.

## [S1] Problem

The rhino-mcp project folder is 775 MB, of which ~770 MB is leftover experiment
infrastructure (a full .NET 10 SDK, NuGet caches, a one-off C# ZahaHousePlugin,
~70 throwaway build scripts, 3 old specs, 38 old screenshots). The live MCP is
only `server.js` + `rhino/bridge.py` + `scripts/capture_window.ps1`.

The registered tool list (25 tools) contains duplicates (`rhino_layers` vs
`rhino_ensure_layer`, `rhino_document_info` vs `rhino_get_document`), debug/meta
tools, trivial single-object primitives, and a screenshot tool known to return
stale frames on Rhino 9 WIP (lessons.json `stale-capture`).

Per-tool-call latency is unnecessarily high. Source-level comparison with
github.com/jingcheng-chen/rhinomcp (1127★, the reference community
implementation) shows our bridge pays, on every call:

1. up to 30 ms waiting for the WinForms timer tick (or an unpredictable
   `RhinoApp.Idle` firing) that pumps the request queue onto the Rhino UI
   thread — the reference plugin uses `RhinoApp.InvokeOnUiThread` for
   immediate dispatch;
2. a fresh TCP connection per call (connect/teardown) instead of one
   persistent connection;
3. an exec-namespace rebuild per call, including a retry `import RhinoCycles`.

User decisions (Grill, this session): full purge; lean core tool set (~15);
optimize the existing Python bridge (no C# rewrite — `InvokeOnUiThread` is
callable from IronPython; C# would reintroduce the .NET SDK being purged);
work in place with no git.

## [S2] Design

### S2.1 File layout after cleanup

Delete: `dotnet-sdk/`, `nuget/`, `dotnet-install.ps1`, `cs/`, `specs/`,
`captures/*` (keep the directory), and all of `scripts/` except
`capture_window.ps1` and `ping.js`.

Keep: `server.js`, `rhino/bridge.py`, `rhino/bootstrap.py`,
`scripts/capture_window.ps1`, `scripts/ping.js`, `lessons.json`, `LAYERS.md`,
`README.md`, `package.json`, `captures/` (empty), `docs/` (this spec).

Nothing live references the deleted paths (verified by grep; the only
reference was `scripts/run_csharp_builder.py`, itself deleted).

### S2.2 Bridge dispatch (amended 2026-10-05, post-delivery)

Live testing on Rhino 8 exposed a Rhino-side instability that reframed the
dispatch design. Bisection evidence (each variant = fresh Rhino 8 launch +
stability watch):

| Variant | Result |
|---------|--------|
| bare Rhino, no bridge | stable ≥ 4 min |
| imports-only script (incl. rhinoscriptsyntax) | stable ≥ 4 min |
| TCP server ONLY (no timer, no Idle, no InvokeOnUiThread, no RhinoCycles) | **crashed ~30 s** (0xc00000fd, coreclr) |
| any bridge with background `InvokeOnUiThread` (incl. silent no-op calls) | crashed ≤ 5 min |
| full bridge, RhinoCycles removed | crashed < 30 s |
| file-queue bridge (delivered) | **stable ≥ 5 min idle, still serving after** |

Root cause: **IronPython socket/server threads inside Rhino's coreclr runtime
destabilize it** (stack overflow, 0xc00000fd) — on Rhino 8 stable and 9 WIP
alike. This also retroactively explains the twelve 2026-09-26 crashes of the
original timer+Idle TCP bridge. Additionally, `RhinoApp.InvokeOnUiThread`
called from a background thread silently no-ops on Rhino 8 (a UI-thread probe
passes; the real calling context fails).

Delivered design: the bridge runs **zero background threads and zero
sockets**. A single 30 ms WinForms timer on the Rhino UI thread (created in
`start()`, which runs on the UI thread) polls a queue directory, executes
requests on the spot, and writes response files. The IronPython exec
namespace is built once at `start()` and shallow-copied per exec. Atomic
writes use `os.rename` (`os.replace` is Python 3-only; IronPython is 2.7).
No `RhinoApp.Idle` hook, no `InvokeOnUiThread`, no RhinoCycles import.

Per-connection receive buffering is fixed so multiple newline-framed requests
in one TCP chunk are not discarded (`_recv_json_line` currently drops the
remainder after the first line).

### S2.3 Namespace cache

`_build_namespace()` is executed once at `start()` and cached module-level.
`_exec_python` uses a shallow `dict()` copy per call, so user code cannot
poison the shared namespace.

### S2.4 Transport (amended 2026-10-05, post-delivery): file queue

The original TCP transport (and the persistent-socket optimization of it) is
gone — see S2.2 for why sockets cannot run inside Rhino at all. Delivered
protocol, over a queue directory (`%TEMP%\rhino-mcp-queue`, override with
`RHINO_MCP_QUEUE`):

- server writes `<seq>_<id>.req.json` atomically (tmp + rename);
- the bridge's UI-thread timer picks it up, executes, writes
  `<seq>_<id>.resp.json`, deletes the request;
- the server polls for the response (~2 ms), reads it, deletes it;
- both sides purge the queue directory at startup;
- requests are serialized one-at-a-time through a promise chain (one in-flight
  request); responses are matched by id; per-request timeout deletes the
  orphaned request file and surfaces a friendly error.

There is no connection to retry, no pipelining, and no bridge-side
concurrency by construction. Round-trip ≈ 30–90 ms per call (dominated by the
30 ms UI-thread poll), 100 boxes in one exec ≈ 375 ms.

### S2.5 Lean tool set (15 tools)

Keep: `rhino_status`, `rhino_run_python`, `rhino_run_command`,
`rhino_get_document`, `rhino_get_layers`, `rhino_ensure_layer`,
`rhino_setup_layers`, `rhino_list_objects`, `rhino_object_info`,
`rhino_delete`, `rhino_transform`, `rhino_zoom`, `rhino_get_points`,
`rhino_screenshot_window`, `rhino_export`.

Remove (tool + handler in server.js; no bridge op changes required except
below): `rhino_layers` (superseded by `rhino_ensure_layer`),
`rhino_document_info` (superset `rhino_get_document` stays),
`rhino_health`, `rhino_report_lesson`, `rhino_get_lessons` (lessons.json stays
on disk as static data), `rhino_screenshot` (stale CaptureToBitmap on this
WIP; `rhino_screenshot_window` is the ground-truth capture),
`rhino_add_sphere`, `rhino_add_point`, `rhino_add_curve` (one-off geometry is
a single `rhino_run_python` snippet, which also batches naturally).

In `rhino/bridge.py`, drop the now-unreferenced `screenshot` op and
`_screenshot` (stale-capture path). Remaining ops: `ping`, `exec`, `command`,
`document_info` (used by `rhino_status`), `list_objects`, `object_info`.

### S2.6 Documentation

README.md rewritten to the new tool table, transport/dispatch design, the
latency rationale (research summary with reference to the GitHub comparison),
and unchanged setup instructions. MiMo config entry stays identical; the MCP
process must be restarted (new conversation / engine restart) to pick up the
new server.js.

### Follow-up (out of scope, recorded)

C# in-process plugin (like the reference implementation) as a future option if
the residual ~1–5 ms IronPython compile per exec ever matters; requires the
.NET SDK and a build/packaging step.

## [S3] Out of Scope

- C# plugin rewrite or any .NET toolchain use.
- Grasshopper tools, MCP protocol/transport changes (stdio stays), HTTP transport.
- Multi-client concurrent access to the bridge (single serialized client, as today).
- Rhino-side plugin packaging (.rhp/yak).
- The `captures/` retention policy beyond deleting current stale files.

## Tasks

- [x] T1: Write this spec — acceptance: spec file exists at
  docs/compose/spec/lean-rhino-mcp.md with this content (covers: S2)
- [x] T2: Purge experiment infrastructure — acceptance: `dotnet-sdk/`, `nuget/`,
  `dotnet-install.ps1`, `cs/`, `specs/`, old captures, and all scripts except
  `capture_window.ps1` + `ping.js` are gone; folder is ~1 MB; `server.js`,
  bridge, ps1, ping.js still present (covers: S2.1; depends: T1)
- [x] T3: Bridge optimization — acceptance: `rhino/bridge.py` dispatches via
  `InvokeOnUiThread` with queue/timer fallback, caches the exec namespace,
  keeps per-connection receive buffering, drops the `screenshot` op;
  py-syntax-check clean (covers: S2.2, S2.3, S2.5; depends: T2)
- [x] T4: Server optimization + lean tools — acceptance: `server.js` keeps one
  persistent socket with retry-once reconnect and serialized requests;
  exactly 15 tools registered; `node --check` clean; harness shows
  initialize/tools/list round-trip OK and connection reuse ≥ 2 requests on one
  socket (covers: S2.4, S2.5; depends: T2)
- [x] T5: Verification — acceptance: node --check + py syntax pass; harness
  with mocked bridge measures ≥ 2 requests served over one connection and
  correct error result when bridge is down; if Rhino is available, live
  before/after latency measured and recorded in Report (covers: S2.2, S2.4;
  depends: T3, T4)
- [x] T6: Review + finalize — acceptance: fresh subagent reviews spec vs diff,
  findings resolved, README updated, spec status set to delivered with Report
  filled (covers: S2.6; depends: T5)
