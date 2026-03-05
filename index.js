const express = require('express');
const axios = require('axios');
const { MACD } = require('technicalindicators');
const fs = require('fs-extra');
const path = require('path');
const pLimit = require('p-limit');

const app = express();
const port = 5000;
const COINGECKO_API_KEY = 'CG-nFugCK3pwgPiLnSupXdpDn3u';
const DATA_FILE = path.join(__dirname, 'last_results.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const limit = pLimit.default ? pLimit.default(20) : (typeof pLimit === 'function' ? pLimit(20) : pLimit); // Handle different p-limit versions

app.use(express.json());

// Helper to save/load results
const saveResults = async (data) => {
    await fs.writeJson(DATA_FILE, data);
};

const loadResults = async () => {
    if (await fs.pathExists(DATA_FILE)) {
        return await fs.readJson(DATA_FILE);
    }
    return [];
};

const saveSettings = async (settings) => {
    await fs.writeJson(SETTINGS_FILE, settings);
};

const loadSettings = async () => {
    if (await fs.pathExists(SETTINGS_FILE)) {
        return await fs.readJson(SETTINGS_FILE);
    }
    return { intervals: ['1d'], type: 'histogram' };
};

const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Crypto Screener</title>
    <style>
        :root {
            --bg-color: #0f172a;
            --card-bg: #1e293b;
            --text-primary: #f1f5f9;
            --text-secondary: #94a3b8;
            --accent: #38bdf8;
            --success: #22c55e;
            --border: #334155;
        }
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            margin: 0; 
            padding: 8px;
            background-color: var(--bg-color); 
            color: var(--text-primary);
            line-height: 1.4;
        }
        .container { max-width: 100%; margin: auto; }
        header { text-align: center; padding: 15px 0; }
        h1 { margin: 0; font-size: 1.2rem; color: var(--accent); }
        
        .card {
            background: var(--card-bg);
            padding: 15px;
            border-radius: 12px;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            margin-bottom: 15px;
            border: 1px solid var(--border);
        }

        .controls { 
            display: flex; 
            flex-direction: row;
            gap: 10px;
            align-items: center;
        }
        
        #interval { 
            flex: 1; 
            min-width: 120px; 
            font-size: 0.8rem; 
            padding: 8px; 
            border-radius: 8px; 
            border: 1px solid var(--border); 
            background-color: var(--bg-color); 
            color: var(--text-primary); 
            cursor: pointer; 
            appearance: none; 
            -webkit-appearance: none; 
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2394a3b8'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M7 10l5 5 5-5' /%3E%3C/svg%3E"); 
            background-repeat: no-repeat; 
            background-position: right 10px center; 
            background-size: 16px; 
            padding-right: 32px;
        }
        #analysisType { 
            flex: 1; 
            min-width: 120px; 
            font-size: 0.8rem; 
            padding: 8px; 
            border-radius: 8px; 
            border: 1px solid var(--border); 
            background-color: var(--bg-color); 
            color: var(--text-primary); 
            cursor: pointer; 
            appearance: none; 
            -webkit-appearance: none; 
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2394a3b8'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M7 10l5 5 5-5' /%3E%3C/svg%3E"); 
            background-repeat: no-repeat; 
            background-position: right 10px center; 
            background-size: 16px; 
            padding-right: 32px;
        }
        #runBtn { flex: 1; border-radius: 8px; padding: 8px; }

        select {
            background-color: var(--bg-color);
            color: var(--text-primary);
        }

        button { 
            background-color: var(--accent); 
            color: #000; 
            font-weight: bold;
            cursor: pointer; 
            border: none;
            transition: opacity 0.2s;
        }
        button:disabled { opacity: 0.5; cursor: not-allowed; }

        .results-container { overflow: hidden; padding: 10px; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        th, td { padding: 8px 4px; text-align: left; border-bottom: 1px solid var(--border); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        th { color: var(--text-secondary); font-weight: 500; font-size: 0.75rem; text-transform: uppercase; }
        
        .symbol-name { font-weight: bold; color: var(--accent); font-size: 0.9rem; }
        .price { font-family: monospace; font-size: 0.85rem; }
        .match-badge {
            background: var(--success);
            color: white;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 0.65rem;
            margin-left: 5px;
            vertical-align: middle;
        }
        .secondary { color: var(--text-secondary); font-size: 0.7rem; }

        .loading { 
            display: none; 
            text-align: center; 
            padding: 20px;
            color: var(--accent);
            font-size: 0.9rem;
        }
        
        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--text-secondary);
        }

        /* Column widths for mobile */
        th:nth-child(1), td:nth-child(1) { width: 30%; }
        th:nth-child(2), td:nth-child(2) { width: 20%; }
        th:nth-child(3), td:nth-child(3) { width: 25%; }
        th:nth-child(4), td:nth-child(4) { width: 25%; }

        @media (max-width: 480px) {
            body { padding: 5px; }
            .card { padding: 10px; }
            th, td { font-size: 0.8rem; padding: 6px 2px; }
            .symbol-name { font-size: 0.8rem; }
        }

        /* Multi-select checkmark styling */
        option.selected::before {
            content: "✓ ";
            color: var(--success);
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Crypto Screener</h1>
        </header>

        <div class="card">
            <div class="controls">
                <select id="interval" multiple size="1" style="overflow: hidden; transition: size 0.2s;" onfocus="this.size=4" onblur="this.size=1" onchange="updateSelectUI(this)">
                    <option value="1h">1h (Hour)</option>
                    <option value="4h">4h</option>
                    <option value="1d" selected>1d (Day)</option>
                    <option value="1w">1w (Week)</option>
                </select>
                <select id="analysisType">
                    <option value="macd">Medium Precision</option>
                    <option value="histogram" selected>High Precision</option>
                </select>
                <button id="runBtn">Run</button>
            </div>
        </div>

        <div id="loading" class="loading">Scanning CoinGecko market...</div>

        <div id="content">
            <div class="card results-container" id="resultsTableWrapper" style="display:none;">
                <table>
                    <thead>
                        <tr>
                            <th>Coin</th>
                            <th>Price</th>
                            <th>Matches</th>
                            <th>Safety</th>
                        </tr>
                    </thead>
                    <tbody id="resultsBody"></tbody>
                </table>
            </div>
            <div id="noResults" class="empty-state" style="display:none;">No results found. Select one or more intervals and click Run.</div>
        </div>
    </div>

    <script>
        const runBtn = document.getElementById('runBtn');
        const loading = document.getElementById('loading');
        const resultsWrapper = document.getElementById('resultsTableWrapper');
        const resultsBody = document.getElementById('resultsBody');
        const noResults = document.getElementById('noResults');
        const intervalSelect = document.getElementById('interval');
        let updateInterval = null;

        function updateSelectUI(select) {
            // Keep at least one selected
            const selected = Array.from(select.selectedOptions);
            if (selected.length === 0) {
                // Find and select 1d as default if nothing is selected
                Array.from(select.options).find(opt => opt.value === '1d').selected = true;
            }
        }

        async function startRealtimePriceUpdates() {
            if (updateInterval) clearInterval(updateInterval);
            
            updateInterval = setInterval(async () => {
                // Only update if document is visible
                if (document.hidden) return;

                const rows = resultsBody.querySelectorAll('tr');
                if (rows.length === 0) return;

                try {
                    // Using Binance Public API for real-time prices (No API Key needed for 24hr ticker)
                    const response = await fetch('https://api.binance.com/api/v3/ticker/price');
                    const prices = await response.json();
                    const priceMap = new Map(prices.map(p => [p.symbol, p.price]));

                    rows.forEach(row => {
                        const symbolCell = row.querySelector('.symbol-name');
                        const priceCell = row.querySelector('.price');
                        if (symbolCell && priceCell) {
                            const symbolText = symbolCell.textContent.trim();
                            // Handle cases like "BTCUSDT" or just "BTC"
                            let symbol = symbolText.toUpperCase();
                            if (!symbol.endsWith('USDT')) {
                                symbol += 'USDT';
                            }
                            const newPrice = priceMap.get(symbol);
                            if (newPrice) {
                                // Formatting: more decimals for small prices, 2 for large
                                const priceNum = parseFloat(newPrice);
                                const formattedPrice = priceNum < 1 ? priceNum.toFixed(6) : priceNum.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
                                // Color feedback based on price change
                                const oldPriceText = priceCell.textContent.replace(/,/g, '');
                                const oldPrice = parseFloat(oldPriceText);
                                if (!isNaN(oldPrice) && oldPriceText !== "") {
                                    if (priceNum > oldPrice) {
                                        priceCell.style.color = '#22c55e'; // Green
                                    } else if (priceNum < oldPrice) {
                                        priceCell.style.color = '#ef4444'; // Red
                                    }
                                }
                                
                                priceCell.textContent = formattedPrice;
                                
                                // Visual feedback for price update (brief flash)
                                priceCell.style.transition = 'color 0.3s';
                                setTimeout(() => {
                                    priceCell.style.color = '';
                                }, 1000);
                            }
                        }
                    });
                } catch (e) {
                    console.error('Real-time update failed', e);
                }
            }, 5000); // Update every 5 seconds
        }

        async function loadInitial() {
            try {
                const settingsRes = await fetch('/settings');
                const settings = await settingsRes.json();
                
                // Update intervals
                Array.from(intervalSelect.options).forEach(opt => {
                    opt.selected = settings.intervals.includes(opt.value);
                });
                
                // Update analysis type
                document.getElementById('analysisType').value = settings.type;

                const res = await fetch('/last-results');
                const data = await res.json();
                renderResults(data);
            } catch (e) {}
        }

        function renderResults(data) {
            if (data && data.length > 0) {
                resultsBody.innerHTML = data.map(item => \`
                    <tr>
                        <td>
                            <div class="symbol-name" style="cursor: pointer;" onclick="navigator.clipboard.writeText('\${item.symbol}')" title="Click to copy">
                                \${item.symbol.replace('USDT', '')}<span class="secondary">USDT</span>
                            </div>
                        </td>
                        <td class="price">\${item.currentPrice}</td>
                        <td>
                            \${item.intervals.length > 0 ? item.intervals.map(i => \`<span class="match-badge">\${i}</span>\`).join('') : '<span class="secondary">No Match</span>'}
                        </td>
                        <td class="divergence-val">
                            <div class="secondary">\${item.strength.toFixed(2)}%</div>
                        </td>
                    </tr>
                \`).join('');
                resultsWrapper.style.display = 'block';
                noResults.style.display = 'none';
            } else {
                resultsWrapper.style.display = 'none';
                noResults.style.display = 'block';
            }
        }

        runBtn.addEventListener('click', async () => {
            const selectedIntervals = Array.from(intervalSelect.selectedOptions).map(opt => opt.value);
            const selectedType = document.getElementById('analysisType').value;
            if (selectedIntervals.length === 0) return;
            
            runBtn.disabled = true;
            loading.style.display = 'block';
            resultsWrapper.style.display = 'none';
            noResults.style.display = 'none';

            try {
                // Save settings
                await fetch('/save-settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ intervals: selectedIntervals, type: selectedType })
                });

                const response = await fetch('/analyze?intervals=' + selectedIntervals.join(',') + '&type=' + selectedType);
                const data = await response.json();
                renderResults(data);
                runBtn.innerText = 'Update';
                startRealtimePriceUpdates();
            } catch (err) {
                alert('Error connecting to server');
            } finally {
                runBtn.disabled = false;
                loading.style.display = 'none';
            }
        });

        loadInitial();
    </script>
</body>
</html>
`;

app.get('/', (req, res) => res.send(html));

app.get('/settings', async (req, res) => {
    const settings = await loadSettings();
    res.json(settings);
});

app.post('/save-settings', async (req, res) => {
    await saveSettings(req.body);
    res.json({ success: true });
});

app.get('/last-results', async (req, res) => {
    const data = await loadResults();
    res.json(data);
});

app.get('/analyze', async (req, res) => {
      const settings = await loadSettings();
      const intervals = (req.query.intervals || settings.intervals.join(',')).split(',');
      const analysisType = req.query.type || settings.type;
      try {
          // استخدام CoinGecko لجلب قائمة العملات (أفضل 250 عملة من حيث القيمة السوقية)
          const coinsRes = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
              params: {
                  vs_currency: 'usd',
                  order: 'market_cap_desc',
                  per_page: 100,
                  page: 1,
                  sparkline: false,
                  x_cg_demo_api_key: COINGECKO_API_KEY
              }
          });

          const symbols = coinsRes.data
              .map(c => ({ 
                  symbol: c.symbol.toUpperCase() + 'USDT',
                  id: c.id,
                  currentPrice: c.current_price
              }));

        const resultsMap = new Map();

        // Analysis function
                const analyzeSymbol = async (coinData, interval) => {
              const { symbol, id, currentPrice } = coinData;
              try {
                  let days = '1';
                  if (interval === '1d') days = '30';
                  if (interval === '1w') days = '90';

                  const ohlcRes = await axios.get(`https://api.coingecko.com/api/v3/coins/${id}/ohlc`, {
                      params: {
                          vs_currency: 'usd',
                          days: days,
                          x_cg_demo_api_key: COINGECKO_API_KEY
                      },
                      timeout: 15000
                  });

                  if (!ohlcRes.data || !Array.isArray(ohlcRes.data)) return null;

                  const lows = ohlcRes.data.map(d => d[3]);
                  const closes = ohlcRes.data.map(d => d[4]);
                
                const macdInput = {
                    values: closes,
                    fastPeriod: 12,
                    slowPeriod: 26,
                    signalPeriod: 9,
                    SimpleMAOscillator: false,
                    SimpleMASignal: false
                };

                const macdResults = MACD.calculate(macdInput);
                if (macdResults.length < 30) return null; // تقليل الحد الأدنى للبيانات المطلوبة

                // اختيار المصفوفة بناءً على طلب المستخدم
                const targetData = (analysisType === 'histogram') 
                    ? macdResults.map(m => m.histogram) 
                    : macdResults.map(m => m.MACD);
                    
                const macdLines = macdResults.map(m => m.MACD); // نحتاجه للتحقق من السلبية دائمًا
                const offset = closes.length - targetData.length;

                const macdTroughs = [];
                // تقليل حجم النافذة (w) للبحث عن القيعان لجعل الاكتشاف أكثر حساسية
                const w = (interval === '1h') ? 5 : (interval === '4h' ? 6 : (interval === '1d' ? 4 : 2));

                // البحث عن القيعان في المصفوفة المختارة (targetData)
                for (let i = w; i < targetData.length - w; i++) {
                    // تحسين البحث عن القاع ليسمح بوجود قيعان متقاربة أو متساوية قليلاً (Flat bottom)
                    if (targetData[i] <= targetData[i - 1] && targetData[i] <= targetData[i + 1]) {
                        if (targetData[i] < targetData[i - 1] || targetData[i] < targetData[i + 1]) {
                            let isLocalMin = true;
                            for (let j = 1; j <= w; j++) {
                                if (targetData[i] > targetData[i - j] || targetData[i] > targetData[i + j]) {
                                    isLocalMin = false; break;
                                }
                            }
                            if (isLocalMin) macdTroughs.push(i);
                        }
                    }
                }

                if (macdTroughs.length >= 2) {
                    const lastTroughIdx = macdTroughs[macdTroughs.length - 1];
                    const prevTroughIdx = macdTroughs[macdTroughs.length - 2];

                    const distance = lastTroughIdx - prevTroughIdx;
                    // توسيع نطاق المسافة المسموح بها بين القاعين
                    if (distance >= 5 && distance <= 80) {

                        const valAtLast = targetData[lastTroughIdx];
                        const valAtPrev = targetData[prevTroughIdx];
                        const priceAtLast = lows[lastTroughIdx + offset];
                        const priceAtPrev = lows[prevTroughIdx + offset];

                        // الدايفرجنس: سعر أقل وقيمة مؤشر (خط أو أعمدة) أعلى
                        // التأكد من أن القيم سالبة (تحت خط الصفر)
                        if (priceAtLast <= priceAtPrev && valAtLast > valAtPrev && valAtLast < 0) {

                            const middleSection = targetData.slice(prevTroughIdx, lastTroughIdx);
                            const highestBetween = Math.max(...middleSection);

                            // فحص الارتداد: تقليل شرط الارتداد ليسمح بظهور النماذج في بدايتها (من 20% إلى 5%)
                            const reboundThreshold = Math.abs(valAtPrev) * 0.05;
                            
                            if (highestBetween > (valAtPrev + reboundThreshold)) { 
                                
                                const priceDiffPct = priceAtPrev > 0 ? ((priceAtPrev - priceAtLast) / priceAtPrev) * 100 : 0;
                                const indicatorImprovementPct = ((valAtLast - valAtPrev) / Math.abs(valAtPrev)) * 100;
                                
                                // Improved strength calculation for true divergence (70-100%)
                                // Base 70% + up to 30% based on price drop and indicator improvement
                                let strength = 70 + (Math.min(15, priceDiffPct * 2) + Math.min(15, indicatorImprovementPct / 5));

                                return {
                                    symbol,
                                    currentPrice: closes[closes.length - 1],
                                    strength: Math.min(100, strength),
                                    interval,
                                    isMatch: true
                                };
                            }
                        }
                    }
                }

                // حساب القوة الأساسية في حالة عدم وجود دايفرجنس
                const lastMacd = macdLines[macdLines.length - 1];
                const prevMacd = macdLines[macdLines.length - 2];
                const lastHist = targetData[targetData.length - 1];
                const prevHist = targetData[targetData.length - 2];
                
                let baseStrength = 0;
                
                // Check for strong signals without full divergence (40-70%)
                if (lastHist > prevHist && lastHist < 0) {
                    // Momentum is turning up while still negative - moderate signal
                    baseStrength = 40 + (Math.min(30, (lastHist - prevHist) / Math.abs(prevHist) * 100));
                } else {
                    // Weak or neutral signals (0-40%)
                    if (lastMacd > 0) baseStrength += 15;
                    if (lastMacd > prevMacd) baseStrength += 15;
                    if (lastHist > 0) baseStrength += 10;
                }

                return {
                    symbol,
                    currentPrice: closes[closes.length - 1],
                    strength: Math.min(69, baseStrength),
                    interval,
                    isMatch: false
                };
            } catch (e) { }
            return {
                symbol: coinData.symbol,
                currentPrice: coinData.currentPrice,
                strength: 0,
                interval: interval
            };
        };

        // Process all symbols for all intervals in parallel with a limit
        const tasks = [];
        for (const interval of intervals) {
            for (const symbol of symbols) {
                tasks.push(limit(() => analyzeSymbol(symbol, interval)));
            }
        }

        const allResults = await Promise.all(tasks);
        
        // Initialize results with all symbols
        symbols.forEach(s => {
            resultsMap.set(s.symbol, {
                symbol: s.symbol,
                currentPrice: s.currentPrice,
                strength: 0,
                intervals: []
            });
        });

        allResults.filter(r => r !== null).forEach(r => {
            const existing = resultsMap.get(r.symbol);
            if (existing) {
                existing.intervals.push(r.interval);
                // For strength, we take the highest percentage found across intervals
                existing.strength = Math.max(existing.strength, r.strength);
            }
        });

        let finalResults = Array.from(resultsMap.values());
        
        // Sort by strength descending (coins with 0% strength will be at the bottom)
        finalResults.sort((a, b) => b.strength - a.strength);
        await saveResults(finalResults);
        res.json(finalResults);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal Error' });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:\${port}`);
});
