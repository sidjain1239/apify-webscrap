import { Actor } from 'apify';
import path from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--prompt') out.prompt = argv[++i];
  }
  return out;
}

// Use a predictable local storage directory unless the user overrides it.
process.env.CRAWLEE_STORAGE_DIR ||= path.join(process.cwd(), 'storage');

const cli = parseArgs(process.argv.slice(2));
const url = cli.url || process.env.URL;
const prompt = cli.prompt || process.env.PROMPT;

if (!url) {
  console.error('Missing url. Usage: node scripts/set-input.mjs --url https://example.com [--prompt "..."]');
  process.exit(1);
}

await Actor.init();
await Actor.setValue('INPUT', { url, ...(prompt ? { prompt } : {}) });
await Actor.exit();

console.log('Wrote INPUT to:', process.env.CRAWLEE_STORAGE_DIR);
