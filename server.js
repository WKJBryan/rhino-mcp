#!/usr/bin/env node
/**
 * Rhino MCP Server (stdio) — custom bridge for MiMo Desktop ↔ Rhino 8/9.
 * Speaks JSON-RPC over stdin/stdout (MCP) and talks to rhino/bridge.py over
 * a FILE QUEUE (see bridge.py's docstring: socket/server threads inside
 * Rhino's coreclr runtime destabilize it, so the bridge runs zero background
 * threads and polls a queue directory on the Rhino UI thread).
 *
 * Protocol: write <priority>_<seq>_<id>.req.json into the queue dir
 * (priority 0 = control, 5 = work); the bridge writes the matching
 * .resp.json and deletes the request; we read + delete the response.
 *
 * Lanes: work ops (exec/command/…) are serialized. Control ops (ping,
 * document_info, list_objects, object_info, measure) run on a parallel lane
 * and are named so the bridge drains them first. rhino_status can also be
 * answered from heartbeat.json while a long script owns the UI thread.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const RHINO_QUEUE = process.env.RHINO_MCP_QUEUE || path.join(os.tmpdir(), "rhino-mcp-queue");
const CAPTURE_DIR = process.env.RHINO_MCP_CAPTURES || path.join(__dirname, "captures");
const REQUEST_TIMEOUT_MS = parseInt(process.env.RHINO_MCP_TIMEOUT_MS || "70000", 10);
const CONTROL_TIMEOUT_MS = parseInt(process.env.RHINO_MCP_CONTROL_TIMEOUT_MS || "5000", 10);
const RESP_POLL_MS = 2;
const HEARTBEAT_FILE = path.join(RHINO_QUEUE, "heartbeat.json");

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  send({ jsonrpc: "2.0", id, error: err });
}

// ---------------------------------------------------------------------------
// File-queue transport
// ---------------------------------------------------------------------------

let nextSeq = 1;
let workChain = Promise.resolve();

const CONTROL_OPS = new Set([
  "ping",
  "document_info",
  "list_objects",
  "object_info",
  "measure",
  "select",
  "set_attrs",
]);

function ensureQueueDir() {
  if (!fs.existsSync(RHINO_QUEUE)) fs.mkdirSync(RHINO_QUEUE, { recursive: true });
}

function purgeQueue() {
  try {
    ensureQueueDir();
    for (const name of fs.readdirSync(RHINO_QUEUE)) {
      try {
        fs.unlinkSync(path.join(RHINO_QUEUE, name));
      } catch {}
    }
  } catch {}
}

function atomicWrite(file, text) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readHeartbeat() {
  try {
    return JSON.parse(fs.readFileSync(HEARTBEAT_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function waitForResponse(respPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(respPath)) return true;
    if (Date.now() > deadline) return false;
    await sleep(RESP_POLL_MS);
  }
}

async function fileRequest(op, payload, timeoutMs = REQUEST_TIMEOUT_MS, priority = 5) {
  const id = String(nextSeq++);
  const base = `${priority}_${Date.now()}_${id}`;
  const reqPath = path.join(RHINO_QUEUE, `${base}.req.json`);
  const respPath = path.join(RHINO_QUEUE, `${base}.resp.json`);
  const body = Object.assign({ id, op, priority }, payload || {});
  atomicWrite(reqPath, JSON.stringify(body));
  const got = await waitForResponse(respPath, timeoutMs);
  if (!got) {
    try {
      fs.unlinkSync(reqPath);
    } catch {}
    const hb = readHeartbeat();
    const busyHint = hb && hb.busy ? ` Bridge is busy on '${hb.op}' since ${Math.round((Date.now() / 1000 - (hb.started || hb.ts || 0)) * 10) / 10}s.` : "";
    throw new Error(
      `Rhino bridge timeout after ${timeoutMs}ms (no response in queue — is bridge.py running inside Rhino? queue: ${RHINO_QUEUE}).${busyHint}`
    );
  }
  let resp;
  try {
    resp = JSON.parse(fs.readFileSync(respPath, "utf8"));
  } finally {
    try {
      fs.unlinkSync(respPath);
    } catch {}
  }
  if (String(resp.id || "") !== id) throw new Error(`Bridge response id mismatch (sent ${id}, got ${resp.id})`);
  return resp;
}

function tcpRequest(op, payload, timeoutMs = REQUEST_TIMEOUT_MS) {
  // Name kept for handler continuity; transport is the file queue now.
  const isControl = CONTROL_OPS.has(op);
  const prio = isControl ? 0 : 5;
  const limit = timeoutMs || (isControl ? CONTROL_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  const run = () => fileRequest(op, payload, limit, prio);
  if (isControl) {
    // Control lane: do not queue behind a 3-minute geometry script.
    return run();
  }
  workChain = workChain.then(run, run);
  return workChain;
}

function statusFromHeartbeat() {
  const hb = readHeartbeat();
  const now = Date.now() / 1000;
  if (!hb) {
    return {
      ok: false,
      alive: false,
      error: "No heartbeat file — bridge.py is not running inside Rhino",
      queue: RHINO_QUEUE,
    };
  }
  const age = now - (hb.ts || 0);
  return {
    ok: true,
    alive: age < 30,
    busy: !!hb.busy,
    busy_op: hb.busy ? hb.op : null,
    busy_for_ms: hb.busy && hb.started ? Math.round((now - hb.started) * 1000) : 0,
    last_op: hb.last_op || null,
    heartbeat_age_ms: Math.round(age * 1000),
    rhino_version: hb.rhino_version || null,
    python: hb.python || null,
    queue_dir: hb.queue_dir || RHINO_QUEUE,
    poll_ms: hb.poll_ms || null,
  };
}

// ---------------------------------------------------------------------------
// MCP result helpers
// ---------------------------------------------------------------------------

function textContent(text) {
  return [{ type: "text", text: String(text) }];
}

function jsonResult(obj) {
  return textContent(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

function failResult(message, extra) {
  const body = Object.assign({ ok: false, error: message }, extra || {});
  return { content: jsonResult(body), isError: true };
}

function okResult(obj) {
  return { content: jsonResult(obj), isError: false };
}

// ---------------------------------------------------------------------------
// Tools (lean core set)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "rhino_status",
    description:
      "Check whether the Rhino bridge is alive and get Rhino version, Python, and a compact document summary. Call this first. Answered from heartbeat when a long script is busy — safe to call anytime.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "rhino_run_python",
    description:
      "Execute Python inside Rhino (RhinoCommon / scriptcontext / rhinoscriptsyntax available as Rhino, sc, rs). Assign to variable `result` to return a value. Runs on Rhino UI thread. Prefer ONE call with a loop over many single-object calls — batching is the main latency win. Keep scripts under ~200 lines; monolithic scripts can crash Rhino 9 WIP.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "Python source. Preloaded names: Rhino, sc (scriptcontext), rs (rhinoscriptsyntax), System, json, math, os, time. Set `result` to return data.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "rhino_run_command",
    description:
      "Run a Rhino command-line script (e.g. '_Zoom _All', '_-Layer _New Facade'). Prefer rhino_run_python for geometry work.",
    inputSchema: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "Rhino command script string" },
        echo: { type: "boolean", description: "Echo command to Rhino command line (default false)" },
      },
      required: ["cmd"],
      additionalProperties: false,
    },
  },
  {
    name: "rhino_get_document",
    description:
      "Full document snapshot: name, path, units, tolerances, object inventory (by type), layer tree summary. Use before modeling and after big edits.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "rhino_get_layers",
    description:
      "Layer hygiene dump: full tree (parent/child), color, visible/locked, object counts per layer. Standard for architecture layer cleanup.",
    inputSchema: {
      type: "object",
      properties: {
        include_empty: { type: "boolean", description: "Include layers with zero objects (default true)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rhino_ensure_layer",
    description:
      "Create a layer (supports nested Parent/Child via Parent::Child or Parent/Child), optional color and current flag. For AIA/NCS-style layer trees.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Layer path e.g. A-ARCH::A-WALL-EXTR" },
        current: { type: "boolean", description: "Make current layer (default false)" },
        color: { type: "string", description: "r,g,b 0-255" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "rhino_setup_layers",
    description:
      "Apply the standard architecture layer template (AIA/NCS-inspired). Idempotent — creates missing layers only. Pass scheme: 'aia' (default) or 'iso13567'.",
    inputSchema: {
      type: "object",
      properties: {
        scheme: { type: "string", enum: ["aia", "iso13567"], description: "Default aia" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rhino_list_objects",
    description: "List objects in the current document with id, type, layer, bounding box.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max objects to return (default 200)" },
        layer: { type: "string", description: "Filter by layer name (suffix match)" },
        type: { type: "string", description: "Filter by geometry type substring, e.g. Brep, Curve, Mesh" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rhino_object_info",
    description: "Detailed info for one object by GUID string.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Object GUID string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "rhino_delete",
    description: "Delete objects by GUID list. If ids omitted, deletes current selection.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Object GUID strings" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rhino_transform",
    description: "Move / rotate / scale objects by GUID (or selection if ids omitted).",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", description: "move | rotate | scale", enum: ["move", "rotate", "scale"] },
        ids: { type: "array", items: { type: "string" } },
        x: { type: "number", description: "move: delta X | rotate: degrees | scale: factor if factor omitted" },
        y: { type: "number", description: "move: delta Y" },
        z: { type: "number", description: "move: delta Z" },
        factor: { type: "number", description: "scale uniform factor (preferred)" },
        cx: { type: "number", description: "rotate/scale center X (default 0)" },
        cy: { type: "number", description: "rotate/scale center Y (default 0)" },
        cz: { type: "number", description: "rotate/scale center Z (default 0)" },
      },
      required: ["op"],
      additionalProperties: false,
    },
  },
  {
    name: "rhino_zoom",
    description: "Zoom viewport: all, selected, or extents (viewport API, not interactive commands).",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["all", "selected", "extents"], description: "default all" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rhino_get_points",
    description: "Get bounding box and/or sampled points from objects (or selection).",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        sample: { type: "boolean", description: "Also sample mesh/curve vertices (default false)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rhino_screenshot_window",
    description:
      "PrintWindow capture of the real Rhino HWND (ground truth). CaptureToBitmap is stale on Rhino 9 WIP — always use this for visual QA, then read the PNG.",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Optional label for the filename" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rhino_export",
    description:
      "Export the document (or selection) to a file via Rhino command, e.g. obj/stl/3dm/dxf/step. Returns the output path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute output file path" },
        only_selected: { type: "boolean", description: "Export selection only (default false = all)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "rhino_measure",
    description:
      "Measure length / area / volume / bbox in one call (selected objects, or given ids). Replaces a pile of per-object queries.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Object GUIDs; omit to use selection (or all if nothing selected)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rhino_select",
    description:
      "Select objects by name / name_contains / geometry type / layer / color. Filters combine with AND or OR. Returns selected ids. Use before measure/export of a subset.",
    inputSchema: {
      type: "object",
      properties: {
        filters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Exact object name (or list of names)" },
            name_contains: { type: "string", description: "Case-insensitive substring of name" },
            type: { type: "string", description: "Geometry type substring as Rhino type name: Extrusion, Brep, Mesh, Curve, Point… (not 'solid')" },
            layer: { type: "string", description: "Layer name substring or suffix" },
            color: { type: "array", items: { type: "number" }, description: "[r,g,b] 0-255 object color" },
          },
          additionalProperties: false,
        },
        filters_type: { type: "string", enum: ["and", "or"], description: "default and" },
        limit: { type: "number", description: "Max objects to select (default 500)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rhino_set_attrs",
    description:
      "Set name / object color / layer on objects (or current selection) in one call. rename_mode: set | prefix | suffix.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Object GUIDs; omit to use selection" },
        name: { type: "string", description: "New name (or affix when rename_mode is prefix/suffix)" },
        rename_mode: { type: "string", enum: ["set", "prefix", "suffix"], description: "default set" },
        color: { type: "array", items: { type: "number" }, description: "[r,g,b] 0-255" },
        layer: { type: "string", description: "Layer name (created if missing)" },
      },
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleTool(name, args) {
  const a = args || {};

  switch (name) {
    case "rhino_status": {
      // Heartbeat first: answer instantly even while a long exec owns the UI thread.
      const hb = statusFromHeartbeat();
      if (hb.busy) {
        return okResult({
          ...hb,
          note: "Bridge is executing a request on the Rhino UI thread; document summary unavailable until it finishes.",
        });
      }
      try {
        const r = await tcpRequest("ping", {}, CONTROL_TIMEOUT_MS);
        return r.ok ? okResult({ ...r.result, heartbeat: hb }) : failResult(r.error, { heartbeat: hb });
      } catch (e) {
        if (hb.alive) return okResult({ ...hb, error: e.message, note: "Heartbeat alive but ping failed/timeout." });
        return failResult(e.message || String(e), { heartbeat: hb });
      }
    }
    case "rhino_run_python": {
      const r = await tcpRequest("exec", { code: a.code || "" });
      if (!r.ok) return failResult(r.error || "Rhino exec failed", r);
      return okResult({
        ok: true,
        result: r.result,
        stdout: r.stdout || "",
      });
    }
    case "rhino_run_command": {
      const r = await tcpRequest("command", { cmd: a.cmd || "", echo: !!a.echo });
      const inner = (r.ok && r.result) || {};
      if (!r.ok || inner.ok === false) return failResult(inner.error || r.error || "command failed", r);
      return okResult(r.result);
    }
    case "rhino_get_document": {
      const code = `
import Rhino, scriptcontext as sc
doc = sc.doc
types = {}
n = 0
for o in doc.Objects:
    n += 1
    t = type(o.Geometry).__name__
    types[t] = types.get(t, 0) + 1
layers = []
for i in range(doc.Layers.Count):
    L = doc.Layers[i]
    layers.append({
        "index": i,
        "name": L.Name,
        "full_name": L.FullPath if hasattr(L, "FullPath") else L.Name,
        "visible": bool(L.IsVisible),
        "locked": bool(L.IsLocked),
        "parent_index": L.ParentLayerId.ToString() if hasattr(L, "ParentLayerId") else None,
    })
result = {
    "name": doc.Name or "",
    "path": doc.Path or "",
    "units": str(doc.ModelUnitSystem),
    "abs_tol": float(doc.ModelAbsoluteTolerance),
    "angle_tol_rad": float(doc.ModelAngleToleranceRadians),
    "objects_enum": n,
    "objects_count_field": doc.Objects.Count,
    "types": types,
    "layer_count": len(layers),
    "layers": layers,
}
`;
      const r = await tcpRequest("exec", { code });
      return r.ok ? okResult(r.result) : failResult(r.error, r);
    }
    case "rhino_get_layers": {
      const includeEmpty = a.include_empty !== false;
      const code = `
import Rhino, scriptcontext as sc
include_empty = ${includeEmpty ? "True" : "False"}
counts = {}
for o in sc.doc.Objects:
    idx = o.Attributes.LayerIndex
    counts[idx] = counts.get(idx, 0) + 1
rows = []
for i in range(sc.doc.Layers.Count):
    L = sc.doc.Layers[i]
    cnt = counts.get(i, 0)
    if not include_empty and cnt == 0:
        continue
    rows.append({
        "index": i,
        "name": L.Name,
        "full_name": L.FullPath if hasattr(L, "FullPath") else L.Name,
        "color": str(L.Color),
        "visible": bool(L.IsVisible),
        "locked": bool(L.IsLocked),
        "object_count": cnt,
    })
result = {"layers": rows, "total_objects": sum(counts.values())}
`;
      const r = await tcpRequest("exec", { code });
      return r.ok ? okResult(r.result) : failResult(r.error, r);
    }
    case "rhino_ensure_layer": {
      const name = JSON.stringify(String(a.name || ""));
      const color = a.color ? JSON.stringify(String(a.color)) : "None";
      const current = a.current === true ? "True" : "False";
      const code = `
import Rhino, scriptcontext as sc
import System
path = ${name}
make_current = ${current}
rgb = ${color}
parts = [p for p in path.replace("::", "/").replace("\\\\", "/").split("/") if p]
created = []
parent_index = -1
for p in parts:
    # find child of parent_index named p
    found = -1
    for i in range(sc.doc.Layers.Count):
        L = sc.doc.Layers[i]
        if L.Name != p:
            continue
        if parent_index < 0:
            if L.ParentLayerId == System.Guid.Empty:
                found = i
                break
        else:
            if L.ParentLayerId == sc.doc.Layers[parent_index].Id:
                found = i
                break
    if found < 0:
        li = Rhino.DocObjects.Layer()
        li.Name = p
        if parent_index >= 0:
            li.ParentLayerId = sc.doc.Layers[parent_index].Id
        if rgb is not None and str(rgb) != "None":
            try:
                r,g,b = [int(x) for x in str(rgb).split(",")]
                li.Color = System.Drawing.Color.FromArgb(r,g,b)
            except Exception:
                pass
        found = sc.doc.Layers.Add(li)
        created.append(p)
    parent_index = found
if make_current and parent_index >= 0:
    sc.doc.Layers.SetCurrentIndex(parent_index, True)
result = {
    "path": path,
    "index": parent_index,
    "full_name": sc.doc.Layers[parent_index].FullPath if parent_index >= 0 and hasattr(sc.doc.Layers[parent_index], "FullPath") else path,
    "created": created,
    "current": sc.doc.Layers.CurrentLayerIndex,
}
`;
      const r = await tcpRequest("exec", { code });
      return r.ok ? okResult(r.result) : failResult(r.error, r);
    }
    case "rhino_setup_layers": {
      const scheme = a.scheme === "iso13567" ? "iso13567" : "aia";
      const groups =
        scheme === "aia"
          ? [
              ["00-SITE", "G-TOPO", "G-SITE", "G-GRID"],
              ["A-ARCH", "A-FLOR-SLAB", "A-FLOR-FNSH", "A-WALL-EXTR", "A-WALL-INTE", "A-WALL-PRHT", "A-GLAZ", "A-DOOR", "A-ROOF", "A-STRS", "A-CEIL", "A-FURN", "A-ANNO"],
              ["S-STRC", "S-COLS", "S-BEAM", "S-SLAB", "S-REIN"],
              ["M-MECH", "M-HVAC", "M-PLMB", "M-ELEC"],
              ["X-XREF", "X-TEMP", "X-CLASH"],
            ]
          : [
              ["A", "A-P10", "A-P20", "A-P21", "A-P30", "A-Q10", "A-R10"],
              ["S", "S-E10", "S-E20"],
              ["G", "G-T10"],
              ["X", "X-U10"],
            ];
      const code = `
import Rhino, scriptcontext as sc
import System
def ensure(parts):
    parent_index = -1
    created = []
    for p in parts:
        found = -1
        for i in range(sc.doc.Layers.Count):
            L = sc.doc.Layers[i]
            if L.Name != p:
                continue
            if parent_index < 0:
                if L.ParentLayerId == System.Guid.Empty:
                    found = i
                    break
            else:
                if L.ParentLayerId == sc.doc.Layers[parent_index].Id:
                    found = i
                    break
        if found < 0:
            li = Rhino.DocObjects.Layer()
            li.Name = p
            if parent_index >= 0:
                li.ParentLayerId = sc.doc.Layers[parent_index].Id
            found = sc.doc.Layers.Add(li)
            created.append(p)
        parent_index = found
    return created

all_created = []
# each group is [root, child1, child2...] — children go under root
groups = ${JSON.stringify(groups)}
for g in groups:
    root = g[0]
    all_created.extend(ensure([root]))
    for child in g[1:]:
        all_created.extend(ensure([root, child]))
result = {"scheme": ${JSON.stringify(scheme)}, "created": all_created, "layer_count": sc.doc.Layers.Count}
`;
      const r = await tcpRequest("exec", { code });
      return r.ok ? okResult(r.result) : failResult(r.error, r);
    }
    case "rhino_list_objects": {
      const r = await tcpRequest("list_objects", {
        limit: a.limit || 200,
        layer: a.layer || null,
        type: a.type || null,
      });
      return r.ok ? okResult(r.result) : failResult(r.error, r);
    }
    case "rhino_object_info": {
      const r = await tcpRequest("object_info", { id: a.id });
      return r.ok ? okResult(r.result) : failResult(r.error, r);
    }
    case "rhino_delete": {
      const code = `
import System
import scriptcontext as sc
ids = ${JSON.stringify(a.ids || [])}
deleted = []
if not ids:
    to_delete = [str(o.Id) for o in sc.doc.Objects.GetSelectedObjects(True, False)]
else:
    to_delete = ids
for id_str in to_delete:
    try:
        guid = System.Guid(id_str)
        if sc.doc.Objects.Delete(guid, True):
            deleted.append(id_str)
    except Exception as e:
        deleted.append(id_str + " ERR " + str(e))
sc.doc.Views.Redraw()
result = {"deleted": deleted, "count": len(deleted)}
`;
      const r = await tcpRequest("exec", { code });
      return r.ok ? okResult(r.result) : failResult(r.error, r);
    }
    case "rhino_transform": {
      const code = `
import System
import Rhino
import scriptcontext as sc
op = ${JSON.stringify(a.op || "move")}
ids = ${JSON.stringify(a.ids || [])}
x = float(${a.x || 0}); y = float(${a.y || 0}); z = float(${a.z || 0})
factor = float(${a.factor != null ? a.factor : "1"})
cx = float(${a.cx || 0}); cy = float(${a.cy || 0}); cz = float(${a.cz || 0})
if not ids:
    ids = [str(o.Id) for o in sc.doc.Objects.GetSelectedObjects(True, False)]
count = 0
for id_str in ids:
    try:
        guid = System.Guid(id_str)
        obj = sc.doc.Objects.Find(guid)
        if obj is None:
            continue
        if op == "move":
            xform = Rhino.Geometry.Transform.Translation(x, y, z)
        elif op == "rotate":
            plane = Rhino.Geometry.Plane(Rhino.Geometry.Point3d(cx, cy, cz), Rhino.Geometry.Vector3d.ZAxis)
            angle = Rhino.RhinoMath.ToRadians(x)
            xform = Rhino.Geometry.Transform.Rotation(angle, plane.Normal, plane.Origin)
        elif op == "scale":
            if ${a.factor != null ? "True" : "False"}:
                f = factor
            else:
                f = x if x != 0 else 1.0
            xform = Rhino.Geometry.Transform.Scale(Rhino.Geometry.Point3d(cx, cy, cz), f)
        else:
            raise Exception("unknown op " + op)
        sc.doc.Objects.Transform(guid, xform, True)
        count += 1
    except Exception as e:
        pass
sc.doc.Views.Redraw()
result = {"op": op, "transformed": count}
`;
      const r = await tcpRequest("exec", { code });
      return r.ok ? okResult(r.result) : failResult(r.error, r);
    }
    case "rhino_zoom": {
      // Use viewport APIs — RunScript("_Zoom ...") can block the UI thread.
      const mode = (a.mode || "all").toLowerCase();
      const code = `
import Rhino
import scriptcontext as sc
view = sc.doc.Views.ActiveView
vp = view.ActiveViewport
mode = ${JSON.stringify(mode)}
if mode == "selected":
    objs = list(sc.doc.Objects.GetSelectedObjects(True, False))
    bb = Rhino.Geometry.BoundingBox.Empty
    for o in objs:
        bb.Union(o.Geometry.GetBoundingBox(True))
    if bb.IsValid:
        vp.ZoomBoundingBox(bb)
    else:
        vp.ZoomExtents()
else:
    vp.ZoomExtents()
view.Redraw()
result = {"ok": True, "mode": mode}
`;
      const r = await tcpRequest("exec", { code });
      return r.ok ? okResult(r.result) : failResult(r.error, r);
    }
    case "rhino_get_points": {
      const code = `
import System
import Rhino
import scriptcontext as sc
ids = ${JSON.stringify(a.ids || [])}
sample = bool(${a.sample ? "True" : "False"})
if not ids:
    objs = list(sc.doc.Objects.GetSelectedObjects(True, False))
    if not objs:
        objs = list(sc.doc.Objects)
else:
    objs = []
    for id_str in ids:
        o = sc.doc.Objects.Find(System.Guid(id_str))
        if o is not None:
            objs.append(o)
points = []
mins = [1e300, 1e300, 1e300]
maxs = [-1e300, -1e300, -1e300]
for obj in objs:
    try:
        bb = obj.Geometry.GetBoundingBox(True)
        if bb.IsValid:
            for i, v in enumerate([bb.Min.X, bb.Min.Y, bb.Min.Z]):
                if v < mins[i]: mins[i] = v
            for i, v in enumerate([bb.Max.X, bb.Max.Y, bb.Max.Z]):
                if v > maxs[i]: maxs[i] = v
        if sample:
            g = obj.Geometry
            if isinstance(g, Rhino.Geometry.Brep):
                for v in g.Vertices:
                    points.append([v.Location.X, v.Location.Y, v.Location.Z])
            elif isinstance(g, Rhino.Geometry.Mesh):
                for v in g.Vertices:
                    points.append([v.X, v.Y, v.Z])
            elif isinstance(g, Rhino.Geometry.Point):
                points.append([g.Location.X, g.Location.Y, g.Location.Z])
            elif hasattr(g, "PointAtStart"):
                points.append([g.PointAtStart.X, g.PointAtStart.Y, g.PointAtStart.Z])
                points.append([g.PointAtEnd.X, g.PointAtEnd.Y, g.PointAtEnd.Z])
    except Exception:
        pass
result = {
    "count": len(objs),
    "bbox": {"min": mins if mins[0] < 1e299 else None, "max": maxs if maxs[0] > -1e299 else None},
    "sample_points": points[:500],
    "sample_total": len(points),
}
`;
      const r = await tcpRequest("exec", { code });
      return r.ok ? okResult(r.result) : failResult(r.error, r);
    }
    case "rhino_screenshot_window": {
      const ps1 = path.join(__dirname, "scripts", "capture_window.ps1");
      const label = String(a.label || "shot").replace(/[^\w\-]+/g, "_").slice(0, 40);
      const out = path.join(CAPTURE_DIR, `${label}_${Date.now()}.png`);
      try {
        const { execFile } = require("child_process");
        const stdout = await new Promise((resolve, reject) => {
          execFile(
            "powershell.exe",
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-OutPath", out],
            { timeout: 20000 },
            (err, so, se) => (err ? reject(new Error(se || err.message)) : resolve(so))
          );
        });
        return okResult({ path: out, raw: stdout.trim(), note: "Read this PNG for visual QA" });
      } catch (e) {
        return failResult("window capture failed: " + e.message);
      }
    }
    case "rhino_export": {
      const out = String(a.path || "").replace(/\//g, "\\");
      const which = a.only_selected ? "_-Export _Selected" : "_-Export";
      const cmd = `${which} "${out}" _Enter _Enter`;
      const r = await tcpRequest("command", { cmd, echo: false });
      const inner = (r.ok && r.result) || {};
      if (!r.ok || inner.ok === false) return failResult(inner.error || r.error || "export command failed", { path: out });
      return okResult({ ok: true, path: out, raw: r.result });
    }
    case "rhino_measure": {
      const r = await tcpRequest("measure", { ids: a.ids || null }, CONTROL_TIMEOUT_MS);
      return r.ok ? okResult(r.result) : failResult(r.error, r);
    }
    case "rhino_select": {
      const r = await tcpRequest(
        "select",
        {
          filters: a.filters || {},
          filters_type: a.filters_type || "and",
          limit: a.limit || 500,
        },
        CONTROL_TIMEOUT_MS
      );
      return r.ok ? okResult(r.result) : failResult(r.error, r);
    }
    case "rhino_set_attrs": {
      const r = await tcpRequest(
        "set_attrs",
        {
          ids: a.ids || null,
          name: a.name != null ? a.name : null,
          color: a.color || null,
          layer: a.layer || null,
          rename_mode: a.rename_mode || "set",
        },
        CONTROL_TIMEOUT_MS
      );
      return r.ok ? okResult(r.result) : failResult(r.error, r);
    }
    default:
      return failResult(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// MCP stdio loop
// ---------------------------------------------------------------------------

async function onMessage(msg) {
  const id = msg.id;
  try {
    if (msg.method === "initialize") {
      sendResult(id, {
        protocolVersion: msg.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "rhino-mcp", version: "1.3.0" },
      });
      return;
    }
    if (msg.method === "notifications/initialized" || msg.method === "initialized") {
      return;
    }
    if (msg.method === "ping") {
      sendResult(id, {});
      return;
    }
    if (msg.method === "tools/list") {
      sendResult(id, { tools: TOOLS });
      return;
    }
    if (msg.method === "tools/call") {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      try {
        const result = await handleTool(name, args);
        sendResult(id, result);
      } catch (e) {
        sendResult(id, failResult(e.message || String(e)));
      }
      return;
    }
    if (id !== undefined && id !== null) {
      sendError(id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (e) {
    if (id !== undefined && id !== null) {
      sendError(id, -32000, e.message || String(e));
    }
  }
}

let stdinBuf = "";
const pending = new Set();
let stdinEnded = false;

function track(p) {
  const wrapped = Promise.resolve(p).finally(() => {
    pending.delete(wrapped);
    if (stdinEnded && pending.size === 0) {
      // allow stdout to flush
      setTimeout(() => process.exit(0), 10);
    }
  });
  pending.add(wrapped);
  return wrapped;
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  let idx;
  while ((idx = stdinBuf.indexOf("\n")) >= 0) {
    const line = stdinBuf.slice(0, idx).trim();
    stdinBuf = stdinBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      continue;
    }
    track(onMessage(msg));
  }
});

process.stdin.on("end", () => {
  stdinEnded = true;
  if (pending.size === 0) {
    setTimeout(() => process.exit(0), 10);
  }
});

purgeQueue();
