/**
 * botpaxg-grid.js
 * Grid trading bot for PAXG/USDT
 *
 * Yêu cầu ENV:
 * - API_KEY, API_SECRET
 * - TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * - SYMBOL=PAXGUSDT (mặc định)
 * - BUY_AMOUNT_USD=40
 * - GRID_MIN, GRID_MAX, GRID_NODES
 * - SELL_OFFSET=1 (giảm từ giá max nốt theo đơn vị giá trước khi làm tròn tick)
 * - KEEPALIVE_URL (tùy chọn) để ping tránh ngủ trên Render
 *
 * Node >= 18
 */

import axios from 'axios';
import crypto from 'crypto';

// ===== Config =====
const API_KEY    = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const BINANCE_API = process.env.BINANCE_API || 'https://api.binance.com';

const SYMBOL = process.env.SYMBOL || 'PAXGUSDT';
const BASE   = SYMBOL.replace('USDT', ''); // PAXG
const QUOTE  = 'USDT';

const BUY_AMOUNT_USD = Number(process.env.BUY_AMOUNT_USD || 40);

// Grid params
const GRID_MIN   = Number(process.env.GRID_MIN);
const GRID_MAX   = Number(process.env.GRID_MAX);
const GRID_NODES = Number(process.env.GRID_NODES);
const SELL_OFFSET = Number(process.env.SELL_OFFSET || 1); // trừ 1 USD khỏi max nốt trước khi làm tròn tick

// Telegram
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID || '';

// Keep alive
const KEEPALIVE_URL = process.env.KEEPALIVE_URL || 'https://bn-5l7b.onrender.com/health';
const LOOP_INTERVAL_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 14 * 60_000;

// ===== State =====
const grid = { levels: [], min: null, max: null, nodes: 0 };
const filters = { tickSize: null, stepSize: null, minQty: 0, minNotional: 0, minPrice: 0, maxPrice: Number.MAX_SAFE_INTEGER };

let prevOpenOrderIds = new Set(); // track vòng trước để phát hiện lệnh biến mất (có thể FILLED/ CANCELED)
let lastRunAt = 0;

// ===== Utils =====
const now = () => Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const toNumber = (x) => Number(x || 0);

function signParams(params) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

async function binancePublic(path, params = {}) {
  const url = `${BINANCE_API}${path}`;
  const res = await axios.get(url, { params, timeout: 10_000 });
  return res.data;
}

async function binancePrivateGET(path, params = {}) {
  const url = `${BINANCE_API}${path}`;
  const timestamp = now();
  const query = signParams({ ...params, timestamp });
  const res = await axios.get(`${url}?${query}`, {
    headers: { 'X-MBX-APIKEY': API_KEY },
    timeout: 10_000
  });
  return res.data;
}

async function binancePrivatePOST(path, body = {}) {
  const url = `${BINANCE_API}${path}`;
  const timestamp = now();
  const query = signParams({ ...body, timestamp });
  const res = await axios.post(`${url}?${query}`, null, {
    headers: { 'X-MBX-APIKEY': API_KEY },
    timeout: 10_000
  });
  return res.data;
}

async function retry(fn, { retries = 3, delay = 400 } = {}) {
  let attempt = 0, lastErr;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      await sleep(delay * (1 + attempt));
    }
    attempt++;
  }
  throw lastErr;
}

// ===== Telegram =====
async function sendTelegramMessage(text) {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, { timeout: 10_000 });
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

// ===== Formatting helpers =====
function roundToTick(price, tick) {
  const p = Math.round(price / tick) * tick;
  return Number(p.toFixed(10));
}
function floorToTick(price, tick) {
  const p = Math.floor(price / tick) * tick;
  return Number(p.toFixed(10));
}
function ceilToTick(price, tick) {
  const p = Math.ceil(price / tick) * tick;
  return Number(p.toFixed(10));
}
function floorToStep(qty, step) {
  const q = Math.floor(qty / step) * step;
  return Number(q.toFixed(10));
}

function ensureNotional(price, qty, minNotional) {
  return price * qty >= minNotional;
}

// ===== Binance abstractions =====
async function loadSymbolFilters() {
  const data = await retry(() => binancePublic('/api/v3/exchangeInfo', { symbol: SYMBOL }), { retries: 3, delay: 500 });
  const symbolInfo = data.symbols[0];
  const lotFilter  = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
  const priceFilter= symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
  const notional   = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');

  filters.stepSize = toNumber(lotFilter.stepSize);
  filters.minQty   = toNumber(lotFilter.minQty);
  filters.tickSize = toNumber(priceFilter.tickSize);
  filters.minPrice = toNumber(priceFilter.minPrice);
  filters.maxPrice = toNumber(priceFilter.maxPrice || Number.MAX_SAFE_INTEGER);
  filters.minNotional = toNumber(notional.minNotional);

  await sendTelegramMessage(
    `⚙️ Filters loaded for ${SYMBOL}\n` +
    `• tickSize: ${filters.tickSize}\n` +
    `• stepSize: ${filters.stepSize}\n` +
    `• minQty: ${filters.minQty}\n` +
    `• minNotional: ${filters.minNotional}`
  );
}

async function getCurrentPrice() {
  const t = await binancePublic('/api/v3/ticker/price', { symbol: SYMBOL });
  return toNumber(t.price);
}

async function getBalances() {
  const acct = await binancePrivateGET('/api/v3/account');
  const usdt = acct.balances.find(b => b.asset === QUOTE);
  const base = acct.balances.find(b => b.asset === BASE);
  return {
    usdtFree: toNumber(usdt?.free || 0),
    baseFree: toNumber(base?.free || 0),
  };
}

async function getOpenOrders() {
  const orders = await binancePrivateGET('/api/v3/openOrders', { symbol: SYMBOL });
  return orders.map(o => ({
    orderId: o.orderId,
    side: o.side, // BUY/SELL
    price: toNumber(o.price),
    origQty: toNumber(o.origQty),
    executedQty: toNumber(o.executedQty),
    status: o.status,
    updateTime: o.updateTime,
  }));
}

async function getOrder(orderId) {
  const o = await binancePrivateGET('/api/v3/order', { symbol: SYMBOL, orderId });
  return {
    orderId: o.orderId,
    side: o.side,
    price: toNumber(o.price),
    origQty: toNumber(o.origQty),
    executedQty: toNumber(o.executedQty),
    status: o.status,
    cummulativeQuoteQty: toNumber(o.cummulativeQuoteQty || 0),
    updateTime: o.updateTime,
  };
}

async function placeLimit(side, price, qty) {
  const params = {
    symbol: SYMBOL,
    side,
    type: 'LIMIT',
    timeInForce: 'GTC',
    price: String(price),
    quantity: String(qty),
    newClientOrderId: `${side}_${Date.now()}_${Math.floor(Math.random()*1e5)}`
  };
  const o = await binancePrivatePOST('/api/v3/order', params);
  return {
    orderId: o.orderId,
    side: o.side,
    price: toNumber(o.price),
    origQty: toNumber(o.origQty),
    status: o.status
  };
}

// ===== Grid =====
async function ensureGrid(currentPrice) {
  if (grid.levels.length) return;

  if (Number.isNaN(GRID_MIN) || Number.isNaN(GRID_MAX) || Number.isNaN(GRID_NODES) || GRID_NODES <= 0 || GRID_MAX <= GRID_MIN) {
    throw new Error('Thiếu hoặc sai GRID_MIN, GRID_MAX, GRID_NODES');
  }

  grid.min = roundToTick(GRID_MIN, filters.tickSize);
  grid.max = roundToTick(GRID_MAX, filters.tickSize);
  grid.nodes = GRID_NODES;

  // Chia đều khoảng [min, max] thành GRID_NODES nốt => levels dài GRID_NODES+1
  grid.levels = [];
  const span = grid.max - grid.min;
  const step = span / GRID_NODES;
  for (let i = 0; i <= GRID_NODES; i++) {
    const level = roundToTick(grid.min + i * step, filters.tickSize);
    grid.levels.push(level);
  }

  await sendTelegramMessage(
    `🧱 Khởi tạo Grid ${SYMBOL}\n` +
    `• Min: ${grid.min}, Max: ${grid.max}\n` +
    `• Số nốt: ${grid.nodes}\n` +
    `• Levels: ${grid.levels.join(', ')}`
  );
}

function findNodeIndexByPrice(p) {
  // Tìm index i sao cho levels[i] <= p < levels[i+1]
  for (let i = 0; i < grid.levels.length - 1; i++) {
    if (p >= grid.levels[i] && p < grid.levels[i + 1]) return i;
  }
  return null;
}

// ===== Core loop =====
async function mainCycle() {
  try {
    if (!filters.tickSize) await loadSymbolFilters();

    // Gom request
    const [price, balances, openOrders] = await Promise.all([
      retry(() => getCurrentPrice(), { retries: 2, delay: 300 }),
      retry(() => getBalances(),     { retries: 2, delay: 300 }),
      retry(() => getOpenOrders(),   { retries: 2, delay: 300 }),
    ]);

    await ensureGrid(price);

    const messages = [];

    // 1) Phát hiện lệnh biến mất khỏi danh sách openOrders vòng trước
    const currentIds = new Set(openOrders.map(o => o.orderId));
    const disappeared = [...prevOpenOrderIds].filter(id => !currentIds.has(id));

    // Chỉ truy vấn chi tiết các lệnh biến mất (tối ưu số request)
    for (const id of disappeared) {
      try {
        const o = await retry(() => getOrder(id), { retries: 2, delay: 300 });
        if (o.status === 'FILLED') {
          const side = o.side;
          const avgPrice = o.executedQty > 0 ? (o.cummulativeQuoteQty / o.executedQty) : o.price;

          if (side === 'BUY') {
            // Đặt SELL ngay sau khi BUY khớp
            const idx = findNodeIndexByPrice(avgPrice) ?? findNodeIndexByPrice(o.price);
            if (idx !== null) {
              const nodeMin = grid.levels[idx];
              const nodeMax = grid.levels[idx + 1];
              const rawSell = nodeMax - SELL_OFFSET;
              const sellPrice = floorToTick(rawSell, filters.tickSize);
              const sellQty   = floorToStep(o.executedQty, filters.stepSize);

              if (ensureNotional(sellPrice, sellQty, filters.minNotional) && sellQty >= filters.minQty) {
                const so = await placeLimit('SELL', sellPrice, sellQty);
                messages.push(
                  `🎉 BUY FILLED → TẠO SELL\n` +
                  `• BUY ID: ${o.orderId}\n` +
                  `• SL khớp BUY: ${o.executedQty}\n` +
                  `• Giá TB BUY  : ${avgPrice}\n` +
                  `• Nốt: [${nodeMin}, ${nodeMax}] → SELL @ ${sellPrice}\n` +
                  `• SELL ID: ${so.orderId}, SL: ${so.origQty}`
                );
              } else {
                messages.push(
                  `⚠️ BUY FILLED nhưng không thể đặt SELL (notional/qty không đủ)\n` +
                  `• SL: ${sellQty}, Giá: ${sellPrice}`
                );
              }
            } else {
              messages.push(
                `⚠️ BUY FILLED nhưng không xác định được nốt: Giá ${avgPrice}`
              );
            }
          } else if (side === 'SELL') {
            messages.push(
              `🎉 SELL FILLED\n` +
              `• SELL ID: ${o.orderId}\n` +
              `• SL khớp: ${o.executedQty}\n` +
              `• Giá TB: ${avgPrice}`
            );
          }
        }
      } catch (e) {
        // Có thể lệnh bị CANCELED hoặc API lỗi nhẹ
        messages.push(`ℹ️ Kiểm tra lệnh ID ${id} thất bại hoặc không FILLED: ${e.message}`);
      }
    }

    // 2) Duyệt từng nốt để đặt lệnh hoặc hiển thị hàng chờ
    for (let i = 0; i < grid.levels.length - 1; i++) {
      const nodeMin = grid.levels[i];
      const nodeMax = grid.levels[i + 1];

      const buyPrice  = roundToTick(nodeMin, filters.tickSize);
      const sellPrice = floorToTick(nodeMax - SELL_OFFSET, filters.tickSize);

      const buyPending  = openOrders.find(o => o.side === 'BUY'  && o.price === buyPrice);
      const sellPending = openOrders.find(o => o.side === 'SELL' && o.price === sellPrice);

      // Nếu đã có BUY chờ → thông báo
      if (buyPending) {
        messages.push(
          `⏳ BUY chờ [${nodeMin}, ${nodeMax}]\n` +
          `• ID: ${buyPending.orderId}\n` +
          `• Giá chờ: ${buyPending.price}\n` +
          `• SL: ${buyPending.origQty}\n` +
          `• Giá hiện tại: ${price}`
        );
      } else {
        // Chưa có BUY
        if (balances.usdtFree >= BUY_AMOUNT_USD) {
          let buyQty = floorToStep(BUY_AMOUNT_USD / buyPrice, filters.stepSize);
          if (buyQty < filters.minQty) buyQty = filters.minQty;

          if (ensureNotional(buyPrice, buyQty, filters.minNotional)) {
            const bo = await placeLimit('BUY', buyPrice, buyQty);
            messages.push(
              `🟩 ĐẶT BUY 40$ tại nốt [${nodeMin}, ${nodeMax}]\n` +
              `• Giá: ${bo.price}\n` +
              `• SL: ${bo.origQty}\n` +
              `• ID: ${bo.orderId}`
            );
            // Lưu ý: SELL sẽ được tạo ngay khi BUY khớp (xử lý ở bước 1)
          } else {
            messages.push(
              `⚠️ Không thể đặt BUY @ ${buyPrice} (notional/qty không đủ)`
            );
          }
        } else {
          // USDT < 40 → nếu có SELL chờ thì gửi thông tin chi tiết SELL
          if (sellPending) {
            messages.push(
              `💤 USDT < ${BUY_AMOUNT_USD}, hiển thị SELL chờ [${nodeMin}, ${nodeMax}]\n` +
              `• ID: ${sellPending.orderId}\n` +
              `• Giá chờ: ${sellPending.price}\n` +
              `• SL: ${sellPending.origQty}\n` +
              `• Giá hiện tại: ${price}`
            );
          }
        }
      }

      // Nếu có SELL chờ → thông báo
      if (sellPending) {
        messages.push(
          `⏳ SELL chờ [${nodeMin}, ${nodeMax}]\n` +
          `• ID: ${sellPending.orderId}\n` +
          `• Giá chờ: ${sellPending.price}\n` +
          `• SL: ${sellPending.origQty}\n` +
          `• Giá hiện tại: ${price}`
        );
      }
    }

    // 3) Gửi gộp thông điệp
    if (messages.length === 0) {
      messages.push(
        `ℹ️ ${SYMBOL}\n` +
        `• Không có hành động mới\n` +
        `• Giá hiện tại: ${price}`
      );
    }
    await sendTelegramMessage(messages.join('\n\n'));

    // Cập nhật prevOpenOrderIds cho lần sau
    prevOpenOrderIds = new Set(openOrders.map(o => o.orderId));
    lastRunAt = Date.now();

  } catch (err) {
    const msg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('❌ mainCycle lỗi:', msg);
    await sendTelegramMessage(`❌ mainCycle lỗi: ${msg}`);
  }
}

// ===== Runner & KeepAlive =====
async function keepAlive() {
  if (!KEEPALIVE_URL) return;
  try {
    await axios.get(KEEPALIVE_URL, { timeout: 5_000 });
  } catch (e) {
    console.warn('KeepAlive failed:', e.message);
  }
}

async function start() {
  try {
    if (!API_KEY || !API_SECRET) throw new Error('Thiếu API_KEY/API_SECRET');
    if (!TG_TOKEN || !TG_CHAT)   console.warn('Thiếu TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID → không gửi Telegram');

    await loadSymbolFilters();

    // chạy ngay lần đầu
    await mainCycle();

    // loop mỗi 30s
    setInterval(mainCycle, LOOP_INTERVAL_MS);

    // keep alive
    if (KEEPALIVE_URL) {
      setInterval(keepAlive, KEEPALIVE_INTERVAL_MS);
      console.log('KeepAlive enabled');
    }

    console.log('Bot started');
  } catch (e) {
    console.error('Start error:', e.message);
    await sendTelegramMessage(`❌ Start error: ${e.message}`);
    process.exit(1);
  }
}

start();
