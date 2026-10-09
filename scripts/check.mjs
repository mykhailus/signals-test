// Проверка конфига и данных перед коммитом: node scripts/check.mjs
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const must = (ok, message) => { if (!ok) problems.push(message); };

const config = JSON.parse(await readFile(path.join(ROOT, 'signals.config.json'), 'utf8'));
must(typeof config.theme === 'string' && config.theme.trim(), 'в signals.config.json не указана тема (theme)');
must(Array.isArray(config.tiktok) && Array.isArray(config.youtube), 'tiktok и youtube в конфиге должны быть списками');
must((config.tiktok?.length || 0) + (config.youtube?.length || 0) > 0, 'в конфиге нет ни одного автора');
for (const item of [...(config.tiktok || []), ...(config.youtube || [])]) {
  const handle = typeof item === 'string' ? item : item?.handle;
  must(handle && /^@?[\w.-]+$/.test(handle), `странный хендл автора: ${JSON.stringify(item)}`);
}

const data = JSON.parse(await readFile(path.join(ROOT, 'site', 'data', 'signals.json'), 'utf8'));
must(Array.isArray(data.signals), 'site/data/signals.json: signals должен быть списком');
const ids = new Set();
for (const post of data.signals || []) {
  must(!ids.has(post.id), `повтор поста ${post.id}`);
  ids.add(post.id);
  must(post.url && Number.isFinite(post.popularity), `у поста ${post.id} нет ссылки или числа`);
  if (post.media) {
    try { await access(path.join(ROOT, 'site', post.media)); } catch { problems.push(`у поста ${post.id} потерян кадр ${post.media}`); }
  }
}
for (const id of data.digest || []) must(ids.has(id), `срез ссылается на ${id}, которого нет в списке`);

if (problems.length) {
  for (const p of problems) console.error(`ошибка: ${p}`);
  process.exit(1);
}
console.log(`проверки прошли: авторов ${(config.tiktok?.length || 0) + (config.youtube?.length || 0)}, постов на борде ${data.signals.length}`);
