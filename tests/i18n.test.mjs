// scripts/lib/i18n.mjs and the locale files under locales/.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SUPPORTED, detectLang, interpolate, loadLocale, pick, translator } from '../scripts/lib/i18n.mjs';
import { KIT_ROOT } from './helpers.mjs';

const readLocale = (lang) => JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'locales', `${lang}.json`), 'utf8'));

/** {"a": {"b": "x"}} -> Map("a.b" -> "x") */
function flatten(obj, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object') flatten(value, `${prefix}${key}.`, out);
    else out.set(`${prefix}${key}`, value);
  }
  return out;
}

const placeholders = (text) => [...String(text).matchAll(/\{([a-zA-Z0-9_.]+)\}/g)].map((m) => m[1]).sort();

describe('locale files', () => {
  const en = flatten(readLocale('en'));
  const ru = flatten(readLocale('ru'));

  it('supports exactly English and Russian', () => {
    assert.deepEqual(SUPPORTED, ['en', 'ru']);
    for (const lang of SUPPORTED) assert.ok(fs.existsSync(path.join(KIT_ROOT, 'locales', `${lang}.json`)), lang);
  });

  it('has the same keys in en and ru (flattened)', () => {
    const missingInRu = [...en.keys()].filter((k) => !ru.has(k));
    const extraInRu = [...ru.keys()].filter((k) => !en.has(k));
    assert.deepEqual(missingInRu, [], `keys missing in ru.json: ${missingInRu.join(', ')}`);
    assert.deepEqual(extraInRu, [], `keys only in ru.json: ${extraInRu.join(', ')}`);
  });

  it('uses the same {placeholders} in both languages for every key', () => {
    const mismatched = [];
    for (const [key, value] of en) if (ru.has(key) && placeholders(value).join() !== placeholders(ru.get(key)).join()) mismatched.push(key);
    assert.deepEqual(mismatched, []);
  });

  it('has only non-empty string leaves', () => {
    for (const [name, map] of [['en', en], ['ru', ru]]) {
      const bad = [...map].filter(([, v]) => typeof v !== 'string' || !v.trim()).map(([k]) => k);
      assert.deepEqual(bad, [], `${name}: ${bad.join(', ')}`);
    }
  });

  it('contains Cyrillic text in ru.json and none in en.json (no untranslated copy)', () => {
    const identical = [...en].filter(([k, v]) => ru.get(k) === v && /[a-z]{4,}/i.test(v) && !/^[\s\S]{0,12}$/.test(v)).map(([k]) => k);
    assert.ok(identical.length < en.size * 0.1, `too many strings identical in both languages: ${identical.join(', ')}`);
    assert.ok(![...en.values()].some((v) => /[Ѐ-ӿ]/.test(v)));
    assert.ok([...ru.values()].filter((v) => /[Ѐ-ӿ]/.test(v)).length > en.size * 0.8);
  });
});

describe('loadLocale', () => {
  it('returns the parsed locale for a supported language', () => {
    assert.equal(loadLocale('en').digest.title, readLocale('en').digest.title);
    assert.equal(loadLocale('ru').digest.title, readLocale('ru').digest.title);
  });

  it('falls back to English for an unsupported language and caches the result', () => {
    assert.equal(loadLocale('de'), loadLocale('en'));
    assert.equal(loadLocale('ru'), loadLocale('ru'));
    assert.notEqual(loadLocale('ru'), loadLocale('en'));
  });
});

describe('interpolate', () => {
  it('replaces {name} with the value', () => {
    assert.equal(interpolate('Hello {name}!', { name: 'Ann' }), 'Hello Ann!');
  });

  it('replaces every occurrence and several variables', () => {
    assert.equal(interpolate('{a}+{b}={a}{b}', { a: 1, b: 2 }), '1+2=12');
  });

  it('leaves unknown placeholders untouched', () => {
    assert.equal(interpolate('{known} {unknown}', { known: 'x' }), 'x {unknown}');
  });

  it('prints 0 and false, but leaves null and undefined placeholders in place', () => {
    assert.equal(interpolate('{n} {f}', { n: 0, f: false }), '0 false');
    assert.equal(interpolate('{a} {b}', { a: null, b: undefined }), '{a} {b}');
  });

  it('resolves dotted names inside nested variables', () => {
    assert.equal(interpolate('{user.name}', { user: { name: 'Bob' } }), 'Bob');
  });

  it('works without variables and with non-string templates', () => {
    assert.equal(interpolate('plain'), 'plain');
    assert.equal(interpolate('{x}'), '{x}');
    assert.equal(interpolate(42, {}), '42');
  });

  it('does not touch braces that are not simple names', () => {
    assert.equal(interpolate('{ spaced } {a-b} {}', { spaced: 1, 'a-b': 2 }), '{ spaced } {a-b} {}');
  });
});

describe('translator', () => {
  it('looks up dotted keys and interpolates', () => {
    const t = translator('en');
    assert.equal(t('cli.apply_done', { n: 2, file: 'f.json' }), 'Applied 2 recipe(s). Journal: f.json');
  });

  it('translates to Russian', () => {
    const t = translator('ru');
    assert.ok(/[а-яё]/i.test(t('cli.apply_nothing')));
    assert.notEqual(t('cli.apply_nothing'), translator('en')('cli.apply_nothing'));
  });

  it('returns the key itself when it does not exist in any language', () => {
    assert.equal(translator('en')('no.such.key'), 'no.such.key');
    assert.equal(translator('ru')('no.such.key'), 'no.such.key');
  });

  it('uses English for an unsupported language', () => {
    assert.equal(translator('de')('cli.apply_nothing'), translator('en')('cli.apply_nothing'));
  });

  it('returns non-string values (such as a group of labels) as they are', () => {
    const impact = translator('en')('console.impact');
    assert.equal(typeof impact, 'object');
    assert.ok(impact.high);
  });
});

describe('detectLang', () => {
  it('returns English with a zero share for nothing', () => {
    assert.deepEqual(detectLang([]), { lang: 'en', cyrillicShare: 0 });
    assert.deepEqual(detectLang(undefined), { lang: 'en', cyrillicShare: 0 });
    assert.deepEqual(detectLang(null), { lang: 'en', cyrillicShare: 0 });
  });

  it('returns English for Latin text and Russian for Cyrillic text', () => {
    assert.deepEqual(detectLang(['deploy the service']), { lang: 'en', cyrillicShare: 0 });
    assert.deepEqual(detectLang(['разверни сервис']), { lang: 'ru', cyrillicShare: 1 });
  });

  it('switches to Russian at exactly 30 percent Cyrillic letters', () => {
    assert.equal(detectLang(['а'.repeat(30) + 'a'.repeat(70)]).lang, 'ru');
    assert.equal(detectLang(['а'.repeat(29) + 'a'.repeat(71)]).lang, 'en');
  });

  it('pools all samples', () => {
    assert.deepEqual(detectLang(['абв', 'abcdefg']), { lang: 'ru', cyrillicShare: 0.3 });
  });

  it('ignores non-string samples, digits, punctuation, emoji and other scripts', () => {
    assert.deepEqual(detectLang([42, null, {}, '12345 !!! \u{1F600} 你好 αβγ']), { lang: 'en', cyrillicShare: 0 });
  });

  it('counts Ukrainian and other Cyrillic-block letters as Cyrillic', () => {
    assert.equal(detectLang(['їжак і єнот']).cyrillicShare, 1);
  });

  it('rounds the share to three decimals', () => {
    assert.equal(detectLang(['а', 'bb']).cyrillicShare, 0.333);
  });
});

describe('pick', () => {
  it('returns a plain string as it is', () => {
    assert.equal(pick('hello', 'ru'), 'hello');
  });

  it('returns an empty string for null and undefined', () => {
    assert.equal(pick(null, 'en'), '');
    assert.equal(pick(undefined, 'en'), '');
  });

  it('picks the requested language', () => {
    assert.equal(pick({ en: 'a', ru: 'б' }, 'ru'), 'б');
    assert.equal(pick({ en: 'a', ru: 'б' }, 'en'), 'a');
  });

  it('falls back to English, then to the first available value', () => {
    assert.equal(pick({ en: 'a' }, 'ru'), 'a');
    assert.equal(pick({ de: 'x' }, 'ru'), 'x');
    assert.equal(pick({}, 'ru'), '');
  });

  it('keeps an empty translation (does not fall back past it)', () => {
    assert.equal(pick({ en: 'a', ru: '' }, 'ru'), '');
  });
});
