#!/usr/bin/env node
// Headless screenshot / interaction driver for SONDER (Playwright + Chromium, software GL).
//
//   node tools/shot.cjs --url "http://localhost:8080/?scale=galaxy&quality=high" --out shots/galaxy.png
//
// Options:
//   --url <url>        page to open (dynres=0 is appended automatically)
//   --out <file.png>   final screenshot (optional when --steps contains shot: commands)
//   --w 1280 --h 720   viewport;  --dpr 1  device pixel ratio
//   --mobile           emulate a touch phone in landscape (844x390 @3x unless --w/--h given)
//   --portrait         with --mobile: portrait orientation
//   --wait 3000        ms to wait after the app reports ready (default 2500)
//   --timeout 180000   ms to wait for readiness
//   --steps "<cmd>;<cmd>;..."   scripted interaction, executed in order after --wait:
//        wait:<ms>                 sleep
//        frames:<n>                wait until n more frames have rendered
//        step:<frames>:<dt>        fast-forward the simulation without rendering (engine.step)
//        shot:<file.png>           take a screenshot now
//        eval:<js>                 run JS in the page (has window.SONDER); result is printed
//        key:<Code>:<ms>           hold a key (e.g. key:KeyW:1500)
//        press:<Code>              tap a key
//        tap:<fx>,<fy>             click / tap at fractional viewport coords (0..1)
//        move:<fx>,<fy>            move the mouse (hover)
//        drag:<fx1>,<fy1>,<fx2>,<fy2>:<ms>   press-drag-release
//        wheel:<deltaY>            mouse wheel
//   (use "::" inside eval code instead of ":" is NOT needed — everything after "eval:" is the code;
//    just avoid ";" in eval code, or pass multiple eval steps)
// Prints: console errors, page errors, SONDER.errors, fps and draw-call stats.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const key = k.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) a[key] = true; else { a[key] = next; i++; }
  }
  return a;
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.url) { console.error('usage: node tools/shot.cjs --url <url> --out <file.png> [--steps "..."]'); process.exit(2); }
  const mobile = !!args.mobile;
  let w = parseInt(args.w || (mobile ? (args.portrait ? 390 : 844) : 1280), 10);
  let h = parseInt(args.h || (mobile ? (args.portrait ? 844 : 390) : 720), 10);
  const dpr = parseFloat(args.dpr || (mobile ? 2 : 1));
  let url = args.url;
  if (!/[?&]dynres=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'dynres=0';

  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  const context = await browser.newContext({
    viewport: { width: w, height: h }, deviceScaleFactor: dpr,
    hasTouch: mobile, isMobile: mobile,
    userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' : undefined,
  });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[console.${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText || ''}`));
  page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`); });

  const shot = async (file) => {
    const out = path.resolve(file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out, type: out.endsWith('.jpg') ? 'jpeg' : 'png' });
    console.log(`shot -> ${out}`);
  };
  const waitFrames = async (n) => {
    await page.evaluate((n) => new Promise((res) => {
      const start = window.SONDER.engine.frame; const t0 = performance.now();
      const tick = () => { if (window.SONDER.engine.frame - start >= n || performance.now() - t0 > 120000) res(); else setTimeout(tick, 50); };
      tick();
    }), n);
  };

  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  const timeout = parseInt(args.timeout || '180000', 10);
  try {
    await page.waitForFunction(() => window.SONDER && window.SONDER.engine, null, { timeout: 30000 });
    await page.evaluate((timeout) => Promise.race([window.SONDER.ready, new Promise((r) => setTimeout(r, timeout))]), timeout);
  } catch (e) { logs.push(`[shot] app did not become ready: ${e.message}`); }
  console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await page.waitForTimeout(parseInt(args.wait || '2500', 10));

  if (args.steps) {
    for (const raw of String(args.steps).split(';')) {
      const s = raw.trim(); if (!s) continue;
      const i = s.indexOf(':'); const cmd = i < 0 ? s : s.slice(0, i); const rest = i < 0 ? '' : s.slice(i + 1);
      try {
        if (cmd === 'wait') await page.waitForTimeout(parseInt(rest, 10));
        else if (cmd === 'frames') await waitFrames(parseInt(rest, 10));
        else if (cmd === 'step') { const [f, dt] = rest.split(':'); await page.evaluate(([f, dt]) => window.SONDER.step(f, dt), [parseInt(f, 10), parseFloat(dt || '0.0333')]); }
        else if (cmd === 'shot') await shot(rest);
        else if (cmd === 'eval') { const r = await page.evaluate(`(async()=>{ return (${rest}); })()`); console.log(`eval -> ${JSON.stringify(r)}`); }
        else if (cmd === 'key') { const [code, ms] = rest.split(':'); await page.keyboard.down(code); await page.waitForTimeout(parseInt(ms || '300', 10)); await page.keyboard.up(code); }
        else if (cmd === 'press') await page.keyboard.press(rest);
        else if (cmd === 'tap') { const [fx, fy] = rest.split(',').map(Number); if (mobile) await page.touchscreen.tap(fx * w, fy * h); else await page.mouse.click(fx * w, fy * h); }
        else if (cmd === 'move') { const [fx, fy] = rest.split(',').map(Number); await page.mouse.move(fx * w, fy * h, { steps: 4 }); }
        else if (cmd === 'drag') {
          const [coords, ms] = rest.split(':'); const [x1, y1, x2, y2] = coords.split(',').map(Number);
          await page.mouse.move(x1 * w, y1 * h); await page.mouse.down();
          const n = 12; for (let k = 1; k <= n; k++) { await page.mouse.move((x1 + (x2 - x1) * k / n) * w, (y1 + (y2 - y1) * k / n) * h); await page.waitForTimeout(parseInt(ms || '400', 10) / n); }
          await page.mouse.up();
        }
        else if (cmd === 'wheel') await page.mouse.wheel(0, parseFloat(rest));
        else console.log(`[shot] unknown step "${cmd}"`);
      } catch (e) { logs.push(`[step ${s.slice(0, 60)}] ${e.message}`); }
    }
  }
  if (args.out) await shot(args.out);

  try {
    const info = await page.evaluate(() => {
      const S = window.SONDER; if (!S) return null;
      const r = S.engine.renderer.info;
      return { scale: S.engine.scales.currentName, fps: +S.engine.fps.toFixed(1), frame: S.engine.frame, calls: r.render.calls, triangles: r.render.triangles, points: r.render.points, geometries: r.memory.geometries, textures: r.memory.textures, errors: S.errors };
    });
    console.log('info', JSON.stringify(info));
  } catch (e) { logs.push(`[shot] info failed: ${e.message}`); }
  const uniq = [...new Set(logs)];
  if (uniq.length) console.log(uniq.slice(0, 40).join('\n'));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
