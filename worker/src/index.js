const jsonHeaders = {"content-type": "application/json; charset=utf-8"};

function cors(request, env) {
  const requested = request.headers.get("Origin");
  const configured = env.ALLOWED_ORIGIN || "*";
  const origin = configured === "*" ? "*" : (requested === configured ? configured : configured);
  return {"access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "Content-Type, Authorization", "access-control-max-age": "86400", "vary": "Origin"};
}

function response(body, status, request, env, headers = {}) {
  return new Response(body, {status, headers: {...cors(request, env), ...headers}});
}

function json(body, status, request, env) {
  return response(JSON.stringify(body), status, request, env, jsonHeaders);
}

function authValue(request) {
  const raw = request.headers.get("Authorization") || "";
  return raw.replace(/^Bearer\s+/i, "").trim();
}

function validSessionMeta(session) {
  return session && typeof session === "object" && typeof session.session_id === "string" && session.session_id.length > 0 && session.session_id.length <= 180 && typeof session.student === "string" && session.student.length <= 80;
}

function validItem(item) {
  return item && typeof item === "object" && typeof item.item_id === "string" && item.item_id.length > 0 && item.item_id.length <= 220;
}

function validProfile(profile, student) {
  return profile && typeof profile === "object" && profile.student === student && profile.student.length <= 80 && profile.units && typeof profile.units === "object" && profile.items && typeof profile.items === "object" && Array.isArray(profile.weak_ranking) && Array.isArray(profile.requests);
}

async function readJsonLimited(request, maxBytes) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length && length > maxBytes) throw new Error("payload too large");
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new Error("payload too large");
  return JSON.parse(new TextDecoder().decode(buffer));
}

async function appendSessionIndex(env, student, sessionId) {
  const key = `index:${student}`;
  const current = (await env.LOGS.get(key, "json")) || [];
  const next = [sessionId, ...current.filter(id => id !== sessionId)].slice(0, 200);
  await env.LOGS.put(key, JSON.stringify(next));
}

async function postLog(request, env) {
  if (!env.PASS_HASH || authValue(request) !== env.PASS_HASH) return json({error: "unauthorized"}, 401, request, env);
  let body;
  try { body = await readJsonLimited(request, 5 * 1024 * 1024); } catch (error) { return json({error: error.message === "payload too large" ? "payload too large" : "invalid json"}, error.message === "payload too large" ? 413 : 400, request, env); }
  if (!validSessionMeta(body.session) || !Array.isArray(body.items) || body.items.length > 500 || (body.profile != null && !validProfile(body.profile, body.session?.student))) return json({error: "invalid body"}, 400, request, env);
  if (body.items.some(item => !validItem(item))) return json({error: "invalid item"}, 400, request, env);
  const {session} = body;
  const previous = (await env.LOGS.get(`session:${session.session_id}`, "json")) || {};
  const itemIds = [...new Set([...(previous.item_ids || []), ...body.items.map(item => item.item_id)])];
  const meta = {session_id: session.session_id, student: session.student, started_at: session.started_at || previous.started_at || null, user_agent: session.user_agent || previous.user_agent || null, session_report: session.session_report || previous.session_report || null, study_sessions: Array.isArray(session.study_sessions) ? session.study_sessions : (previous.study_sessions || []), item_ids: itemIds, updated_at: new Date().toISOString()};
  await env.LOGS.put(`session:${session.session_id}`, JSON.stringify(meta));
  await Promise.all(body.items.map(item => env.LOGS.put(`item:${session.session_id}:${item.item_id}`, JSON.stringify(item))));
  if (body.profile != null) await env.LOGS.put(`profile:${session.student}`, JSON.stringify(body.profile));
  await appendSessionIndex(env, session.student, session.session_id);
  return json({ok: true, saved: body.items.length}, 200, request, env);
}

async function teacherAuth(request, env, url) {
  return url.searchParams.get("key") && env.TEACHER_HASH && url.searchParams.get("key") === env.TEACHER_HASH;
}

async function listSessions(request, env, url) {
  if (!(await teacherAuth(request, env, url))) return json({error: "unauthorized"}, 401, request, env);
  const list = [];
  const students = await env.LOGS.list({prefix: "index:"});
  for (const key of students.keys) {
    const student = key.name.slice("index:".length);
    const ids = (await env.LOGS.get(key.name, "json")) || [];
    for (const id of ids) {
      const meta = await env.LOGS.get(`session:${id}`, "json");
      if (meta) list.push({...meta, student: meta.student || student});
    }
  }
  list.sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));
  return json({sessions: list}, 200, request, env);
}

async function getSession(request, env, url, sessionId) {
  if (!(await teacherAuth(request, env, url))) return json({error: "unauthorized"}, 401, request, env);
  if (!sessionId || sessionId.length > 180) return json({error: "not found"}, 404, request, env);
  const meta = await env.LOGS.get(`session:${sessionId}`, "json");
  if (!meta) return json({error: "not found"}, 404, request, env);
  const items = [];
  for (const itemId of (meta.item_ids || [])) {
    const item = await env.LOGS.get(`item:${sessionId}:${itemId}`, "json");
    if (item) items.push(item);
  }
  return json({...meta, items}, 200, request, env);
}

async function getProfile(request, env, url, student) {
  if (!(await teacherAuth(request, env, url))) return json({error: "unauthorized"}, 401, request, env);
  if (!student || student.length > 80) return json({error: "not found"}, 404, request, env);
  const profile = await env.LOGS.get(`profile:${student}`, "json");
  if (!profile) return json({error: "not found"}, 404, request, env);
  return json(profile, 200, request, env);
}

async function getExport(request, env, url, student) {
  if (!(await teacherAuth(request, env, url))) return json({error: "unauthorized"}, 401, request, env);
  if (!student || student.length > 80) return json({error: "not found"}, 404, request, env);
  const profile = await env.LOGS.get(`profile:${student}`, "json");
  const ids = (await env.LOGS.get(`index:${student}`, "json")) || [];
  const sessions = [];
  for (const id of ids) {
    const meta = await env.LOGS.get(`session:${id}`, "json");
    if (!meta) continue;
    const items = [];
    for (const itemId of (meta.item_ids || [])) {
      const item = await env.LOGS.get(`item:${id}:${itemId}`, "json");
      if (item) items.push(item);
    }
    sessions.push({...meta, student: meta.student || student, items});
  }
  return json({profile: profile || null, sessions}, 200, request, env);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return response(null, 204, request, env);
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/log" && request.method === "POST") return await postLog(request, env);
      if (url.pathname === "/api/sessions" && request.method === "GET") return await listSessions(request, env, url);
      if (url.pathname.startsWith("/api/profile/") && request.method === "GET") return await getProfile(request, env, url, decodeURIComponent(url.pathname.slice("/api/profile/".length)));
      if (url.pathname.startsWith("/api/export/") && request.method === "GET") return await getExport(request, env, url, decodeURIComponent(url.pathname.slice("/api/export/".length)));
      if (url.pathname.startsWith("/api/session/") && request.method === "GET") return await getSession(request, env, url, decodeURIComponent(url.pathname.slice("/api/session/".length)));
      return json({error: "not found"}, 404, request, env);
    } catch (error) {
      return json({error: "server error"}, 500, request, env);
    }
  }
};
