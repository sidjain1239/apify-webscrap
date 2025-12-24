import { Actor } from 'apify';
import { scrapeAndSummarize } from './route.js';

await Actor.main(async () => {
  const input = (await Actor.getInput()) || {};

  if (!input.url) {
    throw new Error(
      'No INPUT was found. For local testing run: `npm run set-input -- --url https://example.com` then `npm start`.'
    );
  }

  const output = await scrapeAndSummarize(input);

  // Store results in the default dataset (most common Actor output).
  await Actor.pushData(output);
  // Also store a single object to KV store for easy retrieval.
  await Actor.setValue('OUTPUT', output);
});
