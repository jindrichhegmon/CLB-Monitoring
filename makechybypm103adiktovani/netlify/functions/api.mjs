// Netlify Function (runtime v2) – backend pro přehled chybových běhů scénářů Make.
//
// Obsluhuje cesty /api/*:
//   GET  /api/errors                       přehled sledovaných scénářů (stav, DLQ, chybové běhy)
//   POST /api/retry      {dlqId}           opakovat jeden neúplný běh (DLQ) od modulu, kde spadl
//   POST /api/retry-all  {scenarioId}      opakovat všechny neúplné běhy scénáře
//   POST /api/replay     {scenarioId, executionId}
//                                          znovu spustit běh z historie se stejnými vstupními daty
//
// Konfigurace (proměnné prostředí v Netlify):
//   MAKE_API_TOKEN   – API token Make (alternativně MAKE_TOKEN nebo MAKE_API_KEY)
//   MAKE_ZONE        – zóna Make, výchozí eu2.make.com
//   MAKE_TEAM_ID     – ID týmu (jen pro odkazy do Make), výchozí 1179427
//   DAYS_BACK        – kolik dní historie zobrazit, výchozí 3
//   MAKE_SCENARIOS   – volitelně JSON pole [{"id":123,"name":"…"}], které nahradí výchozí seznam níže
//   APP_PASSWORD     – je-li nastaveno, API vyžaduje HTTP Basic Auth (libovolné jméno, toto heslo);
//                      prohlížeč se na heslo zeptá sám

import { timingSafeEqual } from "node:crypto";
import { SCENARIOS as DEFAULT_SCENARIOS } from "./scenarios.mjs";

export const config = { path: "/api/*" };

const STATUS_OK = 1;
const STATUS_WARNING = 2;
const STATUS_ERROR = 3;

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

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
  const appPassword = e.APP_PASSWORD || "";
  return { token, zone, teamId, daysBack, scenarios, appPassword };
}

/** Ověří HTTP Basic Auth proti APP_PASSWORD. Bez nastaveného hesla je přístup volný. */
export function isAuthorized(req, settings) {
  if (!settings.appPassword) return true;
  const header = req.headers.get("authorization") || "";
  const m = /^Basic\s+(.+)$/i.exec(header);
  if (!m) return false;
  let decoded = "";
  try { decoded = Buffer.from(m[1], "base64").toString("utf8"); } catch { return false; }
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : decoded;
  return timingSafeEqualStr(password, settings.appPassword);
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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
      headers: {
        authorization,
        "content-type": "application/json",
        "user-agent": "makechyby-netlify/2.0",
      },
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
    // Metadata scénáře (isActive, isPaused, název, plánování)
    getScenario: (scenarioId) => call(`/scenarios/${scenarioId}`).then((r) => r.scenario),
    // Historie běhů, nejnovější první
    listExecutions: (scenarioId, limit = 100) =>
      call(`/scenarios/${scenarioId}/logs`, {
        query: { "pg[limit]": limit, "pg[sortDir]": "desc", "pg[sortBy]": "timestamp" },
      }).then((r) => r.scenarioLogs || []),
    // Neúplné běhy (DLQ)
    listIncomplete: (scenarioId) =>
      call(`/dlqs`, { query: { scenarioId, "pg[limit]": 100 } }).then((r) => r.dlqs || []),
    retryIncomplete: (dlqId) => call(`/dlqs/${encodeURIComponent(dlqId)}/retry`, { method: "POST" }),
    retryAllIncomplete: (scenarioId) =>
      call(`/dlqs/retry`, { method: "POST", query: { scenarioId }, body: { all: true } }),
    // Přehrání běhu z historie se stejnými vstupními daty
    replayExecution: (scenarioId, executionId) =>
      call(`/scenarios/${scenarioId}/replay`, { method: "POST", body: { executionIds: [executionId] } }),
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

/**
 * Vyhodnotí, zda scénář "jede": je zapnutý, poslední běh dopadl dobře a nic nečeká v DLQ.
 * Vrací { level: "ok" | "warn" | "error", text }.
 */
export function evaluateHealth({ scenario, executions, pending, daysBack, now = Date.now() }) {
  const reasons = [];
  let level = "ok";
  const bump = (l) => { if (l === "error" || (l === "warn" && level === "ok")) level = l; };

  if (scenario) {
    if (scenario.isActive === false) { bump("error"); reasons.push("scénář je vypnutý (neaktivní)"); }
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
    const ageMs = now - new Date(last.timestamp).getTime();
    if (ageMs > daysBack * 86400000) {
      bump("warn");
      reasons.push(`poslední běh je starší než ${daysBack} dny (${new Date(last.timestamp).toISOString().slice(0, 10)})`);
    }
  }

  if (pending.length) {
    bump("warn");
    reasons.push(`${pending.length}× neúplný běh čeká na opakování`);
  }

  return {
    level,
    text: reasons.length ? reasons.join("; ") : "scénář je zapnutý a poslední běh proběhl v pořádku",
  };
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

      const executions = logs
        .filter(isExecution)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      const pending = dlqs
        .filter((d) => !d.resolved && !d.deleted)
        .map((d) => ({
          dlqId: d.id,
          created: d.created,
          reason: d.reason || "",
          attempts: d.attempts ?? 0,
          executionId: d.executionId || null,
        }));

      const errors = executions
        .filter((ex) => ex.status !== STATUS_OK && new Date(ex.timestamp).getTime() >= since)
        .map((ex) => ({
          executionId: ex.id,
          timestamp: ex.timestamp,
          status: ex.status,
          errorModule: ex.error?.name || "",
          errorMessage: ex.error?.message || "",
          isReplayable: ex.isReplayable === true,
          detailUrl: urls.execution(ex.id),
        }));

      const last = executions[0] || null;
      const health = evaluateHealth({ scenario, executions, pending, daysBack: settings.daysBack, now });
      if (problems.length) {
        health.level = health.level === "ok" ? "warn" : health.level;
        health.text += `; nepodařilo se načíst: ${problems.join(" | ")}`;
      }

      return {
        scenarioId: sc.id,
        name: sc.name || scenario?.name || `Scénář ${sc.id}`,
        makeName: scenario?.name || null,
        isActive: scenario ? scenario.isActive !== false && !scenario.isPaused : null,
        scheduling: scenario?.scheduling?.type || null,
        makeHistoryUrl: urls.history,
        makeEditUrl: urls.edit,
        health,
        lastRun: last
          ? {
              executionId: last.id,
              timestamp: last.timestamp,
              status: last.status,
              isReplayable: last.isReplayable === true,
              errorMessage: last.error?.message || "",
              detailUrl: urls.execution(last.id),
            }
          : null,
        runsInPeriod: executions.filter((ex) => new Date(ex.timestamp).getTime() >= since).length,
        pending,
        errors,
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

  if (!isAuthorized(req, settings)) {
    return new Response(JSON.stringify({ error: "Vyžadováno heslo aplikace." }), {
      status: 401,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "www-authenticate": 'Basic realm="Chybove behy Make", charset="UTF-8"',
        "cache-control": "no-store",
      },
    });
  }

  try {
    if (method === "GET" && route === "errors") {
      return json(200, await buildOverview(client, settings));
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

    if (method === "POST" && route === "replay") {
      const { scenarioId, executionId } = await readJson(req);
      if (!scenarioId || !executionId) return json(400, { error: "Chybí scenarioId nebo executionId." });
      const result = await client.replayExecution(Number(scenarioId), String(executionId));
      return json(200, { ok: true, executionId: result?.executionId || null });
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
