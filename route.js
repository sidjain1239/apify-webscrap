import axios from 'axios';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

export const runtime = 'nodejs';
export const maxDuration = 60;

const OVERALL_TIMEOUT_MS = 25000;

const MAX_TABLES = 10;
const MAX_TABLE_ROWS = 50;
const MAX_TABLE_COLS = 20;
const MAX_LISTS = 30;
const MAX_LIST_ITEMS = 60;
const MAX_UNIQUE_COMPONENTS = 80;

function withTimeout(promise, ms, errorMessage) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMessage)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function validateScrapeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('INVALID_URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('INVALID_URL_PROTOCOL');
  }

  return parsed.href;
}

function normalizeText(value) {
  if (!value) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function extractTables($) {
  const tables = [];

  $('table').each((_, table) => {
    if (tables.length >= MAX_TABLES) return;
    const $table = $(table);

    const caption = normalizeText($table.find('caption').first().text());

    // Headers: prefer thead, fallback to first row if it contains th.
    let headers = [];
    const theadHeaderCells = $table.find('thead tr').first().find('th, td');
    if (theadHeaderCells.length > 0) {
      headers = theadHeaderCells
        .map((_, cell) => normalizeText($(cell).text()))
        .get()
        .slice(0, MAX_TABLE_COLS);
    } else {
      const firstRow = $table.find('tr').first();
      const firstRowHasTh = firstRow.find('th').length > 0;
      if (firstRowHasTh) {
        headers = firstRow
          .find('th, td')
          .map((_, cell) => normalizeText($(cell).text()))
          .get()
          .slice(0, MAX_TABLE_COLS);
      }
    }

    const rows = [];
    const allRows = $table.find('tbody tr').length ? $table.find('tbody tr') : $table.find('tr');
    allRows.each((rowIdx, tr) => {
      if (rows.length >= MAX_TABLE_ROWS) return;
      // If we used the first row as headers, skip it in data rows.
      if (rowIdx === 0 && headers.length > 0 && $table.find('thead tr').length === 0) {
        return;
      }

      const cells = $(tr)
        .find('th, td')
        .map((_, cell) => normalizeText($(cell).text()))
        .get()
        .slice(0, MAX_TABLE_COLS)
        .filter((v) => v.length > 0);

      if (cells.length > 0) rows.push(cells);
    });

    if (headers.length === 0 && rows.length === 0) return;

    const colCount = Math.max(
      headers.length,
      ...rows.map((r) => r.length)
    );

    tables.push({
      caption,
      headers,
      rows,
      rowCount: rows.length,
      colCount,
      html: $.html(table)
    });
  });

  return tables;
}

function extractLists($) {
  const lists = [];

  $('ul, ol').each((_, list) => {
    if (lists.length >= MAX_LISTS) return;
    const $list = $(list);
    const type = list?.tagName?.toLowerCase?.() === 'ol' ? 'ol' : 'ul';

    const items = $list
      .find('li')
      .map((_, li) => normalizeText($(li).text()))
      .get()
      .filter((t) => t.length > 0)
      .slice(0, MAX_LIST_ITEMS);

    if (items.length === 0) return;

    lists.push({
      type,
      items,
      itemCount: items.length,
      html: $.html(list)
    });
  });

  return lists;
}

function extractUniqueComponents($) {
  const candidates = [
    // Text structure
    'h1,h2,h3,h4,h5,h6',
    'blockquote',
    'pre',
    'code',

    // Forms/inputs
    'form',
    'button',
    'input',
    'select',
    'textarea',

    // Layout/semantic
    'header',
    'nav',
    'main',
    'section',
    'article',
    'aside',
    'footer',

    // Embeds/media (excluding img which we already extract)
    'iframe',
    'video',
    'audio'
  ].join(',');

  const skipTags = new Set(['p', 'a', 'img', 'table', 'ul', 'ol']);
  const seen = new Set();
  const out = [];

  const pickAttrs = (el) => {
    const attrs = ['type', 'name', 'id', 'placeholder', 'value', 'aria-label', 'role', 'title'];
    const parts = [];
    for (const attr of attrs) {
      const v = $(el).attr(attr);
      if (v) parts.push(`${attr}=${normalizeText(v)}`);
    }
    return parts.join(' | ');
  };

  $(candidates).each((_, el) => {
    if (out.length >= MAX_UNIQUE_COMPONENTS) return;
    const tag = (el?.tagName || '').toLowerCase();
    if (!tag || skipTags.has(tag)) return;

    let name = tag;
    if (tag === 'input') {
      const t = normalizeText($(el).attr('type'));
      if (t) name = `input[type=${t}]`;
    }

    let content = normalizeText($(el).text());
    if (!content) {
      content = normalizeText($(el).attr('aria-label')) ||
        normalizeText($(el).attr('placeholder')) ||
        normalizeText($(el).attr('title')) ||
        '';
    }
    const attrs = pickAttrs(el);
    if (attrs) {
      content = content ? `${content} (${attrs})` : attrs;
    }

    if (!content) return;

    // De-dup by (name + content)
    const key = `${name}::${content}`;
    if (seen.has(key)) return;
    seen.add(key);

    // Keep content bounded
    out.push({
      name,
      content: content.slice(0, 300)
    });
  });

  return out;
}

function extractFromHtml(html, url) {
  const $ = cheerio.load(html);
  const textContent = $('body').text().trim();

  const tables = extractTables($);
  const lists = extractLists($);
  const uniqueComponents = extractUniqueComponents($);

  const paragraphs = $('p, article p, main p, .content p')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => t.length > 30);

  return {
    title: $('title').text().trim() || $('h1').first().text().trim() || 'No title found',
    description:
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      $('p').first().text().trim().slice(0, 160) ||
      '',
    paragraphs,
    images: $('img')
      .map((_, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src');
        if (!src) return null;
        try {
          return new URL(src, url).href;
        } catch {
          return src.startsWith('http') ? src : null;
        }
      })
      .get()
      .filter(Boolean)
      .slice(0, 20),
    links: $('a')
      .map((_, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim();
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return null;
        try {
          return { url: new URL(href, url).href, text: text || href };
        } catch {
          return href.startsWith('http') ? { url: href, text: text || href } : null;
        }
      })
      .get()
      .filter(Boolean)
      .slice(0, 50),
    tables,
    lists,
    uniqueComponents,
    rawHtml: html,
    techStack: detectTechStack(html, url),
    _bodyTextLength: textContent.length
  };
}

function looksBlockedOrJsRequired(html, extracted) {
  const lower = (html || '').toLowerCase();
  if (extracted?._bodyTextLength < 120) return true;
  if (lower.includes('enable javascript')) return true;
  if (lower.includes('please enable cookies')) return true;
  if (lower.includes('attention required') && lower.includes('cloudflare')) return true;
  if (lower.includes('cf-chl') || lower.includes('challenge-platform')) return true;
  if (lower.includes('access denied')) return true;
  return false;
}

function looksEmptyExtraction(extracted) {
  const paras = extracted?.paragraphs?.length || 0;
  const links = extracted?.links?.length || 0;
  const bodyLen = extracted?._bodyTextLength ?? 0;

  // If the body is tiny and we got basically nothing, this is likely blocked/challenged.
  if (bodyLen < 200 && paras < 2) return true;

  // Many bot walls return a couple of generic links.
  if (paras === 0 && links <= 3) return true;

  return false;
}

function formatTablesForPrompt(tables) {
  if (!Array.isArray(tables) || tables.length === 0) return '';
  const lines = [];
  const maxTables = 6;
  const maxRowsPerTable = 6;

  for (let i = 0; i < Math.min(maxTables, tables.length); i++) {
    const t = tables[i] || {};
    const caption = normalizeText(t.caption);
    const headers = Array.isArray(t.headers) ? t.headers.map(normalizeText).filter(Boolean) : [];
    const rows = Array.isArray(t.rows) ? t.rows : [];

    lines.push(`Table ${i + 1}${caption ? ` (caption: ${caption})` : ''}:`);
    if (headers.length) lines.push(`- headers: ${headers.join(' | ')}`);

    const rowCount = Math.min(maxRowsPerTable, rows.length);
    for (let r = 0; r < rowCount; r++) {
      const row = Array.isArray(rows[r]) ? rows[r].map(normalizeText).filter(Boolean) : [];
      if (row.length) lines.push(`- row ${r + 1}: ${row.join(' | ')}`);
    }
    if (rows.length > rowCount) lines.push(`- … (${rows.length - rowCount} more rows)`);
  }

  if (tables.length > maxTables) lines.push(`… (${tables.length - maxTables} more tables)`);
  return lines.join('\n');
}

function formatListsForPrompt(lists) {
  if (!Array.isArray(lists) || lists.length === 0) return '';
  const lines = [];
  const maxLists = 10;
  const maxItemsPerList = 10;

  for (let i = 0; i < Math.min(maxLists, lists.length); i++) {
    const l = lists[i] || {};
    const type = l.type === 'ol' ? 'ordered' : 'unordered';
    const items = Array.isArray(l.items) ? l.items.map(normalizeText).filter(Boolean) : [];
    lines.push(`List ${i + 1} (${type}):`);
    const itemCount = Math.min(maxItemsPerList, items.length);
    for (let k = 0; k < itemCount; k++) {
      lines.push(`- ${items[k]}`);
    }
    if (items.length > itemCount) lines.push(`- … (${items.length - itemCount} more items)`);
  }

  if (lists.length > maxLists) lines.push(`… (${lists.length - maxLists} more lists)`);
  return lines.join('\n');
}

async function scrapeWithHttp(url) {
  const response = await axios.get(url, {
    headers: { 
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1'
    },
    timeout: 60000,
    maxRedirects: 5,
    validateStatus: (status) => status < 500
  });

  if (response.status >= 400) {
    throw new Error(`HTTP_ERROR_${response.status}`);
  }

  const extracted = extractFromHtml(response.data, url);

  // Heuristic: if body text is tiny, it's likely JS-rendered or blocked.
  if (looksBlockedOrJsRequired(response.data, extracted)) {
    throw new Error('JAVASCRIPT_RENDERED');
  }

  const { _bodyTextLength, ...rest } = extracted;
  return rest;
}

async function scrapeWithBrowser(url) {
  const isServerlessChromium = Boolean(
    process.env.VERCEL ||
      process.env.NETLIFY ||
      process.env.NETLIFY_LOCAL ||
      process.env.AWS_LAMBDA_FUNCTION_VERSION ||
      // Apify Actor runtime
      process.env.APIFY_ACTOR_RUN_ID ||
      process.env.APIFY_IS_AT_HOME
  );

  const guessLocalExecutablePath = () => {
    const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (envPath) return envPath;

    // Common local Chrome paths (best-effort; safe to try).
    if (process.platform === 'win32') {
      return (
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      );
    }
    if (process.platform === 'darwin') {
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    }
    return null;
  };

  const launchOptions = isServerlessChromium
    ? {
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless
      }
    : {
        // Local dev on Windows/macOS typically needs an explicit Chrome path.
        // Set PUPPETEER_EXECUTABLE_PATH to your Chrome/Chromium.
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: guessLocalExecutablePath(),
        headless: true
      };

  if (!launchOptions.executablePath) {
    throw new Error(
      isServerlessChromium
        ? 'BROWSER_EXECUTABLE_NOT_FOUND'
        : 'LOCAL_BROWSER_EXECUTABLE_NOT_CONFIGURED'
    );
  }

  const browser = await puppeteer.launch({ ...launchOptions, timeout: 20000 });
  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(15000);
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (type === 'image' || type === 'font' || type === 'stylesheet' || type === 'media') {
        return req.abort();
      }
      return req.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the DOM to become meaningful. Many SPA sites first show a shell/logo.
    try {
      await page.waitForFunction(
        () => (document?.body?.innerText || '').replace(/\s+/g, ' ').trim().length > 300,
        { timeout: 8000 }
      );
    } catch {
      // Ignore; we'll still attempt extraction.
    }


    const tryNetworkIdle = async (timeout) => {
      try {
        await page.waitForNetworkIdle({ idleTime: 750, timeout });
      } catch {
        // Some sites keep connections open; ignore.
      }
    };

    const tryExtractLoop = async () => {
      const maxAttempts = 6;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await tryNetworkIdle(8000);

        const html = await page.content();
        const extracted = extractFromHtml(html, url);

        if (!looksBlockedOrJsRequired(html, extracted) && !looksEmptyExtraction(extracted)) {
          return { html, extracted };
        }

        // Scroll in steps to trigger lazy-load/infinite feeds.
        try {
          await page.evaluate(() => {
            window.scrollBy(0, Math.max(window.innerHeight, 800));
          });
          await page.waitForTimeout(900 + attempt * 200);
        } catch {
          // Ignore scroll issues.
        }
      }
      return null;
    };

    const loopResult = await tryExtractLoop();
    if (!loopResult) throw new Error('BLOCKED_OR_EMPTY');

    const { html, extracted } = loopResult;

    const { _bodyTextLength, ...rest } = extracted;
    return rest;
  } finally {
    await browser.close();
  }
}

function detectTechStack(html, url) {
  const technologies = [];
  const lowerHtml = html.toLowerCase();
  
  // Frontend frameworks
  if (lowerHtml.includes('react') || lowerHtml.includes('_next') || lowerHtml.includes('__next')) {
    if (lowerHtml.includes('_next')) technologies.push({ name: 'Next.js', icon: 'Next' });
    else technologies.push({ name: 'React', icon: 'React' });
  }
  if (lowerHtml.includes('vue') || lowerHtml.includes('nuxt')) {
    technologies.push({ name: lowerHtml.includes('nuxt') ? 'Nuxt.js' : 'Vue.js', icon: 'Vue' });
  }
  if (lowerHtml.includes('angular') || lowerHtml.includes('ng-version')) {
    technologies.push({ name: 'Angular', icon:  'Angular' });
  }
  if (lowerHtml.includes('svelte')) {
    technologies.push({ name: 'Svelte', icon: 'Svelte' });
  }
  
  // CSS Frameworks
  if (lowerHtml.includes('bootstrap')) {
    technologies.push({ name: 'Bootstrap', icon: 'Bootstrap' });
  }
  if (lowerHtml.includes('tailwind')) {
    technologies.push({ name: 'Tailwind CSS', icon: 'Tailwind' });
  }
  if (lowerHtml.includes('material-ui') || lowerHtml.includes('mui')) {
    technologies.push({ name: 'Material-UI', icon: 'MUI' });
  }
  
  // Backend & CMS
  if (lowerHtml.includes('wordpress') || lowerHtml.includes('wp-content')) {
    technologies.push({ name: 'WordPress', icon:  'WP' });
  }
  if (lowerHtml.includes('shopify')) {
    technologies.push({ name: 'Shopify', icon: 'Shopify' });
  }
  if (lowerHtml.includes('wix')) {
    technologies.push({ name: 'Wix', icon: 'Wix' });
  }
  
  // Analytics & Tools
  if (lowerHtml.includes('google-analytics') || lowerHtml.includes('gtag')) {
    technologies.push({ name: 'Google Analytics', icon: 'GA' });
  }
  if (lowerHtml.includes('jquery')) {
    technologies.push({ name: 'jQuery', icon:  'jQuery' });
  }
  if (lowerHtml.includes('cloudflare')) {
    technologies.push({ name: 'Cloudflare', icon: 'CF' });
  }
  
  // Meta frameworks
  if (lowerHtml.includes('gatsby')) {
    technologies.push({ name: 'Gatsby', icon: 'Gatsby' });
  }
  if (lowerHtml.includes('remix')) {
    technologies.push({ name: 'Remix', icon: 'Remix' });
  }
  
  // Hosting/Platform
  if (url.includes('vercel.app')) {
    technologies.push({ name: 'Vercel', icon: 'Vercel' });
  }
  if (url.includes('netlify.app')) {
    technologies.push({ name: 'Netlify', icon: 'Netlify' });
  }
  if (url.includes('github.io')) {
    technologies.push({ name: 'GitHub Pages', icon: 'GitHub' });
  }
  
  return technologies;
}

export async function scrapeAndSummarize(input) {
  const { url, prompt } = input || {};

  if (!url) {
    const err = new Error('URL_REQUIRED');
    err.statusCode = 400;
    err.publicPayload = { error: 'URL is required' };
    throw err;
  }

  let normalizedUrl;
  try {
    normalizedUrl = validateScrapeUrl(url);
  } catch (e) {
    const code = e?.message || 'INVALID_URL';
    const err = new Error(code);
    err.statusCode = 400;
    err.publicPayload = {
      error: 'Invalid URL',
      errorType: code,
      message:
        code === 'INVALID_URL_PROTOCOL'
          ? 'Only http(s) URLs are allowed.'
          : 'Invalid URL format',
      url
    };
    throw err;
  }

  console.log('[INFO] Scraping:', { url: normalizedUrl, mode: 'auto' });

  let scraped;
  let methodUsed = 'HTTP';
  let httpError = null;

  try {
    scraped = await withTimeout(
      scrapeWithHttp(normalizedUrl),
      Math.min(OVERALL_TIMEOUT_MS, 15000),
      'HTTP_TIMEOUT'
    );
    methodUsed = 'HTTP';
  } catch (err) {
    httpError = err;
    console.error('[ERROR] HTTP scraping failed:', err?.message);
  }

  if (!scraped) {
    try {
      scraped = await withTimeout(
        scrapeWithBrowser(normalizedUrl),
        OVERALL_TIMEOUT_MS,
        'BROWSER_TIMEOUT'
      );
      methodUsed = 'BROWSER';
    } catch (err) {
      console.error('[ERROR] Browser scraping failed:', err?.message);
      const details = {
        httpError: httpError?.message || null,
        browserError: err?.message || null
      };

      const isTimeout =
        details.httpError?.includes('TIMEOUT') || details.browserError?.includes('TIMEOUT');
      const isBlocked = details.browserError === 'BLOCKED_OR_EMPTY';
      const isLoginOrBlocked = details.browserError === 'LOGIN_OR_BLOCKED';

      const errorType = isTimeout
        ? 'TIMEOUT'
        : isLoginOrBlocked
          ? 'LOGIN_REQUIRED'
          : isBlocked
            ? 'BLOCKED'
            : 'SCRAPE_ERROR';

      const errOut = new Error(errorType);
      errOut.statusCode = 422;
      errOut.publicPayload = {
        error: 'Scraping failed',
        errorType,
        message: isTimeout
          ? '⚠️ Scraping timed out on the server. This often happens on serverless hosts for heavy pages.'
          : isLoginOrBlocked
            ? '⚠️ This page likely requires login or restricts automated access (common on social platforms like Instagram). For reliable results, use the platform’s official API or scrape only content you’re authorized to access.'
            : isBlocked
              ? '⚠️ This site appears to block scraping from server IPs (bot protection/captcha).'
              : '⚠️ Unable to scrape this site. It may be blocking automation or requires interaction/login.',
        url: normalizedUrl,
        details,
        timestamp: new Date().toISOString()
      };
      throw errOut;
    }
  }

  const contentText = (scraped.paragraphs || []).join('\n');
  const tablesText = formatTablesForPrompt(scraped.tables);
  const listsText = formatListsForPrompt(scraped.lists);

  const fullText = `
Title: ${scraped.title}
URL: ${normalizedUrl}
Description: ${scraped.description}

Text (paragraphs):
${contentText}

Tables:
${tablesText || 'None'}

Lists:
${listsText || 'None'}
`.trim().slice(0, 4500);

  let summary = '';
  if (prompt) {
    try {
      const res = await axios.post(
        'https://text.pollinations.ai/',
        {
          messages: [{ role: 'user', content: `${prompt}:\n\n${fullText}` }],
          model: 'openai',
          private: true
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000
        }
      );
      summary = res.data;
    } catch (apiError) {
      console.error('AI API error:', apiError.response?.data || apiError.message);
      if (apiError.response?.status === 429) {
        summary =
          'AI service is currently busy (rate limit). You can still view the scraped content and use chat later.';
      } else {
        summary = 'AI summary unavailable. You can still view the scraped content below.';
      }
    }
  }

  return {
    url: normalizedUrl,
    methodUsed,
    summary,
    ...scraped,
    scrapedAt: new Date().toISOString()
  };
}

export async function POST(request) {
  try {
    const input = await request.json();
    const output = await scrapeAndSummarize(input);
    return Response.json(output);
  } catch (error) {
    if (error?.publicPayload && error?.statusCode) {
      return Response.json(error.publicPayload, { status: error.statusCode });
    }

    console.error('Scrape error:', error);
    return Response.json(
      {
        error: 'Internal server error',
        message: 'An unexpected error occurred while processing your request.',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
}
