import json, os, time

q = os.environ.get("RHINO_MCP_QUEUE") or os.path.join(
    os.environ.get("TEMP", os.path.expanduser("~")), "rhino-mcp-queue"
)

def call(op, payload=None, timeout=20.0):
    body = {"id": "L%d" % int(time.time() * 1000), "op": op}
    if payload:
        body.update(payload)
    base = "0_%d_%s" % (int(time.time() * 1000), op)
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
                os.remove(resp)
                return (time.time() - t0) * 1000.0, data
            except (IOError, OSError):
                pass
        time.sleep(0.002)
    return None, {"error": "timeout"}

code = r'''
import clr, System, traceback
info = {}
try:
    dll = r"C:\Users\bryan\XiaomiMiMoProjects\rhino-mcp\plugin\bin\IntentHarness.dll"
    clr.AddReference(dll)
    from IntentHarness import IntentStore, TcpHost
    IntentStore.Load()
    TcpHost.Start()
    info["tcp_running"] = bool(TcpHost.IsRunning)
    info["port"] = int(TcpHost.Port)
    info["intent_path"] = str(IntentStore.IntentPath)
    result = info
except Exception:
    result = {"error": traceback.format_exc(), "info": info}
'''

ms, data = call("exec", {"code": code})
print("load: %.1f ms" % (ms or -1))
print(json.dumps(data, indent=2)[:2000])
