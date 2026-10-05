# Rhino ↔ MiMo MCP (custom)

Live control of your open Rhino (8 or 9) from MiMo Desktop. Lean: one Node
file + one Python file (plus tiny helper scripts), no dependencies, ~1 MB.

## Pieces

1. **`rhino/bridge.py`** — runs *inside* Rhino; a WinForms timer (8 ms) on the
   Rhino UI thread polls a queue directory (`%TEMP%\rhino-mcp-queue`) for
   request files, executes them, and writes response files. **Zero background
   threads, zero sockets** — IronPython socket/server threads destabilize
   Rhino's coreclr runtime (stack-overflow crashes within minutes; see
   docs/compose/spec/lean-rhino-mcp.md).
2. **`server.js`** — MCP stdio server MiMo launches. Writes request files to
   the queue, polls for responses, talks MCP over stdin/stdout.

## Start the bridge in Rhino

In the Rhino command line (one time per Rhino session):

```
! _-RunPythonScript "C:\Users\bryan\XiaomiMiMoProjects\rhino-mcp\rhino\bridge.py"
```

You should see: `Rhino MCP bridge (file-queue) polling … every 8ms`

## MiMo config

Registered under `mcp.rhino` in `~/.config/mimocode/mimocode.jsonc`.
**Restart the MiMo conversation / engine** after editing `server.js` (the MCP
process starts with the conversation). Re-running `bridge.py` inside Rhino
picks up bridge changes immediately.

## Tools (18)

| Tool | Purpose |
|------|---------|
| `rhino_status` | Bridge + document health. Call first. Answered from **heartbeat** even while a long script is busy. |
| `rhino_run_python` | Run Python in Rhino (`Rhino`, `sc`, `rs`, `System`, `json`, `math`, `os`, `time` preloaded; set `result` to return). **Batch N objects in one call.** |
| `rhino_run_command` | Rhino command-line script |
| `rhino_get_document` | Units, tolerances, object inventory, layer summary |
| `rhino_get_layers` | Layer tree + color + visible/locked + object counts |
| `rhino_ensure_layer` | Create nested layer (Parent::Child), optional color/current |
| `rhino_setup_layers` | AIA/NCS (or ISO 13567) layer template, idempotent |
| `rhino_list_objects` / `rhino_object_info` | Scene inventory |
| `rhino_delete` / `rhino_transform` | Edit (by GUID list or selection) |
| `rhino_zoom` / `rhino_get_points` | View + geometry queries |
| `rhino_screenshot_window` | PrintWindow capture of the Rhino HWND (ground truth) |
| `rhino_export` | Export obj/stl/3dm/dxf/step via command |
| `rhino_measure` | Length / area / volume / bbox in one call (Extrusion→Brep aware) |
| `rhino_select` | Select by name / type / layer / color (AND/OR filters) |
| `rhino_set_attrs` | Set name / color / layer on ids or selection in one call |

## Protocol (file queue)

- Request: `%TEMP%\rhino-mcp-queue\<priority>_<seq>_<id>.req.json`
  (`0_` = control, `5_` = work — control sorts first).
- Bridge executes on the UI thread and writes `<base>.resp.json`, deletes the
  request. Server reads + deletes the response.
- **Lanes:** work ops (`exec`, `command`) are serialized on the server.
  Control ops (`ping`, `document_info`, `list_objects`, `object_info`,
  `measure`, `select`, `set_attrs`) run on a parallel lane and jump the queue.
- **Heartbeat:** `heartbeat.json` is rewritten around every request so
  `rhino_status` can answer instantly while a long script owns the UI thread
  (tanishqbhattad/rhino-mcp “multiplexed ping” idea, adapted to a file queue).
- Both sides purge the queue at startup. Override directory with
  `RHINO_MCP_QUEUE`.

## Performance (Rhino 8.35, this machine)

| Path | Time |
|------|------|
| typical tool call (status / ping) | **8–20 ms** (was 45–90 ms @ 30 ms poll) |
| measure 25 objects | ~25 ms |
| 25-object tower in one `run_python` | ~375 ms total |
| idle stability | ≥ 5 min + still serving |

## What we learned from other Rhino MCPs

Compared against `jingcheng-chen/rhinomcp` (1130★, C# Yak plugin + TCP) and
`tanishqbhattad/rhino-mcp` (multiplexed protocol, vision loop, tool profiles):

| Lesson | Applied here? |
|--------|----------------|
| Batch everything (one script = N objects) | Yes — `run_python` + measure/select/set_attrs |
| Ping/status answers while long ops run | Yes — heartbeat + control lane |
| Visual QA loop (capture after edits) | Yes — `rhino_screenshot_window` (PrintWindow) |
| Filtered selection + measure tools | Yes — `rhino_select`, `rhino_measure` |
| Compact status (don’t dump whole model) | Yes — lean `ping` document summary |
| C# plugin + TCP for instant dispatch | **No** — IronPython sockets crash coreclr (see spec). File queue + 8 ms poll is the safe equivalent. |
| 100+ tool surface | **No** — 18 focused tools; geometry one-offs go through `run_python` |

## Self-test (no Rhino needed)

```
node scripts/selftest.js
```

14/14: handshake, 18-tool registry, round-trips, control+work parallel lane,
friendly timeout, restart recovery, queue hygiene.

## Env

| Var | Default |
|-----|---------|
| `RHINO_MCP_QUEUE` | `%TEMP%\rhino-mcp-queue` |
| `RHINO_MCP_TIMEOUT_MS` | `70000` (work ops) |
| `RHINO_MCP_CONTROL_TIMEOUT_MS` | `5000` (status/measure/select) |
| `RHINO_MCP_POLL_MS` | `8` (bridge timer) |
| `RHINO_MCP_CAPTURES` | `./captures` |

## Known quirks

- `CaptureToBitmap`/`ViewCaptureToFile` can return stale frames (Rhino 9 WIP)
  — use `rhino_screenshot_window` (PrintWindow).
- `Objects.Count` and sometimes the object enumerator lie — trust names +
  bboxes + screenshots (see `lessons.json`).
- Interactive `RunScript` commands (`_Zoom`, `_Purge`, exports) block the UI
  thread — zoom via viewport API (built into `rhino_zoom`).
- **Never add socket/server threads or background `InvokeOnUiThread` calls to
  bridge.py** — both are proven crash causes on Rhino 8/9 coreclr. A C#
  plugin (like jingcheng-chen/rhinomcp) is the only safe path to TCP.
- Geometry type filters use Rhino type names (`Extrusion`, `Brep`, `Mesh`,
  `Curve`) — a tower of `AddBox` is often `Extrusion`, not `Brep`.
- IronPython 2.7: no `os.replace`; always remove-then-rename when rewriting a
  fixed path (`heartbeat.json`).
