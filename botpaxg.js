const express = require('express');
const axios = require('axios').default;
const crypto = require('crypto');

const app = express();
app.use(express.json());

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;

if (!API_KEY || !API_SECRET) {
  console.error('❌ Thiếu BINANCE_API_KEY hoặc BINANCE_API_SECRET trong biến môi trường');
  process.exit(1);
}

const SYMBOL = 'PAXGUSDT';
const QUOTE = 'USDT';
const BASE = 'PAXG';
const BUY_AMOUNT_USD = 80;
const INTERVAL = 30000;

let filters = {};
let currentBuyOrder = null;
let currentSellOrder = null;
let lastBuyPrice = null;

async function binanceRequest(method, path, params = {}, isPrivate = false) {
  const baseURL = 'https://api.binance.com';
  const timestamp = Date.now();
  const query = new URLSearchParams(params);

  if (isPrivate) {
    query.append('timestamp', timestamp);
    query.append('recvWindow', '5000');
    const signature = crypto
      .createHmac('sha256', API_SECRET)
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
  return (Math.floor(qty / stepSize) * stepSize).toFixed(8);
}

function roundTickSize(price, tickSize) {
  return (Math.floor(price / tickSize) * tickSize).toFixed(2);
}

async function loadFilters() {
  const info = await binanceRequest('GET', '/api/v3/exchangeInfo');
  const symbolInfo = info.symbols.find(s => s.symbol === SYMBOL);
  if (!symbolInfo) throw new Error(`Không tìm thấy symbol ${SYMBOL}`);

  const lotSize = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
  const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');

  // Tìm filter min notional hoặc notional
  const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'NOTIONAL');

  filters = {
    stepSize: parseFloat(lotSize?.stepSize || '0.00000001'),
    tickSize: parseFloat(priceFilter?.tickSize || '0.01'),
    minNotional: minNotionalFilter
      ? parseFloat(minNotionalFilter.minNotional || minNotionalFilter.notional || '0')
      : 0
  };

  console.log('Filters:', filters);
}


async function getBalances() {
  const acc = await binanceRequest('GET', '/api/v3/account', {}, true);
  const usdt = acc.balances.find(b => b.asset === QUOTE);
  const paxg = acc.balances.find(b => b.asset === BASE);
  return {
    usdtFree: parseFloat(usdt.free),
    paxgFree: parseFloat(paxg.free)
  };
}

async function checkOpenOrders() {
  const orders = await binanceRequest('GET', '/api/v3/openOrders', { symbol: SYMBOL }, true);
  currentBuyOrder = orders.find(o => o.side === 'BUY') || null;
  currentSellOrder = orders.find(o => o.side === 'SELL') || null;
}

async function placeBuyOrder(price) {
  const balances = await getBalances();
  let maxBuyUSD = Math.min(BUY_AMOUNT_USD, balances.usdtFree); // chỉ dùng số dư khả dụng
  if (maxBuyUSD <= 0) {
    console.log(`❌ Không đủ USDT để mua. Số dư: ${balances.usdtFree}`);
    return;
  }

  let qty = maxBuyUSD / price;

  // Làm tròn theo stepSize
  qty = parseFloat(roundStepSize(qty, filters.stepSize));

  // Kiểm tra minNotional
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
    price: price
  }, true);
  currentBuyOrder = order;
}

async function placeSellOrder(price, qty) {
  const balances = await getBalances();
  let sellQty = Math.min(qty, balances.paxgFree); // chỉ bán số lượng khả dụng

  sellQty = parseFloat(roundStepSize(sellQty, filters.stepSize));

  if (sellQty * price < filters.minNotional) {
    console.log(`❌ Lệnh bán không đạt minNotional (${filters.minNotional} ${QUOTE})`);
    return;
  }

  if (sellQty <= 0) {
    console.log(`❌ Không đủ ${BASE} để bán. Số dư: ${balances.paxgFree}`);
    return;
  }

  console.log(`✅ Đặt BÁN ${sellQty} ${SYMBOL} tại ${price}`);
  const order = await binanceRequest('POST', '/api/v3/order', {
    symbol: SYMBOL,
    side: 'SELL',
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity: sellQty,
    price: price
  }, true);
  currentSellOrder = order;
}

async function checkFilledOrders() {
  // Kiểm tra lệnh mua
  if (currentBuyOrder) {
    const order = await binanceRequest('GET', '/api/v3/order', {
      symbol: SYMBOL,
      orderId: currentBuyOrder.orderId
    }, true);

    if (order.status === 'FILLED') {
      lastBuyPrice = parseFloat(order.price);
      currentBuyOrder = null;

      // Giá bán = giá mua + 20
      const sellPrice = roundTickSize(lastBuyPrice + 20, filters.tickSize);

      // Số lượng đã mua
      const qtyBought = parseFloat(order.executedQty);

      console.log(`✅ Đã mua ${qtyBought} ${BASE} tại giá ${lastBuyPrice}`);
      console.log(`📌 Tạo lệnh bán ngay tại giá ${sellPrice}`);

      // Đặt lệnh bán ngay sau khi mua
      await placeSellOrder(sellPrice, qtyBought);
    }
  }

  // Kiểm tra lệnh bán
  if (currentSellOrder) {
    const order = await binanceRequest('GET', '/api/v3/order', {
      symbol: SYMBOL,
      orderId: currentSellOrder.orderId
    }, true);

    if (order.status === 'FILLED') {
      console.log(`💰 Đã bán ${order.executedQty} ${BASE} tại giá ${order.price}`);
      currentSellOrder = null;
      lastBuyPrice = null;
    }
  }
}



async function botLoop() {
  try {
    await checkOpenOrders();
    await checkFilledOrders();

    const ticker = await binanceRequest('GET', '/api/v3/ticker/price', { symbol: SYMBOL });
    const currentPrice = parseFloat(ticker.price);
    const balances = await getBalances();

    console.log(`📊 Giá hiện tại: ${currentPrice} | USDT: ${balances.usdtFree} | ${BASE}: ${balances.paxgFree}`);
    console.log(`📌 Lệnh chờ mua: ${currentBuyOrder ? JSON.stringify(currentBuyOrder) : 'Không có'}`);
    console.log(`📌 Lệnh chờ bán: ${currentSellOrder ? JSON.stringify(currentSellOrder) : 'Không có'}`);

    // Nếu đã mua PAXG và chưa có lệnh SELL thì đặt lệnh bán
    if (!currentSellOrder && lastBuyPrice !== null) {
      const sellPrice = roundTickSize(lastBuyPrice + 20, filters.tickSize);
      await placeSellOrder(sellPrice, balances.paxgFree);
      return; // Ưu tiên bán trước, không đặt lệnh mua trong vòng này
    }

    // Nếu chưa có lệnh mua/bán và USDT đủ 80 thì đặt lệnh mua
    if (!currentBuyOrder && !currentSellOrder && balances.usdtFree >= BUY_AMOUNT_USD) {
      const buyPrice = roundTickSize(currentPrice - 10, filters.tickSize);
      await placeBuyOrder(buyPrice);
    } else if (balances.usdtFree < BUY_AMOUNT_USD) {
      console.log(`❌ Không đủ USDT để đặt lệnh mua (cần >= ${BUY_AMOUNT_USD} ${QUOTE})`);
    }

  } catch (err) {
    console.error('🚨 Lỗi:', err.response?.data || err.message);
  }
}



(async () => {
  await loadFilters();
  console.log('Bot PAXG bắt đầu chạy...');
  setInterval(botLoop, INTERVAL);
})();

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.send('Bot PAXG đang chạy...');
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server listening on port ${process.env.PORT || 3000}`);
});

const url = 'https://bn-5l7b.onrender.com/health'; // endpoint
setInterval(() => {
  axios.get(url)
    .then(res => console.log(`Ping at ${new Date().toISOString()} - ${res.status}`))
    .catch(err => console.error(`Ping error: ${err.message}`));
}, 14 * 60 * 1000); // 14 min







