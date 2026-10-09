// Борд сигналов. Читает data/signals.json, ничего не пишет и никуда не ходит.

const PLATFORMS = ['tiktok', 'youtube'];
const url = new URL(window.location.href);
const state = {
  data: null,
  platform: PLATFORMS.includes(url.searchParams.get('platform')) ? url.searchParams.get('platform') : 'all',
  layout: url.searchParams.get('layout') === 'radar' ? 'radar' : 'grid',
};
const el = (id) => document.getElementById(id);
const esc = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// ——— числа и даты ————————————————————————————————————————————
const FORMS = { просмотры: ['просмотр', 'просмотра', 'просмотров'], день: ['день', 'дня', 'дней'] };
function plural(value, key) {
  const forms = FORMS[key];
  if (!forms) return key;
  if (Math.abs(value) >= 1000) return forms[2];
  const n = Math.abs(Math.trunc(value));
  if (n % 100 >= 11 && n % 100 <= 14) return forms[2];
  if (n % 10 === 1) return forms[0];
  if (n % 10 >= 2 && n % 10 <= 4) return forms[1];
  return forms[2];
}
const fmt = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)} млн` : v >= 1000 ? `${Math.round(v / 1000)} тыс` : String(v));
function when(iso) {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  return `${days} ${plural(days, 'день')} назад`;
}
function stamp(iso) {
  if (!iso) return 'ещё не собирали';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `срез ${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ——— карточка ————————————————————————————————————————————————
const EMBED = {
  youtube: (u) => { const id = (u.match(/[?&]v=([\w-]{6,})/) || [])[1]; return id && { src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`, ratio: '16 / 9' }; },
  tiktok: (u) => { const id = (u.match(/\/video\/(\d+)/) || [])[1]; return id && { src: `https://www.tiktok.com/player/v1/${id}?autoplay=1&rel=0`, ratio: '9 / 16' }; },
};
const PLAY = '<span class="play" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg></span>';

function card(post) {
  const ratio = post.format?.width ? ` style="--ratio:${post.format.width} / ${post.format.height}"` : '';
  const tip = post.about ? ` data-tip="${esc(post.about)}"` : '';
  const embed = EMBED[post.platform]?.(post.url || '');
  const frame = !post.media ? ''
    : embed
      ? `<button type="button" class="frame"${ratio}${tip} data-embed="${embed.src}" data-embed-ratio="${embed.ratio}" data-url="${esc(post.url)}" aria-label="смотреть"><img src="${post.media}" alt="" loading="lazy">${PLAY}</button>`
      : `<a class="frame" href="${esc(post.url)}" target="_blank" rel="noreferrer noopener"${ratio}${tip}><img src="${post.media}" alt="" loading="lazy"></a>`;
  const shape = post.format?.name ? `<span class="tag">${post.format.name}</span>` : '';
  return `
    <article class="card" data-id="${esc(post.id)}">
      ${frame}
      <div class="body">
        <div class="row"><span class="tag">${post.platform}</span><span class="tag">${esc(post.source)}</span>${shape}<span>${when(post.posted_at)}</span></div>
        <p class="num"><b>${post.approx ? '≈' : ''}${fmt(post.popularity)}</b> ${plural(post.popularity, post.popularity_unit)}</p>
        <h3 class="title"><a href="${esc(post.url)}" target="_blank" rel="noreferrer noopener">${esc(post.title || 'без подписи')}</a></h3>
        ${post.why ? `<p class="why">${esc(post.why)}</p>` : ''}
        ${post.remake ? `<p class="why">наша версия: ${esc(post.remake)}</p>` : ''}
      </div>
    </article>`;
}

// ——— плитка: мозаика ————————————————————————————————————————
const fitObserver = new ResizeObserver((entries) => entries.forEach(({ target }) => fit(target)));
function fit(node) {
  const gap = parseFloat(getComputedStyle(node.parentElement).columnGap) || 0;
  node.style.gridRowEnd = `span ${Math.max(1, Math.ceil((node.getBoundingClientRect().height + gap) / 4))}`;
}
function masonry() {
  fitObserver.disconnect();
  document.querySelectorAll('.grid > .card').forEach((n) => { fit(n); fitObserver.observe(n); });
}

// ——— радар ———————————————————————————————————————————————————
// сектор – площадка, от центра – свежесть, размер – место по просмотрам внутри площадки
const R = { size: 640, inner: 26, outer: 290, days: 30, sweep: 6 };
const RINGS = [[1, 'сутки'], [3, '3 дня'], [7, 'неделя'], [14, '2 недели'], [30, 'месяц']];
const radius = (days) => R.inner + (R.outer - R.inner) * Math.sqrt(Math.min(Math.max(days, 0), R.days) / R.days);
function hash(text) { let h = 2166136261; for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return ((h >>> 0) % 1000) / 1000; }

function radar(posts) {
  const platforms = PLATFORMS.filter((p) => posts.some((x) => x.platform === p));
  const span = (2 * Math.PI) / platforms.length;
  const c = R.size / 2;
  const rank = new Map();
  for (const p of platforms) {
    const list = posts.filter((x) => x.platform === p).sort((a, b) => b.popularity - a.popularity);
    list.forEach((x, i) => rank.set(x.id, list.length > 1 ? 1 - i / (list.length - 1) : 1));
  }
  const point = (deg) => { const a = ((deg - 90) * Math.PI) / 180; return [c + Math.cos(a) * R.outer, c + Math.sin(a) * R.outer]; };
  const wedges = Array.from({ length: 24 }, (_, i) => {
    const [x1, y1] = point(-(i + 1) * 2); const [x2, y2] = point(-i * 2);
    return `<path d="M${c} ${c}L${x1.toFixed(1)} ${y1.toFixed(1)}A${R.outer} ${R.outer} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}Z" fill-opacity="${(0.22 * (1 - i / 24)).toFixed(3)}"/>`;
  }).join('');
  const [bx, by] = point(0);
  const rings = RINGS.map(([d, label]) => { const r = radius(d); return `<circle cx="${c}" cy="${c}" r="${r.toFixed(1)}" class="ring"/><text x="${c + 4}" y="${(c - r + 12).toFixed(1)}" class="ring-label">${label}</text>`; }).join('');
  const sectors = platforms.map((p, i) => {
    const a0 = -Math.PI / 2 + i * span; const mid = a0 + span / 2;
    const line = platforms.length > 1 ? `<line x1="${c}" y1="${c}" x2="${(c + Math.cos(a0) * R.outer).toFixed(1)}" y2="${(c + Math.sin(a0) * R.outer).toFixed(1)}" class="axis"/>` : '';
    const cos = Math.cos(mid); const sin = Math.sin(mid);
    const anchor = cos > 0.25 ? 'start' : cos < -0.25 ? 'end' : 'middle';
    const base = sin > 0.6 ? 'hanging' : sin < -0.6 ? 'auto' : 'middle';
    return `${line}<text x="${(c + cos * (R.outer + 14)).toFixed(1)}" y="${(c + sin * (R.outer + 14)).toFixed(1)}" class="sector" text-anchor="${anchor}" dominant-baseline="${base}">${p}</text>`;
  }).join('');
  const dots = posts.map((p) => {
    const a = -Math.PI / 2 + platforms.indexOf(p.platform) * span + span * (0.12 + 0.76 * hash(p.id));
    const r = radius((Date.now() - new Date(p.posted_at).getTime()) / 86_400_000);
    const x = (c + Math.cos(a) * r).toFixed(1); const y = (c + Math.sin(a) * r).toFixed(1);
    const size = (5 + 9 * (rank.get(p.id) ?? 0)).toFixed(1);
    const turn = (((a + Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const delay = `${((turn / (2 * Math.PI)) * R.sweep).toFixed(2)}s`;
    const ping = p.picked === false ? '' : `<circle cx="${x}" cy="${y}" r="${size}" class="ping" style="animation-delay:${delay}"/>`;
    return `${ping}<circle cx="${x}" cy="${y}" r="${size}" class="dot${p.picked === false ? ' is-rest' : ''}" style="animation-delay:${delay}" data-dot="${esc(p.id)}" tabindex="0" aria-label="${esc(p.source)}"/>`;
  }).join('');
  return `<div class="radar"><svg viewBox="-110 -40 ${R.size + 220} ${R.size + 80}" role="img" aria-label="радар сигналов">${rings}<g class="sweep" style="transform-origin:${c}px ${c}px">${wedges}<line x1="${c}" y1="${c}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" class="beam"/></g>${sectors}${dots}</svg><p class="legend">сектор – площадка · ближе к центру – свежее · крупнее – больше просмотров внутри площадки · залитые – в срезе, полые – остальные посты авторов за окно</p><div class="pop" id="pop" hidden></div></div>`;
}

function fitRadar() {
  const svg = document.querySelector('.radar svg');
  if (!svg) return;
  const top = svg.getBoundingClientRect().top + window.scrollY;
  svg.style.maxHeight = `${Math.max(380, window.innerHeight - top - 60)}px`;
  const extra = document.documentElement.scrollHeight - window.innerHeight;
  if (extra > 0) svg.style.maxHeight = `${Math.max(380, parseFloat(svg.style.maxHeight) - extra - 2)}px`;
}

function wireRadar() {
  let pinned = false; let timer = null;
  const show = (dot) => {
    const pop = el('pop'); const post = state.data.signals.find((p) => p.id === dot.dataset.dot);
    if (!pop || !post) return;
    clearTimeout(timer);
    if (pop.dataset.id !== post.id) {
      pop.innerHTML = card(post); pop.dataset.id = post.id;
      const ratio = post.format?.width ? post.format.width / post.format.height : 1;
      const vertical = ratio < 0.9;
      pop.classList.toggle('is-vertical', vertical);
      const frame = pop.querySelector('.frame');
      if (vertical) { const w = Math.round(380 * ratio); if (frame) frame.style.width = `${w}px`; pop.style.width = `${w + 280}px`; }
      else pop.style.width = '340px';
    }
    pop.hidden = false;
    const wrap = pop.parentElement.getBoundingClientRect(); const d = dot.getBoundingClientRect();
    let left = d.right - wrap.left + 12;
    if (left + pop.offsetWidth > wrap.width) left = d.left - wrap.left - pop.offsetWidth - 12;
    pop.style.left = `${Math.max(0, left)}px`;
    pop.style.top = `${Math.max(0, Math.min(d.top - wrap.top - pop.offsetHeight / 2, wrap.height - pop.offsetHeight))}px`;
    document.querySelectorAll('.dot.is-active').forEach((n) => n.classList.remove('is-active'));
    dot.classList.add('is-active');
  };
  const hide = () => { if (pinned) return; clearTimeout(timer); timer = setTimeout(() => { const pop = el('pop'); if (pop) pop.hidden = true; document.querySelectorAll('.dot.is-active').forEach((n) => n.classList.remove('is-active')); }, 220); };
  document.addEventListener('mouseover', (e) => { const dot = e.target.closest('.dot'); if (dot && !pinned) show(dot); else if (e.target.closest('#pop')) clearTimeout(timer); });
  document.addEventListener('mouseout', (e) => { if (e.target.closest('.dot') || e.target.closest('#pop')) hide(); });
  document.addEventListener('click', (e) => { const dot = e.target.closest('.dot'); if (dot) { pinned = true; show(dot); return; } if (!e.target.closest('#pop') && pinned) { pinned = false; hide(); } });
}

// ——— плееры и подсказки ——————————————————————————————————————
function wirePlay() {
  document.addEventListener('click', (e) => {
    const button = e.target.closest('button.frame');
    if (!button) return;
    const box = document.createElement('div');
    box.className = 'frame';
    box.style.setProperty('--ratio', button.dataset.embedRatio);
    if (button.style.width) box.style.width = button.style.width;
    const player = document.createElement('iframe');
    player.src = button.dataset.embed;
    player.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    player.allowFullscreen = true;
    box.append(player);
    button.replaceWith(box);
    const note = document.createElement('p');
    note.className = 'fallback';
    note.innerHTML = `<a href="${esc(button.dataset.url)}" target="_blank" rel="noreferrer noopener">пусто в плеере – открыть на площадке</a>`;
    box.after(note);
  });
}

function wireTips() {
  const tip = document.createElement('div');
  tip.className = 'tip';
  document.body.append(tip);
  let current = null;
  document.addEventListener('mousemove', (e) => {
    const node = e.target.closest('[data-tip]');
    if (!node) { if (current) { current = null; tip.classList.remove('on'); } return; }
    if (node !== current) {
      current = node;
      tip.innerHTML = `<b>о чём пост</b>${esc(node.dataset.tip)}<i>по подписи, ролик не расшифрован</i>`;
      tip.classList.add('on');
    }
    const x = Math.min(Math.max(12, e.clientX - tip.offsetWidth / 2), innerWidth - tip.offsetWidth - 12);
    let y = e.clientY - tip.offsetHeight - 16;
    if (y < 8) y = e.clientY + 20;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  });
  document.addEventListener('scroll', () => { current = null; tip.classList.remove('on'); }, true);
}

// ——— разделы ————————————————————————————————————————————————
function setParam(key, value, empty) {
  const u = new URL(window.location.href);
  if (value === empty) u.searchParams.delete(key); else u.searchParams.set(key, value);
  window.history.replaceState(null, '', u);
}

function renderDigest() {
  // Плитка – посты, которые бывали в срезе; радар – все посты авторов за окно.
  const every = state.data.signals || [];
  const all = state.layout === 'radar' ? every : every.filter((p) => p.picked !== false);
  const present = PLATFORMS.filter((p) => all.some((x) => x.platform === p));
  const chip = (v, label, n) => `<button type="button" class="chip${state.platform === v ? ' is-active' : ''}" data-platform="${v}">${label} <b>${n}</b></button>`;
  el('platforms').innerHTML = [chip('all', 'все', all.length), ...present.map((p) => chip(p, p, all.filter((x) => x.platform === p).length))].join('');
  document.querySelectorAll('#layouts .chip').forEach((b) => b.classList.toggle('is-active', b.dataset.layout === state.layout));

  const posts = (state.platform === 'all' ? all : all.filter((p) => p.platform === state.platform))
    .slice().sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at));
  if (!posts.length) {
    el('digest').innerHTML = '<p class="empty">постов пока нет: сбор ещё не запускался или авторы ничего не публиковали за окно</p>';
    return;
  }
  el('digest').innerHTML = state.layout === 'radar' ? radar(posts) : `<div class="grid">${posts.map(card).join('')}</div>`;
  masonry();
  fitRadar();
}

function renderSources() {
  const rows = state.data.source_report || [];
  el('sources').innerHTML = rows.length
    ? rows.map((r) => `<div class="src"><span>${esc(r.source)}</span>${r.ok ? `<span>${r.fresh} за окно из ${r.scanned}</span>` : `<span class="bad">${esc(r.error)}</span>`}</div>`).join('')
    : '<p class="empty">отчёта ещё нет</p>';
}

function switchView(view) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((p) => p.classList.toggle('is-active', p.dataset.panel === view));
  if (view === 'digest') fitRadar();
}

async function boot() {
  const data = await fetch('./data/signals.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { signals: [] })).catch(() => ({ signals: [] }));
  state.data = { signals: [], ...data };
  if (data.theme) { el('theme').textContent = `что залетело: ${data.theme}`; document.title = `сигналы · ${data.theme}`; }
  el('stamp').textContent = `${stamp(data.generated_at)} · tiktok и youtube · окно ${data.window_days || 7} ${plural(data.window_days || 7, 'день')}`;
  if (data.summary) { el('summary').textContent = data.summary; el('summary').hidden = false; }
  renderDigest();
  renderSources();
  document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => switchView(b.dataset.view); });
  el('platforms').addEventListener('click', (e) => { const b = e.target.closest('[data-platform]'); if (!b) return; state.platform = b.dataset.platform; setParam('platform', state.platform, 'all'); renderDigest(); });
  el('layouts').addEventListener('click', (e) => { const b = e.target.closest('[data-layout]'); if (!b) return; state.layout = b.dataset.layout; setParam('layout', state.layout, 'grid'); renderDigest(); });
  window.addEventListener('resize', fitRadar);
  wirePlay();
  wireTips();
  wireRadar();
}

boot();
