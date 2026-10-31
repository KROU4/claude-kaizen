// scripts/lib/recipes.mjs: condition evaluation, text rendering, ranking and catalog validation,
// plus consistency checks of the real recipes/catalog.json.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLocale } from '../scripts/lib/i18n.mjs';
import { IMPACT_WEIGHT, RISK_PENALTY, actionApplies, addExtraRecipes, readExtraRecipes, resolveExtraFile, defaultParams, evaluate, loadCatalog, recommend, renderText, resolvePath, score, validateCatalog } from '../scripts/lib/recipes.mjs';
import { KIT_ROOT, buildFixtureMeasure, cleanupTempDirs, makeTempDir, setEnv, writeJson, writeText } from './helpers.mjs';

after(() => cleanupTempDirs());

describe('resolvePath', () => {
  const obj = { a: { b: [10, 20, { c: 'x' }] }, s: 'hello', o: { x: 1, y: 2 }, n: 5, z: null, length: { x: 1 } };

  it('follows dotted keys', () => {
    assert.equal(resolvePath(obj, 'a.b.2.c'), 'x');
    assert.equal(resolvePath(obj, 'n'), 5);
  });

  it('indexes arrays with numeric path segments', () => {
    assert.equal(resolvePath(obj, 'a.b.0'), 10);
    assert.equal(resolvePath(obj, 'a.b.1'), 20);
    assert.equal(resolvePath(obj, 'a.b.5'), undefined);
  });

  it('turns a trailing .length into the size of an array, a string or an object', () => {
    assert.equal(resolvePath(obj, 'a.b.length'), 3);
    assert.equal(resolvePath(obj, 's.length'), 5);
    assert.equal(resolvePath(obj, 'o.length'), 2);
  });

  it('has no length for numbers and treats a non-trailing "length" as an ordinary key', () => {
    assert.equal(resolvePath(obj, 'n.length'), undefined);
    assert.equal(resolvePath(obj, 'length.x'), 1);
  });

  it('returns undefined for missing paths, null intermediates and empty paths', () => {
    assert.equal(resolvePath(obj, 'missing.deep.path'), undefined);
    assert.equal(resolvePath(obj, 'z.anything'), undefined);
    assert.equal(resolvePath(obj, ''), undefined);
    assert.equal(resolvePath(obj, undefined), undefined);
  });

  it('returns null (not undefined) for a key whose value is null', () => {
    assert.equal(resolvePath(obj, 'z'), null);
  });
});

describe('evaluate', () => {
  const m = {
    n: 5,
    s: '7',
    list: [1, 2, 3],
    map: { a: 1, b: 2 },
    text: 'hello world',
    yes: true,
    no: false,
    zero: 0,
    empty: '',
    nul: null,
    lang: 'ru',
    arr: ['x', 'y'],
    word: 'abc',
  };
  const ok = (cond) => evaluate(cond, m);

  describe('comparisons', () => {
    it('gte is inclusive', () => {
      assert.equal(ok({ metric: 'n', gte: 5 }), true);
      assert.equal(ok({ metric: 'n', gte: 6 }), false);
    });

    it('gt is exclusive', () => {
      assert.equal(ok({ metric: 'n', gt: 4 }), true);
      assert.equal(ok({ metric: 'n', gt: 5 }), false);
    });

    it('lte is inclusive', () => {
      assert.equal(ok({ metric: 'n', lte: 5 }), true);
      assert.equal(ok({ metric: 'n', lte: 4 }), false);
    });

    it('lt is exclusive', () => {
      assert.equal(ok({ metric: 'n', lt: 6 }), true);
      assert.equal(ok({ metric: 'n', lt: 5 }), false);
    });

    it('reads numeric strings as numbers', () => {
      assert.equal(ok({ metric: 's', gte: 7 }), true);
      assert.equal(ok({ metric: 's', lt: 7 }), false);
    });

    it('never satisfies a numeric comparison for a missing, empty or non-numeric metric', () => {
      for (const metric of ['missing', 'empty', 'word', 'nul', 'list']) {
        for (const op of ['gte', 'gt', 'lte', 'lt']) assert.equal(ok({ metric, [op]: 1 }), false, `${metric} ${op}`);
      }
    });

    it('eq compares strictly, and a numeric string equals its number', () => {
      assert.equal(ok({ metric: 'lang', eq: 'ru' }), true);
      assert.equal(ok({ metric: 'lang', eq: 'en' }), false);
      assert.equal(ok({ metric: 's', eq: 7 }), true);
      assert.equal(ok({ metric: 'zero', eq: 0 }), true);
      assert.equal(ok({ metric: 'empty', eq: '' }), true);
    });

    it('neq is the negation of eq', () => {
      assert.equal(ok({ metric: 'lang', neq: 'en' }), true);
      assert.equal(ok({ metric: 'lang', neq: 'ru' }), false);
      assert.equal(ok({ metric: 's', neq: 7 }), false);
    });
  });

  describe('membership and presence', () => {
    it('in checks the metric against a list', () => {
      assert.equal(ok({ metric: 'lang', in: ['ru', 'en'] }), true);
      assert.equal(ok({ metric: 'n', in: [1, 2] }), false);
      assert.equal(ok({ metric: 'nul', in: ['a', null] }), true);
      assert.equal(ok({ metric: 'lang', in: 'ru' }), false);
    });

    it('includes works on arrays, strings and object keys', () => {
      assert.equal(ok({ metric: 'arr', includes: 'x' }), true);
      assert.equal(ok({ metric: 'arr', includes: 'q' }), false);
      assert.equal(ok({ metric: 'text', includes: 'world' }), true);
      assert.equal(ok({ metric: 'map', includes: 'a' }), true);
      assert.equal(ok({ metric: 'map', includes: 'z' }), false);
    });

    it('includes is false for numbers and missing metrics', () => {
      assert.equal(ok({ metric: 'n', includes: 5 }), false);
      assert.equal(ok({ metric: 'missing', includes: 'x' }), false);
    });

    it('truthy and falsy follow JavaScript truthiness, with the flag inverting them', () => {
      assert.equal(ok({ metric: 'yes', truthy: true }), true);
      assert.equal(ok({ metric: 'zero', truthy: true }), false);
      assert.equal(ok({ metric: 'zero', falsy: true }), true);
      assert.equal(ok({ metric: 'no', falsy: true }), true);
      assert.equal(ok({ metric: 'missing', falsy: true }), true);
      assert.equal(ok({ metric: 'yes', truthy: false }), false);
      assert.equal(ok({ metric: 'yes', falsy: false }), true);
    });

    it('exists is true for any value except null and undefined (0 and "" exist)', () => {
      assert.equal(ok({ metric: 'zero', exists: true }), true);
      assert.equal(ok({ metric: 'empty', exists: true }), true);
      assert.equal(ok({ metric: 'nul', exists: true }), false);
      assert.equal(ok({ metric: 'missing', exists: true }), false);
      assert.equal(ok({ metric: 'missing', exists: false }), true);
      assert.equal(ok({ metric: 'n', exists: false }), false);
    });
  });

  describe('.length suffix', () => {
    it('measures arrays, objects and strings', () => {
      assert.equal(ok({ metric: 'list.length', gte: 3 }), true);
      assert.equal(ok({ metric: 'list.length', gt: 3 }), false);
      assert.equal(ok({ metric: 'map.length', eq: 2 }), true);
      assert.equal(ok({ metric: 'text.length', gt: 10 }), true);
    });

    it('does not exist on numbers', () => {
      assert.equal(ok({ metric: 'n.length', exists: true }), false);
    });
  });

  describe('combinators', () => {
    it('all requires every branch', () => {
      assert.equal(ok({ all: [{ metric: 'n', gte: 5 }, { metric: 'lang', eq: 'ru' }] }), true);
      assert.equal(ok({ all: [{ metric: 'n', gte: 5 }, { metric: 'lang', eq: 'en' }] }), false);
    });

    it('any requires one branch', () => {
      assert.equal(ok({ any: [{ metric: 'n', gte: 99 }, { metric: 'lang', eq: 'ru' }] }), true);
      assert.equal(ok({ any: [{ metric: 'n', gte: 99 }, { metric: 'lang', eq: 'en' }] }), false);
    });

    it('not negates, and combinators nest', () => {
      assert.equal(ok({ not: { metric: 'n', gte: 99 } }), true);
      assert.equal(ok({ not: { all: [{ metric: 'n', gte: 5 }, { metric: 'yes', truthy: true }] } }), false);
      assert.equal(ok({ all: [{ any: [{ metric: 'n', lt: 1 }, { metric: 'n', gt: 4 }] }, { not: { metric: 'no', truthy: true } }] }), true);
    });

    it('an empty all is true and an empty any is false', () => {
      assert.equal(ok({ all: [] }), true);
      assert.equal(ok({ any: [] }), false);
    });

    it('an array of conditions means all of them', () => {
      assert.equal(ok([{ metric: 'n', gte: 1 }, { metric: 'n', lte: 9 }]), true);
      assert.equal(ok([{ metric: 'n', gte: 1 }, { metric: 'n', lte: 3 }]), false);
    });
  });

  describe('trivial and invalid conditions', () => {
    it('treats undefined, null and true as always true, and false as always false', () => {
      assert.equal(ok(undefined), true);
      assert.equal(ok(null), true);
      assert.equal(ok(true), true);
      assert.equal(ok(false), false);
    });

    it('throws for a scalar condition', () => {
      assert.throws(() => ok('n >= 5'), /bad condition/);
      assert.throws(() => ok(5), /bad condition/);
    });

    it('throws for an object without an operator', () => {
      assert.throws(() => ok({ metric: 'n' }), /no operator/);
      assert.throws(() => ok({ metric: 'n', bogus: 1 }), /no operator/);
    });
  });
});

describe('renderText', () => {
  const m = {
    a: { n: 3, ratio: 0.256, big: 2500, f: 1.5, list: ['x', 'y', 'z'], obj: { p: 1, q: 2 }, name: 'srv' },
    counts: { Bash: 4, Edit: 2 },
    items: [{ name: 'one' }, { server: 'two' }, { command: 'three' }, { z: 1 }],
    many: ['1', '2', '3', '4', '5', '6', '7'],
  };

  it('prints integers as they are and other numbers with two decimals', () => {
    assert.equal(renderText('{a.n}', m), '3');
    assert.equal(renderText('{a.f}', m), '1.50');
  });

  it('prints hook entries readably and an empty list as a dash, never raw JSON', () => {
    const hm = {
      slow: [{ hook: 'fmt.mjs', runs: 4, avgMs: 2300, maxMs: 9100 }],
      killed: [{ hook: 'push-guard.mjs', timeouts: 12, limitMs: 5000 }],
      none: [],
    };
    assert.equal(renderText('{slow}', hm), 'fmt.mjs (avg 2300 ms, max 9100 ms)');
    assert.equal(renderText('{killed}', hm), 'push-guard.mjs (12× > 5 s)');
    assert.equal(renderText('{none}', hm), '—');
  });

  it('prints the units of a hook entry in the requested language', () => {
    const hm = { slow: [{ hook: 'fmt.mjs', runs: 4, avgMs: 2300, maxMs: 9100 }], killed: [{ hook: 'push-guard.mjs', timeouts: 12, limitMs: 5000 }] };
    assert.equal(renderText('{slow}', hm, {}, 'ru'), 'fmt.mjs (сред. 2300 мс, макс. 9100 мс)');
    assert.equal(renderText('{killed}', hm, {}, 'ru'), 'push-guard.mjs (12× > 5 с)');
    assert.equal(renderText('{slow}', hm, {}, 'en'), 'fmt.mjs (avg 2300 ms, max 9100 ms)');
  });

  it('|pct rounds a fraction to a percentage', () => {
    assert.equal(renderText('{a.ratio|pct}', m), '26%');
  });

  it('|k prints thousands with one decimal', () => {
    assert.equal(renderText('{a.big|k}', m), '2.5k');
  });

  it('|len counts array items, object keys or string characters', () => {
    assert.equal(renderText('{a.list|len}', m), '3');
    assert.equal(renderText('{a.obj|len}', m), '2');
    assert.equal(renderText('{a.name|len}', m), '3');
  });

  it('|int rounds to an integer', () => {
    assert.equal(renderText('{a.ratio|int}', m), '0');
    assert.equal(renderText('{a.f|int}', m), '2');
  });

  it('ignores an unknown filter', () => {
    assert.equal(renderText('{a.n|weird}', m), '3');
  });

  it('renders a missing key inside a map of counts as 0 (or 0% with |pct)', () => {
    assert.equal(renderText('{counts.Bash}', m), '4');
    assert.equal(renderText('{counts.Missing}', m), '0');
    assert.equal(renderText('{counts.Missing|pct}', m), '0%');
    assert.equal(renderText('{counts.Missing|len}', m), '0');
  });

  it('renders any other missing value as n/a', () => {
    assert.equal(renderText('{a.nothing}', m), 'n/a');
    assert.equal(renderText('{a.nothing|pct}', m), 'n/a');
    assert.equal(renderText('{nothing.deep}', m), 'n/a');
  });

  it('renders arrays as a comma list of at most five items, naming objects by name/server/command', () => {
    assert.equal(renderText('{a.list}', m), 'x, y, z');
    assert.equal(renderText('{items}', m), 'one, two, three, {"z":1}');
    assert.equal(renderText('{many}', m), '1, 2, 3, 4, 5');
  });

  it('renders an object as its first keys', () => {
    assert.equal(renderText('{a.obj}', m), 'p, q');
  });

  it('reads {params.x} from the params argument', () => {
    assert.equal(renderText('Hello {params.who}!', m, { who: 'Ann' }), 'Hello Ann!');
    assert.equal(renderText('{params.missing}', m, {}), 'n/a');
  });

  it('replaces several placeholders and leaves other text alone', () => {
    assert.equal(renderText('{a.n} of {counts.Bash} ({a.ratio|pct})', m), '3 of 4 (26%)');
    assert.equal(renderText('no placeholders', m), 'no placeholders');
    assert.equal(renderText('{ a.n }', m), '{ a.n }');
  });

  it('returns an empty string for an empty template', () => {
    assert.equal(renderText('', m), '');
    assert.equal(renderText(null, m), '');
    assert.equal(renderText(undefined, m), '');
  });
});

describe('score', () => {
  it('starts from the impact weight and subtracts the risk penalty', () => {
    assert.equal(score({ impact: 'high', risk: 'low' }, {}), 3);
    assert.equal(score({ impact: 'medium', risk: 'medium' }, {}), 1.5);
    assert.equal(score({ impact: 'low', risk: 'high' }, {}), 0);
    assert.deepEqual(IMPACT_WEIGHT, { high: 3, medium: 2, low: 1 });
    assert.deepEqual(RISK_PENALTY, { low: 0, medium: 0.5, high: 1 });
  });

  it('treats a missing risk as none and an unknown impact as 1', () => {
    assert.equal(score({ impact: 'high' }, {}), 3);
    assert.equal(score({ impact: 'bogus' }, {}), 1);
  });

  it('adds the weight of every boost whose condition holds (default weight 1)', () => {
    const recipe = { impact: 'medium', boost: [{ when: { metric: 'n', gte: 1 }, weight: 2 }, { when: { metric: 'n', gte: 1 } }, { when: { metric: 'n', gte: 99 }, weight: 5 }] };
    assert.equal(score(recipe, { n: 3 }), 5);
  });
});

describe('defaultParams', () => {
  const recipe = {
    params: [
      { name: 'mode', default: 'deny' },
      { name: 'servers', default: [], defaultFrom: 'mcp.unused' },
      { name: 'x', default: 'd', defaultFrom: 'missing.path' },
    ],
  };

  it('uses the declared default, or the measured value when defaultFrom resolves to something non-empty', () => {
    assert.deepEqual(defaultParams(recipe, { mcp: { unused: ['a', 'b'] } }), { mode: 'deny', servers: ['a', 'b'], x: 'd' });
  });

  it('keeps the default when the measured value is an empty array', () => {
    assert.deepEqual(defaultParams(recipe, { mcp: { unused: [] } }).servers, []);
  });

  it('returns an empty object for a recipe without params', () => {
    assert.deepEqual(defaultParams({}, {}), {});
  });
});

describe('actionApplies', () => {
  it('is true for an action without a condition', () => {
    assert.equal(actionApplies({ type: 'file' }, {}), true);
  });

  it('follows the action condition', () => {
    assert.equal(actionApplies({ type: 'file', when: { metric: 'n', gte: 2 } }, { n: 3 }), true);
    assert.equal(actionApplies({ type: 'file', when: { metric: 'n', gte: 2 } }, { n: 1 }), false);
  });

  it('applies the action when its condition is malformed (never blocks on a typo)', () => {
    assert.equal(actionApplies({ type: 'file', when: { metric: 'n' } }, {}), true);
  });
});

describe('recommend on a synthetic catalog', () => {
  const text = (en, ru = en) => ({ en, ru });
  const base = (id, over = {}) => ({ id, category: 'workflow', impact: 'medium', risk: 'low', title: text(`T ${id}`, `Т ${id}`), why: text('why', 'почему'), evidence: text('n is {m.n}', 'n равно {m.n}'), when: { metric: 'm.n', gte: 1 }, actions: [{ type: 'settings.set', path: 'x', value: 1 }], ...over });
  const catalog = {
    recipes: [
      base('z.low', { impact: 'low' }),
      base('a.high-risky', { impact: 'high', risk: 'high' }),
      base('b.high', { impact: 'high' }),
      base('m.medium-b'),
      base('m.medium-a'),
      base('never', { when: { metric: 'm.n', gte: 100 } }),
      base('disabled', { disabled: true }),
      base('broken', { when: { metric: 'm.n', bogus: 1 } }),
    ],
  };
  const measure = { m: { n: 5, unused: ['srv-a', 'srv-b'] } };

  it('orders by score, then by id', () => {
    const res = recommend(catalog, measure);
    assert.deepEqual(res.recommended.map((r) => r.id), ['b.high', 'a.high-risky', 'm.medium-a', 'm.medium-b', 'z.low']);
    assert.deepEqual(res.recommended.map((r) => r.score), [3, 2, 2, 2, 1]);
  });

  it('reports why the others were left out and skips disabled recipes entirely', () => {
    const res = recommend(catalog, measure);
    const reasons = Object.fromEntries(res.notApplicable.map((n) => [n.id, n.reason]));
    assert.equal(reasons.never, 'conditions not met');
    assert.match(reasons.broken, /^bad condition: condition has no operator/);
    assert.ok(!('disabled' in reasons));
    assert.ok(!res.recommended.some((r) => r.id === 'disabled'));
  });

  it('leaves out recipes already applied and lists them with their match state', () => {
    const res = recommend(catalog, measure, { applied: new Set(['b.high', 'never']) });
    assert.ok(!res.recommended.some((r) => r.id === 'b.high'));
    assert.deepEqual(res.alreadyApplied, [{ id: 'b.high', matched: true }, { id: 'never', matched: false }]);
    assert.ok(!res.notApplicable.some((n) => n.id === 'never'));
  });

  it('includeAll lists every recipe, applied and non-matching ones included, with matched:false for the latter', () => {
    const res = recommend(catalog, measure, { applied: new Set(['b.high']), includeAll: true });
    const byId = Object.fromEntries(res.recommended.map((r) => [r.id, r]));
    assert.equal(byId['b.high'].matched, true);
    assert.equal(byId.never.matched, false);
    assert.ok('broken' in byId === false || byId.broken.matched === false);
  });

  it('renders title, why and evidence in the requested language', () => {
    const en = recommend(catalog, measure).recommended.find((r) => r.id === 'b.high');
    const ru = recommend(catalog, measure, { lang: 'ru' }).recommended.find((r) => r.id === 'b.high');
    assert.equal(en.title, 'T b.high');
    assert.equal(en.evidence, 'n is 5');
    assert.equal(ru.title, 'Т b.high');
    assert.equal(ru.why, 'почему');
    assert.equal(ru.evidence, 'n равно 5');
  });

  it('marks recipes with actions as "recipe" and the others as "advice"', () => {
    const cat = { recipes: [base('with.actions'), base('only.advice', { actions: undefined })] };
    const res = recommend(cat, measure);
    assert.deepEqual(Object.fromEntries(res.recommended.map((r) => [r.id, r.kind])), { 'with.actions': 'recipe', 'only.advice': 'advice' });
  });

  it('picks the default scope from defaultScope, then the first listed scope, then "user"', () => {
    const cat = { recipes: [base('a', { defaultScope: 'project', scope: ['user', 'project'] }), base('b', { scope: ['project', 'user'] }), base('c', { scope: 'local' }), base('d')] };
    const byId = Object.fromEntries(recommend(cat, measure).recommended.map((r) => [r.id, r]));
    assert.equal(byId.a.scope, 'project');
    assert.equal(byId.b.scope, 'project');
    assert.equal(byId.c.scope, 'local');
    assert.equal(byId.d.scope, 'user');
    assert.deepEqual(byId.b.scopes, ['project', 'user']);
    assert.deepEqual(byId.c.scopes, ['local']);
  });

  it('fills parameters from the measure: defaults, defaultFrom values and options from optionsFrom', () => {
    const cat = {
      recipes: [
        base('with.params', {
          params: [
            { name: 'servers', type: 'multiselect', options: [], optionsFrom: 'm.unused', default: [], defaultFrom: 'm.unused', label: text('Servers', 'Серверы') },
            { name: 'mode', type: 'select', options: ['deny', 'ask'], default: 'deny', label: text('Mode', 'Режим') },
            { name: 'free', label: text('Free', 'Свободно') },
          ],
        }),
      ],
    };
    const [r] = recommend(cat, measure, { lang: 'ru' }).recommended;
    assert.deepEqual(r.params, [
      { name: 'servers', type: 'multiselect', label: 'Серверы', options: ['srv-a', 'srv-b'], value: ['srv-a', 'srv-b'] },
      { name: 'mode', type: 'select', label: 'Режим', options: ['deny', 'ask'], value: 'deny' },
      { name: 'free', type: 'text', label: 'Свободно', options: null, value: undefined },
    ]);
  });

  it('names options built from objects by name, then id, then JSON', () => {
    const cat = { recipes: [base('objs', { params: [{ name: 'p', type: 'multiselect', optionsFrom: 'm.objs', label: text('P') }] })] };
    const [r] = recommend(cat, { m: { n: 1, objs: [{ name: 'one' }, { id: 'two' }, { z: 3 }] } }).recommended;
    assert.deepEqual(r.params[0].options, ['one', 'two', '{"z":3}']);
  });

  it('summarizes only the actions whose own condition holds', () => {
    const cat = {
      recipes: [
        base('conditional', {
          actions: [
            { type: 'settings.set', path: 'cleanupPeriodDays', value: 90 },
            { type: 'settings.set', path: 'language', value: 'russian', when: { metric: 'm.n', gte: 99 } },
            { type: 'file', target: '{kaizenHome}/hooks/x.mjs', template: 'hooks/x.mjs' },
            { type: 'claude-md.block', template: 'claude-md/x.md' },
            { type: 'settings.hook', event: 'PreToolUse', matcher: 'Bash', command: 'x' },
          ],
        }),
      ],
    };
    const [r] = recommend(cat, measure).recommended;
    assert.deepEqual(r.actionsSummary, [
      'settings.json: cleanupPeriodDays = 90',
      'file ~/.claude/kaizen/hooks/x.mjs',
      'rules block in CLAUDE.md',
      'PreToolUse hook (Bash) in settings.json',
    ]);
    const [ru] = recommend(cat, measure, { lang: 'ru' }).recommended;
    assert.equal(ru.actionsSummary[1], 'файл ~/.claude/kaizen/hooks/x.mjs');
  });

  it('passes source and conflicts through and defaults effort/risk', () => {
    const cat = { recipes: [base('meta', { source: 'somewhere', conflicts: ['other'], risk: undefined })] };
    const [r] = recommend(cat, measure).recommended;
    assert.equal(r.source, 'somewhere');
    assert.deepEqual(r.conflicts, ['other']);
    assert.equal(r.effort, 'low');
    assert.equal(r.risk, 'low');
  });
});

describe('validateCatalog', () => {
  const text = (en = 'x', ru = 'х') => ({ en, ru });
  const good = (over = {}) => ({ id: 'good.recipe', category: 'hooks', impact: 'high', risk: 'low', title: text(), why: text(), evidence: text(), when: { metric: 'a', gte: 1 }, actions: [], ...over });
  let templatesDir;
  before(() => {
    templatesDir = makeTempDir('kaizen-templates-');
    writeText(path.join(templatesDir, 'hooks', 'present.mjs'), '// ok\n');
  });
  const problemsFor = (recipe) => validateCatalog({ recipes: [recipe] }, { templatesDir });

  it('accepts a well-formed recipe', () => {
    assert.deepEqual(problemsFor(good()), []);
  });

  it('accepts every action shape when its required fields are present', () => {
    const actions = [
      { type: 'settings.hook', event: 'Stop', command: 'x' },
      { type: 'settings.set', path: 'a', value: 0 },
      { type: 'settings.append', path: 'a.b', values: ['x'] },
      { type: 'settings.append', path: 'a.b', valuesFrom: 'tools.x' },
      { type: 'file', target: 't', template: 'hooks/present.mjs' },
      { type: 'skill', name: 'n', content: 'c' },
      { type: 'agent', name: 'n', content: 'c' },
      { type: 'claude-md.block', content: 'c' },
    ];
    assert.deepEqual(problemsFor(good({ actions })), []);
  });

  it('rejects an id that is not lower-case dotted/dashed words', () => {
    assert.match(problemsFor(good({ id: 'Bad Id' }))[0], /invalid id/);
    assert.match(problemsFor(good({ id: undefined }))[0], /invalid id/);
  });

  it('rejects duplicate ids', () => {
    const problems = validateCatalog({ recipes: [good(), good()] }, { templatesDir });
    assert.ok(problems.some((p) => /duplicate id/.test(p)));
  });

  it('requires title, why and evidence in both languages', () => {
    const problems = problemsFor(good({ title: { en: 'x' }, why: 'plain string', evidence: { ru: 'х' } }));
    assert.ok(problems.some((p) => /title\.ru missing/.test(p)));
    assert.ok(problems.some((p) => /why must be \{en, ru\}/.test(p)));
    assert.ok(problems.some((p) => /evidence\.en missing/.test(p)));
  });

  it('requires a known impact, an optional known risk and a category', () => {
    assert.ok(problemsFor(good({ impact: 'huge' })).some((p) => /impact must be/.test(p)));
    assert.ok(problemsFor(good({ risk: 'scary' })).some((p) => /risk must be/.test(p)));
    assert.ok(problemsFor(good({ category: undefined })).some((p) => /category missing/.test(p)));
  });

  it('requires a condition that evaluates', () => {
    assert.ok(problemsFor(good({ when: { metric: 'a' } })).some((p) => /when: .*no operator/.test(p)));
  });

  it('reports a missing template file', () => {
    const problems = problemsFor(good({ actions: [{ type: 'file', target: 't', template: 'hooks/absent.mjs' }] }));
    assert.deepEqual(problems, ['recipe good.recipe: template missing: hooks/absent.mjs']);
  });

  it('checks the required fields of every action type', () => {
    const cases = [
      [{}, /action without type/],
      [{ type: 'settings.hook', event: 'Stop' }, /settings\.hook needs event and command/],
      [{ type: 'settings.set', path: 'a' }, /settings\.set needs path and value/],
      [{ type: 'settings.append', path: 'a' }, /settings\.append needs path and values/],
      [{ type: 'file', target: 't' }, /file needs template or content/],
      [{ type: 'skill', name: 'n' }, /skill needs template or content/],
      [{ type: 'agent', name: 'n' }, /agent needs template or content/],
      [{ type: 'claude-md.block' }, /claude-md\.block needs template or content/],
    ];
    for (const [action, pattern] of cases) assert.match(problemsFor(good({ actions: [action] })).join('\n'), pattern, JSON.stringify(action));
  });

  it('checks parameters: name, options for selects, bilingual label', () => {
    const problems = problemsFor(good({ params: [{ type: 'text', label: text() }, { name: 'pick', type: 'select', label: text() }, { name: 'free', type: 'text', label: { en: 'only' } }] }));
    assert.ok(problems.some((p) => /param without name/.test(p)));
    assert.ok(problems.some((p) => /select param pick needs options or optionsFrom/.test(p)));
    assert.ok(problems.some((p) => /param free needs label/.test(p)));
  });
});

describe('the real recipe catalog', () => {
  let catalog;
  before(() => {
    catalog = loadCatalog();
  });

  it('loads with a version and a non-trivial list of recipes', () => {
    assert.equal(typeof catalog.version, 'number');
    assert.ok(Array.isArray(catalog.recipes));
    assert.ok(catalog.recipes.length >= 25);
  });

  it('rejects a catalog file without a recipes array', () => {
    const dir = makeTempDir('kaizen-catalog-');
    writeJson(path.join(dir, 'catalog.json'), { recipes: 'nope' });
    assert.throws(() => loadCatalog(path.join(dir, 'catalog.json')), /recipes\[\] missing/);
  });

  it('has no structural problems', () => {
    const problems = validateCatalog(catalog).filter((p) => !/template missing/.test(p));
    assert.deepEqual(problems, []);
  });

  it('only references template files that exist', () => {
    const missing = validateCatalog(catalog).filter((p) => /template missing/.test(p));
    if (missing.length) console.log(`templates still missing:\n${missing.join('\n')}`);
    assert.deepEqual(missing, []);
  });

  it('has unique ids', () => {
    const ids = catalog.recipes.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('uses only categories the console has a label for, in both languages', () => {
    for (const lang of ['en', 'ru']) {
      const labels = loadLocale(lang).console.categories;
      const unknown = [...new Set(catalog.recipes.map((r) => r.category))].filter((c) => !(c in labels));
      assert.deepEqual(unknown, [], `categories without a ${lang} label: ${unknown.join(', ')}`);
    }
  });

  it('gives every select parameter a default that is one of its options', () => {
    const bad = [];
    for (const r of catalog.recipes) {
      for (const p of r.params || []) {
        if (p.type === 'select' && Array.isArray(p.options) && !p.options.includes(p.default)) bad.push(`${r.id}.${p.name}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  it('evaluates every condition on an empty measurement without throwing', () => {
    for (const r of catalog.recipes) assert.doesNotThrow(() => evaluate(r.when, {}), r.id);
  });

  it('has every referenced skill/agent/claude-md template inside recipes/templates', () => {
    const outside = [];
    for (const r of catalog.recipes) {
      for (const a of r.actions || []) {
        if (!a.template) continue;
        const resolved = path.resolve(KIT_ROOT, 'recipes', 'templates', a.template);
        if (!resolved.startsWith(path.join(KIT_ROOT, 'recipes', 'templates'))) outside.push(`${r.id}: ${a.template}`);
      }
    }
    assert.deepEqual(outside, []);
  });
});

describe('recommend on the real catalog with the fixture measurement', () => {
  let measure;
  let res;
  before(async () => {
    ({ measure } = await buildFixtureMeasure());
    res = recommend(loadCatalog(), measure);
  });

  const ids = () => res.recommended.map((r) => r.id);

  it('recommends the destructive-command guard: three destructive commands and a force push, no guard hook', () => {
    assert.ok(ids().includes('hooks.guard-destructive'));
  });

  it('recommends removing the unused MCP server, preselecting dead-srv', () => {
    const r = res.recommended.find((x) => x.id === 'context.mcp-unused');
    assert.ok(r);
    assert.deepEqual(r.params[0].options, ['dead-srv']);
    assert.deepEqual(r.params[0].value, ['dead-srv']);
    assert.ok(r.title.includes('dead-srv'));
    assert.ok(r.evidence.includes('1 of 2'));
  });

  it('recommends denying secret files because no deny rule exists', () => {
    assert.ok(ids().includes('permissions.deny-secrets'));
  });

  it('deny-secrets evidence does not claim there are no deny rules when there are some that miss .env', () => {
    const withRules = (rules) => ({ ...measure, inventory: { ...measure.inventory, permissions: { ...measure.inventory.permissions, deny: rules.length } }, context: { ...measure.context, denyRulesText: rules.join('\n').toLowerCase() } });
    for (const lang of ['en', 'ru']) {
      const none = recommend(loadCatalog(), withRules([]), { lang }).recommended.find((r) => r.id === 'permissions.deny-secrets');
      const some = recommend(loadCatalog(), withRules(['Bash(rm -rf:*)', 'Read(./secrets/**)']), { lang }).recommended.find((r) => r.id === 'permissions.deny-secrets');
      assert.ok(none && some, 'it fires with no rules and with rules that do not cover .env');
      assert.doesNotMatch(some.evidence, /No deny rules are configured|Deny-правил нет/);
      assert.ok(some.evidence.includes('2'), some.evidence);
      assert.ok(none.evidence.includes('0'), none.evidence);
      assert.ok(!/filesEdited|затронуто/.test(some.evidence), 'the unrelated edited-files count is gone');
    }
    assert.equal(recommend(loadCatalog(), withRules(['Read(./.env)']), {}).recommended.some((r) => r.id === 'permissions.deny-secrets'), false);
  });

  it('recommends a status line because none is configured', () => {
    assert.ok(ids().includes('statusline.install'));
  });

  it('does not recommend things the data does not support', () => {
    for (const id of ['claude-md.language', 'settings.cleanup-period', 'hooks.protect-secrets', 'permissions.allowlist-readonly', 'claude-md.corrections', 'hooks.format-on-edit']) {
      assert.ok(!ids().includes(id), `${id} should not match the fixture data`);
    }
  });

  it('lists the others as not applicable with a reason', () => {
    assert.ok(res.notApplicable.some((n) => n.id === 'claude-md.language' && n.reason === 'conditions not met'));
  });

  it('sorts by score (high first), then id', () => {
    for (let i = 1; i < res.recommended.length; i++) {
      const a = res.recommended[i - 1];
      const b = res.recommended[i];
      assert.ok(a.score > b.score || (a.score === b.score && a.id.localeCompare(b.id) < 0), `${a.id} before ${b.id}`);
    }
  });

  it('renders evidence without unresolved placeholders', () => {
    for (const r of res.recommended) {
      assert.ok(!/\{[a-zA-Z0-9_.]+(\|[a-z]+)?\}/.test(r.evidence), `${r.id}: ${r.evidence}`);
      assert.ok(!/\{[a-zA-Z0-9_.]+(\|[a-z]+)?\}/.test(r.title), `${r.id}: ${r.title}`);
    }
  });

  it('suggests the Russian language rule when the prompts are Russian and nothing configures it', async () => {
    const russian = { ...measure, locale: { lang: 'ru', cyrillicShare: 0.9 }, context: { ...measure.context, settingsLanguage: null, claudeMdHints: { ...measure.context.claudeMdHints, language: false } } };
    const ru = recommend(loadCatalog(), russian, { lang: 'ru' });
    const r = ru.recommended.find((x) => x.id === 'claude-md.language');
    assert.ok(r);
    assert.equal(r.impact, 'high');
    assert.ok(/[а-яё]/i.test(r.title));
  });
});

describe('the local measurement of the person running the tests (optional)', () => {
  const file = path.join(os.homedir(), '.claude', 'kaizen', 'measure.json');
  const present = fs.existsSync(file);

  it('evaluates every recipe condition against it without throwing', { skip: !present && 'no ~/.claude/kaizen/measure.json on this machine' }, () => {
    const real = JSON.parse(fs.readFileSync(file, 'utf8'));
    const catalog = loadCatalog();
    for (const r of catalog.recipes) assert.doesNotThrow(() => evaluate(r.when, real), r.id);
    assert.doesNotThrow(() => recommend(catalog, real));
  });
});

// ---------------------------------------------------------------- extra (custom) recipes files

describe('extra recipes files (recommend --add / apply --add)', () => {

  it('readExtraRecipes returns the parsed object, and null for a missing, corrupt or non-object file', () => {
    const dir = makeTempDir('kaizen-extra-');
    writeJson(path.join(dir, 'ok.json'), { recipes: [{ id: 'custom.a' }] });
    assert.deepEqual(readExtraRecipes(path.join(dir, 'ok.json')), { recipes: [{ id: 'custom.a' }] });
    assert.equal(readExtraRecipes(path.join(dir, 'missing.json')), null);
    writeText(path.join(dir, 'bad.json'), '{ nope');
    assert.equal(readExtraRecipes(path.join(dir, 'bad.json')), null);
    writeText(path.join(dir, 'list.json'), '[1,2]');
    assert.equal(readExtraRecipes(path.join(dir, 'list.json')), null);
  });

  it('addExtraRecipes appends after the built-in recipes (a built-in id still wins a lookup) and tolerates no recipes', () => {
    const cat = { recipes: [{ id: 'a' }] };
    addExtraRecipes(cat, { recipes: [{ id: 'a', extra: true }, { id: 'custom.b' }] });
    assert.deepEqual(cat.recipes.map((r) => r.id), ['a', 'a', 'custom.b']);
    assert.equal(cat.recipes.find((r) => r.id === 'a').extra, undefined);
    assert.equal(addExtraRecipes(cat, null), cat);
    assert.equal(addExtraRecipes(cat, { profile: 'x' }).recipes.length, 3);
  });

  it('resolveExtraFile makes the path absolute and expands ~ (PowerShell passes it literally)', () => {
    const home = makeTempDir('kaizen-home-');
    const undo = setEnv({ HOME: home, USERPROFILE: home });
    try {
      assert.equal(resolveExtraFile('~/x/extra.json'), path.join(home, 'x', 'extra.json'));
      assert.equal(resolveExtraFile('rel/extra.json'), path.resolve('rel/extra.json'));
    } finally {
      undo();
    }
  });
});

describe('secret parameters', () => {
  it('are flagged and never pre-filled, even when the catalog has a default', () => {
    const catalog = {
      version: 1,
      recipes: [{ id: 's.secret', category: 'hooks', impact: 'high', risk: 'low', kind: 'recipe', title: { en: 'S', ru: 'S' }, why: { en: 'w', ru: 'w' }, when: [],
        params: [{ name: 'token', type: 'text', secret: true, default: 'sekret-default' }, { name: 'chat', type: 'text', default: '42' }], actions: [] }],
    };
    const res = recommend(catalog, {}, { includeAll: true });
    const all = [...res.recommended, ...res.notApplicable, ...res.alreadyApplied];
    const r = all.find((x) => x.id === 's.secret');
    assert.ok(r && Array.isArray(r.params), 'recipe with params is listed');
    const token = r.params.find((p) => p.name === 'token');
    assert.equal(token.secret, true);
    assert.equal(token.value, '');
    assert.equal(r.params.find((p) => p.name === 'chat').value, '42');
  });

  it('the real catalog marks the Telegram bot token as secret', () => {
    const cat = loadCatalog();
    const p = cat.recipes.flatMap((r) => r.params || []).find((x) => x.name === 'telegramBotToken');
    assert.equal(p.secret, true);
  });
});

// ---------------------------------------------------------------- conditions that must not fire on tiny numbers or nothing to do

describe('catalog conditions: small samples, nothing to choose, shared hooks', () => {
  let base;
  before(async () => {
    ({ measure: base } = await buildFixtureMeasure());
  });
  const withMeasure = (patch) => {
    const m = JSON.parse(JSON.stringify(base));
    for (const [p, v] of Object.entries(patch)) {
      const parts = p.split('.');
      let cur = m;
      for (const k of parts.slice(0, -1)) cur = cur[k] ??= {};
      cur[parts.at(-1)] = v;
    }
    return m;
  };
  const found = (m, id) => recommend(loadCatalog(), m).recommended.find((r) => r.id === id);
  const SESSION_CONTEXT_CMD = 'node "/home/u/.claude/kaizen/hooks/session-context.mjs"';

  it('verify-before-done needs at least 5 editing sessions, like its Stop-hook twin', () => {
    const tiny = withMeasure({ 'quality.editsWithoutTestsShare': 1, 'quality.sessionsWithEdits': 1, 'context.claudeMdHints': {} });
    assert.equal(found(tiny, 'claude-md.verify-before-done'), undefined);
    assert.equal(found(withMeasure({ 'quality.editsWithoutTestsShare': 1, 'quality.sessionsWithEdits': 6, 'context.claudeMdHints': {} }), 'claude-md.verify-before-done')?.id, 'claude-md.verify-before-done');
  });

  it('context-pressure does not fire on one compacted session out of one', () => {
    const quiet = { 'context.sessionsOver150k': 0, 'friction.compactionShare': 1, 'friction.sessionsWithCompaction': 1, 'totals.sessions': 1 };
    assert.equal(found(withMeasure(quiet), 'advice.context-pressure'), undefined);
    assert.ok(found(withMeasure({ ...quiet, 'friction.sessionsWithCompaction': 4, 'totals.sessions': 12, 'friction.compactionShare': 0.33 }), 'advice.context-pressure'));
    assert.ok(found(withMeasure({ ...quiet, 'context.sessionsOver150k': 3 }), 'advice.context-pressure'), 'three huge sessions are enough on their own');
  });

  it('session-context is still offered when the only SessionStart hook is the one precompact-handoff installed', () => {
    const lots = { 'totals.sessions': 20, 'context.hasSessionStartHook': true };
    assert.equal(found(withMeasure({ ...lots, 'context.hookEvents': { SessionStart: 1 }, 'context.hookCommandsText': 'sessionstart:node "/x/other-hook.mjs"' }), 'hooks.session-context'), undefined);
    assert.equal(found(withMeasure({ ...lots, 'context.hookEvents': { SessionStart: 2 }, 'context.hookCommandsText': `sessionstart:${SESSION_CONTEXT_CMD}\nsessionstart:node other.mjs` }), 'hooks.session-context'), undefined);
    assert.ok(found(withMeasure({ ...lots, 'context.hookEvents': { SessionStart: 1 }, 'context.hookCommandsText': `sessionstart:${SESSION_CONTEXT_CMD}` }), 'hooks.session-context'));
  });

  it('session-context still recognises its own script when it is the per-project one (session-context.<key>.mjs)', () => {
    const lots = { 'totals.sessions': 20, 'context.hasSessionStartHook': true, 'context.hookEvents': { SessionStart: 1 } };
    const own = 'sessionstart:node "/home/u/.claude/kaizen/hooks/session-context.3fa9c1d2e4.mjs"';
    assert.ok(found(withMeasure({ ...lots, 'context.hookCommandsText': own }), 'hooks.session-context'));
    assert.equal(found(withMeasure({ ...lots, 'context.hookCommandsText': 'sessionstart:node "/x/other-hook.mjs"' }), 'hooks.session-context'), undefined);
  });

  it('hook scripts with parameters baked in are addressed as {kaizenHome}/hooks/<name>.mjs in both the file action and the hook command, so a project key can be inserted', () => {
    for (const r of loadCatalog().recipes) {
      for (const a of (r.actions || []).filter((x) => x.type === 'file' && x.template && /^hooks\//.test(x.template))) {
        const baked = /\{\{[a-zA-Z0-9_]+\}\}/.test(fs.readFileSync(path.join(KIT_ROOT, 'recipes', 'templates', a.template), 'utf8'));
        if (!baked) continue;
        assert.match(a.target, /^\{kaizenHome\}\/hooks\/[A-Za-z0-9_-]+\.mjs$/, `${r.id}: ${a.target}`);
        const hooks = r.actions.filter((x) => x.type === 'settings.hook' && x.command.includes(a.target));
        assert.ok(hooks.length, `${r.id}: a settings.hook must run ${a.target}`);
      }
    }
  });

  it('prune-unused is not offered without a plugin to disable, nor for plugins that are already disabled', () => {
    const crowded = { 'skills.installed': 24, 'skills.unusedCount': 24, 'skills.unusedShare': 1, 'skills.unusedPlugins': [] };
    assert.equal(found(withMeasure(crowded), 'skills.prune-unused'), undefined);
    const idle = { ...crowded, 'skills.unusedPlugins': ['idle@market'] };
    assert.ok(found(withMeasure(idle), 'skills.prune-unused'));
    const disabled = withMeasure({ ...idle, 'inventory.settings': [{ scope: 'user', disabledPlugins: ['idle@market'] }] });
    assert.equal(found(disabled, 'skills.prune-unused'), undefined);
    const two = withMeasure({ ...crowded, 'skills.unusedPlugins': ['idle@market', 'old@market'], 'inventory.settings': [{ scope: 'user', disabledPlugins: ['idle@market'] }] });
    assert.deepEqual(found(two, 'skills.prune-unused').params[0].options, ['old@market']);
    // the full list (recommend --all) still shows the recipe
    assert.ok(recommend(loadCatalog(), disabled, { includeAll: true }).recommended.some((r) => r.id === 'skills.prune-unused'));
  });

  it('format-on-edit offers every formatter the measurement can name for a language', () => {
    const src = fs.readFileSync(path.join(KIT_ROOT, 'scripts', 'lib', 'metrics.mjs'), 'utf8');
    const block = /const FORMATTERS = \{([\s\S]*?)\n\};/.exec(src)[1];
    const named = [...block.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(named.length >= 12, named.join(','));
    const options = loadCatalog().recipes.find((r) => r.id === 'hooks.format-on-edit').params.find((p) => p.name === 'formatter').options;
    for (const f of named) assert.ok(options.includes(f), `${f} must be a valid formatter option`);
    const template = fs.readFileSync(path.join(KIT_ROOT, 'recipes', 'templates', 'hooks', 'format-on-edit.mjs'), 'utf8');
    for (const f of options.filter((o) => o !== 'auto')) assert.ok(template.includes(f), `the hook template must know ${f}`);
  });
});
