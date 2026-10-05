import json, os, time

q = os.environ.get("RHINO_MCP_QUEUE") or os.path.join(
    os.environ.get("TEMP", os.path.expanduser("~")), "rhino-mcp-queue"
)

def call(op, payload=None, timeout=10.0):
    body = {"id": "t%d" % int(time.time() * 1000), "op": op}
    if payload:
        body.update(payload)
    base = "%d_%s" % (int(time.time() * 1000), op)
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

times = []
for i in range(8):
    ms, data = call("ping")
    times.append(ms)

# also a small exec
ms_exec, data_exec = call("exec", {"code": "result = 1+1"})
ms_doc, data_doc = call("document_info")

print("ping times ms:", ["%.1f" % t if t else "TIMEOUT" for t in times])
ok = [t for t in times if t]
if ok:
    print("ping avg=%.1f min=%.1f max=%.1f" % (sum(ok)/len(ok), min(ok), max(ok)))
print("exec 1+1: %.1f ms result=%s" % (ms_exec or -1, data_exec.get("result") if isinstance(data_exec, dict) else data_exec))
print("document_info: %.1f ms open=%s" % (ms_doc or -1, (data_doc.get("result") or {}).get("open") if isinstance(data_doc, dict) else "?"))
