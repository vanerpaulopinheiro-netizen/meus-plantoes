/* Meus Plantões — app (B1). Base: protótipo aprovado G2/G2.1 + F01/F02 (congelado em 23/10/2026): mesmos tokens, componentes,
   gestos e DOM contratual. Acrescenta persistência (IndexedDB, contrato de durabilidade), cadastros, recorrência com escopos,
   lixeira, portabilidade (CSV/ICS/JSON) e PWA. Interface em módulo único; regras puras em core.js; codecs em codecs.js. */
import { TZ, pad, WD, WDL, WDS, cap, addDays, dim, addMonths, dow, diffDays, dm, dmy, wdm, monthOf, dayLong, dayFull, hrs, toMin, pl, sum, esc, isDateKey, isTimeHM, todayKey, nowIso, uid, day, endDay, t0, t1, night, brl, centsTxt, parseCents, PALETTE, ruleDateFor, ruleTxtFor, validRule, cohortOf, overdueOf, occurrences, REP, seriesLabel, seriesFreq, freqTxt, scopeTargets, validateForm, repDates, mkShift as mkShiftCore } from './core.js';
import { openDB, readAll, readMeta, writeAll, createCommitter } from './store.js';
import { csvExport, csvExportGanhos, csvPreview, icsExport, icsPreview, backupMake, backupVerify, applyConflict } from './codecs.js';
import { APP_VERSION } from './version.js';

const Q = new URLSearchParams(location.search);
const TODAY_FIXED = isDateKey(Q.get('today')) ? Q.get('today') : null; /* testes: ?today=YYYY-MM-DD */
let TODAY = TODAY_FIXED || todayKey();
/* cor de cada local: um par claro/escuro da paleta do iOS (o app guarda a chave da paleta, não o hex) */
const PAL = { w1: ['#34C759', '#30D158'], w2: ['#2FA4C0', '#40C8E0'], w3: ['#AF52DE', '#BF5AF2'], w4: ['#FF9500', '#FF9F0A'], w5: ['#E0395F', '#FF375F'] };
const PAL_NAMES = { w1: 'Verde', w2: 'Azul-água', w3: 'Roxo', w4: 'Laranja', w5: 'Rosa' };
const DEFAULT_RULE = { kind: 'days_after', days: 30 };

/* ---------- tema ---------- */
const mq = window.matchMedia('(prefers-color-scheme: dark)');
const lsGet = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } };
const themePref = () => lsGet('mp-theme', 'system');
function applyTheme() { const p = themePref(); document.documentElement.dataset.theme = p === 'system' ? (mq.matches ? 'dark' : 'light') : p; }
const isDark = () => document.documentElement.dataset.theme === 'dark';
mq.addEventListener('change', () => { applyTheme(); if (S) render(false); });
applyTheme();
new MutationObserver(() => { if (themePref() !== 'system' && document.documentElement.dataset.theme !== themePref()) applyTheme(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- estado ---------- */
let S = null, db = null, committer = null;
const META_DEFAULT = () => ({ schema_version: 1, timezone: TZ, week_start: 0, last_backup_at: null, last_backup_sha256: null, sample_loaded: false, restore_undo: null, rev: 0 });
/* só os dados (coleções + meta), sem mexer no estado de tela — usado na abertura e ao recarregar o que outra aba gravou */
function applyRaw(raw) {
  const shifts = [...(raw.shifts || [])].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id)); /* getAll() devolve por id; a ordem útil é cronológica */
  S.places = Object.fromEntries((raw.places || []).map(p => [p.id, p])); S.templates = raw.templates || []; S.series = raw.series || [];
  S.shifts = shifts.filter(s => !s.deleted_at); S.trash = shifts.filter(s => !!s.deleted_at); S.meta = { ...META_DEFAULT(), ...((raw.meta || []).find(m => m.key === 'meta')?.value || {}) };
}
function hydrate(raw) {
  S = { view: 'cal', month: TODAY.slice(0, 7), sel: TODAY, pay: TODAY.slice(0, 7), cohort: 'cash', filter: 'all', showGot: false, calMode: lsGet('mp-cal', 'pontos'),
    seriesId: null, sheet: null, form: null, pform: null, tform: null, imp: null, toast: null, keep: false, flash: null, slide: 0, save: { state: 'saved' }, update: null };
  applyRaw(raw);
}
/* duas abas: recarrega o que a outra aba gravou e descarta o que esta aba não conseguiu gravar; o usuário refaz a última ação */
let reloading = false;
async function reloadFromOtherTab(reason) {
  if (!db || reloading) return; reloading = true;
  try { const raw = await readAll(db); applyRaw(raw); committer.resync(S.meta.rev || 0); S.sheet = null; S.form = S.form && S.view === 'form' ? S.form : null; S.toastPending = null; S.clearUndoAt = null;
    S.toast = { kind: 'conflict', msg: reason === 'conflict' ? 'Seus dados foram alterados em outra aba e recarregados aqui. Refaça a última ação.' : 'Dados atualizados a partir de outra aba.' }; render(false); }
  catch (e) { console.warn('recarga após outra aba falhou', e); } finally { reloading = false; }
}
async function checkOtherTab() { if (!db || !committer || committer.state !== 'saved') return; try { const m = await readMeta(db); if ((m?.rev || 0) > committer.savedRev) await reloadFromOtherTab('refresh'); } catch (e) { } }
const UNKNOWN_PLACE = { id: '?', name: '(local removido)', short: '?', color: 'w1', rule: DEFAULT_RULE, archived: true };
const P = id => S.places[id] || UNKNOWN_PLACE;
const places = () => Object.values(S.places).filter(p => !p.archived);
const templates = () => S.templates.filter(t => !t.archived);
const byId = id => S.shifts.find(s => s.id === id);
const seriesById = id => S.series.find(x => x.id === id);
const tplById = id => S.templates.find(t => t.id === id);
const tplOf = se => se.tpl || tplById(se.template) || { title: 'Plantão', place: Object.keys(S.places)[0], start: '07:00', end: '19:00', amount_cents: 0 };
const pc = id => `--pc:${(PAL[P(id).color] || PAL.w1)[isDark() ? 1 : 0]}`;
const pcKey = key => `--pc:${(PAL[key] || PAL.w1)[isDark() ? 1 : 0]}`;
const ruleDate = (pid, k) => ruleDateFor(P(pid).rule, k);
const ruleTxt = pid => ruleTxtFor(P(pid).rule);
const cohort = (ym, by) => cohortOf(S.shifts, ym, by);
const overdue = () => overdueOf(S.shifts, TODAY);
const mkShift = (f, k, first) => mkShiftCore(f, k, first, P(f.place).rule);
function selfCheck() { /* só com os dados de exemplo (que trazem os totais esperados) */
  const D = window.PLANTOES_SAMPLE; if (!S.meta.sample_loaded || !D?.expected) return [];
  const bad = [];
  for (const [ym, e] of Object.entries(D.expected.months)) for (const [by, key] of [['worked', 'worked_in_month'], ['cash', 'expected_in_month']]) { const t = cohort(ym, by); for (const f of ['count', 'minutes', 'total', 'received', 'pending']) if (t[f] !== e[key][f]) bad.push(`${ym} ${key}.${f}`); }
  if (sum(overdueOf(S.shifts, D.expected.today)) !== D.expected.overdue_cents) bad.push('atrasados');
  return bad;
}

/* ---------- persistência (contrato: nada diz "salvo" antes do transaction.complete) ---------- */
const snapshot = () => ({ places: Object.values(S.places), templates: S.templates, series: S.series, shifts: [...S.shifts, ...S.trash], meta: [{ key: 'meta', value: { ...S.meta, restore_undo: S.clearUndoAt ? null : S.meta.restore_undo } }] });
/* B2 (auditoria): nenhuma mensagem de sucesso aparece antes de a revisão estar durável; o instantâneo de desfazer a restauração só some depois da gravação seguinte confirmada */
function persist(keepRestoreUndo = false) {
  if (!keepRestoreUndo && S.meta.restore_undo && !S.clearUndoAt) S.clearUndoAt = (committer?.rev || 0) + 1;
  S.meta.updated_at = nowIso(); const c = committer?.commit(snapshot);
  if (S.toast && !S.toast.kind && c) { S.toastPending = { toast: S.toast, rev: c.rev }; S.toast = null; }
}
function onSaveState(st) {
  S.save = st; const el = document.getElementById('save-state'); if (el) el.outerHTML = saveCell();
  if (st.state === 'error') { S.toastPending = null; if (st.error?.name === 'ConflictError') { reloadFromOtherTab('conflict'); return; } if (!(S.toast && S.toast.kind === 'save')) { S.toast = { kind: 'save', msg: 'Não foi possível gravar no aparelho.', btn: { label: 'Tentar de novo', act: 'retry-save' } }; renderToast(); } return; }
  if (st.state === 'saved') {
    if (S.clearUndoAt && st.savedRev >= S.clearUndoAt) { S.meta.restore_undo = null; S.clearUndoAt = null; if (S.view === 'data') render(false); }
    if (S.toast?.kind === 'save') S.toast = null;
    if (S.toastPending && st.savedRev >= S.toastPending.rev) { S.toast = S.toastPending.toast; S.toastPending = null; }
    renderToast();
    if (S.reloadWhenSaved) { S.reloadWhenSaved = false; location.reload(); } /* N1: a atualização adiada conclui só com tudo gravado */
  }
}
function saveCell() {
  const st = S.save || { state: 'saved' }, t = st.state === 'saving' ? ['Gravando…', ''] : st.state === 'error' ? [`Não gravado${st.error ? ` (${esc(String(st.error.name || st.error.message || st.error)).slice(0, 60)})` : ''}`, 'late'] : ['Gravado neste aparelho', 'ok'];
  return `<div class="cell" id="save-state"><span class="k">Gravação</span><span class="v ${t[1]}">${t[0]}${st.state === 'error' ? ` <button class="textb" data-act="retry-save">Tentar de novo</button>` : ''}</span></div>`;
}

/* ---------- ícones ---------- */
const I = {
  cal: '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  wallet: '<path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h12a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z"/><path d="M15 12h5.5v4H15a2 2 0 0 1 0-4z"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', left: '<path d="M15 5l-7 7 7 7"/>', right: '<path d="M9 5l7 7-7 7"/>', chev: '<path d="M9 6l6 6-6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  rep: '<path d="M4 11V9a3 3 0 0 1 3-3h12M16 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H5M8 21l-3-3 3-3"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.01"/>', pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  note: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/>', lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  more: '<circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/>',
  trash: '<path d="M4.5 7h15M10 4h4M6.5 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5l1-12.5M10 11v6M14 11v6"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  down: '<path d="M5 9l7 7 7-7"/>', daycal: '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/><circle cx="16" cy="15" r="1.3" fill="currentColor"/>',
};
const ic = (n, s = 22, w = 1.8) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${I[n]}</svg>`;

/* ---------- T01 calendário ---------- */
const dayShifts = k => S.shifts.filter(s => day(s) === k).sort((a, b) => a.start.localeCompare(b.start));
const contShifts = k => S.shifts.filter(s => endDay(s) === k && day(s) < k && t1(s) !== '00:00');
function viewCal() {
  const ym = S.month, [y, m] = ym.split('-').map(Number), ws = S.meta.week_start ? 1 : 0, lead = (dow(ym + '-01') - ws + 7) % 7;
  let cells = [];
  for (let i = lead; i > 0; i--) cells.push(addDays(ym + '-01', -i));
  for (let d = 1; d <= dim(y, m); d++) cells.push(`${ym}-${pad(d)}`);
  while (cells.length < 42) cells.push(addDays(cells[cells.length - 1], 1));
  const wk = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB']; if (ws) wk.push(wk.shift());
  const empty = !S.shifts.length && !places().length;
  return `
  <header class="nav">
    <div class="l"><button class="pillb" data-act="today">Hoje</button><button class="srb" data-act="pmonth" aria-label="Mês anterior">‹</button></div>
    <h1 class="month" aria-live="polite">${monthOf(ym + '-01')} ${y}</h1>
    <div class="r"><button class="srb" data-act="nmonth" aria-label="Próximo mês">›</button><a class="circ" href="#/novo/${S.sel}" aria-label="Novo plantão em ${dm(S.sel)}">${ic('plus', 22, 2)}</a></div>
  </header>
  <div class="cal" data-calswipe>
    <div class="wk" aria-hidden="true">${wk.map(d => `<span>${d}</span>`).join('')}</div>
    <div class="grid${S.calMode === 'siglas' ? ' siglas' : ''}" role="group" aria-label="${monthOf(ym + '-01')} de ${y}">${cells.map(k => dayCell(k, k.startsWith(ym))).join('')}</div>
  </div>
  <div class="legend" aria-label="Locais">${places().map(p => `<span style="${pc(p.id)}" title="${esc(p.name)}"><i></i>${esc(p.short)}</span>`).join('')}</div>
  ${backupNotice()}${empty ? firstRun() : dayPanel(S.sel)}`;
}
/* F12: lembrete honesto de backup, em linha (nunca sobreposto ao conteúdo): só com dados e sem backup há mais de 7 dias */
function backupNotice() {
  if (!S.shifts.length) return ''; const lb = S.meta.last_backup_at, days = lb ? diffDays(lb.slice(0, 10), TODAY) : null; if (lb && days <= 7) return '';
  /* linha tocável de 44 px (alvo inteiro), no componente de lista aprovado; some por 7 dias após cada backup */
  return `<div class="gl" style="padding-bottom:0"><div class="group" style="margin-top:10px;background:var(--fill)"><a class="cell" href="#/dados"><span class="k" style="flex:1 1 auto;white-space:normal;font-size:15px">${ic('alert', 16, 2.2)} ${lb ? `Sem backup há ${days} dias.` : 'Você ainda não fez backup dos seus plantões.'}</span><span class="v" style="font-size:15px">Fazer backup ${ic('chev', 16, 2)}</span></a></div></div>`;
}
function firstRun() {
  return `<div class="gl"><section class="first" aria-labelledby="fr-t"><h2 id="fr-t">Seus plantões, só neste aparelho</h2>
    <p>Comece cadastrando um local (hospital, UPA, clínica) com a regra de recebimento; depois registre os plantões pelo "+". Também dá para importar uma planilha ou ver o app com dados de exemplo.</p>
    <div class="acts"><a class="btn p" href="#/local/novo" style="display:flex;align-items:center;justify-content:center">Cadastrar um local</a><a class="btn" href="#/dados" style="display:flex;align-items:center;justify-content:center">Importar planilha ou backup</a><button class="btn" data-act="sample">Carregar dados de exemplo</button></div></section></div>`;
}
function dayCell(k, inMonth) {
  const d = +k.slice(8, 10), list = inMonth ? dayShifts(k) : [];
  const dots = S.calMode === 'siglas'
    ? `</span><span class="sgs">${list.slice(0, 2).map(s => `<i style="${pc(s.place)}">${esc(P(s.place).short)}${night(s) ? ' ☾' : ''}</i>`).join('')}${list.length > 2 ? `<em>+${list.length - 2}</em>` : ''}<span hidden>`
    : list.slice(0, 3).map(s => `<i style="${pc(s.place)}"></i>`).join('') + (list.length > 3 ? '<em>+</em>' : '');
  const lab = `${dayLong(k)}${k === TODAY ? ', hoje' : ''}${inMonth ? `. ${list.length ? pl(list.length, 'plantão', 'plantões') + ': ' + list.map(s => `${P(s.place).short} ${s.title} às ${t0(s)}`).join('; ') : 'sem plantões'}` : ''}`;
  return `<button class="day${inMonth ? '' : ' other'}${k === TODAY ? ' today' : ''}${k === S.sel ? ' sel' : ''}" data-act="day" data-id="${k}" aria-pressed="${k === S.sel}"${k === TODAY ? ' aria-current="date"' : ''} aria-label="${esc(lab)}">
    <span class="n num">${d}</span><span class="dots">${dots}</span></button>`;
}
function status(s) {
  if (s.paid_at) return { k: 'ok', h: `${ic('check', 13, 2.4)} Recebido ${dm(s.paid_at)}` };
  if (!s.amount_cents) return { k: 'pend', h: `${ic('alert', 13, 2.2)} Valor a preencher` };
  if (s.expected_on < TODAY) return { k: 'late', h: `${ic('alert', 13, 2.2)} Atrasado` };
  return { k: 'pend', h: `${ic('clock', 13, 2)} ${s.expected_on === TODAY ? 'Cai hoje' : `Previsto ${dm(s.expected_on)}`}` };
}
function shiftRow(s, when) {
  const st = status(s), p = P(s.place);
  when ??= `<span class="num">${t0(s)}${night(s) ? ' → ' : ' – '}${t1(s)}</span><span>· ${hrs(s.minutes)}</span>${night(s) ? `<span class="mo">${ic('moon', 12, 2)} termina ${wdm(endDay(s))}</span>` : ''}`;
  /* I1: plano inferior com as ações (ocultas até o gesto descobrir) + superfície [data-swipe] que desliza por cima */
  return `<li data-shift="${s.id}" data-open="">${s.paid_at
    ? `<button class="act unpay" data-act="unpay" data-id="${s.id}">${ic('undo', 22, 2)}<span>Desfazer</span></button>`
    : `<button class="act pay" data-act="pay" data-id="${s.id}">${ic('check', 22, 2.4)}<span>Recebi</span></button>`}<button class="act rm" data-act="delete" data-id="${s.id}">${ic('trash', 22, 2)}<span>Apagar</span></button>
    <div class="sws" data-swipe><button class="row" data-act="open" data-id="${s.id}" style="${pc(s.place)}" aria-label="${esc(`${s.title}, ${p.name}, ${t0(s)} às ${t1(s)}${night(s) ? ' do dia seguinte' : ''}, ${brl(s.amount_cents)}`)}">
    <span class="bar"></span>
    <span class="info"><span class="when">${when}</span><span class="ttl">${esc(s.title)}</span><span class="where"><span class="sg">${esc(p.short)}</span> · ${esc(p.name)}</span></span>
    <span class="right"><span class="amt">${brl(s.amount_cents)}</span><span class="st ${st.k}">${st.h}</span></span>
    <span class="chev">${ic('chev', 16, 2)}</span></button><button class="mbtn" data-act="more" data-id="${s.id}" aria-haspopup="dialog" aria-label="${esc(`Mais ações de ${s.title}, ${p.name}, ${dm(day(s))}`)}">${ic('more', 22)}</button></div></li>`;
}
function dayPanel(k) {
  const list = dayShifts(k), conts = contShifts(k), mins = list.reduce((a, s) => a + s.minutes, 0);
  const sub = list.length ? `${pl(list.length, 'plantão', 'plantões')} · ${hrs(mins)} · ${brl(sum(list))}` : '';
  return `<section aria-labelledby="dh">
    <div class="dayhead"><h2 id="dh" tabindex="-1">${dayLong(k)}</h2><span class="sub num">${sub}</span></div>
    ${conts.map(s => `<p class="note" style="padding:0 20px 4px">${ic('moon', 12, 2)} Madrugada de ${esc(s.title)} (${esc(P(s.place).short)}) até ${t1(s)} — conta em ${dm(day(s))}.</p>`).join('')}
    ${list.length ? `<ul class="rows">${list.map(s => shiftRow(s)).join('')}</ul>` : `<p class="empty">Nenhum plantão neste dia.</p>`}
  </section>`;
}

/* ---------- T02 detalhes ---------- */
function viewDetail(id) {
  const s = byId(id); if (!s) return `<header class="nav"><div class="l"><a class="circ" href="#/calendario" aria-label="Voltar">${ic('left')}</a></div><h1>Plantão</h1><div class="r"></div></header><p class="empty">Plantão não encontrado.</p>`;
  const p = P(s.place), se = s.series && seriesById(s.series), byRule = s.expected_on === ruleDate(s.place, day(s));
  const sit = s.paid_at ? `<span class="v ok">Recebido em ${dmy(s.paid_at)}</span>` : s.expected_on < TODAY ? `<span class="v late">Atrasado há ${pl(diffDays(s.expected_on, TODAY), 'dia', 'dias')}</span>`
    : `<span class="v">${diffDays(TODAY, s.expected_on) === 0 ? 'Cai hoje' : `Previsto · faltam ${pl(diffDays(TODAY, s.expected_on), 'dia', 'dias')}`}</span>`;
  return `
  <header class="nav">
    <div class="l"><a class="circ" href="#/calendario/${day(s)}" aria-label="Voltar ao calendário">${ic('left')}</a></div>
    <h1>Detalhes do plantão</h1>
    <div class="r"><a class="pillb" href="#/editar/${s.id}">Editar</a></div>
  </header>
  <article class="detail" style="${pc(s.place)}">
    <div class="hd"><span class="bar"></span><h1>${esc(s.title)}</h1></div>
    <div class="meta">
      <span class="d">${ic('daycal', 20)} <span>${dayFull(day(s))}</span></span>
      <span class="num">${t0(s)} ${night(s) ? '→' : '–'} ${t1(s)}${night(s) ? ` · termina ${WD[dow(endDay(s))]}, ${dmy(endDay(s))}` : ''}</span>
      <span>${hrs(s.minutes)}${night(s) ? ' · vira a madrugada' : ''}</span>
      <span class="note">Conta como trabalho de ${monthOf(day(s))}${night(s) ? ' (dia do início)' : ''}.</span>
    </div>
    <div class="sect"><div class="kv"><span class="k">${ic('pin', 20)} ${esc(p.name)}</span><span class="v tagp"><span class="dot"></span>${esc(p.short)}</span></div></div>
    <div class="sect">
      <div class="kv"><span class="k">Valor</span><span class="v strong num">${s.amount_cents ? brl(s.amount_cents) : '<span class="late">a preencher</span>'}</span></div>
      <div class="kv"><span class="k">Previsão de recebimento</span><span class="v num">${WD[dow(s.expected_on)]}, ${dmy(s.expected_on)}</span></div>
      <p class="note">${byRule ? `Regra de ${esc(p.name)}: ${ruleTxt(s.place)}.` : 'Previsão ajustada só neste plantão.'} Entra em “cai em ${monthOf(s.expected_on)}”.</p>
      <div class="kv"><span class="k">Situação</span>${sit}</div>
    </div>
    <div class="sect">
      <div class="kv"><span class="k">Marcar como recebido</span><button class="sw" role="switch" aria-checked="${!!s.paid_at}" data-act="${s.paid_at ? 'unpay' : 'pay'}" data-id="${s.id}" aria-label="Marcar como recebido"></button></div>
      ${s.paid_at ? `<div class="kv"><span class="k">Recebido em</span><input class="datein num" type="date" value="${s.paid_at}" data-paid="${s.id}" aria-label="Data em que recebeu"></div>` : ''}
    </div>
    ${se ? `<div class="sect"><a class="kv" href="#/serie/${se.id}" style="color:inherit"><span class="k">${ic('rep', 20)} Repete ${esc(se.label.toLowerCase())}</span><span class="v">até ${dm(se.until)} ${ic('chev', 16, 2)}</span></a></div>` : ''}
    ${s.ext_uid ? `<div class="sect"><div class="kv"><span class="k">${ic('daycal', 20)} Importado de agenda</span><span class="v wrap" style="font-size:13px">${esc(s.ext_uid).slice(0, 40)}</span></div></div>` : ''}
    <div class="sect"><div class="kv" style="min-height:32px"><span class="k">${ic('note', 20)} Observações</span></div><p class="obs">${s.note ? esc(s.note) : '<span style="color:var(--label3)">Nenhuma</span>'}</p></div>
    <button class="del" data-act="delete" data-id="${s.id}">Apagar plantão</button>
  </article>`;
}

/* ---------- T03 formulário de plantão ---------- */
const newForm = (date, tplId) => { const t = tplId && tplById(tplId); return { editId: null, date, title: t ? t.title : '', place: t ? t.place : (places().length === 1 ? places()[0].id : ''), start: t ? t.start : '', end: t ? t.end : '', amount: t ? centsTxt(t.amount_cents) : '', expected: '', expOverride: false, paid: false, paidAt: TODAY, repeat: 'none', until: '', note: '', tpl: tplId || '' }; };
const formFrom = s => ({ editId: s.id, date: day(s), title: s.title, place: s.place, start: t0(s), end: t1(s), amount: s.amount_cents ? centsTxt(s.amount_cents) : '', expected: s.expected_on, expOverride: s.expected_on !== ruleDate(s.place, day(s)), paid: !!s.paid_at, paidAt: s.paid_at || TODAY, repeat: 'none', until: '', note: s.note || '', tpl: '' });
const validate = f => { const e = validateForm(f); if (f.place && !S.places[f.place]) e.place = 'local'; return e; };
function viewForm() {
  const f = S.form, ed = !!f.editId, e = validate(f), ok = !Object.keys(e).length;
  const exp = f.place && f.date && S.places[f.place] ? (f.expOverride ? f.expected : ruleDate(f.place, f.date)) : '';
  const [stCls, stHtml] = fragStatus(f); const tp = templates(); const opts = places().concat(f.place && S.places[f.place]?.archived ? [S.places[f.place]] : []);
  return `
  <header class="nav">
    <div class="l"><a class="textb" href="${ed ? '#/plantao/' + f.editId : '#/calendario/' + f.date}">Cancelar</a></div>
    <h1>${ed ? 'Editar plantão' : 'Novo plantão'}</h1>
    <div class="r"><button class="textb b" data-act="save"${ok ? '' : ' aria-disabled="true"'}>Salvar</button></div>
  </header>
  <form id="f" class="gl" novalidate>
    ${ed || !tp.length ? '' : `<div class="ghead">Começar por um modelo</div><div class="chips">${tp.map(t => `<button type="button" class="chip" data-act="tpl" data-id="${t.id}" aria-pressed="${f.tpl === t.id}" style="${pc(t.place)}"><i></i>${esc(t.title)}</button>`).join('')}</div>`}
    <div class="ghead">Plantão</div>
    <div class="group">
      <label class="cell plain"><input name="title" value="${esc(f.title)}" placeholder="Título do plantão" autocomplete="off" aria-label="Título"></label>
      <label class="cell"><span class="k">Local</span><span class="v"><span class="dot" id="f-dot" style="${f.place && S.places[f.place] ? pc(f.place) : 'display:none'}"></span><select name="place"><option value="">Escolher</option>${opts.map(p => `<option value="${p.id}"${f.place === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></span></label>
    </div>
    <p class="gfoot">${opts.length ? 'A cor e a regra de recebimento vêm do local.' : `Nenhum local cadastrado ainda. <a href="#/local/novo">Cadastrar um local</a>`}</p>
    <div class="group">
      <label class="cell"><span class="k">Data</span><input class="num" type="date" name="date" value="${f.date}"></label>
      <label class="cell"><span class="k">Começa</span><input class="num" type="time" name="start" value="${f.start}"></label>
      <label class="cell"><span class="k">Termina</span><input class="num" type="time" name="end" value="${f.end}"></label>
    </div>
    <div id="f-night" style="display:contents">${fragNight(f)}</div>
    <div class="group">
      <label class="cell"><span class="k">Valor</span><span class="v" style="gap:4px"><span>R$</span><input name="amount" inputmode="decimal" placeholder="0,00" value="${esc(f.amount)}" style="width:110px"></span></label>
      <label class="cell"><span class="k">Previsto para</span><input class="num" type="date" name="expected" value="${exp}"${f.place && f.date ? '' : ' disabled'}></label>
    </div>
    <p class="gfoot" id="f-exp">${fragExp(f)}</p>
    <div class="group">
      <div class="cell"><span class="k">Já recebido</span><button type="button" class="sw" role="switch" aria-checked="${f.paid}" data-act="fpaid" aria-label="Já recebido" style="margin-left:auto"></button></div>
      ${f.paid ? `<label class="cell"><span class="k">Recebido em</span><input class="num" type="date" name="paidAt" value="${f.paidAt}"></label>` : ''}
    </div>
    ${ed ? '' : `<div class="group">
      <label class="cell"><span class="k">Repetir</span><select name="repeat">${Object.entries(REP).map(([v, t]) => `<option value="${v}"${f.repeat === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <div id="f-until" style="display:contents">${fragUntil(f)}</div>
    </div>
    <div id="f-rep" style="display:contents">${fragRep(f)}</div>`}
    <div class="group"><label class="cell col"><span class="k">Observações</span><textarea name="note" rows="2" placeholder="Opcional — sem dados de pacientes">${esc(f.note)}</textarea></label></div>
    <p id="f-status" class="status-line ${stCls}" aria-live="polite">${stHtml}</p>
  </form>`;
}
/* F01: trechos do formulário que mudam com a edição, atualizados no lugar — nenhum re-render destrói o campo ativo nem o botão tocado */
function fragNight(f) {
  if (!(isTimeHM(f.start) && isTimeHM(f.end) && f.start !== f.end)) return '';
  return toMin(f.end) <= toMin(f.start)
    ? `<p class="gfoot night">${ic('moon', 12, 2)} Termina no dia seguinte${isDateKey(f.date) ? ` (${wdm(addDays(f.date, 1))})` : ''} às ${f.end} · ${hrs(toMin(f.end) - toMin(f.start) + 1440)} · conta como trabalho de ${isDateKey(f.date) ? dm(f.date) : 'hoje'}.</p>`
    : `<p class="gfoot">${hrs(toMin(f.end) - toMin(f.start))} · termina no mesmo dia.</p>`;
}
function fragExp(f) { const p = f.place && S.places[f.place]; return p ? (f.expOverride ? `Pela regra de ${esc(p.name)} seria ${isDateKey(f.date) ? dmy(ruleDate(f.place, f.date)) : '—'}. Alterar aqui vale só para este plantão.` : `Regra de ${esc(p.name)}: ${ruleTxt(f.place)}. Alterar aqui vale só para este plantão.`) : 'Escolha o local para calcular a previsão.'; }
function fragUntil(f) { return f.repeat !== 'none' ? `<label class="cell"><span class="k">Até</span><input class="num" type="date" name="until" value="${f.until}"></label>` : ''; }
function fragRep(f) { if (!(f.repeat !== 'none' && isDateKey(f.until) && isDateKey(f.date) && f.until >= f.date)) return ''; const ds = repDates(f); return `<p class="gfoot">${pl(ds.length, 'plantão', 'plantões')}: ${ds.slice(0, 4).map(dm).join(', ')}${ds.length > 4 ? ` … ${dm(ds[ds.length - 1])}` : ''}.</p>`; }
function fragStatus(f) { const e = validate(f), ok = !Object.keys(e).length; return [ok ? 'ok' : 'warn', ok ? `${ic('check', 14, 2.4)} Pronto para salvar` : `${ic('alert', 14, 2.2)} Falta: ${Object.values(e).join(', ')}`]; }
function refreshForm() {
  const f = S.form, form = document.getElementById('f'); if (!f || !form) return;
  const set = (id, html) => { const el = document.getElementById(id); if (el && el.innerHTML !== html) el.innerHTML = html; };
  set('f-night', fragNight(f)); set('f-exp', fragExp(f)); set('f-rep', fragRep(f));
  if (!!form.querySelector('[name="until"]') !== (f.repeat !== 'none')) set('f-until', fragUntil(f));
  const dot = document.getElementById('f-dot'); if (dot) dot.style.cssText = f.place && S.places[f.place] ? pc(f.place) : 'display:none';
  const ex = form.querySelector('[name="expected"]'); if (ex && document.activeElement !== ex) { ex.disabled = !(f.place && isDateKey(f.date) && S.places[f.place]); const v = f.place && isDateKey(f.date) && S.places[f.place] ? (f.expOverride ? f.expected : ruleDate(f.place, f.date)) : ''; if (ex.value !== v) ex.value = v; }
  const [cls, html] = fragStatus(f), st = document.getElementById('f-status'); if (st) { st.className = 'status-line ' + cls; st.innerHTML = html; }
  const sv = document.querySelector('[data-act="save"]'); if (sv) { if (cls === 'ok') sv.removeAttribute('aria-disabled'); else sv.setAttribute('aria-disabled', 'true'); }
  for (const el of form.querySelectorAll('[aria-invalid]')) if ((el.value || '').trim()) el.removeAttribute('aria-invalid');
}
const firstMissing = (f, errs) => ({ title: 'title', place: 'place', date: 'date', time: f.start ? 'end' : 'start', amount: 'amount', expected: 'expected', paidAt: 'paidAt', until: 'until' })[Object.keys(errs)[0]];
function readForm() {
  const el = document.getElementById('f'); if (!el) return S.form;
  const fd = new FormData(el), f = S.form;
  for (const k of ['title', 'place', 'date', 'start', 'end', 'amount', 'expected', 'paidAt', 'repeat', 'until', 'note']) if (fd.has(k)) f[k] = fd.get(k);
  if (fd.has('expected') && f.place && isDateKey(f.date) && S.places[f.place]) f.expOverride = f.expected !== ruleDate(f.place, f.date) && !!f.expected;
  return f;
}
function submitForm() {
  const f = readForm(), errs = validate(f);
  if (Object.keys(errs).length) {
    refreshForm(); S.toast = { msg: `Ainda falta: ${Object.values(errs).join(', ')}.` }; renderToast();
    const el = document.querySelector(`#f [name="${firstMissing(f, errs)}"]`); if (el) { el.setAttribute('aria-invalid', 'true'); el.scrollIntoView({ block: 'center' }); el.focus({ preventScroll: true }); }
    return;
  }
  if (f.editId) {
    const s = byId(f.editId), before = JSON.stringify(s), se = s.series && seriesById(s.series), ovBefore = se ? JSON.stringify(se.overrides) : null;
    Object.assign(s, mkShift(f, f.date, true), { updated_at: nowIso() });
    if (se) se.overrides = { ...se.overrides, [day(s)]: { start: t0(s), end: t1(s) } }; /* H1 (r2): toda edição individual de ocorrência vira exceção visível na série (título, valor, local, previsão ou horário) */
    S.toast = { msg: `${esc(s.title)} atualizado.`, undo: () => { Object.assign(s, JSON.parse(before)); if (se) se.overrides = JSON.parse(ovBefore); } }; S.form = null; persist(); go('#/plantao/' + s.id); return;
  }
  let se = null;
  if (f.repeat !== 'none') {
    const { freq, interval } = seriesFreq(f.repeat);
    se = { id: uid(), tpl: { title: f.title.trim(), place: f.place, start: f.start, end: f.end, amount_cents: parseCents(f.amount) }, freq, interval, starts_on: f.date, until: f.until, label: seriesLabel(f.repeat, f.date), exdates: [], overrides: {}, created_at: nowIso() };
    S.series.push(se);
  }
  const made = repDates(f).map((k, i) => ({ id: uid(), template: f.tpl || null, series: se ? se.id : null, ...mkShift(f, k, i === 0), updated_at: nowIso() }));
  S.shifts.push(...made); const ids = new Set(made.map(s => s.id));
  S.toast = { msg: made.length > 1 ? `${pl(made.length, 'plantão criado', 'plantões criados')} (${esc(se.label)}).` : `${esc(made[0].title)} salvo em ${dm(f.date)}.`, undo: () => { S.shifts = S.shifts.filter(s => !ids.has(s.id)); if (se) S.series = S.series.filter(x => x !== se); } };
  S.month = f.date.slice(0, 7); S.sel = f.date; S.form = null; S.flash = made[0].id; persist(); go('#/calendario/' + f.date); /* volta ao dia com a linha nova em destaque */
}

/* ---------- T04 recorrência ---------- */
function viewSeriesList() {
  const rows = S.series.map(se => ({ se, tp: tplOf(se), n: S.shifts.filter(x => x.series === se.id).length })).sort((a, b) => b.se.until.localeCompare(a.se.until));
  return `<header class="nav"><div class="l"><a class="circ" href="#/ajustes" aria-label="Voltar">${ic('left')}</a></div><h1>Recorrências</h1><div class="r"></div></header>
  <div class="gl">${rows.length ? `<div class="group" style="margin-top:12px">${rows.map(({ se, tp, n }) => `<a class="cell" href="#/serie/${se.id}" style="${pc(tp.place)}"><span class="k"><span class="dot"></span><span>${esc(tp.title)}<br><small style="color:var(--label2);font-size:13px">${esc(se.label)} · até ${dmy(se.until)} · ${pl(n, 'plantão', 'plantões')}</small></span></span><span class="v">${ic('chev', 16, 2)}</span></a>`).join('')}</div>` : '<p class="empty">Nenhuma recorrência. Ao criar um plantão, escolha “Repetir”.</p>'}
  <p class="gfoot">Uma recorrência gera os plantões de uma vez; cada um pode ser editado, recebido ou apagado sozinho.</p></div>`;
}
function viewSeries() {
  const se = seriesById(S.seriesId); if (!se) return `<header class="nav"><div class="l"><a class="circ" href="#/recorrencias" aria-label="Voltar">${ic('left')}</a></div><h1>Recorrência</h1><div class="r"></div></header><p class="empty">Série não encontrada.</p>`;
  const tp = tplOf(se), rows = occurrences(se.freq, se.interval, se.starts_on, se.until).map(k => ({ k, s: S.shifts.find(x => x.series === se.id && day(x) === k), ed: !!se.overrides[k] })).map(r => ({ ...r, skip: !r.s }));
  const next = rows.find(r => r.k >= TODAY && !r.skip), cur = TODAY.slice(0, 7), fut = rows.filter(r => r.k.slice(0, 7) >= cur), past = rows.filter(r => r.k.slice(0, 7) < cur);
  const months = [...new Set(fut.map(r => r.k.slice(0, 7)))].slice(0, 3), n = rows.filter(r => !r.skip).length;
  const occ = r => r.skip ? `<div class="occ skip"><span class="d num">${wdm(r.k)}</span><span class="t">${tp.start}–${tp.end} · pulado</span><button class="textb" data-act="restore" data-id="${r.k}">Restaurar</button></div>`
    : `<button class="occ" data-act="occ" data-id="${r.k}"><span class="d num${r.k < TODAY ? ' past' : ''}">${wdm(r.k)}</span><span class="t num"><b>${t0(r.s)}–${t1(r.s)}</b>${r.s.paid_at ? '' : ` · cai ${dm(r.s.expected_on)}`}</span><span>${r.s.paid_at ? `<span class="tag ok">recebido</span>` : r.ed ? `<span class="tag">editado</span>` : next && r.k === next.k ? `<span class="tag">próximo</span>` : ''}</span></button>`;
  return `
  <header class="nav"><div class="l"><a class="circ" href="#/recorrencias" aria-label="Voltar">${ic('left')}</a></div><h1>Recorrência</h1><div class="r"></div></header>
  <div class="series-hd" style="${pc(tp.place)}"><span class="bar"></span><div><h1>${esc(tp.title)}</h1><p class="num">${esc(se.label)} · ${tp.start}–${tp.end} · ${brl(tp.amount_cents)}</p></div></div>
  <div class="gl">
    <div class="group" style="margin-top:16px">
      <div class="cell"><span class="k">Local</span><span class="v"><span class="dot" style="${pc(tp.place)}"></span>${esc(P(tp.place).short)} · ${esc(P(tp.place).name)}</span></div>
      <div class="cell"><span class="k">Repete</span><span class="v">${freqTxt(se)}</span></div>
      <div class="cell"><span class="k">Até</span><span class="v num">${dmy(se.until)}</span></div>
      <div class="cell"><span class="k">Recebimento</span><span class="v">${ruleTxt(tp.place)}</span></div>
    </div>
    <p class="gfoot">${pl(n, 'plantão', 'plantões')} · ${pl(rows.filter(r => r.skip).length, 'pulado', 'pulados')} · ${pl(Object.keys(se.overrides).length, 'editado só nessa data', 'editados só nessas datas')}. Toque em uma data para editar; para apagar, use o gesto ou o “⋯” na lista do dia (escopos: só este, este e os próximos, toda a série).</p>
  </div>
  ${months.map(ym => `<div class="mlabel">${monthOf(ym + '-01')}</div>${fut.filter(r => r.k.startsWith(ym)).map(occ).join('')}`).join('')}
  ${past.length ? `<div class="mlabel">anteriores · ${pl(past.filter(r => !r.skip).length, 'plantão', 'plantões')}</div>` : ''}
  ${S.sheet ? scopeSheet(se) : ''}`;
}
function scopeSheet(se) {
  const { occ, scope } = S.sheet, s = S.shifts.find(x => x.series === se.id && day(x) === occ), tp = tplOf(se); if (!s) return '';
  const all = S.shifts.filter(x => x.series === se.id), fol = all.filter(x => day(x) >= occ && !x.paid_at), nAll = all.filter(x => !x.paid_at).length, paid = all.length - nAll;
  const opt = (v, t, d, dis) => `<label class="radio${dis ? ' dis' : ''}"><input type="radio" name="scope" value="${v}"${scope === v ? ' checked' : ''}${dis ? ' disabled' : ''}><span><b>${t}</b><small>${d}</small></span></label>`;
  return `<div class="dim" data-act="sheetx"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t">
    <div class="handle"></div>
    <h2 id="sh-t">Editar ${wdm(occ)}</h2><p class="sub">${esc(tp.title)} · ${esc(P(tp.place).short)}${se.overrides[occ] ? ' · já editado só nesta data' : ''}</p>
    <div class="three"><label>Início<input class="num" type="time" id="sc-start" value="${t0(s)}"></label><label>Fim<input class="num" type="time" id="sc-end" value="${t1(s)}"></label><label>Valor<input class="num" id="sc-amt" inputmode="decimal" value="${centsTxt(s.amount_cents)}"></label></div>
    <div class="ghead" style="padding-left:0">Aplicar a</div>
    ${opt('one', 'Só este', s.paid_at ? 'Já recebido — desfaça o recebimento para editar.' : `${dm(occ)} · 1 plantão. O resto da série não muda.`, !!s.paid_at)}
    ${opt('following', 'Este e os próximos', `${dm(occ)} → ${dm(se.until)} · ${pl(fol.length, 'plantão', 'plantões')}. Os anteriores ficam como estão.`)}
    ${opt('all', 'Toda a série', `${pl(nAll, 'plantão não recebido', 'plantões não recebidos')}, inclusive os já trabalhados.`)}
    <p class="lock">${ic('lock', 14, 2)} Plantões recebidos nunca mudam nem somem (${paid} nesta série). Datas puladas continuam puladas.</p>
    <div class="acts"><button class="btn" data-act="sheetx">Cancelar</button><button class="btn p" data-act="applyScope">Aplicar</button></div>
  </div>`;
}

/* ---------- T05 pagamentos ---------- */
function viewPay() {
  const ym = S.pay, mon = monthOf(ym + '-01'), y = ym.slice(0, 4), c = cohort(ym, S.cohort), od = overdue();
  const pct = c.total ? Math.round(c.received / c.total * 100) : 0, cash = S.cohort === 'cash';
  const up = c.list.filter(s => !s.paid_at && !(s.expected_on < TODAY) && (S.filter === 'all' || s.place === S.filter)).sort((a, b) => (cash ? a.expected_on.localeCompare(b.expected_on) : a.start.localeCompare(b.start)));
  const got = c.list.filter(s => s.paid_at && (S.filter === 'all' || s.place === S.filter)).sort((a, b) => a.paid_at.localeCompare(b.paid_at));
  const lateIn = od.filter(s => S.filter === 'all' || s.place === S.filter);
  const paidIn = cohortOf(S.shifts, ym, 'paid');
  const fplaces = places().concat(Object.keys(c.byPlace).filter(id => S.places[id]?.archived).map(id => S.places[id]));
  return `
  <div class="lt"><h1>Pagamentos</h1></div>
  <div class="pg">
    <div class="mon"><button class="circ" data-act="pprev" aria-label="Mês anterior">${ic('left', 20, 2)}</button><h2>${cap(mon)} ${y}</h2><button class="circ" data-act="pnext" aria-label="Próximo mês">${ic('right', 20, 2)}</button></div>
    <div class="seg" role="group" aria-label="Recorte do mês"><button data-act="cohort" data-id="cash" aria-pressed="${cash}">Cai no mês</button><button data-act="cohort" data-id="worked" aria-pressed="${!cash}">Trabalhado</button></div>
    <section class="hero" aria-live="polite">
      <div class="lab">${cash ? `Cai em ${mon}` : `Trabalhado em ${mon}`}</div>
      <div class="big">${brl(c.total)}</div>
      <div class="cap num">${pl(c.count, 'plantão', 'plantões')}${cash ? ' · pela previsão de recebimento' : ` · ${hrs(c.minutes)} · pelo dia de início`}</div>
      <div class="split"><div class="ok">Recebido<b>${brl(c.received)}</b></div><div>${cash ? 'Pendente' : 'A receber'}<b>${brl(c.pending)}</b></div></div>
      <div class="bar2" role="img" aria-label="${pct}% recebido"><i style="width:${pct}%"></i></div>
      <p class="note" style="margin-top:10px">Caixa de ${mon}: ${brl(paidIn.total)} efetivamente recebidos (${pl(paidIn.count, 'plantão', 'plantões')}), pela data do recebimento.</p>
    </section>
    ${lateIn.length ? `<div class="late-box"><span class="ic">!</span><span><b>${pl(lateIn.length, 'recebimento atrasado', 'recebimentos atrasados')}</b><small class="num">${brl(sum(lateIn))} · ${esc(lateIn[0].title)} · ${esc(P(lateIn[0].place).short)} · previsto ${dm(lateIn[0].expected_on)}${lateIn.length > 1 ? ' e outros' : ''}</small></span><button class="textb" data-act="pay" data-id="${lateIn[0].id}">Recebi</button></div>` : ''}
    <div class="chips" style="margin-top:14px"><button class="chip s" data-act="filter" data-id="all" aria-pressed="${S.filter === 'all'}">Todos os locais</button>${fplaces.map(p => `<button class="chip s" data-act="filter" data-id="${p.id}" aria-pressed="${S.filter === p.id}" style="${pc(p.id)}"><i></i>${esc(p.short)}</button>`).join('')}</div>
    <section class="sec"><h2>${cash ? 'Próximos a cair' : 'A receber'} <span class="num">${brl(sum(up))}</span></h2>
      ${up.length ? `<ul class="rows">${up.map(s => shiftRow(s, cash ? `<span class="num">cai ${wdm(s.expected_on)}</span><span>· trabalhado ${dm(day(s))}</span>` : undefined)).join('')}</ul>` : `<p class="empty" style="padding-left:0">Nada pendente em ${mon}.</p>`}
      ${got.length ? `<button class="more" data-act="got">${S.showGot ? ic('down', 14, 2) : ic('chev', 14, 2)} Já recebidos ${cash ? `que caíam em ${mon}` : `de ${mon}`} (${got.length}) · ${brl(sum(got))}</button>${S.showGot ? `<ul class="rows">${got.map(s => shiftRow(s, `<span class="num">recebido ${wdm(s.paid_at)}</span><span>· previsto ${dm(s.expected_on)}</span>`)).join('')}</ul>` : ''}` : ''}
    </section>
    <section class="sec"><h2>Por local <span>${cash ? `cai em ${mon}` : `trabalhado em ${mon}`}</span></h2>
      <ul class="rows">${Object.entries(c.byPlace).sort((a, b) => b[1].total - a[1].total).map(([pid, b]) => `<li><button class="row place" data-act="filter" data-id="${pid}" style="${pc(pid)}"><span class="bar"></span><span><span class="ttl">${esc(P(pid).name)}</span><span class="where num">${pl(b.count, 'plantão', 'plantões')} · recebido ${brl(b.received)}</span></span><span class="amt">${brl(b.total)}</span></button></li>`).join('')}</ul>
    </section>
  </div>`;
}

/* ---------- T06 ajustes, locais, modelos, dados, lixeira ---------- */
function viewSettings() {
  const t = themePref(), lb = S.meta.last_backup_at;
  return `
  <div class="lt"><h1>Ajustes</h1></div>
  <div class="gl">
    <div class="ghead">Aparência</div>
    <div class="group"><div class="cell"><span class="k">Tema</span><div class="seg" role="group" aria-label="Tema">${[['light', 'Claro'], ['dark', 'Escuro'], ['system', 'Sistema']].map(([v, l]) => `<button data-act="theme" data-id="${v}" aria-pressed="${t === v}">${l}</button>`).join('')}</div></div></div>
    <p class="gfoot">“Sistema” acompanha o modo claro/escuro do iPhone.</p>
    <div class="ghead">Plantões</div>
    <div class="group">
      <a class="cell" href="#/locais"><span class="k">Locais</span><span class="v">${places().map(p => `<span class="dot" style="${pc(p.id)}"></span>`).join('')} ${places().length} ${ic('chev', 16, 2)}</span></a>
      <a class="cell" href="#/modelos"><span class="k">Modelos de plantão</span><span class="v">${templates().length} ${ic('chev', 16, 2)}</span></a>
      <a class="cell" href="#/recorrencias"><span class="k">Recorrências</span><span class="v">${S.series.length} ${ic('chev', 16, 2)}</span></a>
      <a class="cell" href="#/lixeira"><span class="k">Lixeira</span><span class="v">${S.trash.length} ${ic('chev', 16, 2)}</span></a>
      <div class="cell"><span class="k">Semana começa</span><div class="seg" role="group" aria-label="Primeiro dia da semana">${[[0, 'Domingo'], [1, 'Segunda']].map(([v, l]) => `<button data-act="week" data-id="${v}" aria-pressed="${(S.meta.week_start || 0) === v}">${l}</button>`).join('')}</div></div>
      <div class="cell"><span class="k">Calendário</span><div class="seg" role="group" aria-label="Marcação dos plantões no calendário">${[['pontos', 'Pontos'], ['siglas', 'Siglas']].map(([v, l]) => `<button data-act="calmode" data-id="${v}" aria-pressed="${S.calMode === v}">${l}</button>`).join('')}</div></div>
    </div>
    <p class="gfoot">“Siglas” mostra o local em cada dia, sem depender da cor.</p>
    <div class="ghead">Seus dados</div>
    <div class="group">
      <a class="cell" href="#/dados"><span class="k">Backup, exportar e importar</span><span class="v">${lb ? `backup ${dm(lb.slice(0, 10))}` : 'sem backup'} ${ic('chev', 16, 2)}</span></a>
      ${saveCell()}
    </div>
    <p class="gfoot">Sem conta e sem servidor: os plantões ficam só neste aparelho. O backup é um arquivo seu.</p>
    <div class="ghead">Sobre</div>
    <div class="group">
      <div class="cell"><span class="k">Versão</span><span class="v">${esc(APP_VERSION)}</span></div>
      ${S.update ? `<button class="cell accent" data-act="update">Atualizar para a nova versão</button>` : ''}
      <a class="cell" href="#/privacidade"><span class="k">Privacidade</span><span class="v">${ic('chev', 16, 2)}</span></a>
    </div>
  </div>`;
}
function viewPrivacy() {
  return `<header class="nav"><div class="l"><a class="circ" href="#/ajustes" aria-label="Voltar">${ic('left')}</a></div><h1>Privacidade</h1><div class="r"></div></header>
  <div class="gl priv"><p>Este app não tem conta, não tem servidor e não envia nada pela internet: os plantões, valores e observações ficam gravados só neste aparelho (IndexedDB do navegador) e só saem dele nos arquivos que você mesmo exportar.</p>
  <p>A política de segurança do próprio app (CSP) bloqueia qualquer conexão fora da origem onde ele está instalado. Não há analytics, nem fontes ou scripts de terceiros.</p>
  <p>Como o iPhone pode apagar dados de sites sob pressão de espaço, faça backups periódicos (Ajustes › Seus dados). O app avisa quando passam 7 dias sem backup.</p>
  <p>Não registre dados de pacientes nas observações.</p></div>`;
}
function viewPlaces() {
  const act = places(), arch = Object.values(S.places).filter(p => p.archived);
  const cell = p => `<a class="cell" href="#/local/${p.id}" style="${pc(p.id)}"><span class="k"><span class="dot"></span>${esc(p.name)}</span><span class="v">${esc(p.short)} · ${ruleTxt(p.id)} ${ic('chev', 16, 2)}</span></a>`;
  return `<header class="nav"><div class="l"><a class="circ" href="#/ajustes" aria-label="Voltar">${ic('left')}</a></div><h1>Locais</h1><div class="r"><a class="circ" href="#/local/novo" aria-label="Novo local">${ic('plus', 22, 2)}</a></div></header>
  <div class="gl">${act.length ? `<div class="group" style="margin-top:12px">${act.map(cell).join('')}</div>` : '<p class="empty">Nenhum local. Toque em “+” para cadastrar o primeiro.</p>'}
  <p class="gfoot">Cada local tem sigla, cor e regra de recebimento. A cor vale nos dois temas.</p>
  ${arch.length ? `<div class="ghead">Arquivados</div><div class="group">${arch.map(cell).join('')}</div><p class="gfoot">Arquivar tira o local do formulário e da legenda; os plantões dele continuam.</p>` : ''}</div>`;
}
const newPlaceForm = () => ({ id: null, name: '', short: '', color: PALETTE[Object.keys(S.places).length % PALETTE.length], kind: 'days_after', days: 30, day: 10, archived: false });
const placeForm = p => ({ id: p.id, name: p.name, short: p.short, color: p.color, kind: p.rule.kind, days: p.rule.kind === 'days_after' ? p.rule.days : 30, day: p.rule.kind === 'fixed_day' ? p.rule.day : 10, archived: !!p.archived });
function validatePlace(f) { const e = {}; if (!f.name.trim()) e.name = 'nome'; if (!f.short.trim() || f.short.trim().length > 4) e.short = 'sigla (1 a 4 letras)'; if (!PALETTE.includes(f.color)) e.color = 'cor'; if (!validRule(f.kind === 'days_after' ? { kind: 'days_after', days: +f.days } : { kind: 'fixed_day', day: +f.day })) e.rule = f.kind === 'days_after' ? 'dias (0 a 366)' : 'dia do mês (1 a 31)'; return e; }
function viewPlaceForm() {
  const f = S.pform, ed = !!f.id, e = validatePlace(f), ok = !Object.keys(e).length, n = ed ? S.shifts.filter(s => s.place === f.id).length : 0;
  return `
  <header class="nav"><div class="l"><a class="textb" href="#/locais">Cancelar</a></div><h1>${ed ? 'Editar local' : 'Novo local'}</h1><div class="r"><button class="textb b" data-act="psave"${ok ? '' : ' aria-disabled="true"'}>Salvar</button></div></header>
  <form id="pf" class="gl" novalidate>
    <div class="ghead">Local</div>
    <div class="group">
      <label class="cell plain"><input name="name" value="${esc(f.name)}" placeholder="Nome (ex.: UPA Vila Nova)" autocomplete="off" aria-label="Nome do local"></label>
      <label class="cell"><span class="k">Sigla</span><input class="short num" name="short" value="${esc(f.short)}" maxlength="4" placeholder="UPA" aria-label="Sigla"></label>
    </div>
    <p class="gfoot">A sigla aparece no calendário no modo “Siglas” e nas listas.</p>
    <div class="ghead">Cor</div>
    <div class="chips">${PALETTE.map(k => `<button type="button" class="chip" data-act="pcolor" data-id="${k}" aria-pressed="${f.color === k}" style="${pcKey(k)}"><i></i>${PAL_NAMES[k]}</button>`).join('')}</div>
    <div class="ghead">Regra de recebimento</div>
    <div class="group">
      <div class="cell"><span class="k">Quando recebe</span><div class="seg" role="group" aria-label="Tipo de regra"><button type="button" data-act="pkind" data-id="days_after" aria-pressed="${f.kind === 'days_after'}">Dias após</button><button type="button" data-act="pkind" data-id="fixed_day" aria-pressed="${f.kind === 'fixed_day'}">Dia fixo</button></div></div>
      ${f.kind === 'days_after' ? `<label class="cell"><span class="k">Dias após o plantão</span><input type="number" class="num" name="days" min="0" max="366" inputmode="numeric" value="${esc(f.days)}"></label>` : `<label class="cell"><span class="k">Dia do mês seguinte</span><input type="number" class="num" name="day" min="1" max="31" inputmode="numeric" value="${esc(f.day)}"></label>`}
    </div>
    <p class="gfoot">${f.kind === 'days_after' ? 'Ex.: 30 dias após → plantão de 22/10 cai em 21/11.' : 'Ex.: dia 10 → plantão de 22/10 cai em 10/11. No mês sem esse dia, vale o último dia válido.'} A regra só muda a previsão de plantões novos; os existentes mantêm a sua.</p>
    ${ed ? `<div class="group" style="margin-top:20px"><div class="cell"><span class="k">Arquivado</span><button type="button" class="sw" role="switch" aria-checked="${f.archived}" data-act="parch" aria-label="Arquivar local" style="margin-left:auto"></button></div></div><p class="gfoot">Arquivar esconde o local do formulário e da legenda; ${pl(n, 'plantão existente continua', 'plantões existentes continuam')} no calendário e nas somas.</p>` : ''}
    <p id="pf-status" class="status-line ${ok ? 'ok' : 'warn'}" aria-live="polite">${ok ? `${ic('check', 14, 2.4)} Pronto para salvar` : `${ic('alert', 14, 2.2)} Falta: ${Object.values(e).join(', ')}`}</p>
  </form>`;
}
function readPlaceForm() { const el = document.getElementById('pf'); if (!el) return S.pform; const fd = new FormData(el), f = S.pform; for (const k of ['name', 'short', 'days', 'day']) if (fd.has(k)) f[k] = fd.get(k); f.short = f.short.toUpperCase(); return f; }
function savePlace() {
  const f = readPlaceForm(), e = validatePlace(f);
  if (Object.keys(e).length) { S.toast = { msg: `Ainda falta: ${Object.values(e).join(', ')}.` }; renderToast(); const el = document.querySelector(`#pf [name="${e.name ? 'name' : e.short ? 'short' : f.kind === 'days_after' ? 'days' : 'day'}"]`); if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); } return; }
  const rule = f.kind === 'days_after' ? { kind: 'days_after', days: +f.days } : { kind: 'fixed_day', day: +f.day };
  const p = f.id ? S.places[f.id] : (S.places[uid()] = { id: null }); if (!p.id) p.id = Object.keys(S.places).find(k => S.places[k] === p);
  const before = JSON.stringify(p); Object.assign(p, { name: f.name.trim(), short: f.short.trim().toUpperCase(), color: f.color, rule, archived: !!f.archived, updated_at: nowIso() });
  S.toast = { msg: `${esc(p.name)} ${f.id ? 'atualizado' : 'cadastrado'}.`, undo: f.id ? () => Object.assign(p, JSON.parse(before)) : () => { delete S.places[p.id]; } };
  S.pform = null; persist(); go('#/locais');
}
function viewTemplates() {
  const act = templates(), arch = S.templates.filter(t => t.archived);
  const cell = t => `<a class="cell" href="#/modelo/${t.id}" style="${pc(t.place)}"><span class="k"><span class="dot"></span>${esc(t.title)}</span><span class="v num">${t.start}–${t.end} · ${brl(t.amount_cents)} ${ic('chev', 16, 2)}</span></a>`;
  return `<header class="nav"><div class="l"><a class="circ" href="#/ajustes" aria-label="Voltar">${ic('left')}</a></div><h1>Modelos de plantão</h1><div class="r"><a class="circ" href="#/modelo/novo" aria-label="Novo modelo">${ic('plus', 22, 2)}</a></div></header>
  <div class="gl">${act.length ? `<div class="group" style="margin-top:12px">${act.map(cell).join('')}</div>` : '<p class="empty">Nenhum modelo. Toque em “+” para criar o primeiro.</p>'}
  <p class="gfoot">Um modelo preenche título, local, horário e valor com um toque no formulário.</p>
  ${arch.length ? `<div class="ghead">Arquivados</div><div class="group">${arch.map(cell).join('')}</div>` : ''}</div>`;
}
const newTplForm = () => ({ id: null, title: '', place: places()[0]?.id || '', start: '07:00', end: '19:00', amount: '', archived: false });
const tplForm = t => ({ id: t.id, title: t.title, place: t.place, start: t.start, end: t.end, amount: centsTxt(t.amount_cents), archived: !!t.archived });
function validateTpl(f) { const e = {}; if (!f.title.trim()) e.title = 'título'; if (!f.place || !S.places[f.place]) e.place = 'local'; if (!isTimeHM(f.start) || !isTimeHM(f.end) || f.start === f.end) e.time = 'horário'; const c = parseCents(f.amount); if (c == null || c <= 0) e.amount = 'valor'; return e; }
function viewTplForm() {
  const f = S.tform, ed = !!f.id, e = validateTpl(f), ok = !Object.keys(e).length;
  return `
  <header class="nav"><div class="l"><a class="textb" href="#/modelos">Cancelar</a></div><h1>${ed ? 'Editar modelo' : 'Novo modelo'}</h1><div class="r"><button class="textb b" data-act="tsave"${ok ? '' : ' aria-disabled="true"'}>Salvar</button></div></header>
  <form id="tf" class="gl" novalidate>
    <div class="ghead">Modelo</div>
    <div class="group">
      <label class="cell plain"><input name="title" value="${esc(f.title)}" placeholder="Título (ex.: Noturno 12h)" autocomplete="off" aria-label="Título do modelo"></label>
      <label class="cell"><span class="k">Local</span><span class="v"><span class="dot" style="${f.place && S.places[f.place] ? pc(f.place) : 'display:none'}"></span><select name="place"><option value="">Escolher</option>${places().map(p => `<option value="${p.id}"${f.place === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></span></label>
      <label class="cell"><span class="k">Começa</span><input class="num" type="time" name="start" value="${f.start}"></label>
      <label class="cell"><span class="k">Termina</span><input class="num" type="time" name="end" value="${f.end}"></label>
      <label class="cell"><span class="k">Valor</span><span class="v" style="gap:4px"><span>R$</span><input name="amount" inputmode="decimal" placeholder="0,00" value="${esc(f.amount)}" style="width:110px"></span></label>
    </div>
    ${ed ? `<div class="group" style="margin-top:20px"><div class="cell"><span class="k">Arquivado</span><button type="button" class="sw" role="switch" aria-checked="${f.archived}" data-act="tarch" aria-label="Arquivar modelo" style="margin-left:auto"></button></div></div><p class="gfoot">Arquivar tira o modelo dos chips do formulário; nenhum plantão muda.</p>` : ''}
    <p id="tf-status" class="status-line ${ok ? 'ok' : 'warn'}" aria-live="polite">${ok ? `${ic('check', 14, 2.4)} Pronto para salvar` : `${ic('alert', 14, 2.2)} Falta: ${Object.values(e).join(', ')}`}</p>
  </form>`;
}
function readTplForm() { const el = document.getElementById('tf'); if (!el) return S.tform; const fd = new FormData(el), f = S.tform; for (const k of ['title', 'place', 'start', 'end', 'amount']) if (fd.has(k)) f[k] = fd.get(k); return f; }
function saveTpl() {
  const f = readTplForm(), e = validateTpl(f);
  if (Object.keys(e).length) { S.toast = { msg: `Ainda falta: ${Object.values(e).join(', ')}.` }; renderToast(); const el = document.querySelector(`#tf [name="${Object.keys(e)[0] === 'time' ? 'start' : Object.keys(e)[0]}"]`); if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); } return; }
  let t = f.id ? tplById(f.id) : null; const before = t && JSON.stringify(t);
  if (!t) { t = { id: uid() }; S.templates.push(t); }
  Object.assign(t, { title: f.title.trim(), place: f.place, start: f.start, end: f.end, amount_cents: parseCents(f.amount), archived: !!f.archived, updated_at: nowIso() });
  S.toast = { msg: `${esc(t.title)} ${f.id ? 'atualizado' : 'criado'}.`, undo: f.id ? () => Object.assign(t, JSON.parse(before)) : () => { S.templates = S.templates.filter(x => x !== t); } };
  S.tform = null; persist(); go('#/modelos');
}
function viewTrash() {
  const list = [...S.trash].sort((a, b) => (b.deleted_at || '').localeCompare(a.deleted_at || ''));
  return `<header class="nav"><div class="l"><a class="circ" href="#/ajustes" aria-label="Voltar">${ic('left')}</a></div><h1>Lixeira</h1><div class="r">${list.length ? `<button class="textb" data-act="tempty" style="color:var(--danger)">Esvaziar</button>` : ''}</div></header>
  ${list.length ? `<p class="gfoot" style="padding:8px 20px 0">${pl(list.length, 'plantão apagado', 'plantões apagados')}. Fora do calendário e das somas até ser restaurado.</p><ul class="rows">${list.map(s => `<li class="plain"><button class="row" data-act="trestore" data-id="${s.id}" style="${pc(s.place)}" aria-label="${esc(`Restaurar ${s.title}, ${P(s.place).name}, ${dmy(day(s))}`)}"><span class="bar"></span><span class="info"><span class="when"><span class="num">${dmy(day(s))} · ${t0(s)}–${t1(s)}</span></span><span class="ttl">${esc(s.title)}</span><span class="where"><span class="sg">${esc(P(s.place).short)}</span> · apagado ${dm((s.deleted_at || '').slice(0, 10))}</span></span><span class="right"><span class="amt">${brl(s.amount_cents)}</span><span class="st pend">${ic('undo', 13, 2.2)} Restaurar</span></span></button></li>`).join('')}</ul>` : '<p class="empty">A lixeira está vazia.</p>'}`;
}
function viewData() {
  const lb = S.meta.last_backup_at, days = lb ? diffDays(lb.slice(0, 10), TODAY) : null, n = S.shifts.length;
  return `<header class="nav"><div class="l"><a class="circ" href="#/ajustes" aria-label="Voltar">${ic('left')}</a></div><h1>Seus dados</h1><div class="r"></div></header>
  <div class="gl">
    <div class="ghead">Backup completo</div>
    <div class="group">
      <div class="cell"><span class="k">Último backup</span><span class="v ${days != null && days > 7 ? 'late' : ''}">${lb ? `${dmy(lb.slice(0, 10))} ${lb.slice(11, 16)} UTC${days > 7 ? ` · há ${days} dias` : ''}` : 'nunca'}</span></div>
      <button class="cell accent" data-act="backup">Fazer backup agora (.json)</button>
      <button class="cell" data-act="pick" data-id="backup"><span class="k">Restaurar de um backup</span><span class="v">${ic('chev', 16, 2)}</span></button>
      ${S.meta.restore_undo ? `<button class="cell" data-act="restore-undo"><span class="k">Desfazer a última restauração</span><span class="v">${ic('undo', 16, 2)}</span></button>` : ''}
    </div>
    <p class="gfoot">O backup traz tudo (locais, modelos, recorrências, plantões, lixeira) com assinatura SHA-256; a restauração só grava depois de validar o arquivo inteiro e pode ser desfeita.</p>
    <div class="ghead">Exportar</div>
    <div class="group">
      <button class="cell" data-act="exp" data-id="csv"><span class="k">Planilha da escala (.csv)</span><span class="v">${n} ${ic('chev', 16, 2)}</span></button>
      <button class="cell" data-act="exp" data-id="ganhos"><span class="k">Planilha com ganhos (.csv)</span><span class="v">${ic('chev', 16, 2)}</span></button>
      <button class="cell" data-act="exp" data-id="ics"><span class="k">Agenda (.ics) sem valores</span><span class="v">${ic('chev', 16, 2)}</span></button>
      <button class="cell" data-act="exp" data-id="icsv"><span class="k">Agenda (.ics) com valores</span><span class="v">${ic('chev', 16, 2)}</span></button>
    </div>
    <p class="gfoot">CSV da escala no formato documentado do Plantãozinho (id, title, place, color, start_date, end_date, value, notes). A agenda "sem valores" leva só horário, título e local — para compartilhar o calendário sem expor ganhos; a "com valores" inclui valor, previsão e recebimento. O .ics abre no Calendário do iPhone pela folha de compartilhar.</p>
    <div class="ghead">Importar</div>
    <div class="group">
      <button class="cell" data-act="pick" data-id="csv"><span class="k">Planilha (.csv)</span><span class="v">${ic('chev', 16, 2)}</span></button>
      <button class="cell" data-act="pick" data-id="ics"><span class="k">Agenda (.ics)</span><span class="v">${ic('chev', 16, 2)}</span></button>
    </div>
    <p class="gfoot">Antes de gravar, você vê a prévia: válidas, inválidas (com o motivo) e duplicadas. Nada é alterado sem confirmação.</p>
    <div class="ghead">Dados de exemplo</div>
    <div class="group">${S.meta.sample_loaded ? `<button class="cell danger" data-act="sample-remove">Remover os dados de exemplo</button>` : `<button class="cell" data-act="sample">Carregar dados de exemplo (fictícios)</button>`}</div>
    <div class="ghead">Gravação</div>
    <div class="group">${saveCell()}<div class="cell"><span class="k">Armazenamento persistente</span><span class="v wrap ${S.storage?.persisted ? 'ok' : S.storage?.persisted === false ? 'late' : ''}">${S.storage?.persisted ? 'concedido pelo sistema' : S.storage?.persisted === false ? 'não concedido — o sistema pode apagar dados de sites sem aviso; mantenha backups' : 'não informado por este navegador'}</span></div></div>
    <input type="file" id="pick-csv" accept=".csv,text/csv,text/plain" hidden><input type="file" id="pick-ics" accept=".ics,text/calendar" hidden><input type="file" id="pick-backup" accept=".json,application/json" hidden>
  </div>`;
}
function viewImport() {
  const im = S.imp; if (!im) return `<header class="nav"><div class="l"><a class="circ" href="#/dados" aria-label="Voltar">${ic('left')}</a></div><h1>Importar</h1><div class="r"></div></header><p class="empty">Nenhum arquivo escolhido.</p>`;
  const kind = { csv: 'planilha', ics: 'agenda', backup: 'backup' }[im.kind], pv = im.preview;
  if (im.kind === 'backup') {
    const b = im.raw, ok = pv.ok;
    return `<header class="nav"><div class="l"><a class="textb" href="#/dados">Cancelar</a></div><h1 tabindex="-1">Restaurar backup</h1><div class="r"><button class="textb b" data-act="imp-confirm"${ok ? '' : ' aria-disabled="true"'}>Restaurar</button></div></header>
    <div class="gl"><div class="ghead">Arquivo</div><div class="group">
      <div class="cell"><span class="k">Nome</span><span class="v wrap">${esc(im.name)}</span></div>
      ${typeof b?.exported_at === 'string' ? `<div class="cell"><span class="k">Exportado em</span><span class="v num">${esc(b.exported_at.replace('T', ' ').slice(0, 16))} UTC</span></div>` : ''}
      ${typeof b?.app_version === 'string' ? `<div class="cell"><span class="k">Versão do app</span><span class="v">${esc(b.app_version.slice(0, 40))}</span></div>` : ''}
      ${b?.counts && ['shifts', 'places', 'templates', 'series'].every(k => Number.isInteger(b.counts[k])) ? `<div class="cell"><span class="k">Conteúdo</span><span class="v wrap num">${b.counts.shifts} plantões · ${b.counts.places} locais · ${b.counts.templates} modelos · ${b.counts.series} recorrências</span></div>` : ''}
      <div class="cell"><span class="k">Verificação</span><span class="v ${ok ? 'ok' : 'late'}">${ok ? 'íntegro e válido' : 'rejeitado'}</span></div></div>
      ${ok ? `<p class="gfoot">Restaurar substitui tudo o que está no aparelho (${S.shifts.length} plantões hoje). A restauração é atômica e pode ser desfeita em Seus dados › Desfazer.</p>` : `<div class="ghead">Problemas</div><div class="group"><ul class="imp">${pv.errors.slice(0, 30).map(e => `<li>${esc(e)}</li>`).join('')}</ul></div><p class="gfoot">Nada foi alterado.</p>`}</div>`;
  }
  const conf = pv.conflicts || [], mode = im.mode || 'keep', ok = pv.valid?.length > 0 || (conf.length > 0 && mode === 'replace'), noAmt = (pv.valid || []).filter(s => s.noAmount).length;
  const chTxt = c => c.changes.map(x => `${x.field}: ${x.money ? brl(x.from) : esc(String(x.from)).slice(0, 24)} → ${x.money ? brl(x.to) : esc(String(x.to)).slice(0, 24)}`).join(' · ');
  return `<header class="nav"><div class="l"><a class="textb" href="#/dados">Cancelar</a></div><h1 tabindex="-1">Importar ${kind}</h1><div class="r"><button class="textb b" data-act="imp-confirm"${ok ? '' : ' aria-disabled="true"'}>Importar</button></div></header>
  <div class="gl">
    <div class="ghead">${esc(im.name)}</div>
    ${pv.error ? `<div class="group" role="status"><div class="cell"><span class="k">Não deu para ler</span><span class="v late wrap">${esc(pv.error)}</span></div></div>` : `<div class="group" role="status" aria-label="Resumo da importação">
      <div class="cell"><span class="k">Registros no arquivo</span><span class="v num">${pv.total}</span></div>
      <div class="cell"><span class="k">Vão entrar</span><span class="v"><span class="badge ok">${pv.valid.length}</span></span></div>
      <div class="cell"><span class="k">Duplicados (ignorados)</span><span class="v"><span class="badge">${pv.dup.length}</span></span></div>
      <div class="cell"><span class="k">Inválidos (ignorados)</span><span class="v"><span class="badge${pv.invalid.length ? ' warn' : ''}">${pv.invalid.length}</span></span></div>
      ${conf.length ? `<div class="cell"><span class="k">Conflitos</span><span class="v"><span class="badge warn">${conf.length}</span></span></div>` : ''}
      ${noAmt ? `<div class="cell"><span class="k">Sem valor</span><span class="v wrap">${noAmt} entram com R$ 0,00 (valor a preencher; fora das somas)</span></div>` : ''}
      ${(pv.valid || []).some(s => s.tzUnknown) ? `<div class="cell"><span class="k">Fuso desconhecido</span><span class="v wrap">${(pv.valid || []).filter(s => s.tzUnknown).length} eventos com fuso não reconhecido: horário tratado como de São Paulo</span></div>` : ''}
    </div>
    ${pv.newPlaces.length ? `<div class="ghead">Locais novos (serão criados)</div><div class="group"><ul class="imp">${pv.newPlaces.map(p => `<li><span>${esc(p.name)}</span><small>${pl(p.count, 'plantão', 'plantões')} · regra padrão: 30 dias após</small></li>`).join('')}</ul></div><p class="gfoot">Depois ajuste sigla, cor e regra em Ajustes › Locais.</p>` : ''}
    ${pv.invalid.length ? `<div class="ghead">Inválidos</div><div class="group"><ul class="imp">${pv.invalid.slice(0, 20).map(x => `<li><span class="n">linha ${x.line}</span><small>${esc(x.reason)}</small></li>`).join('')}${pv.invalid.length > 20 ? `<li><small>… e mais ${pv.invalid.length - 20}</small></li>` : ''}</ul></div>` : ''}
    ${conf.length ? `<div class="ghead">Conflitos (já existem aqui, com conteúdo diferente)</div><div class="group"><div class="cell"><span class="k">O que fazer</span><div class="seg" role="group" aria-label="Como tratar os conflitos"><button data-act="imp-mode" data-id="keep" aria-pressed="${mode === 'keep'}">Manter os meus</button><button data-act="imp-mode" data-id="replace" aria-pressed="${mode === 'replace'}">Substituir pelo arquivo</button></div></div><ul class="imp">${conf.slice(0, 10).map(c => `<li><span>${esc(c.title)} · ${dmy(c.start.slice(0, 10))}</span><small>${chTxt(c)}</small></li>`).join('')}${conf.length > 10 ? `<li><small>… e mais ${conf.length - 10}</small></li>` : ''}</ul></div><p class="gfoot">"Substituir" atualiza título, horário, valor e observação do plantão existente; a data em que você recebeu nunca é alterada por importação.</p>` : ''}
    ${pv.dup.length ? `<div class="ghead">Duplicados</div><div class="group"><ul class="imp">${pv.dup.slice(0, 10).map(x => `<li><span>${esc(x.title)}</span><small>${dmy(x.start.slice(0, 10))}${x.why ? ' · ' + x.why : ''}</small></li>`).join('')}${pv.dup.length > 10 ? `<li><small>… e mais ${pv.dup.length - 10}</small></li>` : ''}</ul></div>` : ''}`}
    <p class="gfoot">Nada é gravado até você tocar em Importar. Depois dá para desfazer.</p>
  </div>`;
}

/* ---------- importação / exportação (efeitos) ---------- */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
async function readPicked(kind, file) {
  S.imp = { kind, name: file.name, preview: null, raw: null };
  if (file.size > MAX_FILE_BYTES) { S.imp.preview = kind === 'backup' ? { ok: false, errors: [`arquivo com ${(file.size / 1048576).toFixed(1)} MB — o limite é 5 MB`] } : { error: `arquivo com ${(file.size / 1048576).toFixed(1)} MB — o limite é 5 MB`, valid: [], invalid: [], dup: [], newPlaces: [], total: 0 }; go('#/importar'); return; } /* M3 */
  try {
    const text = await file.text(); const data = { places: Object.values(S.places), templates: S.templates, series: S.series, shifts: S.shifts };
    if (kind === 'csv') S.imp.preview = csvPreview(text, data);
    else if (kind === 'ics') S.imp.preview = icsPreview(text, data);
    else { let obj = null; try { obj = JSON.parse(text); } catch (e) { obj = null; } S.imp.raw = obj; S.imp.preview = obj ? await backupVerify(obj) : { ok: false, errors: ['o arquivo não é um JSON válido'] }; }
  } catch (e) { S.imp.preview = { error: String(e.message || e), valid: [], invalid: [], dup: [], newPlaces: [], total: 0 }; }
  go('#/importar');
}
function confirmImport() {
  const im = S.imp; if (!im || !im.preview) return true;
  if (im.kind === 'backup') { if (!im.preview.ok) return true; restoreBackup(im.preview.data); return true; }
  const pv = im.preview, conf = pv.conflicts || [], replace = im.mode === 'replace'; if (!pv.valid?.length && !(replace && conf.length)) return true;
  const createdPlaces = [], map = {}; let ci = Object.keys(S.places).length;
  for (const np of pv.newPlaces) { const id = uid(); const short = (np.name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).map(w => w[0] || '').join('').slice(0, 3) || np.name.slice(0, 3)).toUpperCase(); S.places[id] = { id, name: np.name, short, color: PALETTE[ci++ % PALETTE.length], rule: { ...DEFAULT_RULE }, archived: false, updated_at: nowIso() }; map[np.tempId] = id; createdPlaces.push(id); }
  const made = pv.valid.map(v => { const place = map[v.place] || v.place; const s = { id: uid(), title: v.title, place, start: v.start, end: v.end, minutes: v.minutes, amount_cents: v.amount_cents, expected_on: v.expected_on || ruleDate(place, v.start.slice(0, 10)), paid_at: v.paid_at || null, note: v.note || '', series: null, template: null, imported_at: nowIso(), updated_at: nowIso() }; if (v.ext_uid) s.ext_uid = v.ext_uid; return s; });
  S.shifts.push(...made); const ids = new Set(made.map(s => s.id));
  const replacedBefore = []; if (replace) for (const c of conf) { const ex = byId(c.existingId); if (!ex) continue; replacedBefore.push([ex, JSON.stringify(ex)]); applyConflict(ex, { ...c.incoming, place: map[c.incoming.place] || c.incoming.place }, nowIso()); }
  const parts = [made.length ? pl(made.length, 'plantão importado', 'plantões importados') : '', replacedBefore.length ? pl(replacedBefore.length, 'plantão atualizado', 'plantões atualizados') : '', createdPlaces.length ? pl(createdPlaces.length, 'local criado', 'locais criados') : ''].filter(Boolean);
  S.toast = { msg: parts.join(' · ') + '.', undo: () => { S.shifts = S.shifts.filter(s => !ids.has(s.id)); for (const [ex, before] of replacedBefore) Object.assign(ex, JSON.parse(before)); for (const id of createdPlaces) delete S.places[id]; } };
  const first = (made.length ? made.map(s => day(s)) : replacedBefore.map(([ex]) => day(ex))).sort()[0]; S.imp = null; S.month = first.slice(0, 7); S.sel = first; persist(); go('#/calendario/' + first); return true;
}
function restoreBackup(data) {
  const undo = { places: Object.values(S.places), templates: S.templates, series: S.series, shifts: [...S.shifts, ...S.trash], meta: { ...S.meta, restore_undo: null } };
  const d = JSON.parse(JSON.stringify(data));
  S.places = Object.fromEntries(d.places.map(p => [p.id, p])); S.templates = d.templates; S.series = d.series; S.shifts = d.shifts.filter(s => !s.deleted_at); S.trash = d.shifts.filter(s => !!s.deleted_at);
  S.meta = { ...META_DEFAULT(), ...S.meta, sample_loaded: d.shifts.some(s => s.sample), restore_undo: undo };
  S.imp = null; S.toast = { msg: `Backup restaurado: ${pl(S.shifts.length, 'plantão', 'plantões')}.`, btn: { label: 'Desfazer', act: 'restore-undo' } };
  S.month = TODAY.slice(0, 7); S.sel = TODAY; persist(true); go('#/calendario');
}
function undoRestore() {
  const u = S.meta.restore_undo; if (!u) return;
  S.places = Object.fromEntries(u.places.map(p => [p.id, p])); S.templates = u.templates; S.series = u.series; S.shifts = u.shifts.filter(s => !s.deleted_at); S.trash = u.shifts.filter(s => !!s.deleted_at); S.meta = { ...u.meta, restore_undo: null };
  S.toast = { msg: 'Restauração desfeita.' }; persist(); go('#/calendario');
}
async function download(name, text, type) {
  const blob = new Blob([text], { type }); const file = new File([blob], name, { type });
  if (!Q.get('noshare') && navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return 'share'; } catch (e) { if (e.name === 'AbortError') return 'cancel'; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); return 'download';
}
const data4 = () => ({ places: Object.values(S.places), templates: S.templates, series: S.series, shifts: S.shifts });
async function doExport(kind) {
  const stamp = TODAY; let r;
  if (kind === 'csv') r = await download(`meus-plantoes-escala-${stamp}.csv`, '﻿' + csvExport(data4()), 'text/csv;charset=utf-8');
  else if (kind === 'ganhos') r = await download(`meus-plantoes-ganhos-${stamp}.csv`, '﻿' + csvExportGanhos(data4(), TODAY), 'text/csv;charset=utf-8');
  else if (kind === 'ics') r = await download(`meus-plantoes-agenda-${stamp}.ics`, icsExport(data4(), new Date(), { values: false }), 'text/calendar;charset=utf-8');
  else if (kind === 'icsv') r = await download(`meus-plantoes-agenda-valores-${stamp}.ics`, icsExport(data4(), new Date(), { values: true }), 'text/calendar;charset=utf-8');
  if (r !== 'cancel') { S.toast = { msg: { csv: 'Planilha da escala exportada.', ganhos: 'Planilha com ganhos exportada.', ics: 'Agenda sem valores exportada — abra no Calendário.', icsv: 'Agenda com valores exportada — abra no Calendário.' }[kind] }; renderToast(); }
}
async function doBackup() {
  const all = { places: Object.values(S.places), templates: S.templates, series: S.series, shifts: [...S.shifts, ...S.trash] };
  const b = await backupMake(all, APP_VERSION); const r = await download(`meus-plantoes-backup-${TODAY}.json`, JSON.stringify(b, null, 1), 'application/json');
  if (r !== 'cancel') { S.meta.last_backup_at = nowIso(); S.meta.last_backup_sha256 = b.sha256; S.toast = { msg: `Backup salvo: ${b.counts.shifts} plantões.` }; persist(); render(false); }
}
function loadSampleScript() { return new Promise((res, rej) => { if (window.PLANTOES_SAMPLE) return res(); const s = document.createElement('script'); s.src = 'sample.js'; s.onload = () => res(); s.onerror = () => rej(new Error('dados de exemplo indisponíveis')); document.head.appendChild(s); }); }
async function loadSample() {
  await loadSampleScript(); const D = JSON.parse(JSON.stringify(window.PLANTOES_SAMPLE));
  for (const p of D.places) if (!S.places[p.id]) S.places[p.id] = { ...p, sample: true };
  for (const t of D.templates) if (!tplById(t.id)) S.templates.push({ ...t, sample: true });
  for (const se of D.series) if (!seriesById(se.id)) S.series.push({ ...se, sample: true });
  const have = new Set(S.shifts.map(s => s.id)); for (const s of D.shifts) if (!have.has(s.id)) S.shifts.push({ ...s, sample: true });
  S.meta.sample_loaded = true; S.month = D.meta.today.slice(0, 7); S.sel = D.meta.today;
}
function removeSample() {
  for (const [id, p] of Object.entries(S.places)) if (p.sample) delete S.places[id];
  S.templates = S.templates.filter(t => !t.sample); S.series = S.series.filter(x => !x.sample); S.shifts = S.shifts.filter(s => !s.sample); S.trash = S.trash.filter(s => !s.sample); S.meta.sample_loaded = false;
  S.toast = { msg: 'Dados de exemplo removidos.' };
}

/* ---------- roteamento e render ---------- */
const $app = document.getElementById('app');
const TAB = { cal: 'cal', detail: 'cal', form: null, series: 'aj', serieslist: 'aj', pay: 'pay', settings: 'aj', places: 'aj', pform: 'aj', templates: 'aj', tform: 'aj', trash: 'aj', data: 'aj', import: null, privacy: 'aj' };
function parseHash() { let h = (location.hash || '').replace(/^#\/?/, ''); return h.includes('/') ? h.split('/') : h.split('~'); }
function route() {
  const [r = 'calendario', a, b] = parseHash();
  if (!S.keep) S.toast = S.toast?.kind === 'save' ? S.toast : null; S.keep = false; S.sheet = null;
  switch (r) {
    case 'plantao': S.view = 'detail'; S.id = a; break;
    case 'novo': S.view = 'form'; S.form = newForm(isDateKey(a || '') ? a : S.sel, b); break;
    case 'editar': { const s = byId(a); S.view = s ? 'form' : 'cal'; if (s) S.form = formFrom(s); break; }
    case 'serie': S.view = 'series'; S.seriesId = a; break;
    case 'recorrencias': S.view = 'serieslist'; break;
    case 'pagamentos': S.view = 'pay'; break;
    case 'ajustes': S.view = 'settings'; break;
    case 'locais': S.view = 'places'; break;
    case 'local': S.view = 'pform'; S.pform = a === 'novo' || !S.places[a] ? newPlaceForm() : placeForm(S.places[a]); break;
    case 'modelos': S.view = 'templates'; break;
    case 'modelo': S.view = 'tform'; S.tform = a === 'novo' || !tplById(a) ? newTplForm() : tplForm(tplById(a)); break;
    case 'lixeira': S.view = 'trash'; break;
    case 'dados': S.view = 'data'; break;
    case 'importar': S.view = 'import'; break;
    case 'privacidade': S.view = 'privacy'; break;
    default: S.view = 'cal'; if (isDateKey(a || '')) { S.sel = a; S.month = a.slice(0, 7); } if (b === 'siglas' || b === 'pontos') S.calMode = b;
  }
  render(true);
}
function go(h) { if (location.hash === h) route(); else { S.keep = true; location.hash = h; } }
const VIEWS = { detail: () => viewDetail(S.id), form: viewForm, series: viewSeries, serieslist: viewSeriesList, pay: viewPay, settings: viewSettings, places: viewPlaces, pform: viewPlaceForm, templates: viewTemplates, tform: viewTplForm, trash: viewTrash, data: viewData, import: viewImport, privacy: viewPrivacy, cal: viewCal };
function render(scrollTop) {
  const v = S.view;
  $app.innerHTML = (VIEWS[v] || viewCal)();
  document.body.className = (['form', 'series', 'serieslist', 'settings', 'places', 'pform', 'templates', 'tform', 'data', 'import', 'privacy'].includes(v) ? 'grouped ' : '') + (['form', 'pform', 'tform', 'import'].includes(v) || S.sheet ? 'noframe ' : '');
  const t = TAB[v], tab = (id, href, icon, label) => `<a href="${href}"${t === id ? ' aria-current="page"' : ''}>${ic(icon, 24)}<span>${label}</span></a>`;
  document.getElementById('tabs').innerHTML = tab('cal', '#/calendario', 'cal', 'Calendário') + tab('pay', '#/pagamentos', 'wallet', 'Pagamentos') + tab('aj', '#/ajustes', 'gear', 'Ajustes');
  renderToast();
  if (scrollTop) window.scrollTo(0, 0);
  if (S.sheet) document.getElementById('sc-start')?.focus(); /* M1: foco entra na folha de escopo */
  if (v === 'import') document.querySelector('#app h1')?.focus(); /* M2: a prévia é anunciada */
  if (S.flash) { const li = document.querySelector(`li[data-shift="${CSS.escape(S.flash)}"]`); S.flash = null; if (li) { li.classList.add('flash'); setTimeout(() => li.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' }), 60); } }
  if (S.slide) { const z = document.querySelector('[data-calswipe]'), cls = S.slide > 0 ? 'slide-next' : 'slide-prev'; S.slide = 0; if (z && !reduced()) { z.classList.add(cls); z.addEventListener('animationend', () => z.classList.remove(cls), { once: true }); } }
}
function renderToast() { const t = S.toast; document.getElementById('toast').innerHTML = t ? `<div class="toast"><span>${t.msg}</span>${t.undo ? '<button data-act="undo">Desfazer</button>' : ''}${t.btn ? `<button class="act2" data-act="${t.btn.act}">${esc(t.btn.label)}</button>` : ''}<button data-act="toastx" aria-label="Fechar">${ic('x', 16, 2.2)}</button></div>` : ''; }

/* F02: trocar de mês preservando o dia selecionado quando ele existe no destino (senão o último dia válido) */
function shiftMonth(n, animate) {
  const ym = addMonths(S.month + '-01', n).slice(0, 7), [y, m] = ym.split('-').map(Number), d = +S.sel.slice(8, 10);
  S.month = ym; S.sel = `${ym}-${pad(Math.min(d, dim(y, m)))}`; S.slide = animate ? n : 0;
}
/* gesto horizontal na grade do calendário ([data-calswipe], zona separada das linhas da lista): esquerda = próximo mês, direita = anterior. */
let cg = null;
document.addEventListener('pointerdown', e => {
  if (!e.isPrimary || e.button > 0) return; const z = e.target.closest('[data-calswipe]'); if (!z || e.target.closest('li[data-shift]')) return;
  cg = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, on: false, z };
});
document.addEventListener('pointermove', e => {
  const g = cg; if (!g || e.pointerId !== g.id) return; const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
  if (!g.on) { if (Math.abs(dx) <= 10 || Math.abs(dx) <= Math.abs(dy)) { if (Math.abs(dy) > 10) cg = null; return; } g.on = true; g.z.classList.add('drag'); try { g.z.setPointerCapture(e.pointerId); } catch (_) { } }
  g.dx = dx; if (!reduced()) g.z.style.setProperty('--cx', Math.max(-48, Math.min(48, dx * 0.3)) + 'px');
});
function endCal(e, cancel) {
  const g = cg; if (!g || e.pointerId !== g.id) return; cg = null; g.z.classList.remove('drag'); g.z.style.removeProperty('--cx'); if (!g.on) return;
  eat(null, g.id);
  if (!cancel && Math.abs(g.dx) >= 60) { shiftMonth(g.dx < 0 ? 1 : -1, true); render(false); }
}
document.addEventListener('pointerup', e => endCal(e, false));
document.addEventListener('pointercancel', e => endCal(e, true));

/* ---------- ações ---------- */
function payShift(s, date) { const prev = s.paid_at; s.paid_at = date; s.updated_at = nowIso(); S.toast = { msg: `${esc(s.title)} · ${esc(P(s.place).short)}: recebido em ${dm(date)}.`, undo: () => { s.paid_at = prev; } }; }
function unpayShift(s) { const prev = s.paid_at; s.paid_at = null; s.updated_at = nowIso(); S.toast = { msg: `Recebimento de ${dm(prev)} desfeito.`, undo: () => { s.paid_at = prev; } }; }
const NO_PERSIST = new Set(['imp-mode', 'week', 'day', 'today', 'pmonth', 'nmonth', 'open', 'more', 'edit', 'menu-close', 'delete', 'delete-cancel', 'pprev', 'pnext', 'cohort', 'filter', 'got', 'theme', 'calmode', 'tpl', 'fpaid', 'save', 'occ', 'sheetx', 'toastx', 'pick', 'exp', 'backup', 'pcolor', 'pkind', 'parch', 'tarch', 'psave', 'tsave', 'imp-confirm', 'update', 'retry-save', 'sample', 'restore-undo', 'tempty']); /* estes gravam por conta própria (ou não mudam dados) */
const ACT = {
  day(k) { S.sel = k; S.month = k.slice(0, 7); },
  today() { S.sel = TODAY; S.month = TODAY.slice(0, 7); },
  pmonth() { shiftMonth(-1, false); }, nmonth() { shiftMonth(1, false); },
  open(id) { go('#/plantao/' + id); return true; },
  pay(id) { payShift(byId(id), TODAY); return done(id); },
  unpay(id) { unpayShift(byId(id)); return done(id); },
  more(id) { openOv(menuSheet(byId(id)), id); return true; },
  edit(id) { closeOv(false); go('#/editar/' + id); return true; },
  'menu-close'() { closeOv(); return true; },
  delete(id) { closeOv(false); openOv(confirmBox(byId(id)), id); return true; },
  'delete-cancel'() { closeOv(); return true; },
  'delete-confirm'(id) { const scope = document.querySelector('[name=scope]:checked')?.value || 'one'; closeOv(false); doDelete(id, scope); return true; },
  pprev() { S.pay = addMonths(S.pay + '-01', -1).slice(0, 7); }, pnext() { S.pay = addMonths(S.pay + '-01', 1).slice(0, 7); },
  cohort(v) { S.cohort = v; }, filter(v) { S.filter = S.filter === v && v !== 'all' ? 'all' : v; }, got() { S.showGot = !S.showGot; },
  theme(v) { lsSet('mp-theme', v); applyTheme(); },
  calmode(v) { S.calMode = v; lsSet('mp-cal', v); },
  week(v) { S.meta.week_start = +v; persist(); },
  tpl(id) { const f = readForm(), t = tplById(id); Object.assign(f, { tpl: id, title: t.title, place: t.place, start: t.start, end: t.end, amount: centsTxt(t.amount_cents), expOverride: false }); },
  fpaid() { const f = readForm(); f.paid = !f.paid; },
  save() { submitForm(); return true; },
  occ(k) { S.sheet = { occ: k, scope: 'one' }; }, sheetx() { const k = S.sheet?.occ; S.sheet = null; render(false); document.querySelector(`[data-act="occ"][data-id="${k}"]`)?.focus({ preventScroll: true }); return true; },
  restore(k) { const se = seriesById(S.seriesId), tp = tplOf(se), o = se.overrides[k] || {};
    const s = { id: uid(), template: se.template || null, series: se.id, ...mkShift({ title: tp.title, place: tp.place, start: o.start || tp.start, end: o.end || tp.end, amount: centsTxt(tp.amount_cents), note: '', paid: false }, k, false), updated_at: nowIso() };
    S.shifts.push(s); se.exdates = se.exdates.filter(x => x !== k); S.toast = { msg: `${dm(k)} restaurado na série.`, undo: () => { S.shifts = S.shifts.filter(x => x !== s); se.exdates.push(k); } }; },
  applyScope() { const se = seriesById(S.seriesId), { occ } = S.sheet, scope = document.querySelector('[name=scope]:checked')?.value || 'one';
    const st = document.getElementById('sc-start').value, en = document.getElementById('sc-end').value, c = parseCents(document.getElementById('sc-amt').value);
    if (!isTimeHM(st) || !isTimeHM(en) || st === en || c == null || c <= 0) { S.toast = { msg: 'Confira início, fim e valor.' }; return; }
    const targets = scopeTargets(S.shifts, se.id, occ, scope); const snap = JSON.stringify({ t: targets, o: se.overrides, tpl: se.tpl });
    for (const x of targets) Object.assign(x, mkShift({ title: x.title, place: x.place, start: st, end: en, amount: centsTxt(c), note: x.note, paid: false, expOverride: true, expected: x.expected_on }, day(x), true), { paid_at: null, updated_at: nowIso() });
    if (scope === 'one') se.overrides = { ...se.overrides, [occ]: { start: st, end: en } };
    if (scope === 'all') { se.tpl = { ...tplOf(se), start: st, end: en, amount_cents: c }; se.overrides = {}; }
    S.sheet = null; S.toast = { msg: `${pl(targets.length, 'plantão alterado', 'plantões alterados')}. Recebidos intactos.`, undo: () => { const o = JSON.parse(snap); o.t.forEach(b => Object.assign(byId(b.id), b)); se.overrides = o.o; se.tpl = o.tpl; } };
    persist(); render(false); document.querySelector(`[data-act="occ"][data-id="${occ}"]`)?.focus({ preventScroll: true }); return true; },
  undo() { S.toast.undo(); S.toast = null; }, toastx() { S.toast = null; },
  /* locais e modelos */
  pcolor(k) { readPlaceForm().color = k; }, pkind(k) { readPlaceForm().kind = k; }, parch() { const f = readPlaceForm(); f.archived = !f.archived; }, psave() { savePlace(); return true; },
  tarch() { const f = readTplForm(); f.archived = !f.archived; }, tsave() { saveTpl(); return true; },
  /* lixeira */
  trestore(id) { const i = S.trash.findIndex(s => s.id === id); if (i < 0) return; const [s] = S.trash.splice(i, 1); delete s.deleted_at; s.updated_at = nowIso(); S.shifts.push(s); const se = s.series && seriesById(s.series); if (se) se.exdates = se.exdates.filter(x => x !== day(s));
    S.toast = { msg: `${esc(s.title)} de ${dm(day(s))} restaurado.`, undo: () => { S.shifts = S.shifts.filter(x => x !== s); s.deleted_at = nowIso(); S.trash.push(s); if (se) se.exdates.push(day(s)); } }; },
  tempty() { openOv(`<div class="dim"></div><div class="alert" role="alertdialog" aria-modal="true" aria-labelledby="al-t" aria-describedby="al-d"><h2 id="al-t">Esvaziar a lixeira?</h2><p id="al-d">${pl(S.trash.length, 'plantão será apagado', 'plantões serão apagados')} de vez. Não dá para desfazer.</p><div class="aacts"><button data-act="delete-cancel" data-first>Cancelar</button><button class="danger" data-act="tempty-confirm">Apagar</button></div></div>`, null); return true; },
  'tempty-confirm'() { closeOv(false); S.trash = []; S.toast = { msg: 'Lixeira esvaziada.' }; persist(); render(false); return true; },
  /* dados */
  pick(kind) { const inp = document.getElementById('pick-' + kind); if (inp) { inp.value = ''; inp.click(); } return true; },
  exp(kind) { doExport(kind); return true; },
  backup() { doBackup(); return true; },
  'imp-confirm'() { return confirmImport(); }, 'imp-mode'(v) { if (S.imp) S.imp.mode = v; },
  'restore-undo'() { closeOv(false); undoRestore(); return true; },
  sample() { loadSample().then(() => { S.toast = { msg: 'Dados de exemplo carregados (fictícios). Remova em Ajustes › Seus dados.' }; persist(); go('#/calendario/' + S.sel); }).catch(e => { S.toast = { msg: String(e.message || e) }; renderToast(); }); return true; },
  'sample-remove'() { removeSample(); persist(); },
  'retry-save'() { committer?.retry(); return true; },
  update() { applyUpdate(); return true; },
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.tagName === 'A') e.preventDefault();
  const act = b.dataset.act, r = ACT[act]?.(b.dataset.id);
  if (!NO_PERSIST.has(act) && r !== true) persist();
  if (r) return;
  render(false);
  (document.querySelector(`[data-act="${act}"]${b.dataset.id ? `[data-id="${b.dataset.id}"]` : ''}`) || $app).focus({ preventScroll: true });
});
document.addEventListener('submit', e => { if (['f', 'pf', 'tf'].includes(e.target.id)) { e.preventDefault(); if (e.target.id === 'f') submitForm(); else if (e.target.id === 'pf') savePlace(); else saveTpl(); } });
document.addEventListener('input', e => {
  const t = e.target; if (t.form?.id === 'f' && ['title', 'amount', 'note'].includes(t.name)) { readForm(); refreshForm(); }
  else if (t.form?.id === 'pf' || t.form?.id === 'tf') { const f = t.form.id === 'pf' ? readPlaceForm() : readTplForm(); const e2 = t.form.id === 'pf' ? validatePlace(f) : validateTpl(f), ok = !Object.keys(e2).length; const st = document.getElementById(t.form.id + '-status'); if (st) { st.className = 'status-line ' + (ok ? 'ok' : 'warn'); st.innerHTML = ok ? `${ic('check', 14, 2.4)} Pronto para salvar` : `${ic('alert', 14, 2.2)} Falta: ${Object.values(e2).join(', ')}`; } const sv = document.querySelector('[data-act="psave"],[data-act="tsave"]'); if (sv) { if (ok) sv.removeAttribute('aria-disabled'); else sv.setAttribute('aria-disabled', 'true'); } if ((t.value || '').trim()) t.removeAttribute('aria-invalid'); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.form?.id === 'f') { readForm(); refreshForm(); } /* F01: atualização no lugar — nenhum re-render durante a edição */
  else if (t.form?.id === 'pf') readPlaceForm(); else if (t.form?.id === 'tf') { readTplForm(); const dot = t.form.querySelector('.dot'); if (dot && t.name === 'place') dot.style.cssText = t.value && S.places[t.value] ? pc(t.value) : 'display:none'; }
  else if (t.name === 'scope' && S.sheet) S.sheet.scope = t.value;
  else if (t.dataset.paid) { if (isDateKey(t.value)) { byId(t.dataset.paid).paid_at = t.value; persist(); render(false); } }
  else if (t.id?.startsWith('pick-') && t.files?.[0]) readPicked(t.id.slice(5), t.files[0]);
});
window.addEventListener('hashchange', route);

/* ---------- G2.1 · I1 reveal direto: gesto, ação em 1 toque, menu "⋯" e confirmação de exclusão ---------- */
const AW = 96;
let drag = null, swallow = null, openY = 0, OV = null;
const eat = (li, pid) => { swallow = { li, pid, t: performance.now() }; };
const openLi = () => document.querySelector('li[data-shift]:not([data-open=""])');
function setX(li, x) { li.style.setProperty('--x', x + 'px'); if (x) li.dataset.side = x < 0 ? 'pay' : 'delete'; }
function settle(li, side) {
  li.dataset.open = side; li.classList.remove('drag'); setX(li, side === 'pay' ? -AW : side ? AW : 0); clearTimeout(li._t);
  if (side) { li.classList.add('sl'); openY = scrollY; return; }
  li._t = setTimeout(() => { if (!li.dataset.open && !li.classList.contains('drag')) { li.classList.remove('sl'); li.style.minHeight = ''; delete li.dataset.side; } }, 220);
}
document.addEventListener('pointerdown', e => {
  if (!e.isPrimary || e.button > 0) return;
  swallow = null; const li = e.target.closest('li[data-shift]'), o = openLi();
  if (o && o !== li) { settle(o, ''); eat(null, e.pointerId); }
  const sf = e.target.closest('[data-swipe]');
  if (!sf || e.clientX <= 16) return;
  const op = sf.parentElement.dataset.open;
  drag = { li: sf.parentElement, sf, t: e.target, id: e.pointerId, x0: e.clientX, y0: e.clientY, base: op === 'pay' ? -AW : op ? AW : 0, x: 0, on: false };
});
document.addEventListener('pointermove', e => {
  const d = drag; if (!d || e.pointerId !== d.id) return;
  const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
  if (!d.on) {
    if (Math.abs(dx) <= 10 || Math.abs(dx) <= Math.abs(dy)) { if (Math.abs(dy) > 10) drag = null; return; }
    d.on = true; try { d.sf.setPointerCapture(e.pointerId); } catch (_) { }
    const o = openLi(); if (o && o !== d.li) settle(o, '');
    clearTimeout(d.li._t); d.li.style.minHeight = d.li.offsetHeight + 'px'; d.li.classList.add('drag', 'sl');
  }
  let x = d.base + dx; const ax = Math.abs(x);
  if (ax > AW) x = Math.sign(x) * (AW + Math.min(40, (ax - AW) * 0.3));
  d.x = x; setX(d.li, x);
});
document.addEventListener('touchmove', e => { if ((drag && drag.on) || (cg && cg.on)) e.preventDefault(); }, { passive: false });
function endDrag(e, cancel) {
  const d = drag; if (!d || e.pointerId !== d.id) return; drag = null;
  if (d.on) { eat(d.li, d.id); const x = cancel ? 0 : d.x; settle(d.li, x <= -0.4 * AW ? 'pay' : x >= 0.4 * AW ? 'delete' : ''); }
  else if (!cancel && d.li.dataset.open && !d.t.closest('[data-act="more"]')) { settle(d.li, ''); eat(d.li, d.id); }
}
document.addEventListener('pointerup', e => endDrag(e, false));
document.addEventListener('pointercancel', e => endDrag(e, true));
document.addEventListener('click', e => {
  const sw = swallow; swallow = null;
  if (!sw || !e.detail) return;
  const samePointer = e.pointerId === undefined || e.pointerId === -1 || e.pointerId === sw.pid, recent = performance.now() - sw.t < 700, sameLine = !sw.li || sw.li.contains(e.target);
  if (samePointer && recent && sameLine) { e.preventDefault(); e.stopImmediatePropagation(); }
}, true);
addEventListener('scroll', () => { const o = openLi(); if (o && !drag && Math.abs(scrollY - openY) > 10) settle(o, ''); }, { passive: true });

const $ov = document.querySelector('.app').appendChild(document.createElement('div'));
const trigger = id => (id && id !== 'x' ? document.querySelector(`li[data-shift="${CSS.escape(id)}"] [data-act="more"]`) || document.querySelector(`.del[data-id="${CSS.escape(id)}"]`) : null) || document.querySelector('[data-act="tempty"]');
function openOv(html, id) { const o = openLi(); if (o) settle(o, ''); $ov.innerHTML = html; OV = id ?? 'x'; $ov.querySelector('[data-first]').focus(); }
function closeOv(focus = true) { if (OV === null) return; const id = OV; $ov.innerHTML = ''; OV = null; if (focus) trigger(id)?.focus({ preventScroll: true }); }
function done(id) { closeOv(false); persist(); render(false); (document.querySelector(`[data-act="more"][data-id="${CSS.escape(id)}"], .sw[data-id="${CSS.escape(id)}"]`) || $app).focus({ preventScroll: true }); return true; }
function menuSheet(s) {
  const it = (a, icon, t, c = '') => `<button class="mi${c}" data-act="${a}" data-id="${s.id}"${a === 'edit' ? ' data-first' : ''}>${ic(icon, 22, 2)}<span>${t}</span></button>`;
  return `<div class="dim"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mn-t" data-menu="${s.id}">
    <div class="handle"></div><h2 id="mn-t">${esc(s.title)}</h2><p class="sub num">${esc(P(s.place).short)} · ${dm(day(s))} · ${brl(s.amount_cents)}</p>
    <div class="mlist">${it('edit', 'edit', 'Editar')}${s.paid_at ? it('unpay', 'undo', 'Desfazer recebimento') : it('pay', 'check', 'Recebi')}${it('delete', 'trash', 'Apagar', ' danger')}</div>
    <button class="btn" data-act="menu-close">Cancelar</button></div>`;
}
function confirmBox(s) {
  const se = s.series && seriesById(s.series); const fol = se ? scopeTargets(S.shifts, se.id, day(s), 'following').length : 0, all = se ? scopeTargets(S.shifts, se.id, day(s), 'all').length : 0;
  const opt = (v, t, d, chk) => `<label class="radio"><input type="radio" name="scope" value="${v}"${chk ? ' checked' : ''}><span><b>${t}</b><small>${d}</small></span></label>`;
  return `<div class="dim"></div><div class="alert" role="alertdialog" aria-modal="true" aria-labelledby="al-t" aria-describedby="al-d">
    <h2 id="al-t">Apagar ${esc(s.title)} de ${dm(day(s))}?</h2>
    <p id="al-d">${esc(P(s.place).name)} · ${brl(s.amount_cents)}. Vai para a lixeira: sai do calendário e dos totais${se ? `; é uma ocorrência da série “${esc(se.label)}”` : ''}.</p>
    ${se ? opt('one', 'Só este plantão', `${dm(day(s))} · o resto da série não muda.`, true) + opt('following', 'Este e os próximos', `${pl(fol, 'plantão não recebido', 'plantões não recebidos')} a partir de ${dm(day(s))}.`) + opt('all', 'Toda a série', `${pl(all, 'plantão não recebido', 'plantões não recebidos')}; recebidos ficam.`) : ''}
    <div class="aacts"><button data-act="delete-cancel" data-first>Cancelar</button><button class="danger" data-act="delete-confirm" data-id="${s.id}">Apagar</button></div></div>`;
}
/* apagar = lixeira (reversível); escopos de série só sobre não recebidos (SPEC §2.6) */
function doDelete(id, scope = 'one') {
  const s = byId(id); if (!s) return; const se = s.series && seriesById(s.series), k = day(s);
  const targets = se && scope !== 'one' ? scopeTargets(S.shifts, se.id, k, scope) : [s]; /* H1: nos escopos de série, recebidos nunca entram — nem a ocorrência tocada */
  if (!targets.length) { S.toast = { msg: 'Nada a apagar: plantões recebidos não entram nos escopos de série.' }; renderToast(); return; }
  const now = nowIso(), ids = new Set(targets.map(x => x.id)), removed = S.shifts.filter(x => ids.has(x.id));
  S.shifts = S.shifts.filter(x => !ids.has(x.id)); for (const x of removed) { x.deleted_at = now; S.trash.push(x); if (se) se.exdates.push(day(x)); }
  S.toast = { msg: removed.length > 1 ? `${pl(removed.length, 'plantão apagado', 'plantões apagados')} (na lixeira).` : `${esc(s.title)} de ${dm(k)} apagado.`, undo: () => { for (const x of removed) { delete x.deleted_at; S.trash = S.trash.filter(y => y !== x); S.shifts.push(x); if (se) se.exdates = se.exdates.filter(d => d !== day(x)); } } };
  persist();
  const f = () => (document.querySelector('ul.rows [data-act="open"]') || document.getElementById('dh') || $app).focus({ preventScroll: true });
  if (S.view === 'detail') { addEventListener('hashchange', f, { once: true }); go('#/calendario/' + k); } else { render(false); f(); }
}
$ov.addEventListener('click', e => { if (e.target.classList.contains('dim')) closeOv(); });
const focusable = el => !el.disabled && !el.hidden && el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length > 0; /* M2 */
document.addEventListener('keydown', e => {
  if (OV === null && S?.sheet) { /* M1: a folha de escopo se comporta como os outros diálogos */
    if (e.key === 'Escape') { e.preventDefault(); ACT.sheetx(); return; }
    if (e.key === 'Tab') { const f = [...document.querySelectorAll('.sheet button, .sheet input')].filter(focusable), i = f.indexOf(document.activeElement); if (f.length) { e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus(); } }
    return;
  }
  if (OV === null) { if (e.key === 'Escape' && openLi()) settle(openLi(), ''); return; }
  if (e.key === 'Escape') { e.preventDefault(); closeOv(); }
  else if (e.key === 'Tab') { const f = [...$ov.querySelectorAll('button, input')].filter(focusable), i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus(); }
});
window.addEventListener('hashchange', () => closeOv(false));

/* ---------- service worker: aviso de versão nova; ativação só sem gravação pendente ---------- */
let swReg = null;
async function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:' || Q.get('nosw')) return;
  try {
    swReg = await navigator.serviceWorker.register('./sw.js');
    const watch = w => { if (!w) return; w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) { S.update = w; S.toast = { msg: 'Nova versão pronta.', btn: { label: 'Atualizar', act: 'update' } }; renderToast(); } }); };
    if (swReg.waiting && navigator.serviceWorker.controller) { S.update = swReg.waiting; S.toast = { msg: 'Nova versão pronta.', btn: { label: 'Atualizar', act: 'update' } }; renderToast(); }
    swReg.addEventListener('updatefound', () => watch(swReg.installing)); watch(swReg.installing);
    const hadController = !!navigator.serviceWorker.controller; let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { /* H3/N1: aba já controlada recarrega quando um worker novo assume — mas nunca com gravação pendente ou em erro (recarrega assim que estiver 'saved'); a 1ª instalação não recarrega */
      if (!(updateApplied || hadController) || reloading) return; reloading = true;
      const tryReload = () => { if (!committer || committer.state === 'saved') return location.reload(); if (committer.state === 'error') { S.reloadWhenSaved = true; S.toast = { kind: 'save', msg: 'Nova versão ativa, mas há dados não gravados. Resolva para concluir.', btn: { label: 'Tentar de novo', act: 'retry-save' } }; renderToast(); return; } committer.whenIdle().then(tryReload); };
      tryReload(); });
  } catch (e) { console.warn('service worker indisponível:', e); }
}
let updateApplied = false;
async function applyUpdate() { const w = S.update || swReg?.waiting; if (!w) return; await committer?.whenIdle(); if (committer?.state === 'error') { S.toast = { msg: 'Há dados não gravados; resolva antes de atualizar.', btn: { label: 'Tentar de novo', act: 'retry-save' } }; renderToast(); return; } updateApplied = true; w.postMessage('SKIP_WAITING'); }

/* ---------- arranque ---------- */
async function boot() {
  let raw = { places: [], templates: [], series: [], shifts: [], meta: [] }, dbError = null;
  try { db = await openDB(); raw = await readAll(db); } catch (e) { dbError = e; }
  hydrate(raw);
  committer = createCommitter((data, expectRev) => db ? writeAll(db, data, expectRev) : Promise.reject(dbError || new Error('banco indisponível')), onSaveState, S.meta.rev || 0); /* expectRev: a revisão gravada precisa ser a que esta aba conhece (duas abas) */ /* B2: revisão durável continua da persistida */
  if (S.meta.schema_version > 1) { S.toast = { kind: 'save', msg: `Estes dados foram gravados por uma versão mais nova do app (esquema ${S.meta.schema_version}). Atualize o app antes de editar.` }; }
  if (dbError) onSaveState({ state: 'error', error: dbError, rev: 0, savedRev: 0 });
  const empty = !raw.shifts.length && !raw.places.length;
  if (empty && Q.get('sample')) { try { await loadSample(); persist(); } catch (e) { console.warn(e); } }
  addEventListener('pagehide', () => committer.flushNow()); document.addEventListener('visibilitychange', () => { if (document.hidden) committer.flushNow(); else { tick(); checkOtherTab(); } }); addEventListener('focus', checkOtherTab);
  try { S.storage = { supported: !!navigator.storage?.persist, persisted: navigator.storage?.persist ? await navigator.storage.persist() : null }; } catch (e) { S.storage = { supported: true, persisted: null, error: String(e.message || e) }; } /* M5: resultado observável em Seus dados */
  Object.defineProperty(window, '__mp', { enumerable: true, writable: false, configurable: false, value: Object.freeze({
    contract: 'g21-1', today: TODAY, version: APP_VERSION,
    shift: id => { const s = byId(id); return s ? JSON.parse(JSON.stringify(s)) : null; },
    shifts: () => S.shifts.map(s => ({ id: s.id, start: s.start, end: s.end, place: s.place, amount_cents: s.amount_cents, expected_on: s.expected_on, paid_at: s.paid_at, series: s.series })),
    series: id => { const se = seriesById(id); return se ? JSON.parse(JSON.stringify(se)) : null; },
    cohort: (ym, by) => { const c = cohort(ym, by); return { count: c.count, total: c.total, received: c.received, pending: c.pending }; },
    overdue: () => sum(overdue()), selfCheck,
    open: () => document.querySelector('li[data-shift][data-open]:not([data-open=""])')?.dataset.shift || null,
    save: () => ({ state: committer.state, rev: committer.rev, savedRev: committer.savedRev }), idle: () => committer.whenIdle(), trash: () => S.trash.map(s => s.id), meta: () => JSON.parse(JSON.stringify(S.meta)),
  }) });
  route();
  registerSW();
}
function tick() { swReg?.update().catch(() => { }); /* ao voltar ao app, procura versão nova (PWA no iPhone raramente reinicia do zero) */ if (TODAY_FIXED) return; const t = todayKey(); if (t !== TODAY) { TODAY = t; render(false); } }
setInterval(tick, 60000);
boot().catch(e => { $app.innerHTML = `<p class="empty">Não foi possível abrir o app: ${esc(String(e.message || e))}</p>`; console.error(e); });
