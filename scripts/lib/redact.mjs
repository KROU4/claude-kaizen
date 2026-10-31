// Secret scrubbing for anything that leaves the raw transcript and lands in a
// digest an LLM (or a bug report) may read. Conservative by design: false
// positives cost a few characters, false negatives leak credentials.

// The `sk-` prefixes must not be glued to a preceding letter or digit, otherwise kebab-case words
// such as "task-management-system-configuration" or "risk-assessment-report" would be mangled.
const PATTERNS = [
  ['anthropic-key', /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{16,}/g],
  ['openai-key', /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{16,}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['telegram-bot-token', /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['url-credentials', /(https?:\/\/)([^\s/:@]+):([^\s@]+)@/g],
  // `Authorization: Bearer <opaque token>` / `Authorization: Basic <base64>`; the scheme word is required so plain
  // prose such as "authorization: required" stays readable.
  ['authorization', /(authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+)[^\s"',;]{8,}/gi],
  // A bare `Bearer <token>` (no header name, e.g. inside a curl flag or a log line); needs a digit so that
  // "bearer of bad news" is left alone.
  ['bearer', /(?<![A-Za-z0-9])(bearer\s+)(?=[A-Za-z0-9._~+\/=-]*\d)[A-Za-z0-9._~+\/=-]{12,}/gi],
  [
    'assignment',
    // An identifier prefix is allowed (PGPASSWORD=, DB_PASSWORD=, MY_SECRET=, GITHUB_TOKEN=): `\b` before the key
    // name alone would not match inside such a word. AWS_SECRET_ACCESS_KEY has the key word in the middle, so it is
    // listed explicitly; an optional closing quote before the separator covers JSON / YAML keys ("password": "...").
    /(?<![A-Za-z0-9])((?:[A-Za-z0-9_-]{0,40}?)(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?access[_-]?key|secret[_-]?key|client[_-]?secret|password|passwd|pwd|token|secret)["']?\s*[:=]\s*["']?)([^\s"'<>]{6,})/gi,
  ],
];

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Replace credential-looking substrings with [REDACTED:kind].
 * @param {string} text
 * @param {{emails?: boolean}} opts  emails=true also masks e-mail addresses
 */
export function redact(text, opts = {}) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [kind, re] of PATTERNS) {
    re.lastIndex = 0;
    if (kind === 'url-credentials') {
      out = out.replace(re, '$1[REDACTED:url-credentials]@');
    } else if (kind === 'assignment') {
      out = out.replace(re, '$1[REDACTED:secret]');
    } else if (kind === 'authorization' || kind === 'bearer') {
      out = out.replace(re, '$1[REDACTED:auth]');
    } else {
      out = out.replace(re, `[REDACTED:${kind}]`);
    }
  }
  if (opts.emails) out = out.replace(EMAIL, '[REDACTED:email]');
  return out;
}

/** Shorten a snippet for a digest: single line, trimmed, hard length cap. */
export function snippet(text, max = 160) {
  if (typeof text !== 'string') return '';
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}
