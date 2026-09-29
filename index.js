import express from "express";
import { PublicKey, Connection } from "@solana/web3.js";
import fs from "fs";
import fetch from "node-fetch";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const archiver = require("archiver");

const app = express();
const port = 5000;
app.use(express.json());

const generatedResultFiles = new Set();

// ------------------------------------------------------------
// RPCs (default list; will validate at startup)
// ------------------------------------------------------------
const ALCHEMY_URLS = [
  "https://solana-mainnet.g.alchemy.com/v2/A9xPBcSGQkSIa9owFAab88-KbrZWw7iL",
  "https://solana-mainnet.g.alchemy.com/v2/QMBCCev_Ig1zGFssTed57KsriUzCryCj"
];
const HELIUS_URLS = [
  "https://mainnet.helius-rpc.com/?api-key=24e04e6f-f4ad-4b22-883a-420b194b9a34"
];
let activeUrls = [];

async function validateUrls() {
  const results = [];
  const candidates = [...ALCHEMY_URLS, ...HELIUS_URLS];
  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
        signal: controller.signal
      });
      clearTimeout(timer);
      const data = await response.json();
      if (response.ok && (data.result === "ok" || data.result === undefined)) results.push(url);
    } catch (e) { /* skip */ }
    await new Promise(r => setTimeout(r, 250));
  }
  activeUrls = results.length ? results : [ALCHEMY_URLS[0]];
  console.log(`Active RPCs: ${activeUrls.length}/${candidates.length}`);
}

// ------------------------------------------------------------
// Program IDs
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
// Utilities: batch getMultipleAccounts (like original) + getProgramAccounts
// ------------------------------------------------------------
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

async function getProgramAccountsAll(programId, filters, dataSlice) {
  const errors = [];
  const urls = [...HELIUS_URLS, ...ALCHEMY_URLS, ...activeUrls];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i % urls.length];
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 60000);
      const params = [programId, { encoding: "base64", commitment: "confirmed", filters }];
      if (dataSlice) params[1].dataSlice = dataSlice;
      let res;
      try {
        res = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: c.signal,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params })
        });
      } finally { clearTimeout(t); }
      const data = await res.json();
      if (data.error) { errors.push(data.error.message); continue; }
      if (data.result) return { accounts: data.result, errors };
    } catch (e) { errors.push(e.message); }
  }
  return { accounts: [], errors };
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
  serum_token_accounts: { file: "serum_token_accounts.txt", label: "Serum: ATA وحسابات توكن" },
  streamflow_streams: { file: "streamflow_streams.txt", label: "Streamflow: Streams / Escrows" },
  all: { file: "scan_all.txt", label: "فحص شامل (Serum + Streamflow)" }
};

// Simple web UI (reused from original, simplified)
app.get("/", (req, res) => {
  res.send(`<html><head><meta charset="utf-8"><title>Serum+Streamflow Scanner</title></head><body style="background:#111;color:#eee;font-family:Arial;padding:20px;">
    <h2>Serum + Streamflow Scanner</h2>
    <p>فحص محافظ: Serum (OpenOrders + ATAs) و Streamflow (streams/escrow). ضع addresses.txt في المستودع.</p>
    <div>
      <button onclick="start('serum_open_orders')">Serum OpenOrders</button>
      <button onclick="start('serum_token_accounts')">Serum Token Accounts</button>
      <button onclick="start('streamflow_streams')">Streamflow Streams</button>
      <button onclick="start('all')">فحص شامل</button>
    </div>
    <pre id="log" style="background:#000;color:#0f0;padding:12px;height:60vh;overflow:auto;"></pre>
    <script>
      let es;
      function start(p){
        document.getElementById('log').textContent = 'Starting ' + p + "\n";
        es = new EventSource('/scan-stream?platform=' + p);
        es.onmessage = e => { const d = JSON.parse(e.data); if(d.type==='progress') { document.getElementById('log').textContent += d.display ? d.display + "\n" : JSON.stringify(d) + "\n"; } else if(d.type==='note') { document.getElementById('log').textContent += d.text + "\n"; } else if(d.type==='done') { document.getElementById('log').textContent += 'Done: ' + d.summary + "\nFile: " + d.file + "\n"; es.close(); } };
        es.onerror = () => { es.close(); }
      }
    </script>
  </body></html>`);
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
  const grand = { sol: 0, usdc: 0, pump: 0, rent: 0 };

  send({ type: 'progress', current: 0, total, percent: 0, display: `جاري الفحص: ${platforms.join(', ')} — ${total} عناوين` });

  for (const p of platforms) {
    const conf = SCANS[p];
    const outputFile = conf.file;
    fs.writeFileSync(outputFile, `=== ${conf.label} ===\n`);
    generatedResultFiles.add(outputFile);
    send({ type: 'note', text: `▶ ${conf.label}` });
    try {
      const r = await runScan(p, addresses, send, outputFile, total);
      grandTotal += r.found;
      grand.sol += r.sol || 0; grand.usdc += r.usdc || 0; grand.pump += r.pump || 0; grand.rent += r.rent || 0;
      fs.appendFileSync(outputFile, `\nالإجمالي: ${(r.sol||0).toFixed(6)} SOL | ${(r.usdc||0).toFixed(4)} USDC | ${(r.pump||0).toFixed(4)} TOK | إيجار: ${(r.rent||0).toFixed(6)} SOL\n`);
      send({ type: 'note', text: `↳ ${r.found} نتائج | ${(r.sol||0).toFixed(6)} SOL | ${(r.usdc||0).toFixed(4)} USDC` });
    } catch (e) {
      send({ type: 'progress', current: 0, total, percent: 0, display: '', errors: [`${conf.label}: ${e.message}`] });
    }
  }

  send({ type: 'done', foundTotal: grandTotal, summary: `الإجمالي الكلي: ${grand.sol.toFixed(6)} SOL | ${grand.usdc.toFixed(4)} USDC`, file: platforms.map(p=>SCANS[p].file).join(', ') });
  res.end();
});

// ------------------------------------------------------------
// Core scanner implementation
// ------------------------------------------------------------
async function runScan(platform, addresses, send, outputFile, total) {
  const BATCH_PROGRESS = 100;
  const wallets = addresses.map(a => { try { return new PublicKey(a); } catch (e) { return null; } });
  const acc = { found: 0, sol: 0, usdc: 0, pump: 0, rent: 0 };
  const record = (address, pda, display) => {
    acc.found++;
    fs.appendFileSync(outputFile, `العنوان: ${address} | الحساب: ${pda} | ${display}\n-------------------\n`);
  };
  const progress = (endIndex, foundItems, errors = [], display) => {
    send({ type: 'progress', current: endIndex, total, percent: Math.round((endIndex/total)*100), foundItems, errors, display });
  };
  const DEFAULT = PublicKey.default.toBase58();
  const safe = list => list.map(x => x || DEFAULT);

  // 1) Serum token accounts (ATAs) — البحث عن أرصدة توكن مرتبطة بالعناوين
  if (platform === 'serum_token_accounts') {
    const mints = [...QUOTE_MINTS, /* add other mints if desired */];
    const sets = [];
    for (const q of mints) {
      const atas = wallets.map(w => w ? getATA(w, q.mint).toBase58() : null);
      const { accounts, errors } = await batchGetMultipleAccounts(safe(atas), 'base64');
      sets.push({ q, atas, accounts, errors });
    }
    for (let i=0;i<addresses.length;i+=BATCH_PROGRESS) {
      const end = Math.min(i+BATCH_PROGRESS, addresses.length);
      const foundItems = [];
      const errors = [];
      for (const s of sets) errors.push(...s.errors.splice(0,s.errors.length));
      for (let k=i;k<end;k++) {
        if (!wallets[k]) continue;
        const parts = [];
        let rent = 0;
        for (const s of sets) {
          const a = s.accounts[k];
          const buf = accData(a);
          if (!buf) continue;
          // parse token account
          if (buf.length >= 72) {
            const mint = new PublicKey(buf.subarray(0,32)).toBase58();
            const owner = new PublicKey(buf.subarray(32,64)).toBase58();
            const amt = readU64(buf, 64) / Math.pow(10, s.q.decimals);
            if (amt === 0) { rent += lamportsOf(a); parts.push(`${s.q.symbol}: فارغ → ${lamportsOf(a).toFixed(6)} SOL`); }
            else { parts.push(`${s.q.symbol}: ${amt.toFixed(6)} رصيد (قابل للسحب)`); if (s.q.symbol==='WSOL') acc.sol += amt; else acc.usdc += amt; }
          }
        }
        if (parts.length>0) {
          acc.rent += rent;
          const display = `${parts.join(' | ')}${rent?` → ${rent.toFixed(6)} SOL إيجار` : ''}`;
          record(addresses[k], 'ATAs', display);
          foundItems.push({ address: addresses[k], display });
        }
      }
      progress(end, foundItems, errors);
    }
    return acc;
  }

  // 2) Serum OpenOrders accounts (نحاول الحصول على حسابات OpenOrders المرتبطة بالمحفظة)
  if (platform === 'serum_open_orders') {
    send({ type: 'note', text: 'جاري فحص حسابات OpenOrders عبر getProgramAccounts (ستتم محاولات للعثور على حسابات تخص العناوين)...' });
    // سنحاول جلب جميع حسابات البرنامج ذات طول نموذجي (layout قد يختلف بين الإصدارات) ومن ثم البحث عن owner داخل البيانات
    const likelySizes = [322, 320, 376, 368]; // بعض أحجام OpenOrders عبر النسخ
    let accountsAll = [];
    for (const sz of likelySizes) {
      const { accounts, errors } = await getProgramAccountsAll(SERUM_PROGRAM_ID.toBase58(), [{ dataSize: sz }]);
      if (accounts && accounts.length) accountsAll = accountsAll.concat(accounts);
      if (errors && errors.length) send({ type: 'progress', current: 0, total, percent: 0, foundItems: [], errors: errors.slice(0,3) });
    }
    send({ type: 'note', text: `تحميل ${accountsAll.length} حساب محتمل` });
    // index by owner occurrence
    const ownerToAccounts = new Map();
    for (const a of accountsAll) {
      const buf = accData(a.account);
      if (!buf) continue;
      // scan buffer for any of our wallet pubkeys
      for (let wi=0; wi<wallets.length; wi++) {
        const w = wallets[wi]; if (!w) continue;
        const b = w.toBuffer();
        if (buf.indexOf(b) !== -1) {
          const addr = addresses[wi];
          if (!ownerToAccounts.has(addr)) ownerToAccounts.set(addr, []);
          ownerToAccounts.get(addr).push({ pubkey: a.pubkey, lamports: lamportsOf(a.account) });
        }
      }
    }
    // report
    for (let i=0;i<addresses.length;i+=BATCH_PROGRESS) {
      const end = Math.min(i+BATCH_PROGRESS, addresses.length);
      const foundItems = [];
      for (let k=i;k<end;k++) {
        const list = ownerToAccounts.get(addresses[k]);
        if (!list || list.length===0) continue;
        const sumLam = list.reduce((s,x)=>s+x.lamports,0);
        acc.sol += sumLam;
        const display = `${list.length} حساب OpenOrders محتمل | ${sumLam.toFixed(6)} SOL ضمن الحسابات (قد تمثل رصيد/إيجار)`;
        record(addresses[k], list[0].pubkey, display);
        foundItems.push({ address: addresses[k], display });
      }
      progress(end, foundItems);
    }
    return acc;
  }

  // 3) Streamflow streams (نحمل حسابات البرنامج ونبحث عن البدل الخاص بكل محفظة داخل البيانات)
  if (platform === 'streamflow_streams') {
    send({ type: 'note', text: 'جاري تحميل حسابات Streamflow program...' });
    const { accounts, errors } = await getProgramAccountsAll(STREAMFLOW_PROGRAM_ID.toBase58(), []);
    if (errors && errors.length) send({ type: 'progress', current: 0, total, percent: 0, foundItems: [], errors: errors.slice(0,3) });
    send({ type: 'note', text: `تم تحميل ${accounts.length} حساب من Streamflow` });
    const ownerMap = new Map();
    for (const a of accounts) {
      const buf = accData(a.account);
      if (!buf) continue;
      for (let wi=0; wi<wallets.length; wi++) {
        const w = wallets[wi]; if (!w) continue;
        if (buf.indexOf(w.toBuffer()) !== -1) {
          const addr = addresses[wi];
          if (!ownerMap.has(addr)) ownerMap.set(addr, []);
          ownerMap.get(addr).push({ pda: a.pubkey, lamports: lamportsOf(a.account) });
        }
      }
    }
    for (let i=0;i<addresses.length;i+=BATCH_PROGRESS) {
      const end = Math.min(i+BATCH_PROGRESS, addresses.length);
      const foundItems = [];
      for (let k=i;k<end;k++) {
        const list = ownerMap.get(addresses[k]);
        if (!list || list.length===0) continue;
        const totalLam = list.reduce((s,x)=>s+x.lamports,0);
        acc.sol += totalLam;
        const display = `${list.length} حساب Streamflow مرتبط | ${totalLam.toFixed(6)} SOL (قد تمثل مبالغ قابلة للايداع/استرجاع)`;
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
  let totalSol=0,totalUsdc=0,totalPump=0;
  for (const l of lines) { for (const m of l.matchAll(/([\d.]+)\s*SOL/g)) totalSol+=parseFloat(m[1])||0; for (const m of l.matchAll(/([\d.]+)\s*WSOL/g)) totalSol+=parseFloat(m[1])||0; for (const m of l.matchAll(/([\d.]+)\s*USDC/g)) totalUsdc+=parseFloat(m[1])||0; for (const m of l.matchAll(/([\d.]+)\s*(?:توكن\s*)?PUMP/g)) totalPump+=parseFloat(m[1])||0; }
  res.json({ success:true, count:lines.length, totalSol, totalUsdc, totalPump });
});
app.get('/clean-addresses',(req,res)=>{ try{ const addrs=getAddresses(); const unique=[...new Set(addrs)]; fs.writeFileSync('addresses.txt', unique.join('\n')+'\n'); res.json({ success:true, count: unique.length }); }catch(e){ res.json({ success:false, message:e.message }); } });
app.get('/zip-results',(req,res)=>{ const toZip = scanResultFiles(); if (toZip.length===0) return res.status(404).json({ success:false, message:'لا توجد ملفات نتائج بها بيانات' }); res.setHeader('Content-Type','application/zip'); res.setHeader('Content-Disposition','attachment; filename="scanner_results.zip"'); const archive = archiver('zip',{ zlib:{ level:9 }}); archive.on('error',()=>{ try{ res.end(); }catch{} }); archive.pipe(res); for (const f of toZip) archive.file(f,{ name: f }); archive.finalize(); });

app.listen(port, '0.0.0.0', async ()=>{
  if (!fs.existsSync('addresses.txt')) { fs.writeFileSync('addresses.txt', 'EnterPublicKeyHere\n'); console.log('✅ تم إنشاء ملف addresses.txt'); }
  await validateUrls();
  console.log('Server listening on port', port);
});
