// tokpanel v4 agent-tree aggregator (contract-v4.md sections 1.1-1.4, 2).
// Pure module: no imports. The build inlines this file into the server asset
// (the single leading "export " is stripped); tests import it as ESM.
// deps: { fsp, path, homedir, env, now?, tick?, limits? }
export function makeTokpanelAgentTree(deps) {
	const fsp = deps.fsp;
	const path = deps.path;
	const now = deps.now || (() => Date.now());
	const tick = deps.tick || (() => new Promise((r) => setImmediate(r)));
	const L = Object.assign({
		chunk: 1 << 20,
		linesPerTick: 2000,
		wallMs: 2500,
		newBytes: 256 * 1024 * 1024,
		maxThreads: 200,
		maxThreadDepth: 6,
		maxAgentFiles: 5000,
		maxNodes: 2000,
		maxSmallJson: 4 * 1024 * 1024,
		maxLine: 32 * 1024 * 1024,
		cacheFiles: 3000,
		cacheBytes: 200 * 1024 * 1024,
		memoMs: 5000,
		concurrency: 2,
		dirCacheMs: 60000,
		liveMs: 120000,
		forkScanLines: 300
	}, deps.limits || {});

	const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
	const THREAD_RE = /^[A-Za-z0-9._:-]{1,200}$/;
	const AGENT_RE = /^agent-[A-Za-z0-9_-]{1,80}\.jsonl$/;
	const RUN_RE = /^wf_[A-Za-z0-9_-]{1,80}$/;
	const JOURNAL_RE = /^wf_[A-Za-z0-9_-]{1,80}\.json$/;
	const PREFIX = "/api/tokpanel/agent-tree/";
	const PAT = Buffer.from("\"type\":\"assistant\"");
	const FORK_PAT = Buffer.from("\"forkedFrom\"");
	const FIELDS = 6; // in, cr, cw5m, cw1h, out, ws
	const O_FLAGS = (fsp.constants && fsp.constants.O_RDONLY | (fsp.constants.O_NOFOLLOW || 0)) || "r";

	// ------------------------------------------------------------ helpers
	const nn = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
	function sanitize(s) {
		if (typeof s !== "string") return "";
		let t = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/[‎‏‪-‮⁦-⁩؜]/g, "").replace(/\s+/g, " ").trim();
		const cps = Array.from(t);
		if (cps.length > 60) t = cps.slice(0, 59).join("") + "…";
		return t;
	}
	function parseThreadId(url) {
		try {
			let p = String(url == null ? "" : url);
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) p = new URL(p).pathname;
			const q = p.search(/[?#]/);
			if (q >= 0) p = p.slice(0, q);
			if (!p.startsWith(PREFIX)) return null;
			const raw = p.slice(PREFIX.length);
			if (!raw || raw.includes("/")) return null;
			const id = decodeURIComponent(raw);
			if (!THREAD_RE.test(id) || id.includes("..")) return null;
			return id;
		} catch {
			return null;
		}
	}
	const fail = (reason) => ({ ok: false, v: 4, reason });
	const lastLog = new Map();
	function shouldLog(reason) {
		const t = now();
		const prev = lastLog.get(reason);
		if (prev !== undefined && t - prev < 60000) return false;
		lastLog.set(reason, t);
		return true;
	}

	// ------------------------------------------------------------ SQL plan
	// Generator: yields {sql, params}, receives row arrays, returns the bundle.
	// SELECT-only, parameterized. json_valid guards keep malformed payloads from throwing.
	const J = (col, p) => `CASE WHEN json_valid(${col}) THEN json_extract(${col}, '${p}') END`;
	const PT_COLS = `p.provider_thread_id AS pt, p.thread_id AS threadId, p.driver AS driver, p.provider_instance_id AS instanceId,
		p.first_run_ordinal AS firstOrd, p.updated_at AS updatedAt,
		${J("p.payload_json", "$.nativeThreadRef.nativeId")} AS nativeId,
		${J("p.payload_json", "$.forkedFrom.providerThreadId")} AS forkedFromPt,
		s.model AS model, ${J("s.payload_json", "$.cwd")} AS cwd`;
	const SQL = {
		thread: "SELECT thread_id AS id FROM orchestration_v2_projection_threads WHERE thread_id = ?",
		candidates: `SELECT t.thread_id AS id, ${J("t.payload_json", "$.lineage.parentThreadId")} AS parent,
			${J("t.payload_json", "$.lineage.relationshipToParent")} AS rel
			FROM orchestration_v2_projection_threads t
			WHERE t.thread_id IN (SELECT DISTINCT thread_id FROM orchestration_v2_projection_provider_threads WHERE thread_id IS NOT NULL)`,
		providerThreads: `SELECT ${PT_COLS} FROM orchestration_v2_projection_provider_threads p
			LEFT JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id = p.provider_session_id
			WHERE p.thread_id IN (SELECT value FROM json_each(?))`,
		providerThreadsById: `SELECT ${PT_COLS} FROM orchestration_v2_projection_provider_threads p
			LEFT JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id = p.provider_session_id
			WHERE p.provider_thread_id IN (SELECT value FROM json_each(?))`,
		turns: `SELECT provider_thread_id AS pt, provider_turn_id AS id, run_attempt_id AS attempt, ordinal AS ordinal,
			${J("payload_json", "$.turnTokenUsage")} AS u, ${J("payload_json", "$.model")} AS m
			FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id IN (SELECT value FROM json_each(?))`
	};
	function* queryPlan(threadId) {
		const found = yield { sql: SQL.thread, params: [threadId] };
		if (!found || found.length === 0) return { threadId, notFound: true };
		const cand = yield { sql: SQL.candidates, params: [] };
		const byParent = new Map();
		for (const r of cand || []) {
			if (!r || r.rel !== "subagent" || typeof r.parent !== "string" || typeof r.id !== "string") continue;
			if (!byParent.has(r.parent)) byParent.set(r.parent, []);
			byParent.get(r.parent).push(r.id);
		}
		const threads = [{ id: threadId, parent: null, depth: 0 }];
		const seen = new Set([threadId]);
		let frontier = [threadId];
		let truncated = false;
		for (let d = 1; d <= L.maxThreadDepth && frontier.length; d++) {
			const next = [];
			for (const p of frontier) for (const c of (byParent.get(p) || []).slice().sort()) {
				if (seen.has(c)) continue;
				if (threads.length >= L.maxThreads) { truncated = true; break; }
				seen.add(c);
				threads.push({ id: c, parent: p, depth: d });
				next.push(c);
			}
			frontier = next;
		}
		if (frontier.length && threads.length < L.maxThreads) for (const p of frontier) if ((byParent.get(p) || []).some((c) => !seen.has(c))) truncated = true;
		const ids = threads.map((t) => t.id);
		const pts = Array.from((yield { sql: SQL.providerThreads, params: [JSON.stringify(ids)] }) || []);
		const known = new Set(pts.map((r) => r.pt));
		const forkIds = Array.from(new Set(pts.map((r) => r.forkedFromPt).filter((x) => typeof x === "string" && !known.has(x))));
		const forkSources = forkIds.length ? Array.from((yield { sql: SQL.providerThreadsById, params: [JSON.stringify(forkIds)] }) || []) : [];
		const nonClaude = pts.filter((r) => r.driver !== "claudeAgent").map((r) => r.pt);
		const turns = nonClaude.length ? Array.from((yield { sql: SQL.turns, params: [JSON.stringify(nonClaude)] }) || []) : [];
		return { threadId, notFound: false, threads, truncated, providerThreads: pts, forkSources, turns };
	}

	// ------------------------------------------------------------ filesystem (read-only)
	function expandHome(p) {
		const h = deps.homedir();
		if (p === "~") return h;
		if (p.startsWith("~/")) return path.join(h, p.slice(2));
		return p;
	}
	function claudeHome(settings, instanceId) {
		let configured = "";
		const inst = settings && typeof settings === "object" ? settings.providerInstances : null;
		if (inst && typeof inst === "object") {
			const pick = (x) => (x && typeof x === "object" && x.config && typeof x.config.homePath === "string" ? x.config.homePath.trim() : "");
			const own = typeof instanceId === "string" ? inst[instanceId] : null;
			if (own && (own.driver === undefined || own.driver === "claudeAgent")) configured = pick(own);
			if (!configured && inst.claudeAgent) configured = pick(inst.claudeAgent);
			if (!configured) for (const v of Object.values(inst)) if (v && v.driver === "claudeAgent" && (configured = pick(v))) break;
		}
		if (configured) return path.resolve(expandHome(configured));
		const envDir = deps.env && typeof deps.env.CLAUDE_CONFIG_DIR === "string" ? deps.env.CLAUDE_CONFIG_DIR.trim() : "";
		return path.resolve(envDir || path.join(deps.homedir(), ".claude"));
	}
	const realCache = new Map();
	async function projectsDirOf(home) {
		const c = realCache.get(home);
		if (c && now() - c.at < L.dirCacheMs) return c.dir;
		let dir = null;
		try {
			dir = await fsp.realpath(path.join(home, "projects"));
			const st = await fsp.stat(dir);
			if (!st.isDirectory()) dir = null;
		} catch { dir = null; }
		realCache.set(home, { at: now(), dir });
		return dir;
	}
	const inside = (root, p) => path.resolve(p).startsWith(root + path.sep);
	async function lstatSafe(root, p) {
		if (!inside(root, p)) return null;
		try { return await fsp.lstat(p); } catch { return null; }
	}
	async function readdirSafe(root, dir) {
		if (dir !== root && !inside(root, dir)) return [];
		try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
	}
	async function isRealDir(root, p) {
		const st = await lstatSafe(root, p);
		return !!(st && st.isDirectory() && !st.isSymbolicLink());
	}
	const sessionDirCache = new Map(); // projectsDir -> {at, dirs:[name]}
	async function findSessionFile(root, cwd, sid) {
		if (typeof cwd === "string" && cwd) {
			const enc = path.join(root, cwd.replace(/[^A-Za-z0-9]/g, "-"));
			if (inside(root, enc) && await isRealDir(root, enc)) {
				const f = path.join(enc, sid + ".jsonl");
				const st = await lstatSafe(root, f);
				if (st && st.isFile()) return { file: f, dir: enc };
			}
		}
		let c = sessionDirCache.get(root);
		if (!c || now() - c.at > L.dirCacheMs) {
			const ents = await readdirSafe(root, root);
			c = { at: now(), dirs: ents.filter((e) => e.isDirectory()).map((e) => e.name).sort() };
			sessionDirCache.set(root, c);
		}
		for (const d of c.dirs) {
			const f = path.join(root, d, sid + ".jsonl");
			const st = await lstatSafe(root, f);
			if (st && st.isFile()) return { file: f, dir: path.join(root, d) };
		}
		return null;
	}
	// Only the extracted fields are cached (never the raw journal/meta object, which holds prompts/results).
	const smallCache = new Map();
	const SMALL_CACHE_MAX = 1000;
	const str = (v) => (typeof v === "string" ? v : null);
	const pickMeta = (o) => (o && typeof o === "object" ? { agentType: str(o.agentType), description: sanitize(o.description), toolUseId: str(o.toolUseId), spawnDepth: nn(o.spawnDepth) } : null);
	function pickJournal(o) {
		if (!o || typeof o !== "object") return null;
		const wp = [];
		if (Array.isArray(o.workflowProgress)) for (const ev of o.workflowProgress) if (ev && (ev.type === "workflow_agent" || ev.type === "agent") && typeof ev.agentId === "string") wp.push({ type: "agent", agentId: ev.agentId, label: sanitize(ev.label) });
		return { workflowName: sanitize(o.workflowName), workflowProgress: wp };
	}
	async function readSmallJson(root, p, pick) {
		const st = await lstatSafe(root, p);
		if (!st || !st.isFile() || st.size > L.maxSmallJson) return null;
		const c = smallCache.get(p);
		if (c && c.size === st.size && c.mtimeMs === st.mtimeMs && c.ino === st.ino) { smallCache.delete(p); smallCache.set(p, c); return c.v; }
		let v = null;
		let fh = null;
		try {
			fh = await fsp.open(p, O_FLAGS);
			const fst = await fh.stat();
			if (fst.isFile() && fst.ino === st.ino && fst.size <= L.maxSmallJson) v = pick(JSON.parse((await fh.readFile()).toString("utf8")));
		} catch { v = null; } finally { if (fh) await fh.close().catch(() => {}); }
		smallCache.delete(p);
		while (smallCache.size >= SMALL_CACHE_MAX) smallCache.delete(smallCache.keys().next().value);
		smallCache.set(p, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, v });
		return v;
	}

	// ------------------------------------------------------------ transcript parsing + LRU cache
	const fileCache = new Map();
	let cacheBytes = 0;
	const est = (e) => 256 + e.ids.size * 160 + e.toolUses.size * 120 + e.side.size * 60;
	function cacheTouch(p, e) {
		if (fileCache.has(p)) { cacheBytes -= fileCache.get(p).est || 0; fileCache.delete(p); }
		e.est = est(e);
		cacheBytes += e.est;
		fileCache.set(p, e);
		while (fileCache.size > L.cacheFiles || (cacheBytes > L.cacheBytes && fileCache.size > 1)) {
			const k = fileCache.keys().next().value;
			cacheBytes -= fileCache.get(k).est || 0;
			fileCache.delete(k);
		}
	}
	const newEntry = (ino) => ({ ino, size: -1, mtimeMs: -1, offset: 0, ids: new Map(), toolUses: new Map(), side: new Set(), clamped: new Set(), forkFrom: null, forkLines: 0, skipLine: false, tail: null, est: 0 });
	const models = new Map();
	const internModel = (m) => { const c = models.get(m); if (c !== undefined) return c; models.set(m, m); return m; };

	function handleRow(e, line) {
		let o;
		try { o = JSON.parse(line); } catch { return; }
		if (!o || o.type !== "assistant") return;
		const m = o.message;
		if (!m || typeof m !== "object") return;
		if (Array.isArray(m.content)) for (const c of m.content) {
			if (c && c.type === "tool_use" && (c.name === "Agent" || c.name === "Task") && typeof c.id === "string" && c.id.length <= 200) {
				const d = c.input && typeof c.input === "object" ? sanitize(c.input.description) : "";
				if (!e.toolUses.has(c.id) || (d && !e.toolUses.get(c.id))) e.toolUses.set(c.id, d || null);
			}
		}
		if (typeof m.id !== "string" || typeof m.model !== "string" || m.model === "<synthetic>" || o.isApiErrorMessage === true) return;
		const u = m.usage;
		if (!u || typeof u !== "object") return;
		const cwt = nn(u.cache_creation_input_tokens);
		let a = cwt, b = 0;
		const cc = u.cache_creation;
		if (cc && typeof cc === "object") {
			a = nn(cc.ephemeral_5m_input_tokens);
			b = nn(cc.ephemeral_1h_input_tokens);
			if (a + b > cwt) {
				if (cwt === 0) { a = 0; b = 0; } else { a = Math.round((a * cwt) / (a + b)); b = cwt - a; }
				e.clamped.add(m.id);
			} else if (a + b < cwt) a += cwt - (a + b);
		}
		const vals = [nn(u.input_tokens), nn(u.cache_read_input_tokens), a, b, nn(u.output_tokens), nn(u.server_tool_use && u.server_tool_use.web_search_requests)];
		const prev = e.ids.get(m.id);
		if (prev) { for (let i = 0; i < FIELDS; i++) if (vals[i] > prev[i + 1]) prev[i + 1] = vals[i]; } else e.ids.set(m.id, [internModel(m.model), ...vals]);
		if (o.isSidechain === true) e.side.add(m.id);
	}
	function scanFork(e, data, start, end) {
		// Bound the scan to the first forkScanLines lines, then search that range only (linear).
		let s = start;
		while (e.forkLines < L.forkScanLines && s < end) {
			let nl = data.indexOf(10, s);
			if (nl < 0 || nl >= end) nl = end;
			e.forkLines++;
			s = nl + 1;
		}
		const scanEnd = Math.min(s, end);
		let i = data.indexOf(FORK_PAT, start);
		while (!e.forkFrom && i !== -1 && i < scanEnd) {
			const ls = Math.max(start, data.lastIndexOf(10, i) + 1);
			let le = data.indexOf(10, i);
			if (le < 0 || le > scanEnd) le = scanEnd;
			try {
				const o = JSON.parse(data.toString("utf8", ls, le));
				const sid = o && o.forkedFrom && typeof o.forkedFrom === "object" ? o.forkedFrom.sessionId : null;
				if (typeof sid === "string" && UUID_RE.test(sid)) e.forkFrom = sid;
			} catch {}
			i = le + 1 < scanEnd ? data.indexOf(FORK_PAT, le + 1) : -1;
		}
	}
	async function processLines(e, data, start, end, budget, isRoot) {
		if (isRoot && e.forkLines < L.forkScanLines) scanFork(e, data, start, end);
		let n = 0;
		let i = data.indexOf(PAT, start);
		while (i !== -1 && i < end) {
			const ls = Math.max(start, data.lastIndexOf(10, i) + 1);
			let le = data.indexOf(10, i);
			if (le < 0 || le > end) le = end;
			handleRow(e, data.toString("utf8", ls, le));
			if (++n >= L.linesPerTick) { n = 0; await tick(); budget.check(); }
			i = le + 1 < end ? data.indexOf(PAT, le + 1) : -1;
		}
	}
	// Returns {entry, status: 'ok'|'missing'|'rejected'}; never throws.
	async function parseFile(root, p, budget, isRoot) {
		const st = await lstatSafe(root, p);
		if (!st) return { entry: null, status: "missing" };
		if (st.isSymbolicLink() || !st.isFile()) return { entry: null, status: "rejected" };
		let e = fileCache.get(p);
		if (e && e.ino === st.ino && e.size === st.size && e.mtimeMs === st.mtimeMs) { cacheTouch(p, e); return { entry: e, status: "ok", mtimeMs: st.mtimeMs }; }
		if (!e || e.ino !== st.ino || st.size < e.offset) e = newEntry(st.ino);
		if (budget.exceeded) { cacheTouch(p, e); return { entry: e, status: "ok", incomplete: true, mtimeMs: st.mtimeMs }; }
		let fh = null;
		let complete = false;
		try {
			fh = await fsp.open(p, O_FLAGS);
			const fst = await fh.stat();
			if (!fst.isFile() || fst.ino !== st.ino) return { entry: null, status: "rejected" };
			// Append-only check: the bytes just before the saved offset must be unchanged, else reparse from 0.
			if (e.offset > 0 && e.tail) {
				const chk = Buffer.allocUnsafe(e.tail.length);
				const r = await fh.read(chk, 0, chk.length, e.offset - e.tail.length);
				if (r.bytesRead !== chk.length || !chk.equals(e.tail)) e = newEntry(st.ino);
			}
			const end = Math.min(st.size, fst.size);
			let pos = e.offset;
			let parts = [];
			let partsLen = 0;
			while (pos < end) {
				if (budget.check()) break;
				const len = Math.min(L.chunk, end - pos);
				const buf = Buffer.allocUnsafe(len);
				const { bytesRead } = await fh.read(buf, 0, len, pos);
				if (!bytesRead) break;
				budget.bytes += bytesRead;
				pos += bytesRead;
				let chunk = buf.subarray(0, bytesRead);
				if (e.skipLine) {
					const nl = chunk.indexOf(10);
					if (nl < 0) { e.offset = pos; continue; }
					e.skipLine = false;
					e.offset = pos - bytesRead + nl + 1;
					chunk = chunk.subarray(nl + 1);
				}
				const nlc = chunk.lastIndexOf(10);
				if (nlc < 0) {
					parts.push(chunk);
					partsLen += chunk.length;
					if (partsLen > L.maxLine) { e.skipLine = true; parts = []; partsLen = 0; e.offset = pos; }
					continue;
				}
				const data = partsLen ? Buffer.concat(parts.concat([chunk])) : chunk;
				const lastNl = partsLen + nlc;
				const base = pos - data.length;
				parts = [];
				partsLen = 0;
				await processLines(e, data, 0, lastNl + 1, budget, isRoot);
				e.offset = base + lastNl + 1;
				e.tail = Buffer.from(data.subarray(Math.max(0, lastNl + 1 - 64), lastNl + 1));
				if (lastNl + 1 < data.length) { const rest = Buffer.from(data.subarray(lastNl + 1)); parts.push(rest); partsLen = rest.length; }
				await tick();
			}
			complete = pos >= end;
			if (complete) { e.size = st.size; e.mtimeMs = st.mtimeMs; } else { e.size = -1; e.mtimeMs = -1; }
		} catch {
			e.size = -1; e.mtimeMs = -1;
		} finally {
			if (fh) await fh.close().catch(() => {});
		}
		cacheTouch(p, e);
		return { entry: e, status: "ok", incomplete: !complete, mtimeMs: st.mtimeMs };
	}

	// ------------------------------------------------------------ aggregation
	function makeBudget() {
		const deadline = now() + L.wallMs;
		const b = { bytes: 0, exceeded: false, check() { if (!b.exceeded && (b.bytes >= L.newBytes || now() > deadline)) b.exceeded = true; return b.exceeded; } };
		return b;
	}
	const emptyVals = () => [0, 0, 0, 0, 0, 0, 0]; // in,cr,cw5m,cw1h,out,ws,msgs
	function addUsage(node, model, vals, msgs) {
		let u = node.usage.get(model);
		if (!u) { u = emptyVals(); node.usage.set(model, u); }
		for (let i = 0; i < FIELDS; i++) u[i] += vals[i];
		u[6] += msgs;
	}
	const ptOrder = (a, b) => (nn(a.firstOrd) - nn(b.firstOrd)) || String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")) || String(a.pt).localeCompare(String(b.pt));

	async function compute(bundle, settings) {
		if (!bundle || bundle.notFound) return fail("not-found");
		const budget = makeBudget();
		const scope = { kind: "claude-session-history", sessions: 0, missingSessions: 0, files: 0, liveFiles: 0, childThreads: 0, partial: !!bundle.truncated, budgetExceeded: false, forkExcludedMsgs: 0, tierClamped: 0, orphans: 0 };
		const nodes = [];
		const mk = (o) => { const n = Object.assign({ idx: nodes.length, parent: null, kind: "sub", purpose: "subagente", agentType: null, missing: false, partial: false, inWorkflow: false, orphan: false, usage: new Map(), children: [] }, o); nodes.push(n); return n; };
		const ptsByThread = new Map();
		for (const r of bundle.providerThreads || []) {
			if (!r || typeof r.pt !== "string") continue;
			if (!ptsByThread.has(r.threadId)) ptsByThread.set(r.threadId, []);
			ptsByThread.get(r.threadId).push(r);
		}
		for (const l of ptsByThread.values()) l.sort(ptOrder);
		const rootPts = ptsByThread.get(bundle.threadId) || [];
		const hasClaudeRoot = rootPts.some((r) => r.driver === "claudeAgent");
		const childThreads = (bundle.threads || []).filter((t) => t.depth > 0 && (ptsByThread.get(t.id) || []).length);
		if (!hasClaudeRoot && childThreads.length === 0) return fail("no-data");

		const threadNode = new Map();
		const root = mk({ kind: "root", purpose: "Agente principal", parent: null, agentType: hasClaudeRoot ? null : (rootPts[0] && rootPts[0].driver) || null });
		threadNode.set(bundle.threadId, root);
		for (const t of bundle.threads || []) {
			if (t.depth === 0 || !(ptsByThread.get(t.id) || []).length) continue;
			const parent = threadNode.get(t.parent) || root;
			const pts = ptsByThread.get(t.id);
			const drv = (pts.find((r) => r.driver === "claudeAgent") || pts[0]).driver;
			threadNode.set(t.id, mk({ kind: "child-thread", purpose: "Hilo hijo", agentType: typeof drv === "string" ? drv : null, parent }));
			scope.childThreads++;
		}

		// Codex / non-Claude usage from provider_turns (mirrors tokenPanel.js).
		const turnsByPt = new Map();
		for (const t of bundle.turns || []) { if (!turnsByPt.has(t.pt)) turnsByPt.set(t.pt, []); turnsByPt.get(t.pt).push(t); }
		// Claude sessions, grouped by owner node.
		const rootFiles = []; // {node, entry, root, file, dir, sid}
		const sessionsSeen = new Set();
		const forkSourcesById = new Map((bundle.forkSources || []).concat(bundle.providerThreads || []).map((r) => [r.pt, r]));
		const forkSids = [];
		const order = [bundle.threadId].concat((bundle.threads || []).filter((t) => t.depth > 0).map((t) => t.id));
		for (const tid of order) {
			const node = threadNode.get(tid);
			if (!node) continue;
			for (const r of ptsByThread.get(tid) || []) {
				if (r.driver !== "claudeAgent") {
					const seen = new Set();
					for (const t of turnsByPt.get(r.pt) || []) {
						if (typeof t.id === "string") { if (seen.has(t.id)) continue; seen.add(t.id); }
						let u = null;
						try { u = typeof t.u === "string" ? JSON.parse(t.u) : t.u; } catch { u = null; }
						if (!u || typeof u !== "object") continue;
						// runAttemptId null (Codex native-subagent / delegate child turns, usageScope main_agent): counted on this
						// same node; the parent turns never include it, and turns are deduped by provider turn id above.
						const inp = nn(u.inputTokens);
						const cr = Math.min(nn(u.cachedInputTokens), inp);
						const cw = Math.min(nn(u.cacheCreationTokens), inp - cr);
						const vals = [Math.max(0, inp - cr - cw), cr, cw, 0, nn(u.outputTokens), 0];
						if (u.usageStatus !== "complete") node.partial = true;
						if (vals.every((v) => v === 0)) continue;
						let m = Array.isArray(u.models) && typeof u.models[0] === "string" && u.models[0].trim() ? u.models[0] : (typeof t.m === "string" && t.m.trim() ? t.m : r.model);
						m = typeof m === "string" && m.trim() ? m.trim() : "unknown";
						addUsage(node, m, vals, 1);
					}
					continue;
				}
				const sid = r.nativeId;
				if (typeof sid !== "string" || !UUID_RE.test(sid)) { scope.sessions++; node.missing = true; scope.missingSessions++; scope.partial = true; continue; }
				if (sessionsSeen.has(sid)) continue;
				sessionsSeen.add(sid);
				scope.sessions++;
				const pdir = await projectsDirOf(claudeHome(settings, r.instanceId));
				const loc = pdir ? await findSessionFile(pdir, r.cwd, sid) : null;
				if (!loc) { node.missing = true; scope.missingSessions++; scope.partial = true; continue; }
				const res = await parseFile(pdir, loc.file, budget, true);
				if (!res.entry) { node.missing = true; scope.missingSessions++; scope.partial = true; continue; }
				rootFiles.push({ node, entry: res.entry, root: pdir, file: loc.file, dir: loc.dir, sid, res });
				if (typeof r.forkedFromPt === "string") {
					const src = forkSourcesById.get(r.forkedFromPt);
					if (src && typeof src.nativeId === "string" && UUID_RE.test(src.nativeId)) forkSids.push({ sid: src.nativeId, cwd: src.cwd, pdir });
				}
				if (res.entry.forkFrom) forkSids.push({ sid: res.entry.forkFrom, cwd: r.cwd, pdir });
			}
		}

		// Sub-agent files per session.
		const subFiles = []; // {node, owner, root, file, meta, workflow, entry}
		let agentFiles = 0;
		for (const rf of rootFiles) {
			const sdir = path.join(rf.dir, rf.sid);
			if (!(await isRealDir(rf.root, sdir))) continue;
			const sub = path.join(sdir, "subagents");
			const hasSub = await isRealDir(rf.root, sub);
			const ents = hasSub ? await readdirSafe(rf.root, sub) : [];
			const native = ents.filter((d) => d.isFile() && AGENT_RE.test(d.name)).map((d) => d.name).sort();
			for (const name of native) {
				if (agentFiles >= L.maxAgentFiles) { scope.partial = true; break; }
				agentFiles++;
				const id = name.slice(6, -6);
				const meta = await readSmallJson(rf.root, path.join(sub, "agent-" + id + ".meta.json"), pickMeta);
				subFiles.push({ owner: rf.node, root: rf.root, file: path.join(sub, name), meta: meta && typeof meta === "object" ? meta : {}, workflow: null, agentId: id });
			}
			const wdir = path.join(sub, "workflows");
			const runs = hasSub && await isRealDir(rf.root, wdir) ? (await readdirSafe(rf.root, wdir)).filter((d) => d.isDirectory() && RUN_RE.test(d.name)).map((d) => d.name).sort() : [];
			for (const run of runs) {
				const rdir = path.join(wdir, run);
				const jdir = path.join(sdir, "workflows");
				const journal = JOURNAL_RE.test(run + ".json") && await isRealDir(rf.root, jdir) ? await readSmallJson(rf.root, path.join(jdir, run + ".json"), pickJournal) : null;
				const labels = new Map();
				const wp = journal && Array.isArray(journal.workflowProgress) ? journal.workflowProgress : [];
				for (const ev of wp) if (ev && (ev.type === "workflow_agent" || ev.type === "agent") && typeof ev.agentId === "string") {
					const lab = sanitize(ev.label);
					if (lab && !labels.has(ev.agentId)) labels.set(ev.agentId, lab);
				}
				const group = mk({ kind: "workflow", purpose: sanitize(journal && journal.workflowName) || "Workflow", parent: rf.node, inWorkflow: false });
				const files = (await readdirSafe(rf.root, rdir)).filter((d) => d.isFile() && AGENT_RE.test(d.name)).map((d) => d.name).sort();
				for (const name of files) {
					if (agentFiles >= L.maxAgentFiles) { scope.partial = true; break; }
					agentFiles++;
					const id = name.slice(6, -6);
					const meta = await readSmallJson(rf.root, path.join(rdir, "agent-" + id + ".meta.json"), pickMeta);
					subFiles.push({ owner: rf.node, root: rf.root, file: path.join(rdir, name), meta: meta && typeof meta === "object" ? meta : {}, workflow: group, label: labels.get(id) || "", agentId: id });
				}
			}
		}
		subFiles.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
		for (const sf of subFiles) {
			const res = await parseFile(sf.root, sf.file, budget, false);
			sf.entry = res.entry;
			sf.res = res;
			const meta = sf.meta;
			sf.node = mk({ kind: "sub", agentType: typeof meta.agentType === "string" ? sanitize(meta.agentType) || null : null, inWorkflow: !!sf.workflow, parent: null, missing: !res.entry });
		}
		// toolUseId -> node (root files + all sub files of the same owner)
		const toolOwner = new Map();
		for (const rf of rootFiles) for (const [k, d] of rf.entry.toolUses) if (!toolOwner.has(k)) toolOwner.set(k, { node: rf.node, desc: d });
		for (const sf of subFiles) if (sf.entry) for (const [k, d] of sf.entry.toolUses) if (!toolOwner.has(k)) toolOwner.set(k, { node: sf.node, desc: d });
		for (const sf of subFiles) {
			const meta = sf.meta;
			const tu = typeof meta.toolUseId === "string" ? toolOwner.get(meta.toolUseId) : null;
			const desc = sanitize(meta.description);
			if (sf.workflow) {
				sf.node.purpose = sf.label || desc || (tu && tu.desc) || sf.node.agentType || "subagente";
				sf.node.parent = sf.workflow;
			} else {
				sf.node.purpose = desc || (tu && tu.desc) || sf.node.agentType || "subagente";
				if (tu && tu.node !== sf.node) sf.node.parent = tu.node;
				else {
					// depth 1 -> session owner; depth >= 2 with unresolved tool_use -> owner, orphan
					sf.node.parent = sf.owner;
					if (nn(meta.spawnDepth) >= 2) { sf.node.orphan = true; scope.orphans++; }
				}
			}
		}
		// Cycle guard: any sub whose ancestry loops is re-attached to its owner.
		for (const sf of subFiles) {
			let p = sf.node.parent, steps = 0;
			while (p && steps < 10000) { if (p === sf.node) { sf.node.parent = sf.owner; if (!sf.node.orphan) { sf.node.orphan = true; scope.orphans++; } break; } p = p.parent; steps++; }
		}

		// Fork exclusion: ids of source sessions that are not themselves part of this tree.
		const excluded = new Set();
		for (const f of forkSids) {
			if (sessionsSeen.has(f.sid) || !f.pdir) continue;
			const loc = await findSessionFile(f.pdir, f.cwd, f.sid);
			if (!loc) continue;
			const res = await parseFile(f.pdir, loc.file, budget, true);
			if (res.entry) for (const k of res.entry.ids.keys()) excluded.add(k);
		}
		const excludedHit = new Set();

		// Global dedupe: root files (requested thread first, then child threads), then sub files by path.
		const global = new Map(); // id -> {node, rec}
		const sideNodes = new Map();
		const t0 = now();
		const take = (node, entry) => {
			for (const [id, rec] of entry.ids) {
				if (excluded.has(id)) { excludedHit.add(id); continue; }
				const g = global.get(id);
				if (g) { for (let i = 1; i <= FIELDS; i++) if (rec[i] > g.rec[i]) g.rec[i] = rec[i]; continue; }
				let owner = node;
				if (entry.side.has(id) && (node.kind === "root" || node.kind === "child-thread")) {
					owner = sideNodes.get(node);
					if (!owner) { owner = mk({ kind: "sub", purpose: "Subagente (sidechain)", parent: node }); sideNodes.set(node, owner); }
				}
				global.set(id, { node: owner, rec: rec.slice() });
			}
		};
		const countFile = (res) => {
			scope.files++;
			if (res && res.mtimeMs && t0 - res.mtimeMs < L.liveMs) scope.liveFiles++;
			if (res && res.incomplete) scope.partial = true;
		};
		for (const rf of rootFiles) { take(rf.node, rf.entry); countFile(rf.res); for (const k of rf.entry.clamped) scope.tierClamped++; }
		for (const sf of subFiles) {
			if (!sf.entry) { sf.node.missing = true; continue; }
			take(sf.node, sf.entry);
			countFile(sf.res);
			for (const k of sf.entry.clamped) scope.tierClamped++;
		}
		for (const { node, rec } of global.values()) addUsage(node, rec[0], rec.slice(1), 1);
		scope.forkExcludedMsgs = excludedHit.size;
		if (budget.exceeded) { scope.budgetExceeded = true; scope.partial = true; }

		return finish(nodes, root, scope);
	}

	function finish(nodes, root, scope) {
		for (const n of nodes) n.children = [];
		for (const n of nodes) if (n !== root && n.parent) n.parent.children.push(n);
		const tokens = (n) => { let s = 0; for (const u of n.usage.values()) s += u[0] + u[1] + u[2] + u[3] + u[4]; return s; };
		// Fold smallest leaves if the node budget is exceeded.
		let count = 0;
		const walkCount = (n) => { count++; n.children.forEach(walkCount); };
		walkCount(root);
		if (count > L.maxNodes) {
			const leaves = nodes.filter((n) => n.kind === "sub" && n.children.length === 0 && n.parent).sort((a, b) => tokens(a) - tokens(b));
			const picked = new Map();
			let reduction = 0, i = 0;
			while (reduction < count - L.maxNodes && i < leaves.length) {
				const lf = leaves[i++];
				const g = picked.get(lf.parent) || [];
				g.push(lf);
				picked.set(lf.parent, g);
				reduction = 0;
				for (const l of picked.values()) reduction += l.length - 1;
			}
			for (const [parent, group] of picked) {
				if (group.length < 2) continue;
				const set = new Set(group);
				parent.children = parent.children.filter((c) => !set.has(c));
				const fold = { kind: "sub", purpose: "+" + group.length + " agentes", agentType: null, missing: group.some((g) => g.missing), partial: group.some((g) => g.partial), inWorkflow: group.every((g) => g.inWorkflow), orphan: false, usage: new Map(), children: [], parent };
				for (const g of group) for (const [m, u] of g.usage) addUsage(fold, m, u.slice(0, FIELDS), u[6]);
				parent.children.push(fold);
			}
			scope.partial = true;
		}
		const out = [];
		const byModel = new Map();
		const totals = emptyVals();
		const emit = (n, parentId, depth, guard) => {
			if (guard.has(n)) return;
			guard.add(n);
			const id = "n" + out.length;
			const ms = [];
			for (const [m, u] of n.usage) {
				ms.push({ model: m, in: u[0], cr: u[1], cw5m: u[2], cw1h: u[3], out: u[4], ws: u[5], msgs: u[6] });
				let b = byModel.get(m);
				if (!b) { b = emptyVals(); byModel.set(m, b); }
				for (let i = 0; i < 7; i++) { b[i] += u[i]; totals[i] += u[i]; }
			}
			ms.sort((a, b) => (b.in + b.cr + b.cw5m + b.cw1h + b.out) - (a.in + a.cr + a.cw5m + a.cw1h + a.out) || (a.model < b.model ? -1 : 1));
			out.push({ id, parentId, kind: n.kind, purpose: sanitize(n.purpose) || "subagente", agentType: n.agentType || null, depth, missing: !!n.missing, partial: !!n.partial, inWorkflow: !!n.inWorkflow, ...(n.orphan ? { orphan: true } : {}), models: n.kind === "workflow" ? [] : ms });
			for (const c of n.children) emit(c, id, depth + 1, guard);
		};
		emit(root, null, 0, new Set());
		if (out.some((n) => n.partial || n.missing)) scope.partial = true;
		const fmt = (u) => ({ in: u[0], cr: u[1], cw5m: u[2], cw1h: u[3], out: u[4], ws: u[5], msgs: u[6] });
		return {
			ok: true, v: 4, generatedAt: new Date(now()).toISOString(), scope,
			nodes: out,
			byModel: Array.from(byModel, ([model, u]) => ({ model, ...fmt(u) })).sort((a, b) => (b.in + b.cr + b.cw5m + b.cw1h + b.out) - (a.in + a.cr + a.cw5m + a.cw1h + a.out)),
			totals: fmt(totals)
		};
	}

	// ------------------------------------------------------------ concurrency, memo
	const memo = new Map();
	const inflight = new Map();
	let active = 0;
	const waiters = [];
	const acquire = () => (active < L.concurrency ? (active++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
	const release = () => { const w = waiters.shift(); if (w) w(); else active--; };
	function run(threadId, bundle, settings) {
		const m = memo.get(threadId);
		if (m && now() - m.at < L.memoMs) return Promise.resolve(m.body);
		const p0 = inflight.get(threadId);
		if (p0) return p0;
		const p = (async () => {
			await acquire();
			try {
				return await compute(bundle, settings);
			} catch {
				return fail("internal");
			} finally {
				release();
			}
		})().then((body) => {
			if (memo.size > 64) memo.delete(memo.keys().next().value);
			memo.set(threadId, { at: now(), body });
			return body;
		}).finally(() => inflight.delete(threadId));
		inflight.set(threadId, p);
		return p;
	}

	return { parseThreadId, queryPlan, run, compute, fail, shouldLog, sanitize, claudeHome, SQL, _cache: { fileCache, memo, small: smallCache, clear() { fileCache.clear(); cacheBytes = 0; memo.clear(); smallCache.clear(); realCache.clear(); sessionDirCache.clear(); } } };
}
