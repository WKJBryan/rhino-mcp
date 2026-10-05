# Emergency re-register: restart the bridge (timer + dispatch) and prove exec works
import sys
import traceback
import Rhino

info = {"stage": "bootstrap"}
try:
    # import start from the real bridge path
    path = r"C:\Users\bryan\XiaomiMiMoProjects\rhino-mcp\rhino"
    if path not in sys.path:
        sys.path.insert(0, path)
    import bridge as br
    try:
        br.start()
        info["bridge"] = "restarted"
        info["timer"] = str(sys.modules.get(br.STATE_KEY).timer is not None)
    except Exception:
        info["bridge_err"] = traceback.format_exc()
    info["exec"] = "ok"
    result = info
except Exception:
    result = {"error": traceback.format_exc()}
