/**
 * 15分足GC版 BTC＋ETH 組み合わせbot
 * ルール（銘柄ごと）：「15分足EMA50 > EMA200」かつ「4時間足の終値 > EMA200」の間だけ保有
 * 資金は銘柄ごとに BUDGET_JPY × 配分 で分け、それぞれの予算の範囲だけで売買する
 * Coincheck 現物・ロングのみ ― Google Apps Script版（取引履歴・サマリー付き）
 *
 * 準備:
 *  1. 新しいスプレッドシート →「拡張機能」→「Apps Script」にこのコードを貼って保存
 *  2. 「プロジェクトの設定」→「スクリプト プロパティ」に次を登録（コードには書かない）
 *       NOTIFY_EMAIL … 通知先のメールアドレス（不要なら登録しない）
 *       DISCORD_URL  … 通知先のDiscord Webhook URL（不要なら登録しない）
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
  keys.forEach(k => p.deleteProperty(k));
  const s = sheets_();
  if (s.trades.getLastRow() > 1) s.trades.deleteRows(2, s.trades.getLastRow() - 1);
  log_('記録をリセットしました');
}
function testNotify() { notify_('テスト通知', 'BTC＋ETH botからの通知テストです。これが届いていれば設定OKです。'); }

// ================= メイン =================
function main() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  const status = {};
  try {
    COINS.forEach(c => { status[c] = stepCoin_(c, null); });   // 残高は銘柄ごとに最新を取得
    summary_(status);
  } catch (e) {
    log_('✖ エラー: ' + e.message);
    const last = JSON.parse(props_().getProperty('LAST_ERR') || '{}');
    if (last.msg !== e.message || Date.now() - last.t > 3600000) {
      notify_('botエラー', e.message);
      props_().setProperty('LAST_ERR', JSON.stringify({msg: e.message, t: Date.now()}));
    }
  } finally { lock.releaseLock(); }
}

function stepCoin_(coin, account) {
  const SYM = coin.toUpperCase(), sig = signal_(coin);
  const t = JSON.parse(UrlFetchApp.fetch('https://coincheck.com/api/ticker?pair=' + coin + '_jpy').getContentText());
  const bid = Number(t.bid), ask = Number(t.ask);
  let bal = balance_(coin, account);
  const holding = bal.coin >= MIN_ORDER[coin];

  if (sig.want && !holding) {
    const amountJpy = Math.floor(bal.jpy * USE_RATIO);
    if (amountJpy / ask < MIN_ORDER[coin]) {
      if (new Date().getMinutes() < 5) log_(`⚠ ${SYM}: 予算が最小注文数量（${MIN_ORDER[coin]}${SYM}）に届かず買えません`);
    } else {
      const after = buy_(coin, amountJpy, ask, bal);
      const got = after.coin - bal.coin, paid = bal.jpy - after.jpy, price = paid / got;
      const sh = sheets_().trades;
      sh.appendRow([sh.getLastRow(), SYM, new Date(), Math.round(price), round8_(got), Math.round(paid),
                    '', '', '', '', '', '', '', DRY_RUN ? 'お試し' : '本番']);
      props_().setProperty('OPEN_' + coin, JSON.stringify({row: sh.getLastRow(), time: Date.now(), jpy: paid}));
      log_(`▶ ${SYM} 買い ${Math.round(paid).toLocaleString()}円 → ${round8_(got)}${SYM} @${Math.round(price).toLocaleString()} | ${sig.text}`);
      notify_(`${SYM}買い`, `${Math.round(paid).toLocaleString()}円分を買いました\n価格 ${Math.round(price).toLocaleString()}円 / 数量 ${round8_(got)} ${SYM}\n${sig.text}`);
      bal = after;
    }
  } else if (!sig.want && holding) {
    const amount = Math.floor(bal.coin * 1e8) / 1e8;
    const after = sell_(coin, amount, bid, bal);
    const got = after.jpy - bal.jpy, price = got / amount;
    const open = JSON.parse(props_().getProperty('OPEN_' + coin) || 'null') || findOpenRow_(SYM);
    if (open) {
      const pnl = got - open.jpy, pct = pnl / open.jpy * 100, hrs = (Date.now() - open.time) / 3600000;
      sheets_().trades.getRange(open.row, 7, 1, 7).setValues([[new Date(), Math.round(price), Math.round(got),
        Math.round(pnl), Math.round(pct * 100) / 100, Math.round(hrs * 10) / 10, pnl >= 0 ? '勝ち' : '負け']]);
      log_(`▶ ${SYM} 売り ${amount}${SYM} @${Math.round(price).toLocaleString()} 損益 ${Math.round(pnl).toLocaleString()}円（${pct.toFixed(2)}%）保有${hrs.toFixed(1)}時間 | ${sig.text}`);
      notify_(pnl >= 0 ? `${SYM}売り（勝ち）` : `${SYM}売り（負け）`,
        `損益 ${Math.round(pnl).toLocaleString()}円（${pct.toFixed(2)}%）/ 保有 ${hrs.toFixed(1)}時間\n決済価格 ${Math.round(price).toLocaleString()}円\n${sig.text}`);
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
function closes_(coin, interval) {
  const url = `https://api.kraken.com/0/public/OHLC?pair=${KRAKEN_PAIR[coin]}&interval=${interval}`;
  const r = JSON.parse(UrlFetchApp.fetch(url, {muteHttpExceptions: true}).getContentText());
  if (r.error && r.error.length) throw new Error('Kraken: ' + r.error.join(','));
  const key = Object.keys(r.result).find(k => k !== 'last');
  return r.result[key].slice(0, -1).map(x => Number(x[4]));
}
function ema_(arr, p) { const a = 2 / (p + 1); let e = arr[0]; for (let i = 1; i < arr.length; i++) e = a * arr[i] + (1 - a) * e; return e; }
function signal_(coin) {
  const c15 = closes_(coin, 15), c4 = closes_(coin, 240);
  const f = ema_(c15, 50), s = ema_(c15, 200), e4 = ema_(c4, 200), l4 = c4[c4.length - 1];
  const gc = f > s, up4 = l4 > e4;
  return {want: gc && up4,
          text: `15分 EMA50 ${f.toFixed(0)} / EMA200 ${s.toFixed(0)} → ${gc ? 'GC' : 'DC'}｜4H 終値 ${l4.toFixed(0)} / EMA200 ${e4.toFixed(0)} → ${up4 ? '上' : '下'}`};
}

// ================= 残高・売買（銘柄ごとの予算帳簿） =================
function budget_(coin) { return BUDGET_JPY * WEIGHTS[coin]; }
function balance_(coin, account) {
  if (DRY_RUN) {
    const s = JSON.parse(props_().getProperty('SIM_' + coin) || JSON.stringify({jpy: budget_(coin), coin: 0}));
    return {jpy: s.jpy, coin: s.coin};
  }
  const b = account || ccPrivate_('get', '/api/accounts/balance');
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
              [`【${SYM}】取引回数・勝率`, `${st.n}回（勝率 ${st.rate}）`], ['', '']);
  });
  s.summary.clear();
  s.summary.getRange(1, 1, rows.length, 2).setValues(rows);
  s.summary.getRange(1, 1, rows.length, 1).setFontWeight('bold');
  s.summary.autoResizeColumns(1, 2);
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
    log: get('ログ', ['日時', '内容'])
  };
}
function log_(msg) { sheets_().log.appendRow([new Date(), msg]); console.log(msg); }
function notify_(subject, body) {
  const mode = DRY_RUN ? '【お試し】' : '【本番】';
  if (NOTIFY_EMAIL) {
    try { MailApp.sendEmail(NOTIFY_EMAIL, `[BTC+ETH bot] ${mode}${subject}`, body); }
    catch (e) { console.log('メール送信失敗: ' + e.message); }
  }
  if (DISCORD_URL) {
    try {
      UrlFetchApp.fetch(DISCORD_URL, {method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({content: `**[BTC+ETH] ${mode}${subject}**\n${body}`})});
    } catch (e) { console.log('Discord送信失敗: ' + e.message); }
  }
}
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
