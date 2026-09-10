import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOverview, createMakeClient, evaluateHealth, getSettings, handle } from "../netlify/functions/api.mjs";

const NOW = Date.parse("2026-09-10T10:00:00Z");
const HOUR = 3600000;
const iso = (offsetHours) => new Date(NOW - offsetHours * HOUR).toISOString();

const settings = {
  token: "00000000-0000-4000-8000-000000000000",
  zone: "eu2.make.com",
  teamId: 1179427,
  daysBack: 3,
  scenarios: [
    { id: 7734429, name: "B1 adresy" },
    { id: 7734406, name: "A. MEDISTAR" },
  ],
};

// Falešný Make server: zaznamenává požadavky a vrací data podle cesty.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    calls.push({ method: opts.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: opts.body, headers: opts.headers });
    const key = `${opts.method} ${u.pathname}`;
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    const out = typeof handler === "function" ? handler(u, opts) : handler;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

const routes = {
  "GET /api/v2/scenarios/7734429": { scenario: { id: 7734429, name: "B1. Načtení ADRES", isActive: true, isPaused: false, scheduling: { type: "immediately" } } },
  "GET /api/v2/scenarios/7734406": { scenario: { id: 7734406, name: "A.MEDISTAR", isActive: false, isPaused: false, scheduling: { type: "immediately" } } },
  "GET /api/v2/scenarios/7734429/logs": {
    scenarioLogs: [
      { id: "78007656", type: "start", timestamp: iso(1), authorName: "X" },
      { id: "eec344e5d1cd40c3893ae240e9a4fe97", status: 1, timestamp: iso(2), isReplayable: true },
      { id: "90dde4e0f70f4398b34e18a97b3b89bc", status: 3, timestamp: iso(20), isReplayable: true, error: { name: "InconsistencyError", message: "Transaction has been aborted." } },
      { id: "019cb35dcbd940c3be326f18453f1152", status: 3, timestamp: iso(24 * 10), isReplayable: false, error: { name: "Old", message: "stará chyba" } },
    ],
  },
  "GET /api/v2/scenarios/7734406/logs": {
    scenarioLogs: [
      { id: "f8e9f751b53248af97b88020d4791377", status: 3, timestamp: iso(5), isReplayable: true, error: { name: "RuntimeError", message: "SQL timeout" } },
      { id: "ff2c533eab0d49ee9aeb089a80f5533b", status: 1, timestamp: iso(30), isReplayable: true },
    ],
  },
  "GET /api/v2/dlqs": (u) =>
    u.searchParams.get("scenarioId") === "7734406"
      ? { dlqs: [{ id: "dlq-1", reason: "Timeout", created: iso(4), attempts: 1, resolved: false }, { id: "dlq-old", reason: "x", created: iso(50), attempts: 3, resolved: true }] }
      : { dlqs: [] },
  "POST /api/v2/dlqs/dlq-1/retry": { dlq: {} },
  "POST /api/v2/dlqs/retry": {},
  "POST /api/v2/scenarios/7734406/replay": { executionId: "new-exec-id" },
  "POST /api/v2/scenarios/7734429/replay": { executionId: "replay-b1" },
  "GET /api/v2/scenarios/5535556": { scenario: { id: 5535556, name: "PM103 statistiky", isActive: true, scheduling: { type: "on-demand" } } },
  "GET /api/v2/scenarios/5535556/logs": { scenarioLogs: [] },
  "POST /api/v2/scenarios/5535556/run": { executionId: "run-1" },
  "GET /api/v2/scenarios/7734429/executions/90dde4e0f70f4398b34e18a97b3b89bc": { status: "ERROR", error: { name: "InconsistencyError", message: "Transaction has been aborted." } },
};

test("getSettings používá výchozí seznam scénářů a umí ho přepsat z prostředí", () => {
  const def = getSettings({ MAKE_API_TOKEN: "t" });
  assert.equal(def.zone, "eu2.make.com");
  assert.equal(def.daysBack, 3);
  const ids = def.scenarios.map((s) => s.id);
  assert.ok(ids.includes(7734429), "obsahuje B1 Načtení ADRES");
  assert.ok(ids.includes(7734406), "obsahuje A.MEDISTAR PacientiVykony");
  assert.ok(ids.includes(5082766) && ids.includes(6231864), "obsahuje DIKTOVANI a PM103");

  const custom = getSettings({ MAKE_TOKEN: "t", MAKE_SCENARIOS: '[{"id":1,"name":"x"}]', DAYS_BACK: "7" });
  assert.deepEqual(custom.scenarios, [{ id: 1, name: "x" }]);
  assert.equal(custom.daysBack, 7);
  assert.equal(custom.token, "t");

  const broken = getSettings({ MAKE_API_KEY: "t", MAKE_SCENARIOS: "{not json" });
  assert.equal(broken.scenarios.length, def.scenarios.length);
});

test("buildOverview sestaví stav, DLQ a chyby pro každý scénář", async () => {
  const { fetchImpl, calls } = fakeFetch(routes);
  const client = createMakeClient(settings, fetchImpl);
  const data = await buildOverview(client, settings, NOW);

  assert.equal(data.daysBack, 3);
  assert.equal(data.scenarios.length, 2);

  const b1 = data.scenarios[0];
  assert.equal(b1.scenarioId, 7734429);
  assert.equal(b1.name, "B1 adresy");
  assert.equal(b1.makeName, "B1. Načtení ADRES");
  assert.equal(b1.isActive, true);
  assert.equal(b1.makeHistoryUrl, "https://eu2.make.com/1179427/scenarios/7734429/logs");
  assert.equal(b1.lastRun.executionId, "eec344e5d1cd40c3893ae240e9a4fe97", "událost typu start se nepočítá jako běh");
  assert.equal(b1.health.level, "ok");
  assert.equal(b1.errors.length, 1, "stará chyba mimo období se nezobrazí");
  assert.equal(b1.errors[0].errorModule, "InconsistencyError");
  assert.equal(b1.errors[0].isReplayable, true);
  assert.equal(b1.errors[0].detailUrl, "https://eu2.make.com/1179427/scenarios/7734429/logs/90dde4e0f70f4398b34e18a97b3b89bc");
  assert.equal(b1.runsInPeriod, 2);
  assert.deepEqual(b1.pending, []);

  const med = data.scenarios[1];
  assert.equal(med.isActive, false);
  assert.equal(med.health.level, "error");
  assert.match(med.health.text, /vypnutý/);
  assert.match(med.health.text, /poslední běh skončil chybou: SQL timeout/);
  assert.match(med.health.text, /1× nedoběhlý běh/);
  assert.equal(med.pending.length, 1, "vyřešené DLQ položky se nezobrazují");
  assert.equal(med.pending[0].dlqId, "dlq-1");
  assert.equal(med.lastRun.status, 3);

  // Autorizační hlavička – UUID token se posílá jako "Token".
  assert.ok(calls.every((c) => c.headers.authorization === `Token ${settings.token}`));
  const logsCall = calls.find((c) => c.path.endsWith("/7734429/logs"));
  assert.equal(logsCall.query["pg[sortDir]"], "desc");
});

test("buildOverview přežije výpadek jednoho volání Make", async () => {
  const { fetchImpl } = fakeFetch({ ...routes, "GET /api/v2/scenarios/7734429/logs": new Response("boom", { status: 500 }) });
  const client = createMakeClient(settings, fetchImpl);
  const data = await buildOverview(client, settings, NOW);
  const b1 = data.scenarios[0];
  assert.equal(b1.lastRun, null);
  assert.notEqual(b1.health.level, "ok");
  assert.match(b1.health.text, /nepodařilo se načíst/);
  assert.equal(data.scenarios[1].errors.length, 1, "druhý scénář se načte normálně");
});

test("evaluateHealth: bez běhu v období je varování, chyba posledního běhu je error", () => {
  const stale = evaluateHealth({ scenario: { isActive: true }, executions: [{ status: 1, timestamp: iso(24 * 5) }], pending: [], daysBack: 3, now: NOW });
  assert.equal(stale.level, "warn");
  const failed = evaluateHealth({ scenario: { isActive: true }, executions: [{ status: 3, timestamp: iso(1), error: { message: "x" } }], pending: [], daysBack: 3, now: NOW });
  assert.equal(failed.level, "error");
  const none = evaluateHealth({ scenario: null, executions: [], pending: [], daysBack: 3, now: NOW });
  assert.equal(none.level, "warn");
});

test("HTTP: retry, retry-all a replay volají správné endpointy Make", async () => {
  const { fetchImpl, calls } = fakeFetch(routes);
  const client = createMakeClient(settings, fetchImpl);
  const opts = { settings, client };
  const post = (route, body) => handle(new Request(`https://x.netlify.app/api/${route}`, { method: "POST", body: JSON.stringify(body) }), opts);

  let res = await post("retry", { dlqId: "dlq-1" });
  assert.equal(res.status, 200);
  assert.equal(calls.at(-1).path, "/api/v2/dlqs/dlq-1/retry");

  res = await post("retry-all", { scenarioId: 7734406 });
  assert.equal(res.status, 200);
  assert.equal(calls.at(-1).path, "/api/v2/dlqs/retry");
  assert.equal(calls.at(-1).query.scenarioId, "7734406");
  assert.deepEqual(JSON.parse(calls.at(-1).body), { all: true });

  res = await post("replay", { scenarioId: 7734406, executionId: "f8e9f751b53248af97b88020d4791377" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, executionId: "new-exec-id" });
  assert.equal(calls.at(-1).path, "/api/v2/scenarios/7734406/replay");
  assert.deepEqual(JSON.parse(calls.at(-1).body), { executionIds: ["f8e9f751b53248af97b88020d4791377"] });

  res = await post("replay", { scenarioId: 7734406 });
  assert.equal(res.status, 400);

  res = await handle(new Request("https://x.netlify.app/api/neznama"), opts);
  assert.equal(res.status, 404);

  res = await handle(new Request("https://x.netlify.app/api/overview"), opts);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.scenarios.length, 2);
  assert.equal(body.scenarios[0].rerun.mode, "replay", "webhook scénář se spouští přehráním");
  assert.equal(body.scenarios[0].rerun.executionId, "eec344e5d1cd40c3893ae240e9a4fe97", "přehrává se nejnovější přehratelný běh");
  assert.equal(body.scenarios[0].okInPeriod, 1);
});

test("HTTP: rerun přehraje poslední běh u webhook scénáře a spustí on-demand scénář", async () => {
  const { fetchImpl, calls } = fakeFetch(routes);
  const client = createMakeClient(settings, fetchImpl);
  const opts = { settings, client };
  const post = (body) => handle(new Request("https://x.netlify.app/api/rerun", { method: "POST", body: JSON.stringify(body) }), opts);

  let res = await post({ scenarioId: 7734429 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, mode: "replay", replayedExecutionId: "eec344e5d1cd40c3893ae240e9a4fe97", executionId: "replay-b1" });
  assert.equal(calls.at(-1).path, "/api/v2/scenarios/7734429/replay");

  res = await post({ scenarioId: 5535556 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, mode: "run", executionId: "run-1" });
  assert.equal(calls.at(-1).path, "/api/v2/scenarios/5535556/run");
  assert.deepEqual(JSON.parse(calls.at(-1).body), { data: {}, responsive: false });

  res = await post({});
  assert.equal(res.status, 400);
});

test("HTTP: rerun bez přehratelného běhu vrátí 409", async () => {
  const { fetchImpl } = fakeFetch({ ...routes, "GET /api/v2/scenarios/7734429/logs": { scenarioLogs: [{ id: "x".repeat(32), status: 1, timestamp: iso(1), isReplayable: false }] } });
  const client = createMakeClient(settings, fetchImpl);
  const res = await handle(new Request("https://x.netlify.app/api/rerun", { method: "POST", body: JSON.stringify({ scenarioId: 7734429 }) }), { settings, client });
  assert.equal(res.status, 409);
});

test("HTTP: chyba Make se vrátí jako 502 s textem", async () => {
  const { fetchImpl } = fakeFetch({ ...routes, "POST /api/v2/dlqs/dlq-1/retry": new Response(JSON.stringify({ message: "DLQ not found" }), { status: 404 }) });
  const client = createMakeClient(settings, fetchImpl);
  const res = await handle(new Request("https://x.netlify.app/api/retry", { method: "POST", body: JSON.stringify({ dlqId: "dlq-1" }) }), { settings, client });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /DLQ not found/);
});

test("HTTP: bez tokenu vrací srozumitelnou chybu", async () => {
  const client = createMakeClient({ ...settings, token: "" }, async () => { throw new Error("nesmí se volat"); });
  const res = await handle(new Request("https://x.netlify.app/api/overview"), { settings: { ...settings, token: "" }, client });
  assert.equal(res.status, 200, "přehled se vrátí, chyba je u každého scénáře");
  const body = await res.json();
  assert.match(body.scenarios[0].health.text, /MAKE_API_TOKEN/);
});


test("overview obsahuje historii běhů; /api/history a /api/execution vrací data", async () => {
  const { fetchImpl, calls } = fakeFetch(routes);
  const client = createMakeClient(settings, fetchImpl);
  const opts = { settings, client };

  const data = await buildOverview(client, settings, NOW);
  const b1 = data.scenarios[0];
  assert.equal(b1.history.length, 3, "historie obsahuje všechny běhy (i OK), ne události start/modify");
  assert.equal(b1.history[0].status, 1);
  assert.equal(b1.historyTotal, 3);

  let res = await handle(new Request("https://x.netlify.app/api/history?scenarioId=7734429&limit=50"), opts);
  assert.equal(res.status, 200);
  const h = await res.json();
  assert.equal(h.executions.length, 3);
  assert.equal(calls.at(-1).query["pg[limit]"], "50");

  res = await handle(new Request("https://x.netlify.app/api/history"), opts);
  assert.equal(res.status, 400);

  res = await handle(new Request("https://x.netlify.app/api/execution?scenarioId=7734429&executionId=90dde4e0f70f4398b34e18a97b3b89bc"), opts);
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.detail.status, "ERROR");
  assert.equal(calls.at(-1).path, "/api/v2/scenarios/7734429/executions/90dde4e0f70f4398b34e18a97b3b89bc");

  res = await handle(new Request("https://x.netlify.app/api/execution?scenarioId=7734429&executionId=../x"), opts);
  assert.equal(res.status, 400);
});
