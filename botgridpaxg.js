// botpaxg-grid.js
'use strict';

const express = require('express');
const axios = require('axios').default;
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ====== Cấu hình người dùng ======
const SYMBOL          = process.env.SYMBOL || 'PAXGUSDT';
const QUOTE           = process.env.QUOTE  || 'USDT';
const BASE            = process.env.BASE   || 'PAXG';

const BUY_AMOUNT_USD  = Number(process.env.BUY_AMOUNT_USD || 40);
const INTERVAL        = Number(process.env.INTERVAL_MS || 30_000);
const KEEPALIVE_URL   = process.env.KEEPALIVE_URL || 'https://bn-5l7b.onrender.com/health';

// Grid config: ưu tiên GRID_MIN/MAX/NODES; nếu thiếu thì dùng GRID_STEP_USD = 10
const GRID_MIN        = process.env.GRID_MIN ? Number(process.env.GRID_MIN) : null;
const GRID_MAX        = process.env.GRID_MAX ? Number(process.env.GRID_MAX) : null;
const GRID_NODES      = process.env.GRID_NODES ? Number(process.env.GRID_NODES) : null;
const GRID_STEP_USD   = Number(process.env.GRID_STEP_USD || 10);

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

// ====== Retry helper ======
async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
async function retry(fn, { retries = 3, delay = 500, backoff = 2 } = {}) {
  let attempt = 0, lastErr;
  while (attempt < retries) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      attempt++;
      if (attempt >= retries) break;
      const d = delay * Math.pow(backoff, attempt - 1);
      await wait(d);
    }
  }
  throw lastErr;
}

// ====== Signing & basic helpers ======
function signQuery(paramsObj) {
  const qs = new URLSearchParams(paramsObj).toString();
  const signature = crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex');
  return `${qs}&signature=${signature}`;
}
async function binanceGET(path, params = {}) {
  return await retry(async () => {
    const query = signQuery({ ...params, timestamp: Date.now(), recvWindow: 5000 });
    const { data } = await BINANCE.get(`${path}?${query}`);
    return data;
  });
}
async function binancePOST(path, params = {}) {
  return await retry(async () => {
    const query = signQuery({ ...params, timestamp: Date.now(), recvWindow: 5000 });
    const { data } = await BINANCE.post(`${path}?${query}`);
    return data;
  });
}

// ====== Filters & Helpers ======
let filters = {
  tickSize: 0, stepSize: 0, minNotional: 0, minQty: 0,
  minPrice: 0, maxPrice: Infinity, maxQty: Infinity
};

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

// ====== Binance helper APIs (gom request mỗi vòng) ======
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

// ====== Grid state ======
// Trạng thái tối giản theo nốt hiện tại (một workflow tại một thời điểm)
let grid = {
  min: null,
  max: null,
  nodes: null,        // số nốt (intervals)
  levels: [],         // danh sách mốc giá [p0, p1, ..., pn]
};

let state = {
  currentNode: null,      // index interval i: [levels[i], levels[i+1]]
  mode: 'IDLE',           // 'IDLE' | 'BUY_PLACED' | 'HOLDING' | 'SELL_PLACED'
  buyOrderId: null,
  sellOrderId: null,
  lastBuyQty: 0,
  lastBuyAvg: null
};

// Khởi tạo grid: ưu tiên GRID_MIN/MAX/NODES; nếu thiếu sẽ tạo grid động theo GRID_STEP_USD quanh giá hiện tại
async function ensureGrid(price) {
  if (grid.levels.length) return;

  if (GRID_MIN != null && GRID_MAX != null && GRID_NODES != null && GRID_MAX > GRID_MIN && GRID_NODES > 0) {
    grid.min   = GRID_MIN;
    grid.max   = GRID_MAX;
    grid.nodes = GRID_NODES;
  } else {
    // grid động: tạo 40 bậc (~20 dưới, 20 trên) với step = GRID_STEP_USD
    const stepsEachSide = 20;
    const low  = Math.max(filters.minPrice, price - stepsEachSide * GRID_STEP_USD);
    const high = Math.min(filters.maxPrice, price + stepsEachSide * GRID_STEP_USD);
    grid.min   = roundToTick(low,  filters.tickSize);
    grid.max   = roundToTick(high, filters.tickSize);
    grid.nodes = Math.max(1, Math.floor((grid.max - grid.min) / GRID_STEP_USD));
  }

  // Tạo levels
  const width = (grid.max - grid.min) / grid.nodes;
  grid.levels = Array.from({length: grid.nodes + 1}, (_, i) => formatByTick(grid.min + i * width, filters.tickSize)).map(Number);

  await sendTelegramMessage(
    `🧱 Khởi tạo Grid\n` +
    `• Min: ${grid.min}\n` +
    `• Max: ${grid.max}\n` +
    `• Nốt: ${grid.nodes}\n` +
    `• Bước ~: ${((grid.max-grid.min)/grid.nodes).toFixed(4)}`
  );
}

function findNodeIndex(price) {
  const lv = grid.levels;
  if (!lv.length) return null;
  if (price < lv[0] || price > lv[lv.length-1]) return null;
  // tìm i sao cho price thuộc [lv[i], lv[i+1]]
  for (let i = 0; i < lv.length - 1; i++) {
    if (price >= lv[i] && price <= lv[i+1]) return i;
  }
  return null;
}

// ====== Main cycle ======
async function mainCycle() {
  try {
    if (!filters.tickSize) await loadSymbolFilters();

    // Gom API: giá, số dư, openOrders
    const [price, balances, openOrders] = await Promise.all([
      retry(() => getCurrentPrice(), {retries: 3, delay: 400}),
      retry(() => getBalances(),     {retries: 3, delay: 400}),
      retry(() => getOpenOrders(),   {retries: 3, delay: 400}),
    ]);

    await ensureGrid(price);

    // Xác định nốt hiện tại
    const idx = findNodeIndex(price);
    if (idx === null) {
      // Giá ngoài grid
      await sendTelegramMessage(
        `📛 ${SYMBOL}\n` +
        `• Giá hiện tại: ${price}\n` +
        `• Trạng thái: Ngoài dải Grid [${grid.min}, ${grid.max}]`
      );
      return;
    }

    state.currentNode = idx;
    const nodeMin = grid.levels[idx];
    const nodeMax = grid.levels[idx + 1];

    // Đồng bộ trạng thái dựa vào lệnh mở hiện có (để tránh trùng lệnh)
    const buyPending  = openOrders.find(o => o.side==='BUY'  && Number(o.price)===Number(formatByTick(nodeMin, filters.tickSize)));
    const sellPending = openOrders.find(o => o.side==='SELL' && Number(o.price)===Number(formatByTick(nodeMax, filters.tickSize)));

    if (buyPending) {
      state.mode = 'BUY_PLACED';
      state.buyOrderId = buyPending.orderId;
    } else if (sellPending) {
      state.mode = 'SELL_PLACED';
      state.sellOrderId = sellPending.orderId;
    } else if (state.mode === 'BUY_PLACED' || state.mode === 'SELL_PLACED') {
      // Không còn lệnh pending -> chuyển sang IDLE nếu chưa giữ hàng
      if (state.mode === 'SELL_PLACED') {
        // có thể vừa khớp SELL -> về IDLE
        state.mode = 'IDLE';
        state.lastBuyQty = 0;
        state.lastBuyAvg = null;
      } else {
        state.mode = 'IDLE';
      }
      state.buyOrderId = null;
      state.sellOrderId = null;
    }

    // Hành vi theo mode
    if (state.mode === 'IDLE') {
      // Chưa mua -> kiểm tra USDT và đặt BUY tại min nốt
      if (balances.usdtFree <= BUY_AMOUNT_USD) {
        await sendTelegramMessage(
          `ℹ️ ${SYMBOL}\n` +
          `• Giá: ${price}\n` +
          `• Nốt: [${nodeMin}, ${nodeMax}]\n` +
          `• USDT (${balances.usdtFree}) không đủ > ${BUY_AMOUNT_USD} để đặt BUY`
        );
        return;
      }

      const buyPrice = roundToTick(nodeMin, filters.tickSize);
      let buyQty = floorToStep(BUY_AMOUNT_USD / buyPrice, filters.stepSize);
      if (buyQty < filters.minQty) buyQty = filters.minQty;
      if (!ensureNotional(buyPrice, buyQty, filters.minNotional)) {
        await sendTelegramMessage(
          `⚠️ Bỏ qua BUY: Notional không đạt minNotional\n` +
          `• Giá: ${buyPrice}\n` +
          `• SL: ${buyQty}\n` +
          `• minNotional: ${filters.minNotional}`
        );
        return;
      }

      const buyOrder = await placeLimit('BUY', buyPrice, buyQty);
      state.mode = 'BUY_PLACED';
      state.buyOrderId = buyOrder.orderId;

      await sendTelegramMessage(
        `🟩 ĐẶT BUY ${SYMBOL}\n` +
        `• Nốt: [${nodeMin}, ${nodeMax}]\n` +
        `• ID: ${buyOrder.orderId}\n` +
        `• Giá: ${buyOrder.price}\n` +
        `• SL: ${buyOrder.origQty}`
      );
      return;
    }

    if (state.mode === 'BUY_PLACED' && state.buyOrderId) {
      // Kiểm tra khớp BUY
      const o = await retry(() => getOrder(state.buyOrderId), {retries: 3, delay: 400});
      if (o.status === 'FILLED') {
        const executedQty = toNumber(o.executedQty || 0);
        const cumQuote    = toNumber(o.cummulativeQuoteQty || 0);
        const avgBuyPrice = executedQty > 0 ? (cumQuote / executedQty) : null;

        state.lastBuyQty = executedQty;
        state.lastBuyAvg = avgBuyPrice;
        state.mode = 'HOLDING';

        await sendTelegramMessage(
          `✅ BUY FILLED ${SYMBOL}\n` +
          `• Nốt: [${nodeMin}, ${nodeMax}]\n` +
          `• ID: ${o.orderId}\n` +
          `• SL khớp: ${executedQty}\n` +
          `• Giá TB: ${avgBuyPrice ?? 'null'}`
        );
      } else if (['CANCELED','REJECTED','EXPIRED'].includes(o.status)) {
        state.mode = 'IDLE';
        state.buyOrderId = null;
        await sendTelegramMessage(`⚠️ BUY kết thúc ${o.status}, chuyển về IDLE`);
      } else {
        // vẫn chờ
        await sendTelegramMessage(
          `⏳ BUY đang chờ\n` +
          `• ID: ${o.orderId}\n` +
          `• Trạng thái: ${o.status}\n` +
          `• Giá hiện tại: ${price}`
        );
      }
      return;
    }

    if (state.mode === 'HOLDING') {
      // Sau khi BUY khớp -> đặt SELL ở max nốt
      const sellPrice = formatByTick(ceilToTick(nodeMax, filters.tickSize), filters.tickSize);
      const sellQty   = floorToStep(state.lastBuyQty, filters.stepSize);

      if (sellQty < filters.minQty || !ensureNotional(sellPrice, sellQty, filters.minNotional)) {
        await sendTelegramMessage(`⚠️ Bỏ qua SELL: Không đạt qty/minNotional`);
        return;
      }

      const sellOrder = await placeLimit('SELL', sellPrice, sellQty);
      state.mode = 'SELL_PLACED';
      state.sellOrderId = sellOrder.orderId;

      await sendTelegramMessage(
        `🟥 ĐẶT SELL ${SYMBOL}\n` +
        `• Nốt: [${nodeMin}, ${nodeMax}]\n` +
        `• ID: ${sellOrder.orderId}\n` +
        `• Giá: ${sellOrder.price}\n` +
        `• SL: ${sellOrder.origQty}`
      );
      return;
    }

    if (state.mode === 'SELL_PLACED' && state.sellOrderId) {
      // Kiểm tra khớp SELL
      const o = await retry(() => getOrder(state.sellOrderId), {retries: 3, delay: 400});
      if (o.status === 'FILLED') {
        state.mode = 'IDLE';
        state.sellOrderId = null;
        state.buyOrderId  = null;
        state.lastBuyQty  = 0;
        state.lastBuyAvg  = null;

        await sendTelegramMessage(
          `🎉 SELL FILLED ${SYMBOL}\n` +
          `• Nốt: [${nodeMin}, ${nodeMax}]\n` +
          `• ID: ${o.orderId}\n` +
          `• SL khớp: ${o.executedQty}\n` +
          `• Giá TB: ${toNumber(o.cummulativeQuoteQty)/toNumber(o.executedQty)}`
        );

        // Sau SELL khớp -> vòng sau sẽ IDLE và kiểm tra lại nốt để đặt BUY
      } else if (['CANCELED','REJECTED','EXPIRED'].includes(o.status)) {
        state.mode = 'HOLDING'; // vẫn còn giữ coin?
        state.sellOrderId = null;
        await sendTelegramMessage(`⚠️ SELL kết thúc ${o.status}, quay lại trạng thái HOLDING`);
      } else {
        await sendTelegramMessage(
          `⏳ SELL đang chờ\n` +
          `• ID: ${o.orderId}\n` +
          `• Trạng thái: ${o.status}\n` +
          `• Giá hiện tại: ${price}`
        );
      }
      return;
    }

  } catch (err) {
    const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('❌ mainCycle lỗi:', msg);
    await sendTelegramMessage(`❌ Lỗi: ${msg}`);
  }
}

// ====== Khởi động & vòng lặp ======
async function botLoop() {
  await mainCycle();
}

(async () => {
  await loadSymbolFilters();
  console.log('🚀 Bot PAXG Grid bắt đầu chạy…');
  await sendTelegramMessage('🚀 Bot PAXG Grid đã khởi động và sẵn sàng giao dịch');

  setInterval(botLoop, INTERVAL);
})();

// ====== HTTP server & keepalive ======
app.get('/health', (_, r) => r.json({ status: 'ok' }));
app.get('/',    (_, r) => r.send('Bot PAXG Grid đang chạy…'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server tại port ${PORT}`));

// keepalive
if (KEEPALIVE_URL) {
  setInterval(() => {
    axios.get(KEEPALIVE_URL).catch(()=>{/* ignore */});
  }, 14 * 60 * 1000);
}

// ====== Graceful shutdown ======
async function shutdown(sig) {
  try {
    await sendTelegramMessage(`🛑 Bot dừng (${sig}) — đang thoát an toàn`);
  } catch (_) {}
  process.exit(0);
}
['SIGINT','SIGTERM'].forEach(sig => process.on(sig, () => shutdown(sig)));
