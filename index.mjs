import fs from "node:fs";
import path from "node:path";

/**
 * fal.ai plugin: any model on the platform through its queue API. Agents
 * discover models and their input schemas first (both free), upload sources
 * to the fal CDN, run, and get outputs saved into workspace artifacts with
 * provenance and a cost estimate. The key is the managed FAL_KEY credential
 * (Settings → Integrations), read per call so it can be set without a restart.
 *
 *   plugins:
 *     fal:
 *       config:
 *         api_key: ${FAL_KEY}      # optional; this is the default
 *         default_wait_s: 600      # how long fal_run waits before handing back a request_id
 */

const API = "https://api.fal.ai/v1";
const QUEUE = "https://queue.fal.run";
const REST = "https://rest.fal.ai";
const POLL_MS = 3000;
const DOWNLOAD_CAP = 512 * 1024 * 1024;
/** Above this the CDN wants multipart upload — out of scope for now. */
const UPLOAD_CAP = 90 * 1024 * 1024;

const EXT_BY_MIME = {
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/mp4": "m4a",
  "application/json": "json", "text/plain": "txt",
};
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]));
MIME_BY_EXT.jpeg = "image/jpeg";
MIME_BY_EXT.m4v = "video/mp4";

const resolveRef = (ref) => String(ref ?? "").replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] ?? "");

export default async function activate(ctx) {
  const cfg = { api_key: "${FAL_KEY}", default_wait_s: 600, ...(ctx.config ?? {}) };
  const key = () => {
    const k = resolveRef(cfg.api_key);
    if (!k) throw new Error("FAL_KEY is not set — add the fal.ai key under Settings → Integrations (or plugins.fal.config.api_key)");
    return k;
  };
  const auth = () => ({ Authorization: `Key ${key()}` });

  async function falJson(url, init = {}, timeoutMs = 60_000) {
    const res = await fetch(url, { ...init, headers: { ...auth(), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    if (!res.ok) throw new Error(`fal ${res.status} ${url.replace(QUEUE, "queue").replace(API, "api")}: ${body.slice(0, 400)}`);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`fal returned non-JSON from ${url}: ${body.slice(0, 200)}`);
    }
  }
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const json = (v) => text(JSON.stringify(v, null, 1));

  /** Local path → absolute, jailed to this workspace's artifacts or workdir. */
  function resolveLocal(ws, p) {
    const art = ctx.paths.workspaceArtifacts(ws);
    const work = ctx.paths.workspaceWorkdir(ws);
    const abs = p.includes("artifacts/")
      ? path.join(art, p.slice(p.indexOf("artifacts/") + "artifacts/".length))
      : path.resolve(work, p);
    const inside = (root) => abs === root || abs.startsWith(root + path.sep);
    if (!inside(art) && !inside(work)) throw new Error(`path is outside your workspace: ${p}`);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`file not found: ${p}`);
    return abs;
  }

  /** Walk a result and collect every file-like output ({url, content_type?, file_name?}). */
  function collectFiles(v, out = [], depth = 0) {
    if (depth > 6 || v === null || typeof v !== "object") return out;
    if (Array.isArray(v)) {
      for (const x of v) collectFiles(x, out, depth + 1);
      return out;
    }
    if (typeof v.url === "string" && /^https?:\/\//.test(v.url) &&
        (typeof v.content_type === "string" || typeof v.file_name === "string" || /\.(mp4|webm|mov|png|jpe?g|webp|gif|mp3|wav|ogg|m4a)(\?|$)/i.test(v.url))) {
      out.push({ url: v.url, contentType: typeof v.content_type === "string" ? v.content_type : undefined });
      return out;
    }
    for (const x of Object.values(v)) collectFiles(x, out, depth + 1);
    return out;
  }

  /** Download outputs into artifacts/<task|fal>/ with provenance; returns relative paths. */
  async function saveOutputs(call, endpointId, requestId, result, note) {
    const files = collectFiles(result);
    if (!files.length) return [];
    const folder = call.taskId ?? "fal";
    const slug = endpointId.replace(/^fal-ai\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
    const rels = [];
    for (const [i, f] of files.entries()) {
      const res = await fetch(f.url, { signal: AbortSignal.timeout(300_000), redirect: "follow" });
      if (!res.ok) {
        ctx.log.warn(`fal output download failed (${res.status}): ${f.url}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > DOWNLOAD_CAP) {
        ctx.log.warn(`fal output exceeds the ${DOWNLOAD_CAP / 1e6}MB cap, left on the CDN: ${f.url}`);
        continue;
      }
      const mime = f.contentType ?? (res.headers.get("content-type") ?? "").split(";")[0];
      const urlExt = (new URL(f.url).pathname.split(".").pop() ?? "").toLowerCase();
      const ext = EXT_BY_MIME[mime] ?? (urlExt && urlExt.length <= 4 ? urlExt : "bin");
      const name = `${slug}-${requestId.slice(0, 8)}${files.length > 1 ? `-${i + 1}` : ""}.${ext}`;
      const rel = path.posix.join(folder, name);
      const abs = path.join(ctx.paths.workspaceArtifacts(call.workspace), rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      ctx.artifacts.annotate(call.workspace, rel, {
        agent: call.agent,
        taskId: call.taskId,
        description: `fal.ai ${endpointId} · request ${requestId} · ${note}`.slice(0, 300),
        action: "generated",
      });
      rels.push(rel);
    }
    if (rels.length) ctx.artifacts.mirror(call.workspace, rels);
    return rels;
  }

  /** Best-effort historical price for one call; 0 when the estimate API has nothing. */
  async function estimateCost(endpointId) {
    try {
      const r = await falJson(`${API}/models/pricing/estimate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ estimate_type: "historical_api_price", endpoints: { [endpointId]: { call_quantity: 1 } } }),
      }, 20_000);
      return typeof r.total_cost === "number" ? r.total_cost : 0;
    } catch {
      return 0;
    }
  }

  /** Trim a result for the tool reply: keep structure, cut long strings (base64, logs). */
  function compact(v, depth = 0) {
    if (typeof v === "string") return v.length > 600 ? `${v.slice(0, 600)}…(${v.length} chars)` : v;
    if (Array.isArray(v)) return depth > 5 ? `[${v.length} items]` : v.slice(0, 20).map((x) => compact(x, depth + 1));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compact(x, depth + 1)]));
    return v;
  }

  async function finish(call, endpointId, requestId, note) {
    const result = await falJson(`${QUEUE}/${endpointId}/requests/${requestId}/response`, {}, 120_000);
    const artifacts = await saveOutputs(call, endpointId, requestId, result, note);
    const costUsd = await estimateCost(endpointId);
    ctx.usage.record({ workspace: call.workspace, agent: call.agent, kind: "fal", model: endpointId, costUsd });
    return json({
      request_id: requestId,
      status: "COMPLETED",
      artifacts,
      ...(costUsd ? { cost_usd_estimate: costUsd } : {}),
      result: compact(result),
      ...(artifacts.length ? { hint: "reference outputs as [media: artifacts/<path>]; watch videos with video_understand before signing off" } : {}),
    });
  }

  const z = ctx.z;

  ctx.registerTool({
    name: "fal_models",
    description:
      "Search the fal.ai catalog (600+ models: image, video, audio, music, 3D, LLM). Free. Returns endpoint ids to use with fal_schema / fal_run. Filter by free text and/or category such as text-to-image, image-to-video, text-to-video, text-to-audio, video-to-video.",
    schema: {
      query: z.string().optional().describe("free-text search, e.g. 'minimax image to video'"),
      category: z.string().optional().describe("e.g. image-to-video"),
      limit: z.number().int().min(1).max(30).optional(),
    },
    handler: async (args) => {
      const u = new URL(`${API}/models`);
      if (args.query) u.searchParams.set("q", String(args.query));
      if (args.category) u.searchParams.set("category", String(args.category));
      u.searchParams.set("limit", String(args.limit ?? 15));
      u.searchParams.set("status", "active");
      const r = await falJson(u.toString());
      return json({
        models: (r.models ?? []).map((m) => ({
          endpoint_id: m.endpoint_id,
          name: m.metadata?.display_name,
          category: m.metadata?.category,
          description: String(m.metadata?.description ?? "").slice(0, 200),
        })),
        has_more: r.has_more ?? false,
      });
    },
  });

  ctx.registerTool({
    name: "fal_schema",
    description:
      "Input schema of one fal.ai endpoint (free) — parameter names, types, enums, defaults, which are required. ALWAYS read it before fal_run: a paid call built on guessed parameter names burns money to learn what this read tells you.",
    schema: { endpoint_id: z.string().describe("e.g. fal-ai/minimax/hailuo-02/standard/image-to-video") },
    handler: async (args) => {
      const id = String(args.endpoint_id);
      const u = new URL(`${API}/models`);
      u.searchParams.set("endpoint_id", id);
      u.searchParams.set("expand", "openapi-3.0");
      const r = await falJson(u.toString());
      const m = r.models?.[0];
      if (!m) return text(`error: no such endpoint "${id}" — search with fal_models`);
      const api = m.openapi ?? {};
      const schemas = api.components?.schemas ?? {};
      const deref = (s, depth = 0) => {
        if (depth > 8 || !s || typeof s !== "object") return s;
        if (typeof s.$ref === "string") return deref(schemas[s.$ref.split("/").pop() ?? ""], depth + 1);
        return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => deref(x, depth + 1)) : deref(v, depth + 1)]));
      };
      let input = null;
      let output = null;
      for (const [p, ops] of Object.entries(api.paths ?? {})) {
        if (p.includes("/requests/")) continue;
        const body = ops.post?.requestBody?.content?.["application/json"]?.schema;
        if (body) input = deref(body);
      }
      for (const [p, ops] of Object.entries(api.paths ?? {})) {
        if (!p.endsWith("/response")) continue;
        const resp = ops.get?.responses?.["200"]?.content?.["application/json"]?.schema;
        if (resp) output = deref(resp);
      }
      const out = JSON.stringify({ endpoint_id: id, name: m.metadata?.display_name, category: m.metadata?.category, input, output }, null, 1);
      return text(out.length > 14_000 ? `${out.slice(0, 14_000)}\n…(truncated)` : out);
    },
  });

  ctx.registerTool({
    name: "fal_upload",
    description:
      "Upload a local file (artifacts/… or a workspace path) to the fal CDN and get a URL usable as image_url / video_url / audio_url input for fal_run. Files already on a public https URL need no upload.",
    schema: { path: z.string().describe("artifacts/<path> or a path inside your workspace") },
    handler: async (args, call) => {
      const abs = resolveLocal(call.workspace, String(args.path));
      const size = fs.statSync(abs).size;
      if (size > UPLOAD_CAP) throw new Error(`file is ${(size / 1e6).toFixed(0)}MB; the plugin uploads up to ${UPLOAD_CAP / 1e6}MB`);
      const ext = path.extname(abs).slice(1).toLowerCase();
      const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";
      const init = await falJson(`${REST}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content_type: contentType, file_name: path.basename(abs) }),
      });
      const put = await fetch(init.upload_url, { method: "PUT", headers: { "Content-Type": contentType }, body: fs.readFileSync(abs), signal: AbortSignal.timeout(600_000) });
      if (!put.ok) throw new Error(`fal upload PUT failed: ${put.status} ${(await put.text()).slice(0, 200)}`);
      return json({ url: init.file_url, content_type: contentType, bytes: size });
    },
  });

  ctx.registerTool({
    name: "fal_run",
    description:
      "Run any fal.ai endpoint through the queue and wait for the result. Inputs follow the endpoint's schema (fal_schema) — pass them as-is, e.g. {prompt, image_url, duration, resolution, enable_safety_checker}. Outputs (video/image/audio) are downloaded into this task's artifacts folder with provenance; the reply carries their paths plus the raw result. If the wait runs out, you get the request_id back — continue with fal_result. Every call is PAID: check the schema first, keep test runs at the cheapest settings.",
    schema: {
      endpoint_id: z.string(),
      input: z.record(z.string(), z.unknown()).describe("endpoint input object, exactly as the schema names it"),
      wait_s: z.number().int().min(10).max(1500).optional().describe("seconds to wait before handing back the request_id (default from config, 600)"),
      note: z.string().max(200).optional().describe("short provenance note stored on the outputs (what this is for)"),
    },
    handler: async (args, call) => {
      const endpointId = String(args.endpoint_id).replace(/^\/+|\/+$/g, "");
      const input = args.input ?? {};
      const waitMs = Number(args.wait_s ?? cfg.default_wait_s) * 1000;
      const note = String(args.note ?? (typeof input.prompt === "string" ? input.prompt.slice(0, 120) : ""));
      const sub = await falJson(`${QUEUE}/${endpointId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      ctx.log.info(`@${call.agent} fal ${endpointId} → request ${sub.request_id}`);
      const started = Date.now();
      let last = null;
      while (Date.now() - started < waitMs) {
        last = await falJson(`${QUEUE}/${endpointId}/requests/${sub.request_id}/status?logs=1`, {}, 30_000);
        if (last.status === "COMPLETED") return finish(call, endpointId, sub.request_id, note);
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      return json({
        request_id: sub.request_id,
        status: last?.status ?? "IN_QUEUE",
        queue_position: last?.queue_position,
        last_log: last?.logs?.at(-1)?.message,
        hint: `still running after ${Math.round(waitMs / 1000)}s — call fal_result with this request_id (the work continues on fal's side)`,
      });
    },
  });

  ctx.registerTool({
    name: "fal_result",
    description: "Status / result of a queued fal.ai request (from fal_run that ran out of wait time). Completed outputs are downloaded into artifacts exactly like fal_run does.",
    schema: {
      endpoint_id: z.string(),
      request_id: z.string(),
      wait_s: z.number().int().min(0).max(1500).optional().describe("optionally keep polling this long"),
      note: z.string().max(200).optional(),
    },
    handler: async (args, call) => {
      const endpointId = String(args.endpoint_id);
      const rid = String(args.request_id);
      const waitMs = Number(args.wait_s ?? 0) * 1000;
      const started = Date.now();
      for (;;) {
        const st = await falJson(`${QUEUE}/${endpointId}/requests/${rid}/status?logs=1`, {}, 30_000);
        if (st.status === "COMPLETED") return finish(call, endpointId, rid, String(args.note ?? ""));
        if (Date.now() - started >= waitMs) return json({ request_id: rid, status: st.status, queue_position: st.queue_position, last_log: st.logs?.at(-1)?.message });
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    },
  });

  ctx.registerTool({
    name: "fal_cancel",
    description: "Cancel a queued fal.ai request that has not started yet (already-running work cannot be cancelled and is billed).",
    schema: { endpoint_id: z.string(), request_id: z.string() },
    handler: async (args) => {
      const res = await fetch(`${QUEUE}/${String(args.endpoint_id)}/requests/${String(args.request_id)}/cancel`, { method: "PUT", headers: auth(), signal: AbortSignal.timeout(30_000) });
      const body = await res.json().catch(() => ({}));
      return json({ http: res.status, ...body });
    },
  });

  ctx.log.info("fal.ai tools registered (fal_models, fal_schema, fal_upload, fal_run, fal_result, fal_cancel)");
}
