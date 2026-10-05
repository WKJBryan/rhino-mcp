# -*- coding: utf-8 -*-
"""
Rhino MCP Bridge — runs INSIDE Rhino 8/9 (IronPython 2.7 or CPython).

Start from Rhino command line:
    ! _-RunPythonScript "C:\\Users\\bryan\\XiaomiMiMoProjects\\rhino-mcp\\rhino\\bridge.py"

TRANSPORT: file queue, not sockets. IronPython socket/server threads inside
Rhino's coreclr runtime destabilize it (0xc00000fd stack overflows). This
bridge runs ZERO background threads: a WinForms timer on the Rhino UI thread
polls a queue directory for request files, executes them, and writes response
files.

Priority: request filenames are <priority>_<seq>_<id>.req.json
(0 = control/status, 5 = work). Control requests sort first so a ping jumps
ahead of queued geometry scripts.

Heartbeat: %TEMP%/rhino-mcp-queue/heartbeat.json is rewritten before/after
every request so the Node server can answer rhino_status instantly even while
a long script is running on the UI thread.
"""

from __future__ import print_function

import json
import os
import sys
import time
import traceback

import Rhino
import scriptcontext as sc

try:
    import rhinoscriptsyntax as rs
except Exception:
    rs = None

try:
    import System
except Exception:
    System = None

STATE_KEY = "_rhino_mcp_bridge_state"
MAX_CODE_BYTES = 200000
QUEUE_DIR = os.environ.get(
    "RHINO_MCP_QUEUE",
    os.path.join(os.environ.get("TEMP", os.path.expanduser("~")), "rhino-mcp-queue"),
)
POLL_INTERVAL_MS = int(os.environ.get("RHINO_MCP_POLL_MS", "8"))
DIAG_LOG = r"C:\Users\bryan\XiaomiMiMoProjects\rhino-mcp\bridge_diag.log"
HEARTBEAT_NAME = "heartbeat.json"
_CTRL_PREFIX = "0_"


def _diag(text):
    try:
        with open(DIAG_LOG, "a") as f:
            f.write(text + "\n")
    except Exception:
        pass


def _json_safe(obj, depth=0):
    """Best-effort conversion of Rhino/.NET values into JSON-safe data."""
    if depth > 6:
        return str(obj)
    if obj is None or isinstance(obj, (bool, int, float)):
        return obj
    if isinstance(obj, str):
        return obj
    try:
        if isinstance(obj, unicode):  # IronPython 2
            return obj.encode("utf-8")
    except NameError:
        pass
    if isinstance(obj, dict):
        return dict((str(k), _json_safe(v, depth + 1)) for k, v in obj.items())
    if isinstance(obj, (list, tuple, set)):
        return [_json_safe(v, depth + 1) for v in obj]
    try:
        if hasattr(obj, "ToString"):
            tname = type(obj).__name__
            if tname in ("Guid", "guid"):
                return str(obj)
    except Exception:
        pass
    try:
        name = type(obj).__name__
        if name in ("Point3d", "Vector3d", "Point2d"):
            if hasattr(obj, "Z"):
                return [float(obj.X), float(obj.Y), float(obj.Z)]
            return [float(obj.X), float(obj.Y)]
        if name == "BoundingBox":
            return {
                "min": _json_safe(obj.Min, depth + 1),
                "max": _json_safe(obj.Max, depth + 1),
            }
    except Exception:
        pass
    try:
        # System.Drawing.Color → [r,g,b]
        if hasattr(obj, "R") and hasattr(obj, "G") and hasattr(obj, "B"):
            try:
                return [int(obj.R), int(obj.G), int(obj.B)]
            except Exception:
                pass
        return str(obj)
    except Exception:
        return repr(obj)


def _guid_str(obj):
    try:
        return str(obj)
    except Exception:
        return str(obj)


def _layer_color(layer):
    try:
        c = layer.Color
        return [int(c.R), int(c.G), int(c.B)]
    except Exception:
        return None


def _doc_info(full_layers=False):
    doc = sc.doc
    if doc is None:
        return {"open": False}
    try:
        units = str(doc.ModelUnitSystem)
    except Exception:
        units = "unknown"
    try:
        abs_tol = float(doc.ModelAbsoluteTolerance)
    except Exception:
        abs_tol = None
    try:
        angle_tol = float(doc.ModelAngleToleranceRadians)
    except Exception:
        angle_tol = None

    object_count = 0
    try:
        object_count = int(doc.Objects.Count)
    except Exception:
        pass

    filepath = ""
    try:
        filepath = doc.Path or ""
    except Exception:
        pass

    name = ""
    try:
        name = doc.Name or ""
    except Exception:
        pass

    out = {
        "open": True,
        "name": name,
        "path": filepath,
        "units": units,
        "absolute_tolerance": abs_tol,
        "angle_tolerance_radians": angle_tol,
        "object_count": object_count,
    }

    if full_layers:
        layers = []
        try:
            for i in range(doc.Layers.Count):
                layer = doc.Layers[i]
                layers.append(
                    {
                        "index": i,
                        "name": layer.Name,
                        "full_name": layer.FullPath if hasattr(layer, "FullPath") else layer.Name,
                        "visible": bool(layer.IsVisible),
                        "locked": bool(layer.IsLocked),
                        "color": _layer_color(layer),
                    }
                )
        except Exception as e:
            layers = [{"error": str(e)}]
        out["layer_count"] = len(layers)
        out["layers"] = layers
    else:
        try:
            out["layer_count"] = int(doc.Layers.Count)
        except Exception:
            out["layer_count"] = None

    return out


def _object_summary(obj, detail=False):
    if obj is None:
        return None
    data = {
        "id": _guid_str(obj.Id),
        "type": type(obj.Geometry).__name__ if obj.Geometry else "?",
        "layer_index": obj.Attributes.LayerIndex if obj.Attributes else -1,
    }
    try:
        data["name"] = obj.Attributes.Name or ""
    except Exception:
        data["name"] = ""
    try:
        layer = sc.doc.Layers[obj.Attributes.LayerIndex]
        data["layer"] = layer.FullPath if hasattr(layer, "FullPath") else layer.Name
    except Exception:
        pass
    try:
        bb = obj.Geometry.GetBoundingBox(True)
        data["bbox"] = _json_safe(bb)
    except Exception:
        pass
    if detail:
        try:
            data["is_valid"] = bool(obj.Geometry.IsValid)
        except Exception:
            pass
        try:
            g = obj.Geometry
            if hasattr(g, "GetLength") and type(g).__name__ in ("NurbsCurve", "LineCurve", "ArcCurve", "PolyCurve", "Curve"):
                data["length"] = float(g.GetLength())
            if hasattr(g, "GetArea"):
                try:
                    data["area"] = float(g.GetArea())
                except Exception:
                    pass
            if hasattr(g, "Volume") and type(g).__name__ == "Brep":
                try:
                    data["volume"] = float(g.GetVolume())
                except Exception:
                    pass
        except Exception:
            pass
    return data


def _build_base_namespace():
    # Deliberately NO RhinoCycles probe and NO threads/sockets.
    return {
        "Rhino": Rhino,
        "sc": sc,
        "rs": rs,
        "System": System,
        "json": json,
        "os": os,
        "math": __import__("math"),
        "time": time,
    }


_BASE_NS = None


def _make_stdout_buf():
    # IronPython 2.7: io.StringIO wants unicode; StringIO.StringIO is 8-bit safe.
    try:
        from StringIO import StringIO as _SIO
        return _SIO()
    except Exception:
        pass
    try:
        from io import StringIO as _SIO
        return _SIO()
    except Exception:
        return None


def _exec_python(code):
    stdout_buf = _make_stdout_buf()
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    if stdout_buf is not None:
        sys.stdout = stdout_buf
        sys.stderr = stdout_buf
    error = None
    result = None
    try:
        ns = dict(_BASE_NS or _build_base_namespace())
        ns["result"] = None
        compiled = compile(code, "<rhino-mcp>", "exec")
        exec(compiled, ns)
        if "result" in ns:
            result = ns["result"]
    except Exception:
        error = traceback.format_exc()
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr
    out_text = ""
    if stdout_buf is not None:
        try:
            out_text = stdout_buf.getvalue()
        except Exception:
            out_text = ""
    return {
        "result": _json_safe(result),
        "stdout": out_text,
        "error": error,
    }


def _run_command(cmd, echo=False):
    ok = False
    err = None
    try:
        ok = bool(Rhino.RhinoApp.RunScript(cmd, bool(echo)))
    except Exception:
        err = traceback.format_exc()
    return {"ok": ok, "error": err, "command": cmd}


def _list_objects(limit=200, layer=None, type_filter=None):
    doc = sc.doc
    if doc is None:
        return []
    out = []
    count = 0
    try:
        for obj in doc.Objects:
            if layer is not None:
                try:
                    lname = doc.Layers[obj.Attributes.LayerIndex].Name
                    if lname != layer and not lname.endswith(layer):
                        continue
                except Exception:
                    continue
            if type_filter:
                tname = type(obj.Geometry).__name__ if obj.Geometry else ""
                if type_filter.lower() not in tname.lower():
                    continue
            out.append(_object_summary(obj, detail=False))
            count += 1
            if count >= int(limit):
                break
    except Exception as e:
        return {"error": str(e), "objects": out}
    return out


def _object_info(obj_id):
    doc = sc.doc
    if doc is None:
        return {"error": "No document"}
    try:
        guid = System.Guid(str(obj_id))
        obj = doc.Objects.Find(guid)
        if obj is None:
            return {"error": "Object not found", "id": obj_id}
        return _object_summary(obj, detail=True)
    except Exception:
        return {"error": traceback.format_exc(), "id": obj_id}


def _as_brep(g):
    """Extrusion/other solids → Brep for area/volume queries."""
    if g is None:
        return None
    try:
        if type(g).__name__ == "Brep":
            return g
        if hasattr(g, "ToBrep"):
            return g.ToBrep()
    except Exception:
        pass
    return None


def _measure(ids=None, sample_limit=50):
    doc = sc.doc
    if doc is None:
        return {"error": "No document"}
    objs = []
    if ids:
        for id_str in ids:
            try:
                o = doc.Objects.Find(System.Guid(str(id_str)))
                if o is not None:
                    objs.append(o)
            except Exception:
                pass
    else:
        try:
            objs = list(doc.Objects.GetSelectedObjects(True, False))
        except Exception:
            objs = []
        if not objs:
            objs = list(doc.Objects)

    rows = []
    total_length = 0.0
    total_area = 0.0
    total_volume = 0.0
    mins = [1e300, 1e300, 1e300]
    maxs = [-1e300, -1e300, -1e300]

    for obj in objs[:500]:
        g = obj.Geometry
        if g is None:
            continue
        row = {"id": _guid_str(obj.Id), "type": type(g).__name__}
        try:
            row["name"] = obj.Attributes.Name or ""
        except Exception:
            row["name"] = ""
        try:
            bb = g.GetBoundingBox(True)
            if bb.IsValid:
                row["bbox"] = _json_safe(bb)
                for i, v in enumerate([bb.Min.X, bb.Min.Y, bb.Min.Z]):
                    if v < mins[i]:
                        mins[i] = v
                for i, v in enumerate([bb.Max.X, bb.Max.Y, bb.Max.Z]):
                    if v > maxs[i]:
                        maxs[i] = v
        except Exception:
            pass
        try:
            # Curves
            if hasattr(g, "GetLength"):
                try:
                    ln = float(g.GetLength())
                    row["length"] = ln
                    total_length += ln
                except Exception:
                    pass
            # Faces / solids (Extrusion first converts to Brep)
            br = _as_brep(g)
            if br is not None:
                try:
                    ar = float(br.GetArea())
                    row["area"] = ar
                    total_area += ar
                except Exception:
                    pass
                try:
                    vol = float(br.GetVolume())
                    row["volume"] = vol
                    total_volume += vol
                except Exception:
                    pass
            elif hasattr(g, "GetArea"):
                try:
                    ar = float(g.GetArea())
                    row["area"] = ar
                    total_area += ar
                except Exception:
                    pass
            if hasattr(g, "GetVolume"):
                try:
                    vol = float(g.GetVolume())
                    row["volume"] = vol
                    total_volume += vol
                except Exception:
                    pass
        except Exception:
            pass
        rows.append(row)

    return {
        "count": len(rows),
        "totals": {
            "length": total_length,
            "area": total_area,
            "volume": total_volume,
        },
        "bbox": {
            "min": mins if mins[0] < 1e299 else None,
            "max": maxs if maxs[0] > -1e299 else None,
        },
        "objects": rows,
    }


def _select(filters=None, filters_type="and", limit=500):
    """Select objects in the document by simple filters. Returns matched ids."""
    doc = sc.doc
    if doc is None:
        return {"error": "No document"}
    filters = filters or {}
    mode = (filters_type or "and").lower()
    name = filters.get("name")
    name_sub = filters.get("name_contains") or name
    type_sub = filters.get("type") or filters.get("geometry")
    layer_sub = filters.get("layer")
    color = filters.get("color")  # [r,g,b]

    matched = []
    try:
        for obj in doc.Objects:
            checks = []
            if name is not None and not isinstance(name_sub, type(None)):
                try:
                    n = obj.Attributes.Name or ""
                except Exception:
                    n = ""
                if isinstance(name, list):
                    checks.append(n in name)
                else:
                    checks.append(n == str(name))
            if name_sub is not None and name is None:
                try:
                    n = obj.Attributes.Name or ""
                except Exception:
                    n = ""
                checks.append(str(name_sub).lower() in n.lower())
            if type_sub:
                tname = type(obj.Geometry).__name__ if obj.Geometry else ""
                checks.append(str(type_sub).lower() in tname.lower())
            if layer_sub:
                try:
                    lname = doc.Layers[obj.Attributes.LayerIndex].Name
                    full = doc.Layers[obj.Attributes.LayerIndex].FullPath if hasattr(doc.Layers[obj.Attributes.LayerIndex], "FullPath") else lname
                    s = str(layer_sub).lower()
                    checks.append(s in lname.lower() or s in str(full).lower() or lname.lower().endswith(s))
                except Exception:
                    checks.append(False)
            if color is not None:
                try:
                    c = obj.Attributes.ObjectColor
                    checks.append(int(c.R) == int(color[0]) and int(c.G) == int(color[1]) and int(c.B) == int(color[2]))
                except Exception:
                    checks.append(False)

            if not checks:
                ok = True
            elif mode == "or":
                ok = any(checks)
            else:
                ok = all(checks)
            if ok:
                matched.append(obj)
                if len(matched) >= int(limit):
                    break
    except Exception as e:
        return {"error": str(e)}

    try:
        doc.Objects.UnselectAll()
    except Exception:
        pass
    for obj in matched:
        try:
            obj.Select(True)
        except Exception:
            pass
    try:
        doc.Views.Redraw()
    except Exception:
        pass

    return {
        "selected": len(matched),
        "filters_type": mode,
        "ids": [_guid_str(o.Id) for o in matched[:200]],
    }


def _set_attrs(ids=None, name=None, color=None, layer=None, rename_mode="set"):
    doc = sc.doc
    if doc is None:
        return {"error": "No document"}
    if not ids:
        try:
            ids = [_guid_str(o.Id) for o in doc.Objects.GetSelectedObjects(True, False)]
        except Exception:
            ids = []
    changed = []
    for id_str in ids:
        try:
            guid = System.Guid(str(id_str))
            obj = doc.Objects.Find(guid)
            if obj is None:
                continue
            attrs = obj.Attributes.Duplicate()
            dirty = False
            if name is not None:
                if rename_mode == "suffix":
                    attrs.Name = (attrs.Name or "") + str(name)
                elif rename_mode == "prefix":
                    attrs.Name = str(name) + (attrs.Name or "")
                else:
                    attrs.Name = str(name)
                dirty = True
            if color is not None:
                try:
                    r, g, b = [int(x) for x in color[:3]]
                    attrs.ObjectColor = System.Drawing.Color.FromArgb(r, g, b)
                    attrs.ColorSource = Rhino.DocObjects.ObjectColorSource.ColorFromObject
                    dirty = True
                except Exception:
                    pass
            if layer is not None:
                # find or create top-level / nested by name path
                lname = str(layer)
                found = -1
                for i in range(doc.Layers.Count):
                    L = doc.Layers[i]
                    if L.Name == lname or (hasattr(L, "FullPath") and L.FullPath == lname):
                        found = i
                        break
                if found < 0:
                    li = Rhino.DocObjects.Layer()
                    li.Name = lname.replace("::", "-").replace("/", "-")
                    found = doc.Layers.Add(li)
                attrs.LayerIndex = found
                dirty = True
            if dirty:
                if doc.Objects.ModifyAttributes(obj.Id, attrs, True):
                    changed.append(id_str)
        except Exception:
            pass
    try:
        doc.Views.Redraw()
    except Exception:
        pass
    return {"changed": changed, "count": len(changed)}


def _handle_payload(payload):
    """Execute one request. Returns response dict."""
    op = payload.get("op") or payload.get("type")
    req_id = payload.get("id")

    def ok(result):
        return {"id": req_id, "ok": True, "result": _json_safe(result), "error": None}

    def fail(err):
        return {"id": req_id, "ok": False, "result": None, "error": str(err)}

    if op == "ping":
        info = {
            "pong": True,
            "transport": "file-queue",
            "queue_dir": QUEUE_DIR,
            "poll_ms": POLL_INTERVAL_MS,
            "rhino_version": str(Rhino.RhinoApp.Version),
            "python": sys.version.split()[0],
            "document": _doc_info(full_layers=False),
            "busy": False,
        }
        return ok(info)

    if op == "exec":
        code = payload.get("code") or ""
        try:
            string_types = (str, unicode)  # IronPython 2.x
        except NameError:
            string_types = (str,)
        if not isinstance(code, string_types):
            return fail("code must be a string (got %s)" % type(code).__name__)
        if len(code) > MAX_CODE_BYTES:
            return fail("code too large")
        out = _exec_python(code)
        if out.get("error"):
            return {
                "id": req_id,
                "ok": False,
                "result": out.get("result"),
                "stdout": out.get("stdout"),
                "error": out.get("error"),
            }
        return {
            "id": req_id,
            "ok": True,
            "result": out.get("result"),
            "stdout": out.get("stdout"),
            "error": None,
        }

    if op == "command":
        cmd = payload.get("cmd") or ""
        echo = bool(payload.get("echo", False))
        return ok(_run_command(cmd, echo=echo))

    if op == "document_info":
        return ok(_doc_info(full_layers=True))

    if op == "list_objects":
        limit = int(payload.get("limit", 200))
        layer = payload.get("layer")
        type_filter = payload.get("type")
        return ok(_list_objects(limit=limit, layer=layer, type_filter=type_filter))

    if op == "object_info":
        return ok(_object_info(payload.get("id")))

    if op == "measure":
        return ok(_measure(ids=payload.get("ids"), sample_limit=payload.get("sample_limit", 50)))

    if op == "select":
        return ok(
            _select(
                filters=payload.get("filters") or {},
                filters_type=payload.get("filters_type") or "and",
                limit=payload.get("limit", 500),
            )
        )

    if op == "set_attrs":
        return ok(
            _set_attrs(
                ids=payload.get("ids"),
                name=payload.get("name"),
                color=payload.get("color"),
                layer=payload.get("layer"),
                rename_mode=payload.get("rename_mode") or "set",
            )
        )

    return fail("Unknown op: %s" % op)


# ---------------------------------------------------------------------------
# File-queue pump — everything runs on the Rhino UI thread.
# Request:  <priority>_<seq>_<id>.req.json   (priority 0 = control, 5 = work)
# Response: same base + .resp.json ; bridge deletes the request.
# Heartbeat: heartbeat.json (rewritten around every request).
# ---------------------------------------------------------------------------


def _atomic_write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    # IronPython 2.7 has no os.replace. Windows os.rename fails if dest exists,
    # so remove first — heartbeat.json is rewritten in place every tick/request.
    if hasattr(os, "replace"):
        os.replace(tmp, path)
        return
    try:
        if os.path.exists(path):
            os.remove(path)
    except Exception:
        pass
    try:
        os.rename(tmp, path)
    except OSError:
        try:
            os.remove(path)
        except Exception:
            pass
        os.rename(tmp, path)


def _write_heartbeat(payload):
    try:
        path = os.path.join(QUEUE_DIR, HEARTBEAT_NAME)
        _atomic_write_json(path, payload)
    except Exception:
        pass


def _purge_queue():
    try:
        if not os.path.isdir(QUEUE_DIR):
            os.makedirs(QUEUE_DIR)
            return
        for name in os.listdir(QUEUE_DIR):
            if name == HEARTBEAT_NAME:
                continue
            try:
                os.remove(os.path.join(QUEUE_DIR, name))
            except Exception:
                pass
    except Exception:
        pass


def _drain_queue(state):
    try:
        names = [
            n
            for n in os.listdir(QUEUE_DIR)
            if n.endswith(".req.json") and not n.startswith(".")
        ]
    except Exception:
        return
    # Numeric-prefix sort: 0_ (control) before 5_ (work). Fall back to name.
    names.sort()
    # Process at most one request per tick so a long exec does not also
    # swallow a burst of work before the UI thread can breathe / redraw.
    for name in names[:1]:
        if not state.running:
            return
        req_path = os.path.join(QUEUE_DIR, name)
        try:
            with open(req_path, "r") as f:
                payload = json.load(f)
            if not isinstance(payload, dict):
                payload = {"id": None, "op": "error", "error": "payload must be a JSON object"}
        except Exception as e:
            payload = {"id": None, "op": "error", "error": "bad request file: %s" % e}

        op_name = payload.get("op") or payload.get("type") or "unknown"
        _write_heartbeat(
            {
                "busy": True,
                "op": op_name,
                "id": payload.get("id"),
                "ts": time.time(),
                "started": time.time(),
                "rhino_version": str(Rhino.RhinoApp.Version),
                "python": sys.version.split()[0],
                "queue_dir": QUEUE_DIR,
            }
        )

        try:
            if payload.get("op") == "error":
                resp = {
                    "id": payload.get("id"),
                    "ok": False,
                    "result": None,
                    "error": payload.get("error"),
                }
            else:
                resp = _handle_payload(payload)
        except Exception:
            resp = {
                "id": payload.get("id"),
                "ok": False,
                "result": None,
                "error": traceback.format_exc(),
            }

        resp_path = req_path[: -len(".req.json")] + ".resp.json"
        try:
            _atomic_write_json(resp_path, resp)
        except Exception:
            _diag("resp write failed for %s:\n%s" % (name, traceback.format_exc()))
        try:
            os.remove(req_path)
        except Exception:
            pass

        _write_heartbeat(
            {
                "busy": False,
                "op": None,
                "id": None,
                "ts": time.time(),
                "last_op": op_name,
                "last_id": payload.get("id"),
                "last_duration_ms": int((time.time() - (payload.get("_t0") or time.time())) * 1000),
                "rhino_version": str(Rhino.RhinoApp.Version),
                "python": sys.version.split()[0],
                "queue_dir": QUEUE_DIR,
            }
        )


class BridgeState(object):
    def __init__(self):
        self.running = False
        self.timer = None


def _stop_existing():
    old = sys.modules.get(STATE_KEY)
    if old is None:
        return
    old.running = False
    timer = getattr(old, "timer", None)
    if timer is not None:
        try:
            timer.Stop()
        except Exception:
            pass
        try:
            timer.Dispose()
        except Exception:
            pass
    try:
        del sys.modules[STATE_KEY]
    except Exception:
        pass


def start():
    global _BASE_NS
    _stop_existing()
    _BASE_NS = _build_base_namespace()
    state = BridgeState()
    state.running = True
    _purge_queue()
    _write_heartbeat(
        {
            "busy": False,
            "op": None,
            "id": None,
            "ts": time.time(),
            "started_at": time.time(),
            "rhino_version": str(Rhino.RhinoApp.Version),
            "python": sys.version.split()[0],
            "queue_dir": QUEUE_DIR,
            "poll_ms": POLL_INTERVAL_MS,
        }
    )

    # The ONLY recurring mechanism: one WinForms timer on the UI thread.
    try:
        from System.Windows.Forms import Timer

        def _on_tick(sender, args):
            if not state.running:
                return
            try:
                _drain_queue(state)
            except Exception:
                _diag("tick error:\n" + traceback.format_exc())

        timer = Timer()
        timer.Interval = POLL_INTERVAL_MS
        timer.Tick += _on_tick
        timer.Start()
        state.timer = timer
    except Exception:
        state.timer = None
        _diag("timer creation failed:\n" + traceback.format_exc())

    sys.modules[STATE_KEY] = state

    msg = "Rhino MCP bridge (file-queue) polling %s every %sms  (python=%s, rhino=%s, timer=%s)" % (
        QUEUE_DIR,
        POLL_INTERVAL_MS,
        sys.version.split()[0],
        Rhino.RhinoApp.Version,
        state.timer is not None,
    )
    _diag("start: " + msg)
    try:
        Rhino.RhinoApp.WriteLine(msg)
    except Exception:
        pass
    print(msg)
    return state


# Auto-start when executed as a script (RunPythonScript / EditPythonScript).
# When imported as module `bridge` (bootstrap.py), the caller invokes start().
if __name__ != "bridge":
    start()
