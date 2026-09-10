// Netlify Function (runtime v2) – backend přehledu scénářů Make.
// Bez přihlašování: kdo zná adresu webu, může scénáře znovu spouštět.
//
// Obsluhuje cesty /api/*:
//   GET  /api/overview                     tabulka sledovaných scénářů (aktivní, poslední běh, nedoběhlé, historie)
//   GET  /api/history?scenarioId=&limit=   historie běhů scénáře (výchozí 100 posledních)
//   GET  /api/execution?scenarioId=&executionId=   detail jednoho běhu (moduly, chyba)
//   POST /api/rerun      {scenarioId}      spustit scénář znovu (on-demand scénář se spustí, scénář s webhookem
//                                          přehraje poslední běh se stejnými daty)
//   POST /api/replay     {scenarioId, executionId}   přehrát konkrétní běh z historie
//   POST /api/retry      {dlqId}           spustit jeden nedoběhlý běh (pokračuje od modulu, kde spadl)
//   POST /api/retry-all  {scenarioId}      spustit všechny nedoběhlé běhy scénáře
//
// Konfigurace (proměnné prostředí v Netlify):
//   MAKE_API_TOKEN   – API token Make (alternativně MAKE_TOKEN nebo MAKE_API_KEY) – povinné
//   MAKE_ZONE        – zóna Make, výchozí eu2.make.com
//   MAKE_TEAM_ID     – ID týmu (pro odkazy do Make), výchozí 1179427
//   DAYS_BACK        – kolik dní historie chyb zobrazit, výchozí 3
//   MAKE_SCENARIOS   – volitelně JSON pole [{"id":123,"name":"…"}], které nahradí seznam v scenarios.mjs

import { SCENARIOS as DEFAULT_SCENARIOS } from "./scenarios.mjs";

export const config = { path: "/api/*" };

const STATUS_OK = 1;
const STATUS_WARNING = 2;
const STATUS_ERROR = 3;

export function getSettings(e = process.env) {
  const token = e.MAKE_API_TOKEN || e.MAKE_TOKEN || e.MAKE_API_KEY || "";
  const zone = e.MAKE_ZONE || "eu2.make.com";
  const teamId = Number(e.MAKE_TEAM_ID || 1179427);
  const daysBack = Number(e.DAYS_BACK || 3);
  let scenarios = DEFAULT_SCENARIOS;
  if (e.MAKE_SCENARIOS) {
    try {
      const parsed = JSON.parse(e.MAKE_SCENARIOS);
      if (Array.isArray(parsed) && parsed.length) scenarios = parsed;
    } catch (err) {
      console.warn("MAKE_SCENARIOS není platný JSON, používám výchozí seznam:", err.message);
    }
  }
  return { token, zone, teamId, daysBack, scenarios };
}

// ---------- Make API klient ----------

export function createMakeClient(settings, fetchImpl = globalThis.fetch) {
  const base = `https://${settings.zone}/api/v2`;
  const isApiKey = /^[0-9a-f-]{36}$/i.test(settings.token);
  const authorization = `${isApiKey ? "Token" : "Bearer"} ${settings.token}`;

  async function call(path, { method = "GET", body, query } = {}) {
    if (!settings.token) throw new Error("Chybí MAKE_API_TOKEN (proměnná prostředí v Netlify).");
    const url = new URL(base + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetchImpl(url.toString(), {
      method,
      headers: { authorization, "content-type": "application/json", "user-agent": "makechyby-netlify/3.0" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* ne-JSON odpověď */ }
    if (!res.ok) {
      const detail = (json && (json.message || json.detail || json.error)) || text || `HTTP ${res.status}`;
      const err = new Error(`Make API ${method} ${path}: ${detail}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  return {
    getScenario: (scenarioId) => call(`/scenarios/${scenarioId}`).then((r) => r.scenario),
    listExecutions: (scenarioId, limit = 100) =>
      call(`/scenarios/${scenarioId}/logs`, {
        query: { "pg[limit]": limit, "pg[sortDir]": "desc", "pg[sortBy]": "timestamp" },
      }).then((r) => r.scenarioLogs || []),
    listIncomplete: (scenarioId) =>
      call(`/dlqs`, { query: { scenarioId, "pg[limit]": 100 } }).then((r) => r.dlqs || []),
    retryIncomplete: (dlqId) => call(`/dlqs/${encodeURIComponent(dlqId)}/retry`, { method: "POST" }),
    retryAllIncomplete: (scenarioId) =>
      call(`/dlqs/retry`, { method: "POST", query: { scenarioId }, body: { all: true } }),
    replayExecution: (scenarioId, executionId) =>
      call(`/scenarios/${scenarioId}/replay`, { method: "POST", body: { executionIds: [executionId] } }),
    runScenario: (scenarioId) =>
      call(`/scenarios/${scenarioId}/run`, { method: "POST", body: { data: {}, responsive: false } }),
    getExecutionDetail: (scenarioId, executionId) =>
      call(`/scenarios/${scenarioId}/executions/${encodeURIComponent(executionId)}`, { query: { maxBytes: 200000 } }),
  };
}

// ---------- Sestavení přehledu ----------

function makeUrls(settings, scenarioId) {
  const root = `https://${settings.zone}/${settings.teamId}/scenarios/${scenarioId}`;
  return {
    history: `${root}/logs`,
    edit: `${root}/edit`,
    execution: (executionId) => `${root}/logs/${executionId}`,
  };
}

function isExecution(log) {
  // Historie obsahuje i události typu start/stop/modify/warning bez stavu běhu.
  return log && typeof log.status === "number" && typeof log.id === "string" && log.id.length >= 16;
}

export function mapExecution(ex, urls) {
  return {
    executionId: ex.id,
    timestamp: ex.timestamp,
    status: ex.status,
    duration: ex.duration ?? null,
    operations: ex.operations ?? null,
    type: ex.type || "",
    replayOf: ex.replayOfExecutionId || null,
    errorModule: ex.error?.name || "",
    errorMessage: ex.error?.message || "",
    isReplayable: ex.isReplayable === true,
    detailUrl: urls.execution(ex.id),
  };
}

const HISTORY_IN_OVERVIEW = 20;

/** Souhrnný stav řádku: ok | warn | error + krátký text. */
export function evaluateHealth({ scenario, executions, pending, daysBack, now = Date.now() }) {
  const reasons = [];
  let level = "ok";
  const bump = (l) => { if (l === "error" || (l === "warn" && level === "ok")) level = l; };

  if (scenario) {
    if (scenario.isActive === false) { bump("error"); reasons.push("scénář je vypnutý"); }
    if (scenario.isPaused) { bump("error"); reasons.push("scénář je pozastavený"); }
    if (scenario.isinvalid) { bump("error"); reasons.push("scénář je označen jako neplatný"); }
  }

  const last = executions[0];
  if (!last) {
    bump("warn");
    reasons.push("v historii není žádný běh");
  } else {
    if (last.status === STATUS_ERROR) {
      bump("error");
      reasons.push("poslední běh skončil chybou" + (last.error?.message ? `: ${last.error.message}` : ""));
    } else if (last.status === STATUS_WARNING) {
      bump("warn");
      reasons.push("poslední běh skončil s varováním");
    }
    if (now - new Date(last.timestamp).getTime() > daysBack * 86400000) {
      bump("warn");
      reasons.push(`poslední běh je starší než ${daysBack} dny`);
    }
  }

  if (pending.length) {
    bump("warn");
    reasons.push(`${pending.length}× nedoběhlý běh čeká na spuštění`);
  }

  return { level, text: reasons.length ? reasons.join("; ") : "v pořádku" };
}

export async function buildOverview(client, settings, now = Date.now()) {
  const since = now - settings.daysBack * 86400000;

  const scenarios = await Promise.all(
    settings.scenarios.map(async (sc) => {
      const urls = makeUrls(settings, sc.id);
      const [scenarioRes, logsRes, dlqRes] = await Promise.allSettled([
        client.getScenario(sc.id),
        client.listExecutions(sc.id),
        client.listIncomplete(sc.id),
      ]);

      const problems = [];
      const scenario = scenarioRes.status === "fulfilled" ? scenarioRes.value : (problems.push(scenarioRes.reason.message), null);
      const logs = logsRes.status === "fulfilled" ? logsRes.value : (problems.push(logsRes.reason.message), []);
      const dlqs = dlqRes.status === "fulfilled" ? dlqRes.value : (problems.push(dlqRes.reason.message), []);

      const executions = logs.filter(isExecution).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      const inPeriod = executions.filter((ex) => new Date(ex.timestamp).getTime() >= since);

      const pending = dlqs
        .filter((d) => !d.resolved && !d.deleted)
        .map((d) => ({
          dlqId: d.id,
          created: d.created,
          reason: d.reason || "",
          attempts: d.attempts ?? 0,
          executionId: d.executionId || null,
        }));

      const health = evaluateHealth({ scenario, executions, pending, daysBack: settings.daysBack, now });
      if (problems.length) {
        if (health.level === "ok") health.level = "warn";
        health.text += `; nepodařilo se načíst: ${problems.join(" | ")}`;
      }

      const schedulingType = scenario?.scheduling?.type || null;
      const last = executions[0] || null;
      const lastReplayable = executions.find((ex) => ex.isReplayable === true) || null;

      // Jak lze scénář znovu spustit: on-demand přes "run", ostatní přehráním posledního běhu.
      let rerun = { mode: "none", label: "nelze spustit odsud" };
      if (schedulingType === "on-demand") {
        rerun = { mode: "run", label: "Spustit scénář" };
      } else if (lastReplayable) {
        rerun = { mode: "replay", label: "Spustit znovu poslední běh", executionId: lastReplayable.id, timestamp: lastReplayable.timestamp };
      }

      return {
        scenarioId: sc.id,
        name: sc.name || scenario?.name || `Scénář ${sc.id}`,
        makeName: scenario?.name || null,
        folder: scenario?.folderPath || null,
        isActive: scenario ? scenario.isActive !== false && !scenario.isPaused : null,
        scheduling: schedulingType,
        makeHistoryUrl: urls.history,
        makeEditUrl: urls.edit,
        health,
        lastRun: last ? mapExecution(last, urls) : null,
        runsInPeriod: inPeriod.length,
        okInPeriod: inPeriod.filter((ex) => ex.status === STATUS_OK).length,
        rerun,
        pending,
        errors: inPeriod.filter((ex) => ex.status !== STATUS_OK).map((ex) => mapExecution(ex, urls)),
        history: executions.slice(0, HISTORY_IN_OVERVIEW).map((ex) => mapExecution(ex, urls)),
        historyTotal: executions.length,
      };
    })
  );

  return { generatedAt: new Date(now).toISOString(), daysBack: settings.daysBack, scenarios };
}

// ---------- HTTP obsluha ----------

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}

export async function handle(req, { settings = getSettings(), client = createMakeClient(settings) } = {}) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const method = req.method.toUpperCase();

  try {
    if (method === "GET" && (route === "overview" || route === "errors")) {
      return json(200, await buildOverview(client, settings));
    }

    if (method === "GET" && route === "history") {
      const scenarioId = Number(url.searchParams.get("scenarioId"));
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
      if (!scenarioId) return json(400, { error: "Chybí scenarioId." });
      const urls = makeUrls(settings, scenarioId);
      const executions = (await client.listExecutions(scenarioId, limit)).filter(isExecution)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .map((ex) => mapExecution(ex, urls));
      return json(200, { scenarioId, executions });
    }

    if (method === "GET" && route === "execution") {
      const scenarioId = Number(url.searchParams.get("scenarioId"));
      const executionId = url.searchParams.get("executionId") || "";
      if (!scenarioId || !/^[0-9a-f]{32}$/i.test(executionId)) return json(400, { error: "Chybí scenarioId nebo executionId." });
      const detail = await client.getExecutionDetail(scenarioId, executionId);
      return json(200, { scenarioId, executionId, detail });
    }

    if (method === "POST" && route === "rerun") {
      const { scenarioId } = await readJson(req);
      if (!scenarioId) return json(400, { error: "Chybí scenarioId." });
      const id = Number(scenarioId);
      const scenario = await client.getScenario(id);
      if (scenario?.scheduling?.type === "on-demand") {
        const r = await client.runScenario(id);
        return json(200, { ok: true, mode: "run", executionId: r?.executionId || null });
      }
      const executions = (await client.listExecutions(id)).filter(isExecution)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      const replayable = executions.find((ex) => ex.isReplayable === true);
      if (!replayable) return json(409, { error: "Scénář nemá žádný běh, který by šel přehrát. Spusťte ho ručně v Make." });
      const r = await client.replayExecution(id, replayable.id);
      return json(200, { ok: true, mode: "replay", replayedExecutionId: replayable.id, executionId: r?.executionId || null });
    }

    if (method === "POST" && route === "replay") {
      const { scenarioId, executionId } = await readJson(req);
      if (!scenarioId || !executionId) return json(400, { error: "Chybí scenarioId nebo executionId." });
      const r = await client.replayExecution(Number(scenarioId), String(executionId));
      return json(200, { ok: true, executionId: r?.executionId || null });
    }

    if (method === "POST" && route === "retry") {
      const { dlqId } = await readJson(req);
      if (!dlqId) return json(400, { error: "Chybí dlqId." });
      await client.retryIncomplete(dlqId);
      return json(200, { ok: true });
    }

    if (method === "POST" && route === "retry-all") {
      const { scenarioId } = await readJson(req);
      if (!scenarioId) return json(400, { error: "Chybí scenarioId." });
      await client.retryAllIncomplete(Number(scenarioId));
      return json(200, { ok: true });
    }

    return json(404, { error: `Neznámá cesta: ${method} /api/${route}` });
  } catch (err) {
    console.error(err);
    return json(err.status && err.status >= 400 && err.status < 600 ? 502 : 500, { error: err.message || String(err) });
  }
}

export default async function (req) {
  return handle(req);
}
