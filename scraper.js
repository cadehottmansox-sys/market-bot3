const https = require('https');
const http = require('http');
const { URL } = require('url');

function fetchHTML(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        ...extraHeaders,
      },
    };
    const req = lib.request(options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchHTML(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ html: data, status: res.statusCode }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timed out')); });
    req.end();
  });
}

function toPlainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ').trim();
}

function upsizeEbayImage(url) {
  if (!url) return null;
  return url.replace(/s-l\d+\.(webp|jpg)/i, 's-l500.webp');
}

async function scrapeEbay(query, limit = 12) {
  const shortQuery = query.split(' ').slice(0, 6).join(' ');
  const encoded = encodeURIComponent(shortQuery);
  const url = 'https://www.ebay.com/sch/i.html?_nkw=' + encoded + '&LH_Sold=1&LH_Complete=1&_sop=13&_ipg=60';
  console.log('[eBay] Fetching: ' + url);
  try {
    const { html, status } = await fetchHTML(url);
    console.log('[eBay] Status: ' + status + ', size: ' + html.length);
    if (status !== 200) return [];
    const imagePositions = [];
    const imgPattern = /https:\/\/i\.ebayimg\.com\/images\/g\/([^"'\s]+\.(?:webp|jpg))/g;
    let imgMatch;
    while ((imgMatch = imgPattern.exec(html)) !== null) {
      imagePositions.push({ url: upsizeEbayImage(imgMatch[0]), pos: imgMatch.index });
    }
    const text = toPlainText(html);
    const soldPattern = /Sold\s{1,3}((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s*\d{4})/gi;
    const splits = [];
    let m;
    while ((m = soldPattern.exec(text)) !== null) {
      splits.push({ index: m.index, date: m[1].trim() });
    }
    console.log('[eBay] Found ' + splits.length + ' sold markers');
    const soldHtmlPattern = /Sold\s{1,3}(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/gi;
    const soldHtmlPositions = [];
    let shm;
    while ((shm = soldHtmlPattern.exec(html)) !== null) {
      soldHtmlPositions.push(shm.index);
    }
    const items = [];
    for (let i = 0; i < splits.length && items.length < limit; i++) {
      const start = splits[i].index;
      const end = splits[i + 1] ? splits[i + 1].index : start + 800;
      const chunk = text.substring(start, end);
      const date = splits[i].date;
      const titleMatch = chunk.match(/Sold\s{1,3}[A-Z][a-z]+\.?\s+\d{1,2},?\s*\d{4}\s+(.+?)\s+Opens in a new window/i);
      let title = titleMatch ? titleMatch[1].trim() : null;
      if (!title) continue;
      title = title.replace(/\s*(Pre-Owned|Brand New|New with tags|Used|Like New)$/i, '').trim();
      if (title.toLowerCase().includes('shop on ebay') || title.length < 4 || title.length > 200) continue;
      const priceMatch = chunk.match(/\$([0-9,]+\.?\d*)/);
      const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : null;
      if (!price || price <= 0) continue;
      const condMatch = chunk.match(/Opens in a new window or tab\s+(Pre-Owned|Brand New|New with tags|New without tags|Used|Like New|For parts[^$\n]*)/i);
      const condition = condMatch ? condMatch[1].trim() : 'Pre-Owned';
      const htmlPos = soldHtmlPositions[i] || 0;
      let bestImg = null;
      let bestDist = Infinity;
      for (const img of imagePositions) {
        const dist = Math.abs(img.pos - htmlPos);
        if (dist < bestDist) { bestDist = dist; bestImg = img.url; }
      }
      items.push({ title, price, date, condition, imageUrl: bestImg, itemUrl: null, platform: 'eBay' });
    }
    console.log('[eBay] Parsed ' + items.length + ' sold listings');
    return items;
  } catch (err) {
    console.error('[eBay] Error:', err.message);
    return [];
  }
}

async function scrapeDepop(query, limit = 10) {
  const shortQuery = query.split(' ').slice(0, 5).join(' ');
  const encoded = encodeURIComponent(shortQuery);
  const endpoints = [
    'https://webapi.depop.com/api/v2/search/products/?q=' + encoded + '&sold=true&country=us&currency=USD&itemsPerPage=12',
    'https://webapi.depop.com/api/v1/search/products/?q=' + encoded + '&sold=true&country=us&currency=USD',
  ];
  for (const apiUrl of endpoints) {
    try {
      const { html, status } = await fetchHTML(apiUrl, {
        'Accept': 'application/json',
        'Origin': 'https://www.depop.com',
        'Referer': 'https://www.depop.com/',
        'depop-app-type': 'web',
      });
      if (status === 200) {
        const data = JSON.parse(html);
        const products = data?.products || data?.data?.products || [];
        if (products.length > 0) {
          console.log('[Depop] Got ' + products.length + ' from API');
          return products.slice(0, limit).map((p) => ({
            title: p.description || p.slug?.replace(/-/g, ' ') || 'Depop Item',
            price: parseFloat(p.price?.priceAmount || p.priceAmount || 0),
            date: 'Recently sold',
            condition: p.variants?.[0]?.condition?.en || 'Used',
            imageUrl: p.preview?.[0]?.url || null,
            itemUrl: 'https://www.depop.com/products/' + (p.slug || p.id) + '/',
            platform: 'Depop',
          }));
        }
      }
    } catch (e) {
      console.warn('[Depop] failed:', e.message);
    }
  }
  try {
    const pageUrl = 'https://www.depop.com/search/?q=' + encoded + '&sold=true';
    const { html, status } = await fetchHTML(pageUrl, { 'Referer': 'https://www.depop.com/' });
    if (status === 200) {
      const ndm = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
      if (ndm) {
        const data = JSON.parse(ndm[1]);
        const products = data?.props?.pageProps?.searchResults?.products || data?.props?.pageProps?.products || [];
        if (products.length > 0) {
          return products.slice(0, limit).map((p) => ({
            title: p.description || 'Depop Item',
            price: parseFloat(p.price?.priceAmount || 0),
            date: 'Recently sold', condition: 'Used',
            imageUrl: p.preview?.[0]?.url || null,
            itemUrl: 'https://www.depop.com/products/' + p.slug + '/',
            platform: 'Depop',
          }));
        }
      }
    }
  } catch (e) {
    console.warn('[Depop] fallback failed:', e.message);
  }
  return [];
}

function getPriceStats(listings) {
  const prices = listings.map((l) => l.price).filter((p) => p > 0);
  if (!prices.length) return null;
  prices.sort((a, b) => a - b);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const median = prices[Math.floor(prices.length / 2)];
  return { avg: avg.toFixed(2), median: median.toFixed(2), min: prices[0].toFixed(2), max: prices[prices.length - 1].toFixed(2), count: prices.length };
}

module.exports = { scrapeEbay, scrapeDepop, getPriceStats, upsizeEbayImage };
