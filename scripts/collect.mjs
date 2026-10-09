// Сбор сигналов: самые популярные посты отслеживаемых авторов TikTok и YouTube.
//
//   node scripts/collect.mjs              собрать и записать site/data/signals.json
//   node scripts/collect.mjs --dry-run    собрать и напечатать, ничего не писать
//   node scripts/collect.mjs --probe tiktok:handle,youtube:handle
//                                         проверить, читаются ли аккаунты
//
// Ключи не нужны: TikTok читается с публичных embed-страниц, YouTube – со
// страницы канала и страницы ролика. Все настройки – в signals.config.json.

import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'signals.config.json');
const DATA_PATH = path.join(ROOT, 'site', 'data', 'signals.json');
const MEDIA_DIR = path.join(ROOT, 'site', 'data', 'media');

const UA = 'signals-board/1.0 (weekly popular-posts collector)';
const DRY_RUN = process.argv.includes('--dry-run');
const GAP_MS = 1100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function entry(item) {
  if (typeof item === 'string') return { handle: item.replace(/^@/, ''), person: item.replace(/^@/, '').toLowerCase() };
  const handle = String(item.handle || '').replace(/^@/, '');
  return { handle, channelId: item.channel_id || null, person: String(item.person || handle).toLowerCase() };
}

// ——— формат кадра ————————————————————————————————————————————
function shapeOf(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || !width || !height) return null;
  const ratio = width / height;
  const name = ratio < 0.7 ? 'вертикальный 9:16'
    : ratio < 0.95 ? 'вертикальный 4:5'
      : ratio < 1.05 ? 'квадрат 1:1'
        : ratio < 1.5 ? 'горизонтальный 4:3'
          : ratio < 2 ? 'горизонтальный 16:9'
            : 'ультраширокий';
  return { width, height, ratio: Number(ratio.toFixed(2)), name };
}

function dimensionsFromBytes(buffer) {
  if (buffer.length > 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
    if (chunk === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + size;
    }
  }
  return null;
}

// ——— tiktok ——————————————————————————————————————————————————
async function tiktokProfile(handle) {
  const res = await fetch(`https://www.tiktok.com/embed/@${encodeURIComponent(handle)}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(25_000),
  });
  const html = await res.text();
  if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
  const match = html.match(/id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error(html.includes('overload-protect') ? 'tiktok временно придерживает запросы (overload-protect)' : 'аккаунт не найден или закрыт');
  const page = (JSON.parse(match[1])?.source?.data || {})[`/embed/@${handle}`];
  if (!page || !Array.isArray(page.videoList)) throw new Error('список видео пуст');
  return page;
}

// id видео – snowflake: старшие 32 бита это время публикации в секундах.
function tiktokCreatedAt(id) {
  try {
    const seconds = Number(BigInt(String(id)) >> 32n);
    return seconds > 1_400_000_000 ? new Date(seconds * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

async function collectTiktok(list, windowStart, report) {
  const out = [];
  for (const item of list) {
    const { handle, person } = entry(item);
    try {
      const page = await tiktokProfile(handle);
      let fresh = 0;
      for (const video of page.videoList) {
        if (!video?.id || video.privateItem) continue;
        const createdAt = tiktokCreatedAt(video.id);
        if (!createdAt || new Date(createdAt).getTime() < windowStart) continue;
        fresh += 1;
        out.push({
          id: `tiktok:${video.id}`,
          platform: 'tiktok',
          source: `@${handle}`,
          person,
          url: `https://www.tiktok.com/@${handle}/video/${video.id}`,
          title: String(video.desc || '').slice(0, 200),
          posted_at: createdAt,
          popularity: Number(video.playCount) || 0,
          popularity_unit: 'просмотры',
          metrics: { followers: Number(page.userInfo?.followerCount) || null },
          format: { kind: 'видео', ...(shapeOf(Number(video.width), Number(video.height)) || {}) },
          media_origin: video.originCoverUrl || video.coverUrl || null,
        });
      }
      report.push({ source: `tiktok/${handle}`, ok: true, scanned: page.videoList.length, fresh });
    } catch (error) {
      report.push({ source: `tiktok/${handle}`, ok: false, error: String(error.message || error) });
    }
    await sleep(GAP_MS);
  }
  return out;
}

// ——— youtube —————————————————————————————————————————————————
// Список роликов – со страницы канала /videos (ytInitialData), точные просмотры
// и дата – со страницы ролика. Если страница ролика пришла без чисел, берутся
// округлённые просмотры и возраст со страницы канала, пост помечается approx.
const AGE_UNITS = { s: 1 / 86400, sec: 1 / 86400, m: 1 / 1440, min: 1 / 1440, h: 1 / 24, hour: 1 / 24, d: 1, day: 1, w: 7, week: 7, mo: 30, month: 30, y: 365, year: 365 };

function ageDays(text) {
  const m = String(text || '').toLowerCase().match(/(\d+)\s*(mo|month|min|sec|hour|day|week|year|[smhdwy])/);
  return m ? Number(m[1]) * (AGE_UNITS[m[2]] ?? 1) : null;
}

function roundedViews(text) {
  const m = String(text || '').trim().match(/^([\d.,]+)\s*([KMB])?/i);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ''));
  const scale = { K: 1e3, M: 1e6, B: 1e9 }[String(m[2] || '').toUpperCase()] || 1;
  return Number.isFinite(base) ? Math.round(base * scale) : null;
}

async function youtubePage(url) {
  let status = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(25_000) });
    status = res.status;
    if (res.ok) return res.text();
    await sleep(4000);
  }
  throw new Error(`HTTP ${status}`);
}

async function youtubeChannelId(handle) {
  const html = await youtubePage(`https://www.youtube.com/@${encodeURIComponent(handle)}`);
  const id = (html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{20,})"/)
    || html.match(/feeds\/videos\.xml\?channel_id=(UC[\w-]{20,})/)
    || html.match(/"channelId":"(UC[\w-]{20,})"/) || [])[1];
  if (!id) throw new Error('канал не найден');
  return id;
}

function youtubeLockups(html) {
  const raw = (html.match(/(?:var ytInitialData|window\["ytInitialData"\])\s*=\s*(\{[\s\S]*?\});\s*<\/script>/) || [])[1];
  if (!raw) throw new Error('на странице канала нет списка роликов');
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.lockupViewModel) found.push(node.lockupViewModel);
    for (const value of Object.values(node)) walk(value);
  };
  walk(JSON.parse(raw));
  return found.map((lockup) => {
    const meta = lockup.metadata?.lockupMetadataViewModel || {};
    const parts = (meta.metadata?.contentMetadataViewModel?.metadataRows || [])
      .flatMap((row) => row.metadataParts || []).map((part) => part.text?.content || '');
    return {
      id: lockup.contentId,
      title: meta.title?.content || '',
      age: ageDays(parts.find((part) => /ago/i.test(part))),
      views: roundedViews(parts.find((part) => /^[\d.,]+\s*[KMB]?(\s*views?)?$/i.test(part.trim()))),
    };
  }).filter((item) => item.id);
}

async function youtubeVideo(id) {
  const html = await youtubePage(`https://www.youtube.com/watch?v=${id}`);
  return {
    views: Number((html.match(/"viewCount":"(\d+)"/) || [])[1]) || 0,
    published: (html.match(/"publishDate":"([^"]+)"/) || html.match(/"uploadDate":"([^"]+)"/) || [])[1] || null,
  };
}

async function collectYoutube(list, windowStart, windowDays, report) {
  const out = [];
  for (const item of list) {
    const { handle, channelId, person } = entry(item);
    try {
      const id = channelId || (await youtubeChannelId(handle));
      const videos = youtubeLockups(await youtubePage(`https://www.youtube.com/channel/${id}/videos`));
      const candidates = videos.filter((v) => v.age === null || v.age <= windowDays + 1).slice(0, 10);
      let fresh = 0;
      for (const video of candidates) {
        await sleep(GAP_MS);
        const exact = await youtubeVideo(video.id).catch(() => ({ views: 0, published: null }));
        const approx = !exact.published || !exact.views;
        const published = exact.published || (video.age !== null ? new Date(Date.now() - video.age * 86_400_000).toISOString() : null);
        if (!published || new Date(published).getTime() < windowStart) continue;
        fresh += 1;
        out.push({
          id: `youtube:${video.id}`,
          platform: 'youtube',
          source: `@${handle}`,
          person,
          url: `https://www.youtube.com/watch?v=${video.id}`,
          title: video.title.slice(0, 200),
          posted_at: new Date(published).toISOString(),
          popularity: exact.views || video.views || 0,
          popularity_unit: 'просмотры',
          metrics: { followers: null },
          ...(approx ? { approx: true } : {}),
          format: { kind: 'видео' },
          media_origin: `https://i.ytimg.com/vi/${video.id}/maxresdefault.jpg`,
          media_fallback: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
        });
      }
      report.push({ source: `youtube/${handle}`, ok: true, scanned: videos.length, fresh });
    } catch (error) {
      report.push({ source: `youtube/${handle}`, ok: false, error: String(error.message || error) });
    }
    await sleep(GAP_MS * 3);
  }
  return out;
}

// ——— кадры ———————————————————————————————————————————————————
// Ссылки на обложки TikTok подписанные и истекают, поэтому кадр сохраняется
// себе. Ролики не сохраняются: на борде играют встроенные плееры площадок.
async function saveMedia(signal) {
  const sources = [signal.media_origin, signal.media_fallback].filter(Boolean);
  if (!sources.length) return { file: null, dimensions: null };
  const name = `${signal.platform}-${createHash('sha1').update(signal.id).digest('hex').slice(0, 12)}.jpg`;
  for (const source of sources) {
    try {
      const res = await fetch(source, { headers: { 'User-Agent': UA } });
      if (!res.ok) continue;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length < 1024) continue;
      if (!DRY_RUN) {
        await mkdir(MEDIA_DIR, { recursive: true });
        await writeFile(path.join(MEDIA_DIR, name), bytes);
      }
      return { file: `data/media/${name}`, dimensions: dimensionsFromBytes(bytes) };
    } catch {
      // следующий источник
    }
  }
  return { file: null, dimensions: null };
}

// ——— проверка аккаунтов ——————————————————————————————————————
async function probe(spec) {
  for (const raw of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [platform, handle] = raw.includes(':') ? raw.split(':') : ['tiktok', raw];
    try {
      if (platform === 'youtube') {
        const id = await youtubeChannelId(handle.replace(/^@/, ''));
        const videos = youtubeLockups(await youtubePage(`https://www.youtube.com/channel/${id}/videos`));
        const month = videos.filter((v) => v.age !== null && v.age <= 30).length;
        console.log(`ok   youtube/${handle} · канал ${id} · роликов за 30 дней: ${month}`);
      } else {
        const page = await tiktokProfile(handle.replace(/^@/, ''));
        const month = page.videoList.filter((v) => {
          const at = tiktokCreatedAt(v.id);
          return at && Date.now() - new Date(at).getTime() < 30 * 86_400_000;
        }).length;
        console.log(`ok   tiktok/${handle} · подписчиков ${page.userInfo?.followerCount ?? '–'} · роликов за 30 дней: ${month}`);
      }
    } catch (error) {
      console.log(`нет  ${platform}/${handle} · ${error.message || error}`);
    }
    await sleep(GAP_MS * 2);
  }
}

// ——— отбор ———————————————————————————————————————————————————
async function main() {
  const probeAt = process.argv.indexOf('--probe');
  if (probeAt !== -1) {
    await probe(process.argv[probeAt + 1] || '');
    return;
  }

  const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const windowDays = Number(config.window_days) || 7;
  const topPerPlatform = Number(config.top_per_platform) || 3;
  const windowStart = Date.now() - windowDays * 86_400_000;

  let library = { signals: [] };
  try {
    library = JSON.parse(await readFile(DATA_PATH, 'utf8'));
  } catch {
    // первый прогон
  }
  // Новая тема – чистый лист: репозиторий из шаблона приходит с данными
  // примера. Посты авторов, которых убрали из конфига, тоже уходят.
  if ((library.theme || '') !== (config.theme || '')) library = { signals: [] };
  const handleOf = (a) => String(typeof a === 'string' ? a : a?.handle || '').replace(/^@/, '').toLowerCase();
  const authors = new Set([...(config.tiktok || []).map((a) => `tiktok @${handleOf(a)}`), ...(config.youtube || []).map((a) => `youtube @${handleOf(a)}`)]);
  library.signals = (library.signals || []).filter((s) => authors.has(`${s.platform} ${String(s.source).toLowerCase()}`));
  const previous = new Map((library.signals || []).map((s) => [s.id, s]));

  const report = [];
  const found = [
    ...(await collectTiktok(config.tiktok || [], windowStart, report)),
    ...(await collectYoutube(config.youtube || [], windowStart, windowDays, report)),
  ];

  // Лучшие за окно: по top_per_platform с площадки, один пост на аккаунт.
  // Числа сравниваются только внутри площадки.
  const byPlatform = new Map();
  for (const post of found) byPlatform.set(post.platform, [...(byPlatform.get(post.platform) || []), post]);
  const top = [];
  for (const [, list] of byPlatform) {
    list.sort((a, b) => b.popularity - a.popularity);
    const seen = new Set();
    for (const post of list) {
      if (top.filter((p) => p.platform === post.platform).length >= topPerPlatform) break;
      if (seen.has(post.source)) continue;
      seen.add(post.source);
      top.push(post);
    }
  }

  // Один человек – один пост: если автор ведёт обе площадки, остаётся пост с
  // площадки, где у него больше подписчиков (а при равенстве – первый найденный).
  const personOf = (post) => post.person || String(post.source).toLowerCase();
  const byPerson = new Map();
  for (const post of top) {
    const kept = byPerson.get(personOf(post));
    if (!kept || (post.metrics?.followers || 0) > (kept.metrics?.followers || 0)) byPerson.set(personOf(post), post);
  }
  const slice = [...byPerson.values()].sort((a, b) => b.popularity - a.popularity);

  // Плюс лучший пост последних суток с каждой площадки от автора, которого ещё
  // нет в срезе: недельный отбор отдаёт верх постам трёх-пятидневной давности.
  const dayStart = Date.now() - 86_400_000;
  const people = new Set(slice.map(personOf));
  for (const [, list] of byPlatform) {
    const best = list
      .filter((s) => !slice.includes(s) && !people.has(personOf(s)) && new Date(s.posted_at).getTime() >= dayStart)
      .sort((a, b) => b.popularity - a.popularity)[0];
    if (!best) continue;
    slice.push(best);
    people.add(personOf(best));
  }

  // Остальные посты окна идут на радар с picked: false. Пост, который уже
  // бывал в срезе, остаётся в срезе и в плитке. Кадр сохраняется у всех.
  const now = new Date().toISOString();
  const rest = found.filter((s) => !slice.includes(s));
  for (const signal of [...slice, ...rest]) {
    const before = previous.get(signal.id);
    const { file, dimensions } = await saveMedia(signal);
    signal.media = file || before?.media || null;
    if (dimensions && signal.platform === 'youtube') Object.assign(signal.format, { width: dimensions.width, height: dimensions.height });
    else if (dimensions && !signal.format.name) Object.assign(signal.format, shapeOf(dimensions.width, dimensions.height));
    delete signal.media_origin;
    delete signal.media_fallback;
    signal.first_seen = before?.first_seen || now;
    for (const key of ['why', 'remake', 'about']) if (before?.[key] && !signal[key]) signal[key] = before[key];
    signal.picked = slice.includes(signal) || (before ? before.picked !== false : false);
  }
  const fresh = new Set([...slice, ...rest].map((s) => s.id));
  const kept = (library.signals || []).filter((s) => !fresh.has(s.id)
    && (s.picked !== false || new Date(s.posted_at).getTime() >= windowStart));

  const tally = (values) => Object.entries(values.filter(Boolean).reduce((acc, v) => ({ ...acc, [v]: (acc[v] || 0) + 1 }), {}))
    .sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

  const output = {
    generated_at: now,
    window_days: windowDays,
    theme: config.theme || '',
    digest: slice.map((s) => s.id),
    formats: { shapes: tally(slice.map((s) => s.format?.name)), of: slice.length },
    source_report: report,
    summary: library.summary || '',
    signals: [...slice, ...rest, ...kept],
  };

  if (DRY_RUN) {
    console.log(JSON.stringify({ ...output, signals: slice }, null, 1));
    return;
  }
  await mkdir(path.dirname(DATA_PATH), { recursive: true });
  await writeFile(DATA_PATH, `${JSON.stringify(output, null, 1)}\n`);
  // Кадры выбывших постов удаляются, чтобы папка не росла.
  const used = new Set(output.signals.map((s) => s.media && path.basename(s.media)).filter(Boolean));
  for (const name of await readdir(MEDIA_DIR).catch(() => [])) if (!used.has(name)) await unlink(path.join(MEDIA_DIR, name));
  console.log(`найдено ${found.length}, в срезе ${slice.length}, в плитке ${output.signals.filter((s) => s.picked !== false).length}, на радаре ${output.signals.length}`);
  for (const row of report.filter((r) => !r.ok)) console.log(`  молчит ${row.source}: ${row.error}`);
}

await main();
