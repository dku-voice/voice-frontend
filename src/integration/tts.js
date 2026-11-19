const preferences = {
  ja: ['nanami', 'kyoko', 'haruka', 'sayaka', 'otoya', 'google 日本語'],
  es: ['elvira', 'dalia', 'monica', 'paulina', 'alvaro', 'jorge', 'google español'],
  th: ['premwadee', 'achara', 'kanya', 'narisa', 'google ไทย'],
};

const settings = {
  ko: { rate: 1, pitch: 1 },
  ja: { rate: 0.96, pitch: 1 },
  es: { rate: 0.98, pitch: 1 },
  th: { rate: 0.94, pitch: 1 },
};

const normalized = (value) => String(value || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replaceAll('_', '-');

const qualityScore = (voice) => {
  const description = normalized(`${voice.name} ${voice.voiceURI}`);
  if (/\b(neural|natural|premium|enhanced|siri)\b/.test(description)) return 500;
  return 0;
};

export function ttsSettings(language) {
  return settings[language] || settings.ko;
}

// Web Speech exposes only voices installed/provided by the current browser.
// Prefer an exact locale and its higher-quality variant, then a familiar voice
// for that language. If none exists, returning null keeps the browser fallback.
export function rankTtsVoices(voices, language, locale) {
  if (!Array.isArray(voices) || !preferences[language]) return null;
  const targetLocale = normalized(locale);
  const targetLanguage = targetLocale.split('-')[0];
  const candidates = voices.filter((voice) => normalized(voice?.lang).split('-')[0] === targetLanguage);
  if (!candidates.length) return [];

  return candidates.map((voice, index) => {
    const voiceLocale = normalized(voice.lang);
    const voiceName = normalized(voice.name);
    const preferredIndex = preferences[language].findIndex((name) => voiceName.includes(normalized(name)));
    const score = (voiceLocale === targetLocale ? 1000 : 500)
      + qualityScore(voice)
      + (preferredIndex < 0 ? 0 : 300 - preferredIndex * 10)
      + (voice.localService ? 5 : 0)
      - index / 1000;
    return { voice, score };
  }).sort((left, right) => right.score - left.score).map((entry) => entry.voice);
}

export function selectTtsVoice(voices, language, locale) {
  return rankTtsVoices(voices, language, locale)?.[0] || null;
}

export function waitForTtsVoice(synthesis, language, locale, timeoutMs = 1500) {
  const current = () => selectTtsVoice(synthesis?.getVoices?.() || [], language, locale);
  const ready = current();
  if (ready || !preferences[language] || !synthesis?.getVoices) return Promise.resolve(ready);

  return new Promise((resolve) => {
    let timer; let pollTimer; let settled = false;
    const finish = (voice) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(pollTimer);
      synthesis.removeEventListener?.('voiceschanged', changed);
      resolve(voice);
    };
    const changed = () => {
      const voice = current();
      if (voice) finish(voice);
    };
    const poll = () => {
      const voice = current();
      if (voice) { finish(voice); return; }
      pollTimer = setTimeout(poll, 100);
    };
    synthesis.addEventListener?.('voiceschanged', changed);
    pollTimer = setTimeout(poll, 100);
    timer = setTimeout(() => finish(current()), timeoutMs);
  });
}
