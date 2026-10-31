// Streaming JSONL reader. Transcripts can be hundreds of megabytes; we never
// hold more than one line in memory.
import fs from 'node:fs';
import readline from 'node:readline';

export async function* readJsonl(file, { onError } = {}) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of rl) {
      lineNo++;
      if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
      try {
        yield JSON.parse(line);
      } catch (err) {
        if (onError) onError(err, lineNo);
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }
}

export function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
