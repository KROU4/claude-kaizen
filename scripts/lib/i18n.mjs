// Tiny i18n: locale JSON files under locales/, dotted keys, {var} interpolation,
// English fallback. Also the language detector used to pick the dialog language.
import fs from 'node:fs';
import path from 'node:path';
import { kitRoot } from './paths.mjs';

export const SUPPORTED = ['en', 'ru'];
const cache = new Map();

export function loadLocale(lang) {
  const l = SUPPORTED.includes(lang) ? lang : 'en';
  if (!cache.has(l)) {
    const file = path.join(kitRoot(), 'locales', `${l}.json`);
    cache.set(l, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return cache.get(l);
}

function lookup(obj, key) {
  return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

export function interpolate(str, vars = {}) {
  return String(str).replace(/\{([a-zA-Z0-9_.]+)\}/g, (m, k) => {
    const v = lookup(vars, k);
    return v === undefined || v === null ? m : String(v);
  });
}

/** Translator bound to a language. t('console.title'), t('x.y', {n: 3}). */
export function translator(lang) {
  const primary = loadLocale(lang);
  const fallback = loadLocale('en');
  return function t(key, vars) {
    const raw = lookup(primary, key) ?? lookup(fallback, key) ?? key;
    return typeof raw === 'string' ? interpolate(raw, vars) : raw;
  };
}

/**
 * An expected failure caused by what the user typed or by a missing step (unknown id, bad flag, no measurement yet).
 * The CLI prints just its (already localized) message and exits 1; the stack is shown only with KAIZEN_DEBUG=1.
 */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
    this.expected = true;
  }
}

/** Pick a localized value from {en: .., ru: ..} objects used in the recipe catalog. */
export function pick(localized, lang) {
  if (localized == null) return '';
  if (typeof localized === 'string') return localized;
  return localized[lang] ?? localized.en ?? Object.values(localized)[0] ?? '';
}

/**
 * Detect the dominant script of user-written text.
 * Returns {lang, cyrillicShare}. Threshold is deliberately low: a user who
 * writes 30% of prompts in Russian wants a Russian dialog.
 */
export function detectLang(samples) {
  let cyr = 0;
  let lat = 0;
  for (const s of samples || []) {
    if (typeof s !== 'string') continue;
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      if (c >= 0x0400 && c <= 0x04ff) cyr++;
      else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) lat++;
    }
  }
  const total = cyr + lat;
  const cyrillicShare = total ? cyr / total : 0;
  return { lang: cyrillicShare >= 0.3 ? 'ru' : 'en', cyrillicShare: Number(cyrillicShare.toFixed(3)) };
}
