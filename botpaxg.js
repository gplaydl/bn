// botpaxg.js
const express = require('express');
const axios = require('axios').default;
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;

const SYMBOL = 'PAXGUSDT';
const QUOTE = 'USDT';
const BASE = 'PAXG';

const BUY_AMOUNT_USD = 80;
const INTERVAL = 30000; // 30s

let filters = {
  stepSize: null,
  tickSize: null,
  minNotional: null,
  qtyDecimals: 8,
  priceDecimals: 2,
};
let currentBuyOrder = null;
let currentSellOrder = null;
let lastBuyPrice = null;

// ------------- Binance low-level request -------------
async function binanceRequest(method, path, params = {}, isPrivate = false) {
  const baseURL = 'https://api.binance.com';
  const timestamp = Date.now();
  const query = new URLSearchParams(params);

  if (isPrivate) {
    query.append('timestamp', timestamp);
    // optional: recvWindow to reduce TIMESTAMP errors
    if (!query.has('recvWindow')) query.append('recvWindow', '5000');
    const signature = crypto
      .createHmac('sha256', API_SECRET)
      .update(query.toString())
      .digest('hex');
    query.append('signature', signature);
  }

  const headers = isPrivate ? { 'X-MBX-APIKEY': API_KEY } : {};
  const url = `${baseURL}${path}?${query.toString()}`;
  const res = await axios({ method, url, headers, timeout: 10000 });
  return res.data;
}

// ------------- Helpers -------------
function decimalsFromStep(step) {
  if (!step) return 8;
  const s = step.toString();
  if (!s.includes('.')) return 0;
  return s.length - s.indexOf('.') - 1;
}

function roundStepSize(qty, stepSize, qtyDecimals = 8) {
  const floored = Math.floor(qty / stepSize) * stepSize;
  return Number(floored.toFixed(qtyDecimals));
}

function roundTickSize(price, tickSize, priceDecimals = 2) {
  const floored = Math.floor(price / tickSize) * tickSize;
  return Number(floored.toFixed(priceDecimals));
}

function fmt(n, d = 8) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  return Number(n).toFixed(d);
}

// ------------- Exchange filters / precision -------------
async function loadFilters() {
  const info = await binanceRequest('GET', '/api/v3/exchangeInfo');
  const symbolInfo = info.symbols.find((s) => s.symbol === SYMBOL);
  if (!symbolInfo) throw new Error(`Không tìm thấy symbol ${SYMBOL} trong exchangeInfo`);

  const lotSize = symbolInfo.filters.find((f) => f.filterType === 'LOT_SIZE');
  const priceFilter = symbolInfo.filters.find((f) => f.filterType === 'PRICE_FILTER');
  const minNotional = symbolInfo.filters.find((f) => f.filterType === 'MIN_NOTIONAL');

  filters.stepSize = parseFloat(lotSize.stepSize);
  filters.tickSize = parseFloat(priceFilter.tickSize);
  filters.minNotional = parseFloat(minNotional.minNotional);
  filters.qtyDecimals = decimalsFromStep(lotSize.stepSize);
  filters.priceDecimals = decimalsFromStep(priceFilter.tickSize);

  console.log(`Filters loaded: stepSize=${filters.stepSize}, tickSize=${filters.tickSize}, minNotional=${filters.minNotional}`);
}

// ------------- Balances / price / orders -------------
async function getCurrentPrice() {
  const ticker = await binanceRequest('GET', '/api/v3/ticker/price', { symbol: SYMBOL });
  return parseFloat(ticker.price);
}

async function getBalances() {
  const acc = await binanceRequest('GET', '/api/v3/account', {}, true);
  const findAsset = (asset) => acc.balances.find((b) => b.asset === asset) || { free: '0', locked: '0' };
  const usdt = findAsset(QUOTE);
  const paxg = findAsset(BASE);
  return {
    usdtFree: parseFloat(usdt.free),
    usdtLocked: parseFloat(usdt.locked),
    paxgFree: parseFloat(paxg.free),
    paxgLocked: parseFloat(paxg.locked),
  };
}

async function checkOpenOrders() {
  const orders = await binanceRequest('GET', '/api/v3/openOrders', { symbol: SYMBOL }, true);
  currentBuyOrder = orders.find((o) => o.side === 'BUY') || null;
  currentSellOrder = orders.find((o) => o.side === 'SELL') || null;
}

async function getOrderStatus(orderId) {
  return binanceRequest('GET', '/api/v3/order', { symbol: SYMBOL, orderId }, true);
}

async function placeBuyOrder(limitPrice) {
  const qtyRaw = BUY_AMOUNT_USD / limitPrice;
  let qty = roundStepSize(qtyRaw, filters.stepSize, filters.qtyDecimals);

  // Đảm bảo đáp ứng minNotional
  if (limitPrice * qty < filters.minNotional) {
    const minQty = filters.minNotional / limitPrice;
    qty = roundStepSize(minQty, filters.stepSize, filters.qtyDecimals);
  }

  if (qty <= 0) {
    console.log('Không đủ số dư để đặt lệnh mua hợp lệ (qty <= 0).');
    return null;
  }

  const price = roundTickSize(limitPrice, filters.tickSize, filters.priceDecimals);

  const order = await binanceRequest(
    'POST',
    '/api/v3/order',
    {
      symbol: SYMBOL,
      side: 'BUY',
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: qty.toFixed(filters.qtyDecimals),
      price: price.toFixed(filters.priceDecimals),
    },
    true
  );

  console.log(`Đã đặt BUY: qty=${qty.toFixed(filters.qtyDecimals)} price=${price.toFixed(filters.priceDecimals)} orderId=${order.orderId}`);
  currentBuyOrder = order;
  return order;
}

async function placeSellOrder(limitPrice, qty) {
  const roundedQty = roundStepSize(qty, filters.stepSize, filters.qtyDecimals);
  const price = roundTickSize(limitPrice, filters.tickSize, filters.priceDecimals);

  if (roundedQty <= 0) {
    console.log('Qty bán không hợp lệ (<=0). Bỏ qua đặt bán.');
    return null;
  }

  const order = await binanceRequest(
    'POST',
    '/api/v3/order',
    {
      symbol: SYMBOL,
      side: 'SELL',
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity: roundedQty.toFixed(filters.qtyDecimals),
      price: price.toFixed(filters.priceDecimals),
    },
    true
  );

  console.log(`Đã đặt SELL: qty=${roundedQty.toFixed(filters.qtyDecimals)} price=${price.toFixed(filters.priceDecimals)} orderId=${order.orderId}`);
  currentSellOrder = order;
  return order;
}

// ------------- Core loop -------------
async function checkFilledOrdersAndAdvance() {
  // Kiểm tra BUY
  if (currentBuyOrder) {
    const ob = await getOrderStatus(currentBuyOrder.orderId);
    if (ob.status === 'FILLED') {
      const execQty = parseFloat(ob.executedQty);
      // Lấy giá mua trung bình thực tế: cummulativeQuoteQty / executedQty
      const avgBuy = execQty > 0 ? parseFloat(ob.cummulativeQuoteQty) / execQty : parseFloat(ob.price);
      lastBuyPrice = avgBuy;
      currentBuyOrder = null;

      const sellPrice = avgBuy + 100;
      await placeSellOrder(sellPrice, execQty);
      console.log(`BUY filled: avg=${fmt(avgBuy, filters.priceDecimals)}, execQty=${fmt(execQty, filters.qtyDecimals)} → đặt SELL @ ${fmt(sellPrice, filters.priceDecimals)}`);
    }
  }

  // Kiểm tra SELL
  if (currentSellOrder) {
    const os = await getOrderStatus(currentSellOrder.orderId);
    if (os.status === 'FILLED') {
      console.log(`SELL filled: price=${fmt(parseFloat(os.price), filters.priceDecimals)}, qty=${fmt(parseFloat(os.executedQty), filters.qtyDecimals)}`);
      currentSellOrder = null;
      lastBuyPrice = null;
    }
  }
}

async function botLoop() {
  try {
    // 1) Cập nhật lệnh đang mở và xử lý chuyển trạng thái
    await checkOpenOrders();
    await checkFilledOrdersAndAdvance();

    // 2) Đặt lệnh BUY nếu không có lệnh mở
    if (!currentBuyOrder && !currentSellOrder) {
      const priceNow = await getCurrentPrice();
      const buyPrice = priceNow - 50;
      await placeBuyOrder(buyPrice);
    }

    // 3) In trạng thái ra shell
    const [priceNow, balances] = await Promise.all([getCurrentPrice(), getBalances()]);
    printStatus(priceNow, balances);
  } catch (err) {
    console.error('Lỗi:', err.response?.data || err.message);
  }
}

// ------------- Logging status -------------
function printStatus(priceNow, balances) {
  const buyInfo = currentBuyOrder
    ? `BUY waiting: id=${currentBuyOrder.orderId} price=${fmt(Number(currentBuyOrder.price), filters.priceDecimals)} qty=${fmt(Number(currentBuyOrder.origQty), filters.qtyDecimals)}`
    : 'No BUY pending';

  const sellInfo = currentSellOrder
    ? `SELL waiting: id=${currentSellOrder.orderId} price=${fmt(Number(currentSellOrder.price), filters.priceDecimals)} qty=${fmt(Number(currentSellOrder.origQty), filters.qtyDecimals)}`
    : 'No SELL pending';

  console.log('----- PAXG BOT STATUS -----');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Price: ${fmt(priceNow, filters.priceDecimals)} ${QUOTE}`);
  console.log(`Balance: USDT free=${fmt(balances.usdtFree, 4)} locked=${fmt(balances.usdtLocked, 4)} | PAXG free=${fmt(balances.paxgFree, filters.qtyDecimals)} locked=${fmt(balances.paxgLocked, filters.qtyDecimals)}`);
  console.log(`Last buy price: ${lastBuyPrice ? fmt(lastBuyPrice, filters.priceDecimals) : '-'}`);
  console.log(buyInfo);
  console.log(sellInfo);
  console.log('---------------------------\n');
}

// ------------- Bootstrap & server -------------
(async () => {
  try {
    await loadFilters();
    console.log('Bot PAXG khởi động...');
    // chạy ngay 1 vòng, sau đó đặt interval
    await botLoop();
    setInterval(botLoop, INTERVAL);
  } catch (e) {
    console.error('Khởi động thất bại:', e.response?.data || e.message);
    process.exit(1);
  }
})();

// Health & status endpoints (Render sẽ ping giữ app sống)
app.get('/', (req, res) => {
  res.send('PAXG bot is running');
});

app.get('/status', async (req, res) => {
  try {
    const [priceNow, balances] = await Promise.all([getCurrentPrice(), getBalances()]);
    res.json({
      time: new Date().toISOString(),
      price: priceNow,
      balances,
      pending: {
        buy: currentBuyOrder
          ? {
              orderId: currentBuyOrder.orderId,
              price: Number(currentBuyOrder.price),
              qty: Number(currentBuyOrder.origQty),
            }
          : null,
        sell: currentSellOrder
          ? {
              orderId: currentSellOrder.orderId,
              price: Number(currentSellOrder.price),
              qty: Number(currentSellOrder.origQty),
            }
          : null,
      },
      lastBuyPrice,
    });
  } catch (e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server listening on ${process.env.PORT || 3000}`);
});
