/* ============================================================
 * CRAWL-ALL PATCH for Amazon Now Deals Explorer v2
 *
 * HOW TO APPLY (two pastes into your v2 file):
 *   PASTE A: right after the parseHtmlSearchPage() function (before openResultsTab)
 *   PASTE B: right after  `panel.appendChild(globalBtn);`  (and after updateDiscountPillsUI is defined is fine,
 *            it only needs globalBtn, panel, tabNav, brandId, selectedMinDiscount, categoriesData)
 * ============================================================ */


/* ===================== PASTE A (helpers) ===================== */

// Walk any JSON structure, calling fn on every object
function walk(obj, fn, depth) {
  depth = depth || 0;
  if (!obj || depth > 14) return;
  if (Array.isArray(obj)) {
    for (var i = 0; i < obj.length; i++) walk(obj[i], fn, depth + 1);
    return;
  }
  if (typeof obj === 'object') {
    fn(obj);
    for (var k in obj) walk(obj[k], fn, depth + 1);
  }
}

// Shape-agnostic extraction: finds products AND links to other nodes anywhere in the JSON
function extractFromJson(json, catName) {
  var prods = [];
  var nodes = {};
  walk(json, function (o) {
    if (o.asin && (o.buyingPrice || o.listPrice || o.savings)) {
      var p = parseProduct(o, catName);
      if (p) prods.push(p);
    }
    ['nodeId', 'categoryNodeId', 'browseNodeId'].forEach(function (k) {
      if (o[k] && /^\d{9,13}$/.test(String(o[k]))) nodes[String(o[k])] = 1;
    });
    ['url', 'href', 'link', 'deeplink', 'deepLink', 'target'].forEach(function (k) {
      if (typeof o[k] === 'string') {
        var m = o[k].match(/nodeId=(\d{9,13})/);
        if (m) nodes[m[1]] = 1;
      }
    });
  });
  return { prods: prods, nodes: Object.keys(nodes) };
}

// If an endpoint returns HTML instead of JSON, pull embedded state + node links out of it
function scanHtmlState(html) {
  var doc = new DOMParser().parseFromString(html, 'text/html');
  var blobs = [];
  doc.querySelectorAll('script[type="a-state"],script[type="application/json"]').forEach(function (s) {
    try { blobs.push(JSON.parse(s.textContent)); } catch (e) {}
  });
  doc.querySelectorAll('a[href*="nodeId="]').forEach(function (a) {
    blobs.push({ href: a.getAttribute('href') });
  });
  return blobs;
}

var CRAWL_ENDPOINTS = ['category', 'merch', 'explore/category'];

// Try each endpoint style until one yields products or child nodes
async function fetchNodePage(nodeId, offset, hint, catName) {
  var order = hint
    ? [hint].concat(CRAWL_ENDPOINTS.filter(function (e) { return e !== hint; }))
    : CRAWL_ENDPOINTS;
  for (var i = 0; i < order.length; i++) {
    var ep = order[i];
    var url =
      'https://www.amazon.in/tez/browse/' + ep +
      '?nodeId=' + nodeId +
      '&brandId=' + brandId +
      '&qcbrand=' + brandId +
      '&offset=' + offset;
    try {
      var res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json, text/html' } });
      if (res.status === 429) return { status: 429 };
      if (!res.ok) continue;
      var txt = await res.text();
      var json;
      try { json = JSON.parse(txt); } catch (e) { json = scanHtmlState(txt); }
      var out = extractFromJson(json, catName);
      if (out.prods.length || out.nodes.length) {
        out.endpoint = ep;
        return out;
      }
    } catch (e) {}
  }
  return null;
}

// Breadth-first crawl: fetch every node, follow every node it links to
async function crawlAll(seedNodes, maxNodes, nameFor, onProgress) {
  var queue = seedNodes.slice();
  var seen = {};
  var seenCount = 0;
  var items = [];
  var byAsin = {};
  var hints = {};

  while (queue.length && seenCount < maxNodes) {
    var node = queue.shift();
    if (seen[node]) continue;
    seen[node] = 1;
    seenCount++;

    var cat = nameFor(node);
    var offset = 0, emptyStreak = 0, rl = 0;

    while (offset < 40) {
      onProgress(seenCount, maxNodes, queue.length, items.length, cat, offset + 1);
      var r = await fetchNodePage(node, offset, hints[node], cat);

      if (r && r.status === 429) {
        if (++rl > 3) break;
        await sleep(4000 * rl);
        continue;
      }
      rl = 0;
      if (!r) break;
      hints[node] = r.endpoint;

      var added = 0;
      r.prods.forEach(function (p) {
        if (!byAsin[p.a]) {
          byAsin[p.a] = p;
          items.push(p);
          added++;
        } else if (p.c[0] && byAsin[p.a].c.indexOf(p.c[0]) === -1) {
          byAsin[p.a].c.push(p.c[0]);
        }
      });
      r.nodes.forEach(function (n) { if (!seen[n] && queue.indexOf(n) === -1) queue.push(n); });

      if (!r.prods.length) break;
      if (!added) { if (++emptyStreak >= 2) break; } else { emptyStreak = 0; }
      offset++;
      await sleep(500);
    }
  }
  return items;
}


/* ===================== PASTE B (button + handler) ===================== */

var crawlBtn = document.createElement('button');
crawlBtn.style.cssText =
  'width:100%;padding:10px 12px;margin-bottom:10px;background:#7c3aed;border:1px solid #6d28d9;border-radius:8px;font-size:12.5px;font-weight:700;color:#fff;cursor:pointer;text-align:center;box-shadow:0 2px 6px rgba(124,58,237,.25);touch-action:manipulation;';
crawlBtn.textContent = '🕸️ Crawl EVERYTHING (all categories + seasonal)';
panel.insertBefore(crawlBtn, tabNav);

crawlBtn.onclick = async function () {
  if (!ensureBrandId()) return;

  // Seeds: current page node, any node links on this page, all known categories, plus anything you paste
  var seeds = [];
  function addSeed(n) { if (n && seeds.indexOf(n) === -1) seeds.push(n); }

  var cur = new URLSearchParams(location.search).get('nodeId');
  addSeed(cur);
  document.querySelectorAll('a[href*="nodeId="]').forEach(function (a) {
    var m = a.href.match(/nodeId=(\d{9,13})/);
    if (m) addSeed(m[1]);
  });
  var nameMap = {};
  categoriesData.forEach(function (g) {
    g.subs.forEach(function (s) { addSeed(s[1]); nameMap[s[1]] = s[0]; });
  });

  var extra = prompt(
    'Optional: paste extra explore/category URLs or node IDs (comma-separated). Leave blank to skip.',
    '220882624031'
  );
  if (extra) {
    extra.split(/[\s,]+/).forEach(function (tok) {
      var m = tok.match(/nodeId=(\d{9,13})/) || tok.match(/^(\d{9,13})$/);
      if (m) { seeds.unshift(m[1]); nameMap[m[1]] = nameMap[m[1]] || 'Seasonal ' + m[1]; }
    });
  }

  var maxNodes = parseInt(prompt('Max categories to crawl (more = slower, more requests):', '60'), 10) || 60;

  setAllControlsDisabled(true);
  crawlBtn.disabled = true;
  try {
    var items = await crawlAll(
      seeds,
      maxNodes,
      function (n) { return nameMap[n] || 'Other ' + n; },
      function (i, max, q, found, name, page) {
        crawlBtn.textContent = '(' + i + '/' + max + ', q' + q + ') ' + name + ' p' + page + ' - ' + found + ' found';
      }
    );
    // Same discount filter as the pills; set the pill to 10% (or lower) to see more
    items = items.filter(function (p) { return p.d >= selectedMinDiscount; });
    openResultsTab('Full Crawl (' + selectedMinDiscount + '%+ Off)', items);
  } finally {
    crawlBtn.disabled = false;
    crawlBtn.textContent = '🕸️ Crawl EVERYTHING (all categories + seasonal)';
    setAllControlsDisabled(false);
    updateDiscountPillsUI();
    updateSearchUI();
    updateCategoryUI();
  }
};
