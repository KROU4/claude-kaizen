// scripts/lib/redact.mjs: secret scrubbing for everything that leaves the raw transcripts.
// Every credential below is assembled at run time from harmless pieces so that neither this file nor the
// repository ever contains a string that looks like a live token.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redact, snippet } from '../scripts/lib/redact.mjs';

const rep = (s, n) => s.repeat(n);

describe('redact: token families', () => {
  const cases = [
    ['an Anthropic API key', `sk-ant-${rep('aB3_', 8)}`, 'anthropic-key'],
    ['an OpenAI key', `sk-${rep('x9', 12)}`, 'openai-key'],
    ['an OpenAI project key', `sk-proj-${rep('Zq7-', 8)}`, 'openai-key'],
    ['a GitHub personal token (ghp_)', `ghp_${rep('A1', 18)}`, 'github-token'],
    ['a GitHub OAuth token (gho_)', `gho_${rep('b2', 18)}`, 'github-token'],
    ['a GitHub user token (ghu_)', `ghu_${rep('c3', 18)}`, 'github-token'],
    ['a GitHub server token (ghs_)', `ghs_${rep('d4', 18)}`, 'github-token'],
    ['a GitHub refresh token (ghr_)', `ghr_${rep('e5', 18)}`, 'github-token'],
    ['a fine-grained GitHub token', `github_pat_${rep('11Ab', 8)}`, 'github-pat'],
    ['a GitLab token', `glpat-${rep('xY1_', 6)}`, 'gitlab-token'],
    ['a Slack bot token', `xoxb-${rep('1234567890-', 2)}abcdef`, 'slack-token'],
    ['an AWS access key id', `AKIA${rep('AB12', 4)}`, 'aws-key'],
    ['a Google API key', `AIza${rep('xY_9', 9)}`, 'google-key'],
    ['a Telegram bot token', `123456789:${rep('AaB_', 9)}`, 'telegram-bot-token'],
    ['a JWT', `eyJ${rep('a1', 6)}.eyJ${rep('b2', 6)}.${rep('c3', 8)}`, 'jwt'],
  ];
  for (const [label, token, kind] of cases) {
    it(`redacts ${label}`, () => {
      assert.equal(redact(`before ${token} after`), `before [REDACTED:${kind}] after`);
    });
  }

  it('redacts a PEM private key block across lines', () => {
    const key = `-----BEGIN RSA PRIVATE KEY-----\n${rep('MIIBOgIBAAJB', 5)}\n${rep('AKj34GkxFhD9', 3)}\n-----END RSA PRIVATE KEY-----`;
    assert.equal(redact(`key:\n${key}\ndone`), 'key:\n[REDACTED:private-key]\ndone');
  });

  it('redacts credentials embedded in a URL but keeps the scheme and host', () => {
    assert.equal(redact('git clone https://deploy:pa55w0rd@git.example.test/team/repo.git'), 'git clone https://[REDACTED:url-credentials]@git.example.test/team/repo.git');
    assert.equal(redact('http://user:secret@localhost:8080/x'), 'http://[REDACTED:url-credentials]@localhost:8080/x');
  });
});

describe('redact: key = value assignments', () => {
  const secretNames = ['api_key', 'api-key', 'apikey', 'access_token', 'auth-token', 'secret_key', 'client_secret', 'password', 'passwd', 'pwd', 'token', 'secret', 'PASSWORD', 'Api_Key'];
  for (const name of secretNames) {
    it(`redacts the value after ${name}=`, () => {
      assert.equal(redact(`${name}=abcd1234efgh`), `${name}=[REDACTED:secret]`);
    });
  }

  it('accepts a colon, spaces and quotes around the value', () => {
    assert.equal(redact('password: hunter22hunter'), 'password: [REDACTED:secret]');
    assert.equal(redact('password = "hunter22hunter"'), 'password = "[REDACTED:secret]"');
    assert.equal(redact("token='abcdef123456'"), "token='[REDACTED:secret]'");
  });

  it('leaves values shorter than six characters alone', () => {
    assert.equal(redact('password=abc12'), 'password=abc12');
  });

  it('works in the middle of a command line and keeps the rest', () => {
    assert.equal(redact('curl --header token=abcdef123456 https://api.example.test/v1'), 'curl --header token=[REDACTED:secret] https://api.example.test/v1');
  });

  it('redacts several secrets in one string', () => {
    const text = `a ghp_${rep('Q1', 18)} b password=hunter22hunter c ${`AKIA${rep('ZZ99', 4)}`}`;
    assert.equal(redact(text), 'a [REDACTED:github-token] b password=[REDACTED:secret] c [REDACTED:aws-key]');
  });
});

describe('redact: e-mail addresses', () => {
  it('leaves e-mail addresses alone by default', () => {
    assert.equal(redact('write to jane.doe+news@example.co.uk please'), 'write to jane.doe+news@example.co.uk please');
  });

  it('masks them with { emails: true }', () => {
    assert.equal(redact('write to jane.doe+news@example.co.uk please', { emails: true }), 'write to [REDACTED:email] please');
  });
});

describe('redact: text that must stay untouched', () => {
  const untouched = [
    'Add a retry to the fetch helper in src/app.ts',
    'Нет, не надо трогать конфиг',
    'git commit -m "feat: add csv converter"',
    'a 40 character hash 0123456789abcdef0123456789abcdef01234567 is not a secret',
    'a uuid 11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa is not a secret',
    'the token expired yesterday, request a new one',
    'password reset flow and password policy',
    'visit https://example.test/docs:section@v2 for details',
    'http://localhost:3000/api/items',
    'version 1.2.3-beta.4 released at 10:45',
    'C:\\Users\\dev\\project\\src\\app.ts',
    'ssh-keygen -t ed25519 -C "dev laptop"',
    'npm run build -- --mode=production',
  ];
  for (const text of untouched) {
    it(`does not change: ${text.slice(0, 50)}`, () => {
      assert.equal(redact(text), text);
    });
  }
});

describe('redact: edge cases', () => {
  it('returns non-strings and empty strings unchanged', () => {
    assert.equal(redact(''), '');
    assert.equal(redact(null), null);
    assert.equal(redact(undefined), undefined);
    assert.equal(redact(42), 42);
    const obj = { a: 1 };
    assert.equal(redact(obj), obj);
  });

  it('gives the same answer on every call (global regexes carry no state between calls)', () => {
    const text = `x ghp_${rep('Q1', 18)} y password=hunter22hunter`;
    const first = redact(text);
    assert.equal(redact(text), first);
    assert.equal(redact(text), first);
  });

  it('is idempotent', () => {
    const text = `a ghp_${rep('Q1', 18)} b password=hunter22hunter c https://u:p4ssw0rd@h.example.test/`;
    const once = redact(text);
    assert.equal(redact(once), once);
  });

  it('keeps the surrounding multi-line text', () => {
    assert.equal(redact('line1\nline2 password=hunter22hunter\nline3'), 'line1\nline2 password=[REDACTED:secret]\nline3');
  });
});

describe('snippet', () => {
  it('collapses whitespace and newlines to single spaces and trims', () => {
    assert.equal(snippet('  hello \n\n  wide\tworld  '), 'hello wide world');
  });

  it('leaves text up to the limit unchanged', () => {
    assert.equal(snippet('a'.repeat(160)), 'a'.repeat(160));
  });

  it('truncates longer text to the limit, ending with an ellipsis', () => {
    const out = snippet('a'.repeat(300));
    assert.equal(out.length, 160);
    assert.ok(out.endsWith('…'));
    assert.equal(out, `${'a'.repeat(159)}…`);
  });

  it('honours a custom limit', () => {
    assert.equal(snippet('abcdefghij', 5), 'abcd…');
    assert.equal(snippet('abcde', 5), 'abcde');
  });

  it('returns an empty string for anything that is not a string', () => {
    assert.equal(snippet(undefined), '');
    assert.equal(snippet(null), '');
    assert.equal(snippet(5), '');
    assert.equal(snippet({}), '');
  });
});
