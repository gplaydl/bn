'use strict';

const express = require('express');
const axios = require('axios').default;
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ====== Chế độ chạy ======
// MODE=paper: mô phỏng (không khớp thật)
// MODE=binance_testnet: giao dịch thật trên Binance Testnet
const MODE = (process.env.MODE || 'paper').toLowerCase();
const IS_PAPER = MODE === 'paper';
const IS_TESTNET = MODE === 'binance_testnet';

if (!IS_PAPER && !IS_TESTNET) {
  console.error('MODE không hợp lệ. Chỉ hỗ trợ: paper, binance_testnet');
  process.exit(1);
}

// ====== Cấu hình người dùng ======
const SYMBOL          = 'PAXGUSDT';
const QUOTE           = 'USDT';
const BASE            = 'PAXG';
const BUY_AMOUNT_USD  = 80;         // giá trị mỗi lệnh mua
const INTERVAL_MS     = 30_000;     // chu kỳ lặp
const HTTP_PORT       = process.env.PORT || 3000;

// ====== Cấu hình Grid ======
// Ví dụ lưới 5 nốt, mỗi nốt rộng 10 USD, bắt đầu từ 1800
const GRID_COUNT      = 5;
const GRID_MIN_PRICE  = 1800;
const GRID_WIDTH      = 10;
const GRID_MAX_PRICE  = GRID_MIN_PRICE + GRID_COUNT * GRID_WIDTH;

// Tạo danh sách nốt
const gridNodes = Array.from({ length: GRID_COUNT }, (_, i) => {
  const minP = GRID_MIN_PRICE + i * GRID_WIDTH;
  return { index: i + 1, minPrice: minP, maxPrice: minP + GRID_WIDTH };
});

// ====== Telegram Bot ======
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID || '';

async function sendTelegramMessage(text) {
  console.log(text);
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('Lỗi gửi Telegram:', e.response?.data || e.message);
  }
}

// ====== Binance client ======
const API_KEY    = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

const BINANCE = IS_TESTNET
  ? axios.create({
      baseURL: 'https://testnet.binance.vision',
      timeout: 15_000,
      headers: { 'X-MBX-APIKEY': API_KEY },
    })
  : axios.create({
      baseURL: 'https://api.binance.com', // Không dùng khi paper
      timeout: 15_000,
      headers: { 'X-MBX-APIKEY': API_KEY },
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

// ====== Utils & filters ======
const toNum = (x) => (typeof x === 'number' ? x : Number(x));
const decPlaces = (s) =>
  String(s).includes('.') ? String(s).split('.')[1].replace(/0+$/, '').length : 0;

const floorToStep = (v, step) => {
  v = toNum(v);
  step = toNum(step);
  return step === 0 ? v : Math.floor(v / step) * step;
};

const floorToTick = (v, tick) => {
  v = toNum(v);
  tick = toNum(tick);
  return tick === 0 ? v : Math.floor(v / tick) * tick;
};

const ceilToTick = (v, tick) => {
  v = toNum(v);
  tick = toNum(tick);
  return tick === 0 ? v : Math.ceil(v / tick) * tick;
};

const fmtByTick = (v, tick) => toNum(v).toFixed(Math.max(decPlaces(tick), 0));
const fmtByStep = (v, step) => toNum(v).toFixed(Math.max(decPlaces(step), 0));
const ensureNotional = (p, q, minN) => toNum(p) * toNum(q) >= toNum(minN);

let filters = {
  tickSize: 0,
  stepSize: 0,
  minNotional: 0,
  minQty: 0,
  minPrice: 0,
  maxPrice: Infinity,
  maxQty: Infinity,
};

async function loadSymbolFilters() {
  if (IS_PAPER) {
    // Thiết lập giả lập hợp lý cho PAXGUSDT
    filters = {
      tickSize: 0.01,
      stepSize: 0.0001,
      minNotional: 10,
      minQty: 0.0001,
      minPrice: 1,
      maxPrice: 1_000_000,
      maxQty: 10_000,
    };
    return;
  }
  if (IS_TESTNET && (!API_KEY || !API_SECRET)) {
    throw new Error('Thiếu BINANCE_API_KEY/BINANCE_API_SECRET cho testnet');
  }
  const info = await BINANCE.get('/api/v3/exchangeInfo', { params: { symbol: SYMBOL } });
  const sym = info.data.symbols?.[0];
  if (!sym) throw new Error('Không tìm thấy symbol trên Binance');

  const pf = sym.filters.find((f) => f.filterType === 'PRICE_FILTER');
  const ls = sym.filters.find((f) => f.filterType === 'LOT_SIZE');
  const mn =
    sym.filters.find((f) => f.filterType === 'MIN_NOTIONAL') ||
    sym.filters.find((f) => f.filterType === 'NOTIONAL');

  filters.tickSize = toNum(pf?.tickSize || 0);
  filters.minPrice = toNum(pf?.minPrice || 0);
  filters.maxPrice = toNum(pf?.maxPrice || Infinity);
  filters.stepSize = toNum(ls?.stepSize || 0);
  filters.minQty = toNum(ls?.minQty || 0);
  filters.maxQty = toNum(ls?.maxQty || Infinity);
  filters.minNotional = toNum(mn?.minNotional || mn?.notional || 0);
}

// ====== Nguồn giá ======
async function getCurrentPrice() {
  if (IS_PAPER) {
    // Bạn có thể thay bằng nguồn giá live khác nếu muốn
    // Ở đây giả lập bằng cách "dao động nhẹ" quanh giữa lưới
    const center = (GRID_MIN_PRICE + GRID_MAX_PRICE) / 2;
    const drift = (Math.sin(Date.now() / 60_000) * GRID_WIDTH) / 2;
    return Number((center + drift).toFixed(2));
  }
  const { data } = await BINANCE.get('/api/v3/ticker/price', { params: { symbol: SYMBOL } });
  return toNum(data.price);
}

// ====== Sổ lệnh mô phỏng (paper mode) ======
const paperState = {
  usdtFree: 1_000_000,
  baseFree: 0,
  openOrders: [],
  nextOrderId: 1,
};

function paperBalances() {
  return { usdtFree: paperState.usdtFree, baseFree: paperState.baseFree };
}

function paperPlaceLimit(side, price, quantity) {
  const order = {
    orderId: paperState.nextOrderId++,
    symbol: SYMBOL,
    side,
    type: 'LIMIT',
    price: Number(price),
    origQty: Number(quantity),
    executedQty: 0,
    status: 'NEW',
    time: Date.now(),
  };
  paperState.openOrders.push(order);
  return order;
}

function paperMatch(price) {
  // Đơn giản: lệnh BUY khớp nếu price <= order.price; SELL khớp nếu price >= order.price
  for (const o of paperState.openOrders) {
    if (o.status !== 'NEW') continue;
    const canFill =
      (o.side === 'BUY' && price <= o.price) || (o.side === 'SELL' && price >= o.price);
    if (!canFill) continue;
    // Khớp toàn bộ
    o.status = 'FILLED';
    o.executedQty = o.origQty;
    if (o.side === 'BUY') {
      const cost = o.price * o.executedQty;
      paperState.usdtFree -= cost;
      paperState.baseFree += o.executedQty;
    } else {
      const proceeds = o.price * o.executedQty;
      paperState.baseFree -= o.executedQty;
      paperState.usdtFree += proceeds;
    }
  }
  // Dọn lệnh hoàn tất
  paperState.openOrders = paperState.openOrders.filter((o) => o.status === 'NEW');
}

async function getBalances() {
  if (IS_PAPER) return paperBalances();
  const acc = await binanceGET('/api/v3/account');
  const findFree = (a) => toNum(acc.balances.find((b) => b.asset === a)?.free || 0);
  return { usdtFree: findFree(QUOTE), baseFree: findFree(BASE) };
}

async function getOpenOrders() {
  if (IS_PAPER) return [...paperState.openOrders];
  return await binanceGET('/api/v3/openOrders', { symbol: SYMBOL });
}

async function placeLimit(side, price, qty) {
  const pAdj = fmtByTick(price, filters.tickSize);
  const qAdj = fmtByStep(qty, filters.stepSize);

  if (toNum(pAdj) < filters.minPrice || toNum(pAdj) > filters.maxPrice)
    throw new Error(`Giá ${pAdj} ngoài [${filters.minPrice}, ${filters.maxPrice}]`);
  if (toNum(qAdj) < filters.minQty || toNum(qAdj) > filters.maxQty)
    throw new Error(`Qty ${qAdj} ngoài [${filters.minQty}, ${filters.maxQty}]`);
  if (!ensureNotional(pAdj, qAdj, filters.minNotional))
    throw new Error(`Notional ${pAdj * qAdj} < ${filters.minNotional}`);

  if (IS_PAPER) {
    return paperPlaceLimit(side, Number(pAdj), Number(qAdj));
  }
  return await binancePOST('/api/v3/order', {
    symbol: SYMBOL,
    side,
    type: 'LIMIT',
    timeInForce: 'GTC',
    price: pAdj,
    quantity: qAdj,
    newOrderRespType: 'RESULT',
  });
}

async function getOrder(orderId) {
  if (IS_PAPER) {
    const o = paperState.openOrders.find((x) => x.orderId === orderId);
    if (!o) {
      // giả lập: coi như đã FILLED (vì đã bị dọn)
      return { orderId, status: 'FILLED', executedQty: 0, price: 0 };
    }
    return o;
  }
  return await binanceGET('/api/v3/order', { symbol: SYMBOL, orderId });
}

async function waitFilled(orderId, timeout = 300_000, interval = 2_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const o = await getOrder(orderId);
    if (o.status === 'FILLED') return o;
    if (['CANCELED', 'REJECTED', 'EXPIRED'].includes(o.status))
      throw new Error(`Order ${orderId} kết thúc: ${o.status}`);
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Đợi order ${orderId} FILLED quá giờ`);
}

// ====== Xác định nốt theo giá ======
function findGridNode(price) {
  return gridNodes.find((node) => price >= node.minPrice && price < node.maxPrice);
}

// ====== Logic chính ======
async function mainCycle() {
  try {
    // Load filters lần đầu
    if (!filters.tickSize) await loadSymbolFilters();

    // Giá hiện tại
    const price = await getCurrentPrice();

    // Với paper mode: thử khớp lệnh dựa trên giá hiện tại
    if (IS_PAPER) paperMatch(price);

    // Giá ngoài lưới
    if (price < GRID_MIN_PRICE || price > GRID_MAX_PRICE) {
      return sendTelegramMessage(`⚠️ Giá ${price} ngoài lưới [${GRID_MIN_PRICE} - ${GRID_MAX_PRICE}]`);
    }

    // Nốt hiện tại
    const node = findGridNode(price);
    if (!node) return sendTelegramMessage(`⚠️ Không tìm thấy nốt cho giá ${price}`);

    // Tránh chồng lệnh
    const openOrders = await getOpenOrders();
    if (openOrders.length > 0) {
      return sendTelegramMessage(`⏳ Đang có ${openOrders.length} lệnh mở, chờ xử lý xong`);
    }

    // Tính giá mua và khối lượng
    const buyPriceRaw = floorToTick(price - 1, filters.tickSize);
    const buyQtyRaw = Math.max(filters.minQty, BUY_AMOUNT_USD / buyPriceRaw);
    const buyQty = floorToStep(buyQtyRaw, filters.stepSize);

    if (!ensureNotional(buyPriceRaw, buyQty, filters.minNotional)) {
      return sendTelegramMessage(`⚠️ Notional không đủ: ${buyPriceRaw} * ${buyQty}`);
    }

    // Đặt lệnh mua
    const order = await placeLimit('BUY', buyPriceRaw, buyQty);
    await sendTelegramMessage(`✅ Đã đặt lệnh mua ${buyQty} ${BASE} @ ${buyPriceRaw} (nốt ${node.index})`);

    // Với paper mode: thử khớp sau khi đặt lệnh
    if (IS_PAPER) {
      paperMatch(price);
    }

    // Chờ khớp
    const filled = await waitFilled(order.orderId);
    await sendTelegramMessage(`🎯 Đã khớp lệnh mua ${filled.executedQty} ${BASE} @ ${filled.price || buyPriceRaw}`);

    // Đặt lệnh bán chốt lời đơn giản: +1 USD
    const sellPriceRaw = ceilToTick(price + 1, filters.tickSize);
    const sellQty = floorToStep(Number(filled.executedQty || buyQty), filters.stepSize);

    // Với paper mode, kiểm tra đủ BASE để bán
    if (IS_PAPER && paperState.baseFree < sellQty) {
      return sendTelegramMessage(`⚠️ Không đủ ${BASE} để đặt lệnh bán: cần ${sellQty}, có ${paperState.baseFree}`);
    }

    const sellOrder = await placeLimit('SELL', sellPriceRaw, sellQty);
    await sendTelegramMessage(`📤 Đã đặt lệnh bán ${sellQty} ${BASE} @ ${sellPriceRaw}`);

    // Paper: thử khớp với giá hiện tại ngay sau đặt
    if (IS_PAPER) {
      paperMatch(price);
    }
  } catch (e) {
    await sendTelegramMessage(`🚨 Lỗi: ${e.message}`);
  }
}

// ====== Keepalive endpoints ======
app.get('/health', (_req, res) => res.json({ ok: true, mode: MODE }));
app.get('/', (_req, res) => res.send('Bot PAXG Grid đang chạy'));

// ====== Khởi chạy ======
async function start() {
  console.log(`Khởi động bot ở MODE=${MODE}`);
  try {
    await loadSymbolFilters();
    console.log('Filters:', filters);
  } catch (e) {
    console.error('Lỗi load filters:', e.message);
  }

  setInterval(mainCycle, INTERVAL_MS);
  app.listen(HTTP_PORT, () => {
    console.log(`HTTP server listen on port ${HTTP_PORT}`);
  });
}

start();
