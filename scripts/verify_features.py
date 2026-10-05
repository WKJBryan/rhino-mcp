import json, os, time

q = os.environ.get("RHINO_MCP_QUEUE") or os.path.join(
    os.environ.get("TEMP", os.path.expanduser("~")), "rhino-mcp-queue"
)

def call(op, payload=None, timeout=10.0, priority=5):
    body = {"id": "v%d" % int(time.time() * 1000), "op": op}
    if payload:
        body.update(payload)
    base = "%d_%d_%s" % (priority, int(time.time() * 1000), op)
    req = os.path.join(q, base + ".req.json")
    resp = os.path.join(q, base + ".resp.json")
    t0 = time.time()
    with open(req, "w") as f:
        json.dump(body, f)
    deadline = t0 + timeout
    while time.time() < deadline:
        if os.path.exists(resp):
            try:
                with open(resp) as f:
                    data = json.load(f)
                try:
                    os.remove(resp)
                except Exception:
                    pass
                return (time.time() - t0) * 1000.0, data
            except (IOError, OSError):
                pass  # writer still holds the file briefly
        time.sleep(0.002)
    try:
        os.remove(req)
    except Exception:
        pass
    return None, {"error": "timeout"}

print("=== lean ping ===")
ms, data = call("ping", priority=0)
print("%.1f ms" % (ms or -1))
print(json.dumps(data, indent=2)[:800])

print("\n=== heartbeat ===")
hb_path = os.path.join(q, "heartbeat.json")
if os.path.exists(hb_path):
    with open(hb_path) as f:
        print(f.read()[:500])
else:
    print("NO HEARTBEAT")

print("\n=== measure ===")
ms, data = call("measure", priority=0)
print("%.1f ms" % (ms or -1))
res = (data or {}).get("result") or {}
print("count=%s totals=%s" % (res.get("count"), res.get("totals")))

print("\n=== select type=Brep ===")
ms, data = call("select", {"filters": {"type": "Brep"}, "limit": 10}, priority=0)
print("%.1f ms" % (ms or -1))
print(json.dumps((data or {}).get("result"), indent=2)[:400])

print("\n=== set_attrs color on first id ===")
ms, data = call("measure", priority=0)
ids = ((data or {}).get("result") or {}).get("objects") or []
if ids:
    id0 = ids[0]["id"]
    ms, data = call("set_attrs", {"ids": [id0], "color": [255, 128, 0], "name": "MCP_TEST_MARK"}, priority=0)
    print("%.1f ms" % (ms or -1))
    print(json.dumps((data or {}).get("result"), indent=2))
else:
    print("no objects to tag")
