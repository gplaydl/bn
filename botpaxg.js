// botpaxg.js
'use strict';

const express = require('express');
const axios = require('axios').default;
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ====== Cấu hình ======
const SYMBOL = 'PAXGUSDT';
const QUOTE = 'USDT';
const BASE = 'PAXG';
const BUY_AMOUNT_USD = 80;              // số USDT dùng cho mỗi lệnh mua
const INTERVAL = 30_000;                // 30s mỗi vòng lặp
const ENABLE_REINVEST = true;           // bật/tắt tái đầu tư sau khi bán
const KEEPALIVE_URL = 'https://bn-5l7b.onrender.com/health';

// ====== API key ======
const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;

if (!API_KEY || !API_SECRET) {
  console.error('❌ Thiếu BINANCE_API_KEY hoặc BINANCE_API_SECRET trong biến môi trường');
  process.exit(1);
}

// ====== Trạng thái ======
let filters = { stepSize: 0.00000001, tickSize: 0.01, minNotional: 0 };
let currentBuyOrder = null;
let currentSellOrder = null;
let lastBuyPrice = null;

// ====== Tiện ích Binance ======
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
  const q = Math.floor(qty / stepSize) * stepSize;
  return Number(q.toFixed(8));
}

function roundTickSize(price, tickSize) {
  const p = Math.floor(price / tickSize) * tickSize;
  return Number(p.toFixed(2));
}

// ====== Filters giao dịch ======
async function loadFilters() {
  const info = await binanceRequest('GET', '/api/v3/exchangeInfo');
  const symbolInfo = info.symbols.find(s => s.symbol === SYMBOL);
  if (!symbolInfo) throw new Error(`Không tìm thấy symbol ${SYMBOL}`);

  const lotSize = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
  const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
  const minNotionalFilter =
    symbolInfo.filters.find(f => f.filterType === 'NOTIONAL') ||
    symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');

  filters = {
    stepSize: parseFloat(lotSize?.stepSize || '0.00000001'),
    tickSize: parseFloat(priceFilter?.tickSize || '0.01'),
    minNotional: minNotionalFilter
      ? parseFloat(minNotionalFilter.minNotional || minNotionalFilter.notional || '0')
      : 0
  };

  console.log('Filters:', filters);
}

// ====== Số dư ======
async function getBalances() {
  const acc = await binanceRequest('GET', '/api/v3/account', {}, true);
  const usdt = acc.balances.find(b => b.asset === QUOTE) || { free: '0' };
  const paxg = acc.balances.find(b => b.asset === BASE) || { free: '0' };
  return {
    usdtFree: parseFloat(usdt.free),
    paxgFree: parseFloat(paxg.free)
  };
}

// ====== Lấy giá trung bình đã mua ======
// 1) Cố gắng lấy từ capital/config/getall (nếu tài khoản hỗ trợ)
async function getAverageBuyPriceFromCapital(asset) {
  try {
    const data = await binanceRequest('GET', '/sapi/v1/capital/config/getall', {}, true);
    const assetInfo = Array.isArray(data) ? data.find(a => a.coin === asset || a.asset === asset) : null;
    const avg =
      assetInfo?.avgPrice ??
      assetInfo?.price ??
      assetInfo?.costPrice ??
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

// 2) Fallback: tính giá vốn trung bình từ lịch sử giao dịch myTrades (FIFO)
async function fetchAllTrades(symbol, maxPages = 50) {
  const all = [];
  let fromId = undefined;

  for (let i = 0; i < maxPages; i++) {
    const params = { symbol, limit: 1000 };
    if (fromId !== undefined) params.fromId = fromId;

    const batch = await binanceRequest('GET', '/api/v3/myTrades', params, true);
    if (!Array.isArray(batch) || batch.length === 0) break;

    all.push(...batch);

    const last = batch[batch.length - 1];
    const nextId = (typeof last.id === 'number') ? last.id + 1 : undefined;
    if (!nextId || batch.length < 1000) break;
    fromId = nextId;
  }

  // đảm bảo theo thời gian tăng dần
  all.sort((a, b) => a.time - b.time || a.id - b.id);
  return all;
}

function computeRemainingPositionAvgPriceFIFO(trades) {
  // trades: myTrades cho SYMBOL; mỗi trade có: isBuyer, qty, price, commission, commissionAsset
  // Ta tính tồn kho còn lại theo FIFO và giá vốn trung bình của tồn kho
  const lots = []; // mỗi lot: { qty, costPerUnit }
  const asNumber = v => parseFloat(v);

  for (const t of trades) {
    const qty = asNumber(t.qty);
    const price = asNumber(t.price);
    const commission = asNumber(t.commission || 0);
    const commissionAsset = t.commissionAsset;

    if (t.isBuyer) {
      // Điều chỉnh số lượng và chi phí theo phí:
      // - Nếu phí bằng BASE => số lượng thực nhận giảm
      // - Nếu phí bằng QUOTE => chi phí tăng thêm (trên tổng cost)
      let qtyNet = qty;
      let totalCostQuote = qty * price;

      if (commissionAsset === BASE) {
        qtyNet = Math.max(0, qtyNet - commission);
      } else if (commissionAsset === QUOTE) {
        totalCostQuote += commission;
      }
      if (qtyNet > 0) {
        const unitCost = totalCostQuote / qtyNet;
        lots.push({ qty: qtyNet, unitCost });
      }
    } else {
      // SELL: trừ dần từ các lot FIFO
      let remainingSell = qty;
      // Nếu phí bằng BASE, số lượng thực bán giảm; nếu bằng QUOTE thì không ảnh hưởng qty
      if (commissionAsset === BASE) {
        remainingSell = Math.max(0, remainingSell - commission);
      }
      while (remainingSell > 0 && lots.length > 0) {
        const lot = lots[0];
        const take = Math.min(lot.qty, remainingSell);
        lot.qty -= take;
        remainingSell -= take;
        if (lot.qty <= 0.00000001) {
          lots.shift();
        }
      }
      // Nếu remainingSell > 0 và hết lot => coi như bán vượt, bỏ qua phần dư (không nên xảy ra nếu dữ liệu đủ)
    }
  }

  const remainingQty = lots.reduce((s, l) => s + l.qty, 0);
  const remainingCost = lots.reduce((s, l) => s + l.qty * l.unitCost, 0);

  if (remainingQty > 0 && remainingCost > 0) {
    return remainingCost / remainingQty;
  }
  return null;
}

async function getAverageBuyPriceFromTrades(symbol) {
  try {
    const trades = await fetchAllTrades(symbol);
    if (!trades || trades.length === 0) {
      console.log('⚠️ Không có lịch sử giao dịch để tính giá trung bình.');
      return null;
    }
    const avg = computeRemainingPositionAvgPriceFIFO(trades);
    if (avg && Number.isFinite(avg) && avg > 0) return avg;
    console.log('⚠️ Không tính được giá trung bình từ myTrades (có thể không còn tồn kho).');
    return null;
  } catch (e) {
    console.log('⚠️ Lỗi lấy/tính myTrades:', e.response?.data || e.message);
    return null;
  }
}

// Tổ hợp: lấy avg từ capital, nếu không có thì fallback sang myTrades
async function getAverageBuyPrice(asset, symbol) {
  const capitalAvg = await getAverageBuyPriceFromCapital(asset);
  if (capitalAvg) return capitalAvg;

  const tradesAvg = await getAverageBuyPriceFromTrades(symbol);
  if (tradesAvg) return tradesAvg;

  return null;
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
  // Kiểm tra lệnh mua
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

      // Tái đầu tư sau khi bán
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

    // Nếu đang có PAXG và chưa có lệnh SELL -> lấy giá trung bình và đặt SELL toàn bộ tại avg + 20
    if (balances.paxgFree > 0 && !currentSellOrder) {
      if (lastBuyPrice === null) {
        const avg = await getAverageBuyPrice(BASE, SYMBOL);
        if (!avg) {
          console.log('⏸ Không truy xuất/tính được giá trung bình. Bỏ qua vòng này.');
          return;
        }
        lastBuyPrice = avg;
        console.log(`📈 Giá trung bình mua vào của ${BASE}: ${lastBuyPrice}`);
      }

      const sellPrice = roundTickSize(lastBuyPrice + 20, filters.tickSize);
      await placeSellOrder(sellPrice, balances.paxgFree);
      return; // ưu tiên đặt bán trước, không đặt mua trong vòng này
    }

    // Nếu chưa có PAXG, tùy chiến lược: chờ khớp mua hoặc tái đầu tư sẽ lo phần mua.
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

// Ping giữ dịch vụ sống
if (KEEPALIVE_URL) {
  setInterval(() => {
    axios.get(KEEPALIVE_URL)
      .then(res => console.log(`🔔 Ping at ${new Date().toISOString()} - ${res.status}`))
      .catch(err => console.error(`Ping error: ${err.message}`));
  }, 14 * 60 * 1000);
}
