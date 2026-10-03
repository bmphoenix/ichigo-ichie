/**
 * ダウ追加版 BTC＋ETH 組み合わせbot
 *  ルール（銘柄ごと）：次の3つがそろっている間だけ保有し、どれかが崩れたら売って円で待機
 *   1. 15分足のEMA50 > EMA200（ゴールデンクロスの状態）
 *   2. 4時間足の終値 > EMA200
 *   3. 4時間足のダウ理論で上昇トレンド（山と谷を左右3本で判定し、高値・安値の切り上がりで上昇、直近の押し安値割れで終了）
 *
 * ルール（銘柄ごと）：「15分足EMA50 > EMA200」かつ「4時間足の終値 > EMA200」の間だけ保有
 * 資金は銘柄ごとに BUDGET_JPY × 配分 で分け、それぞれの予算の範囲だけで売買する
 * Coincheck 現物・ロングのみ ― Google Apps Script版（取引履歴・サマリー付き）
 *
 * 準備:
 *  1. 新しいスプレッドシート →「拡張機能」→「Apps Script」にこのコードを貼って保存
 *  2. 通知先（メール・Discord）はこのファイルに直接書き込み済み
 *  3. 関数「testNotify」を実行して通知を確認 → 関数「setup」を1回実行（5分ごとに自動実行）
 *  本番にするとき:
 *  4. スクリプト プロパティに CC_KEY と CC_SECRET（CoincheckのAPIキー）を登録
 *  5. DRY_RUN を false にして保存し、関数「resetSim」を実行
 */
const DRY_RUN      = true;          // true: 注文を出さない（お試し）/ false: 本番
const BUDGET_JPY   = 200000;        // このbot全体に割り当てる資金（円）。お試しでは仮想資金
const WEIGHTS      = {btc: 0.5, eth: 0.5};           // 銘柄ごとの配分
const MIN_ORDER    = {btc: 0.001, eth: 0.01};        // 最小注文数量（Coincheckの「取引所での取引注文ルール」で要確認）
const KRAKEN_PAIR  = {btc: 'XBTUSD', eth: 'ETHUSD'};
const USE_RATIO    = 0.99;          // 買うときに使う予算の割合
// 通知先はコードに書かず、スクリプト プロパティから読み込む（GitHubに公開しても漏れないように）
const NOTIFY_EMAIL = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL') || '';
const DISCORD_URL  = PropertiesService.getScriptProperties().getProperty('DISCORD_URL') || '';
const COINS = Object.keys(WEIGHTS);
const DOW_N        = 3;                                  // ダウ理論の山・谷の判定（左右3本）


// ================= 初期設定 =================
function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('main').timeBased().everyMinutes(5).create();
  sheets_();
  log_('トリガーを設定しました（5分ごとに main を実行）');
  main();
}
function resetSim() {
  const p = props_(), keys = ['LAST_ERR'];
  COINS.forEach(c => keys.push('SIM_' + c, 'LEDGER_' + c, 'OPEN_' + c));
  keys.push('PENDING');
  keys.forEach(k => p.deleteProperty(k));
  const s = sheets_();
  if (s.trades.getLastRow() > 1) s.trades.deleteRows(2, s.trades.getLastRow() - 1);
  log_('記録をリセットしました');
}
function testNotify() { notify_('テスト通知', 'ダウ版 botからの通知テストです。これが届いていれば設定OKです。'); }

// ================= メイン =================
function main() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  const status = {};
  try {
    flushPending_();
    COINS.forEach(c => { status[c] = stepCoin_(c, null); });   // 残高は銘柄ごとに最新を取得
    compareSpreads_();                                          // 取引所ごとのスプレッド比較（売買には影響しない）
    try { summary_(status); } catch (e) { console.log('サマリー更新失敗: ' + e.message); }
  } catch (e) {
    log_('✖ エラー: ' + e.message);   // log_ 自体は失敗しても止まらない
    const last = JSON.parse(props_().getProperty('LAST_ERR') || '{}');
    if (last.msg !== e.message || Date.now() - last.t > 3600000) {
      notify_('botエラー', e.message);
      props_().setProperty('LAST_ERR', JSON.stringify({msg: e.message, t: Date.now()}));
    }
  } finally { lock.releaseLock(); }
}

function stepCoin_(coin, account) {
  const SYM = coin.toUpperCase(), sig = signal_(coin);
  const t = fetchJson_('https://coincheck.com/api/ticker?pair=' + coin + '_jpy');
  const bid = Number(t.bid), ask = Number(t.ask);
  trackSpread_(coin, bid, ask);
  let bal = balance_(coin, account);
  const holding = bal.coin >= MIN_ORDER[coin];

  if (sig.want && !holding) {
    const amountJpy = Math.floor(bal.jpy * USE_RATIO);
    if (amountJpy / ask < MIN_ORDER[coin]) {
      if (new Date().getMinutes() < 5) log_(`⚠ ${SYM}: 予算が最小注文数量（${MIN_ORDER[coin]}${SYM}）に届かず買えません`);
    } else {
      const after = buy_(coin, amountJpy, ask, bal);
      const got = after.coin - bal.coin, paid = bal.jpy - after.jpy, price = paid / got;
      const now = Date.now();
      props_().setProperty('OPEN_' + coin, JSON.stringify({row: null, time: now, jpy: paid}));   // 先に保有の情報を保存
      notify_(`${SYM}買い`, `${Math.round(paid).toLocaleString()}円分を買いました\n価格 ${Math.round(price).toLocaleString()}円 / 数量 ${round8_(got)} ${SYM}\n${sig.text}`);
      log_(`▶ ${SYM} 買い ${Math.round(paid).toLocaleString()}円 → ${round8_(got)}${SYM} @${Math.round(price).toLocaleString()} | ${sig.text}`);
      record_({type: 'buy', coin: coin, time: now,
               row: ['', SYM, jst_(now), Math.round(price), round8_(got), Math.round(paid), '', '', '', '', '', '', '', DRY_RUN ? 'お試し' : '本番']});
      bal = after;
    }
  } else if (!sig.want && holding) {
    const amount = Math.floor(bal.coin * 1e8) / 1e8;
    const after = sell_(coin, amount, bid, bal);
    const got = after.jpy - bal.jpy, price = got / amount;
    const open = JSON.parse(props_().getProperty('OPEN_' + coin) || 'null') || findOpenRow_(SYM);
    if (open) {
      const pnl = got - open.jpy, pct = pnl / open.jpy * 100, hrs = (Date.now() - open.time) / 3600000;
      notify_(pnl >= 0 ? `${SYM}売り（勝ち）` : `${SYM}売り（負け）`,
        `損益 ${Math.round(pnl).toLocaleString()}円（${pct.toFixed(2)}%）/ 保有 ${hrs.toFixed(1)}時間\n決済価格 ${Math.round(price).toLocaleString()}円\n${sig.text}`);
      log_(`▶ ${SYM} 売り ${amount}${SYM} @${Math.round(price).toLocaleString()} 損益 ${Math.round(pnl).toLocaleString()}円（${pct.toFixed(2)}%）保有${hrs.toFixed(1)}時間 | ${sig.text}`);
      record_({type: 'sell', sym: SYM, row: open.row, values: [jst_(Date.now()), Math.round(price), Math.round(got),
        Math.round(pnl), Math.round(pct * 100) / 100, Math.round(hrs * 10) / 10, pnl >= 0 ? '勝ち' : '負け']});
    } else {
      log_(`▶ ${SYM} 売り ${amount}${SYM} @${Math.round(price).toLocaleString()}（記録外のポジション）`);
    }
    props_().deleteProperty('OPEN_' + coin);
    bal = after;
  } else if (new Date().getMinutes() < 5) {
    log_(`… ${SYM} 変化なし | ${sig.text}`);
  }
  return {sig: sig, bal: bal, bid: bid};
}

// 記録用のメモが消えていた場合に、取引履歴から「まだ決済されていない行」を探す
function findOpenRow_(SYM) {
  const sh = sheets_().trades, n = sh.getLastRow() - 1;
  if (n < 1) return null;
  const data = sh.getRange(2, 1, n, 7).getValues();
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i][1] === SYM && data[i][6] === '') {
      return {row: i + 2, time: new Date(data[i][2]).getTime(), jpy: Number(data[i][5])};
    }
  }
  return null;
}

// ================= シグナル（Kraken公開データ、確定足のみ） =================
function krakenOHLC_(coin, interval) {
  const r = fetchJson_(`https://api.kraken.com/0/public/OHLC?pair=${KRAKEN_PAIR[coin]}&interval=${interval}`);
  if (r.error && r.error.length) throw new Error('Kraken: ' + r.error.join(','));
  const key = Object.keys(r.result).find(k => k !== 'last');
  const rows = r.result[key].slice(0, -1);                     // 最後の1本は未確定足
  return {h: rows.map(x => +x[2]), l: rows.map(x => +x[3]), c: rows.map(x => +x[4])};
}
function ema_(arr, p) { const a = 2 / (p + 1); let e = arr[0]; for (let i = 1; i < arr.length; i++) e = a * arr[i] + (1 - a) * e; return e; }
function emaSeries_(arr, p) { const a = 2 / (p + 1), out = [arr[0]]; for (let i = 1; i < arr.length; i++) out.push(a * arr[i] + (1 - a) * out[i - 1]); return out; }

// ダウ理論：山と谷（左右N本で確定）を追い、高値・安値の切り上がりで上昇、押し安値割れで終了
function dowStates_(h, l, c, N) {
  const sh = [], sl = [], st = []; let up = false;
  for (let i = 0; i < c.length; i++) {
    const k = i - N;
    if (k >= N) {
      let mx = -Infinity, mn = Infinity;
      for (let j = k - N; j <= i; j++) { mx = Math.max(mx, h[j]); mn = Math.min(mn, l[j]); }
      if (h[k] === mx) sh.push(h[k]);
      if (l[k] === mn) sl.push(l[k]);
    }
    if (sh.length >= 2 && sl.length >= 2) {
      const s1 = sh[sh.length - 1], s2 = sh[sh.length - 2], l1 = sl[sl.length - 1], l2 = sl[sl.length - 2];
      if (s1 > s2 && l1 > l2) up = true;
      if (c[i] < l1) up = false;
      if (c[i] > s1 && l1 > l2) up = true;
    }
    st.push(up);
  }
  return st;
}

function signal_(coin) {
  const c15 = krakenOHLC_(coin, 15).c, h4 = krakenOHLC_(coin, 240);
  const f = ema_(c15, 50), s = ema_(c15, 200), e4 = ema_(h4.c, 200), l4 = h4.c[h4.c.length - 1];
  const dow = dowStates_(h4.h, h4.l, h4.c, DOW_N);
  const gc = f > s, up4 = l4 > e4, dw = dow[dow.length - 1];
  return {want: gc && up4 && dw,
          text: `15分 ${gc ? 'GC' : 'DC'}（EMA50 ${f.toFixed(0)} / EMA200 ${s.toFixed(0)}）｜4H 終値 ${l4.toFixed(0)} / EMA200 ${e4.toFixed(0)} → ${up4 ? '上' : '下'}｜ダウ ${dw ? '上昇トレンド' : '上昇トレンドでない'}`};
}

// ================= 残高・売買（銘柄ごとの予算帳簿） =================
function budget_(coin) { return BUDGET_JPY * WEIGHTS[coin]; }
function balance_(coin, account) {
  if (DRY_RUN) {
    const s = JSON.parse(props_().getProperty('SIM_' + coin) || JSON.stringify({jpy: budget_(coin), coin: 0}));
    return {jpy: s.jpy, coin: s.coin};
  }
  const b = account || retry_(() => ccPrivate_('get', '/api/accounts/balance'));
  const ledger = Number(props_().getProperty('LEDGER_' + coin) || budget_(coin));
  return {jpy: Math.min(ledger, Number(b.jpy)), coin: Number(b[coin]), accountJpy: Number(b.jpy)};
}
function buy_(coin, amountJpy, ask, bal) {
  if (DRY_RUN) {
    const s = {jpy: bal.jpy - amountJpy, coin: bal.coin + amountJpy / ask};
    props_().setProperty('SIM_' + coin, JSON.stringify(s)); return s;
  }
  ccPrivate_('post', '/api/exchange/orders', {pair: coin + '_jpy', order_type: 'market_buy', market_buy_amount: amountJpy});
  const after = waitBalance_(coin, b => b.coin > bal.coin);
  const paid = bal.accountJpy - after.accountJpy;
  props_().setProperty('LEDGER_' + coin, String(bal.jpy - paid));
  return {jpy: bal.jpy - paid, coin: after.coin, accountJpy: after.accountJpy};
}
function sell_(coin, amount, bid, bal) {
  if (DRY_RUN) {
    const s = {jpy: bal.jpy + amount * bid, coin: bal.coin - amount};
    props_().setProperty('SIM_' + coin, JSON.stringify(s)); return s;
  }
  ccPrivate_('post', '/api/exchange/orders', {pair: coin + '_jpy', order_type: 'market_sell', amount: amount});
  const after = waitBalance_(coin, b => b.accountJpy > bal.accountJpy);
  const got = after.accountJpy - bal.accountJpy;
  props_().setProperty('LEDGER_' + coin, String(bal.jpy + got));
  return {jpy: bal.jpy + got, coin: after.coin, accountJpy: after.accountJpy};
}
function waitBalance_(coin, done) {
  for (let i = 0; i < 6; i++) {
    Utilities.sleep(3000);
    const b = balance_(coin, null);
    if (done(b)) return b;
  }
  throw new Error(`${coin.toUpperCase()}: 注文後の残高が更新されません。Coincheckで約定状況を確認してください`);
}

// ================= サマリー =================
function summary_(status) {
  const s = sheets_();
  let eqTotal = 0;
  COINS.forEach(c => { const x = status[c]; eqTotal += x.bal.jpy + x.bal.coin * x.bid; });
  const start = BUDGET_JPY;   // 開始時の資産＝割り当てた予算
  const data = s.trades.getLastRow() > 1 ? s.trades.getRange(2, 1, s.trades.getLastRow() - 1, 14).getValues() : [];
  const stat = rows => {
    const closed = rows.filter(r => r[12] !== ''), p = closed.map(r => Number(r[10])), w = p.filter(x => x >= 0).length;
    return {n: closed.length, w: w, rate: closed.length ? (w / closed.length * 100).toFixed(1) + '%' : '-',
            pnl: closed.reduce((a, r) => a + Number(r[9]), 0)};
  };
  const all = stat(data);
  const rows = [
    ['最終更新', new Date()],
    ['モード', DRY_RUN ? 'お試し（注文は出ていません）' : '本番'],
    ['合計の評価額（円）', Math.round(eqTotal)],
    ['開始時の資産（円）', Math.round(start)],
    ['通算損益（円）', Math.round(eqTotal - start)],
    ['通算リターン', ((eqTotal / start - 1) * 100).toFixed(2) + '%'],
    ['決済済みの取引（全体）', `${all.n}回（勝ち${all.w} / 負け${all.n - all.w}、勝率 ${all.rate}）`],
    ['', ''],
  ];
  COINS.forEach(c => {
    const x = status[c], SYM = c.toUpperCase(), st = stat(data.filter(r => r[1] === SYM));
    const open = JSON.parse(props_().getProperty('OPEN_' + c) || 'null');
    rows.push([`【${SYM}】状態`, x.bal.coin >= MIN_ORDER[c] ? '保有中' : '待機中（円）'],
              [`【${SYM}】シグナル`, x.sig.text],
              [`【${SYM}】評価額（円）`, Math.round(x.bal.jpy + x.bal.coin * x.bid)],
              [`【${SYM}】含み損益（円）`, open ? Math.round(x.bal.coin * x.bid - open.jpy) : '-'],
              [`【${SYM}】決済済み損益（円）`, Math.round(st.pnl)],
              [`【${SYM}】取引回数・勝率`, `${st.n}回（勝率 ${st.rate}）`],
              [`【${SYM}】平均スプレッド（＝成行の往復コスト）`, sprText_(c)], ['', '']);
  });
  s.summary.clear();
  s.summary.getRange(1, 1, rows.length, 2).setValues(rows);
  s.summary.getRange(1, 1, rows.length, 1).setFontWeight('bold');
  s.summary.autoResizeColumns(1, 2);
}

// ================= スプレッドの記録（実際の売買コストの検証用） =================
// 5分ごとの買値・売値の差（%）を集計し、1時間ごとに「スプレッド」シートへ平均・最小・最大を書き出す
function trackSpread_(coin, bid, ask) {
  try {
    if (!(bid > 0 && ask > 0)) return;
    const sp = (ask - bid) / ask * 100, hour = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:00');
    const key = 'SPR_' + coin, all = 'SPRALL_' + coin;
    let h = JSON.parse(props_().getProperty(key) || 'null');
    if (h && h.hour !== hour) {          // 1時間が終わったらシートに書き出す
      retry_(() => sheets_().spread.appendRow([h.hour, coin.toUpperCase(), r4_(h.sum / h.n), r4_(h.min), r4_(h.max), h.n]), 2);
      h = null;
    }
    h = h || {hour: hour, n: 0, sum: 0, min: 999, max: 0};
    h.n++; h.sum += sp; h.min = Math.min(h.min, sp); h.max = Math.max(h.max, sp);
    props_().setProperty(key, JSON.stringify(h));
    const a = JSON.parse(props_().getProperty(all) || '{"n":0,"sum":0,"max":0}');
    a.n++; a.sum += sp; a.max = Math.max(a.max, sp);
    props_().setProperty(all, JSON.stringify(a));
  } catch (e) { console.log('スプレッド記録失敗: ' + e.message); }
}
function sprText_(coin) {
  const a = JSON.parse(props_().getProperty('SPRALL_' + coin) || 'null');
  return a && a.n ? `${(a.sum / a.n).toFixed(3)}%（最大 ${a.max.toFixed(3)}%、${a.n}回計測）` : '計測中';
}
function r4_(x) { return Math.round(x * 10000) / 10000; }

// ================= 取引所ごとのスプレッド比較（Coincheck・bitFlyer・bitbank・GMOコイン） =================
// 5分ごとに各取引所の板の最良の買値・売値を取得し、1時間ごとに「取引所比較」シートへ記録する。
// 「取引所比較まとめ」シートには、平均スプレッド＋往復の手数料＝成行の往復コストを、安い順に表示する。
// 手数料（テイカー・片道%）は各社の公式サイトで確認して、必要なら書き換えること。
const EXCH = {
  coincheck: {name: 'Coincheck', fee: 0.00,
              url: c => `https://coincheck.com/api/ticker?pair=${c}_jpy`, parse: j => [+j.bid, +j.ask]},
  bitflyer:  {name: 'bitFlyer', fee: 0.15,   // 直近30日の取引量で0.01〜0.15%に変動
              url: c => `https://api.bitflyer.com/v1/ticker?product_code=${c.toUpperCase()}_JPY`, parse: j => [+j.best_bid, +j.best_ask]},
  bitbank:   {name: 'bitbank', fee: 0.10,
              url: c => `https://public.bitbank.cc/${c}_jpy/ticker`, parse: j => [+j.data.buy, +j.data.sell]},
  gmo:       {name: 'GMOコイン', fee: 0.05,
              url: c => `https://api.coin.z.com/public/v1/ticker?symbol=${c.toUpperCase()}`, parse: j => [+j.data[0].bid, +j.data[0].ask]},
};

function compareSpreads_() {
  try {
    const keys = [];
    Object.keys(EXCH).forEach(ex => COINS.forEach(c => keys.push([ex, c])));
    const res = UrlFetchApp.fetchAll(keys.map(([ex, c]) => ({url: EXCH[ex].url(c), muteHttpExceptions: true})));
    const hour = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:00');
    let h = JSON.parse(props_().getProperty('XSPR') || 'null');
    const all = JSON.parse(props_().getProperty('XSPRALL') || '{}');
    if (h && h.hour !== hour) {                       // 1時間が終わったら書き出す
      const rows = Object.keys(h.s).map(k => {
        const [ex, c] = k.split('|'), x = h.s[k];
        return [h.hour, EXCH[ex].name, c.toUpperCase(), x.n ? r4_(x.sum / x.n) : '', x.n ? r4_(x.max) : '', x.n, x.err];
      });
      if (rows.length) retry_(() => { const sh = sheets_().xspread; sh.getRange(sh.getLastRow() + 1, 1, rows.length, 7).setValues(rows); }, 2);
      h = null;
    }
    h = h || {hour: hour, s: {}};
    res.forEach((r, i) => {
      const [ex, c] = keys[i], k = ex + '|' + c;
      const s = h.s[k] = h.s[k] || {n: 0, sum: 0, max: 0, err: 0};
      const a = all[k] = all[k] || {n: 0, sum: 0, max: 0, err: 0};
      try {
        if (r.getResponseCode() !== 200) throw new Error('HTTP ' + r.getResponseCode());
        const [bid, ask] = EXCH[ex].parse(JSON.parse(r.getContentText()));
        if (!(bid > 0 && ask > 0 && ask >= bid)) throw new Error('値が不正');
        const sp = (ask - bid) / ask * 100;
        s.n++; s.sum += sp; s.max = Math.max(s.max, sp);
        a.n++; a.sum += sp; a.max = Math.max(a.max, sp);
      } catch (e) { s.err++; a.err++; }
    });
    props_().setProperty('XSPR', JSON.stringify(h));
    props_().setProperty('XSPRALL', JSON.stringify(all));
    writeXSummary_(all);
  } catch (e) { console.log('取引所比較の失敗: ' + e.message); }
}

function writeXSummary_(all) {
  const rows = Object.keys(all).map(k => {
    const [ex, c] = k.split('|'), a = all[k], avg = a.n ? a.sum / a.n : null;
    return [EXCH[ex].name, c.toUpperCase(), avg === null ? '' : r4_(avg), EXCH[ex].fee,
            avg === null ? '' : r4_(avg + EXCH[ex].fee * 2), a.n ? r4_(a.max) : '', a.n, a.err];
  }).sort((x, y) => x[1] !== y[1] ? x[1].localeCompare(y[1]) : (x[4] === '' ? 99 : x[4]) - (y[4] === '' ? 99 : y[4]));
  const sh = sheets_().xsummary;
  sh.clear();
  const head = [['取引所', '銘柄', '平均スプレッド(%)', '手数料・片道(%)', '成行の往復コスト(%)', '最大スプレッド(%)', '計測回数', '取得エラー']];
  sh.getRange(1, 1, 1, 8).setValues(head);
  sh.getRange(1, 1, 1, 8).setFontWeight('bold');
  if (rows.length) sh.getRange(2, 1, rows.length, 8).setValues(rows);
  sh.getRange(rows.length + 3, 1).setValue('成行の往復コスト＝平均スプレッド＋手数料×2。銘柄ごとに安い順。手数料は各社の最新情報で要確認。');
}

// ================= 失敗に強くするための仕組み =================
// 一時的な通信エラーに備えて、読み取り系の処理は数回やり直す（注文は二重発注を防ぐため再試行しない）
function retry_(fn, tries) {
  let err;
  for (let i = 0; i < (tries || 3); i++) {
    try { return fn(); } catch (e) { err = e; Utilities.sleep(2000 * (i + 1)); }
  }
  throw err;
}
function fetchJson_(url) {
  return retry_(() => {
    const r = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
    if (r.getResponseCode() >= 500) throw new Error(`HTTP ${r.getResponseCode()}: ${url}`);
    return JSON.parse(r.getContentText());
  });
}
// 取引履歴への書き込み。失敗したら内容を保存しておき、次の実行で書き込む
function record_(op) {
  try { applyRecord_(op); }
  catch (e) {
    const q = JSON.parse(props_().getProperty('PENDING') || '[]'); q.push(op);
    props_().setProperty('PENDING', JSON.stringify(q));
    console.log('取引履歴の書き込みを保留: ' + e.message);
  }
}
function applyRecord_(op) {
  retry_(() => {
    const sh = sheets_().trades;
    if (op.type === 'buy') {
      op.row[0] = sh.getLastRow();          // No（何回目の取引か）
      sh.appendRow(op.row);
      const open = JSON.parse(props_().getProperty('OPEN_' + op.coin) || 'null');
      if (open && open.time === op.time) { open.row = sh.getLastRow(); props_().setProperty('OPEN_' + op.coin, JSON.stringify(open)); }
    } else {
      const open = op.row ? {row: op.row} : findOpenRow_(op.sym);
      if (open && open.row) sh.getRange(open.row, 7, 1, 7).setValues([op.values]);
    }
  });
}
function flushPending_() {
  const q = JSON.parse(props_().getProperty('PENDING') || '[]');
  if (!q.length) return;
  const left = [];
  q.forEach(op => { try { applyRecord_(op); } catch (e) { left.push(op); } });
  if (left.length) props_().setProperty('PENDING', JSON.stringify(left)); else props_().deleteProperty('PENDING');
  if (left.length < q.length) log_(`保留していた取引履歴を${q.length - left.length}件書き込みました`);
}

// ================= シート・通知・補助 =================
function sheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const get = (name, header) => {
    let sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); if (header) { sh.appendRow(header); sh.setFrozenRows(1); sh.getRange(1, 1, 1, header.length).setFontWeight('bold'); } }
    return sh;
  };
  return {
    summary: get('サマリー'),
    trades: get('取引履歴', ['No', '銘柄', 'エントリー日時', 'エントリー価格', '数量', '投入額(円)', '決済日時', '決済価格',
                            '受取額(円)', '損益(円)', '損益率(%)', '保有時間(h)', '結果', 'モード']),
    log: get('ログ', ['日時', '内容']),
    spread: get('スプレッド', ['時間帯', '銘柄', '平均スプレッド(%)', '最小(%)', '最大(%)', '計測回数']),
    xspread: get('取引所比較', ['時間帯', '取引所', '銘柄', '平均スプレッド(%)', '最大(%)', '計測回数', '取得エラー']),
    xsummary: get('取引所比較まとめ')
  };
}
function log_(msg) {
  console.log(msg);
  try { retry_(() => sheets_().log.appendRow([new Date(), msg]), 2); } catch (e) { console.log('ログの書き込み失敗: ' + e.message); }
}
function notify_(subject, body) {
  const mode = DRY_RUN ? '【お試し】' : '【本番】';
  if (NOTIFY_EMAIL) {
    try { MailApp.sendEmail(NOTIFY_EMAIL, `[ダウ版 bot] ${mode}${subject}`, body); }
    catch (e) { console.log('メール送信失敗: ' + e.message); }
  }
  if (DISCORD_URL) {
    try {
      UrlFetchApp.fetch(DISCORD_URL, {method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({content: `**[ダウ版] ${mode}${subject}**\n${body}`})});
    } catch (e) { console.log('Discord送信失敗: ' + e.message); }
  }
}
function jst_(t) { return Utilities.formatDate(new Date(t), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'); }
function round8_(x) { return Math.round(x * 1e8) / 1e8; }
function props_() { return PropertiesService.getScriptProperties(); }

// ================= Coincheck 認証付きAPI =================
let NONCE_ = 0;
function ccPrivate_(method, path, body) {
  const url = 'https://coincheck.com' + path;
  NONCE_ = Math.max(Date.now() * 1000, NONCE_ + 1);   // 連続で呼んでも必ず増えるように
  const nonce = String(NONCE_);
  const bodyStr = body ? JSON.stringify(body) : '';
  const raw = Utilities.computeHmacSha256Signature(nonce + url + bodyStr, props_().getProperty('CC_SECRET'));
  const sig = raw.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  const opt = {method: method, contentType: 'application/json', muteHttpExceptions: true,
               headers: {'ACCESS-KEY': props_().getProperty('CC_KEY'), 'ACCESS-NONCE': nonce, 'ACCESS-SIGNATURE': sig}};
  if (bodyStr) opt.payload = bodyStr;
  const r = JSON.parse(UrlFetchApp.fetch(url, opt).getContentText());
  if (!r.success) throw new Error('Coincheck: ' + JSON.stringify(r));
  return r;
}
