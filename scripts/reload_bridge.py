import json, os, time

q = os.environ.get("RHINO_MCP_QUEUE") or os.path.join(
    os.environ.get("TEMP", os.path.expanduser("~")), "rhino-mcp-queue"
)

def call(op, payload=None, timeout=15.0, priority=5):
    body = {"id": "r%d" % int(time.time() * 1000), "op": op}
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
            with open(resp) as f:
                data = json.load(f)
            try:
                os.remove(resp)
            except Exception:
                pass
            return (time.time() - t0) * 1000.0, data
        time.sleep(0.002)
    try:
        os.remove(req)
    except Exception:
        pass
    return None, {"error": "timeout"}

code = r'''
import sys, traceback
path = r"C:\Users\bryan\XiaomiMiMoProjects\rhino-mcp\rhino"
if path not in sys.path:
    sys.path.insert(0, path)
info = {}
try:
    if "bridge" in sys.modules:
        del sys.modules["bridge"]
    import bridge as br
    info["imported"] = True
    st = br.start()
    info["started"] = True
    info["timer"] = st.timer is not None
    info["poll_ms"] = br.POLL_INTERVAL_MS
    info["name"] = __name__
    result = info
except Exception:
    result = {"error": traceback.format_exc(), "info": info}
'''

ms, data = call("exec", {"code": code})
print("reload: %.1f ms" % (ms or -1))
print(json.dumps(data, indent=2)[:1500])
