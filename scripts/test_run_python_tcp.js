const { spawn } = require("child_process");
const os = require("os");
const path = require("path");

const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: Object.assign({}, process.env, {
    RHINO_MCP_QUEUE: path.join(os.tmpdir(), "rhino-mcp-queue"),
    RHINO_MCP_TIMEOUT_MS: "15000",
  }),
});

let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
});
function send(msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
setTimeout(() => {
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "rhino_run_python", arguments: { code: "result = 40+2" } },
  });
  setTimeout(() => {
    const lines = buf
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const r = lines.find((x) => x.id === 2);
    const text =
      (r && r.result && r.result.content && r.result.content[0] && r.result.content[0].text) || "";
    const ok = text.includes("42");
    console.log(ok ? "PASS run_python with TCP up" : "FAIL run_python: " + text.slice(0, 300));
    child.kill();
    process.exit(ok ? 0 : 1);
  }, 2500);
}, 500);
