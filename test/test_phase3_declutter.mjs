import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from './lib/puppeteer.mjs';
import { ROOT, DIST, screenshotOutDir, keepScreenshot } from './app-source.mjs';

const SCREEN = path.join(ROOT, 'screenshots');
const OUT = screenshotOutDir();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png'
};
fs.mkdirSync(SCREEN, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const failed = [];
function assert(cond, msg) {
  if (!cond) { failed.push(msg); console.log('  FAIL  ' + msg); }
  else console.log('  ok    ' + msg);
}

async function ensureDesktopHover(page) {
  const already = await page.evaluate(() => window.matchMedia('(hover: hover)').matches);
  if (already) return true;
  try {
    const cdp = await page.target().createCDPSession();
    await cdp.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [
        { name: 'hover', value: 'hover' },
        { name: 'pointer', value: 'fine' },
        { name: 'any-hover', value: 'hover' },
        { name: 'any-pointer', value: 'fine' }
      ]
    });
  } catch (err) {
    console.log('  info  setEmulatedMedia(hover: hover) failed: ' + err.message);
  }
  return page.evaluate(() => window.matchMedia('(hover: hover)').matches);
}

const src = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8') + '\n'
  + fs.readFileSync(path.join(ROOT, 'src/tree.js'), 'utf8');
assert(src.includes('data-canvas-quick-edit') && src.includes('canvas-card-pencil'), 'canvas pencil exists');
assert(/person-card:hover \.canvas-card-pencil/.test(src) && /@media \(hover: none\)/.test(src) && /person-card\.selected \.canvas-card-pencil/.test(src), 'pencil CSS is hover-only on desktop and selected-on-touch');
assert(!src.includes('data-canvas-quick-add'), 'the in-card + pill is gone');
assert(src.includes('+Parent') && src.includes('+Spouse') && src.includes('+Child') && src.includes('+Sibling') && src.includes('canvas-add-bar'), 'the four-button canvas add bar is restored');
assert(/person-card:hover \.canvas-add-bar/.test(src) && /padding-top:\s*8px/.test(src), 'desktop add bar appears on hover of any editable card and uses a hover bridge');
assert(src.includes('add-bar-open') && src.includes('scheduleHideAddBar') && src.includes('180'), 'a short hide delay plus hover class keeps the bar reachable');
assert(/@media \(hover: none\)/.test(src) && /person-card\.selected \.canvas-add-bar/.test(src), 'on touch, the add bar stays on the selected card');
assert(!src.includes('(isSelected && canEditTree())'), 'the add bar is not limited to the selected card');
assert(/const CARD_W = 188/.test(src) && /const CARD_H = 104/.test(src), 'person cards are 188×104');
assert(/flex-direction:\s*row/.test(src) && !/flex flex-col items-center justify-center text-center/.test(src), 'the photo/avatar sits in a left column, not above the name');
assert(/const LAYER_HEIGHT = 200/.test(src) && /gutterTop \+ 36/.test(src), 'generation gutters leave room under the shorter card for the hover pill and union buses');
assert(!/data-set-child-linkage|data-set-union-status|data-move-union/.test(src.split('IMMEDIATE FAMILY')[1]?.slice(0, 2500) || ''), 'Immediate Family no longer has linkage, status, or reorder controls');
assert(!src.includes('Your wife') && !src.includes('WIFE:') && !/value=['\"]partner['\"]/.test(src), 'no gendered labels or partner status');

function fixture() {
  return {
    tree: { title: 'Phase 3 demo', id: 'demo', revision: 1 },
    persons: {
      a1: { id: 'a1', given: 'Alice', surname: 'Example', sex: 'F', livingStatus: 'living', events: [{ id: 'b1', type: 'BIRT', date: '1970' }] },
      b1: { id: 'b1', given: 'Bob', surname: 'Example', sex: 'M', livingStatus: 'living', events: [{ id: 'b2', type: 'BIRT', date: '1968' }] },
      c1: { id: 'c1', given: 'Cara', surname: 'Example', sex: 'F', livingStatus: 'living', events: [{ id: 'b3', type: 'BIRT', date: '2001' }] }
    },
    families: {
      f1: { id: 'f1', partner1Id: 'a1', partner2Id: 'b1', status: 'married', marriageDate: '12 Jun 1995', marriagePlace: 'Test Harbor', children: [{ personId: 'c1', linkage: 'biological' }] }
    },
    accessControl: { permissions: [] },
    changeEvents: [],
    changeSequence: 0,
    superAdminEmail: 'sa@example.com',
    centralPersonId: 'a1'
  };
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  const file = path.join(DIST, urlPath === '/' ? '/index.html' : urlPath);
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${PORT}/index.html?test=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => window.__TREE, { timeout: 15000 });

const familyUi = await page.evaluate((state) => {
  const T = window.__TREE;
  T.load(state);
  T.setTestWrite?.(() => ({ ok: true }));
  const ui = T.getUi();
  ui.accordions = ui.accordions || {};
  ui.accordions.family = true;
  T.openInspector('a1', 'profile');
  const body = document.getElementById('inspector-body');
  const familyHead = [...body.querySelectorAll('button, span')].find(el => /IMMEDIATE FAMILY/.test(el.textContent || ''));
  const section = familyHead ? familyHead.closest('div').parentElement : null;
  const list = section ? [...section.querySelectorAll('[data-search-pick]')] : [];
  return {
    hasLinkage: !!body.querySelector('[data-set-child-linkage]'),
    hasUnion: !!body.querySelector('[data-set-union-status]'),
    hasMove: !!body.querySelector('[data-move-union]'),
    labels: list.map(btn => ({
      name: btn.querySelector('.text-xs.font-semibold')?.textContent || '',
      sub: btn.querySelector('.text-\\[11px\\]')?.textContent || btn.innerText
    })),
    count: list.length
  };
}, fixture());

assert(!familyUi.hasLinkage && !familyUi.hasUnion && !familyUi.hasMove, 'Immediate Family has no inline linkage, status, or reorder controls');
assert(familyUi.count >= 2, 'Immediate Family lists relatives (' + familyUi.count + ')');
assert(familyUi.labels.some(l => /Bob/.test(l.name) && /Spouse/.test(l.sub)) && familyUi.labels.some(l => /Cara/.test(l.name)), 'rows show name, neutral role, and year: ' + JSON.stringify(familyUi.labels));
assert(familyUi.labels.every(l => !/wife|husband|your /i.test(l.sub)), 'roles stay gender-neutral');

await page.evaluate(() => {
  document.getElementById('btn-close-inspector')?.click();
  window.__TREE.closeQuickEditModal?.();
  document.getElementById('toast-banner')?.classList.add('hidden');
  window.__TREE.fitTreeToScreen?.();
});
await new Promise(r => setTimeout(r, 200));

const canvasRest = await page.evaluate(() => {
  document.querySelector('[data-person-card="a1"]')?.click();
  document.getElementById('btn-close-inspector')?.click();
  const card = document.querySelector('[data-person-card="a1"]');
  const pencil = card && card.querySelector('[data-canvas-quick-edit="a1"]');
  const addPill = document.querySelector('[data-canvas-quick-add]');
  const barLabels = [...(card ? card.querySelectorAll('button') : [])]
    .map(b => (b.textContent || '').trim())
    .filter(t => /^\+(Parent|Spouse|Child|Sibling)$/.test(t));
  return {
    hasPencil: !!pencil,
    hasAddPill: !!addPill,
    barLabels,
    selected: window.__TREE.getState().selectedPersonId
  };
});
assert(canvasRest.hasPencil && !canvasRest.hasAddPill, 'cards have a pencil and no + pill');
assert(canvasRest.selected === 'a1' && canvasRest.barLabels.length === 4, 'selected card has the +Parent/+Spouse/+Child/+Sibling bar: ' + JSON.stringify(canvasRest.barLabels));

const cardLayout = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('[data-person-card]')];
  const sizes = cards.map(el => {
    const r = el.getBoundingClientRect();
    const name = el.querySelector('.card-name');
    const life = el.querySelector('.card-lifespan');
    const av = el.querySelector('.card-avatar');
    const pencil = el.querySelector('[data-canvas-quick-edit]');
    const nr = name && name.getBoundingClientRect();
    const lr = life && life.getBoundingClientRect();
    const ar = av && av.getBoundingClientRect();
    const pr = pencil && pencil.getBoundingClientRect();
    const inside = (box) => !box || (box.top >= r.top - 0.5 && box.bottom <= r.bottom + 0.5 && box.left >= r.left - 0.5 && box.right <= r.right + 0.5);
    const hits = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const mid = (box) => box && (box.top + box.bottom) / 2;
    return {
      id: el.dataset.personCard,
      w: el.offsetWidth,
      h: el.offsetHeight,
      left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      nameInside: inside(nr),
      lifeInside: inside(lr),
      avatarLeftOfText: !!(ar && nr && ar.right <= nr.left + 1),
      avatarVCenter: ar ? Math.abs(mid(ar) - mid(r)) : 99,
      textHitsPencil: hits(nr, pr) || hits(lr, pr)
    };
  });
  let overlap = false;
  for (let i = 0; i < sizes.length; i++) {
    for (let j = i + 1; j < sizes.length; j++) {
      const a = sizes[i], b = sizes[j];
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) overlap = true;
    }
  }
  return { sizes, overlap, count: sizes.length };
});
assert(cardLayout.count >= 3 && cardLayout.sizes.every(c => Math.abs(c.w - 188) < 1 && Math.abs(c.h - 104) < 1), 'rendered person cards are 188×104: ' + JSON.stringify(cardLayout.sizes));
assert(!cardLayout.overlap, 'person cards do not overlap each other: ' + JSON.stringify(cardLayout.sizes));
assert(cardLayout.sizes.every(c => c.nameInside && c.lifeInside), 'name and dates stay inside the card without clipping: ' + JSON.stringify(cardLayout.sizes));
assert(cardLayout.sizes.every(c => c.avatarLeftOfText && c.avatarVCenter < 8), 'the avatar is on the left and vertically centered: ' + JSON.stringify(cardLayout.sizes));
assert(cardLayout.sizes.every(c => !c.textHitsPencil), 'the pencil does not overlap name or dates: ' + JSON.stringify(cardLayout.sizes));

await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
await page.mouse.move(2, 2);
await new Promise(r => setTimeout(r, 80));
const visibility = await page.evaluate(() => {
  const pencil = document.querySelector('[data-canvas-quick-edit="a1"]');
  const cs = pencil ? getComputedStyle(pencil) : null;
  return cs ? { opacity: cs.opacity, pe: cs.pointerEvents } : { missing: true };
});
const mediaHover = await page.evaluate(() => ({
  hover: window.matchMedia('(hover: hover)').matches,
  none: window.matchMedia('(hover: none)').matches
}));
if (mediaHover.hover) {
  assert(!visibility.missing && Number(visibility.opacity) === 0, 'desktop pencil stays hidden until hover (opacity=' + visibility.opacity + ')');
} else {
  console.log('  info  environment reports (hover: none); selected-card pencil follows the touch rule (opacity=' + visibility.opacity + ')');
  assert(!visibility.missing && Number(visibility.opacity) === 1, 'when hover is unavailable, a selected card shows the pencil (opacity=' + visibility.opacity + ')');
}

await page.hover('[data-person-card="a1"]');
await new Promise(r => setTimeout(r, 150));
const hovered = await page.evaluate(() => {
  const pencil = document.querySelector('[data-canvas-quick-edit="a1"]');
  const cs = pencil ? getComputedStyle(pencil) : null;
  const card = document.querySelector('[data-person-card="a1"]');
  const bar = card && card.querySelector('.canvas-add-bar');
  const barCs = bar ? getComputedStyle(bar) : null;
  return { opacity: cs && cs.opacity, pe: cs && cs.pointerEvents, bar: barCs && Number(barCs.opacity) === 1 };
});
assert(hovered.bar && Number(hovered.opacity) === 1, 'hovering a selected card shows the pencil and the add bar (opacity=' + hovered.opacity + ')');

let hoverPage = page;
let headedBrowser = null;
let desktopHover = await ensureDesktopHover(page);
if (!desktopHover) {
  try {
    headedBrowser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome',
      headless: false,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,900']
    });
    hoverPage = await headedBrowser.newPage();
    const hErrs = [];
    hoverPage.on('pageerror', e => hErrs.push(String(e)));
    await hoverPage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await hoverPage.goto(`http://127.0.0.1:${PORT}/index.html?test=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await hoverPage.waitForFunction(() => window.__TREE, { timeout: 15000 });
    await hoverPage.evaluate((state) => {
      const T = window.__TREE;
      T.load(state);
      T.setTestWrite?.(() => ({ ok: true }));
      T.closeQuickEditModal?.();
      document.getElementById('btn-close-inspector')?.click();
      document.getElementById('toast-banner')?.classList.add('hidden');
      T.fitTreeToScreen?.();
    }, fixture());
    await new Promise(r => setTimeout(r, 200));
    desktopHover = await hoverPage.evaluate(() => window.matchMedia('(hover: hover)').matches);
    if (!desktopHover) desktopHover = await ensureDesktopHover(hoverPage);
    if (!desktopHover) {
      console.log('  info  headed Chrome still reports (hover: none)');
      await headedBrowser.close();
      headedBrowser = null;
      hoverPage = page;
    } else {
      console.log('  info  using headed Chrome to exercise (hover: hover)');
      if (hErrs.length) console.log('  info  headed page errors: ' + hErrs.join(' | '));
    }
  } catch (err) {
    console.log('  info  headed hover fallback failed: ' + err.message);
    desktopHover = false;
    hoverPage = page;
    if (headedBrowser) {
      try { await headedBrowser.close(); } catch {}
      headedBrowser = null;
    }
  }
}
if (desktopHover) {
  await hoverPage.click('[data-person-card="a1"]');
  await hoverPage.evaluate(() => {
    document.getElementById('btn-close-inspector')?.click();
    window.__TREE.closeQuickEditModal?.();
    document.getElementById('toast-banner')?.classList.add('hidden');
    document.querySelectorAll('.person-card.add-bar-open').forEach((el) => el.classList.remove('add-bar-open'));
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  });
  await hoverPage.mouse.move(2, 2);
  await new Promise(r => setTimeout(r, 220));
  const awayBars = await hoverPage.evaluate(() => {
    const info = (sel) => {
      const card = document.querySelector(sel);
      const bar = card && card.querySelector('.canvas-add-bar');
      const cs = bar ? getComputedStyle(bar) : null;
      return { opacity: cs && cs.opacity, selected: card && card.classList.contains('selected') };
    };
    return { alice: info('[data-person-card="a1"]'), bob: info('[data-person-card="b1"]') };
  });
  assert(awayBars.alice.selected && Number(awayBars.alice.opacity) === 0, 'desktop: a selected card hides the add bar until hover (opacity=' + awayBars.alice.opacity + ')');
  assert(!awayBars.bob.selected && Number(awayBars.bob.opacity) === 0, 'desktop: an unselected card hides the add bar until hover (opacity=' + awayBars.bob.opacity + ')');

  await hoverPage.hover('[data-person-card="b1"]');
  await new Promise(r => setTimeout(r, 150));
  const bobHover = await hoverPage.evaluate(() => {
    const info = (sel) => {
      const card = document.querySelector(sel);
      const bar = card && card.querySelector('.canvas-add-bar');
      const inner = card && card.querySelector('.canvas-add-bar-inner');
      const pencil = card && card.querySelector('[data-canvas-quick-edit]');
      const cs = bar ? getComputedStyle(bar) : null;
      const pcs = pencil ? getComputedStyle(pencil) : null;
      const labels = [...(inner ? inner.querySelectorAll('button') : [])]
        .map(b => (b.textContent || '').trim())
        .filter(t => /^\+(Parent|Spouse|Child|Sibling)$/.test(t));
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      return {
        opacity: cs && cs.opacity,
        pe: cs && cs.pointerEvents,
        pencilOpacity: pcs && pcs.opacity,
        labels,
        selected: card && card.classList.contains('selected'),
        barRect: rect(inner),
        pencilRect: rect(pencil),
        cardRect: rect(card)
      };
    };
    return {
      bob: info('[data-person-card="b1"]'),
      alice: info('[data-person-card="a1"]'),
      selected: window.__TREE.getState().selectedPersonId
    };
  });
  assert(bobHover.selected === 'a1' && !bobHover.bob.selected, 'hovering Bob does not select him (selected=' + bobHover.selected + ')');
  assert(Number(bobHover.bob.opacity) === 1 && bobHover.bob.pe !== 'none' && bobHover.bob.labels.length === 4, 'hovering an unselected editable card shows the add bar');
  assert(Number(bobHover.bob.pencilOpacity) === 1, 'hovering an unselected card also shows the pencil');
  assert(Number(bobHover.alice.opacity) === 0, 'the selected card that is not hovered does not show the add bar');
  const boxesOverlap = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  assert(!boxesOverlap(bobHover.bob.pencilRect, bobHover.bob.barRect), 'the pencil and add bar do not overlap: ' + JSON.stringify({ pencil: bobHover.bob.pencilRect, bar: bobHover.bob.barRect }));
  assert(bobHover.bob.barRect && bobHover.bob.cardRect && bobHover.bob.barRect.top >= bobHover.bob.cardRect.bottom, 'the add bar sits below the card, clear of the in-card pencil');
  const cardMid = (bobHover.bob.cardRect.left + bobHover.bob.cardRect.right) / 2;
  const barMid = (bobHover.bob.barRect.left + bobHover.bob.barRect.right) / 2;
  assert(Math.abs(cardMid - barMid) < 2, 'the hover add bar is centered horizontally beneath the card (cardMid=' + cardMid + ', barMid=' + barMid + ')');

  const barBox = bobHover.bob.barRect;
  await hoverPage.mouse.move(barBox.left + barBox.width / 2, barBox.top + barBox.height / 2);
  await new Promise(r => setTimeout(r, 80));
  const still = await hoverPage.evaluate(() => {
    const bar = document.querySelector('[data-person-card="b1"] .canvas-add-bar');
    const cs = bar ? getComputedStyle(bar) : null;
    return { opacity: cs && cs.opacity, pe: cs && cs.pointerEvents };
  });
  assert(Number(still.opacity) === 1 && still.pe !== 'none', 'moving from the card onto the add bar keeps the bar visible (no flicker gap)');

  // Re-hover the unselected card and capture the bar.
  await hoverPage.hover('[data-person-card="b1"]');
  await new Promise(r => setTimeout(r, 80));
  const clip = await hoverPage.evaluate(() => {
    const alice = document.querySelector('[data-person-card="a1"]').getBoundingClientRect();
    const bob = document.querySelector('[data-person-card="b1"]').getBoundingClientRect();
    const bar = document.querySelector('[data-person-card="b1"] .canvas-add-bar-inner').getBoundingClientRect();
    const left = Math.max(0, Math.min(alice.left, bob.left, bar.left) - 28);
    const top = Math.max(0, Math.min(alice.top, bob.top, bar.top) - 28);
    const right = Math.max(alice.right, bob.right, bar.right) + 28;
    const bottom = Math.max(alice.bottom, bob.bottom, bar.bottom) + 28;
    return {
      x: Math.floor(left),
      y: Math.floor(top),
      width: Math.ceil(right - left),
      height: Math.ceil(bottom - top)
    };
  });
  const shotHover = path.join(OUT, 'phase3d-hover.png');
  await hoverPage.screenshot({ path: shotHover, clip });
  keepScreenshot(shotHover, 'phase3d-hover.png');
  console.log('  wrote ' + shotHover);

  const clipFamily = await hoverPage.evaluate(() => {
    const ids = ['a1', 'b1', 'c1'];
    const rects = ids.map(id => document.querySelector('[data-person-card="' + id + '"]')).filter(Boolean).map(el => el.getBoundingClientRect());
    const bar = document.querySelector('[data-person-card="b1"] .canvas-add-bar-inner')?.getBoundingClientRect();
    const union = document.querySelector('[data-union-marker]')?.getBoundingClientRect();
    const all = [...rects, bar, union].filter(Boolean);
    const left = Math.max(0, Math.min(...all.map(r => r.left)) - 36);
    const top = Math.max(0, Math.min(...all.map(r => r.top)) - 36);
    const right = Math.max(...all.map(r => r.right)) + 36;
    const bottom = Math.max(...all.map(r => r.bottom)) + 36;
    return {
      x: Math.floor(left),
      y: Math.floor(top),
      width: Math.ceil(right - left),
      height: Math.ceil(bottom - top)
    };
  });
  const shotCards = path.join(OUT, 'phase3e-cards.png');
  await hoverPage.screenshot({ path: shotCards, clip: clipFamily });
  keepScreenshot(shotCards, 'phase3e-cards.png');
  console.log('  wrote ' + shotCards);

  await hoverPage.evaluate(() => {
    const paint = (fill, stroke) => {
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = fill;
      g.beginPath();
      g.arc(64, 64, 64, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = stroke;
      g.beginPath();
      g.arc(64, 54, 22, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.ellipse(64, 112, 32, 28, 0, Math.PI, 0, true);
      g.fill();
      return c.toDataURL('image/png');
    };
    const setPhoto = (id, dataUrl) => {
      const av = document.querySelector('[data-person-card="' + id + '"] .card-avatar');
      if (!av) return;
      av.innerHTML = '<img src="' + dataUrl + '" alt="" style="width:100%;height:100%;object-cover">';
    };
    setPhoto('a1', paint('#F8D4C8', '#C47B6A'));
    setPhoto('c1', paint('#D7E6F4', '#6A8BB0'));
  });
  await hoverPage.hover('[data-person-card="b1"]');
  await new Promise(r => setTimeout(r, 80));
  const clipPhotos = await hoverPage.evaluate(() => {
    const ids = ['a1', 'b1', 'c1'];
    const rects = ids.map(id => document.querySelector('[data-person-card="' + id + '"]')).filter(Boolean).map(el => el.getBoundingClientRect());
    const bar = document.querySelector('[data-person-card="b1"] .canvas-add-bar-inner')?.getBoundingClientRect();
    const union = document.querySelector('[data-union-marker]')?.getBoundingClientRect();
    const all = [...rects, bar, union].filter(Boolean);
    const left = Math.max(0, Math.min(...all.map(r => r.left)) - 36);
    const top = Math.max(0, Math.min(...all.map(r => r.top)) - 36);
    const right = Math.max(...all.map(r => r.right)) + 36;
    const bottom = Math.max(...all.map(r => r.bottom)) + 36;
    return {
      x: Math.floor(left),
      y: Math.floor(top),
      width: Math.ceil(right - left),
      height: Math.ceil(bottom - top)
    };
  });
  const shotPhotos = path.join(OUT, 'phase3f-cards.png');
  await hoverPage.screenshot({ path: shotPhotos, clip: clipPhotos });
  keepScreenshot(shotPhotos, 'phase3f-cards.png');
  console.log('  wrote ' + shotPhotos);
} else {
  console.log('  info  could not enable (hover: hover); skipped desktop unselected-hover checks and phase3d-hover.png');
}

await page.evaluate(() => {
  document.getElementById('btn-close-inspector')?.click();
  window.__TREE.closeQuickEditModal?.();
  document.getElementById('toast-banner')?.classList.add('hidden');
});
await page.hover('[data-person-card="a1"]');
const afterPencil = await page.evaluate(() => {
  document.querySelector('[data-canvas-quick-edit="a1"]').click();
  const modal = document.getElementById('modal-quick-edit');
  const drawer = document.getElementById('inspector-drawer');
  const ui = window.__TREE.getUi();
  return {
    qe: modal && !modal.classList.contains('hidden'),
    heading: document.getElementById('qe-name-heading')?.textContent,
    inspectorOpen: ui.inspectorOpen,
    drawerVisible: drawer && !drawer.classList.contains('translate-x-full'),
    selected: window.__TREE.getState().selectedPersonId
  };
});
assert(afterPencil.qe && /Alice/.test(afterPencil.heading || '') && afterPencil.selected === 'a1', 'the canvas pencil opens Quick Edit');
assert(!afterPencil.inspectorOpen && !afterPencil.drawerVisible, 'the canvas pencil does not open the Inspector side panel: ' + JSON.stringify(afterPencil));

const shotPencil = path.join(OUT, 'phase3c-pencil.png');
await page.screenshot({ path: shotPencil, fullPage: false });
keepScreenshot(shotPencil, 'phase3c-pencil.png');
console.log('  wrote ' + shotPencil);

const fromPanel = await page.evaluate(() => {
  window.__TREE.closeQuickEditModal();
  window.__TREE.openInspector('a1', 'profile');
  document.getElementById('toast-banner')?.classList.add('hidden');
  document.getElementById('btn-insp-circle-edit')?.click();
  const modal = document.getElementById('modal-quick-edit');
  const drawer = document.getElementById('inspector-drawer');
  const ui = window.__TREE.getUi();
  const detailed = document.getElementById('form-edit-person-profile');
  return {
    qe: modal && !modal.classList.contains('hidden'),
    heading: document.getElementById('qe-name-heading')?.textContent,
    inspectorOpen: ui.inspectorOpen,
    tab: ui.inspectorTab,
    drawerVisible: drawer && !drawer.classList.contains('translate-x-full'),
    detailed: !!detailed
  };
});
assert(fromPanel.qe && /Alice/.test(fromPanel.heading || ''), 'the side-panel Edit button opens Quick Edit');
assert(fromPanel.inspectorOpen && fromPanel.drawerVisible && fromPanel.tab === 'profile' && !fromPanel.detailed, 'side-panel Edit leaves the Inspector open on Profile and does not switch to the detailed form: ' + JSON.stringify(fromPanel));

await page.evaluate(() => {
  document.getElementById('toast-banner')?.classList.add('hidden');
  const modal = document.getElementById('modal-quick-edit');
  const panel = modal && modal.querySelector(':scope > div.relative, :scope > .relative');
  const drawer = document.getElementById('inspector-drawer');
  if (!panel || !drawer) return;
  const m = panel.getBoundingClientRect();
  const d = drawer.getBoundingClientRect();
  const overlap = Math.min(m.right, d.right) - Math.max(m.left, d.left);
  if (overlap > d.width * 0.45) panel.style.transform = 'translateX(-180px)';
});
await new Promise(r => setTimeout(r, 80));
const shotSide = path.join(OUT, 'phase3c-sideedit.png');
await page.screenshot({ path: shotSide, fullPage: false });
keepScreenshot(shotSide, 'phase3c-sideedit.png');
console.log('  wrote ' + shotSide);
await page.evaluate(() => {
  const modal = document.getElementById('modal-quick-edit');
  const panel = modal && modal.querySelector(':scope > div.relative, :scope > .relative');
  if (panel) panel.style.transform = '';
});

const more = await page.evaluate(() => {
  document.getElementById('btn-qe-more')?.click();
  const modal = document.getElementById('modal-quick-edit');
  const ui = window.__TREE.getUi();
  const form = document.getElementById('form-edit-person-profile');
  const heading = form ? (form.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return {
    qeClosed: !modal || modal.classList.contains('hidden'),
    tab: ui.inspectorTab,
    inspectorOpen: ui.inspectorOpen,
    hasForm: !!form,
    heading
  };
});
assert(more.qeClosed && more.tab === 'edit' && more.inspectorOpen && more.hasForm && /Edit Identity/.test(more.heading || ''), 'Quick Edit “Edit more” opens the detailed Inspector edit form: ' + JSON.stringify(more));

// Hovering an unselected card and pressing +Parent must add to that card, not the selected one.
if (desktopHover) {
  await hoverPage.evaluate((state) => {
    window.__TREE.closeQuickEditModal?.();
    document.getElementById('btn-close-inspector')?.click();
    window.__TREE.load(state);
    window.__TREE.setTestWrite?.(() => ({ ok: true }));
    window.__TREE.fitTreeToScreen?.();
  }, fixture());
  await new Promise(r => setTimeout(r, 200));
  await hoverPage.click('[data-person-card="a1"]');
  await hoverPage.evaluate(() => document.getElementById('btn-close-inspector')?.click());
  await hoverPage.hover('[data-person-card="b1"]');
  await new Promise(r => setTimeout(r, 80));
  await hoverPage.click('[data-person-card="b1"] [data-quick-rel="parent"]');
  const added = await hoverPage.evaluate(() => {
    const st = window.__TREE.getState();
    const newIds = Object.keys(st.persons).filter(id => !['a1', 'b1', 'c1'].includes(id));
    const famOf = (pid) => Object.values(st.families).find(f => (f.children || []).some(c => c.personId === pid));
    const bobFam = famOf('b1');
    const aliceFam = famOf('a1');
    const partners = (f) => f ? [f.partner1Id, f.partner2Id] : [];
    return {
      newIds,
      bobParents: partners(bobFam),
      aliceParents: partners(aliceFam),
      selected: st.selectedPersonId
    };
  });
  assert(added.newIds.some(id => added.bobParents.includes(id)), 'clicking +Parent on an unselected hovered card adds a parent to that card: ' + JSON.stringify(added));
  assert(!added.newIds.some(id => added.aliceParents.includes(id)), 'the +Parent action does not use the previously selected person: ' + JSON.stringify(added));
}

if (headedBrowser) {
  try { await headedBrowser.close(); } catch {}
  headedBrowser = null;
}

// Touch: pencil hidden until the card is selected, then a tap opens Quick Edit only.

const touchPage = await browser.newPage();
const touchErrs = [];
touchPage.on('pageerror', e => touchErrs.push(String(e)));
await touchPage.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const cdp = await touchPage.createCDPSession();
await cdp.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }]
});
await touchPage.goto(`http://127.0.0.1:${PORT}/index.html?test=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await touchPage.waitForFunction(() => window.__TREE, { timeout: 15000 });
const touchUi = await touchPage.evaluate((state) => {
  const T = window.__TREE;
  T.load(state);
  T.setTestWrite?.(() => ({ ok: true }));
  T.closeQuickEditModal?.();
  document.getElementById('btn-close-inspector')?.click();
  T.fitTreeToScreen?.();
  // Deselect by keeping Alice selected first to render, then inspect Bob (unselected) and Alice (will select).
  const bobCard = document.querySelector('[data-person-card="b1"]');
  const bobPencil = document.querySelector('[data-canvas-quick-edit="b1"]');
  const bobOpacity = bobPencil ? getComputedStyle(bobPencil).opacity : null;
  // Select Alice without going through the pencil.
  const alice = document.querySelector('[data-person-card="a1"]');
  alice && alice.click();
  document.getElementById('btn-close-inspector')?.click();
  T.closeQuickEditModal?.();
  const alicePencil = document.querySelector('[data-canvas-quick-edit="a1"]');
  const aliceOpacity = alicePencil ? getComputedStyle(alicePencil).opacity : null;
  const aliceBar = alice && alice.querySelector('.canvas-add-bar');
  const bobBar = bobCard && bobCard.querySelector('.canvas-add-bar');
  const aliceBarOp = aliceBar ? getComputedStyle(aliceBar).opacity : null;
  const bobBarOp = bobBar ? getComputedStyle(bobBar).opacity : null;
  const bar = alice && [...alice.querySelectorAll('button')].some(b => /^\+Parent$/.test((b.textContent || '').trim()));
  return {
    bobOpacity,
    aliceOpacity,
    bar,
    aliceBarOp,
    bobBarOp,
    selected: T.getState().selectedPersonId
  };
}, fixture());
assert(touchUi.selected === 'a1' && Number(touchUi.aliceOpacity) === 1 && touchUi.bar && Number(touchUi.aliceBarOp) === 1, 'on touch, the pencil and add bar show when the card is selected (opacity=' + touchUi.aliceOpacity + ', bar=' + touchUi.aliceBarOp + ')');
assert(touchUi.bobOpacity == null || Number(touchUi.bobOpacity) === 0, 'on touch, the pencil stays hidden on an unselected card (opacity=' + touchUi.bobOpacity + ')');
assert(touchUi.bobBarOp == null || Number(touchUi.bobBarOp) === 0, 'on touch, the add bar stays hidden on an unselected card (opacity=' + touchUi.bobBarOp + ')');

const pencilHandle = await touchPage.$('[data-canvas-quick-edit="a1"]');
const box = await pencilHandle.boundingBox();
if (touchPage.touchscreen && box) {
  await touchPage.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
} else {
  await pencilHandle.click();
}
const touched = await touchPage.evaluate(() => {
  const modal = document.getElementById('modal-quick-edit');
  const ui = window.__TREE.getUi();
  return {
    qe: modal && !modal.classList.contains('hidden'),
    inspectorOpen: ui.inspectorOpen,
    tab: ui.inspectorTab
  };
});
assert(touched.qe && !touched.inspectorOpen, 'a touch/tap on the canvas pencil opens Quick Edit only, not the Inspector: ' + JSON.stringify(touched));
assert(touchErrs.length === 0, 'no touch-page errors (' + touchErrs.join(' | ') + ')');
await touchPage.close();

assert(errs.length === 0, 'no page errors (' + errs.join(' | ') + ')');
await browser.close();
server.close();
if (failed.length) {
  console.log('FAILED ' + failed.length);
  process.exit(1);
}
console.log('All phase-3 declutter checks passed');
