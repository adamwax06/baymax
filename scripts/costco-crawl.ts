#!/usr/bin/env bun
// Crawl costco.com grocery category listings into data/costco-catalog.json
// (name, size-in-name, price, item number, URL). Same trick as tj.ts: Akamai
// walls scripted clients, so each worker drives its own tab in the user's
// real Chrome via AppleScript. Listings carry no macros; get those from
// FDC/Open Food Facts or a label photo when an item goes on a list.
//
// usage: bun scripts/costco-crawl.ts [workers=6]
// ponytail: costco.com lists only part of the warehouse (little fresh produce/meat).

import { join } from "node:path";

const CATS = process.env.COSTCO_CATS ? process.env.COSTCO_CATS.split(",") : ["all-costco-grocery", "snacks", "meat", "beverages", "candy", "deli", "coffee-sweeteners",
  "prepared-food", "breakfast", "breakfast-cereal", "pantry", "cakes-cookies", "dairy-eggs-cheese",
  "cold-frozen-grocery", "organic-groceries", "kirkland-signature-groceries"];
const WORKERS = Number(process.argv[2] ?? 6);
const MAX_PAGES = 60;

const extract = `JSON.stringify((()=>{const out={};for(const a of document.querySelectorAll('a[href*=".product."]')){
  const id=(a.href.match(/product\\.(\\d+)/)||[])[1];if(!id)continue;const o=out[id]||(out[id]={id,url:a.href.split('?')[0]});
  const t=a.innerText.trim();if(t&&t!=='See Details'&&!o.name)o.name=t;
  let p=a;for(let i=0;i<8&&p;i++){p=p.parentElement;if(p&&/\\$\\s*[\\d,]+\\.\\d\\d/.test(p.innerText)){
    if(new Set([...p.querySelectorAll('a[href*=".product."]')].map(x=>(x.href.match(/product\\.(\\d+)/)||[])[1])).size>1)break;
    o.price=Number(p.innerText.match(/\\$\\s*([\\d,]+\\.\\d\\d)/)[1].replace(/,/g,''));o.tile=p.innerText.replace(/\\s+/g,' ').slice(0,240);break}}}
  return Object.values(out).filter(o=>o.name)})())`;

function page(worker: number, url: string): any[] {
  const js = `/tmp/costco-${process.pid}-${worker}.js`;
  require("node:fs").writeFileSync(js, extract);
  const as = `
set js to read POSIX file "${js}" as «class utf8»
tell application "Google Chrome"
  set t to missing value
  repeat with x in tabs of window 1
    if URL of x contains "#cw${worker}" then set t to x
  end repeat
  if t is missing value then set t to make new tab at end of tabs of window 1
  set URL of t to "${url}#cw${worker}"
  delay 7
  repeat 10 times
    set r to execute t javascript js
    if r is not "[]" then return r
    delay 1
  end repeat
  return r
end tell`;
  const p = Bun.spawnSync(["osascript", "-"], { stdin: Buffer.from(as) });
  try { return JSON.parse(p.stdout.toString().trim() || "[]"); } catch { return []; }
}

const all = new Map<string, any>();
const queue = [...CATS];
async function worker(w: number) {
  for (let cat; (cat = queue.shift()); ) {
    const seenHere = new Set<string>();
    for (let n = 1; n <= MAX_PAGES; n++) {
      const items = page(w, `https://www.costco.com/${cat}.html?currentPage=${n}`);
      const fresh = items.filter((i) => !seenHere.has(i.id));
      for (const i of items) {
        seenHere.add(i.id);
        const prev = all.get(i.id);
        all.set(i.id, { ...prev, ...i, categories: [...new Set([...(prev?.categories ?? []), cat])] });
      }
      console.log(`w${w} ${cat} p${n}: ${items.length} (${fresh.length} new here, ${all.size} total)`);
      if (fresh.length === 0 || items.length < 20) break;
    }
  }
}
// Bun.spawnSync blocks, so workers run as separate processes when asked to.
if (process.env.COSTCO_WORKER) {
  const w = Number(process.env.COSTCO_WORKER);
  queue.splice(0, queue.length, ...CATS.filter((_, i) => i % WORKERS === w));
  await worker(w);
  await Bun.write(`/tmp/costco-part-${w}.json`, JSON.stringify([...all.values()]));
} else {
  const procs = Array.from({ length: WORKERS }, (_, w) =>
    Bun.spawn(["bun", import.meta.path, String(WORKERS)], { env: { ...process.env, COSTCO_WORKER: String(w) }, stdout: "inherit", stderr: "inherit" }));
  await Promise.all(procs.map((p) => p.exited));
  const merged = new Map<string, any>();
  for (let w = 0; w < WORKERS; w++) {
    const f = Bun.file(`/tmp/costco-part-${w}.json`);
    if (!(await f.exists())) continue;
    for (const i of await f.json()) {
      const prev = merged.get(i.id);
      merged.set(i.id, { ...prev, ...i, categories: [...new Set([...(prev?.categories ?? []), ...i.categories])] });
    }
  }
  const out = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
    .map((i) => ({ ...i, warehouse: /Warehouse/.test(i.tile ?? ""), inStockSF: /In Stock at San Francisco/.test(i.tile ?? "") }));
  await Bun.write(join(import.meta.dir, "../data/costco-catalog.json"), JSON.stringify({ crawledAt: new Date().toISOString(), items: out }, null, 2) + "\n");
  console.log(`wrote ${out.length} items to data/costco-catalog.json`);
}
