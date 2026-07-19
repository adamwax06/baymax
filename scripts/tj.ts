#!/usr/bin/env bun
// Search Trader Joe's products + prices at a specific store.
//
// TJ's GraphQL API is Akamai-walled (403s curl/Bun/headless Chrome), so this
// runs the fetch inside the user's real Chrome via AppleScript. One-time
// setup in Chrome: View > Developer > Allow JavaScript from Apple Events.
//
// usage: bun run tj <search terms>     (TJ_STORE=<code> to override store)

const STORE = process.env.TJ_STORE ?? "226"; // San Francisco (Hayes Valley), 788 Laguna St
const search = process.argv.slice(2).join(" ").trim();
if (!search) {
  console.error("usage: bun run tj <search terms>");
  process.exit(1);
}

const query = `query SearchProducts($search: String, $currentPage: Int, $pageSize: Int, $storeCode: String, $availability: String = "1", $published: String = "1") {
  products(search: $search, filter: {store_code: {eq: $storeCode}, published: {eq: $published}, availability: {match: $availability}} currentPage: $currentPage pageSize: $pageSize) {
    items { sku item_title sales_size sales_uom_description retail_price category_hierarchy { name } }
    total_count
  }
}`;

const body = JSON.stringify({
  operationName: "SearchProducts",
  variables: { storeCode: STORE, availability: "1", published: "1", search, currentPage: 1, pageSize: 15 },
  query,
});

// window.__tj: null = in flight, string = response. Set synchronously so the
// poll below can't read a stale value from a previous run.
const js = `window.__tj = null;
(async () => {
  try {
    const r = await fetch("/api/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(body)} });
    window.__tj = await r.text();
  } catch (e) {
    window.__tj = JSON.stringify({ errors: [{ message: String(e) }] });
  }
})(); "ok"`;

const jsPath = `/tmp/tj-query-${process.pid}.js`;
await Bun.write(jsPath, js);

const appleScript = `
set js to read POSIX file "${jsPath}" as «class utf8»
tell application "Google Chrome"
  if (count of windows) = 0 then make new window
  set tj to missing value
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t contains "traderjoes.com" then
        set tj to t
        exit repeat
      end if
    end repeat
    if tj is not missing value then exit repeat
  end repeat
  if tj is missing value then
    set tj to make new tab at end of tabs of window 1 with properties {URL:"https://www.traderjoes.com/home"}
    delay 6 -- first load sets Akamai cookies
  end if
  execute tj javascript js
  repeat 40 times
    set out to execute tj javascript "window.__tj === null ? '' : window.__tj"
    if out is not "" then return out
    delay 0.5
  end repeat
  return "{\\"errors\\":[{\\"message\\":\\"timed out waiting for response in Chrome\\"}]}"
end tell`;

const proc = Bun.spawnSync(["osascript", "-"], { stdin: Buffer.from(appleScript) });
await Bun.file(jsPath).delete();
const raw = proc.stdout.toString().trim();
if (proc.exitCode !== 0 || !raw) {
  const err = proc.stderr.toString();
  if (err.includes("Allow JavaScript"))
    console.error("Chrome blocked scripting. Enable: View > Developer > Allow JavaScript from Apple Events");
  else console.error(err || "osascript failed with no output");
  process.exit(1);
}

const data = JSON.parse(raw);
if (data.errors) {
  console.error("TJ API error:", data.errors.map((e: { message: string }) => e.message).join("; "));
  process.exit(1);
}

const { items, total_count } = data.data.products;
if (!items.length) {
  console.log(`no matches for "${search}" at store ${STORE}`);
  process.exit(0);
}
for (const it of items) {
  const size = it.sales_size ? `${it.sales_size} ${it.sales_uom_description ?? ""}`.trim() : "";
  const cat = it.category_hierarchy?.at(-1)?.name ?? "";
  console.log(`$${it.retail_price}\t${it.item_title}\t${size}\t${cat}\t#${it.sku}`);
}
if (total_count > items.length) console.log(`… ${total_count - items.length} more (showing ${items.length})`);
