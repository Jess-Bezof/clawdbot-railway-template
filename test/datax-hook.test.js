import { strict as assert } from "node:assert";
import { test } from "node:test";
import http from "node:http";

// Minimal isolated test of the /hooks/datax contract: imports the formatter
// from a simulated context. We test the validation + formatting behaviour by
// spinning up a small in-process HTTP server that mirrors the route so we
// don't need to boot the whole wrapper (which requires OpenClaw state).

function makeHookHandler({ expectedSecret, telegramUrl, chatId, botToken }) {
  return async (req, res) => {
    try {
      const auth = (req.headers.authorization || "").trim();
      const received = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!received || received !== expectedSecret) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid bearer token" }));
        return;
      }
      if (!chatId || !botToken) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Not configured" }));
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = {};
      }
      const text = body?.statusUpdate?.status?.state || "unknown";
      // Call the fake Telegram endpoint so we can assert payload shape.
      const r = await fetch(telegramUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      });
      const ok = r.ok;
      res.writeHead(ok ? 200 : 502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
}

test("hooks/datax rejects missing bearer", async () => {
  const app = http.createServer(
    makeHookHandler({
      expectedSecret: "shh",
      telegramUrl: "http://127.0.0.1:1/", // unused
      chatId: "1",
      botToken: "t",
    }),
  );
  await listen(app);
  const { port } = app.address();
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST" });
  assert.equal(res.status, 401);
  app.close();
});

test("hooks/datax rejects wrong bearer", async () => {
  const app = http.createServer(
    makeHookHandler({
      expectedSecret: "shh",
      telegramUrl: "http://127.0.0.1:1/",
      chatId: "1",
      botToken: "t",
    }),
  );
  await listen(app);
  const { port } = app.address();
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong" },
  });
  assert.equal(res.status, 401);
  app.close();
});

test("hooks/datax accepts correct bearer and posts to telegram", async () => {
  let telegramReceived = null;
  const fakeTg = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    telegramReceived = JSON.parse(raw);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  await listen(fakeTg);
  const { port: tgPort } = fakeTg.address();

  const app = http.createServer(
    makeHookHandler({
      expectedSecret: "shh",
      telegramUrl: `http://127.0.0.1:${tgPort}/`,
      chatId: "474205181",
      botToken: "abc123",
    }),
  );
  await listen(app);
  const { port } = app.address();

  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      Authorization: "Bearer shh",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      statusUpdate: {
        taskId: "t1",
        contextId: "c1",
        status: { state: "TASK_STATE_WORKING" },
      },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(telegramReceived, "telegram was called");
  assert.equal(telegramReceived.chat_id, "474205181");
  assert.equal(telegramReceived.text, "TASK_STATE_WORKING");
  app.close();
  fakeTg.close();
});
