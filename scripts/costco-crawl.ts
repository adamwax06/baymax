#!/usr/bin/env bun
// Crawl costco.com grocery category listings into data/costco-catalog.json
// (name, size-in-name, price, item number, URL). Same trick as tj.ts: Akamai
// walls scripted clients, so each worker drives its own tab in the user's
// real Chrome via AppleScript. Listings carry no macros; get those from
// FDC/Open Food Facts or a label photo when an item goes on a list.
//
// usage: bun scripts/costco-crawl.ts [workers=6] [--sameday]
// costco.com lists only part of the warehouse (little fresh produce/meat), so
// --sameday pulls Costco Same-Day (Instacart, logged in) food departments instead
// into data/costco-sameday.json. Same-Day prices run above warehouse prices.

import { join } from "node:path";

if (process.argv.includes("--sameday")) process.env.COSTCO_SAMEDAY = "1";
const SAMEDAY = !!process.env.COSTCO_SAMEDAY;
const SAMEDAY_DEPTS = ["n-produce-50673", "n-meat-seafood-74327", "n-dairy-eggs-74913", "n-deli-37813",
  "n-frozen-foods-94815", "n-bakery-desserts-23722", "n-pantry-dry-goods-99939", "n-snacks-candy-nuts-80879", "n-beverages-1068"];
const CATS = process.env.COSTCO_CATS ? process.env.COSTCO_CATS.split(",") : ["all-costco-grocery", "snacks", "meat", "beverages", "candy", "deli", "coffee-sweeteners",
  "prepared-food", "breakfast", "breakfast-cereal", "pantry", "cakes-cookies", "dairy-eggs-cheese",
  "cold-frozen-grocery", "organic-groceries", "kirkland-signature-groceries"];
const WORKERS = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 6);
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
  const err = p.stderr.toString().trim();
  if (err) console.error(`w${worker} osascript: ${err.slice(0, 300)}`);
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
// Same-Day: Instacart's own persisted GraphQL queries (CollectionProducts -> item ids,
// Items -> details), fetched inside one logged-in tab. Hidden tabs don't lazy-load on
// scroll, so the API beats a tab fleet here. Hashes change when Instacart redeploys:
// re-capture them from performance.getEntriesByType('resource') on a collection page.
const SAMEDAY_JS = String.raw`window.__sd=null;(async()=>{try{
const q=async(op,h,v)=>(await fetch('/graphql?operationName='+op+'&variables='+encodeURIComponent(JSON.stringify(v))+'&extensions='+encodeURIComponent(JSON.stringify({persistedQuery:{version:1,sha256Hash:h}})))).json();
const C="ec43ca38c70d22a76438a525e7c5a531ad7c2630860673bc15505abbd1bd28c6",I="8fe60a2c4c74b994076e8fc97883141aec582e7f6e2402d82c9902772432f183";
const loc={shopId:"12",zoneId:"1",postalCode:"94103"},out={};
for(const slug of DEPTS){const j=await q("CollectionProducts",C,{...loc,slug,filters:[],first:2000,showDebugInfo:false,ignoreAvailability:false});
  const ids=j.data?.collectionProducts?.itemIds||[];
  for(let i=0;i<ids.length;i+=50){const r=await q("Items",I,{...loc,ids:ids.slice(i,i+50)});
    for(const it of r.data?.items||[]){const c=it.price?.viewSection?.itemCard||{};const o=out[it.productId]||(out[it.productId]={id:it.productId,name:it.name,brand:it.brandName,
      url:'https://sameday.costco.com/store/costco/products/'+it.evergreenUrl,price:Number((c.priceString||'').replace(/[^\d.]/g,''))||null,
      priceString:c.priceString||null,unitPrice:c.pricingUnitString||null,packageSize:c.pricingUnitSecondaryString||null,
      available:it.availability?.available??null,stockLevel:it.availability?.stockLevel||null,tags:it.tags||[],departments:[]});o.departments.push(slug)}}}
window.__sd=JSON.stringify(Object.values(out));}catch(e){window.__sd='ERR '+e}})();'ok'`;

if (SAMEDAY) {
  const js = `/tmp/costco-sameday-${process.pid}.js`;
  require("node:fs").writeFileSync(js, SAMEDAY_JS.replace("DEPTS", JSON.stringify(SAMEDAY_DEPTS)));
  const as = `
set js to read POSIX file "${js}" as «class utf8»
tell application "Google Chrome"
  set t to make new tab at end of tabs of window 1 with properties {URL:"https://sameday.costco.com/store/costco/storefront"}
  delay 8
  execute t javascript js
  repeat 600 times
    set r to execute t javascript "window.__sd === null ? '' : window.__sd"
    if r is not "" then
      close t
      return r
    end if
    delay 1
  end repeat
  close t
  return "ERR timed out"
end tell`;
  const p = Bun.spawnSync(["osascript", "-"], { stdin: Buffer.from(as) });
  const raw = p.stdout.toString().trim();
  if (!raw.startsWith("[")) throw new Error(`Same-Day crawl failed: ${raw || p.stderr.toString()}`);
  const items = JSON.parse(raw).sort((a: any, b: any) => a.name.localeCompare(b.name));
  await Bun.write(join(import.meta.dir, "../data/costco-sameday.json"), JSON.stringify({ crawledAt: new Date().toISOString(), items }, null, 2) + "\n");
  console.log(`wrote ${items.length} items to data/costco-sameday.json`);
  process.exit(0);
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
  const file = "costco-catalog.json";
  await Bun.write(join(import.meta.dir, "../data", file), JSON.stringify({ crawledAt: new Date().toISOString(), items: out }, null, 2) + "\n");
  console.log(`wrote ${out.length} items to data/${file}`);
}
