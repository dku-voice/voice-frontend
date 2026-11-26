import { messages } from './messages.js';

export const languages = [
  { code: 'ko', label: '한국어', locale: 'ko-KR' },
  { code: 'en', label: 'English', locale: 'en-US' },
  { code: 'ja', label: '日本語', locale: 'ja-JP' },
  { code: 'es', label: 'Español', locale: 'es-ES' },
  { code: 'th', label: 'ไทย', locale: 'th-TH' },
];
const storageKey = 'voice-kiosk-language';
export const supportedLanguage = (value) => typeof value === 'string' && languages.some((language) => language.code === value);
export const localeFor = (language) => languages.find((entry) => entry.code === language)?.locale || 'ko-KR';
export function readLanguage() {
  try {
    const saved = globalThis.localStorage?.getItem(storageKey);
    return supportedLanguage(saved) ? saved : 'ko';
  } catch { return 'ko'; }
}
export function storeLanguage(language) {
  if (!supportedLanguage(language)) return;
  try { globalThis.localStorage?.setItem(storageKey, language); } catch { /* In-memory switching still works. */ }
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const numericNames = new Set(['count', 'quantity', 'age']);
const capture = (name) => (numericNames.has(name) ? '(\\d+)' : name === 'name' ? '([^,]+?)' : '(.+?)');
const templates = Object.keys(messages).filter((key) => key.includes('{')).map((key) => {
  const names = [...key.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  const parts = key.split(/\{\w+\}/g).map(escape);
  const pattern = '^' + parts.reduce((joined, part, index) => joined + (index ? capture(names[index - 1]) : '') + part, '') + '$';
  return { key, names, pattern: new RegExp(pattern, 'u') };
});

// This receives display strings only. Unknown messages/names retain the Korean
// source; no API fields, identifiers, prices or form values are rewritten.
export function translate(value, language = 'ko', depth = 0) {
  if (typeof value !== 'string' || language === 'ko' || !supportedLanguage(language) || depth > 5) return value;
  const source = value.trim();
  const prefix = value.slice(0, value.indexOf(source));
  const suffix = value.slice(value.indexOf(source) + source.length);
  if (!source) return value;
  let translated = messages[source]?.[language];
  if (!translated) {
    for (const template of templates) {
      const match = template.pattern.exec(source);
      if (!match) continue;
      translated = messages[template.key][language].replace(/\{(\w+)\}/g, (_placeholder, name) =>
        translate(match[template.names.indexOf(name) + 1], language, depth + 1));
      break;
    }
  }
  if (!translated && source.includes(', ')) translated = source.split(', ').map((part) => translate(part, language, depth + 1)).join(', ');
  if (!translated && source.includes(' / ')) translated = source.split(' / ').map((part) => translate(part, language, depth + 1)).join(' / ');
  return prefix + (translated || source) + suffix;
}

export function formatMoney(value, language = 'ko') {
  if (language === 'ko') return `${Number(value ?? 0).toLocaleString('ko-KR')}원`;
  return new Intl.NumberFormat(localeFor(language), { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(value ?? 0);
}

export function orderSummary(order, language) {
  return (order.items || []).map((item) => {
    const name = translate(item.menuNameKo, language);
    const options = (item.optionNames || []).map((option) => translate(option, language));
    return `${name} ${item.quantity}${translate('개', language)}${options.length ? ` (${options.join(', ')})` : ''}`;
  }).join(', ');
}
