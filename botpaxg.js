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
const BUY_AMOUNT_USD = 80;        // số USDT cho mỗi lệnh mua
const INTERVAL = 30_000;          // 30s mỗi vòng lặp
const ENABLE_REINVEST = true;     // tái đầu tư sau khi bán
const KEEPALIVE_URL = 'https://bn-5l7b.onrender.com/health'; // endpoint keepalive

// ====== Biến môi trường ======
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;

if (!API_KEY || !API_SECRET) {
  console.error('❌ Thiếu BINANCE_API_KEY hoặc BINANCE_API_SECRET trong biến môi trường');
  process.exit(1);
}

// ====== Trạng thái toàn cục ======
let filters = { stepSize: 0.00000001, tickSize: 0.01, minNotional: 0 };
let currentBuyOrder = null;
let currentSellOrder = null;
let lastBuyPrice = null;

// ====== Tiện ích ======
async function binanceRequest(method, path, params = {}, isPrivate = false) {
  const baseURL = 'https://api.binance.com';
  const timestamp = Date.now();
  const query = new URLSearchParams(params);

  if (isPrivate) {
    query.append('timestamp', timestamp);
    query.append('recvWindow', '5000');
    const signature = crypto.createHmac('sha256', API_SECRET)
      .update(query.toString())
      .digest('hex');
    query.append('signature', signature);
  }

  const headers = isPrivate ? { 'X-MBX-APIKEY': API_KEY } : {};
  const url = `${baseURL}${path}?${query.toString()}`;
  const res = await axios({ method, url, headers });
  return res.data;
}

function roundStepSize(qty, stepSize) {
  // ép số về bội của stepSize và định dạng 8 chữ số thập phân
  const q = Math.floor(qty / stepSize) * stepSize;
  return Number(q.toFixed(8));
}

function roundTickSize(price, tickSize) {
  // ép giá về bội của tickSize và định dạng 2 chữ số thập phân
  const p = Math.floor(price / tickSize) * tickSize;
  return Number(p.toFixed(2));
}

// ====== Khởi tạo filter sàn ======
async function loadFilters() {
  const info = await binanceRequest('GET', '/api/v3/exchangeInfo');
  const symbolInfo = info.symbols.find(s => s.symbol === SYMBOL);
  if (!symbolInfo) throw new Error(`Không tìm thấy symbol ${SYMBOL}`);

  const lotSize = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
  const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
  const minNotionalFilter =
    symbolInfo.filters.find(f => f.filterType === 'NOTIONAL') ||
    symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL'); // tương thích cũ

  filters = {
    stepSize: parseFloat(lotSize?.stepSize || '0.00000001'),
    tickSize: parseFloat(priceFilter?.tickSize || '0.01'),
    minNotional: minNotionalFilter
      ? parseFloat(minNotionalFilter.minNotional || minNotionalFilter.notional || '0')
      : 0
  };

  console.log('Filters:', filters);
}

// ====== Thông tin tài khoản ======
async function getBalances() {
  const acc = await binanceRequest('GET', '/api/v3/account', {}, true);
  const usdt = acc.balances.find(b => b.asset === QUOTE) || { free: '0' };
  const paxg = acc.balances.find(b => b.asset === BASE) || { free: '0' };
  return {
    usdtFree: parseFloat(usdt.free),
    paxgFree: parseFloat(paxg.free)
  };
}

// Giá trung bình đã mua (giá vốn) từ tài khoản (Binance Savings/Wallet)
async function getAverageBuyPrice(asset) {
  try {
    const data = await binanceRequest('GET', '/sapi/v1/capital/config/getall', {}, true);
    const assetInfo = Array.isArray(data) ? data.find(a => a.coin === asset || a.asset === asset) : null;

    // Một số tài khoản trả về avgPrice, một số không — xử lý mềm dẻo
    const avg =
      assetInfo?.avgPrice ??
      assetInfo?.price ??          // fallback đôi khi là price
      assetInfo?.costPrice ??      // hoặc costPrice
      null;

    if (!avg) {
      console.log(`⚠️ Không tìm thấy giá trung bình cho ${asset} từ capital/config/getall`);
      return null;
    }
    const avgNum = parseFloat(avg);
    if (Number.isFinite(avgNum) && avgNum > 0) return avgNum;

    console.log(`⚠️ Trường giá trung bình không hợp lệ cho ${asset}: ${avg}`);
    return null;
  } catch (e) {
    console.log('⚠️ Lỗi lấy giá trung bình từ capital API:', e.response?.data || e.message);
    return null;
  }
}

// ====== Đơn hàng ======
async function checkOpenOrders() {
  const orders = await binanceRequest('GET', '/api/v3/openOrders', { symbol: SYMBOL }, true);
  currentBuyOrder = orders.find(o => o.side === 'BUY') || null;
  currentSellOrder = orders.find(o => o.side === 'SELL') || null;
}

async function placeBuyOrder(price) {
  const { usdtFree } = await getBalances();
  const maxBuyUSD = Math.min(BUY_AMOUNT_USD, usdtFree);
  if (maxBuyUSD <= 0) {
    console.log(`❌ Không đủ USDT để mua. Số dư: ${usdtFree}`);
    return;
  }

  let qty = maxBuyUSD / price;
  qty = roundStepSize(qty, filters.stepSize);

  if (qty * price < filters.minNotional) {
    console.log(`❌ Lệnh mua không đạt minNotional (${filters.minNotional} ${QUOTE})`);
    return;
  }

  console.log(`✅ Đặt MUA ${qty} ${SYMBOL} tại ${price}`);
  const order = await binanceRequest('POST', '/api/v3/order', {
    symbol: SYMBOL,
    side: 'BUY',
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity: qty,
    price
  }, true);

  currentBuyOrder = order;
}

async function placeSellOrder(price, qty) {
  const { paxgFree } = await getBalances();
  let sellQty = Math.min(qty, paxgFree);
  sellQty = roundStepSize(sellQty, filters.stepSize);

  if (sellQty <= 0) {
    console.log(`❌ Không đủ ${BASE} để bán. Số dư: ${paxgFree}`);
    return;
  }

  if (sellQty * price < filters.minNotional) {
    console.log(`❌ Lệnh bán không đạt minNotional (${filters.minNotional} ${QUOTE})`);
    return;
  }

  console.log(`✅ Đặt BÁN ${sellQty} ${SYMBOL} tại ${price}`);
  const order = await binanceRequest('POST', '/api/v3/order', {
    symbol: SYMBOL,
    side: 'SELL',
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity: sellQty,
    price
  }, true);

  currentSellOrder = order;
}

async function checkFilledOrders() {
  // Lệnh mua
  if (currentBuyOrder) {
    const order = await binanceRequest('GET', '/api/v3/order', {
      symbol: SYMBOL,
      orderId: currentBuyOrder.orderId
    }, true);

    if (order.status === 'FILLED') {
      lastBuyPrice = parseFloat(order.price);
      currentBuyOrder = null;
      console.log(`✅ Đã mua ${order.executedQty} ${BASE} tại giá ${lastBuyPrice}`);
    }
  }

  // Lệnh bán
  if (currentSellOrder) {
    const order = await binanceRequest('GET', '/api/v3/order', {
      symbol: SYMBOL,
      orderId: currentSellOrder.orderId
    }, true);

    if (order.status === 'FILLED') {
      console.log(`💰 Đã bán ${order.executedQty} ${BASE} tại giá ${order.price}`);
      currentSellOrder = null;
      lastBuyPrice = null;

      // Tái đầu tư (tùy chọn)
      if (ENABLE_REINVEST) {
        const balances = await getBalances();
        if (balances.usdtFree >= BUY_AMOUNT_USD) {
          const ticker = await binanceRequest('GET', '/api/v3/ticker/price', { symbol: SYMBOL });
          const currentPrice = parseFloat(ticker.price);
          const buyPrice = roundTickSize(currentPrice - 10, filters.tickSize);
          console.log(`🔄 Tái đầu tư: đặt lệnh mua mới tại ${buyPrice}`);
          await placeBuyOrder(buyPrice);
        } else {
          console.log(`⏸ Không đủ USDT để tái đầu tư (cần ≥ ${BUY_AMOUNT_USD})`);
        }
      }
    }
  }
}

// ====== Vòng lặp bot ======
async function botLoop() {
  try {
    await checkOpenOrders();
    await checkFilledOrders();

    const ticker = await binanceRequest('GET', '/api/v3/ticker/price', { symbol: SYMBOL });
    const currentPrice = parseFloat(ticker.price);
    const balances = await getBalances();

    console.log(`📊 Giá hiện tại: ${currentPrice} | ${QUOTE}: ${balances.usdtFree} | ${BASE}: ${balances.paxgFree}`);
    console.log(`📌 Lệnh chờ mua: ${currentBuyOrder ? JSON.stringify({ id: currentBuyOrder.orderId, price: currentBuyOrder.price }) : 'Không có'}`);
    console.log(`📌 Lệnh chờ bán: ${currentSellOrder ? JSON.stringify({ id: currentSellOrder.orderId, price: currentSellOrder.price }) : 'Không có'}`);

    // Nếu đang có PAXG và chưa có lệnh SELL -> tự động truy xuất giá trung bình và đặt SELL toàn bộ tại avg + 20
    if (balances.paxgFree > 0 && !currentSellOrder) {
      // Ưu tiên dùng lastBuyPrice nếu vừa mua xong; nếu chưa có, lấy giá trung bình từ tài khoản
      if (lastBuyPrice === null) {
        const avg = await getAverageBuyPrice(BASE);
        if (!avg) {
          console.log('⏸ Không lấy được giá trung bình. Bỏ qua vòng này.');
          return;
        }
        lastBuyPrice = avg;
        console.log(`📈 Giá trung bình mua vào của ${BASE}: ${lastBuyPrice}`);
      }

      const sellPrice = roundTickSize(lastBuyPrice + 20, filters.tickSize);
      await placeSellOrder(sellPrice, balances.paxgFree);
      return; // ưu tiên bán trước, không đặt mua trong vòng này
    }

    // Nếu không có PAXG: chỉ log (mua sẽ xảy ra khi tái đầu tư hoặc tùy chiến lược riêng)
    if (balances.paxgFree === 0) {
      console.log(`⏸ Không có ${BASE} trong ví. Chờ lệnh mua được khớp hoặc tái đầu tư.`);
    }

  } catch (err) {
    console.error('🚨 Lỗi:', err.response?.data || err.message);
  }
}

// ====== Khởi động bot ======
(async () => {
  await loadFilters();
  console.log('🚀 Bot PAXG bắt đầu chạy...');
  setInterval(botLoop, INTERVAL);
})();

// ====== HTTP server & keepalive ======
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.send('Bot PAXG đang chạy...'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Server listening on port ${PORT}`));

// ping giữ dịch vụ sống
if (KEEPALIVE_URL) {
  setInterval(() => {
    axios.get(KEEPALIVE_URL)
      .then(res => console.log(`🔔 Ping at ${new Date().toISOString()} - ${res.status}`))
      .catch(err => console.error(`Ping error: ${err.message}`));
  }, 14 * 60 * 1000); // 14 phút
}
