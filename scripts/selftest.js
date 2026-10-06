#!/usr/bin/env node
/**
 * Self-test for rhino-mcp server.js against a mocked file-queue bridge
 * (no Rhino needed). The mock responder here plays the role of bridge.py:
 * polls the queue dir, answers requests, writes response files.
 *
 * Verifies: MCP handshake, 15-tool registry, request/response round-trip,
 * throughput, friendly timeout error when no bridge is running, recovery
 * when it comes back, and queue hygiene (no leftover files).
 *
 * Usage: node scripts/selftest.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const QUEUE = fs.mkdtempSync(path.join(os.tmpdir(), "rhino-mcp-selftest-"));
const MCP_TIMEOUT = "3000";
let failures = 0;
let responderTimer = null;

function check(name, cond, detail) {
  if (cond) {
    console.log(`PASS  ${name}${detail ? "  (" + detail + ")" : ""}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? "  (" + detail + ")" : ""}`);
  }
}

function startResponder() {
  responderTimer = setInterval(() => {
    let names;
    try {
      names = fs.readdirSync(QUEUE).filter((n) => n.endsWith(".req.json"));
    } catch {
      return;
    }
    for (const name of names) {
      const reqPath = path.join(QUEUE, name);
      let req;
      try {
        req = JSON.parse(fs.readFileSync(reqPath, "utf8"));
      } catch {
        continue;
      }
      let result;
      if (req.op === "ping") result = { pong: true, mock: true };
      else if (req.op === "exec") result = { received_code: req.code };
      else if (req.op === "list_objects") result = [];
      else if (req.op === "object_info") result = { id: req.id, mock: true };
      else if (req.op === "command") result = { ok: true, mock: true };
      else if (req.op === "measure") result = { count: 0, totals: { length: 0, area: 0, volume: 0 } };
      else if (req.op === "select") result = { selected: 0, ids: [] };
      else if (req.op === "set_attrs") result = { changed: [], count: 0 };
      else result = { unknown_op: req.op };
      const respPath = reqPath.slice(0, -".req.json".length) + ".resp.json";
      const tmp = respPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ id: req.id, ok: true, result, error: null }));
      fs.renameSync(tmp, respPath);
      try {
        fs.unlinkSync(reqPath);
      } catch {}
    }
  }, 4);
}

function stopResponder() {
  if (responderTimer) clearInterval(responderTimer);
  responderTimer = null;
}

function startMcp() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: Object.assign({}, process.env, {
      RHINO_MCP_QUEUE: QUEUE,
      RHINO_MCP_TIMEOUT_MS: MCP_TIMEOUT,
      // Force the file-queue path so the mock bridge is the transport under test.
      RHINO_MCP_DISABLE_TCP: "1",
    }),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const client = {
    child,
    buf: "",
    nextId: 1,
    waiters: [],
    send(method, params) {
      return new Promise((resolve) => {
        const id = client.nextId++;
        client.waiters.push({ id, resolve });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    notify(method) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
    },
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    client.buf += chunk;
    let idx;
    while ((idx = client.buf.indexOf("\n")) >= 0) {
      const line = client.buf.slice(0, idx).trim();
      client.buf = client.buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined) {
        const w = client.waiters.find((x) => x.id === msg.id);
        if (w) {
          client.waiters.splice(client.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    }
  });
  return client;
}

async function main() {
  startResponder();
  const mcp = startMcp();

  const init = await mcp.send("initialize", { protocolVersion: "2024-11-05" });
  check("initialize handshake", init.result && init.result.serverInfo.name === "rhino-mcp", init.result && init.result.serverInfo.version);
  mcp.notify("notifications/initialized");

  const tools = await mcp.send("tools/list", {});
  const names = (tools.result.tools || []).map((t) => t.name);
  check("tool count = 24", names.length === 24, String(names.length));
  check(
    "dropped tools absent",
    !names.some((n) =>
      ["rhino_layers", "rhino_health", "rhino_screenshot", "rhino_document_info", "rhino_add_sphere", "rhino_add_point", "rhino_add_curve", "rhino_report_lesson", "rhino_get_lessons"].includes(n)
    )
  );
  check(
    "core tools present",
    [
      "rhino_status",
      "rhino_run_python",
      "rhino_run_command",
      "rhino_get_document",
      "rhino_get_layers",
      "rhino_ensure_layer",
      "rhino_setup_layers",
      "rhino_list_objects",
      "rhino_object_info",
      "rhino_delete",
      "rhino_transform",
      "rhino_zoom",
      "rhino_get_points",
      "rhino_screenshot_window",
      "rhino_export",
      "rhino_measure",
      "rhino_select",
      "rhino_set_attrs",
      "rhino_set_intent",
      "rhino_get_policy",
      "rhino_check_scene",
      "rhino_create_mass",
      "rhino_add_subd",
      "rhino_add_mesh",
    ].every((n) => names.includes(n))
  );

  const st = await mcp.send("tools/call", { name: "rhino_status", arguments: {} });
  check("rhino_status via mock", st.result && st.result.content && st.result.content[0].text.includes("pong"));

  const py = await mcp.send("tools/call", { name: "rhino_run_python", arguments: { code: "result = 1" } });
  check("rhino_run_python passes code", py.result && py.result.content[0].text.includes("received_code"));

  const meas = await mcp.send("tools/call", { name: "rhino_measure", arguments: {} });
  check("rhino_measure via mock", meas.result && meas.result.content[0].text.includes("totals"));

  const sel = await mcp.send("tools/call", { name: "rhino_select", arguments: { filters: { type: "Brep" } } });
  check("rhino_select via mock", sel.result && sel.result.content[0].text.includes("selected"));

  const attrs = await mcp.send("tools/call", { name: "rhino_set_attrs", arguments: { name: "tower" } });
  check("rhino_set_attrs via mock", attrs.result && attrs.result.content[0].text.includes("changed"));

  // Control-lane ping should still answer while a work request is queued
  // (mock responder is fast, so we just check both complete).
  const [st2, py2] = await Promise.all([
    mcp.send("tools/call", { name: "rhino_status", arguments: {} }),
    mcp.send("tools/call", { name: "rhino_run_python", arguments: { code: "result = 2" } }),
  ]);
  check("parallel status+run_python both complete", !!(st2.result && py2.result));

  const N = 20;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    await mcp.send("tools/call", { name: "rhino_status", arguments: {} });
  }
  const avgMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  check(`avg round-trip over mock (${avgMs.toFixed(2)} ms/call)`, avgMs < 50);

  // Bridge disappears → friendly timeout error (server child has 3s timeout).
  stopResponder();
  const tDown = Date.now();
  const down = await mcp.send("tools/call", { name: "rhino_status", arguments: {} });
  const downMs = Date.now() - tDown;
  const downText = down.result && down.result.content && down.result.content[0].text;
  check(
    "bridge-down error is friendly",
    down.result && down.result.isError === true && /no response in queue/.test(downText),
    `${(downText || "").slice(0, 70)}… after ${downMs}ms`
  );

  // Bridge returns → next call recovers.
  startResponder();
  const up = await mcp.send("tools/call", { name: "rhino_status", arguments: {} });
  check("recovers after bridge restart", up.result && up.result.content[0].text.includes("pong"));

  stopResponder();
  mcp.child.kill();

  await new Promise((r) => setTimeout(r, 50));
  const leftovers = fs.readdirSync(QUEUE).filter((n) => n.endsWith(".req.json") || n.endsWith(".resp.json"));
  check("queue left clean (no req/resp files)", leftovers.length === 0, leftovers.join(","));

  try {
    fs.rmSync(QUEUE, { recursive: true, force: true });
  } catch {}
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  stopResponder();
  process.exit(1);
});
