// Разбор среза моделью: абзац о неделе, «почему залетело», «наша версия» под
// вашу тему (или продукт, если он есть в конфиге) и пересказ «о чём пост» для подсказки на борде.
//
//   node scripts/compose.mjs            записать разбор в site/data/signals.json
//   node scripts/compose.mjs --dry-run  напечатать ответ модели, ничего не писать
//
// Ключ: OPENROUTER_API_KEY (любая модель OpenRouter) или ANTHROPIC_API_KEY.
// Без ключа шаг ничего не придумывает и завершается: сбор и борд работают и так.
// Один вызов в день стоит около $0.02 на Claude Sonnet.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'signals.config.json');
const DATA_PATH = path.join(ROOT, 'site', 'data', 'signals.json');
const DRY_RUN = process.argv.includes('--dry-run');

const config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
const data = JSON.parse(await readFile(DATA_PATH, 'utf8'));
const language = config.language || 'ru';
const modelOR = config.model || 'anthropic/claude-sonnet-5';
const modelAnthropic = modelOR.replace(/^anthropic\//, '');

// Аудитория и продукт необязательны: без них «наша версия» пишется под тему.
const audience = String(config.audience || '').trim();
const product = String(config.product || '').trim();
const target = product ? 'продукта автора' : 'автора в его теме';

const SYSTEM = `Ты разбираешь подборку популярных постов TikTok и YouTube для автора, который делает контент по теме «${config.theme}».
${audience ? `Аудитория автора: ${audience}.\n` : ''}${product ? `Продукт или проект автора: ${product}.\n` : ''}
Пиши на языке: ${language}. Коротко, по делу, без эмодзи и без оценок, которых нет в данных.
Числа сравнивай только внутри одной площадки: просмотры TikTok и YouTube несопоставимы.
Ты не видишь сами ролики, только подписи и числа. Не выдумывай того, чего нет в подписи.

Верни ТОЛЬКО валидный JSON без markdown:
{"summary": "абзац 3-4 предложения: что набирает в этой теме за окно, с числами",
 "items": [{"id": "<id поста>", "why": "одна фраза: почему залетело – форма, ход, подача", "remake": "одна фраза: как сделать такой же приём для ${target}"}],
 "abouts": [{"id": "<id поста>", "about": "1-2 предложения: о чём пост, по подписи"}]}`;

const byId = new Map(data.signals.map((s) => [s.id, s]));
const digest = (data.digest || []).map((id) => byId.get(id)).filter(Boolean);
const aboutQueue = [
  ...digest.filter((p) => !p.about),
  ...data.signals.filter((p) => !p.about && p.picked !== false && !digest.includes(p)).sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at)),
].slice(0, 20);

if (!digest.length && !aboutQueue.length) {
  console.log('в срезе пусто – разбирать нечего');
  process.exit(0);
}

const facts = (p) => [
  `id: ${p.id}`,
  `площадка: ${p.platform}, автор: ${p.source}, опубликован: ${p.posted_at.slice(0, 10)}`,
  `просмотры: ${p.approx ? '≈' : ''}${p.popularity}`,
  `формат: ${p.format?.name || p.format?.kind || 'неизвестен'}`,
  `подпись: ${p.title || 'без подписи'}`,
].join('\n');

const user = [
  `окно: ${data.window_days} дней.`,
  '',
  `срез, ${digest.length} постов. в items разбери каждый, ровно ${digest.length} элементов:`,
  '',
  digest.map(facts).join('\n\n'),
  aboutQueue.length ? `\n\nпересказ в abouts, ровно ${aboutQueue.length} элементов:\n\n${aboutQueue.map((p) => `id: ${p.id}\nподпись: ${p.title || 'без подписи'}`).join('\n\n')}` : '',
].join('\n');

function parseJson(text) {
  const t = String(text || '');
  let json = (t.match(/```(?:json)?\s*([\s\S]*?)```/i) || [])[1] || t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  // Модель иногда ставит прямые кавычки внутри текста и рвёт JSON. Кавычка
  // перед местом ошибки меняется на ёлочку, и разбор повторяется.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      return JSON.parse(json);
    } catch (error) {
      const at = Number((String(error.message).match(/position (\d+)/) || [])[1]);
      const quote = Number.isInteger(at) ? json.lastIndexOf('"', at - 1) : -1;
      if (quote <= 0) throw error;
      json = `${json.slice(0, quote)}${/\s/.test(json[quote - 1]) ? '«' : '»'}${json.slice(quote + 1)}`;
    }
  }
  return JSON.parse(json);
}

async function ask() {
  const or = process.env.OPENROUTER_API_KEY;
  const an = process.env.ANTHROPIC_API_KEY;
  if (an) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': an, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelAnthropic, max_tokens: 4000, temperature: 0.4, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error?.message || `Anthropic HTTP ${res.status}`);
    return parseJson(payload.content?.map((c) => c.text).join(''));
  }
  if (or) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${or}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelOR,
        max_tokens: 4000,
        temperature: 0.4,
        // у моделей с размышлениями оно съедает лимит, и ответ приходит пустым
        reasoning: { enabled: false },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error?.message || `OpenRouter HTTP ${res.status}`);
    return parseJson(payload.choices?.[0]?.message?.content);
  }
  console.error('нет ни OPENROUTER_API_KEY, ни ANTHROPIC_API_KEY: разбор пропущен, борд работает без него');
  process.exit(0);
}

const clean = (text) => String(text || '').replace(/—/g, '–').trim();
const result = await ask();
if (DRY_RUN) {
  console.log(JSON.stringify(result, null, 1));
  process.exit(0);
}

const digestIds = new Set(data.digest);
for (const item of result.items || []) {
  const post = byId.get(item.id);
  if (!post || !digestIds.has(item.id)) continue;
  post.why = clean(item.why);
  post.remake = clean(item.remake);
}
const queued = new Set(aboutQueue.map((p) => p.id));
let abouts = 0;
for (const row of result.abouts || []) {
  const post = byId.get(row.id);
  if (!post || !queued.has(row.id) || !row.about) continue;
  post.about = clean(row.about);
  abouts += 1;
}
if (result.summary) data.summary = clean(result.summary);
await writeFile(DATA_PATH, `${JSON.stringify(data, null, 1)}\n`);
console.log(`разбор: ${(result.items || []).length} из ${digest.length}, пересказов ${abouts} из ${aboutQueue.length}`);
