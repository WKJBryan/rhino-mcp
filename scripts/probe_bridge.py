import json, os, time
q = os.environ.get("RHINO_MCP_QUEUE") or os.path.join(
    os.environ.get("TEMP", os.path.expanduser("~")), "rhino-mcp-queue"
)
base = "%d_probe" % int(time.time() * 1000)
req = os.path.join(q, base + ".req.json")
resp = os.path.join(q, base + ".resp.json")
body = {"id": "probe", "op": "ping"}
if not os.path.isdir(q):
    os.makedirs(q)
with open(req, "w") as f:
    json.dump(body, f)
deadline = time.time() + 3
got = False
while time.time() < deadline:
    if os.path.exists(resp):
        got = True
        break
    time.sleep(0.01)
if got:
    with open(resp) as f:
        print(f.read())
    try:
        os.remove(resp)
    except Exception:
        pass
else:
    print("NO_RESPONSE within 3s; queue=" + q)
    if os.path.exists(req):
        print("request still present - bridge not draining")
        try:
            os.remove(req)
        except Exception:
            pass
