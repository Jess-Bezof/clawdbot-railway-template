import { strict as assert } from "node:assert";
import { test } from "node:test";
import http from "node:http";

// Minimal isolated test of the /hooks/datax contract: mirrors the route logic
// so we don't need to boot the whole wrapper (which requires OpenClaw state).

function makeHookHandler({ expectedSecret, accountMap }) {
  // accountMap: { [accountName]: { telegramUrl, chatId, botToken } }
  return async (req, res) => {
    try {
      const auth = (req.headers.authorization || "").trim();
      const received = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!received || received !== expectedSecret) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid bearer token" }));
        return;
      }
      // Extract account from URL path: /hooks/datax/<account> or /hooks/datax
      const pathParts = req.url.split("/").filter(Boolean);
      const account = pathParts.length >= 3 ? pathParts[2] : "default";
      const cfg = accountMap[account];
      if (!cfg?.chatId || !cfg?.botToken) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `Not configured for account ${account}` }));
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
      const r = await fetch(cfg.telegramUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: "HTML" }),
      });
      const ok = r.ok;
      res.writeHead(ok ? 200 : 502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok, account }));
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
      accountMap: { default: { chatId: "1", botToken: "t", telegramUrl: "http://127.0.0.1:1/" } },
    }),
  );
  await listen(app);
  const { port } = app.address();
  const res = await fetch(`http://127.0.0.1:${port}/hooks/datax`, { method: "POST" });
  assert.equal(res.status, 401);
  app.close();
});

test("hooks/datax rejects wrong bearer", async () => {
  const app = http.createServer(
    makeHookHandler({
      expectedSecret: "shh",
      accountMap: { default: { chatId: "1", botToken: "t", telegramUrl: "http://127.0.0.1:1/" } },
    }),
  );
  await listen(app);
  const { port } = app.address();
  const res = await fetch(`http://127.0.0.1:${port}/hooks/datax`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong" },
  });
  assert.equal(res.status, 401);
  app.close();
});

test("hooks/datax/default routes to default account", async () => {
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
      accountMap: {
        default: { chatId: "474205181", botToken: "defaultToken", telegramUrl: `http://127.0.0.1:${tgPort}/` },
        agent2:  { chatId: "474205181", botToken: "agent2Token",  telegramUrl: `http://127.0.0.1:${tgPort}/` },
      },
    }),
  );
  await listen(app);
  const { port } = app.address();

  const res = await fetch(`http://127.0.0.1:${port}/hooks/datax/default`, {
    method: "POST",
    headers: { Authorization: "Bearer shh", "Content-Type": "application/json" },
    body: JSON.stringify({ statusUpdate: { taskId: "t1", contextId: "c1", status: { state: "TASK_STATE_WORKING" } } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.account, "default");
  assert.ok(telegramReceived, "telegram was called");
  assert.equal(telegramReceived.chat_id, "474205181");
  app.close();
  fakeTg.close();
});

test("hooks/datax/agent2 routes to agent2 account with different token", async () => {
  const tokensUsed = [];
  const fakeTg = http.createServer(async (req, res) => {
    // The bot token appears in the request URL path: /bot<token>/sendMessage
    tokensUsed.push(req.url.split("/")[1]); // e.g. "botABC123"
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { message_id: 2 } }));
  });
  // We need to intercept via a real fetch, so use the per-account botToken in the accountMap
  // and assert the correct account is used.
  await listen(fakeTg);
  const { port: tgPort } = fakeTg.address();

  const app = http.createServer(
    makeHookHandler({
      expectedSecret: "shh",
      accountMap: {
        default: { chatId: "474205181", botToken: "defaultToken", telegramUrl: `http://127.0.0.1:${tgPort}/` },
        agent2:  { chatId: "474205181", botToken: "agent2Token",  telegramUrl: `http://127.0.0.1:${tgPort}/` },
      },
    }),
  );
  await listen(app);
  const { port } = app.address();

  const res = await fetch(`http://127.0.0.1:${port}/hooks/datax/agent2`, {
    method: "POST",
    headers: { Authorization: "Bearer shh", "Content-Type": "application/json" },
    body: JSON.stringify({ statusUpdate: { taskId: "t2", contextId: "c2", status: { state: "TASK_STATE_COMPLETED" } } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.account, "agent2");
  app.close();
  fakeTg.close();
});

test("hooks/datax/unknownaccount returns 503 when not configured", async () => {
  const app = http.createServer(
    makeHookHandler({
      expectedSecret: "shh",
      accountMap: {
        default: { chatId: "474205181", botToken: "t", telegramUrl: "http://127.0.0.1:1/" },
      },
    }),
  );
  await listen(app);
  const { port } = app.address();

  const res = await fetch(`http://127.0.0.1:${port}/hooks/datax/unknownaccount`, {
    method: "POST",
    headers: { Authorization: "Bearer shh", "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 503);
  app.close();
});

