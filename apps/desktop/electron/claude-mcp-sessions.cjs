/**
 * Drift MCP (stdio) so Claude Code can list other Claude cards and send them
 * messages. Env: DRIFT_HOOK_PORT, DRIFT_CARD_ID.
 * Spawned with ELECTRON_RUN_AS_NODE=1 against this file.
 */
const http = require("node:http");

const PORT = process.env.DRIFT_HOOK_PORT;
const CARD = encodeURIComponent(process.env.DRIFT_CARD_ID || "");

function call(method, route, body) {
  return new Promise((resolve) => {
    if (!PORT) {
      resolve({ error: "DRIFT_HOOK_PORT is not set" });
      return;
    }
    const data = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: `/mcp/${CARD}/${route}`,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (c) => {
          out += c;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve({ error: "Could not parse Drift response" });
          }
        });
      }
    );
    req.on("error", () =>
      resolve({ error: "Could not reach Drift. Is the app still open?" })
    );
    req.end(data);
  });
}

const TOOLS = [
  {
    name: "list_sessions",
    description:
      "List other Claude sessions currently open on the Drift board (name, folder, status).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "send_to_session",
    description:
      "Send a message into another Claude session on the Drift board. The text is pasted into that session's terminal and submitted. wait_for_reply defaults to false in Drift v1.",
    inputSchema: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description: "Session name from list_sessions",
        },
        message: {
          type: "string",
          description: "Message to send; be specific so the peer has context",
        },
        wait_for_reply: {
          type: "boolean",
          description: "Reserved; Drift v1 returns immediately after send",
        },
      },
      required: ["session", "message"],
    },
  },
];

const reply = (id, result) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const text = (t, isError) => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError: true } : {}),
});

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "drift", version: "0.1.0" },
    });
  }
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "tools/call") {
    const args = params?.arguments || {};
    if (params?.name === "list_sessions") {
      const r = await call("GET", "sessions");
      if (r.error) return reply(id, text(r.error, true));
      const sessions = Array.isArray(r.sessions) ? r.sessions : [];
      if (!sessions.length) {
        return reply(
          id,
          text("No other Claude sessions on the Drift board.")
        );
      }
      return reply(
        id,
        text(
          sessions
            .map(
              (s) =>
                `- ${s.name}: folder ${s.folder || "?"}, status ${s.state || "?"}`
            )
            .join("\n")
        )
      );
    }
    if (params?.name === "send_to_session") {
      const r = await call("POST", "send", {
        session: args.session,
        message: args.message,
        wait: args.wait_for_reply === true,
      });
      if (r.error) return reply(id, text(r.error, true));
      return reply(id, text(r.reply ?? r.result ?? "sent"));
    }
    return process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${params?.name}` },
      })}\n`
    );
  }
  if (method === "ping") return reply(id, {});
  process.stdout.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unsupported method: ${method}` },
    })}\n`
  );
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      /* ignore */
    }
  }
});
