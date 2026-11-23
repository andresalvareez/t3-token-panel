
var __tpApi=(function(){const PRICE_VERSION = "2026-11-17";
const PRICE_TABLE = [["claude-opus-5-5", 4, 20, 0.2, 5], ["claude-opus-5", 5, 25, 0.5, 6.25], ["claude-opus-4-5", 5, 25, 0.5, 6.25], ["claude-opus-4-1", 15, 75, 1.5, 18.75], ["claude-opus-4-0", 15, 75, 1.5, 18.75], ["claude-opus-4", 15, 75, 1.5, 18.75], ["claude-opus", 5, 25, 0.5, 6.25], ["claude-fable-5-2", 8, 40, 0.2, 10], ["claude-fable-5-1", 10, 50, 0.25, 12.5], ["claude-fable", 10, 50, 1, 12.5], ["claude-sonnet-5-5", 2, 10, 0.1, 2.5], ["claude-sonnet-5", 2, 10, 0.2, 2.5], ["claude-sonnet", 3, 15, 0.3, 3.75], ["claude-haiku-5-5", 0.1, 0.5, 0.01, 0.125], ["claude-haiku", 1, 5, 0.1, 1.25], ["gpt-6-1-sol", 2, 10, 0.1, 2.5], ["gpt-6-1-terra", 1, 5, 0.05, 1.25], ["gpt-6-luna", 0.1, 0.5, 0.01, 0.125], ["gpt-6-astra", 10, 50, 1, 12.5], ["gpt-6-sol", 2, 10, 0.2, 2.5], ["gpt-5-6-sol", 4, 20, 0.4, 5], ["gpt-5-6-terra", 2, 12, 0.2, 2.5], ["gpt-5-6-luna", 0.2, 1.2, 0.02, 0.25], ["gpt-5-5", 5, 30, 0.5, 5], ["gpt-5-4-mini", 0.75, 4.5, 0.075, 0.75]];
const SUB_MAX = 12;
const tnum = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
function recencyOf(t) {
if (!t || typeof t !== "object")
return 0;
let best = 0;
for (const k of ["updatedAt", "latestRunRequestedAt", "createdAt"]) {
const ms = typeof t[k] === "string" || typeof t[k] === "number" ? Date.parse(t[k]) : NaN;
if (Number.isFinite(ms) && ms > best)
best = ms;
}
return best;
}
function isNativeClaude(s) {
return !!s && typeof s === "object" && s.driver === "claudeAgent" && s.origin === "provider_native";
}
function collectChildren(rootThreadId, rootProjection, shells) {
try {
const excluded = new Set();
const fromProj = [];
const subs = rootProjection && Array.isArray(rootProjection.subagents) ? rootProjection.subagents : [];
for (const s of subs) {
if (!s || typeof s.childThreadId !== "string" || !s.childThreadId)
continue;
if (isNativeClaude(s))
excluded.add(s.childThreadId);
else
fromProj.push(s.childThreadId);
}
const byParent = new Map();
const rec = new Map();
for (const t of Array.isArray(shells) ? shells : []) {
const l = t && t.lineage;
if (!l || l.relationshipToParent !== "subagent" || typeof l.parentThreadId !== "string")
continue;
if ((t.forkedFrom && t.forkedFrom.type === "run") || l.sideChat === true)
continue;
if (!byParent.has(l.parentThreadId))
byParent.set(l.parentThreadId, []);
byParent.get(l.parentThreadId).push(t);
rec.set(t.id, recencyOf(t));
}
const seen = new Set([rootThreadId]);
const order = [];
const stack = [rootThreadId];
const visit = (id) => {
if (seen.has(id) || excluded.has(id))
return;
seen.add(id);
order.push(id);
stack.push(id);
};
for (const id of fromProj)
visit(id);
while (stack.length) {
const p = stack.pop();
for (const t of byParent.get(p) ?? [])
visit(t.id);
}
const idx = new Map(order.map((id, i) => [id, i]));
const ids = order.slice().sort((a, b) => (rec.get(b) ?? 0) - (rec.get(a) ?? 0) || idx.get(b) - idx.get(a));
return { ids, n: ids.length };
}
catch {
return { ids: [], n: 0 };
}
}
const aggCache = typeof WeakMap === "function" ? new WeakMap() : null;
function aggregateChild(proj) {
try {
const turns = proj && Array.isArray(proj.providerTurns) ? proj.providerTurns : null;
if (!turns)
return { b: {}, inc: false, nou: false };
const hit = aggCache && aggCache.get(turns);
if (hit)
return hit;
const tm = proj.thread && proj.thread.modelSelection && typeof proj.thread.modelSelection.model === "string" ? proj.thread.modelSelection.model : "";
const b = {};
const seen = new Set();
let inc = false;
let nou = false;
for (const t of turns) {
if (!t || typeof t !== "object")
continue;
if (typeof t.id === "string") {
if (seen.has(t.id))
continue;
seen.add(t.id);
}
const u = t.turnTokenUsage;
if (!u || typeof u !== "object") {
if (!["starting", "running", "waiting", "queued", "pending"].includes(t.status))
nou = true;
continue;
}
if (u.usageStatus !== "complete")
inc = true;
const inp = tnum(u.inputTokens);
const cr = Math.min(tnum(u.cachedInputTokens), inp);
const cw = Math.min(tnum(u.cacheCreationTokens), inp - cr);
const unc = Math.max(0, inp - cr - cw);
const out = tnum(u.outputTokens);
if (unc + cr + cw + out <= 0)
continue;
let id = Array.isArray(u.models) && typeof u.models[0] === "string" ? u.models[0].trim() : "";
if (!id)
id = typeof t.model === "string" ? t.model.trim() : "";
if (!id)
id = tm.trim();
const a = b[id] || (b[id] = [0, 0, 0, 0]);
a[0] += unc;
a[1] += cr;
a[2] += cw;
a[3] += out;
}
const r = { b, inc, nou };
if (aggCache)
aggCache.set(turns, r);
return r;
}
catch {
return { b: {}, inc: false, nou: false };
}
}
function mergeChildren(n, shown, items) {
const b = {};
let inc = false, nou = false, more = false, loaded = 0;
for (const it of items) {
loaded++;
if (it.inc)
inc = true;
if (it.nou)
nou = true;
if (it.more)
more = true;
for (const [id, v] of Object.entries(it.b)) {
const a = b[id] || (b[id] = [0, 0, 0, 0]);
for (let i = 0; i < 4; i++)
a[i] += v[i];
}
}
return { n, shown, loaded, b, inc, nou, more };
}
function makeSubAtoms(deps) {
const max = deps && Number.isFinite(deps.max) ? deps.max : SUB_MAX;
const FAIL = { n: 0, shown: 0, loaded: 0, b: {}, inc: false, nou: false, more: false };
return deps.family((key) => {
const cut = String(key).indexOf("\n");
const env = String(key).slice(0, cut);
const tid = String(key).slice(cut + 1);
let prev = null;
let prevSig = "";
return deps.atom((get) => {
let out = FAIL;
try {
const root = get(deps.Z.quietThreadAtom({ environmentId: env, threadId: tid }));
const info = collectChildren(tid, root ? root.projection : null, get(deps.Q.environmentThreadsAtom(env)));
const chosen = max > 0 ? info.ids.slice(0, max) : [];
const items = [];
for (const id of chosen) {
const ref = { environmentId: env, threadId: id };
const d = get(deps.Z.quietThreadAtom(ref));
if (!d || !d.projection)
continue;
const it = aggregateChild(d.projection);
let more = false;
try {
const h = get(deps.Z.historyAtom(ref));
more = !!h && h.hasMoreHistory === true;
}
catch {
more = false;
}
items.push({ ...it, more });
}
out = mergeChildren(info.n, chosen.length, items);
if (max <= 0)
out.mode = "n";
}
catch {
out = FAIL;
}
const sig = JSON.stringify(out);
if (sig === prevSig && prev)
return prev;
prev = out;
prevSig = sig;
return out;
});
});
}
const EMPTY = { attrs: {}, card: null };
const DASH = "—";
const DAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
function cssStr(s) {
const t = String(s ?? "")
.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "")
.slice(0, 60)
.replace(/\\/g, "\\\\")
.replace(/"/g, '\\"');
return '"' + t + '"';
}
const trimZeros = (s) => s.replace(/,0+$/, "").replace(/(,\d*?)0+$/, "$1");
const dec = (v, d) => trimZeros(v.toFixed(d).replace(".", ","));
function compact(v) {
v = num(v);
if (Math.round(v) < 1000)
return String(Math.round(v));
if (v < 999500) {
const k = v / 1000;
return (k < 100 ? dec(k, 1) : String(Math.round(k))) + "k";
}
if (v < 999.5e6) {
const m = v / 1e6;
return (m < 10 ? dec(m, 2) : m < 100 ? dec(m, 1) : String(Math.round(m))) + "M";
}
const g = v / 1e9;
return (g < 10 ? dec(g, 2) : g < 100 ? dec(g, 1) : String(Math.round(g))) + "G";
}
function money(v) {
if (!Number.isFinite(v) || v < 0)
return DASH;
if (v > 0 && v < 0.01)
return "< 0,01 $";
const [i, d] = v.toFixed(2).split(".");
return "≈ " + i.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + d + " $";
}
function normalizeModelId(id) {
let s = String(id ?? "").trim().toLowerCase();
s = s.slice(s.lastIndexOf("/") + 1);
s = s.replace(/^(us|eu|global|anthropic)\./, "").replace(/\[[^\]]*\]$/, "");
s = s.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
return s.replace(/\./g, "-");
}
function displayModel(id) {
const raw = String(id ?? "").trim();
if (!raw)
return DASH;
let s = raw.toLowerCase();
s = s.slice(s.lastIndexOf("/") + 1);
s = s.replace(/^(us|eu|global|anthropic)\./, "").replace(/\[[^\]]*\]$/, "");
s = s.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
let m = /^claude-([a-z]+)-(\d+(?:[-.]\d+)*)$/.exec(s);
if (m)
return cap(m[1]) + " " + m[2].replace(/-/g, ".");
m = /^gpt-(\d+(?:[-.]\d+)?)((?:-[a-z0-9]+)*)$/.exec(s);
if (m)
return "GPT-" + m[1].replace("-", ".") + m[2].split("-").filter(Boolean).map((w) => " " + cap(w)).join("");
return raw.slice(0, 24);
}
function priceFor(modelId, overrides) {
const id = String(modelId ?? "").trim();
if (!id)
return null;
const o = overrides && typeof overrides === "object" ? overrides[id] : null;
if (o && Number.isFinite(o.inputCostPerMillionTokens) && Number.isFinite(o.outputCostPerMillionTokens)) {
const inn = o.inputCostPerMillionTokens;
return {
in: inn,
out: o.outputCostPerMillionTokens,
cr: Number.isFinite(o.cacheReadCostPerMillionTokens) ? o.cacheReadCostPerMillionTokens : inn,
cw: Number.isFinite(o.cacheWriteCostPerMillionTokens) ? o.cacheWriteCostPerMillionTokens : inn,
};
}
const n = normalizeModelId(id);
let best = null;
for (const r of PRICE_TABLE) {
if ((n === r[0] || (r[0] !== "claude-opus-4" && n.startsWith(r[0] + "-"))) && (!best || r[0].length > best[0].length))
best = r;
}
return best ? { in: best[1], out: best[2], cr: best[3], cw: best[4] ?? best[1] } : null;
}
function turnModel(t, aliases, fallback) {
const u = t && t.turnTokenUsage;
let id = u && Array.isArray(u.models) && typeof u.models[0] === "string" ? u.models[0] : null;
if (!id || !id.trim())
id = t && typeof t.model === "string" && t.model.trim() ? t.model : fallback;
id = typeof id === "string" ? id.trim() : "";
if (id && aliases && typeof aliases === "object" && typeof aliases[id] === "string" && aliases[id].trim())
id = aliases[id].trim();
return id;
}
function hhmm(d) {
return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function rateValue(w, weekday) {
const used = Number.isFinite(w.usedPercent) ? w.usedPercent : null;
if (used === null)
return null;
const rem = Math.round(100 - Math.min(100, Math.max(0, used)));
let text = rem + " %";
const ms = typeof w.resetsAt === "string" || typeof w.resetsAt === "number" ? Date.parse(w.resetsAt) : NaN;
if (Number.isFinite(ms)) {
const d = new Date(ms);
text += " · " + (weekday ? DAYS[d.getDay()] + " " : "") + hhmm(d);
}
return { p: rem + " %", text, f: rem / 100 };
}
function pickWindow(wins, kind) {
const of = wins.filter((w) => w && typeof w === "object" && w.kind === kind);
const generic = of.find((w) => !(Array.isArray(w.modelIds) && w.modelIds.length) && !/·/.test(String(w.label ?? "")));
return generic ?? of[0] ?? null;
}
const STRATEGY = {
delta_since_target_last_seen: "delta",
full_thread_summary: "hilo completo",
fork_delta_summary: "fork",
checkpoint_summary: "checkpoint",
manual_context: "manual",
};
function modelOf(x) {
if (typeof x === "string")
return x.trim();
return x && typeof x === "object" && typeof x.model === "string" ? x.model.trim() : "";
}
function aliased(id, aliases) {
id = String(id ?? "").trim();
if (id && aliases && typeof aliases === "object" && typeof aliases[id] === "string" && aliases[id].trim())
return aliases[id].trim();
return id;
}
const tsOf = (h, i) => {
const ms = Date.parse((h && (h.createdAt || h.updatedAt)) || "");
return [Number.isFinite(ms) ? ms : 0, i];
};
function handoffInfo(projection, aliases, overrides, fallbackModel, hasMoreHistory) {
const hs = projection && Array.isArray(projection.contextHandoffs)
? projection.contextHandoffs.filter((h) => h && typeof h === "object" && h.status === "ready" && !(h.delivery && typeof h.delivery === "object" && h.delivery.status === "pending"))
: [];
if (!hs.length)
return null;
const runs = new Map((Array.isArray(projection.runs) ? projection.runs : []).filter((r) => r && typeof r === "object").map((r) => [r.id, r]));
const items = new Map();
for (const it of Array.isArray(projection.turnItems) ? projection.turnItems : []) {
if (it && typeof it === "object" && it.type === "handoff" && typeof it.contextHandoffId === "string")
items.set(it.contextHandoffId, it);
}
const ord = hs.map((h, i) => ({ h, k: tsOf(h, i) })).sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1]);
let tokens = 0, cost = 0, priced = 0, anyTok = 0;
let last = null;
for (const { h } of ord) {
const it = items.get(h.id);
const run = runs.get(h.targetRunId);
const to = aliased(modelOf(it && it.toModel) || modelOf(run && run.modelSelection) || "", aliases);
const fromSel = it && Array.isArray(it.fromModelSelections) ? it.fromModelSelections : [];
const from = fromSel.length ? aliased(modelOf(fromSel[fromSel.length - 1]), aliases) : "";
const tk = typeof h.summaryText === "string" ? h.summaryText.length / 4 : 0;
tokens += tk;
if (tk > 0)
anyTok++;
const p = priceFor(to || fallbackModel, overrides);
if (p && tk > 0) {
cost += (tk * p.in) / 1e6;
priced++;
}
last = { from, to, strategy: typeof h.strategy === "string" ? h.strategy : "" };
}
return {
n: hs.length,
from: last.from ? displayModel(last.from) : DASH,
to: last.to ? displayModel(last.to) : DASH,
strategy: STRATEGY[last.strategy] || last.strategy.slice(0, 24) || DASH,
tokens: Math.round(tokens),
cost: priced > 0 ? cost : null,
partial: hasMoreHistory === true,
};
}
function subInfo(projection, children, aliases, overrides, fallbackModel) {
let n = 0;
let mode = "1";
if (children && typeof children === "object" && Number.isFinite(children.n) && children.n > 0) {
n = children.n;
if (children.mode === "n")
mode = "n";
}
else {
n = collectChildren("", projection, []).n;
mode = "n";
}
if (n <= 0)
return null;
if (mode === "n")
return { n, mode, loaded: 0, total: 0, cost: null, partial: true };
let total = 0, cost = 0, priced = 0, unpricedTok = 0;
const b = children.b && typeof children.b === "object" ? children.b : {};
for (const [id, v] of Object.entries(b)) {
const t = (num(v[0]) + num(v[1]) + num(v[2]) + num(v[3]));
total += t;
const p = priceFor(aliased(id, aliases) || fallbackModel, overrides);
if (p) {
cost += (num(v[0]) * p.in + num(v[1]) * p.cr + num(v[2]) * p.cw + num(v[3]) * p.out) / 1e6;
if (t > 0)
priced++;
}
else
unpricedTok += t;
}
const loaded = Math.max(0, Math.min(Number(children.loaded) || 0, n));
const partial = loaded < n || children.inc === true || children.nou === true || children.more === true || unpricedTok > 0;
return { n, mode, loaded, total, cost: total > 0 && priced === 0 ? null : cost, partial, loadedAny: loaded > 0 };
}
const fix = (v) => String(Math.round(v * 10000) / 10000);
function computeTokenPanel(input) {
try {
const { projection, contextUsage, rateWindows, priceOverrides, aliases, fallbackModel, hasMoreHistory, children } = input || {};
const raw = projection && Array.isArray(projection.providerTurns) ? projection.providerTurns : [];
const seen = new Set();
const turns = [];
let skippedUsage = false;
raw.forEach((t, idx) => {
if (!t || typeof t !== "object")
return;
if (t.runAttemptId === null) {
const su = t.turnTokenUsage;
if (su && typeof su === "object" && num(su.inputTokens) + num(su.outputTokens) + num(su.cachedInputTokens) > 0)
skippedUsage = true;
return;
}
if (typeof t.id === "string") {
if (seen.has(t.id))
return;
seen.add(t.id);
}
const ms = Date.parse(t.completedAt || t.startedAt || "");
turns.push({ t, idx, ms: Number.isFinite(ms) ? ms : 0 });
});
turns.sort((a, b) => a.ms - b.ms || (num(a.t.ordinal) - num(b.t.ordinal)) || a.idx - b.idx);
let sIn = 0, sCr = 0, sCw = 0, sOut = 0, cost = 0, saved = 0, priced = 0, counted = 0;
let partial = hasMoreHistory === true || skippedUsage;
let last = null;
let anyData = false;
for (const { t } of turns) {
const u = t.turnTokenUsage;
if (!u || typeof u !== "object") {
if (!["starting", "running", "waiting", "queued", "pending"].includes(t.status))
partial = true;
continue;
}
const inp = num(u.inputTokens);
const cr = Math.min(num(u.cachedInputTokens), inp);
const cw = Math.min(num(u.cacheCreationTokens), inp - cr);
const unc = Math.max(0, inp - cr - cw);
const out = num(u.outputTokens);
const tot = unc + cr + cw + out;
if (u.usageStatus !== "complete")
partial = true;
if (tot <= 0)
continue;
anyData = true;
counted++;
sIn += unc;
sCr += cr;
sCw += cw;
sOut += out;
const p = priceFor(turnModel(t, aliases, fallbackModel), priceOverrides);
let c = null;
if (p) {
c = (unc * p.in + cr * p.cr + cw * p.cw + out * p.out) / 1e6;
cost += c;
saved += (cr * (p.in - p.cr)) / 1e6;
priced++;
}
else {
partial = true;
}
last = { tot, c };
}
if (!anyData)
return EMPTY;
const total = sIn + sCr + sCw + sOut;
const modelTurn = turns.length ? turns[turns.length - 1].t : null;
const model = displayModel(modelTurn ? turnModel(modelTurn, aliases, fallbackModel) : fallbackModel);
const parts = [sIn, sCr, sCw, sOut].map((v) => (total > 0 ? Math.round((v / total) * 10000) / 10000 : 0));
if (total > 0) {
const big = parts.indexOf(Math.max(...parts));
parts[big] = Math.round((parts[big] + (1 - parts.reduce((a, b) => a + b, 0))) * 10000) / 10000;
}
const cu = contextUsage && typeof contextUsage === "object" ? contextUsage : null;
const max = cu && num(cu.maxTokens) > 0 ? num(cu.maxTokens) : 0;
const used = cu && Number.isFinite(cu.usedTokens) ? num(cu.usedTokens) : null;
let pct = null;
if (used !== null && max > 0)
pct = Math.round(Math.min(100, (used / max) * 100));
else if (cu && Number.isFinite(cu.usedPercentage) && max > 0)
pct = Math.round(Math.min(100, Math.max(0, cu.usedPercentage)));
const thr = cu ? num(cu.autoCompactThreshold) : 0;
const thrOk = max > 0 && thr > 0 && thr < max;
const compactF = thrOk ? thr / max : 0;
const thrPct = thrOk && used !== null ? Math.min(999, Math.round((used / thr) * 100)) : null;
const basis = thrPct !== null ? thrPct : pct;
const tone = basis === null ? "ok" : basis >= 90 ? "error" : basis >= 80 ? "warn" : "ok";
let ctxText = DASH;
if (used !== null) {
ctxText = compact(used);
if (max > 0) {
ctxText += " / " + compact(max);
if (pct !== null)
ctxText += " · " + pct + "%" + (thrPct !== null ? "|" + thrPct + "%" : "");
}
}
const wins = Array.isArray(rateWindows) ? rateWindows : [];
const w5 = pickWindow(wins, "session");
const ww = pickWindow(wins, "weekly");
const r5 = w5 ? rateValue(w5, false) : null;
const rw = ww ? rateValue(ww, true) : null;
const hitDen = sIn + sCr + sCw;
const rl = (r) => (r ? { p: r.p, text: r.text, f: fix(r.f), lv: r.f <= 0.1 ? "bad" : r.f <= 0.2 ? "warn" : "ok" } : null);
const card = {
v: 5,
tone,
partial,
t: {
model,
turns: String(counted),
total: compact(total),
cost: priced ? money(cost) : DASH,
last: last ? compact(last.tot) : DASH,
lastCost: last && last.c !== null ? money(last.c) : DASH,
hit: hitDen > 0 ? Math.round((sCr / hitDen) * 100) + " %" : DASH,
saved: priced ? money(saved) : DASH,
in: compact(sIn),
cr: compact(sCr),
cw: compact(sCw),
out: compact(sOut),
f: { in: fix(parts[0]), cr: fix(parts[1]), cw: fix(parts[2]), out: fix(parts[3]) },
},
c: {
text: ctxText,
f: fix(pct === null ? 0 : clamp01(pct / 100)),
compactF: fix(compactF),
hasCompact: compactF > 0,
compact: compactF > 0 ? compact(thr) : DASH,
},
rl: r5 || rw ? { a: rl(r5), w: rl(rw) } : null,
sub: null,
ho: null,
comp: null,
};
const attrs = { "data-tokpanel": "1", "data-tokpanel-tone": tone };
const sub = subInfo(projection, children, aliases, priceOverrides, fallbackModel);
if (sub) {
const showTok = sub.mode !== "n" && sub.loadedAny;
card.sub = {
mode: sub.mode === "n" ? "n" : "1",
n: sub.n,
loaded: sub.loaded,
total: showTok ? compact(sub.total) : DASH,
cost: showTok && sub.cost !== null ? money(sub.cost) : DASH,
partial: sub.partial === true,
};
}
const ho = handoffInfo(projection, aliases, priceOverrides, fallbackModel, hasMoreHistory);
if (ho) {
card.ho = {
n: ho.n,
strategy: ho.strategy,
from: ho.from,
to: ho.to,
tokens: "≈ " + compact(ho.tokens),
cost: ho.cost === null ? DASH : money(ho.cost),
partial: ho.partial === true,
};
}
const comps = (Array.isArray(projection.turnItems) ? projection.turnItems : []).filter((it) => it && typeof it === "object" && it.type === "compaction");
if (comps.length) {
let freed = 0, anyFreed = false;
for (const it of comps) {
if (Number.isFinite(it.beforeTokenCount) && Number.isFinite(it.afterTokenCount)) {
freed += Math.max(0, it.beforeTokenCount - it.afterTokenCount);
anyFreed = true;
}
}
card.comp = { n: comps.length, freed: anyFreed ? compact(freed) : DASH };
}
return { attrs, card };
}
catch {
return EMPTY;
}
}
function agentsPub(projection, settings) {
try {
const raw = projection && Array.isArray(projection.providerTurns) ? projection.providerTurns : [];
let n = 0, max = 0;
for (const t of raw) {
if (!t || typeof t !== "object" || t.runAttemptId === null)
continue;
const ms = Date.parse(t.completedAt || "");
if (!Number.isFinite(ms))
continue;
n++;
if (ms > max)
max = ms;
}
const s = settings && typeof settings === "object" ? settings : {};
const po = s.usagePriceOverrides && typeof s.usagePriceOverrides === "object" ? s.usagePriceOverrides : null;
const al = s.usageModelAliases && typeof s.usageModelAliases === "object" ? s.usageModelAliases : null;
return { lck: n ? n + "|" + max : "", po, al };
}
catch {
return null;
}
}
function runTokenPanel(c) {
try {
let rateWindows = [];
try {
if (c.ys != null && typeof c.limitsFor === "function") {
const r = c.limitsFor(c.ys, c.providers, c.sources, c.nowMs);
const lim = r?.accounts?.find((a) => a.instanceId === c.ys)?.limits ?? c.providers?.find((p) => p.instanceId === c.ys)?.usageLimits;
if (lim && !lim.unavailable && Array.isArray(lim.windows))
rateWindows = lim.windows;
}
}
catch {
rateWindows = [];
}
const s = c.settings && typeof c.settings === "object" ? c.settings : {};
const base = {
projection: c.q,
contextUsage: c.yc,
rateWindows,
now: c.nowMs,
priceOverrides: s.usagePriceOverrides,
aliases: s.usageModelAliases,
fallbackModel: c.model,
hasMoreHistory: c.hasMore === true,
children: c.children,
};
const r = computeTokenPanel(base);
return { attrs: r.attrs, pub: { ...(agentsPub(c.q, s) || { lck: "", po: null, al: null }), card: r.card } };
}
catch {
return { attrs: {}, pub: { lck: "", po: null, al: null, card: null } };
}
}
const AG_LS = "tokpanel.agents.open";
const AG_MIN_MS = 10000;
const AG_FAIL_MS = 60000;
const AG_TIMEOUT_MS = 15000;
const AG_CACHE_MAX = 20;
const AG_TOP = 3;
const AG_MAX_NODES = 2000;
const AG_BUDGET_CONT = 3;
const AG_F = ["in", "cr", "cw5m", "cw1h", "out", "ws", "msgs"];
const AG_KINDS = { root: "Agente principal", sub: "subagente", workflow: "Workflow", "child-thread": "Hilo hijo" };
const agNum = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
function agReadOpen() {
try {
return globalThis.localStorage.getItem(AG_LS) === "1";
}
catch {
return false;
}
}
function agWriteOpen(v) {
try {
globalThis.localStorage.setItem(AG_LS, v ? "1" : "0");
}
catch { }
}
function agMoney(v) {
if (!Number.isFinite(v) || v < 0)
return "—";
if (v === 0)
return "0 $";
if (v < 0.01)
return "< 0,01 $";
const [i, d] = v.toFixed(2).split(".");
return i.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + d + " $";
}
function agLabel(s, fb) {
const t = String(typeof s === "string" ? s : "")
.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
.replace(/\s+/g, " ")
.trim();
if (!t)
return fb;
const cp = Array.from(t);
return cp.length > 60 ? cp.slice(0, 59).join("") + "…" : t;
}
function agUsage(m) {
return { in: agNum(m.in), cr: agNum(m.cr), cw5m: agNum(m.cw5m), cw1h: agNum(m.cw1h), out: agNum(m.out), ws: agNum(m.ws), msgs: agNum(m.msgs) };
}
const agTok = (u) => u.in + u.cr + u.cw5m + u.cw1h + u.out;
function agCost(u, model, po, al) {
const p = priceFor(aliased(model, al), po);
if (!p)
return null;
return (u.in * p.in + u.cr * p.cr + u.cw5m * p.cw + u.cw1h * 2 * p.in + u.out * p.out) / 1e6;
}
function agPriceRow(m, po, al) {
const u = agUsage(m);
const c = agCost(u, m.model, po, al);
return { ...u, model: m.model, name: displayModel(m.model), tok: agTok(u), cost: c === null ? 0 : c, priced: c !== null };
}
function agUsageText(r) {
const parts = ["ent " + compact(r.in), "cl " + compact(r.cr), "ce " + compact(r.cw5m + r.cw1h) + (r.cw1h > 0 ? " (1h " + compact(r.cw1h) + ")" : ""), "sal " + compact(r.out)];
if (r.ws > 0)
parts.push("web " + Math.round(r.ws));
parts.push(r.priced ? agMoney(r.cost) : "sin precio");
return parts.join(" · ");
}
function agModelsText(names) {
if (!names.length)
return "—";
if (names.length === 1)
return names[0];
if (names.length === 2)
return names[0] + " + " + names[1];
return names[0] + " + " + (names.length - 1);
}
function agMerge(list) {
const acc = new Map();
for (const m of Array.isArray(list) ? list : []) {
if (!m || typeof m !== "object" || typeof m.model !== "string" || !m.model.trim())
continue;
const a = acc.get(m.model);
if (!a) {
acc.set(m.model, { ...m });
continue;
}
for (const f of AG_F)
a[f] = (Number.isFinite(a[f]) ? a[f] : 0) + (Number.isFinite(m[f]) ? m[f] : 0);
}
return [...acc.values()];
}
const agValid = (b) => !!b && typeof b === "object" && b.v === 4 && b.ok === true && Array.isArray(b.nodes);
function buildAgentView(body, po, al) {
try {
if (!agValid(body))
return null;
const byId = new Map();
const nodes = [];
for (const n of body.nodes) {
if (nodes.length >= AG_MAX_NODES)
break;
if (!n || typeof n !== "object" || typeof n.id !== "string" || byId.has(n.id))
continue;
const kind = Object.prototype.hasOwnProperty.call(AG_KINDS, n.kind) ? n.kind : "sub";
const models = agMerge(n.models)
.map((m) => agPriceRow(m, po, al))
.sort((a, b) => b.tok - a.tok);
const v = {
id: n.id,
idx: nodes.length,
parentId: typeof n.parentId === "string" ? n.parentId : null,
kind,
purpose: agLabel(n.purpose, AG_KINDS[kind]),
missing: n.missing === true,
partial: n.partial === true,
models,
children: [],
depth: 0,
key: "",
};
byId.set(v.id, v);
nodes.push(v);
}
const roots = [];
for (const v of nodes) {
const p = v.parentId !== null && v.parentId !== v.id ? byId.get(v.parentId) : undefined;
if (p)
p.children.push(v);
else
roots.push(v);
}
const seen = new Set();
const sum = (v, depth) => {
seen.add(v);
v.depth = depth;
let cost = 0, tok = 0, pricedTok = 0, unpricedTok = 0;
const mt = new Map();
for (const m of v.models) {
tok += m.tok;
if (m.priced) {
cost += m.cost;
pricedTok += m.tok;
}
else
unpricedTok += m.tok;
mt.set(m.name, (mt.get(m.name) ?? 0) + m.tok);
}
v.children = v.children.filter((c) => !seen.has(c));
for (const c of v.children) {
sum(c, depth + 1);
cost += c.subCost;
tok += c.subTok;
pricedTok += c.pricedTok;
unpricedTok += c.unpricedTok;
c.subModels.forEach((t, k) => mt.set(k, (mt.get(k) ?? 0) + t));
}
v.subCost = cost;
v.subTok = tok;
v.pricedTok = pricedTok;
v.unpricedTok = unpricedTok;
v.subModels = mt;
v.children.sort((a, b) => (b.pricedTok > 0) - (a.pricedTok > 0) || b.subCost - a.subCost || b.subTok - a.subTok || a.idx - b.idx);
};
for (const r of roots)
sum(r, 0);
for (const v of nodes)
if (!seen.has(v)) {
roots.push(v);
sum(v, 0);
}
roots.sort((a, b) => (a.kind === "root" ? 0 : 1) - (b.kind === "root" ? 0 : 1) || (b.pricedTok > 0) - (a.pricedTok > 0) || b.subCost - a.subCost || b.subTok - a.subTok || a.idx - b.idx);
const keys = (list, pk) => {
const occ = new Map();
for (const v of [...list].sort((a, b) => a.idx - b.idx)) {
const sig = v.kind + ":" + v.depth + ":" + v.purpose;
const i = occ.get(sig) ?? 0;
occ.set(sig, i + 1);
v.key = pk + "/" + sig + "#" + i;
keys(v.children, v.key);
}
};
keys(roots, "");
for (const v of nodes) {
const own = v.models.filter((m) => m.tok > 0).map((m) => m.name);
const names = own.length ? own : [...v.subModels.entries()].filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
v.modelsText = agModelsText([...new Set(names)]);
v.costText = v.pricedTok > 0 ? agMoney(v.subCost) : v.subTok > 0 ? "sin precio" : "—";
}
let src = Array.isArray(body.byModel) ? agMerge(body.byModel) : null;
if (!src || !src.length) {
const acc = new Map();
for (const v of nodes)
for (const m of v.models) {
const a = acc.get(m.model) ?? { model: m.model, in: 0, cr: 0, cw5m: 0, cw1h: 0, out: 0, ws: 0, msgs: 0 };
for (const f of AG_F)
a[f] += m[f];
acc.set(m.model, a);
}
src = [...acc.values()];
}
const byModel = agMerge(src).map((m) => agPriceRow(m, po, al)).filter((m) => m.tok > 0 || m.ws > 0).sort((a, b) => (b.priced - a.priced) || b.cost - a.cost || b.tok - a.tok);
const totalTok = byModel.reduce((a, m) => a + m.tok, 0);
if (totalTok <= 0)
return null;
const pricedRows = byModel.filter((m) => m.priced && m.tok > 0);
const totalCost = pricedRows.reduce((a, m) => a + m.cost, 0);
const unpriced = [...new Set(byModel.filter((m) => !m.priced && m.tok > 0).map((m) => m.name))];
const ws = byModel.reduce((a, m) => a + m.ws, 0);
const sc = body.scope && typeof body.scope === "object" ? body.scope : {};
const partial = sc.partial === true || sc.budgetExceeded === true || nodes.some((v) => v.missing || v.partial);
const agents = nodes.filter((v) => v.kind !== "workflow").length;
const nModels = new Set(byModel.filter((m) => m.tok > 0).map((m) => m.model)).size;
return {
roots,
byModel,
totalTok,
totalCost,
anyPriced: pricedRows.length > 0,
unpriced,
ws,
partial,
agents,
nModels,
valText: pricedRows.length ? agMoney(totalCost) : "sin precio",
subText: agents + (agents === 1 ? " agente" : " agentes") + " · " + nModels + (nModels === 1 ? " modelo" : " modelos") + " · " + compact(totalTok) + " tok",
};
}
catch {
return null;
}
}
function makeUI(R, deps) {
const d = deps && typeof deps === "object" ? deps : {};
const gFetch = (u, i) => (d.fetch ? d.fetch(u, i) : globalThis.fetch(u, i));
const gWin = () => (d.win ? d.win() : typeof window === "undefined" ? undefined : window);
const gDoc = () => (d.doc ? d.doc() : typeof document === "undefined" ? undefined : document);
const gNow = () => (d.now ? d.now() : Date.now());
const gSetT = (f, ms) => (d.setT ? d.setT(f, ms) : setTimeout(f, ms));
const gClearT = (t) => (d.clearT ? d.clearT(t) : clearTimeout(t));
const h = R.createElement;
const map = new Map();
const subs = new Set();
const sigs = new Map();
function publish(key, v) {
try {
const sig = v ? JSON.stringify(v) : "";
if ((sigs.get(key) ?? "") === sig)
return;
if (v) {
map.set(key, v);
sigs.set(key, sig);
}
else {
map.delete(key);
sigs.delete(key);
}
subs.forEach((f) => f());
}
catch { }
}
const subscribe = (f) => { subs.add(f); return () => { subs.delete(f); }; };
function usePub(key) {
const ref = R.useRef(null);
ref.current = null;
R.useEffect(() => { publish(key, ref.current); });
R.useEffect(() => () => publish(key, null), [key]);
return ref;
}
const cache = new Map();
const fsubs = new Set();
const st = new Map();
let tokenP = null;
let visHooked = false;
const fsubscribe = (f) => { fsubs.add(f); return () => { fsubs.delete(f); }; };
function cacheSet(key, e) {
cache.delete(key);
cache.set(key, e);
while (cache.size > AG_CACHE_MAX)
cache.delete(cache.keys().next().value);
fsubs.forEach((f) => { try {
f();
}
catch { } });
}
function visible() {
try {
const doc = gDoc();
return !doc || doc.visibilityState === undefined || doc.visibilityState === "visible";
}
catch {
return true;
}
}
function hookVis() {
if (visHooked)
return;
try {
const doc = gDoc();
if (doc && typeof doc.addEventListener === "function") {
doc.addEventListener("visibilitychange", () => {
if (!visible())
return;
st.forEach((s, k) => { if (s.mounts > 0 && s.due)
trigger(k); });
});
visHooked = true;
}
}
catch { }
}
async function doFetch(thread, signal) {
const path = "/api/tokpanel/agent-tree/" + encodeURIComponent(thread);
const w = gWin();
let url, init;
if (w && w.desktopBridge) {
const b = w.desktopBridge;
const boots = typeof b.getLocalEnvironmentBootstraps === "function" ? b.getLocalEnvironmentBootstraps() : null;
const pe = Array.isArray(boots) ? boots.find((e) => e && e.id === "primary") : null;
const base = pe && typeof pe.httpBaseUrl === "string" ? pe.httpBaseUrl : "";
if (!base || typeof b.getLocalEnvironmentBearerToken !== "function")
return { kind: "none" };
if (!tokenP)
tokenP = Promise.resolve().then(() => b.getLocalEnvironmentBearerToken());
let token = null;
try {
token = await tokenP;
}
catch {
tokenP = null;
}
if (typeof token !== "string" || !token) {
tokenP = null;
return { kind: "none" };
}
url = new URL(path, base).toString();
init = { headers: { Authorization: "Bearer " + token }, credentials: "omit", cache: "no-store", signal };
}
else {
url = path;
init = { credentials: "include", cache: "no-store", signal };
}
const res = await gFetch(url, init);
if (res.status === 401 || res.status === 403) {
tokenP = null;
return { kind: "auth" };
}
const ct = String((res.headers && typeof res.headers.get === "function" ? res.headers.get("content-type") : "") || "").toLowerCase();
if (!res.ok || !ct.startsWith("application/json"))
return { kind: "fail" };
const body = await res.json();
if (agValid(body))
return { kind: "ok", body };
if (body && typeof body === "object" && body.v === 4 && body.ok === false)
return { kind: "none" };
return { kind: "fail" };
}
function start(key, s) {
s.due = false;
const t0 = gNow();
s.prevLast = s.last;
s.last = t0;
let ctrl = null;
try {
ctrl = typeof AbortController === "function" ? new AbortController() : null;
}
catch { }
const tok = {};
s.ctrl = tok;
s.abort = ctrl ? () => { try {
ctrl.abort();
}
catch { } } : () => { };
const to = gSetT(() => { if (s.ctrl === tok)
s.abort(); }, AG_TIMEOUT_MS);
const done = (r) => {
gClearT(to);
if (s.ctrl !== tok)
return;
s.ctrl = null;
const now = gNow();
if (r.kind === "ok") {
s.failUntil = 0;
cacheSet(key, { body: r.body, at: now, stale: false });
const sc = r.body.scope;
if (sc && typeof sc === "object" && sc.budgetExceeded === true && s.cont < AG_BUDGET_CONT) {
s.cont++;
s.due = true;
}
else
s.cont = 0;
}
else if (r.kind === "none") {
s.failUntil = 0;
cacheSet(key, { body: null, at: now, stale: false });
}
else {
s.failUntil = now + AG_FAIL_MS;
const prev = cache.get(key);
if (r.kind === "fail" && prev && prev.body)
cacheSet(key, { body: prev.body, at: prev.at, stale: true });
else
cacheSet(key, { body: null, at: now, stale: false });
}
if (s.due && s.mounts > 0)
trigger(key);
};
let p;
try {
p = doFetch(s.thread, ctrl ? ctrl.signal : undefined);
}
catch {
p = Promise.resolve({ kind: "fail" });
}
Promise.resolve(p).then(done, () => done({ kind: "fail" }));
}
function trigger(key) {
try {
const s = st.get(key);
if (!s || s.mounts <= 0)
return;
if (!visible()) {
s.due = true;
return;
}
if (s.ctrl) {
s.due = true;
return;
}
const t = gNow();
if (t < s.failUntil) {
s.due = true;
return;
}
const wait = s.last + AG_MIN_MS - t;
if (s.last > 0 && wait > 0) {
if (!s.timer)
s.timer = gSetT(() => { s.timer = null; trigger(key); }, wait);
return;
}
start(key, s);
}
catch { }
}
function mount(key, thread) {
let s = st.get(key);
if (!s) {
s = { mounts: 0, last: 0, prevLast: 0, cont: 0, failUntil: 0, timer: null, ctrl: null, abort: null, due: false, thread };
st.set(key, s);
}
s.mounts++;
s.thread = thread;
hookVis();
trigger(key);
return () => {
s.mounts--;
if (s.mounts > 0)
return;
if (s.timer) {
gClearT(s.timer);
s.timer = null;
}
if (s.ctrl) {
s.ctrl = null;
s.last = s.prevLast;
if (s.abort)
s.abort();
}
s.due = false;
};
}
const row = (name, k, v, extra) => h("div", { "data-tp-row": name, ...extra }, h("span", { "data-tp-k": "" }, k), h("span", { "data-tp-v": "" }, v));
function renderNode(v, c) {
const kids = v.children;
const hasSplit = v.models.length > 0 || v.missing || v.partial;
const expandable = kids.length > 0 || hasSplit;
const open = expandable && (c.exp.has(v.key) ? c.exp.get(v.key) : v.depth === 0);
const bid = c.id + "-n" + v.idx;
const cid = c.id + "-c" + v.idx;
const spans = [
h("span", { "data-tp-purpose": "", key: "p" }, v.purpose),
h("span", { "data-tp-models": "", key: "m" }, v.modelsText),
h("span", { "data-tp-tok": "", key: "t" }, compact(v.subTok)),
h("span", { "data-tp-cost": "", key: "c" }, v.costText),
];
const head = expandable
? h("button", { type: "button", "data-tp-node-toggle": "", "aria-expanded": open ? "true" : "false", "aria-controls": open ? bid : undefined, onClick: () => c.toggle(v.key, !open) }, h("span", { "data-tp-chev": "", "aria-hidden": "true", key: "x" }, "›"), ...spans)
: h("div", { "data-tp-node-head": "" }, ...spans);
let body = null;
if (open) {
const parts = [];
if (hasSplit) {
const rows = v.models.map((m) => h("div", { key: m.model, "data-tp-row": "node-model", "data-priced": m.priced ? "1" : "0" }, h("span", { "data-tp-k": "" }, m.name), h("span", { "data-tp-v": "" }, agUsageText(m))));
if (v.missing)
rows.push(h("div", { key: "!m", "data-tp-note": "" }, "Sin transcript"));
else if (v.partial)
rows.push(h("div", { key: "!p", "data-tp-note": "" }, "Uso parcial"));
parts.push(h("div", { "data-tp-split": "", key: "s" }, ...rows));
}
if (kids.length) {
const all = c.more.has(v.key);
const shown = all ? kids : kids.slice(0, AG_TOP);
parts.push(h("ul", { "data-tp-children": "", id: cid, key: "k" }, ...shown.map((k) => renderNode(k, c))));
if (kids.length > AG_TOP) {
parts.push(h("button", { type: "button", "data-tp-more": "", key: "+", "aria-expanded": all ? "true" : "false", "aria-controls": cid, onClick: () => c.toggleMore(v.key) }, all ? "Mostrar menos" : "+" + (kids.length - AG_TOP) + " más"));
}
}
body = h("div", { id: bid, "data-tp-node-body": "" }, ...parts);
}
return h("li", { key: v.key, "data-tp-node": "", "data-kind": v.kind, "data-depth": String(v.depth), "data-missing": v.missing ? "1" : undefined, "data-partial": v.partial ? "1" : undefined, "data-priced": v.costText === "sin precio" ? "0" : undefined }, head, body);
}
function renderBody(view, id, c) {
const models = [h("div", { "data-tp-h": "", key: "h" }, "Por modelo")];
for (const m of view.byModel)
models.push(h("div", { key: "m:" + m.model, "data-tp-row": "model", "data-priced": m.priced ? "1" : "0" }, h("span", { "data-tp-k": "" }, m.name), h("span", { "data-tp-v": "" }, agUsageText(m))));
models.push(h("div", { key: "t", "data-tp-row": "total" }, h("span", { "data-tp-k": "" }, "Total"), h("span", { "data-tp-v": "" }, view.anyPriced ? agMoney(view.totalCost) : "sin precio")));
if (view.unpriced.length)
models.push(h("div", { key: "u", "data-tp-note": "" }, "Sin precio: " + view.unpriced.join(", ") + " (excluido del total)"));
if (view.ws > 0)
models.push(h("div", { key: "w", "data-tp-note": "" }, "Búsquedas web: " + Math.round(view.ws) + " (tarifa no incluida)"));
return h("div", { id, "data-tp-body": "", role: "group", "aria-label": "Detalle de agentes" }, h("div", { "data-tp-scope": "" }, "Historial completo de la sesión Claude" + (view.partial ? " · parcial" : "")), h("section", { "data-tp-sec": "models" }, ...models), h("section", { "data-tp-sec": "tree" }, h("div", { "data-tp-h": "" }, "Árbol"), h("ul", { "data-tp-tree": "" }, ...view.roots.map((r) => renderNode(r, c)))));
}
function Agents(props) {
const key = props.tkey;
const pub = R.useSyncExternalStore(subscribe, () => map.get(key) ?? null, () => null);
const ent = R.useSyncExternalStore(fsubscribe, () => cache.get(key) ?? null, () => null);
const [open, setOpen] = R.useState(agReadOpen);
const [exp, setExp] = R.useState(() => new Map());
const [more, setMore] = R.useState(() => new Set());
const id = R.useId();
const lck = pub ? (typeof pub.lck === "string" ? pub.lck : "") : null;
const lckRef = R.useRef(lck);
R.useEffect(() => { try {
return mount(key, props.thread);
}
catch {
return undefined;
} }, [key]);
R.useEffect(() => {
const prev = lckRef.current;
lckRef.current = lck;
if (prev !== null && lck !== null && prev !== lck)
trigger(key);
}, [key, lck]);
const po = pub ? pub.po : null;
const al = pub ? pub.al : null;
const view = R.useMemo(() => buildAgentView(ent ? ent.body : null, po, al), [ent, po, al]);
if (!view)
return null;
try {
const c = {
id,
exp,
more,
toggle: (k, v) => setExp((m) => { const n = new Map(m); n.set(k, v); return n; }),
toggleMore: (k) => setMore((s) => { const n = new Set(s); if (n.has(k))
n.delete(k);
else
n.add(k); return n; }),
};
return h("div", { "data-tokpanel-agents": "", style: { display: "none" }, "data-open": open ? "1" : "0", "data-partial": view.partial ? "1" : undefined, "data-stale": ent && ent.stale ? "1" : undefined }, h("button", { type: "button", "data-tp-toggle": "", "aria-expanded": open ? "true" : "false", "aria-controls": open ? id : undefined, onClick: () => { const n = !open; setOpen(n); agWriteOpen(n); if (n)
trigger(key); } }, h("span", { "data-tp-chev": "", "aria-hidden": "true" }, "›"), h("span", { "data-tp-label": "" }, "Agentes"), h("span", { "data-tp-val": "" }, view.valText), h("span", { "data-tp-sub": "" }, view.subText)), open ? renderBody(view, id, c) : null);
}
catch {
return null;
}
}
const Card = tcMake(R, { map, subscribe });
const node = (n) => {
try {
if (!n || typeof n.threadId !== "string" || !n.threadId)
return null;
const tkey = String(n.environmentId) + "\n" + n.threadId;
return h(R.Fragment, null, h(Card, { key: tkey + "#card", tkey }), h(Agents, { key: tkey, tkey, thread: n.threadId }));
}
catch {
return null;
}
};
return { usePub, node, Agents, Card, publish, subscribe, size: () => map.size, trigger, cacheSize: () => cache.size, _state: st };
}
const TC_LS = "tokpanel.sec.";
const TC_IDS = ["tokens", "ctx", "rl", "sub", "ho"];
const TC_DASH = "—";
function tcRead() {
const o = {};
for (const id of TC_IDS) {
try {
o[id] = globalThis.localStorage.getItem(TC_LS + id) !== "0";
}
catch {
o[id] = true;
}
}
return o;
}
function tcWrite(id, v) {
try {
globalThis.localStorage.setItem(TC_LS + id, v ? "1" : "0");
}
catch { }
}
const tcF = (s) => {
const v = Number(s);
return String(Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
};
const tcStr = (v) => (typeof v === "string" ? v : v == null ? TC_DASH : String(v));
function tcMake(R, store) {
const h = R.createElement;
const map = store.map;
const subscribe = store.subscribe;
const row = (name, k, v, extra) => h("div", { "data-tp-row": name, ...extra }, h("span", { "data-tp-k": "" }, k), h("span", { "data-tp-v": "" }, tcStr(v)));
const tier = (t) => ({ "data-tp-tier": t });
const pill = () => h("span", { "data-tp-pill": "", key: "p" }, "parcial");
function Card(props) {
const key = props.tkey;
const pub = R.useSyncExternalStore(subscribe, () => map.get(key) ?? null, () => null);
const [open, setOpen] = R.useState(tcRead);
const id = R.useId();
const card = pub && pub.card;
if (!card || typeof card !== "object")
return null;
try {
const toggle = (sid) => {
const v = !open[sid];
setOpen((o) => ({ ...o, [sid]: v }));
tcWrite(sid, v);
};
const sec = (sid, label, hv, partial, bodyLabel, body, extra) => {
const o = open[sid] !== false;
const bid = id + "-" + sid;
const hvNode = hv == null ? null : h("span", { "data-tp-hv": "", key: "h", ...(extra && extra.hvTone ? { "data-tone": extra.hvTone } : null) }, hv);
return h("section", { key: sid, "data-tp-sec": sid, "data-open": o ? "1" : "0", "data-partial": partial ? "1" : undefined, ...(extra && extra.tier ? tier(extra.tier) : null) }, h("button", { type: "button", "data-tp-toggle": "", "aria-expanded": o ? "true" : "false", "aria-controls": o ? bid : undefined, onClick: () => toggle(sid) }, h("span", { "data-tp-chev": "", "aria-hidden": "true", key: "x" }, "›"), h("span", { "data-tp-label": "", key: "l" }, label), hvNode, partial ? pill() : null), o ? h("div", { id: bid, "data-tp-body": "", role: "group", "aria-label": bodyLabel }, ...body()) : null);
};
const t = card.t || {};
const f = t.f || {};
const kids = [];
const oTokens = open.tokens !== false;
kids.push(sec("tokens", "Tokens", oTokens ? null : t.cost === TC_DASH ? tcStr(t.total) : tcStr(t.total) + " · " + tcStr(t.cost), card.partial === true, "Detalle de tokens", () => [
h("div", { "data-tp-grp": "sum", key: "sum" }, row("model", "Modelo", t.model, tier("fc")), row("turns", "Turnos", t.turns, tier("f")), row("total", "Total", t.total), row("cost", "Coste", t.cost)),
h("div", { "data-tp-grp": "dist", key: "dist", ...tier("fc") }, h("div", { "data-tp-bar": "seg", role: "img", "aria-label": "Reparto de tokens" }, ...["in", "cr", "cw", "out"].map((k) => h("span", { "data-tp-seg": k, key: k, style: { "--f": tcF(f[k]) } }))), h("div", { "data-tp-legend": "" }, ...[["in", "Entrada", "Entrada"], ["cr", "Caché lectura", "Caché l."], ["cw", "Caché escritura", "Caché e."], ["out", "Salida", "Salida"]].map(([k, long, short]) => h("div", { "data-tp-row": "legend", "data-k": k, key: k }, h("span", { "data-tp-k": "" }, h("span", { "data-tp-long": "" }, long), h("span", { "data-tp-short": "" }, short)), h("span", { "data-tp-v": "" }, tcStr(t[k])))))),
h("div", { "data-tp-grp": "last", key: "last", ...tier("fc") }, row("last", "Último turno", tcStr(t.last) + " · " + tcStr(t.lastCost), tier("f")), row("hit", "Acierto caché", t.hit), row("saved", "Ahorro", t.saved)),
]));
const c = card.c || {};
kids.push(sec("ctx", "Contexto", tcStr(c.text), false, "Detalle de contexto", () => [
h("div", { "data-tp-bar": "ctx", role: "img", "aria-label": "Contexto usado", "data-tick": c.hasCompact ? "1" : undefined, style: { "--f": tcF(c.f), "--tick": tcF(c.compactF) }, key: "bar" }, h("span", { "data-tp-fill": "", key: "f" }), c.hasCompact ? h("span", { "data-tp-tick": "", key: "t" }) : null),
row("compact", "Autocompacta", c.compact, { key: "cp", ...tier("f") }),
], { hvTone: card.tone }));
const rl = card.rl;
if (rl && typeof rl === "object") {
const win = (w) => (w ? tcStr(w.p) : TC_DASH);
const rrow = (name, label, w) => h("div", { "data-tp-row": name, key: name }, h("span", { "data-tp-k": "" }, label), h("div", { "data-tp-bar": "rl", "data-lv": w ? w.lv : undefined, style: { "--f": w ? tcF(w.f) : "0" } }, h("span", { "data-tp-fill": "" })), h("span", { "data-tp-v": "" }, w ? tcStr(w.text) : TC_DASH));
const o = open.rl !== false;
kids.push(sec("rl", "Límites", o ? null : "5 h " + win(rl.a) + " · sem. " + win(rl.w), false, "Detalle de límites", () => [
rrow("rl5", "Límite 5 h", rl.a),
rrow("rlw", "Semanal", rl.w),
], { tier: "fc" }));
}
const sb = card.sub;
if (sb && typeof sb === "object") {
if (sb.mode === "n") {
kids.push(h("section", { key: "sub", "data-tp-sec": "sub", "data-open": "1", "data-partial": "1", ...tier("fc") }, h("div", { "data-tp-head": "" }, h("span", { "data-tp-label": "", key: "l" }, "Subagentes · " + sb.n), pill())));
}
else {
kids.push(sec("sub", "Subagentes · " + sb.loaded + "/" + sb.n + " cargados", null, sb.partial === true, "Detalle de subagentes", () => [
row("sub-tokens", "Tokens", sb.total, { key: "t" }),
row("sub-cost", "Coste", sb.cost, { key: "c" }),
h("div", { "data-tp-note": "", key: "n", ...tier("t") }, "no incluidos en el total de arriba"),
], { tier: "fc" }));
}
}
const ho = card.ho;
if (ho && typeof ho === "object") {
kids.push(sec("ho", "Context handoff · " + ho.n, null, ho.partial === true, "Detalle de context handoff", () => [
row("strategy", "Estrategia", ho.strategy, { key: "s" }),
row("from", "Origen", ho.from, { key: "f", ...tier("f") }),
row("to", "Destino", ho.to, { key: "t", ...tier("f") }),
row("fromto", "Origen → destino", tcStr(ho.from) + " → " + tcStr(ho.to), { key: "ft", ...tier("c") }),
row("summary", "Resumen est.", tcStr(ho.tokens) + " · " + tcStr(ho.cost), { key: "r" }),
h("div", { "data-tp-note": "", key: "n" }, "incluido en el total"),
], { tier: "fc" }));
}
const cm = card.comp;
if (cm && typeof cm === "object") {
kids.push(h("section", { key: "comp", "data-tp-sec": "comp", ...tier("fc") }, row("comp", "Compactaciones · " + cm.n, "liberado " + tcStr(cm.freed))));
}
return h("div", { "data-tokpanel-card": "", style: { display: "none" }, "data-tone": card.tone, "data-partial": card.partial ? "1" : undefined }, kids);
}
catch {
return null;
}
}
return Card;
}
return{run:runTokenPanel,compute:computeTokenPanel,cssStr,compact,money,displayModel,priceFor,normalizeModelId,version:PRICE_VERSION,makeSubAtoms,collectChildren,aggregateChild,mergeChildren,subMax:SUB_MAX,makeUI,buildAgentView,agentsPub,agMoney,agLabel,agCost};})();
var __tpSubA=(function(){try{return __tpApi.makeSubAtoms({family:__forgeFamily,atom:__forgeAtom,Z:__tpZ,Q:__forgeQ,max:__tpApi.subMax})}catch(e){return null}})();
var __tpUI=(function(){try{return __tpApi.makeUI(Z)}catch(e){return{usePub:function(){return{current:null}},node:function(){return null}}}})();
