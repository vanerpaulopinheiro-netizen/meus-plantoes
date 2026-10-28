/* codecs.js — portabilidade do Meus Plantões (SPEC §3): CSV da escala (formato documentado do Plantãozinho), CSV com ganhos,
   ICS (exportar/importar), backup JSON verificado por SHA-256. Funções puras sobre o conjunto {places, templates, series, shifts};
   nada aqui grava — a prévia decide e o app aplica. Testado em node:test. */
import { OFFSET, OFFSET_MIN, TZ, isDateKey, isTimeHM, isIsoLocal, minutesOf, parseDecimalCents, decimalTxt, safeCents, ruleTxtFor, dm, dmy, brl, normTitle, dupKeyIcs, uid, validateDataset, SCHEMA_VERSION, pad } from './core.js';

/* ---------- CSV ---------- */
/* M4: células de texto que começam com = + - @ (ou tab/CR) ganham apóstrofo — planilhas não as executam como fórmula */
export function csvEscape(v) { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) v = "'" + v; return /[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }
const unFormula = v => String(v || '').replace(/^'(?=[=+\-@\t\r])/, '');
export const MAX_RECORDS = 20000;
export function csvStringify(rows, header) { return [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n'; }
/* parser RFC 4180 tolerante: delimitador detectado no cabeçalho (',' ou ';'), aspas duplas, quebras dentro de aspas, BOM */
export function csvParse(text) {
  text = String(text || '').replace(/^\uFEFF/, ''); const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === delim) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (q) throw new Error('aspas não fechadas no arquivo');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
const H = { /* cabeçalhos aceitos na importação (sem acento, minúsculas) */
  id: ['id'], title: ['title', 'titulo', 'nome', 'plantao', 'descricao'], place: ['place', 'local', 'hospital', 'unidade'], color: ['color', 'cor'],
  start: ['start_date', 'start', 'inicio', 'data_inicio', 'comeca', 'dtstart'], end: ['end_date', 'end', 'fim', 'data_fim', 'termina', 'dtend'],
  value: ['value', 'valor', 'amount', 'preco'], notes: ['notes', 'obs', 'observacoes', 'observacao', 'nota'], expected: ['expected_on', 'previsto', 'previsao', 'recebimento_previsto'], paid: ['paid_at', 'recebido_em', 'pago_em', 'recebido'],
};
const normH = h => String(h || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_');
export function csvColumns(header) { const idx = {}; header.map(normH).forEach((h, i) => { for (const [k, names] of Object.entries(H)) if (names.includes(h) && idx[k] == null) idx[k] = i; }); return idx; }
/* data/hora de uma célula: ISO com offset (2026-10-22T07:00:00-03:00), ISO sem offset (= São Paulo), ou "22/10/2026 07:00" */
export function parseWhen(v) {
  v = String(v || '').trim(); if (!v) return null;
  let m = v.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?(?:\.\d+)?(Z|[+-]\d\d:?\d\d)?$/);
  if (m) {
    const [, y, mo, d, h, mi, , off] = m; if (!isTimeHM(`${h}:${mi}`)) return null; /* H2: 99:99 não entra */
    if (!off || off === `${OFFSET}`) { const k = `${y}-${mo}-${d}`; return isDateKey(k) ? `${k}T${h}:${mi}:00${OFFSET}` : null; }
    if (!isDateKey(`${y}-${mo}-${d}`)) return null; /* H2 (r4): 30/02 com offset não vira 2 de março */
    const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:00${off === 'Z' ? 'Z' : off.replace(/(\d\d)(\d\d)$/, '$1:$2')}`); return Number.isNaN(t) ? null : localIso(t);
  }
  m = v.match(/^(\d\d)\/(\d\d)\/(\d{4})[ T](\d\d):(\d\d)$/); if (m) { const k = `${m[3]}-${m[2]}-${m[1]}`; return isDateKey(k) && isTimeHM(`${m[4]}:${m[5]}`) ? `${k}T${m[4]}:${m[5]}:00${OFFSET}` : null; }
  return null;
}
/* H2: horário de parede num fuso IANA → instante UTC (ms); duas passagens resolvem a borda do horário de verão. null se o fuso for desconhecido. */
export function zonedToUtc(y, mo, d, h, mi, tz) {
  let fmt; try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { return null; }
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = ms => { const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms; };
  let guess = asUtc - offsetAt(asUtc); guess = asUtc - offsetAt(guess);
  const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map(x => [x.type, x.value])); /* M3 (r4): ida e volta tem de devolver a mesma parede */
  return +p.year === y && +p.month === mo && +p.day === d && +p.hour === h && +p.minute === mi ? guess : NaN;
}
/* instante (ms UTC) → texto ISO local com offset fixo */
export function localIso(ms) { const d = new Date(ms + OFFSET_MIN * 60000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00${OFFSET}`; }
export const CSV_HEADER = ['id', 'title', 'place', 'color', 'start_date', 'end_date', 'value', 'notes'];
export const CSV_HEADER_GANHOS = ['id', 'title', 'place', 'start_date', 'end_date', 'hours', 'value', 'expected_on', 'paid_at', 'status', 'rule'];
const PALETTE_HEX = { w1: '#34C759', w2: '#2FA4C0', w3: '#AF52DE', w4: '#FF9500', w5: '#E0395F', w6: '#007AFF', w7: '#FFCC00', w8: '#5856D6', w9: '#00C7BE', w10: '#A2845E' };
export function csvExport(data) {
  const P = Object.fromEntries(data.places.map(p => [p.id, p]));
  return csvStringify(sortedShifts(data.shifts).map(s => [s.id, s.title, P[s.place]?.name || '', PALETTE_HEX[P[s.place]?.color] || '', s.start, s.end, decimalTxt(s.amount_cents), s.note || '']), CSV_HEADER);
}
export function csvExportGanhos(data, today) {
  const P = Object.fromEntries(data.places.map(p => [p.id, p]));
  const status = s => s.paid_at ? 'recebido' : s.expected_on < today ? 'atrasado' : 'pendente';
  return csvStringify(sortedShifts(data.shifts).map(s => [s.id, s.title, P[s.place]?.name || '', s.start, s.end, (s.minutes / 60).toFixed(2), decimalTxt(s.amount_cents), s.expected_on, s.paid_at || '', status(s), P[s.place] ? ruleTxtFor(P[s.place].rule) : '']), CSV_HEADER_GANHOS);
}
const sortedShifts = shifts => [...shifts].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));

/* Prévia de importação CSV: cada linha vira válida (plantão pronto), inválida (motivo) ou duplicada (já existe). Locais inexistentes
   são listados em newPlaces (criados só com confirmação). ruleDate(placeId|null, name, k) calcula a previsão para locais novos pela regra padrão. */
export function csvPreview(text, data, opts) {
  let rows; try { rows = csvParse(text); } catch (e) { return { error: String(e.message || e), valid: [], invalid: [], dup: [], newPlaces: [] }; }
  if (rows.length < 2) return { error: 'planilha vazia ou sem cabeçalho', valid: [], invalid: [], dup: [], newPlaces: [] };
  if (rows.length - 1 > MAX_RECORDS) return { error: `planilha com mais de ${MAX_RECORDS} linhas — divida o arquivo`, valid: [], invalid: [], dup: [], newPlaces: [] };
  const col = csvColumns(rows[0]); const need = ['start', 'end', 'value'].filter(k => col[k] == null);
  if (need.length) return { error: `cabeçalho sem coluna: ${need.join(', ')}`, valid: [], invalid: [], dup: [], newPlaces: [], header: rows[0] };
  const byName = new Map(data.places.map(p => [normTitle(p.name), p])); const byShort = new Map(data.places.map(p => [normTitle(p.short), p]));
  const key3 = s => `${s.start}|${s.end}|${s.place}`, byKey3 = new Map(data.shifts.map(s => [key3(s), s])); /* identidade do plantão no CSV: início, fim e local */
  const invalid = [], parsed = [], newPlaces = new Map();
  rows.slice(1).forEach((r, i) => {
    const line = i + 2, cell = k => col[k] == null ? '' : (r[col[k]] ?? '').trim();
    const start = parseWhen(cell('start')), end = parseWhen(cell('end')), cents = parseDecimalCents(cell('value'));
    const placeName = unFormula(cell('place')) || (opts?.defaultPlaceName || ''), title = unFormula(cell('title')) || placeName || 'Plantão';
    if (!start) return invalid.push({ line, reason: `início inválido: "${cell('start')}"` });
    if (!end) return invalid.push({ line, reason: `fim inválido: "${cell('end')}"` });
    if (end <= start) return invalid.push({ line, reason: 'fim antes do início' });
    if (cents == null || cents < 0) return invalid.push({ line, reason: `valor inválido: "${cell('value')}"` });
    const paid = cell('paid'), ex = cell('expected'); /* m2: data fornecida e inválida invalida a linha (não é descartada em silêncio) */
    if (paid && !isDateKey(paid)) return invalid.push({ line, reason: `recebido em inválido: "${paid}"` });
    if (ex && !isDateKey(ex)) return invalid.push({ line, reason: `previsão inválida: "${ex}"` });
    /* R6: sem local é válido (place: null); nome que não existe vira local novo só com confirmação */
    const k = placeName ? normTitle(placeName) : null, place = k ? byName.get(k) || byShort.get(k) : null; let placeId = place?.id ?? null;
    if (k && !place) { if (!newPlaces.has(k)) newPlaces.set(k, { name: placeName, color: cell('color'), count: 0, tempId: `new:${k}` }); placeId = newPlaces.get(k).tempId; }
    parsed.push({ id: uid(), title, place: placeId, start, end, minutes: minutesOf(start, end), amount_cents: cents, note: unFormula(cell('notes')), paid_at: paid || null, expected_on: ex || null, line, newPlace: k && !place ? placeName : null });
  });
  return finishPreview(classifyGroups(parsed, key3, s => byKey3.get(key3(s)) || null, () => undefined), invalid, newPlaces, { header: rows[0], total: rows.length - 1 });
}

/* H1 (reformulação R4): UMA identidade por plantão. As linhas do arquivo são agrupadas por identidade ANTES de qualquer classificação
   e cada identidade produz exatamente um resultado — novo, idêntico (duplicado), conflito (um só, contra um só registro da base) ou
   inválido (linhas que se contradizem dentro do arquivo, todas citadas). Dentro do arquivo a comparação é SIMÉTRICA e independe da
   ordem (sameRow: valor inclusive zero, título, horário, local, observação inclusive vazia, previsão). Contra a base vale a política de
   mesclagem conflictChanges (valor zero / observação vazia = "não informado", não sobrescrevem). Recebimento nunca entra. Nenhum registro
   da base recebe mais de um resultado. */
const sameRow = (a, b) => safeCents(a.amount_cents) === safeCents(b.amount_cents) && normTitle(a.title) === normTitle(b.title) && a.start === b.start && a.end === b.end && a.place === b.place && (a.note || '') === (b.note || '') && (a.expected_on || null) === (b.expected_on || null);
function classifyGroups(parsed, identity, findBase, why) {
  const groups = new Map(); for (const s of parsed) { const k = identity(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
  const valid = [], invalid = [], dup = [], conflicts = [], used = new Map();
  for (const g of groups.values()) {
    const rep = g[0], rest = g.slice(1), lines = g.map(x => x.line);
    if (rest.some(o => !sameRow(rep, o))) { invalid.push({ line: rep.line, lines, reason: `linhas ${lines.join(', ')} descrevem o mesmo plantão (início, fim e local) com valor, título, observação ou previsão diferentes — corrija o arquivo` }); continue; }
    for (const o of rest) dup.push({ line: o.line, title: o.title, start: o.start, why: `repete a linha ${rep.line}` });
    const base = findBase(rep);
    if (base && used.has(base.id)) { invalid.push({ line: rep.line, lines, reason: `o mesmo plantão da base já é tratado pela linha ${used.get(base.id)}` }); continue; }
    if (base) { used.set(base.id, rep.line); const changes = conflictChanges(base, rep); if (changes.length) conflicts.push({ line: rep.line, title: rep.title, start: rep.start, existingId: base.id, changes, incoming: rep }); else dup.push({ line: rep.line, title: rep.title, start: rep.start, why: why(rep) }); continue; }
    valid.push(rep);
  }
  return { valid, invalid, dup, conflicts };
}
function finishPreview({ valid, invalid: inv2, dup, conflicts }, invalid, newPlaces, extra) {
  for (const np of newPlaces.values()) np.count = 0;
  for (const s of valid) if (s.newPlace) newPlaces.get(normTitle(s.newPlace)).count++; /* locais novos contam só o que vai entrar */
  return { valid, invalid: [...invalid, ...inv2].sort((a, b) => a.line - b.line), dup, conflicts, newPlaces: [...newPlaces.values()].filter(np => np.count > 0), ...extra };
}

/* diferenças materiais entre o plantão existente e o importado (valor, título, horário, local, observação) */
export function conflictChanges(ex, inc) {
  const ch = [];
  if (safeCents(inc.amount_cents) > 0 && inc.amount_cents !== ex.amount_cents) ch.push({ field: 'valor', from: ex.amount_cents, to: inc.amount_cents, money: true });
  if (normTitle(inc.title) !== normTitle(ex.title)) ch.push({ field: 'título', from: ex.title, to: inc.title });
  if (inc.start !== ex.start || inc.end !== ex.end) ch.push({ field: 'horário', from: `${ex.start.slice(11, 16)}–${ex.end.slice(11, 16)}`, to: `${inc.start.slice(11, 16)}–${inc.end.slice(11, 16)}` });
  if (inc.place && inc.place !== ex.place && !String(inc.place).startsWith('new:')) ch.push({ field: 'local', from: ex.place, to: inc.place });
  if (inc.note && inc.note !== (ex.note || '')) ch.push({ field: 'observação', from: ex.note || '', to: inc.note });
  return ch;
}
/* aplica um conflito escolhido como "substituir pelo arquivo": nunca toca em paid_at (recebimento é decisão local) */
export function applyConflict(ex, inc, now) {
  Object.assign(ex, { title: inc.title, start: inc.start, end: inc.end, minutes: inc.minutes, updated_at: now });
  if (safeCents(inc.amount_cents) > 0) ex.amount_cents = inc.amount_cents; if (inc.note) ex.note = inc.note; if (inc.place && !String(inc.place).startsWith('new:')) ex.place = inc.place; if (inc.expected_on) ex.expected_on = inc.expected_on; if (inc.ext_uid && !ex.ext_uid) ex.ext_uid = inc.ext_uid;
}
/* ---------- ICS ---------- */
const icsEsc = v => String(v ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsUnesc = v => String(v ?? '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
const fold = line => { const out = []; let cps = Array.from(line); while (byteLen(cps.join('')) > 75) { let cut = Math.min(cps.length, 75); while (byteLen(cps.slice(0, cut).join('')) > 75) cut--; out.push(cps.slice(0, cut).join('')); cps = [' ', ...cps.slice(cut)]; } out.push(cps.join('')); return out.join('\r\n'); }; /* M1: corta entre pontos de código */
const byteLen = s => new TextEncoder().encode(s).length;
export const isoToUtcStamp = iso => { const d = new Date(Date.parse(iso)); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`; };
/* opts.values: true = inclui valor, previsão e recebimento (DESCRIPTION + X-MP-*); false = agenda limpa (só horário, título, local e observação) */
export function icsExport(data, now = new Date(), opts = {}) {
  const values = opts.values !== false; const P = Object.fromEntries(data.places.map(p => [p.id, p])), stamp = isoToUtcStamp(now.toISOString());
  const ev = s => { const p = P[s.place]; const desc = (values ? [`Valor: ${brl(s.amount_cents)}`, `Previsto para ${dmy(s.expected_on)}`, s.paid_at ? `Recebido em ${dmy(s.paid_at)}` : 'Ainda não recebido'] : []).concat(s.note ? [`Obs.: ${s.note}`] : []).join('\n');
    return ['BEGIN:VEVENT', `UID:${s.id}@meus-plantoes`, `DTSTAMP:${stamp}`, `DTSTART:${isoToUtcStamp(s.start)}`, `DTEND:${isoToUtcStamp(s.end)}`, `SUMMARY:${icsEsc(`${s.title} · ${p?.short || ''}`.trim())}`, `LOCATION:${icsEsc(p?.name || '')}`, desc ? `DESCRIPTION:${icsEsc(desc)}` : null, values ? `X-MP-AMOUNT-CENTS:${s.amount_cents}` : null, `X-MP-PLACE:${icsEsc(p?.name || '')}`, values ? `X-MP-EXPECTED:${s.expected_on}` : null, values && s.paid_at ? `X-MP-PAID:${s.paid_at}` : null, 'END:VEVENT'].filter(Boolean).map(fold).join('\r\n'); };
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Meus Plantoes//PT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Meus Plantões', ...sortedShifts(data.shifts).map(ev), 'END:VCALENDAR'].join('\r\n') + '\r\n';
}
/* desdobra linhas, separa eventos; devolve [{props: {NAME: {params, value}}}] */
export function icsParse(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/), events = []; let cur = null;
  for (const raw of lines) {
    if (!raw.trim()) continue; if (/^BEGIN:VEVENT/i.test(raw)) { cur = { props: {} }; continue; } if (/^END:VEVENT/i.test(raw)) { if (cur) events.push(cur); cur = null; continue; } if (!cur) continue;
    const i = raw.indexOf(':'); if (i < 0) continue; const left = raw.slice(0, i), value = raw.slice(i + 1); const [name, ...ps] = left.split(';'); const params = {}; for (const p of ps) { const [k, v] = p.split('='); if (k) params[k.toUpperCase()] = (v || '').replace(/^"|"$/g, ''); }
    cur.props[name.toUpperCase()] = { params, value };
  }
  return events;
}
/* DTSTART/DTEND → ISO local; UTC (Z), TZID (qualquer: o instante é tratado como horário de parede de São Paulo, salvo offset conhecido), flutuante = São Paulo; VALUE=DATE = inválido */
export function icsWhen(prop) {
  if (!prop) return null; const v = prop.value.trim();
  if (prop.params.VALUE === 'DATE' || /^\d{8}$/.test(v)) return { allDay: true };
  const m = v.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)?(Z)?$/); if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m; if (!isDateKey(`${y}-${mo}-${d}`) || !isTimeHM(`${h}:${mi}`)) return null;
  if (z) return { iso: localIso(Date.UTC(+y, +mo - 1, +d, +h, +mi)) };
  const tz = prop.params.TZID; /* H2: TZID conhecido converte pelo fuso declarado; flutuante ou fuso desconhecido = São Paulo */
  if (tz && tz !== TZ) { const ms = zonedToUtc(+y, +mo, +d, +h, +mi, tz); if (Number.isNaN(ms)) return null; /* M3: horário inexistente no fuso declarado */ if (ms != null) return { iso: localIso(ms), tz }; return { iso: `${y}-${mo}-${d}T${h}:${mi}:00${OFFSET}`, tzUnknown: tz }; }
  return { iso: `${y}-${mo}-${d}T${h}:${mi}:00${OFFSET}` };
}
export function icsPreview(text, data) {
  const events = icsParse(text); if (!events.length) return { error: 'nenhum evento (VEVENT) no arquivo', valid: [], invalid: [], dup: [], newPlaces: [] };
  if (events.length > MAX_RECORDS) return { error: `agenda com mais de ${MAX_RECORDS} eventos — divida o arquivo`, valid: [], invalid: [], dup: [], newPlaces: [] };
  const byName = new Map(data.places.map(p => [normTitle(p.name), p])); const byShort = new Map(data.places.map(p => [normTitle(p.short), p]));
  const byIdMap = new Map(data.shifts.map(s => [s.id, s])), byExt = new Map(data.shifts.filter(s => s.ext_uid).map(s => [s.ext_uid, s])), byKey = new Map(data.shifts.map(s => [dupKeyIcs(s), s]));
  const invalid = [], parsed = [], newPlaces = new Map();
  events.forEach((e, i) => {
    const n = i + 1, g = k => e.props[k]?.value ? icsUnesc(e.props[k].value).trim() : '';
    const st = icsWhen(e.props.DTSTART), en = icsWhen(e.props.DTEND);
    if (!st || st.allDay) return invalid.push({ line: n, reason: st?.allDay ? 'evento de dia inteiro (sem horário)' : 'DTSTART ausente ou inválido' });
    if (!en || en.allDay) return invalid.push({ line: n, reason: 'DTEND ausente ou inválido' });
    if (en.iso <= st.iso) return invalid.push({ line: n, reason: 'fim antes do início' });
    const uidRaw = g('UID'), own = uidRaw.match(/^(.+)@meus-plantoes$/); const summary = g('SUMMARY') || 'Plantão';
    const placeName = g('X-MP-PLACE') || g('LOCATION') || (summary.includes(' · ') ? summary.split(' · ').pop() : '');
    const title = summary.includes(' · ') ? summary.split(' · ').slice(0, -1).join(' · ') : summary;
    const k = placeName ? normTitle(placeName) : null, place = k ? byName.get(k) || byShort.get(k) : null; let placeId = place?.id ?? null; /* R6: sem LOCATION = sem local */
    if (k && !place) { if (!newPlaces.has(k)) newPlaces.set(k, { name: placeName, count: 0, tempId: `new:${k}` }); placeId = newPlaces.get(k).tempId; }
    const centsRaw = g('X-MP-AMOUNT-CENTS'); const cents = /^\d{1,10}$/.test(centsRaw) ? (safeCents(+centsRaw) ?? 0) : 0; /* B1: inteiro seguro dentro do teto; fora disso = sem valor */
    parsed.push({ id: uid(), ext_uid: uidRaw || null, title, place: placeId, start: st.iso, end: en.iso, minutes: minutesOf(st.iso, en.iso), amount_cents: cents, note: cents || own ? '' : (g('DESCRIPTION') ? g('DESCRIPTION').slice(0, 200) : '') /* DESCRIPTION vira observação só em evento externo sem valor; o nosso já existe aqui */, paid_at: isDateKey(g('X-MP-PAID')) ? g('X-MP-PAID') : null, expected_on: isDateKey(g('X-MP-EXPECTED')) ? g('X-MP-EXPECTED') : null, line: n, newPlace: place ? null : placeName, noAmount: !cents, tzUnknown: st.tzUnknown || en.tzUnknown || null });
  });
  /* identidade (SPEC §3): UID nosso → id; UID externo → ext_uid; sem UID → chave normalizada sem valor */
  const ownOf = s => (s.ext_uid || '').match(/^(.+)@meus-plantoes$/);
  const identity = s => { const o = ownOf(s); return o ? 'i:' + o[1] : s.ext_uid ? 'u:' + s.ext_uid : 'k:' + dupKeyIcs(s); };
  const findBase = s => { const o = ownOf(s); return (o ? byIdMap.get(o[1]) : s.ext_uid ? byExt.get(s.ext_uid) : byKey.get(dupKeyIcs(s))) || null; };
  const why = s => ownOf(s) ? 'exportado por este app' : s.ext_uid ? 'mesmo UID' : 'mesmo horário, local e título';
  return finishPreview(classifyGroups(parsed, identity, findBase, why), invalid, newPlaces, { total: events.length });
}

/* ---------- backup JSON ---------- */
export function stableStringify(v) { if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'; if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'; return JSON.stringify(v === undefined ? null : v); }
export async function sha256Hex(text) { const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
export const counts = d => ({ places: d.places.length, templates: d.templates.length, series: d.series.length, shifts: d.shifts.length });
export async function backupMake(data, appVersion, now = new Date()) {
  const clean = structuredClone({ places: data.places, templates: data.templates, series: data.series, shifts: data.shifts }); /* R01-4: instantâneo síncrono antes do await — hash, contagens e dados descrevem o mesmo estado */
  return { schema_version: SCHEMA_VERSION, app: 'meus-plantoes', app_version: appVersion, exported_at: now.toISOString(), counts: counts(clean), sum_cents: clean.shifts.reduce((a, s) => a + s.amount_cents, 0), sha256: await sha256Hex(stableStringify(clean)), data: clean };
}
/* valida ANTES de qualquer gravação: schema, hash, contagens, soma, estrutura e referências; devolve {ok, errors, data} */
export async function backupVerify(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || obj.app !== 'meus-plantoes') errors.push('não é um backup do Meus Plantões');
  else {
    if (obj.schema_version !== SCHEMA_VERSION) errors.push(`versão do backup não suportada (${obj.schema_version}; esta versão do app lê ${SCHEMA_VERSION})`);
    if (typeof obj.exported_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(obj.exported_at)) errors.push('data de exportação ausente ou inválida'); /* N2 (r4): metadados com tipo validado aqui, antes de qualquer tela */
    if (typeof obj.app_version !== 'string' || !obj.app_version || obj.app_version.length > 40) errors.push('versão do app ausente ou inválida');
    if (!obj.data || typeof obj.data !== 'object') errors.push('backup sem dados');
    else {
      const h = await sha256Hex(stableStringify(obj.data)); if (h !== obj.sha256) errors.push('o conteúdo não bate com a assinatura (sha256) — arquivo alterado ou truncado');
      const c = counts({ places: obj.data.places || [], templates: obj.data.templates || [], series: obj.data.series || [], shifts: obj.data.shifts || [] });
      for (const k of Object.keys(c)) if (obj.counts?.[k] !== c[k]) errors.push(`contagem de ${k} diferente da declarada`);
      const sum = (obj.data.shifts || []).reduce((a, s) => a + (s.amount_cents || 0), 0); if (sum !== obj.sum_cents) errors.push('soma em centavos diferente da declarada');
      errors.push(...validateDataset(obj.data));
    }
  }
  return { ok: errors.length === 0, errors, data: errors.length ? null : obj.data };
}
export { validateDataset, dm, dmy, brl, isIsoLocal };
