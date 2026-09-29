import express from "express";
import { PublicKey } from "@solana/web3.js";
import fs from "fs";
import fetch from "node-fetch";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const archiver = require("archiver");

// Try to import serum parser if available
let SERUM_OPEN_ORDERS_LAYOUT = null;
try {
  // @project-serum/serum exports layouts in different ways across versions.
  const serum = require('@project-serum/serum');
  SERUM_OPEN_ORDERS_LAYOUT = serum.OpenOrders || serum.OPEN_ORDERS_LAYOUT || serum.OpenOrdersLayout || null;
} catch (e) { /* ignore if not available */ }

const app = express();
const port = 5000;
app.use(express.json());

const generatedResultFiles = new Set();

// ------------------------------------------------------------
// Helius RPCs provided by user (use ALL, we'll distribute wallets among them)
// ------------------------------------------------------------
const HELIUS_URLS = [
  "https://mainnet.helius-rpc.com/?api-key=24e04e6f-f4ad-4b22-883a-420b194b9a34",
  "https://mainnet.helius-rpc.com/?api-key=0d09d506-b6dc-48ba-859d-f58b476c92fe",
  "https://mainnet.helius-rpc.com/?api-key=8311058a-64a1-4e84-bbf5-9f2df5a51d4b",
  "https://mainnet.helius-rpc.com/?api-key=05559c40-dfa8-4f30-bb4e-f71015eb3aea",
  "https://mainnet.helius-rpc.com/?api-key=2bdf9316-853f-4eb7-a163-8b3649f82612",
  "https://mainnet.helius-rpc.com/?api-key=3c271c97-7af0-4f1f-834e-9f667002c6ce",
  "https://mainnet.helius-rpc.com/?api-key=a6c9c179-c4ca-45f2-a5c1-de19c1e64f1e",
  "https://mainnet.helius-rpc.com/?api-key=98a1181b-f456-4689-9902-0d42ed128cb1",
  "https://mainnet.helius-rpc.com/?api-key=78bacaf8-98fc-4651-b665-531d048dbc60",
  "https://mainnet.helius-rpc.com/?api-key=34641eda-518f-4d68-80b1-413c540422cb",
  "https://mainnet.helius-rpc.com/?api-key=4a1443a2-50f7-4d0b-bf15-028f0dcbdeb8",
  "https://mainnet.helius-rpc.com/?api-key=6e5dbf89-00c8-4676-85d7-023ec051a65a",
  "https://mainnet.helius-rpc.com/?api-key=bb3e049b-97d3-4de4-9c48-38e52ca358d3",
  "https://mainnet.helius-rpc.com/?api-key=9358b6c2-e3e5-4cec-a1ab-7e8610af93d1",
  "https://mainnet.helius-rpc.com/?api-key=7bbc5d44-ed19-4641-9bab-4c76c30be30a",
  "https://mainnet.helius-rpc.com/?api-key=01badfdb-0936-4956-9bd9-bf6a5382375d",
  "https://mainnet.helius-rpc.com/?api-key=610f79d5-c909-463d-ad29-954c1cb2316f",
  "https://mainnet.helius-rpc.com/?api-key=696178cb-2eb9-452e-bb90-93b6ecd4ca4b",
  "https://mainnet.helius-rpc.com/?api-key=39d92afb-5501-45e0-8cc5-ab4b10859404"
];

let activeUrls = [...HELIUS_URLS];

async function validateUrls() {
  const results = [];
  for (const url of HELIUS_URLS) {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000);
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }), signal: c.signal });
      } finally { clearTimeout(t); }
      if (res && res.ok) results.push(url);
    } catch (e) { /* skip unreachable */ }
    await new Promise(r => setTimeout(r, 100));
  }
  if (results.length) activeUrls = results; else activeUrls = [HELIUS_URLS[0]];
  console.log(`Active Helius endpoints: ${activeUrls.length}/${HELIUS_URLS.length}`);
}

// ------------------------------------------------------------
// Programs and tokens
// ------------------------------------------------------------
const SERUM_PROGRAM_ID = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const STREAMFLOW_PROGRAM_ID = new PublicKey("4RZHdyGHGsA2vQjkZpU2qKnFyVmGk45tdvKkLrSma9h7");

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDT_MINT = new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

const QUOTE_MINTS = [
  { mint: WSOL_MINT, symbol: "WSOL", decimals: 9 },
  { mint: USDC_MINT, symbol: "USDC", decimals: 6 },
  { mint: USDT_MINT, symbol: "USDT", decimals: 6 }
];

function getPDA(seeds, programId) {
  const [pda] = PublicKey.findProgramAddressSync(seeds, programId);
  return pda;
}

function getATA(owner, mint, tokenProgram = TOKEN_PROGRAM_ID) {
  return getPDA([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
}

function accData(acc) {
  if (!acc || !acc.data) return null;
  if (Array.isArray(acc.data)) return Buffer.from(acc.data[0], "base64");
  if (typeof acc.data === "string") return Buffer.from(acc.data, "base64");
  return null;
}
function lamportsOf(acc) { return acc ? (acc.lamports || 0) / 1e9 : 0; }
function readU64(buf, off) { try { return Number(buf.readBigUInt64LE(off)); } catch (e) { return 0; } }

// ------------------------------------------------------------
// Low-level RPC helpers (ability to call a specific Helius URL)
// ------------------------------------------------------------
async function fetchGetProgramAccounts(url, programId, filters = [], dataSlice) {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 60000);
    const params = [programId, { encoding: "base64", commitment: "confirmed", filters }];
    if (dataSlice) params[1].dataSlice = dataSlice;
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: c.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params }) });
    } finally { clearTimeout(t); }
    const data = await res.json();
    if (data.error) return { accounts: [], error: data.error.message };
    return { accounts: data.result || [], error: null };
  } catch (e) { return { accounts: [], error: e.message }; }
}

async function batchGetMultipleAccounts(addresses, encoding = "base64") {
  const BATCH_SIZE = 100;
  const rpcCount = activeUrls.length;
  const batchErrors = [];

  async function fetchBatch(slice, rpcIndex) {
    let retries = 0;
    while (retries < 4) {
      const url = activeUrls[(rpcIndex + retries) % rpcCount];
      try {
        const c = new AbortController(); const t = setTimeout(() => c.abort(), 12000);
        let res;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: c.signal,
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [slice, { encoding, commitment: "confirmed" }] })
          });
        } finally { clearTimeout(t); }
        const data = await res.json();
        if (data.error) {
          retries++;
          if (retries >= 4) { batchErrors.push(`RPC error: ${data.error.message}`); return new Array(slice.length).fill(null); }
          await new Promise(r => setTimeout(r, 600 * retries));
          continue;
        }
        if (data.result && data.result.value) return data.result.value;
        return new Array(slice.length).fill(null);
      } catch (e) {
        retries++;
        if (retries >= 4) { batchErrors.push(`Network error: ${e.message}`); return new Array(slice.length).fill(null); }
        await new Promise(r => setTimeout(r, 600 * retries));
      }
    }
    return new Array(slice.length).fill(null);
  }

  const batches = [];
  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    batches.push(fetchBatch(addresses.slice(i, i + BATCH_SIZE), Math.floor(i / BATCH_SIZE)));
  }
  const results = await Promise.all(batches);
  return { accounts: results.flat(), errors: batchErrors };
}

// ------------------------------------------------------------
// Input addresses
// ------------------------------------------------------------
function getAddresses() {
  const inputFile = "addresses.txt";
  if (!fs.existsSync(inputFile)) return [];
  return fs.readFileSync(inputFile, "utf-8")
    .split(/\r?\n/)
    .map(line => { const m = line.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/); return m ? m[0] : null; })
    .filter(a => a !== null);
}

// ------------------------------------------------------------
// Scans definitions
// ------------------------------------------------------------
const SCANS = {
  serum_open_orders: { file: "serum_open_orders.txt", label: "Serum: OpenOrders accounts (محتملة الرسوم/رصيد)" },
  serum_token_accounts: { file: "serum_token_accounts.txt", label: "Serum: Token Accounts (ATA & other SPL accounts)" },
  streamflow_streams: { file: "streamflow_streams.txt", label: "Streamflow: Streams / Escrows" },
  all: { file: "scan_all.txt", label: "فحص شامل (Serum + Streamflow)" }
};

// ------------------------------------------------------------
// Simple web UI
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Serum+Streamflow Scanner</title></head><body style="background:#0b0b0b;color:#eee;font-family:sans-serif;padding:20px;"><h1>Serum + Streamflow Scanner</h1><p>ضع addresses.txt في جذر المستودع. يحاول الآن استخدام Helius RPCs الموفّرة لتشغيل الفحوصات بالتوازي.</p><div><button onclick="start('serum_open_orders')">Serum OpenOrders</button> <button onclick="start('serum_token_accounts')">Serum Token Accounts</button> <button onclick="start('streamflow_streams')">Streamflow Streams</button> <button onclick="start('all')">فحص شامل</button></div><pre id="log" style="background:#000;color:#0f0;padding:12px;height:60vh;overflow:auto;margin-top:12px;"></pre><script>let es;function start(p){document.getElementById('log').textContent='بدء: '+p+'\n'; es=new EventSource('/scan-stream?platform='+p);es.onmessage=e=>{const d=JSON.parse(e.data); if(d.type==='progress'){ if(d.display) document.getElementById('log').textContent+=d.display+'\n'; if(d.foundItems){ d.foundItems.forEach(it=>document.getElementById('log').textContent+=`✅ ${it.address} — ${it.display}\n`); } if(d.errors){ d.errors.forEach(err=>document.getElementById('log').textContent+=`⚠️ ${err}\n`); } } else if(d.type==='note'){ document.getElementById('log').textContent+=d.text+'\n'; } else if(d.type==='done'){ document.getElementById('log').textContent+=`انتهى: ${d.summary}\nملف: ${d.file}\n`; es.close(); }}; es.onerror=()=>{ es.close(); } }</script></body></html>`);
});

// ------------------------------------------------------------
// Scan stream endpoint (SSE)
// ------------------------------------------------------------
app.get("/scan-stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const platform = req.query.platform;
  const send = obj => res.write("data: " + JSON.stringify(obj) + "\n\n");

  const addresses = getAddresses();
  const total = addresses.length;
  if (total === 0) {
    send({ type: 'done', foundTotal: 0, summary: "لا توجد عناوين في addresses.txt" });
    return res.end();
  }

  const platforms = platform === "all" ? Object.keys(SCANS).filter(k=>k!=='all') : [platform];
  let grandTotal = 0;
  const grand = { sol: 0, usdc: 0, tok: 0, rent: 0 };

  send({ type: 'progress', current: 0, total, percent: 0, display: `جاري الفحص: ${platforms.join(', ')} — ${total} عناوين | Helius endpoints: ${activeUrls.length}` });

  for (const p of platforms) {
    const conf = SCANS[p];
    const outputFile = conf.file;
    fs.writeFileSync(outputFile, `=== ${conf.label} ===\n`);
    generatedResultFiles.add(outputFile);
    send({ type: 'note', text: `▶ ${conf.label}` });

    try {
      const r = await runScan(p, addresses, send, outputFile, total);
      grandTotal += r.found;
      grand.sol += r.sol || 0; grand.usdc += r.usdc || 0; grand.tok += r.tok || 0; grand.rent += r.rent || 0;
      fs.appendFileSync(outputFile, `\nالإجمالي: ${(r.sol||0).toFixed(6)} SOL | ${(r.usdc||0).toFixed(4)} USDC | ${(r.tok||0).toFixed(4)} TOK | إيجار: ${(r.rent||0).toFixed(6)} SOL\n`);
      send({ type: 'note', text: `↳ ${r.found} نتائج | ${(r.sol||0).toFixed(6)} SOL | ${(r.usdc||0).toFixed(4)} USDC` });
    } catch (e) {
      send({ type: 'progress', current: 0, total, percent: 0, display: '', errors: [`${conf.label}: ${e.message}`] });
    }
  }

  send({ type: 'done', foundTotal: grandTotal, summary: `الإجمالي الكلي: ${grand.sol.toFixed(6)} SOL | ${grand.usdc.toFixed(4)} USDC`, file: platforms.map(p=>SCANS[p].file).join(', ') });
  res.end();
});

// ------------------------------------------------------------
// Scanner implementation with distribution across Helius endpoints
// ------------------------------------------------------------
async function runScan(platform, addresses, send, outputFile, total) {
  const BATCH_PROGRESS = 50; // smaller batches for responsive progress
  const wallets = addresses.map(a => { try { return new PublicKey(a); } catch (e) { return null; } });
  const acc = { found: 0, sol: 0, usdc: 0, tok: 0, rent: 0 };
  const record = (address, pda, display) => {
    acc.found++;
    fs.appendFileSync(outputFile, `العنوان: ${address} | الحساب: ${pda} | ${display}\n-------------------\n`);
  };
  const progress = (endIndex, foundItems, errors = [], display) => {
    send({ type: 'progress', current: endIndex, total, percent: Math.round((endIndex/total)*100), foundItems, errors, display });
  };

  const DEFAULT = PublicKey.default.toBase58();
  const safe = list => list.map(x => x || DEFAULT);

  // Helper: distribute wallet indices into groups by helius endpoint index
  const groups = HELIUS_URLS.map(() => []);
  for (let i = 0; i < wallets.length; i++) {
    groups[i % HELIUS_URLS.length].push(i);
  }

  // ============ Serum token accounts (use getTokenAccountsByOwner approach via getMultipleAccounts of ATAs) ============
  if (platform === 'serum_token_accounts') {
    const mints = [...QUOTE_MINTS];
    const sets = [];
    for (const q of mints) {
      const atas = wallets.map(w => w ? getATA(w, q.mint).toBase58() : null);
      const { accounts, errors } = await batchGetMultipleAccounts(safe(atas), 'base64');
      sets.push({ q, atas, accounts, errors });
    }

    for (let i = 0; i < addresses.length; i += BATCH_PROGRESS) {
      const end = Math.min(i + BATCH_PROGRESS, addresses.length);
      const foundItems = [];
      const errors = [];
      for (const s of sets) errors.push(...s.errors.splice(0, s.errors.length));
      for (let k = i; k < end; k++) {
        if (!wallets[k]) continue;
        const parts = [];
        let rent = 0;
        for (const s of sets) {
          const a = s.accounts[k];
          const buf = accData(a);
          if (!buf) continue;
          if (buf.length >= 72) {
            const amt = readU64(buf, 64) / Math.pow(10, s.q.decimals);
            if (amt === 0) { rent += lamportsOf(a); parts.push(`${s.q.symbol}: فارغ → ${lamportsOf(a).toFixed(6)} SOL`); }
            else { parts.push(`${s.q.symbol}: ${amt.toFixed(6)} رصيد (قابل للسحب)`); if (s.q.symbol === 'WSOL') acc.sol += amt; else acc.usdc += amt; }
          }
        }
        if (parts.length > 0) {
          acc.rent += rent;
          const display = `${parts.join(' | ')}${rent ? ` → ${rent.toFixed(6)} SOL إيجار` : ''}`;
          record(addresses[k], 'ATAs', display);
          foundItems.push({ address: addresses[k], display });
        }
      }
      progress(end, foundItems, errors);
    }
    return acc;
  }

  // ============ Serum OpenOrders (accurate discovery using memcmp owner at offset 40) ============
  if (platform === 'serum_open_orders') {
    send({ type: 'note', text: 'جاري فحص OpenOrders: سنستخدم memcmp على offset=40 (owner) عبر Helius endpoints موزعة' });

    // For each group (each Helius URL) process its wallet indices in parallel groups
    const groupPromises = groups.map(async (indices, gIdx) => {
      const url = HELIUS_URLS[gIdx % HELIUS_URLS.length];
      const results = [];
      for (const wi of indices) {
        const w = wallets[wi]; if (!w) continue;
        // memcmp filter at offset 40 for owner pubkey
        const filters = [{ memcmp: { offset: 40, bytes: w.toBase58() } }];
        try {
          const { accounts, error } = await fetchGetProgramAccounts(url, SERUM_PROGRAM_ID.toBase58(), filters);
          if (error) { results.push({ wi, accounts: [], error }); continue; }
          results.push({ wi, accounts, error: null });
        } catch (e) { results.push({ wi, accounts: [], error: e.message }); }
        // tiny delay to avoid overwhelming endpoint
        await new Promise(r => setTimeout(r, 60));
      }
      return results;
    });

    const settled = await Promise.all(groupPromises);
    // flatten
    const perWallet = new Map();
    for (const grp of settled) {
      for (const r of grp) {
        perWallet.set(r.wi, r);
      }
    }

    // Now iterate in batches and record findings
    for (let i = 0; i < addresses.length; i += BATCH_PROGRESS) {
      const end = Math.min(i + BATCH_PROGRESS, addresses.length);
      const foundItems = [];
      const errors = [];
      for (let k = i; k < end; k++) {
        const entry = perWallet.get(k);
        if (!entry) continue;
        if (entry.error) { errors.push(`wallet ${addresses[k]}: ${entry.error}`); continue; }
        const accounts = entry.accounts || [];
        if (!accounts || accounts.length === 0) continue;
        // for each found OpenOrders account, attempt to parse known values; fallback to lamports
        let sumLam = 0;
        const items = [];
        for (const a of accounts) {
          const buf = accData(a.account);
          const lam = lamportsOf(a.account);
          sumLam += lam;
          // attempt to parse using known layout if available
          let parsedInfo = null;
          try {
            if (SERUM_OPEN_ORDERS_LAYOUT && typeof SERUM_OPEN_ORDERS_LAYOUT.decode === 'function') {
              const decoded = SERUM_OPEN_ORDERS_LAYOUT.decode(buf);
              // attempt to read unsettled funds if fields exist (field names vary)
              const baseFree = decoded.baseTokenFree || decoded.base_token_free || decoded.base_token_free_amount || 0;
              const quoteFree = decoded.quoteTokenFree || decoded.quote_token_free || decoded.quote_token_free_amount || 0;
              parsedInfo = { baseFree, quoteFree };
            }
          } catch (e) { /* ignore parse errors */ }

          if (parsedInfo) {
            const baseUi = (parsedInfo.baseFree || 0);
            const quoteUi = (parsedInfo.quoteFree || 0);
            items.push({ pubkey: a.pubkey, lamports: lam, base: baseUi, quote: quoteUi });
            if (baseUi > 0) acc.tok += baseUi;
            if (quoteUi > 0) acc.usdc += quoteUi; // best-effort mapping
          } else {
            items.push({ pubkey: a.pubkey, lamports: lam });
          }
        }

        acc.sol += sumLam;
        const display = `${accounts.length} OpenOrders | lamports: ${sumLam.toFixed(6)} SOL | parsed: ${items.length} items`;
        record(addresses[k], accounts[0].pubkey, display);
        foundItems.push({ address: addresses[k], display });
      }
      progress(end, foundItems, errors);
    }
    return acc;
  }

  // ============ Streamflow streams: use memcmp scanning across program accounts and map to owners ============
  if (platform === 'streamflow_streams') {
    send({ type: 'note', text: 'جاري تحميل حسابات Streamflow عبر Helius (قد يستغرق وقتًا حسب العدد)...' });
    // We will call getProgramAccounts without filters but on multiple endpoints until success; to be safe use dataSlice small
    const allAccounts = [];
    for (const url of activeUrls) {
      const { accounts, error } = await fetchGetProgramAccounts(url, STREAMFLOW_PROGRAM_ID.toBase58(), []);
      if (error) continue;
      if (accounts && accounts.length) { allAccounts.push(...accounts); break; }
    }

    send({ type: 'note', text: `تم تحميل ${allAccounts.length} حساب من Streamflow` });
    const ownerMap = new Map();
    for (let wi = 0; wi < wallets.length; wi++) {
      const w = wallets[wi]; if (!w) continue;
      const b = w.toBuffer();
      for (const a of allAccounts) {
        const buf = accData(a.account);
        if (!buf) continue;
        if (buf.indexOf(b) !== -1) {
          if (!ownerMap.has(w.toBase58())) ownerMap.set(w.toBase58(), []);
          ownerMap.get(w.toBase58()).push({ pda: a.pubkey, lamports: lamportsOf(a.account) });
        }
      }
    }

    // report results
    for (let i = 0; i < addresses.length; i += BATCH_PROGRESS) {
      const end = Math.min(i + BATCH_PROGRESS, addresses.length);
      const foundItems = [];
      for (let k = i; k < end; k++) {
        const list = ownerMap.get(addresses[k]);
        if (!list || list.length === 0) continue;
        const totalLam = list.reduce((s, x) => s + x.lamports, 0);
        acc.sol += totalLam;
        const display = `${list.length} حساب Streamflow مرتبط | ${totalLam.toFixed(6)} SOL (قد تمثل مبالغ/escrow)`;
        record(addresses[k], list[0].pda, display);
        foundItems.push({ address: addresses[k], display });
      }
      progress(end, foundItems);
    }
    return acc;
  }

  return acc;
}

// ------------------------------------------------------------
// Result file helpers
// ------------------------------------------------------------
function scanResultFiles() {
  return [...generatedResultFiles].filter(f => fs.existsSync(f) && fs.statSync(f).size > 40);
}
app.get('/list-result-files', (req,res)=>{ const known = Object.values(SCANS).map(s=>s.file); res.json({ files: known.filter(f=>fs.existsSync(f) && fs.statSync(f).size>40) }); });
app.get('/calculate-total', (req,res)=>{
  const file = req.query.file; if (!file || !fs.existsSync(file)) return res.json({ success:false, message:'الملف غير موجود' });
  const lines = fs.readFileSync(file,'utf-8').split(/\r?\n/).filter(l=>l.startsWith('العنوان:'));
  let totalSol=0,totalUsdc=0,totalTok=0;
  for (const l of lines) { for (const m of l.matchAll(/([\d.]+)\s*SOL/g)) totalSol+=parseFloat(m[1])||0; for (const m of l.matchAll(/([\d.]+)\s*WSOL/g)) totalSol+=parseFloat(m[1])||0; for (const m of l.matchAll(/([\d.]+)\s*USDC/g)) totalUsdc+=parseFloat(m[1])||0; for (const m of l.matchAll(/([\d.]+)\s*USDT/g)) totalUsdc+=parseFloat(m[1])||0; for (const m of l.matchAll(/([\d.]+)\s*(?:توكن\s*)?PUMP/g)) totalTok+=parseFloat(m[1])||0; }
  res.json({ success:true, count:lines.length, totalSol, totalUsdc, totalTok });
});
app.get('/clean-addresses',(req,res)=>{ try{ const addrs=getAddresses(); const unique=[...new Set(addrs)]; fs.writeFileSync('addresses.txt', unique.join('\n')+'\n'); res.json({ success:true, count: unique.length }); }catch(e){ res.json({ success:false, message:e.message }); } });
app.get('/zip-results',(req,res)=>{ const toZip = scanResultFiles(); if (toZip.length===0) return res.status(404).json({ success:false, message:'لا توجد ملفات نتائج بها بيانات' }); res.setHeader('Content-Type','application/zip'); res.setHeader('Content-Disposition','attachment; filename="scanner_results.zip"'); const archive = archiver('zip',{ zlib:{ level:9 }}); archive.on('error',()=>{ try{ res.end(); }catch{} }); archive.pipe(res); for (const f of toZip) archive.file(f,{ name: f }); archive.finalize(); });

app.listen(port, '0.0.0.0', async ()=>{
  if (!fs.existsSync('addresses.txt')) { fs.writeFileSync('addresses.txt', 'EnterPublicKeyHere\n'); console.log('✅ تم إنشاء ملف addresses.txt'); }
  await validateUrls();
  console.log('Server listening on port', port);
});
