// botpaxg.js
'use strict';

const express = require('express');
const axios = require('axios').default;
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ====== Cấu hình người dùng ======
const SYMBOL = 'PAXGUSDT';
const QUOTE = 'USDT';
const BASE = 'PAXG';
const BUY_AMOUNT_USD = 80;
const INTERVAL = 30_000;
const ENABLE_REINVEST = true;
const KEEPALIVE_URL = 'https://bn-5l7b.onrender.com/health';

// ====== Telegram Bot ======
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn('⚠️ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID, sẽ không gửi Telegram');
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('🚨 Lỗi gửi Telegram:', e.response?.data || e.message);
  }
}

// ====== API Binance ======
const API_KEY    = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
if (!API_KEY || !API_SECRET) {
  console.error('❌ Thiếu BINANCE_API_KEY hoặc BINANCE_API_SECRET');
  process.exit(1);
}

// ====== Trạng thái ======
let filters          = { stepSize: 0, tickSize: 0, minNotional: 0, minQty: 0 };
let currentBuyOrder  = null;
let currentSellOrder = null;
let lastBuyPrice     = null;

// ====== Gọi API Binance ======
async function binanceRequest(method, path, params = {}, isPrivate = false) {
  const baseURL = 'https://api.binance.com';
  const query = new URLSearchParams(params);
  if (isPrivate) {
    query.append('timestamp', Date.now());
    query.append('recvWindow', '5000');
    const signature = crypto.createHmac('sha256', API_SECRET)
                        .update(query.toString())
                        .digest('hex');
    query.append('signature', signature);
  }
  const headers = isPrivate ? { 'X-MBX-APIKEY': API_KEY } : {};
  const url = `${baseURL}${path}?${query.toString()}`;
  return (await axios({ method, url, headers })).data;
}

// ====== Round theo stepSize/tickSize ======
function roundStepSize(qty, stepSize) {
  const q = Math.floor(qty / stepSize) * stepSize;
  return Number(q.toFixed(8));
}
function roundTickSize(price, tickSize) {
  const p = Math.floor(price / tickSize) * tickSize;
  return Number(p.toFixed(2));
}

// ====== Load filters ======
async function loadFilters() {
  const info = await binanceRequest('GET', '/api/v3/exchangeInfo');
  const s    = info.symbols.find(x => x.symbol === SYMBOL);
  if (!s) throw new Error(`Không tìm thấy symbol ${SYMBOL}`);

  const lot     = s.filters.find(f => f.filterType === 'LOT_SIZE');
  const priceF  = s.filters.find(f => f.filterType === 'PRICE_FILTER');
  const notional= s.filters.find(f => f.filterType === 'NOTIONAL') ||
                  s.filters.find(f => f.filterType === 'MIN_NOTIONAL');

  filters = {
    stepSize:    parseFloat(lot.stepSize),
    tickSize:    parseFloat(priceF.tickSize),
    minNotional: notional ? parseFloat(notional.minNotional || notional.notional) : 0,
    minQty:      parseFloat(lot.minQty)
  };

  console.log('Filters:', filters);
  await sendTelegramMessage(`🛠️ Filter loaded:\n` +
    `stepSize=${filters.stepSize}, tickSize=${filters.tickSize}\n` +
    `minQty=${filters.minQty}, minNotional=${filters.minNotional}`);
}

// ====== Số dư ======
async function getBalances() {
  const acc  = await binanceRequest('GET', '/api/v3/account', {}, true);
  const usdt = acc.balances.find(b => b.asset === QUOTE) || { free: '0' };
  const paxg = acc.balances.find(b => b.asset === BASE) || { free: '0' };
  return {
    usdtFree: parseFloat(usdt.free),
    paxgFree: parseFloat(paxg.free)
  };
}

// ====== Lấy giá trung bình đã mua ======
async function getAverageBuyPriceFromCapital(asset) {
  try {
    const data      = await binanceRequest('GET', '/sapi/v1/capital/config/getall', {}, true);
    const assetInfo = Array.isArray(data)
      ? data.find(a => a.coin === asset || a.asset === asset)
      : null;
    const avg = assetInfo?.avgPrice ?? assetInfo?.price ?? assetInfo?.costPrice ?? null;
    if (!avg) return null;
    const num = parseFloat(avg);
    return Number.isFinite(num) && num > 0 ? num : null;
  } catch {
    return null;
  }
}

async function fetchAllTrades(symbol, maxPages = 50) {
  const all = [];
  let fromId;
  for (let i = 0; i < maxPages; i++) {
    const params = { symbol, limit: 1000 };
    if (fromId !== undefined) params.fromId = fromId;
    const batch = await binanceRequest('GET', '/api/v3/myTrades', params, true);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    const last   = batch[batch.length - 1];
    const nextId = typeof last.id === 'number' ? last.id + 1 : undefined;
    if (!nextId || batch.length < 1000) break;
    fromId = nextId;
  }
  all.sort((a, b) => a.time - b.time || a.id - b.id);
  return all;
}

function computeRemainingPositionAvgPriceFIFO(trades) {
  const lots = [];
  const f = v => parseFloat(v);

  for (const t of trades) {
    const qty        = f(t.qty);
    const price      = f(t.price);
    const commission = f(t.commission || 0);
    const assetFee   = t.commissionAsset;

    if (t.isBuyer) {
      let netQty = qty;
      let cost   = qty * price;
      if (assetFee === BASE) netQty = Math.max(0, netQty - commission);
      else if (assetFee === QUOTE) cost += commission;
      if (netQty > 0) lots.push({ qty: netQty, unitCost: cost / netQty });
    } else {
      let sellQty = qty;
      if (assetFee === BASE) sellQty = Math.max(0, sellQty - commission);
      while (sellQty > 0 && lots.length) {
        const lot = lots[0];
        const take= Math.min(lot.qty, sellQty);
        lot.qty  -= take;
        sellQty  -= take;
        if (lot.qty <= 1e-8) lots.shift();
      }
    }
  }

  const remQty  = lots.reduce((s, l) => s + l.qty, 0);
  const remCost = lots.reduce((s, l) => s + l.qty * l.unitCost, 0);
  return remQty > 0 ? remCost / remQty : null;
}

async function getAverageBuyPrice(asset, symbol) {
  let avg = await getAverageBuyPriceFromCapital(asset);
  if (avg) return avg;
  const trades = await fetchAllTrades(symbol);
  avg = computeRemainingPositionAvgPriceFIFO(trades);
  return Number.isFinite(avg) && avg > 0 ? avg : null;
}

// ====== Quản lý lệnh ======
async function checkOpenOrders() {
  const orders = await binanceRequest('GET', '/api/v3/openOrders', { symbol: SYMBOL }, true);
  currentBuyOrder  = orders.find(o => o.side === 'BUY')  || null;
  currentSellOrder = orders.find(o => o.side === 'SELL') || null;
  console.log(JSON.stringify(currentBuyOrder, null, 2));
  console.log(JSON.stringify(currentSellOrder, null, 2));
}

async function placeBuyOrder(price) {
  const { usdtFree } = await getBalances();
  const amountUSD    = Math.min(BUY_AMOUNT_USD, usdtFree);
  if (amountUSD < filters.minNotional) {
    console.log(`❌ USDT (${amountUSD}) < minNotional (${filters.minNotional})`);
    return;
  }
  let qty = roundStepSize(amountUSD / price, filters.stepSize);
  if (qty < filters.minQty) {
    console.log(`❌ Qty mua (${qty}) < minQty (${filters.minQty})`);
    return;
  }

  console.log(`✅ Đặt MUA ${qty} ${SYMBOL} tại ${price}`);
  await sendTelegramMessage(`🛒 Đặt lệnh *MUA* ${qty} ${SYMBOL} @ ${price}`);
  const o = await binanceRequest('POST', '/api/v3/order', {
    symbol: SYMBOL, side: 'BUY', type: 'LIMIT',
    timeInForce: 'GTC', quantity: qty, price
  }, true);

  currentBuyOrder = o;
}

async function placeSellOrder(price, qtyWanted) {
  const { paxgFree } = await getBalances();

  // Dust → botLoop sẽ mua lại
  if (paxgFree < filters.minQty) {
    console.log(`ℹ️ Dust PAXG (${paxgFree}) < minQty (${filters.minQty})`);
    return;
  }

  let qty = roundStepSize(Math.min(qtyWanted, paxgFree), filters.stepSize);
  if (qty < filters.minQty) {
    console.log(`ℹ️ Qty bán (${qty}) < minQty (${filters.minQty})`);
    return;
  }
  if (qty * price < filters.minNotional) {
    console.log(`ℹ️ Giá trị bán (${(qty*price).toFixed(2)}) < minNotional`);
    return;
  }

  console.log(`✅ Đặt BÁN ${qty} ${SYMBOL} tại ${price}`);
  await sendTelegramMessage(`💰 Đặt lệnh *BÁN* ${qty} ${SYMBOL} @ ${price}`);
  const o = await binanceRequest('POST', '/api/v3/order', {
    symbol: SYMBOL, side: 'SELL', type: 'LIMIT',
    timeInForce: 'GTC', quantity: qty, price
  }, true);

  currentSellOrder = o;
}

async function checkFilledOrders() {
  // MUA khớp
  if (currentBuyOrder) {
    const o = await binanceRequest('GET', '/api/v3/order', {
      symbol: SYMBOL, orderId: currentBuyOrder.orderId
    }, true);
    if (o.status === 'FILLED') {
      lastBuyPrice    = parseFloat(o.price);
      currentBuyOrder = null;
      console.log(`✅ MUA khớp: ${o.executedQty}@${o.price}`);
      await sendTelegramMessage(`✅ MUA khớp *${o.executedQty} ${BASE}* @ ${o.price}`);
    }
  }

  // BÁN khớp
  if (currentSellOrder) {
    const o = await binanceRequest('GET', '/api/v3/order', {
      symbol: SYMBOL, orderId: currentSellOrder.orderId
    }, true);
    if (o.status === 'FILLED') {
      console.log(`💰 BÁN khớp: ${o.executedQty}@${o.price}`);
      await sendTelegramMessage(`💰 BÁN khớp *${o.executedQty} ${BASE}* @ ${o.price}`);
      currentSellOrder = null;
      lastBuyPrice     = null;

      // Tái đầu tư
      if (ENABLE_REINVEST) {
        const { usdtFree } = await getBalances();
        if (usdtFree >= BUY_AMOUNT_USD) {
          const t        = await binanceRequest('GET', '/api/v3/ticker/price', { symbol: SYMBOL });
          const buyPrice = roundTickSize(parseFloat(t.price) -8, filters.tickSize);
          console.log(`🔄 Tái đầu tư: mua @ ${buyPrice}`);
          await sendTelegramMessage(`🔄 Tái đầu tư: đặt lệnh *MUA* @ ${buyPrice}`);
          await placeBuyOrder(buyPrice);
        } else {
          console.log(`⏸ USDT < ${BUY_AMOUNT_USD}, không tái đầu tư.`);
        }
      }
    }
  }
}

// ====== Vòng lặp chính ======
async function botLoop() {
  try {
    await checkOpenOrders();
    await checkFilledOrders();

    const t            = await binanceRequest('GET', '/api/v3/ticker/price', { symbol: SYMBOL });
    const currentPrice = parseFloat(t.price);
    const { usdtFree, paxgFree } = await getBalances();

    console.log(`📊 ${SYMBOL}: ${currentPrice} | USDT: ${usdtFree} | PAXG: ${paxgFree}`);
    await sendTelegramMessage(`📊 ${SYMBOL}: ${currentPrice} | USDT: ${usdtFree} | PAXG: ${paxgFree}
    📌 Orders: BUY=${currentBuyOrder?currentBuyOrder.orderId:'–'} - ${currentBuyOrder?currentBuyOrder.price:'–'}
    SELL=${currentSellOrder?currentSellOrder.orderId:'–'} - ${currentSellOrder?currentSellOrder.price:'–'}`);
    console.log(`📌 Orders: BUY=${currentBuyOrder?currentBuyOrder.orderId:'–'} SELL=${currentSellOrder?currentSellOrder.orderId:'–'}`);

    // Dust PAXG → mua lại
    if (paxgFree > 0 && paxgFree < filters.minQty && !currentBuyOrder) {
      console.log(`ℹ️ Dust PAXG (${paxgFree}) → mua lại nếu USDT đủ.`);
      if (usdtFree >= BUY_AMOUNT_USD) {
        const buyPrice = roundTickSize(currentPrice -8, filters.tickSize);
        console.log(`🔄 Đặt MUA dust @ ${buyPrice}`);
        await placeBuyOrder(buyPrice);
      }
      return;
    }

    // Có đủ PAXG → đặt SELL
    if (paxgFree >= filters.minQty && !currentSellOrder) {
      if (lastBuyPrice === null) {
        const avg = await getAverageBuyPrice(BASE, SYMBOL);
        if (!avg) return;
        lastBuyPrice = avg;
      }
      const sellPrice = roundTickSize(lastBuyPrice + 16, filters.tickSize);
      await placeSellOrder(sellPrice, paxgFree);
      return;
    }

    // Không có PAXG → đặt BUY nếu USDT đủ
    if (paxgFree === 0 && !currentBuyOrder) {
      if (usdtFree >= BUY_AMOUNT_USD) {
        const buyPrice = roundTickSize(currentPrice -8, filters.tickSize);
        await placeBuyOrder(buyPrice);
      }
    }

  } catch (e) {
    console.error('🚨 Lỗi botLoop:', e.response?.data || e.message);
    await sendTelegramMessage(`🚨 *Lỗi botLoop*: ${e.message}`);
  }
}

// ====== Khởi động ======
(async () => {
  await loadFilters();
  console.log('🚀 Bot PAXG bắt đầu chạy…');
  await sendTelegramMessage('🚀 Bot PAXG đã khởi động và sẵn sàng giao dịch');
  setInterval(botLoop, INTERVAL);
})();

// ====== HTTP server & keepalive ======
app.get('/health', (_, r) => r.json({ status: 'ok' }));
app.get('/', (_, r) => r.send('Bot PAXG đang chạy…'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server tại port ${PORT}`));

if (KEEPALIVE_URL) {
  setInterval(() => {
    axios.get(KEEPALIVE_URL)
      .catch(()=>{/* ignore */});
  }, 14 * 60 * 1000);
}
