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
const KEEPALIVE_URL   = process.env.KEEPALIVE_URL || 'https://bn-5l7b.onrender.com/health';
const BUY_UNDER_USD   = 5;   // đặt mua ở giá thị trường - 5
const SELL_OVER_USD   = 10;  // đặt bán ở giá mua + 10

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

// ====== Filters & Helpers ======
let filters = { tickSize:0, stepSize:0, minNotional:0, minQty:0, minPrice:0, maxPrice:Infinity, maxQty:Infinity };

function toNumber(x) { return typeof x==='number' ? x : Number(x); }
function decimalPlaces(s) { return String(s).includes('.') ? String(s).split('.')[1].replace(/0+$/,'').length : 0; }
function floorToStep(v, step) { v=toNumber(v); step=toNumber(step); return step===0?v:Math.floor(v/step)*step; }
function roundToTick(v, tick) { v=toNumber(v); tick=toNumber(tick); return tick===0?v:Math.floor(v/tick)*tick; }
function ceilToTick(v, tick)  { v=toNumber(v); tick=toNumber(tick); return tick===0?v:Math.ceil(v/tick)*tick; }
function formatByTick(v, tick){ return toNumber(v).toFixed(Math.max(decimalPlaces(tick),0)); }
function formatByStep(v, step){ return toNumber(v).toFixed(Math.max(decimalPlaces(step),0)); }
function ensureNotional(p, q, minN){ return toNumber(p)*toNumber(q) >= toNumber(minN); }

// ====== Load symbol filters ======
async function loadSymbolFilters() {
  const { data } = await BINANCE.get('/api/v3/exchangeInfo', { params:{symbol:SYMBOL} });
  const sym = data.symbols?.[0]; if (!sym) throw new Error('Không tìm thấy symbol');
  const pf = sym.filters.find(f=>f.filterType==='PRICE_FILTER');
  const ls = sym.filters.find(f=>f.filterType==='LOT_SIZE');
  const mn = sym.filters.find(f=>f.filterType==='MIN_NOTIONAL')||sym.filters.find(f=>f.filterType==='NOTIONAL');
  filters.tickSize    = toNumber(pf?.tickSize||0);
  filters.minPrice    = toNumber(pf?.minPrice||0);
  filters.maxPrice    = toNumber(pf?.maxPrice||Infinity);
  filters.stepSize    = toNumber(ls?.stepSize||0);
  filters.minQty      = toNumber(ls?.minQty||0);
  filters.maxQty      = toNumber(ls?.maxQty||Infinity);
  filters.minNotional = toNumber(mn?.minNotional||mn?.notional||0);
}

// ====== Binance helper APIs ======
async function getBalances() {
  const acc = await binanceGET('/api/v3/account');
  const findFree = a => toNumber(acc.balances.find(b=>b.asset===a)?.free||0);
  return { usdtFree:findFree(QUOTE), baseFree:findFree(BASE) };
}
async function getCurrentPrice() {
  const { data } = await BINANCE.get('/api/v3/ticker/price',{params:{symbol:SYMBOL}});
  return toNumber(data.price);
}
async function getOpenOrders() {
  return await binanceGET('/api/v3/openOrders',{ symbol:SYMBOL });
}
async function getOrder(orderId) {
  return await binanceGET('/api/v3/order',{ symbol:SYMBOL, orderId });
}
async function placeLimit(side, price, qty) {
  const pAdj = formatByTick(price, filters.tickSize);
  const qAdj = formatByStep(qty,    filters.stepSize);
  if (toNumber(pAdj)<filters.minPrice||toNumber(pAdj)>filters.maxPrice)
    throw new Error(`Giá ${pAdj} ngoài [${filters.minPrice},${filters.maxPrice}]`);
  if (toNumber(qAdj)<filters.minQty||toNumber(qAdj)>filters.maxQty)
    throw new Error(`Qty ${qAdj} ngoài [${filters.minQty},${filters.maxQty}]`);
  if (!ensureNotional(pAdj,qAdj,filters.minNotional))
    throw new Error(`Notional ${(pAdj*qAdj)} < ${filters.minNotional}`);
  return await binancePOST('/api/v3/order', {
    symbol:SYMBOL, side, type:'LIMIT', timeInForce:'GTC',
    price:pAdj, quantity:qAdj, newOrderRespType:'RESULT'
  });
}
async function waitFilled(orderId, timeout=300000, interval=3000) {
  const start = Date.now();
  while (Date.now()-start < timeout) {
    const o = await getOrder(orderId);
    if (o.status==='FILLED') return o;
    if (['CANCELED','REJECTED','EXPIRED'].includes(o.status))
      throw new Error(`Order ${orderId} kết thúc: ${o.status}`);
    await new Promise(r=>setTimeout(r,interval));
  }
  throw new Error(`Đợi order ${orderId} FILLED quá giờ`);
}

// ====== Logic chính ======
async function mainCycle() {
  try {
    if (!filters.tickSize) await loadSymbolFilters();

    const [price, {usdtFree}, openOrders] = await Promise.all([
      getCurrentPrice(),
      getBalances(),
      getOpenOrders()
    ]);

    // 1. Nếu có lệnh SELL chờ → thông báo
    const sellPending = openOrders.find(o=>o.side==='SELL'&&o.status==='NEW');
    if (sellPending) {
      return sendTelegramMessage(
        `📊 ${SYMBOL}\n` +
        `• Giá thị trường : ${price}\n` +
        `• USDT khả dụng : ${usdtFree}\n` +
        `• SELL chờ : ID=${sellPending.orderId} | Giá=${sellPending.price} | SL=${sellPending.origQty}`
      );
    }

    // 2. Không có SELL, nếu USDT > BUY_AMOUNT_USD → đặt BUY
    if (usdtFree <= BUY_AMOUNT_USD) {
      // Kiểm tra lệnh BUY đang chờ
      const buyPending = openOrders.find(o => o.side === 'BUY' && o.status === 'NEW');
      if (buyPending) {
        return sendTelegramMessage(
          `📊 ${SYMBOL}\n` +
          `• Giá thị trường : ${price}\n` +
          `• USDT khả dụng : ${usdtFree}\n` +
          `• BUY chờ : ID=${buyPending.orderId} | Giá=${buyPending.price} | SL=${buyPending.origQty}`
        );
      }
    
      // Không có BUY chờ
      return sendTelegramMessage(
        `ℹ️ ${SYMBOL}\n` +
        `• Không có SELL chờ\n` +
        `• USDT (${usdtFree}) không đủ > ${BUY_AMOUNT_USD}`
      );
    }

    // Tính giá và SL BUY
    let rawBuy = Math.max(price - BUY_UNDER_USD, filters.minPrice);
    const buyPrice = roundToTick(rawBuy, filters.tickSize);
    let buyQty = floorToStep(BUY_AMOUNT_USD / buyPrice, filters.stepSize);

    if (buyQty < filters.minQty) buyQty = filters.minQty;
    if (!ensureNotional(buyPrice, buyQty, filters.minNotional))
      throw new Error('Không thể đạt minNotional khi BUY');

    const buyOrder = await placeLimit('BUY', buyPrice, buyQty);
    await sendTelegramMessage(
      `🟩 ĐẶT BUY ${SYMBOL}\n` +
      `• ID: ${buyOrder.orderId}\n` +
      `• Giá: ${buyOrder.price}\n` +
      `• SL: ${buyOrder.origQty}`
    );

    // Đợi BUY FILLED
    const filled = await waitFilled(buyOrder.orderId);
    const executedQty = toNumber(filled.executedQty || 0);
    const cumQuote    = toNumber(filled.cummulativeQuoteQty || 0);
    // Nếu không có executedQty, avgBuyPrice sẽ null
    const avgBuyPrice = executedQty > 0
      ? (cumQuote / executedQty)
      : null;

    await sendTelegramMessage(
      `✅ BUY FILLED ${SYMBOL}\n` +
      `• ID: ${filled.orderId}\n` +
      `• SL khớp : ${executedQty}\n` +
      `• Giá TB   : ${avgBuyPrice ?? 'null'}`
    );

    // 3. Đặt SELL: base = avgBuyPrice || price
    const baseSell = avgBuyPrice ?? price;
    let rawSell = Math.min(Math.max(baseSell + SELL_OVER_USD, filters.minPrice), filters.maxPrice);
    const sellPrice = formatByTick(ceilToTick(rawSell, filters.tickSize), filters.tickSize);
    const sellQty   = floorToStep(executedQty, filters.stepSize);

    if (sellQty < filters.minQty || !ensureNotional(sellPrice, sellQty, filters.minNotional)) {
      return sendTelegramMessage(`⚠️ Bỏ qua đặt SELL: mất điều kiện qty/minNotional`);
    }

    const sellOrder = await placeLimit('SELL', sellPrice, sellQty);
    await sendTelegramMessage(
      `🟥 ĐẶT SELL ${SYMBOL}\n` +
      `• ID: ${sellOrder.orderId}\n` +
      `• Giá: ${sellOrder.price}\n` +
      `• SL : ${sellOrder.origQty}`
    );

  } catch (err) {
    const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('❌ mainCycle lỗi:', msg);
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
    axios.get(KEEPALIVE_URL).catch(()=>{/* ignore */});
  }, 14 * 60 * 1000);
}
