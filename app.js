'use strict';
/* ---------- storage (IndexedDB) ---------- */
const DB = (() => {
  let db;
  const open = () => db ? Promise.resolve(db) : new Promise((res, rej) => {
    const r = indexedDB.open('recipe-izer9000', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('recipes')) d.createObjectStore('recipes', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('pantry')) d.createObjectStore('pantry', { keyPath: 'id' });
    };
    r.onsuccess = () => res(db = r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => res(out && out.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    all: st => tx(st, 'readonly', s => s.getAll()),
    put: (st, v) => tx(st, 'readwrite', s => s.put(v)),
    del: (st, id) => tx(st, 'readwrite', s => s.delete(id)),
  };
})();

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const lines = t => String(t || '').split('\n').map(s => s.trim()).filter(Boolean);
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
const view = $('#view');
let tab = 'list', recipes = [], pantry = [], editing = null, current = null, target = null, doneSteps = new Set(), query = '', pQuery = '';
let pEditing = null, pDraft = null, pReturn = null;
let cur = localStorage.getItem('currency') || '$';
const money = n => n == null ? '—' : (n < 0 ? '-' : '') + cur + Math.abs(n).toFixed(2);

/* ---------- quantity parsing & scaling ---------- */
const UNI = { '½': '1/2', '⅓': '1/3', '⅔': '2/3', '¼': '1/4', '¾': '3/4', '⅕': '1/5', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8' };
const NUM = String.raw`\d+\s+\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+`;
const QTY_RE = new RegExp(String.raw`^(${NUM})(?:\s*(?:-|–|to)\s*(${NUM}))?\s*(.*)$`, 'i');
const toNum = s => {
  s = s.trim();
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/); if (m) return +m[1] + m[2] / m[3];
  m = s.match(/^(\d+)\/(\d+)$/); if (m) return m[1] / m[2];
  return parseFloat(s);
};
// One ingredient line -> {hdr} | {qty, qty2, rest} | {text}
function parseIng(line) {
  if (/:$/.test(line)) return { hdr: line.slice(0, -1) };
  const norm = line.replace(/(\d)?([½⅓⅔¼¾⅕⅛⅜⅝⅞])/g, (_, d, f) => (d ? d + ' ' : '') + UNI[f]);
  const m = norm.match(QTY_RE);
  if (!m) return { text: line };
  return { qty: toNum(m[1]), qty2: m[2] ? toNum(m[2]) : null, rest: m[3] };
}
const FRACS = [[0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞'], [1, '']];
const METRIC = /^(g|grams?|kg|ml|millilit(er|re)s?|l|lit(er|re)s?)\b/i;
function fmt(n, rest = '') {
  if (!isFinite(n) || n <= 0) return '0';
  if (METRIC.test(rest)) return n >= 10 ? String(Math.round(n)) : String(+n.toFixed(1));
  if (n >= 20) return String(Math.round(n));
  let whole = Math.floor(n), frac = n - whole, best = FRACS[0];
  for (const f of FRACS) if (Math.abs(frac - f[0]) < Math.abs(frac - best[0])) best = f;
  if (Math.abs(frac - best[0]) > 0.04) return String(+n.toFixed(2));
  if (best[0] === 1) { whole++; best = FRACS[0]; }
  return whole ? whole + best[1] : best[1] || '0';
}
function ingHtml(line, factor) {
  const p = parseIng(line);
  if (p.hdr) return `<li class="hdr">${esc(p.hdr)}</li>`;
  if (p.text) return `<li>${esc(p.text)}</li>`;
  const q = fmt(p.qty * factor, p.rest) + (p.qty2 != null ? '–' + fmt(p.qty2 * factor, p.rest) : '');
  return `<li><span class="q">${esc(q)}</span>${esc(p.rest)}</li>`;
}
const factorOf = r => (target || r.servings) / r.servings;

/* ---------- units ---------- */
// dim: mass (grams), vol (ml), or a count unit name. Case-sensitive t/T handled first.
const UNITS = [
  [/^T\b\.?/, 'tbsp'], [/^t\b\.?/, 'tsp'],
  [/^(fl\.?\s*oz|fluid\s+ounces?)\b\.?/i, 'floz'],
  [/^(tsp|teaspoons?)\b\.?/i, 'tsp'], [/^(tbsp|tbs|tbl|tablespoons?)\b\.?/i, 'tbsp'],
  [/^(cups?|c)\b\.?/i, 'cup'], [/^(pints?|pt)\b\.?/i, 'pt'], [/^(quarts?|qt)\b\.?/i, 'qt'], [/^(gallons?|gal)\b\.?/i, 'gal'],
  [/^(ml|millilit(?:er|re)s?)\b\.?/i, 'ml'], [/^(l|lit(?:er|re)s?)\b\.?/i, 'l'],
  [/^(mg|milligrams?)\b\.?/i, 'mg'], [/^(g|grams?)\b\.?/i, 'g'], [/^(kg|kilos?|kilograms?)\b\.?/i, 'kg'],
  [/^(oz|ounces?)\b\.?/i, 'oz'], [/^(lbs?|pounds?)\b\.?/i, 'lb'],
  [/^(each|ea|pieces?|pcs?|whole|large|medium|small)\b\.?/i, 'each'],
  [/^(cloves?)\b/i, 'clove'], [/^(cans?|tins?)\b/i, 'can'], [/^(slices?)\b/i, 'slice'], [/^(sticks?)\b/i, 'stick'],
  [/^(packages?|pkgs?|packets?)\b\.?/i, 'pkg'], [/^(bunch|bunches)\b/i, 'bunch'], [/^(heads?)\b/i, 'head'],
  [/^(pinch|pinches)\b/i, 'pinch'], [/^(dash|dashes)\b/i, 'dash'], [/^(jars?)\b/i, 'jar'], [/^(bottles?)\b/i, 'bottle'], [/^(sprigs?)\b/i, 'sprig'],
];
const MASS = { mg: 0.001, g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
const VOL = { ml: 1, l: 1000, tsp: 4.92892, tbsp: 14.7868, floz: 29.5735, cup: 236.588, pt: 473.176, qt: 946.353, gal: 3785.41 };
const UNIT_LIST = ['g', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'floz', 'pt', 'qt', 'gal', 'each', 'clove', 'can', 'slice', 'stick', 'pkg', 'bunch', 'head', 'jar', 'bottle'];
function splitUnit(rest) { // -> {unit, name}
  let s = rest.replace(/^\([^)]*\)\s*/, '');
  for (const [re, u] of UNITS) { const m = s.match(re); if (m) return { unit: u, name: s.slice(m[0].length).replace(/^\s*(of\s+)?/i, '') }; }
  return { unit: 'each', name: s };
}
const normUnit = u => { u = String(u || '').trim(); if (!u) return 'each'; for (const [re, k] of UNITS) { const m = u.match(re); if (m && m[0].length === u.length) return k; } return u.toLowerCase(); };
const dimOf = u => MASS[u] ? 'mass' : VOL[u] ? 'vol' : u;
function toGrams(q, u, item) {
  if (MASS[u]) return q * MASS[u];
  if (VOL[u] && item.gPerCup) return q * VOL[u] / VOL.cup * item.gPerCup;
  if (u === 'each' && item.gEach) return q * item.gEach;
  return null;
}
// Convert q of unit u into how many of unit `to` for this pantry item, or null if impossible.
function convert(q, u, to, item) {
  if (u === to) return q;
  const d = dimOf(u);
  if (d === dimOf(to) && (d === 'mass' || d === 'vol')) return d === 'mass' ? q * MASS[u] / MASS[to] : q * VOL[u] / VOL[to];
  const a = toGrams(q, u, item), b = toGrams(1, to, item);
  return a != null && b ? a / b : null;
}

/* ---------- pantry matching, nutrition & cost ---------- */
const NUTR = [['kcal', 'Calories', ''], ['protein', 'Protein', 'g'], ['carbs', 'Carbs', 'g'], ['fat', 'Fat', 'g'], ['fiber', 'Fiber', 'g'], ['sugar', 'Sugar', 'g'], ['sodium', 'Sodium', 'mg']];
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function matchPantry(text) {
  const t = text.toLowerCase(); let best = null, len = 0;
  for (const p of pantry) for (const n of [p.name, ...String(p.aliases || '').split(',')].map(s => s.trim().toLowerCase()).filter(Boolean))
    if (n.length > len && new RegExp(`(^|\\W)${reEsc(n)}(s|es)?(\\W|$)`).test(t)) { best = p; len = n.length; }
  return best;
}
function analyze(r) { // totals for ONE base batch
  const rows = [], tot = { cost: 0 }; NUTR.forEach(([k]) => tot[k] = 0);
  let ingCount = 0, costOk = 0, nutOk = 0;
  for (const line of lines(r.ingredients)) {
    const p = parseIng(line); if (p.hdr) continue;
    if (!p.text) ingCount++; // "salt to taste" etc. can't be costed, so don't count it as missing
    const row = { line, item: matchPantry(p.rest || p.text) };
    if (!row.item) row.issue = 'not in pantry';
    else if (p.text) row.issue = 'no amount';
    else {
      const qty = p.qty2 != null ? (p.qty + p.qty2) / 2 : p.qty, { unit } = splitUnit(p.rest), it = row.item;
      if (it.price != null && it.priceQty) {
        const n = convert(qty, unit, normUnit(it.priceUnit), it);
        if (n != null) { row.cost = n / it.priceQty * it.price; tot.cost += row.cost; costOk++; } else row.issue = `can't convert ${unit} → ${it.priceUnit}`;
      }
      if (it.nQty && it.kcal != null) {
        const n = convert(qty, unit, normUnit(it.nUnit), it);
        if (n != null) { row.kcal = n / it.nQty * it.kcal; NUTR.forEach(([k]) => tot[k] += it[k] != null ? n / it.nQty * it[k] : 0); nutOk++; }
        else row.issue = `can't convert ${unit} → ${it.nUnit}`;
      }
    }
    rows.push(row);
  }
  return { rows, tot, ingCount, costOk, nutOk };
}
function guessName(line) {
  const p = parseIng(line); if (p.text) return p.text;
  return splitUnit(p.rest).name.split(',')[0].trim();
}

/* ---------- rendering ---------- */
async function refresh() { [recipes, pantry] = await Promise.all([DB.all('recipes'), DB.all('pantry')]); render(); }
function render() {
  const tabFor = { view: 'list', pform: 'pantry' }[tab] || tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tabFor));
  ({ list: renderList, view: renderRecipe, add: renderForm, pantry: renderPantry, pform: renderPantryForm, settings: renderSettings })[tab]();
  window.scrollTo(0, 0);
}
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { tab = b.dataset.tab; editing = null; pEditing = null; pDraft = null; render(); });
const openRecipe = r => { current = r; target = r.servings; doneSteps = new Set(); tab = 'view'; render(); };

/* Recipe list */
function renderList() {
  view.innerHTML = `<h2>Recipes (${recipes.length})</h2><input id="q" placeholder="Search name, tag or ingredient" value="${esc(query)}"><div id="items"></div>`;
  const draw = () => {
    const q = query.toLowerCase();
    const items = recipes.filter(r => (r.name + ' ' + r.tags + ' ' + r.ingredients).toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
    $('#items').innerHTML = items.map(r => `<div class="card link" data-id="${r.id}"><div class="name">${esc(r.name)}</div>
      <div class="muted small">${r.servings} portion${r.servings == 1 ? '' : 's'}${r.portion ? ' · ' + esc(r.portion) + ' each' : ''}${r.tags ? ' · ' + esc(r.tags) : ''}</div></div>`).join('')
      || `<div class="card muted">${recipes.length ? 'No matches.' : 'No recipes yet. Use <b>Add</b> to enter one.'}</div>`;
    view.querySelectorAll('[data-id]').forEach(c => c.onclick = () => openRecipe(recipes.find(r => r.id === c.dataset.id)));
  };
  $('#q').oninput = e => { query = e.target.value; draw(); };
  draw();
}

/* Single recipe */
function statRow(label, perPortion, total, fmtFn) { return `<tr><td>${label}</td><td>${fmtFn(perPortion)}</td><td>${fmtFn(total)}</td></tr>`; }
function renderRecipe() {
  const r = current; if (!r) { tab = 'list'; return render(); }
  const f = factorOf(r), A = analyze(r), per = k => A.tot[k] / r.servings;
  const presets = [0.5, 1, 2, 3].map(m => Math.max(1, Math.round(r.servings * m))).filter((v, i, a) => a.indexOf(v) === i);
  const extra = r.extraCost || 0, batchCost = A.tot.cost + extra;
  const sale = r.salePrice, profit = sale != null ? sale - batchCost : null;
  const nf = (k, u) => v => (k === 'kcal' ? Math.round(v) : v >= 10 ? Math.round(v) : +v.toFixed(1)) + (u ? ' ' + u : '');
  const coverage = (ok, what) => ok < A.ingCount ? `<p class="warn small">${A.ingCount - ok} of ${A.ingCount} ingredients missing ${what} data - totals are low. See breakdown.</p>` : '';
  const nutCard = A.nutOk ? `<div class="card"><h3 style="margin-top:0">Nutrition</h3>
      <table class="stats"><tr><th></th><th>Per portion</th><th>${+target} portions</th></tr>
      ${NUTR.map(([k, n, u]) => statRow(n, per(k), per(k) * target, nf(k, u))).join('')}</table>${coverage(A.nutOk, 'nutrition')}</div>` : '';
  const costCard = (A.costOk || extra || sale != null) ? `<div class="card"><h3 style="margin-top:0">Cost &amp; profit</h3>
      <table class="stats"><tr><th></th><th>Per portion</th><th>${+target} portions</th></tr>
      ${statRow('Ingredients', A.tot.cost / r.servings, A.tot.cost * f, money)}
      ${extra ? statRow('Other costs', extra / r.servings, extra * f, money) : ''}
      ${statRow('<b>Total cost</b>', batchCost / r.servings, batchCost * f, money)}
      ${sale != null ? statRow('Sale price', sale / r.servings, sale * f, money) + statRow('<b>Profit</b>', profit / r.servings, profit * f, v => `<b class="${v < 0 ? 'neg' : 'pos'}">${money(v)}</b>`) : ''}</table>
      ${sale ? `<p class="muted small" style="margin:8px 0 0">Margin ${Math.round(100 * profit / sale)}% · food cost ${Math.round(100 * A.tot.cost / sale)}% of sale price · sale price ${money(sale)} per batch of ${r.servings}</p>` : ''}
      ${coverage(A.costOk, 'price')}</div>` : '';
  const breakdown = A.ingCount ? `<details class="card"><summary>Ingredient breakdown (per base batch)</summary>
      <table class="stats bd"><tr><th>Ingredient</th><th>Pantry item</th><th>Cost</th><th>kcal</th></tr>
      ${A.rows.map((x, i) => `<tr><td>${esc(x.line)}</td><td>${x.item ? esc(x.item.name) : ''}${x.issue ? `<div class="warn small">${esc(x.issue)}</div>` : ''}${!x.item ? `<button class="btn alt tiny" data-np="${i}">+ Pantry</button>` : ''}</td>
        <td>${x.cost != null ? money(x.cost) : ''}</td><td>${x.kcal != null ? Math.round(x.kcal) : ''}</td></tr>`).join('')}</table></details>` : '';

  view.innerHTML = `<button class="btn alt" id="back">‹ Recipes</button>
    <h2>${esc(r.name)}</h2>
    ${r.tags || r.time ? `<div class="muted small">${[r.time, r.tags].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
    <div class="card">
      <label>Portions</label>
      <div class="scaler"><button id="minus" aria-label="Fewer portions">−</button>
        <input id="tgt" type="number" inputmode="decimal" min="0.25" step="any" value="${+target}">
        <button id="plus" aria-label="More portions">+</button>
        <span class="muted small">base: ${r.servings}${f !== 1 ? ` · ×${+f.toFixed(2)}` : ''}</span></div>
      <div class="chips">${presets.map(p => `<button data-p="${p}" class="${p == target ? 'on' : ''}">${p}</button>`).join('')}</div>
      ${r.portion ? `<p class="muted small" style="margin:10px 0 0">Portion size: <b>${esc(r.portion)}</b> each</p>` : ''}
    </div>
    <div class="card"><h3 style="margin-top:0">Ingredients</h3><ul class="ing">${lines(r.ingredients).map(l => ingHtml(l, f)).join('')}</ul></div>
    <div class="card"><h3 style="margin-top:0">Steps</h3><p class="hint" style="margin:0 0 6px">Tap a step to check it off.</p>
      <ol class="steps">${lines(r.steps).map((s, i) => `<li data-s="${i}" class="${doneSteps.has(i) ? 'done' : ''}">${esc(s)}</li>`).join('')}</ol></div>
    ${nutCard}${costCard}${breakdown}
    ${!pantry.length ? '<div class="card muted small">Add ingredients to the <b>Pantry</b> with prices and nutrition facts to see calories, cost per portion and profit here.</div>' : ''}
    ${r.notes ? `<div class="card"><h3 style="margin-top:0">Notes</h3><div style="white-space:pre-wrap">${esc(r.notes)}</div></div>` : ''}
    <button class="btn alt" id="edit">Edit</button><button class="btn alt" id="dup">Duplicate</button><button class="btn danger" id="del">Delete</button>`;
  const setT = v => { if (v > 0) { target = Math.round(v * 100) / 100; const y = window.scrollY; renderRecipe(); window.scrollTo(0, y); } };
  $('#back').onclick = () => { tab = 'list'; render(); };
  $('#minus').onclick = () => setT(target > 1 ? Math.ceil(target) - 1 : target / 2);
  $('#plus').onclick = () => setT(target < 1 ? Math.min(1, target * 2) : Math.floor(target) + 1);
  $('#tgt').onchange = e => setT(parseFloat(e.target.value));
  view.querySelectorAll('[data-p]').forEach(b => b.onclick = () => setT(+b.dataset.p));
  view.querySelectorAll('[data-s]').forEach(li => li.onclick = () => { const i = +li.dataset.s; doneSteps.has(i) ? doneSteps.delete(i) : doneSteps.add(i); li.classList.toggle('done'); });
  view.querySelectorAll('[data-np]').forEach(b => b.onclick = () => {
    const line = A.rows[+b.dataset.np].line, p = parseIng(line), u = p.rest ? splitUnit(p.rest).unit : 'each';
    pDraft = { name: guessName(line), priceUnit: u, nUnit: MASS[u] ? 'g' : u, nQty: MASS[u] ? 100 : 1 }; pReturn = r; tab = 'pform'; render();
  });
  $('#edit').onclick = () => { editing = r; tab = 'add'; render(); };
  $('#dup').onclick = async () => { const c = { ...r, id: uid(), name: r.name + ' (copy)', created: Date.now(), updated: Date.now() }; await DB.put('recipes', c); recipes = await DB.all('recipes'); openRecipe(c); };
  $('#del').onclick = async () => { if (confirm(`Delete "${r.name}"?`)) { await DB.del('recipes', r.id); current = null; tab = 'list'; refresh(); } };
}

/* Add / edit recipe */
function renderForm() {
  const r = editing || {};
  view.innerHTML = `<h2>${editing ? 'Edit recipe' : 'Add recipe'}</h2><form class="card" id="f">
    <label>Recipe name</label><input name="name" required placeholder="Grandma's chili" value="${esc(r.name)}">
    <div class="row">
      <div><label>Base portions</label><input name="servings" type="number" inputmode="decimal" min="0.25" step="any" required value="${esc(r.servings || 4)}"></div>
      <div><label>Portion size</label><input name="portion" placeholder="1½ cups" value="${esc(r.portion)}"></div>
    </div>
    <div class="row">
      <div><label>Time (optional)</label><input name="time" placeholder="45 min" value="${esc(r.time)}"></div>
      <div><label>Tags (optional)</label><input name="tags" placeholder="dinner, freezer" value="${esc(r.tags)}"></div>
    </div>
    <label>Ingredients - one per line</label>
    <textarea name="ingredients" required placeholder="2 lb ground beef&#10;1 1/2 cups diced onion&#10;2-3 cloves garlic&#10;Topping:&#10;1 cup shredded cheddar&#10;Salt to taste">${esc(r.ingredients)}</textarea>
    <p class="hint">Start a line with an amount (2, 1/2, 1 1/2, ½, 0.75, 2-3) and a unit (cup, tbsp, g, lb, can...) and it scales and is costed. Lines without an amount stay as-is. End a line with ":" for a section heading.</p>
    <label>Steps - one per line</label>
    <textarea name="steps" required placeholder="Brown the beef.&#10;Add onion and garlic, cook 5 min.">${esc(r.steps)}</textarea>
    <div class="row">
      <div><label>Sale price per batch (${esc(cur)})</label><input name="salePrice" type="number" inputmode="decimal" min="0" step="any" placeholder="optional" value="${esc(r.salePrice)}"></div>
      <div><label>Other costs per batch (${esc(cur)})</label><input name="extraCost" type="number" inputmode="decimal" min="0" step="any" placeholder="packaging, labor" value="${esc(r.extraCost)}"></div>
    </div>
    <p class="hint">A batch is the base number of portions above.</p>
    <label>Notes (optional)</label><textarea name="notes" style="min-height:70px">${esc(r.notes)}</textarea>
    <button class="btn" type="submit">Save</button><button class="btn alt" type="button" id="cancel">Cancel</button></form>`;
  $('#f').onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const servings = num(d.servings);
    if (!(servings > 0)) return alert('Base portions must be more than 0.');
    const rec = editing ? { ...editing } : { id: uid(), created: Date.now() };
    Object.assign(rec, {
      name: d.name.trim(), servings, portion: d.portion.trim(), time: d.time.trim(), tags: d.tags.trim(),
      ingredients: lines(d.ingredients).join('\n'), steps: lines(d.steps).map(s => s.replace(/^\d+[.)]\s*/, '')).join('\n'),
      salePrice: num(d.salePrice), extraCost: num(d.extraCost), notes: d.notes.trim(), updated: Date.now(),
    });
    await DB.put('recipes', rec); recipes = await DB.all('recipes');
    editing = null; openRecipe(rec);
  };
  $('#cancel').onclick = () => { const back = editing ? 'view' : 'list'; editing = null; tab = back; render(); };
}

/* Pantry */
function renderPantry() {
  view.innerHTML = `<h2>Pantry (${pantry.length})</h2>
    <p class="muted small" style="margin-top:0">Ingredients with what you pay and their nutrition facts. Recipes match these by name to work out calories and cost.</p>
    <button class="btn" id="newp">+ Add ingredient</button><input id="pq" placeholder="Search" value="${esc(pQuery)}"><div id="pitems"></div>`;
  const draw = () => {
    const q = pQuery.toLowerCase();
    const items = pantry.filter(p => (p.name + ' ' + (p.aliases || '')).toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
    $('#pitems').innerHTML = items.map(p => `<div class="card link" data-pid="${p.id}"><div class="name">${esc(p.name)}</div>
      <div class="muted small">${p.price != null ? `${money(p.price)} / ${+p.priceQty} ${esc(p.priceUnit)}` : 'no price'} · ${p.kcal != null ? `${+p.kcal} kcal / ${+p.nQty} ${esc(p.nUnit)}` : 'no nutrition'}</div></div>`).join('')
      || `<div class="card muted">${pantry.length ? 'No matches.' : 'Nothing yet.'}</div>`;
    view.querySelectorAll('[data-pid]').forEach(c => c.onclick = () => { pEditing = pantry.find(p => p.id === c.dataset.pid); tab = 'pform'; render(); });
  };
  $('#pq').oninput = e => { pQuery = e.target.value; draw(); };
  $('#newp').onclick = () => { pEditing = null; pDraft = null; tab = 'pform'; render(); };
  draw();
}
function renderPantryForm() {
  const p = pEditing || pDraft || {};
  const unitOpts = sel => `<datalist id="units">${UNIT_LIST.map(u => `<option value="${u}">`).join('')}</datalist>`;
  const nField = ([k, n, u]) => `<div><label>${n}${u ? ` (${u})` : ''}</label><input name="${k}" type="number" inputmode="decimal" min="0" step="any" value="${esc(p[k])}"></div>`;
  view.innerHTML = `<h2>${pEditing ? 'Edit ingredient' : 'Add ingredient'}</h2><form class="card" id="pf">${unitOpts()}
    <label>Name</label><input name="name" required placeholder="ground beef" value="${esc(p.name)}">
    <label>Other names (comma separated, optional)</label><input name="aliases" placeholder="hamburger, beef mince" value="${esc(p.aliases)}">
    <p class="hint">A recipe line uses this item when it contains the name or another name.</p>
    <div class="lookup"><button class="btn alt" type="button" id="usda">Look up nutrition (USDA)</button>
      <label class="inline"><input type="checkbox" id="branded"> include brand-name products</label><div id="usdaRes"></div></div>
    <h3>What you pay</h3>
    <div class="row"><div><label>Price (${esc(cur)})</label><input name="price" type="number" inputmode="decimal" min="0" step="any" placeholder="5.99" value="${esc(p.price)}"></div>
      <div><label>For amount</label><input name="priceQty" type="number" inputmode="decimal" min="0" step="any" placeholder="2" value="${esc(p.priceQty ?? 1)}"></div>
      <div><label>Unit</label><input name="priceUnit" list="units" placeholder="lb" value="${esc(p.priceUnit || 'each')}"></div></div>
    <h3>Nutrition facts</h3>
    <div class="row"><div><label>Per amount</label><input name="nQty" type="number" inputmode="decimal" min="0" step="any" value="${esc(p.nQty ?? 100)}"></div>
      <div><label>Unit</label><input name="nUnit" list="units" value="${esc(p.nUnit || 'g')}"></div></div>
    <p class="hint">Copy from the package label, e.g. per 100 g, per 1 cup, or per 1 each.</p>
    <div class="grid">${NUTR.map(nField).join('')}</div>
    <h3>Conversions (optional)</h3>
    <div class="row"><div><label>1 cup weighs (g)</label><input name="gPerCup" type="number" inputmode="decimal" min="0" step="any" value="${esc(p.gPerCup)}"></div>
      <div><label>1 each weighs (g)</label><input name="gEach" type="number" inputmode="decimal" min="0" step="any" value="${esc(p.gEach)}"></div></div>
    <p class="hint">Only needed when a recipe measures by volume (cups, tbsp) but you buy or have label data by weight, or vice versa.</p>
    <button class="btn" type="submit">Save</button><button class="btn alt" type="button" id="pcancel">Cancel</button>${pEditing ? '<button class="btn danger" type="button" id="pdel">Delete</button>' : ''}</form>`;
  const done = () => { pEditing = null; pDraft = null; if (pReturn) { const r = recipes.find(x => x.id === pReturn.id); pReturn = null; if (r) { current = r; tab = 'view'; return render(); } } tab = 'pantry'; render(); };
  $('#pf').onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const rec = pEditing ? { ...pEditing } : { id: uid(), created: Date.now() };
    Object.assign(rec, { name: d.name.trim(), aliases: d.aliases.trim(), price: num(d.price), priceQty: num(d.priceQty), priceUnit: normUnit(d.priceUnit),
      nQty: num(d.nQty), nUnit: normUnit(d.nUnit), gPerCup: num(d.gPerCup), gEach: num(d.gEach), updated: Date.now() });
    NUTR.forEach(([k]) => rec[k] = num(d[k]));
    await DB.put('pantry', rec); pantry = await DB.all('pantry'); done();
  };
  $('#pcancel').onclick = done;
  $('#usda').onclick = () => usdaSearch($('#pf'));
  const del = $('#pdel'); if (del) del.onclick = async () => { if (confirm(`Delete "${pEditing.name}" from the pantry?`)) { await DB.del('pantry', pEditing.id); pantry = await DB.all('pantry'); done(); } };
}

/* USDA FoodData Central lookup (needs internet; free API key from https://fdc.nal.usda.gov/api-key-signup) */
const FDC = 'https://api.nal.usda.gov/fdc/v1';
const fdcKey = () => localStorage.getItem('fdcKey') || 'DEMO_KEY';
const FDC_NUM = { kcal: ['208', '957', '958'], protein: ['203'], carbs: ['205'], fat: ['204'], fiber: ['291'], sugar: ['269', '269.3'], sodium: ['307'] };
function fdcNutrients(food) { // search results give values per 100 g
  const by = {}; for (const n of food.foodNutrients || []) by[n.nutrientNumber] = n.value;
  const out = {}; for (const [k, nums] of Object.entries(FDC_NUM)) { const v = nums.map(x => by[x]).find(v => v != null); out[k] = v != null ? +(+v).toFixed(2) : null; }
  return out;
}
async function fdcFetch(path, params = {}) {
  const u = new URL(FDC + path); u.searchParams.set('api_key', fdcKey());
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  if (r.status === 429) throw new Error('USDA rate limit reached. Add your own free API key on the Backup tab.');
  if (!r.ok) throw new Error(`USDA lookup failed (${r.status}).`);
  return r.json();
}
async function usdaSearch(form) {
  const box = $('#usdaRes'), q = form.elements.name.value.trim();
  if (!q) { box.innerHTML = '<p class="warn small">Type a name first.</p>'; return; }
  if (!navigator.onLine) { box.innerHTML = '<p class="warn small">Lookup needs an internet connection.</p>'; return; }
  box.innerHTML = '<p class="muted small">Searching…</p>';
  try {
    const types = $('#branded').checked ? 'Foundation,SR Legacy,Survey (FNDDS),Branded' : 'Foundation,SR Legacy,Survey (FNDDS)';
    const data = await fdcFetch('/foods/search', { query: q, pageSize: 15, dataType: types });
    const foods = data.foods || [];
    if (!foods.length) { box.innerHTML = '<p class="muted small">No matches. Try a simpler name, e.g. "onion raw".</p>'; return; }
    box.innerHTML = `<p class="muted small">Tap one to fill in nutrition per 100 g.</p>` + foods.map((f, i) => {
      const n = fdcNutrients(f);
      return `<div class="hit" data-h="${i}"><div>${esc(f.description)}${f.brandOwner ? ` <span class="muted">· ${esc(f.brandOwner)}</span>` : ''}</div>
        <div class="muted small">${n.kcal != null ? Math.round(n.kcal) + ' kcal' : '? kcal'} · P ${n.protein ?? '?'} · C ${n.carbs ?? '?'} · F ${n.fat ?? '?'} per 100 g · ${esc(f.dataType)}</div></div>`;
    }).join('');
    box.querySelectorAll('[data-h]').forEach(el => el.onclick = async () => {
      const f = foods[+el.dataset.h], n = fdcNutrients(f), E = form.elements;
      E.nQty.value = 100; E.nUnit.value = 'g';
      for (const k of Object.keys(FDC_NUM)) E[k].value = n[k] ?? '';
      box.innerHTML = `<p class="small">Filled from <b>${esc(f.description)}</b> (USDA #${f.fdcId}). Looking for cup/each weights…</p>`;
      try { // detail record has household portions (1 cup = 160 g, 1 medium = 110 g)
        const d = await fdcFetch('/food/' + f.fdcId);
        const ports = (d.foodPortions || []).map(p => ({ g: p.gramWeight / (p.amount || 1), t: `${p.measureUnit?.name || ''} ${p.modifier || ''} ${p.portionDescription || ''}`.toLowerCase() }));
        const cup = ports.find(p => /\bcup\b/.test(p.t)), each = ports.find(p => /\bmedium\b/.test(p.t)) || ports.find(p => /\b(each|whole|large|small)\b/.test(p.t));
        if (cup && !E.gPerCup.value) E.gPerCup.value = +cup.g.toFixed(1);
        if (each && !E.gEach.value) E.gEach.value = +each.g.toFixed(1);
        if (d.servingSize && /^g/i.test(d.servingSizeUnit || '') && !E.gEach.value && d.dataType === 'Branded') E.gEach.value = d.servingSize;
        box.innerHTML = `<p class="small">Filled from <b>${esc(f.description)}</b> (USDA #${f.fdcId})${cup || each ? `. Also set ${[cup && '1 cup weight', each && '1 each weight'].filter(Boolean).join(' and ')}.` : '.'} Check the numbers, then Save.</p>`;
      } catch { box.innerHTML = `<p class="small">Filled from <b>${esc(f.description)}</b> (USDA #${f.fdcId}). Check the numbers, then Save.</p>`; }
    });
  } catch (e) { box.innerHTML = `<p class="warn small">${esc(e.message || 'Lookup failed.')}</p>`; }
}

/* Backup & settings */
function renderSettings() {
  view.innerHTML = `<h2>Backup</h2><div class="card"><p>Recipes and pantry items live only on this device. Export a backup file to keep them safe or move them to another device. On a phone, Export opens the share sheet so you can save to Files, iCloud, Google Drive or email.</p>
    <button class="btn" id="exp">Export backup</button>
    <p><label>Import backup (.json) - merges with what's here (same item is overwritten)</label><input type="file" id="imp" accept=".json,application/json"></p></div>
    <div class="card"><label>Currency symbol</label><input id="cur" value="${esc(cur)}" maxlength="4" style="width:100px">
      <label>USDA API key (for nutrition lookup)</label><input id="fdck" placeholder="DEMO_KEY" value="${esc(localStorage.getItem('fdcKey') || '')}" autocapitalize="none" spellcheck="false">
      <p class="hint">Blank uses the shared DEMO_KEY, which allows only a few lookups an hour. Get your own free key at <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener">fdc.nal.usda.gov/api-key-signup</a>.</p></div>`;
  $('#cur').onchange = e => { cur = e.target.value.trim() || '$'; localStorage.setItem('currency', cur); };
  $('#fdck').onchange = e => { const k = e.target.value.trim(); k ? localStorage.setItem('fdcKey', k) : localStorage.removeItem('fdcKey'); };
  $('#exp').onclick = async () => {
    const name = `recipes-${new Date().toISOString().slice(0, 10)}.json`;
    const json = JSON.stringify({ app: 'recipe-izer9000', version: 2, recipes, pantry }, null, 1);
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Recipe backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('#imp').onchange = async e => {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      const rs = (Array.isArray(data) ? data : data.recipes || []).filter(r => r.id && r.name && r.servings > 0);
      const ps = (data.pantry || []).filter(p => p.id && p.name);
      for (const r of rs) await DB.put('recipes', { portion: '', time: '', tags: '', ingredients: '', steps: '', notes: '', ...r });
      for (const p of ps) await DB.put('pantry', p);
      alert(`Imported ${rs.length} recipes and ${ps.length} pantry items.`); tab = 'list'; refresh();
    } catch { alert('That file could not be read.'); }
  };
}

/* ---------- boot ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
refresh();
