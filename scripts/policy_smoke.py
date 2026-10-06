"""TCP policy-gate smoke test against IntentHarness.rhp (port 9545)."""
import json
import socket
import sys
import time

PORT = 9545
RUN = str(int(time.time()))[-6:]


def call(op, payload=None, timeout=15.0):
    body = {"id": op + "-1", "op": op}
    if payload:
        body.update(payload)
    s = socket.create_connection(("127.0.0.1", PORT), timeout=timeout)
    s.sendall((json.dumps(body) + "\n").encode("utf-8"))
    buf = b""
    s.settimeout(timeout)
    try:
        while b"\n" not in buf:
            chunk = s.recv(65536)
            if not chunk:
                break
            buf += chunk
    finally:
        s.close()
    line = buf.split(b"\n", 1)[0].decode("utf-8")
    return json.loads(line) if line else {"error": "empty"}


def unwrap(msg):
    if isinstance(msg, dict) and "result" in msg and "ok" in msg:
        return msg["result"]
    return msg


def show(title, msg):
    print("=== %s ===" % title)
    print(json.dumps(msg, indent=2)[:900])
    print()
    return msg


failures = 0


def check(name, cond, detail=""):
    global failures
    if cond:
        print("PASS  %s %s" % (name, detail))
    else:
        failures += 1
        print("FAIL  %s %s" % (name, detail))


ping = unwrap(show("ping", call("ping")))
check("tcp ping", bool(ping.get("pong") or ping.get("ok") or "pong" in str(ping)), str(ping)[:80])

intent = {
    "project": "Test Tower",
    "units": "mm",
    "vocabulary": ["tower", "podium", "core"],
    "massing": [
        {"name_contains": "tower", "min_height_mm": 20000, "min_aspect_h_over_w": 1.5},
        {"name_contains": "podium", "max_height_mm": 15000, "min_footprint_m2": 20},
    ],
    "limits": {"max_objects": 5000, "max_unnamed": 0},
    "allow": {"subd": False, "mesh": True, "floating": False, "unnamed": False},
}
set_i = unwrap(show("set_intent", call("set_intent", {"intent": intent})))
check("set_intent saved", set_i.get("saved") is True or "intent" in str(set_i), "")

pol = unwrap(show("get_policy", call("get_policy")))
check("get_policy has rules", "physics" in json.dumps(pol), "")

pod = unwrap(show("create podium", call("create_mass", {
    "name": "Podium_" + RUN, "layer": "A-ARCH::A-FLOR-SLAB",
    "x": 0, "y": 0, "z": 0, "dx": 20000, "dy": 15000, "dz": 8000
})))
check("podium created", bool(pod.get("id") or (pod.get("result") or {}).get("id") or pod.get("ok")), str(pod)[:120])

float_tower = unwrap(show("floating tower (expect block)", call("create_mass", {
    "name": "Tower_A_" + RUN, "layer": "A-ARCH::A-WALL-EXTR",
    "x": 1000, "y": 1000, "z": 50000, "dx": 4000, "dy": 4000, "dz": 40000
})))
text = json.dumps(float_tower)
check("floating blocked", "no_floating" in text or "POLICY_BLOCKED" in text, text[:150])

unnamed = unwrap(show("unnamed (expect block)", call("create_mass", {
    "name": "", "x": 0, "y": 0, "z": 0, "dx": 1000, "dy": 1000, "dz": 1000
})))
utext = json.dumps(unnamed)
check("unnamed blocked", "style_named" in utext or "POLICY_BLOCKED" in utext, utext[:150])

short_tower = unwrap(show("short tower (expect block)", call("create_mass", {
    "name": "Tower_Short_" + RUN, "layer": "A-ARCH::A-WALL-EXTR",
    "x": 0, "y": 0, "z": 8000, "dx": 4000, "dy": 4000, "dz": 5000
})))
stext = json.dumps(short_tower)
check("short tower blocked", "intent_massing" in stext or "min_height" in stext or "POLICY_BLOCKED" in stext, stext[:180])

tower = unwrap(show("valid tower on podium", call("create_mass", {
    "name": "Tower_Main_" + RUN, "layer": "A-ARCH::A-WALL-EXTR",
    "x": 5000, "y": 5000, "z": 8000, "dx": 4000, "dy": 4000, "dz": 30000
})))
check("tower created", bool(tower.get("id") or (tower.get("result") or {}).get("id") or tower.get("ok")), str(tower)[:120])

subd = unwrap(show("subd (expect block)", call("add_subd", {
    "name": "Blob_" + RUN, "x": 0, "y": 0, "z": 0, "dx": 1000, "dy": 1000, "dz": 1000
})))
subdtext = json.dumps(subd)
check("subd blocked", "style_subd" in subdtext or "allow.subd" in subdtext or "POLICY_BLOCKED" in subdtext, subdtext[:150])

scene = unwrap(show("check_scene", call("check_scene")))
check("check_scene returns", "objects" in json.dumps(scene) or "ok" in json.dumps(scene), "")

print("\n" + ("ALL PASS" if failures == 0 else "%d FAILURE(S)" % failures))
sys.exit(0 if failures == 0 else 1)
