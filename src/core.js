/* core.js — regras puras do Meus Plantões: datas (texto YYYY-MM-DD, aritmética em UTC), dinheiro em centavos inteiros,
   previsão de recebimento, coortes, recorrência, validação do formulário e do conjunto de dados. Sem DOM; testado em node:test.
   Fuso: America/Sao_Paulo sem horário de verão desde 2019 → offset fixo -03:00 (guardado no texto ISO de cada plantão). */
export const TZ = 'America/Sao_Paulo', OFFSET = '-03:00', OFFSET_MIN = -180;

/* ---------- datas ---------- */
export const pad = n => String(n).padStart(2, '0');
export const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
export const WDL = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
export const WDS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
export const cap = s => s[0].toUpperCase() + s.slice(1);
export const utc = k => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const addDays = (k, n) => { const d = utc(k); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export function addMonths(k, n, day) { let [y, m, d] = k.split('-').map(Number); m += n - 1; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12 + 1; return `${y}-${pad(m)}-${pad(Math.min(day ?? d, dim(y, m)))}`; }
export const dow = k => utc(k).getUTCDay();
export const diffDays = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
export const dm = k => `${k.slice(8, 10)}/${k.slice(5, 7)}`;
export const dmy = k => `${dm(k)}/${k.slice(0, 4)}`;
export const wdm = k => `${WD[dow(k)]} ${dm(k)}`;
export const monthOf = k => MESES[+k.slice(5, 7) - 1];
export const dayLong = k => `${WDS[dow(k)]}, ${+k.slice(8, 10)} de ${monthOf(k)}`;
export const dayFull = k => `${cap(WDL[dow(k)])}, ${+k.slice(8, 10)} de ${monthOf(k)} de ${k.slice(0, 4)}`;
export const hrs = m => (m % 60 ? `${Math.floor(m / 60)}h${pad(m % 60)}` : `${m / 60} h`);
export const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
export const pl = (n, s, p) => `${n} ${n === 1 ? s : p}`;
export const sum = list => list.reduce((a, s) => a + s.amount_cents, 0);
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const isDateKey = k => typeof k === 'string' && /^\d{4}-\d\d-\d\d$/.test(k) && addDays(k, 0) === k; /* 2026-02-30 não passa */
export const isTimeHM = t => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
export const isoLocal = (k, hm) => `${k}T${hm}:00${OFFSET}`;
export const isIsoLocal = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d-03:00$/.test(v) && isDateKey(v.slice(0, 10)) && isTimeHM(v.slice(11, 16));
/* hoje no fuso do app (o relógio do aparelho pode estar em outro fuso) */
export function todayKey(now = new Date(), tz = TZ) { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
export const nowIso = (now = new Date()) => now.toISOString();
export const uid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export const day = s => s.start.slice(0, 10);
export const endDay = s => s.end.slice(0, 10);
export const t0 = s => s.start.slice(11, 16);
export const t1 = s => s.end.slice(11, 16);
export const night = s => endDay(s) > day(s);
export const minutesOf = (start, end) => Math.round((Date.parse(end) - Date.parse(start)) / 60000);

/* ---------- dinheiro ---------- */
export const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const brl = c => BRL.format(c / 100);
export const centsTxt = c => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); /* 1.380,00 */
/* teto de um plantão: R$ 10 milhões em centavos; acima disso (ou não finito, não inteiro, negativo) o valor é inválido em todos os caminhos */
export const MAX_CENTS = 1e9;
export const safeCents = c => Number.isSafeInteger(c) && c >= 0 && c <= MAX_CENTS ? c : null;
export function parseCents(v) {
  v = String(v ?? '').trim().replace(/^R\$\s*/, ''); if (!v || !/^[\d.,]+$/.test(v) || v.length > 20) return null;
  v = v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : /^\d{1,3}(\.\d{3})+$/.test(v) ? v.replace(/\./g, '') : v;
  const n = Number(v); return Number.isFinite(n) ? safeCents(Math.round(n * 100)) : null;
}
/* valor decimal com ponto (CSV): "1234.5" → 123450; aceita também vírgula brasileira; nunca devolve não finito/inseguro */
export function parseDecimalCents(v) { v = String(v ?? '').trim(); if (!v || v.length > 20) return null; if (/^-?\d+(\.\d+)?$/.test(v)) return safeCents(Math.round(Number(v) * 100)); return parseCents(v); }
export const decimalTxt = c => (c / 100).toFixed(2);

/* ---------- previsão de recebimento (regra do local) ---------- */
export const PALETTE = ['w1', 'w2', 'w3', 'w4', 'w5'];
export function ruleDateFor(rule, k) { return rule.kind === 'days_after' ? addDays(k, rule.days) : addMonths(k, 1, rule.day); }
export function ruleTxtFor(rule) { return rule.kind === 'days_after' ? `${rule.days} dias após o plantão` : `dia ${rule.day} do mês seguinte`; }
export const validRule = r => !!r && (r.kind === 'days_after' ? Number.isInteger(r.days) && r.days >= 0 && r.days <= 366 : r.kind === 'fixed_day' && Number.isInteger(r.day) && r.day >= 1 && r.day <= 31);

/* ---------- coortes (regras normativas do SPEC §2) ---------- */
/* 'worked' = mês do início · 'cash' = mês da previsão (expected_on) · 'paid' = mês do recebimento. Cada plantão entra uma vez por recorte. */
export function cohortOf(shifts, ym, by) {
  const key = s => by === 'worked' ? day(s) : by === 'paid' ? (s.paid_at || '') : s.expected_on;
  const list = shifts.filter(s => key(s).startsWith(ym));
  const t = { count: list.length, minutes: 0, total: 0, received: 0, pending: 0, byPlace: {}, list };
  for (const s of list) {
    const k = s.paid_at ? 'received' : 'pending', b = t.byPlace[s.place] ||= { count: 0, total: 0, received: 0, pending: 0 };
    t.minutes += s.minutes; t.total += s.amount_cents; t[k] += s.amount_cents; b.count++; b.total += s.amount_cents; b[k] += s.amount_cents;
  }
  return t;
}
export const overdueOf = (shifts, today) => shifts.filter(s => !s.paid_at && s.expected_on < today).sort((a, b) => a.expected_on.localeCompare(b.expected_on));

/* ---------- recorrência ---------- */
export function occurrences(freq, iv, from, until) {
  const out = [], d0 = +from.slice(8, 10);
  for (let i = 0; i < 500; i++) {
    const k = freq === 'daily' ? addDays(from, i * iv) : freq === 'weekly' ? addDays(from, 7 * i * iv) : freq === 'monthly' ? addMonths(from, i * iv, d0) : addMonths(from, 12 * i * iv, d0);
    if (k > until) break; out.push(k);
  }
  return out;
}
export const REP = { none: 'Não repete', daily: 'Todo dia', weekly: 'Toda semana', biweekly: 'A cada 2 semanas', monthly: 'Todo mês', yearly: 'Todo ano' };
export const seriesLabel = (repeat, d) => ({ daily: 'Todo dia', weekly: `Toda ${WDL[dow(d)].replace('-feira', '')}`, biweekly: `${cap(WD[dow(d)])} sim, ${WD[dow(d)]} não`, monthly: `Todo dia ${+d.slice(8)}`, yearly: `Todo ano em ${dm(d)}` })[repeat];
export const seriesFreq = repeat => ({ freq: repeat === 'biweekly' ? 'weekly' : repeat, interval: repeat === 'biweekly' ? 2 : 1 });
export const freqTxt = se => se.freq === 'weekly' && se.interval === 2 ? 'A cada 2 semanas' : se.freq === 'weekly' ? 'Toda semana' : se.freq === 'monthly' ? 'Todo mês' : se.freq === 'daily' ? 'Todo dia' : 'Todo ano';
/* alvos de um escopo numa série: recebidos nunca entram (SPEC §2.6) */
export function scopeTargets(shifts, seriesId, occ, scope) {
  const all = shifts.filter(x => x.series === seriesId && !x.paid_at);
  return scope === 'one' ? all.filter(x => day(x) === occ) : scope === 'following' ? all.filter(x => day(x) >= occ) : all;
}

/* ---------- formulário de plantão ---------- */
export function validateForm(f) {
  const e = {};
  if (!f.title.trim()) e.title = 'título'; if (!f.place) e.place = 'local'; if (!isDateKey(f.date)) e.date = 'data';
  if (!isTimeHM(f.start) || !isTimeHM(f.end)) e.time = 'horário'; else if (f.start === f.end) e.time = 'horário (início igual ao fim)';
  const c = parseCents(f.amount); if (c == null || c <= 0) e.amount = 'valor';
  if (f.expected && !isDateKey(f.expected)) e.expected = 'previsão';
  if (f.paid && !isDateKey(f.paidAt)) e.paidAt = 'data do recebimento';
  if (f.repeat !== 'none' && (!isDateKey(f.until) || (f.date && f.until < f.date))) e.until = 'até quando repete';
  return e;
}
export function repDates(f) { const { freq, interval } = seriesFreq(f.repeat); return f.repeat === 'none' || !f.until || !f.date || f.until < f.date ? [f.date] : occurrences(freq, interval, f.date, f.until); }
/* monta o plantão de um formulário para a data k; `first` = ocorrência que leva previsão sobrescrita e recebimento; `rule` = regra do local */
export function mkShift(f, k, first, rule) {
  const endK = toMin(f.end) <= toMin(f.start) ? addDays(k, 1) : k; let mins = toMin(f.end) - toMin(f.start); if (mins <= 0) mins += 1440;
  return { title: f.title.trim(), place: f.place, start: isoLocal(k, f.start), end: isoLocal(endK, f.end), minutes: mins, amount_cents: parseCents(f.amount),
    expected_on: first && f.expOverride && f.expected ? f.expected : ruleDateFor(rule, k), paid_at: first && f.paid ? f.paidAt : null, note: (f.note || '').trim() };
}

/* ---------- identidade e duplicidade na importação (SPEC §3) ---------- */
export const normTitle = t => String(t || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
export const dupKeyCsv = s => `${s.start}|${s.end}|${s.place}|${s.amount_cents}`;
export const dupKeyIcs = s => `${s.start}|${s.end}|${s.place}|${normTitle(s.title)}`;

/* ---------- validação estrutural e referencial do conjunto (backup/importação) — lista vazia = válido ---------- */
export const SCHEMA_VERSION = 1;
/* ids seguros: só caracteres que não quebram atributos HTML, seletores nem URLs (UUID, p029, sn1…) */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const optStr = (v, max = 2000) => v == null || (typeof v === 'string' && v.length <= max);
const optBool = v => v == null || typeof v === 'boolean';
const optIso = v => v == null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));
export function validateDataset(d) {
  const errs = [], push = m => { if (errs.length < 50) errs.push(m); };
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['conjunto de dados ausente'];
  for (const k of ['places', 'templates', 'series', 'shifts']) if (!Array.isArray(d[k])) push(`${k}: lista ausente`);
  if (errs.length) return errs;
  const uniq = (coll, name) => { const seen = new Set(); for (const r of coll) { if (!r || typeof r !== 'object' || Array.isArray(r)) { push(`${name}: registro inválido`); continue; } if (typeof r.id !== 'string' || !ID_RE.test(r.id)) { push(`${name}: id ausente ou inválido${typeof r.id === 'string' ? ` (${r.id.slice(0, 20)})` : ''}`); continue; } if (seen.has(r.id)) push(`${name}: id duplicado ${r.id}`); seen.add(r.id); } return seen; };
  const P = uniq(d.places, 'locais'), T = uniq(d.templates, 'modelos'), SE = uniq(d.series, 'séries'); uniq(d.shifts, 'plantões');
  for (const p of d.places) { if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120) push(`local ${p.id}: nome ausente ou longo demais`); if (typeof p.short !== 'string' || !p.short.trim() || p.short.length > 8) push(`local ${p.id}: sigla ausente ou longa demais`); if (!validRule(p.rule)) push(`local ${p.id}: regra de recebimento inválida`); if (!PALETTE.includes(p.color)) push(`local ${p.id}: cor fora da paleta`); if (!optBool(p.archived) || !optBool(p.sample) || !optIso(p.updated_at)) push(`local ${p.id}: campos auxiliares inválidos`); }
  for (const t of d.templates) { if (!P.has(t.place)) push(`modelo ${t.id}: local inexistente`); if (!isTimeHM(t.start) || !isTimeHM(t.end) || t.start === t.end) push(`modelo ${t.id}: horário inválido`); if (safeCents(t.amount_cents) == null) push(`modelo ${t.id}: valor inválido`); if (typeof t.title !== 'string' || !t.title.trim() || t.title.length > 120) push(`modelo ${t.id}: título ausente ou longo demais`); if (!optBool(t.archived) || !optBool(t.sample)) push(`modelo ${t.id}: campos auxiliares inválidos`); }
  for (const se of d.series) {
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(se.freq)) push(`série ${se.id}: frequência inválida`); if (!Number.isInteger(se.interval) || se.interval < 1 || se.interval > 52) push(`série ${se.id}: intervalo inválido`);
    if (!isDateKey(se.starts_on) || !isDateKey(se.until) || se.until < se.starts_on) push(`série ${se.id}: período inválido`); if (!Array.isArray(se.exdates) || se.exdates.some(x => !isDateKey(x))) push(`série ${se.id}: datas puladas inválidas`);
    if (typeof se.label !== 'string' || !se.label.trim() || se.label.length > 80) push(`série ${se.id}: rótulo ausente`);
    if (!se.overrides || typeof se.overrides !== 'object' || Array.isArray(se.overrides) || Object.entries(se.overrides).some(([k, o]) => !isDateKey(k) || !o || typeof o !== 'object' || !isTimeHM(o.start) || !isTimeHM(o.end))) push(`série ${se.id}: exceções (overrides) inválidas`);
    if (se.tpl) { if (!se.tpl || typeof se.tpl !== 'object' || !P.has(se.tpl.place) || !isTimeHM(se.tpl.start) || !isTimeHM(se.tpl.end) || safeCents(se.tpl.amount_cents) == null || typeof se.tpl.title !== 'string' || !se.tpl.title.trim()) push(`série ${se.id}: modelo embutido inválido`); } else if (!T.has(se.template)) push(`série ${se.id}: modelo inexistente`);
    if (!optBool(se.sample) || !optIso(se.created_at)) push(`série ${se.id}: campos auxiliares inválidos`);
  }
  for (const s of d.shifts) {
    if (!P.has(s.place)) push(`plantão ${s.id}: local inexistente`);
    if (!isIsoLocal(s.start) || !isIsoLocal(s.end)) push(`plantão ${s.id}: data/hora inválida`); else if (s.end <= s.start) push(`plantão ${s.id}: fim antes do início`); else if (Number.isInteger(s.minutes) && s.minutes !== minutesOf(s.start, s.end)) push(`plantão ${s.id}: duração não bate com início e fim`);
    if (safeCents(s.amount_cents) == null) push(`plantão ${s.id}: valor inválido`);
    if (!isDateKey(s.expected_on)) push(`plantão ${s.id}: previsão inválida`); if (s.paid_at != null && !isDateKey(s.paid_at)) push(`plantão ${s.id}: data de recebimento inválida`);
    if (s.series != null && !SE.has(s.series)) push(`plantão ${s.id}: série inexistente`); if (s.template != null && s.template !== '' && !T.has(s.template)) push(`plantão ${s.id}: modelo inexistente`);
    if (typeof s.title !== 'string' || !s.title.trim() || s.title.length > 160) push(`plantão ${s.id}: título ausente ou longo demais`); if (!Number.isInteger(s.minutes) || s.minutes <= 0) push(`plantão ${s.id}: duração inválida`);
    if (!optStr(s.note, 4000) || !optStr(s.ext_uid, 300) || !optIso(s.deleted_at) || !optIso(s.updated_at) || !optIso(s.imported_at) || !optBool(s.sample)) push(`plantão ${s.id}: campos auxiliares inválidos`);
  }
  return errs;
}
