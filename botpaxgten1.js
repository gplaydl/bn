// botpaxg.js
'use strict';

const express = require('express');
const axios = require('axios').default;
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ====== Cấu hình người dùng ======
const SYMBOL          = 'PAXGUSDT';
const QUOTE           = 'USDT';
const BASE            = 'PAXG';
const BUY_AMOUNT_USD  = 80;
const INTERVAL        = 30_000;
const ENABLE_REINVEST = true;
const KEEPALIVE_URL   = process.env.KEEPALIVE_URL || 'https://bn-5l7b.onrender.com/health';
const BUY_UNDER_USD   = 5;   // đặt mua ở giá market - BUY_UNDER_USD
const SELL_OVER_USD   = 10;  // đặt bán ở giá mua + SELL_OVER_USD

// ====== Telegram Bot ======
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn('⚠️ Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID, sẽ không gửi Telegram');
}
async function sendTelegramMessage(text) {
  console.log(text);
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

const BINANCE = axios.create({
  baseURL: 'https://api.binance.com',
  timeout: 15_000,
  headers: { 'X-MBX-APIKEY': API_KEY }
});

function signQuery(paramsObj) {
  const qs = new URLSearchParams(paramsObj).toString();
  const signature = crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex');
  return `${qs}&signature=${signature}`;
}

async function binanceGET(path, params = {}) {
  const query = signQuery({ ...params, timestamp: Date.now(), recvWindow: 5000 });
  const { data } = await BINANCE.get(`${path}?${query}`);
  return data;
}

async function binancePOST(path, params = {}) {
  const query = signQuery({ ...params, timestamp: Date.now(), recvWindow: 5000 });
  const { data } = await BINANCE.post(`${path}?${query}`);
  return data;
}

// ====== Trạng thái & Filters ======
let filters = {
  tickSize:    0,
  stepSize:    0,
  minNotional: 0,
  minQty:      0,
  minPrice:    0,
  maxPrice:    Infinity,
  maxQty:      Infinity
};

// ====== Helpers làm tròn & kiểm tra ======
function toNumber(x) {
  return typeof x === 'number' ? x : Number(x);
}

function decimalPlaces(numStr) {
  const s = String(numStr);
  if (!s.includes('.')) return 0;
  return s.split('.')[1].replace(/0+$/, '').length;
}

function floorToStep(value, step) {
  const v = toNumber(value), s = toNumber(step);
  return s === 0 ? v : Math.floor(v / s) * s;
}

function roundToTick(value, tick) {
  const v = toNumber(value), t = toNumber(tick);
  return t === 0 ? v : Math.floor(v / t) * t;
}

function ceilToTick(value, tick) {
  const v = toNumber(value), t = toNumber(tick);
  return t === 0 ? v : Math.ceil(v / t) * t;
}

function formatByTick(value, tick) {
  const dp = Math.max(decimalPlaces(tick), 0);
  return toNumber(value).toFixed(dp);
}

function formatByStep(value, step) {
  const dp = Math.max(decimalPlaces(step), 0);
  return toNumber(value).toFixed(dp);
}

function ensureNotional(price, qty, minNotional) {
  return toNumber(price) * toNumber(qty) >= toNumber(minNotional);
}

// ====== Load filter từ exchangeInfo ======
async function loadSymbolFilters() {
  const { data } = await BINANCE.get('/api/v3/exchangeInfo', { params: { symbol: SYMBOL } });
  const sym = data.symbols?.[0];
  if (!sym) throw new Error('Không tìm thấy symbol trong exchangeInfo');
  const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER');
  const lotSize     = sym.filters.find(f => f.filterType === 'LOT_SIZE');
  const minNotional = sym.filters.find(f => f.filterType === 'MIN_NOTIONAL') 
                     || sym.filters.find(f => f.filterType === 'NOTIONAL');

  filters.tickSize    = toNumber(priceFilter?.tickSize  || '0');
  filters.minPrice    = toNumber(priceFilter?.minPrice  || '0');
  filters.maxPrice    = toNumber(priceFilter?.maxPrice  || '0');
  filters.stepSize    = toNumber(lotSize?.stepSize      || '0');
  filters.minQty      = toNumber(lotSize?.minQty        || '0');
  filters.maxQty      = toNumber(lotSize?.maxQty        || '0');
  filters.minNotional = toNumber(minNotional?.minNotional || minNotional?.notional || '0');
}

// ====== API tài khoản, giá, orders ======
async function getBalances() {
  const acc = await binanceGET('/api/v3/account');
  const getFree = asset => toNumber(acc.balances.find(b => b.asset === asset)?.free || '0');
  return { usdtFree: getFree(QUOTE), baseFree: getFree(BASE) };
}

async function getCurrentPrice() {
  const { data } = await BINANCE.get('/api/v3/ticker/price', { params: { symbol: SYMBOL } });
  return toNumber(data.price);
}

async function getOpenOrders() {
  return await binanceGET('/api/v3/openOrders', { symbol: SYMBOL });
}

async function getOrder(orderId) {
  return await binanceGET('/api/v3/order', { symbol: SYMBOL, orderId });
}

async function placeLimit(side, price, quantity) {
  const priceAdj = formatByTick(price, filters.tickSize);
  const qtyAdj   = formatByStep(quantity, filters.stepSize);
  const p = toNumber(priceAdj), q = toNumber(qtyAdj);

  if (p < filters.minPrice || p > filters.maxPrice)
    throw new Error(`Giá ${p} ngoài khoảng [${filters.minPrice},${filters.maxPrice}]`);
  if (q < filters.minQty   || q > filters.maxQty)
    throw new Error(`Qty ${q} ngoài khoảng [${filters.minQty},${filters.maxQty}]`);
  if (!ensureNotional(p, q, filters.minNotional))
    throw new Error(`Notional ${p*q} < minNotional ${filters.minNotional}`);

  const params = {
    symbol: SYMBOL,
    side,
    type: 'LIMIT',
    timeInForce: 'GTC',
    price: priceAdj,
    quantity: qtyAdj,
    newOrderRespType: 'RESULT'
  };
  return await binancePOST('/api/v3/order', params);
}

async function waitFilled(orderId, timeoutMs = 300_000, pollMs = 3_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ord = await getOrder(orderId);
    if (ord.status === 'FILLED') return ord;
    if (['CANCELED','REJECTED','EXPIRED'].includes(ord.status))
      throw new Error(`Order ${orderId} kết thúc: ${ord.status}`);
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`Đợi order ${orderId} FILLED quá thời gian`);
}

// ====== Logic chính ======
async function mainCycle() {
  try {
    if (!filters.tickSize || !filters.stepSize) {
      await loadSymbolFilters();
    }

    const [price, balances, openOrders] = await Promise.all([
      getCurrentPrice(),
      getBalances(),
      getOpenOrders()
    ]);
    const { usdtFree } = balances;

    // 1. Kiểm tra SELL limit đang chờ
    const sellOrders = openOrders.filter(o => o.side === 'SELL' && o.status === 'NEW');
    if (sellOrders.length > 0) {
      const sell = sellOrders[0];
      await sendTelegramMessage(
        `📊 ${SYMBOL}\n` +
        `• Giá hiện tại: ${price}\n` +
        `• USDT khả dụng: ${usdtFree}\n` +
        `• SELL chờ: ID=${sell.orderId} | Giá=${sell.price} | SL=${sell.origQty}`
      );
      return;
    }

    // 2. Nếu không có SELL, check USDT và đặt BUY
    if (usdtFree <= BUY_AMOUNT_USD) {
      await sendTelegramMessage(
        `ℹ️ ${SYMBOL}\n` +
        `• Không có SELL chờ\n` +
        `• USDT (${usdtFree}) không đủ > ${BUY_AMOUNT_USD}`
      );
      return;
    }

    let buyPriceRaw = price - BUY_UNDER_USD;
    buyPriceRaw = Math.max(buyPriceRaw, filters.minPrice);
    const buyPrice = roundToTick(buyPriceRaw, filters.tickSize);
    let buyQty = floorToStep(BUY_AMOUNT_USD / buyPrice, filters.stepSize);

    if (buyQty < filters.minQty) {
      const needed = filters.minQty * buyPrice;
      if (needed <= usdtFree) buyQty = filters.minQty;
      else {
        await sendTelegramMessage(
          `⚠️ ${SYMBOL}\n` +
          `• Qty < minQty và USDT không đủ nâng lên minQty`
        );
        return;
      }
    }

    if (!ensureNotional(buyPrice, buyQty, filters.minNotional)) {
      const neededQty = Math.ceil((filters.minNotional / buyPrice) / filters.stepSize) * filters.stepSize;
      const cost = neededQty * buyPrice;
      if (cost <= usdtFree && neededQty <= filters.maxQty) buyQty = neededQty;
      else {
        await sendTelegramMessage(
          `⚠️ ${SYMBOL}\n` +
          `• Không thể đạt minNotional`
        );
        return;
      }
    }

    const buyOrder = await placeLimit('BUY', buyPrice, buyQty);
    await sendTelegramMessage(
      `🟩 ĐẶT BUY ${SYMBOL}\n` +
      `• ID: ${buyOrder.orderId}\n` +
      `• Giá: ${buyOrder.price}\n` +
      `• SL: ${buyOrder.origQty}`
    );

    const filled = await waitFilled(buyOrder.orderId);
    const executedQty = toNumber(filled.executedQty || '0');
    const cumQuote    = toNumber(filled.cummulativeQuoteQty || '0');
    const avgBuyPrice = executedQty > 0 ? (cumQuote / executedQty) : toNumber(filled.price);

    await sendTelegramMessage(
      `✅ BUY FILLED ${SYMBOL}\n` +
      `• ID: ${filled.orderId}\n` +
      `• SL: ${executedQty}\n` +
      `• Giá TB: ${avgBuyPrice.toFixed(decimalPlaces(filters.tickSize))}`
    );

    // Đặt SELL ngay
    let sellPriceRaw = avgBuyPrice + SELL_OVER_USD;
    sellPriceRaw = Math.min(Math.max(sellPriceRaw, filters.minPrice), filters.maxPrice);
    const sellPrice = formatByTick(ceilToTick(sellPriceRaw, filters.tickSize), filters.tickSize);
    let sellQty = floorToStep(executedQty, filters.stepSize);

    if (sellQty < filters.minQty) {
      await sendTelegramMessage(`⚠️ Không thể đặt SELL: Qty < minQty`);
      return;
    }
    if (!ensureNotional(sellPrice, sellQty, filters.minNotional)) {
      await sendTelegramMessage(`⚠️ Không thể đặt SELL: Notional < minNotional`);
      return;
    }

    const sellOrder = await placeLimit('SELL', sellPrice, sellQty);
    await sendTelegramMessage(
      `🟥 ĐẶT SELL ${SYMBOL}\n` +
      `• ID: ${sellOrder.orderId}\n` +
      `• Giá: ${sellOrder.price}\n` +
      `• SL: ${sellOrder.origQty}`
    );

  } catch (e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error('❌ mainCycle error:', msg);
    await sendTelegramMessage(`❌ Lỗi: ${msg}`);
  }
}

// ====== Khởi động ======
async function botLoop() {
  await mainCycle();
}

(async () => {
  await loadSymbolFilters();
  console.log('🚀 Bot PAXG bắt đầu chạy…');
  await sendTelegramMessage('🚀 Bot PAXG đã khởi động và sẵn sàng giao dịch');
  setInterval(botLoop, INTERVAL);
})();

// ====== HTTP server & keepalive ======
app.get('/health', (_, r) => r.json({ status: 'ok' }));
app.get('/',    (_, r) => r.send('Bot PAXG đang chạy…'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server tại port ${PORT}`));

if (KEEPALIVE_URL) {
  setInterval(() => {
    axios.get(KEEPALIVE_URL).catch(() => {/* ignore */});
  }, 14 * 60 * 1000);
}
