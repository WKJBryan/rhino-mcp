---
feature: intent-harness
status: in-progress
updated: 2026-10-06
branch: feature/intent-harness
commits: d3da8f9..f958de5
---

# Intent Harness: design-aware policy gate for Rhino MCP

## Report

## [S1] Problem

The agent can already create geometry in Rhino, but nothing stops it from
creating **junk**: invalid or zero-volume solids, anonymous duplicates,
objects on the wrong layer, floating/mismatched massing, SubD/mesh noise, and
shapes that ignore the design language you use in conversation ("tower /
podium / core", floors, facade grid). The current IronPython file-queue bridge
executes whatever it is given. Community plugins (jingcheng-chen/rhinomcp)
expose more tools but also do not gate design intent.

We need a **harness**: a C# Rhino plugin (`.rhp`) that blocks bad creates with
an explanation, understands session design language via an agent-maintained
intent document plus a physics/rules reference, and hosts TCP so dispatch is
native and fast.

## [S2] Design

### S2.1 Architecture (chosen)

```text
MiMo (session language)
   │  tools/call
   ▼
server.js  ──MCP stdio──  MiMo Desktop
   │
   ├─ rhino_set_intent / rhino_get_policy   (intent sync)
   ├─ rhino_check_scene                     (audit)
   └─ TCP 127.0.0.1:9545
         ▼
   IntentHarness.rhp  (C# plugin, UI thread)
         ├─ PolicyEngine   mechanical + style + intent checks
         ├─ IntentStore    loads intent.json + rules/physics.md
         ├─ ObjectGate     intercept create/modify/delete
         └─ TcpHost        worker thread → RhinoApp.InvokeOnUiThread
```

- **C# gate + agent intent** (user decision): the plugin owns hard rejection of
  geometric/style violations on every mutating op. The agent turns *session
  language* into `intent.json` (massing vocabulary, proportions, required
  names/layers) and performs visual QA via screenshot tools.
- **File queue is retired** once TCP is live; `bridge.py` remains only as an
  emergency fallback until TCP is proven (same JSON op names).

### S2.2 Intent and language (why it can "understand" you)

Two inputs, deliberately split:

| Source | What it carries | Who writes it | How it is used |
|--------|-----------------|---------------|----------------|
| **Session language** | Project brief in your words: program, massing words (tower, podium, core…), proportions, style | Agent, via `rhino_set_intent` | Names, layers, and proportions of new objects must match intent tokens/constraints |
| **`rules/physics.md` + `rules/style.md`** | Stable world rules: scale in mm, wall thickness, no floating mass, floor-to-floor, AIA layers, SubD sharpness≥3, no interactive RunScript | Human (this feature) | Plugin always enforces; agent also loads as guidance |

The plugin does **not** do free-form NLP. It checks **structured intent** that
the agent has already interpreted from the conversation. The agent is the
language understanding layer; the plugin is the physics/style gate.

`intent.json` contract (written under `RHINO_MCP_HOME/intent.json`):

```json
{
  "project": "string",
  "units": "mm",
  "vocabulary": ["tower", "podium", "core", "facade"],
  "required_layers": ["A-ARCH::A-WALL-EXTR", "A-ARCH::A-GLAZ"],
  "massing": [
    {"name_contains": "tower", "min_height_mm": 30000, "min_aspect_h_over_w": 1.5},
    {"name_contains": "podium", "max_height_mm": 15000, "min_footprint_m2": 200}
  ],
  "limits": {"max_objects": 2000, "max_unnamed": 0},
  "allow": {"subd": false, "mesh": true, "points": true}
}
```

Missing file = mechanical rules only. Agent must call `rhino_set_intent`
before massing work when the session has a brief.

### S2.3 Policy engine (block + explain)

Every create/modify runs through ordered checks. First failure **blocks** the
op and returns JSON:

```json
{"ok": false, "code": "POLICY_BLOCKED", "rule": "float_massing",
 "message": "Object 'Tower' bbox min Z=1200 does not sit on ground or podium top.",
 "fix": ["Move to Z=0 or attach to podium.", "If intentional, set intent.allow.floating=true"],
 "object": {"name": "Tower", "id": "..."}}
```

Check order:

1. **Mechanical** — geometry `IsValid`, volume/area > ε, not degenerate, not
   duplicate of an existing bbox+type+name, ID uniqueness.
2. **Physics** (`rules/physics.md` encoded as `PhysicsRules`) — nothing floats
   above ground/podium without intent flag; wall-like breps have thickness
   > model tolerance; floor slabs are planar and horizontal; object Z-extents
   stack without large gaps unless `allow.floating`.
3. **Style** (`rules/style.md`) — name non-empty (or `allow.unnamed`); layer is
   in the active scheme (AIA default) and matches type (glazing → `A-GLAZ`);
   no objects on `Default` after layers exist; object count ≤ `limits.max_objects`.
4. **Intent** — if `intent.json` present: name contains a vocabulary token or
   an explicit `name` in massing rules; massing proportion constraints pass;
   SubD/mesh creation requires `allow.subd` / `allow.mesh`.

`rhino_run_python` remains, but the plugin wraps mutating RhinoCommon calls
from **gated tools** (create_box, create_extrusion, add_subd, …). Raw
`run_python` is flagged `escape_hatch: true` and is audited after the fact
via `rhino_check_scene` (cannot intercept every API without banning the tool).

### S2.4 Tool surface (after swap)

Keep: status, run_python, run_command, get_document, get_layers, ensure_layer,
setup_layers, list_objects, object_info, delete, transform, zoom, get_points,
screenshot_window, export, measure, select, set_attrs.

Add:

| Tool | Purpose |
|------|---------|
| `rhino_set_intent` | Write/merge `intent.json` from session language |
| `rhino_get_policy` | Return active rules + intent + last blocks |
| `rhino_check_scene` | Audit whole document; list violations |
| `rhino_create_mass` | Gated box/extrusion/slab/wall (layer+name+physics) |
| `rhino_add_subd` | Gated SubD (sharpness≥3, requires `allow.subd`) |
| `rhino_add_mesh` | Gated mesh (requires `allow.mesh`) |

### S2.5 TCP transport

- Plugin listens on `127.0.0.1:9545` (override `RHINO_MCP_TCP_PORT`).
- Worker thread accepts one client; frames = newline-delimited JSON (same body
  as today's queue files). Dispatch via `RhinoApp.InvokeOnUiThread` (safe in C#).
- `server.js` tries TCP first; on connect failure falls back to file queue and
  reports `transport: "file-queue-fallback"` in status.
- Ops: existing set + `set_intent`, `get_policy`, `check_scene`, `create_mass`,
  `add_subd`, `add_mesh`.

### S2.6 Why this shape (and not jingcheng-style free tools)

- Language lives where it is strongest (the agent + a durable `.md`).
- Geometry truth lives where it is strongest (C# RhinoCommon + UI thread).
- Block+explain teaches the agent instead of silently accumulating junk.
- TCP is the native path C# can host without the IronPython coreclr crash.

## [S3] Out of Scope

- Grasshopper graph tools (later feature).
- Multi-client TCP / remote MCP.
- Yak/Rhino Package Manager packaging (drop-in `.rhp` is enough for now).
- Replacing visual QA with an LLM inside the plugin.
- Auto-fix / auto-delete of violations (block + explain only).
- Undo/redo history browser.

## Tasks

- [ ] T1: Write `rules/physics.md` and `rules/style.md` — acceptance: files
  exist under `rules/` with encoded rules matching S2.3 check order; each rule
  has id, severity block, and `fix` guidance (covers: S2.2, S2.3)
- [ ] T2: Scaffold `plugin/IntentHarness.csproj` + `RhinoPlugin` entry +
  `mcpstart`/`mcpstop` commands — acceptance: project builds against local
  RhinoCommon; plugin loads in Rhino 8 without error (covers: S2.1; depends: T1)
- [ ] T3: Implement `PolicyEngine` + `IntentStore` (load intent.json + rules;
  mechanical/physics/style/intent checks; structured block payloads) —
  acceptance: unit-testable pure checks cover each S2.3 rule with pass/fail
  fixtures (covers: S2.3; depends: T2)
- [ ] T4: Implement `TcpHost` (127.0.0.1:9545, NDJSON, UI-thread dispatch) —
  acceptance: external probe gets ping/exec round-trip while Rhino stays
  stable ≥ 2 min idle (covers: S2.5; depends: T2)
- [ ] T5: Gated create tools (`create_mass`, `add_subd`, `add_mesh`) call
  PolicyEngine before apply — acceptance: invalid create returns
  `POLICY_BLOCKED` with rule+fix; valid create lands on correct layer with
  intent name (covers: S2.3, S2.4; depends: T3, T4)
- [ ] T6: `server.js` TCP client + fallback file queue + new tools
  (`rhino_set_intent`, `rhino_get_policy`, `rhino_check_scene`, gated creates) —
  acceptance: `node scripts/selftest.js` covers intent set → block junk →
  allow valid mass; status reports transport (covers: S2.4, S2.5; depends: T4)
- [ ] T7: Agent intent sync path — acceptance: `rhino_set_intent` writes
  `intent.json`; `rhino_get_policy` returns it; massing constraints block a
  floating "tower" (covers: S2.2; depends: T5, T6)
- [ ] T8: Live verification on Rhino 8 + visual QA capture after a valid mass
  and a blocked junk attempt — acceptance: screenshot after valid mass shows
  podium+tower; block response matches S2.3 payload shape (covers: S2.3, S2.4;
  depends: T5, T7)
- [ ] T9: Review + finalize spec (Report, status delivered, task check-off) —
  acceptance: fresh reviewer sign-off on diff vs this spec (covers: S2.6;
  depends: T8)
