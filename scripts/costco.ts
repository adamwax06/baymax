#!/usr/bin/env bun
// Costco Same-Day (Instacart) cart, driven from the meal plan. Runs Instacart's
// own persisted GraphQL inside Adam's logged-in Chrome (same bridge as
// costco-crawl.ts). Hashes come from the site's operation-hashes chunk at run
// time, so redeploys don't break it. Foods map to SKUs via foods.json `costco`.
//
// usage: bun run costco show                       # what's in the cart
//        bun run costco cart [--from d] [--dry-run]  # add `plan groceries` (Buy list) to the cart, idempotent
//        bun run costco add <food> <packs>           # one SKU by hand (only raises)
//        bun run costco set <food> <packs>           # exact quantity, 0 removes
//        bun run costco checkout --max 150 [--dry-run]  # click through checkout; places only if total ≤ cap

import { type Food, compute, load, today, totals } from "./kitchen";
import { groceries, type PlanDay } from "./plan";
import { join } from "node:path";

type CostcoSku = { id: string; g: number; name: string };
type CartItem = { productId: string; quantity: number };

const STORE = "https://sameday.costco.com/store/costco/storefront";
const PRELUDE = String.raw`
const H={};{const c=performance.getEntriesByType('resource').map(e=>e.name).find(n=>n.includes('operation-hashes'));
  const t=await (await fetch(c)).text();for(const m of t.matchAll(/"([A-Za-z0-9_]+)":"([0-9a-f]{64})"/g))H[m[1]]=m[2];}
const ext=op=>({persistedQuery:{version:1,sha256Hash:H[op]}});
const q=async(op,v)=>(await fetch('/graphql?operationName='+op+'&variables='+encodeURIComponent(JSON.stringify(v))+'&extensions='+encodeURIComponent(JSON.stringify(ext(op))))).json();
const m=async(op,v)=>(await fetch('/graphql?operationName='+op,{method:'POST',headers:{'content-type':'application/json'},credentials:'include',body:JSON.stringify({operationName:op,variables:v,extensions:ext(op)})})).json();
// No active cart (e.g. right after an order) is normal: reads return [], and the mutation creates one.
const cartId=((await q('CartSwitcherSingleRetailerCartIds',{})).data?.userCarts?.carts??[]).find(c=>c.retailerId==='5')?.id;
const items=async()=>cartId?((await q('CartData',{id:cartId})).data?.userCart?.cartItemCollection?.cartItems??[]).map(i=>({productId:i.basketProduct.productId,quantity:i.quantity})):[];`;

/** Run an async JS body in a Same-Day tab; the body's return value comes back as JSON. */
export function inChrome<T>(body: string): T {
  const file = `/tmp/baymax-costco-${process.pid}.js`;
  require("node:fs").writeFileSync(file, `window.__bx=null;(async()=>{try{${PRELUDE}\n${body}}catch(e){return {error:String(e)}}})().then(r=>window.__bx=JSON.stringify(r));'ok'`);
  const as = `
set js to read POSIX file "${file}" as «class utf8»
tell application "Google Chrome"
  set t to missing value
  repeat with x in tabs of window 1
    if URL of x starts with "https://sameday.costco.com" then set t to x
  end repeat
  if t is missing value then
    set t to make new tab at end of tabs of window 1 with properties {URL:"${STORE}"}
    delay 8
  end if
  execute t javascript js
  repeat 120 times
    set r to execute t javascript "window.__bx === null ? '' : window.__bx"
    if r is not "" then return r
    delay 1
  end repeat
  return "{\\"error\\":\\"timed out\\"}"
end tell`;
  const p = Bun.spawnSync(["osascript", "-"], { stdin: Buffer.from(as) });
  const out = JSON.parse(p.stdout.toString().trim() || `{"error":${JSON.stringify(p.stderr.toString())}}`);
  if (out?.error) throw new Error(`Same-Day: ${out.error} (logged in to sameday.costco.com in Chrome?)`);
  return out;
}

export const readCart = () => inChrome<CartItem[]>("return await items();");

/** Set absolute quantities. By default never lowers what's in the cart; `exact` sets it as given (0 removes). */
export function setCart(want: CartItem[], exact = false) {
  const updates = JSON.stringify(want.map((w) => ({ itemId: `items_74-${w.productId}`, quantity: w.quantity, quantityType: "each", trackingParams: {} })));
  return inChrome<CartItem[]>(`
const have=Object.fromEntries((await items()).map(i=>[i.productId,i.quantity]));
const cartItemUpdates=${updates}.filter(u=>${exact}?(have[u.itemId.slice(9)]??0)!==u.quantity:(have[u.itemId.slice(9)]??0)<u.quantity);
if(cartItemUpdates.length){const r=await m('UpdateCartItemsMutation',{cartItemUpdates,cartType:'grocery',requestTimestamp:Date.now(),cartId});
  if(r.data?.updateCartItems?.__typename!=='CartsCartItemUpdateSuccessResponse')return {error:JSON.stringify(r).slice(0,500)};}
return await items();`);
}

/** Run one sync JS expression in the Same-Day tab (optionally navigating first) and return its string result. */
function step(js: string, url = "", wait = 0): string {
  const file = `/tmp/baymax-costco-step-${process.pid}.js`;
  require("node:fs").writeFileSync(file, js);
  const as = `
set js to read POSIX file "${file}" as «class utf8»
tell application "Google Chrome"
  set t to missing value
  repeat with x in tabs of window 1
    if URL of x starts with "https://sameday.costco.com" then set t to x
  end repeat
  if t is missing value then set t to make new tab at end of tabs of window 1 with properties {URL:"${STORE}"}
  if "${url}" is not "" then set URL of t to "${url}"
  delay ${wait}
  return execute t javascript js
end tell`;
  return Bun.spawnSync(["osascript", "-"], { stdin: Buffer.from(as) }).stdout.toString().trim();
}
const click = (re: string) =>
  `(()=>{const b=[...document.querySelectorAll('button,a')].find(b=>${re}.test(((b.getAttribute('aria-label')||'')+' '+(b.innerText||'')).trim()));if(!b)return 'missing';b.click();return 'ok'})()`;

/**
 * Click through checkout exactly like a person: cart drawer → Go to checkout → past the upsell
 * aisle → read the total → Place order only if total ≤ maxTotal. Uses the saved address,
 * payment and tip; delivery is whatever Instacart preselects (Standard).
 */
export function checkout(maxTotal: number, dry = false) {
  const sleep = (s: number) => Bun.sleepSync(s * 1000);
  if (step(click("/^View Cart/i"), STORE, 9) !== "ok") throw new Error("no cart button (empty cart, or logged out?)");
  sleep(4);
  if (step(click("/go to checkout/i")) !== "ok") throw new Error("no Go to checkout button");
  sleep(10);
  if (step("location.href").includes("checkout_aisle")) {
    step(click("/^continue to checkout/i"));
    sleep(12);
  }
  const page = step("document.body.innerText");
  const total = Number(/your price \$([\d.,]+)/.exec(page)?.[1]?.replace(",", "") ?? /Total\s*\$([\d.,]+)/.exec(page)?.[1]?.replace(",", ""));
  const window = /Standard\s*([^\n]+)/.exec(page)?.[1] ?? "?";
  if (!total) throw new Error("couldn't read the checkout total; not placing");
  if (total > maxTotal) throw new Error(`total $${total} is over the $${maxTotal} cap; not placing (checkout page left open)`);
  if (dry) return { placed: false, total, window };
  const placed = step(`(()=>{if(!document.body.innerText.includes('$${total.toFixed(2)}'))return 'changed';const b=[...document.querySelectorAll('button')].find(b=>(b.innerText||'').trim()==='Place order');if(!b)return 'missing';b.click();return 'ok'})()`);
  if (placed !== "ok") throw new Error(`not placed (${placed})`);
  sleep(15);
  const url = step("location.href");
  if (!url.includes("/orders/")) throw new Error(`clicked Place order but no confirmation page (${url})`);
  return { placed: true, total, window, order: /orders\/(\d+)/.exec(url)?.[1] };
}

if (import.meta.main) {
  const [cmd, ...rest] = Bun.argv.slice(2);
  const flag = (f: string) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest.splice(i, 2)[1] : undefined;
  };
  const dry = rest.includes("--dry-run");
  const { dir, foods, events, nutrition } = await load();
  const catalog = new Map<string, any>(((await Bun.file(join(dir, "costco-sameday.json")).json()).items as any[]).map((i) => [i.id, i]));
  const bySku = new Map([...foods.values()].filter((f) => (f as any).costco).map((f) => [(f as any).costco.id as string, f]));
  const price = (id: string) => catalog.get(id)?.price ?? null;
  const print = (cart: CartItem[]) => {
    let total = 0;
    for (const c of cart) {
      const p = price(c.productId);
      total += (p ?? 0) * c.quantity;
      console.log(`  ${c.quantity} × ${catalog.get(c.productId)?.name ?? c.productId}  ${p ? `$${(p * c.quantity).toFixed(2)}` : "price ?"}${bySku.has(c.productId) ? "" : "  (not a mapped food)"}`);
    }
    console.log(`  ≈ $${total.toFixed(2)} before fees/tip (catalog prices)`);
  };

  if (!cmd || cmd === "show") {
    print(readCart());
  } else if (cmd === "cart" || cmd === "add" || cmd === "set") {
    let want: CartItem[] = [];
    if (cmd !== "cart") {
      const f = foods.get(rest[0]!) as (Food & { costco?: CostcoSku }) | undefined;
      if (!f?.costco) throw new Error(`${rest[0]} has no Costco SKU in foods.json (add a costco: {id, g, name})`);
      want = [{ productId: f.costco.id, quantity: Number(rest[1] ?? 1) }];
    } else {
      const plan: { days: PlanDay[] } = await Bun.file(join(dir, "mealplan.json")).json();
      const { lots } = compute(events, nutrition, foods);
      const rows = groceries(plan.days.filter((d) => d.date >= (flag("--from") ?? today())), foods, totals(lots), new Set(events.map((e) => e.food!).filter(Boolean)));
      for (const r of rows) {
        const sku = (foods.get(r.id) as Food & { costco?: CostcoSku }).costco;
        if (!r.tracked) console.log(`skip ${r.name}: never counted (check the kitchen first)`);
        else if (!sku) console.log(`skip ${r.name}: no Costco SKU (TJ's, or map it in foods.json)`);
        else want.push({ productId: sku.id, quantity: Math.ceil(r.buy / sku.g) });
      }
    }
    if (dry) print(want);
    else print(setCart(want, cmd === "set"));
  } else if (cmd === "checkout") {
    const max = Number(flag("--max") ?? NaN);
    if (!(max > 0)) throw new Error("checkout needs --max <dollars> (the spend cap)");
    console.log(JSON.stringify(checkout(max, dry)));
  } else {
    console.error(`unknown command "${cmd}" (see the header of scripts/costco.ts)`);
    process.exit(1);
  }
}
