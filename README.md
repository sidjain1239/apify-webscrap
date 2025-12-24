# Web Scraper AI (Apify Actor)

Scrape a web page (HTTP first, browser fallback for JS-heavy pages) and optionally generate an AI summary via Pollinations.

## What it does

- Validates the input URL (`http` / `https` only)
- Tries a fast HTTP scrape first (Axios + Cheerio)
- If the page looks blocked / empty / JS-rendered, falls back to a headless browser scrape (Puppeteer + `@sparticuz/chromium`)
- Optionally calls Pollinations (`https://text.pollinations.ai/`) to produce a summary using your `prompt`

## Input

This Actor expects a JSON input with:

- `url` (required): page URL to scrape
- `prompt` (optional): if provided, the Actor will request an AI summary

Example:

```json
{
  "url": "https://example.com",
  "prompt": "Summarize the page in 5 bullets"
}
```

## Output

The Actor writes results to:

- Default dataset (one item per run)
- Key-value store as `OUTPUT`

Fields include:

- `url`, `methodUsed`, `scrapedAt`
- `title`, `description`, `paragraphs`, `images`, `links`
- `tables`, `lists`, `uniqueComponents`, `techStack`
- `summary` (only if `prompt` is provided)

## Run locally (Windows)

Install deps:

```bash
npm install
```

Quick smoke test:

```bash
npm run test:local
```

Run with your own URL:

```bash
npm run set-input -- --url https://example.com --prompt "Summarize this page"
npm start
```

Where to find output:

- `storage/datasets/default/000000001.json`
- `storage/key_value_stores/default/OUTPUT.json`

## Deploy / host on Apify

### Option A: Apify Console (UI) — easiest

1. Zip the project (or connect Git repo)
2. In Apify Console → **Actors** → **Create new** → **Source code**
3. Upload the code
4. Build the Actor image
5. Run it with an input JSON (see **Input** section)

### Option B: Apify CLI

If you use the Apify CLI:

1. Install/login:

```bash
npm i -g apify-cli
apify login
```

2. From this project folder:

```bash
apify push
```

3. Then run it from Apify Console or via CLI.

## Will I get the “form layout” like other Actors?

Yes.

Apify shows an input **form UI** automatically when your Actor provides an input schema. This project includes:

- `INPUT_SCHEMA.json` (defines the fields)
- `actor.json` references it via the `input` property

That’s what generates the “every actor has to fill details” form.

If you want more fields (proxy, cookies, max pages, etc.), you extend `INPUT_SCHEMA.json` and update the code to read them.

## Notes / limitations

- Some sites block scraping (bot protection, captchas, login walls). In those cases, the Actor may return `BLOCKED` / `LOGIN_REQUIRED`.
- AI summary depends on Pollinations availability/rate limits.
