const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const firebaseConfig = JSON.parse(
  fs.readFileSync(path.join(root, 'firebase.json'), 'utf8')
);
const fundingForgeHtml = fs.readFileSync(
  path.join(root, firebaseConfig.hosting.public, 'FundingForge.html'),
  'utf8'
);
const dashboardStyles = fs.readFileSync(
  path.join(root, firebaseConfig.hosting.public, 'dashboard-theme.css'),
  'utf8'
);
const dashboardHtml = fundingForgeHtml.match(
  /<section id="dashboard"[^>]*>([\s\S]*?)<section id="dfWhyChoose"/
)?.[1];

test('Crazy Funded dashboard uses its live data components without reference sample data', () => {
  assert.ok(dashboardHtml, 'expected the user dashboard section');
  assert.match(dashboardHtml, /CRAZY <b>FUNDED<\/b>/);
  assert.match(fundingForgeHtml, /<section id="dashboard" data-theme="dark">/);
  assert.match(dashboardHtml, /crazy-funded-logo\.png/);
  assert.match(dashboardHtml, /width="36" height="36"/);
  const dashboardHeader = dashboardHtml.match(/<div class="dash-top" id="dashTop">([\s\S]*?)<div class="dashboard-header-controls">/)?.[1];
  assert.match(dashboardHeader || '', /<h1 id="dashboardGreeting">Account details<\/h1>/);
  assert.doesNotMatch(dashboardHeader || '', /dashboard-breadcrumb|Trading desk/);
  assert.match(dashboardStyles, /#dashboard #dashboardGreeting \{\s*margin: 0;\s*color: var\(--tx\);\s*font-size: clamp\(30px, 3\.2vw, 40px\);/);
  assert.match(dashboardStyles, /#dashboard #dashboardGreeting \.dashboard-greeting-name \{\s*color: var\(--ac\);/);
  assert.ok(fs.existsSync(path.join(root, firebaseConfig.hosting.public, 'crazy-funded-logo.png')));
  assert.doesNotMatch(dashboardHtml, /Envy Funded|4821|\$217,952\.01|\$200,000/);
  const ids = [...dashboardHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'dashboard IDs must remain unique');
  for (const id of [
    'accountTitle',
    'dBalance',
    'dBalanceSub',
    'dEquity',
    'dEquitySub',
    'dWithdraw',
    'dDays',
    'dDaysSub',
    'deskObjectives',
    'deskPerformanceChart',
    'deskPerformanceSummary',
    'deskStatisticsGrid',
    'deskActivityCalendar',
    'deskPositionsTable',
    'deskHistoryTable'
  ]) {
    assert.match(dashboardHtml, new RegExp(`id="${id}"`), `expected live dashboard field ${id}`);
  }
  assert.match(fundingForgeHtml, /desk-objective-progress-fill/);
  assert.match(fundingForgeHtml, /appendPerformanceSummary\('Starting balance'/);
  assert.match(fundingForgeHtml, /appendPerformanceSummary\('Current balance'/);
  assert.match(fundingForgeHtml, /appendPerformanceSummary\('Highest balance'/);
  assert.match(fundingForgeHtml, /appendPerformanceSummary\('Max drawdown used'/);
  assert.match(fundingForgeHtml, /profitTargetBalance: profitTarget !== null/);
  assert.match(fundingForgeHtml, /maxLossBalance: maxDrawdownLimit !== null/);
  assert.match(fundingForgeHtml, /drawdownMetrics\.daily_percent_used/);
  assert.match(fundingForgeHtml, /drawdownMetrics\.max_percent_used/);
  assert.match(fundingForgeHtml, /desk-chart-threshold is-profit-target/);
  assert.match(fundingForgeHtml, /desk-chart-threshold is-max-loss/);
  assert.match(fundingForgeHtml, /account-status-badge is-active/);
  assert.match(fundingForgeHtml, /statusBadge\.classList\.toggle\('is-active',data\.status === 'active'\)/);
  assert.match(fundingForgeHtml, /statusBadge\.classList\.toggle\('is-rejected',rejected\)/);
  assert.match(fundingForgeHtml, /statusBadge\.classList\.toggle\('is-pending',pending\)/);
  assert.match(dashboardStyles, /#dashboard \.account-status-badge\.is-active \{\s*padding: 0;\s*border: 0;\s*border-radius: 0;\s*background: transparent;\s*color: var\(--up\);/);
  assert.match(dashboardStyles, /#dashboard \.account-status-badge\.is-rejected \{\s*padding: 0;\s*border: 0;\s*border-radius: 0;\s*background: transparent;\s*color: var\(--dn\);/);
  assert.match(dashboardStyles, /#dashboard \.account-select-option-status\.is-active \{\s*padding: 0;\s*border: 0;\s*border-radius: 0;\s*background: transparent;\s*color: var\(--up\);/);
  assert.match(dashboardStyles, /#dashboard \.account-select-option-status\.is-rejected \{\s*padding: 0;\s*border: 0;\s*border-radius: 0;\s*background: transparent;\s*color: var\(--dn\);/);
  assert.doesNotMatch(dashboardStyles, /account-badge\.is-(?:active|rejected)::before/);
  assert.doesNotMatch(dashboardHtml, /accountEngineId/);
  assert.doesNotMatch(fundingForgeHtml, /engineIdBadge|ENGINE ['"] \+ data\.tradingEngineAccountId/);
});

test('consistency objective shows percentage used against its limit', () => {
  assert.match(fundingForgeHtml, /const limitUsage = consistencyLimit > 0 \? ratio \/ consistencyLimit \* 100 : null;/);
  assert.match(fundingForgeHtml, /limitUsage\.toFixed\(0\) \+ '% of limit'/);
  assert.match(fundingForgeHtml, /'is-alert',limitUsage,passed \? 'is-up' : 'is-dn'/);
});

test('qualifying trading days come from the authoritative Worker account result', () => {
  assert.match(dashboardHtml || '', /<span>Qualifying days<\/span>/);
  assert.match(fundingForgeHtml, /deskLiveAccountSnapshot\.qualifying_trading_days/);
  assert.match(fundingForgeHtml, /deskNumber\(account && account\.qualifying_trading_days\)/);
  assert.match(fundingForgeHtml, /0\.5% net realized/);
  assert.doesNotMatch(fundingForgeHtml, /data\.tradingDays/);
});

test('dashboard controls retain working destinations and existing handlers', () => {
  assert.ok(dashboardHtml, 'expected the user dashboard section');
  assert.match(fundingForgeHtml, /const firstName = user && typeof user\.displayName === 'string'\s*\? user\.displayName\.trim\(\)\.split\(\/\\s\+\/\)\[0\]/);
  assert.match(fundingForgeHtml, /dashboardSalutation\(new Date\(\)\.getHours\(\)\)/);
  assert.match(fundingForgeHtml, /name\.textContent = firstName;/);
  assert.doesNotMatch(fundingForgeHtml, /greeting\.textContent = 'Hello, '/);
  for (const view of [
    'desk',
    'rewards',
    'referrals',
    'competitions',
    'calendar',
    'leaderboard'
  ]) {
    assert.match(dashboardHtml, new RegExp(`data-dashboard-view="${view}"`));
  }
  for (const icon of [
    'dashboard-nav-desk',
    'dashboard-nav-rewards',
    'dashboard-nav-referrals',
    'dashboard-nav-competitions',
    'dashboard-nav-calendar',
    'dashboard-nav-leaderboard'
  ]) {
    assert.match(dashboardHtml, new RegExp(`class="dashboard-nav-mark ${icon}"`));
  }
  assert.match(dashboardStyles, /#dashboard \.dashboard-side-nav a\.active \.dashboard-nav-mark,\s*#dashboard \.dashboard-side-nav a:hover \.dashboard-nav-mark \{\s*color: var\(--ac\);/);
  assert.match(dashboardStyles, /#dashboard \.dashboard-nav-mark svg \{\s*width: 16px;\s*height: 16px;\s*fill: none;\s*stroke: currentColor;/);
  assert.match(dashboardHtml, /class="dashboard-trade-link" href="\/trade\/"/);
  assert.match(dashboardHtml, /id="dashboardAccountAction"/);
  assert.match(dashboardHtml, /id="accountSelectTrigger"/);
  assert.match(dashboardHtml, /aria-labelledby="accountSelectorLabel accountSelectorValue"/);
  assert.doesNotMatch(dashboardHtml, /accountSelectorStatus|account-select-trigger-status/);
  assert.match(fundingForgeHtml, /status\.textContent = accountPickerStatus\(account\);/);
  assert.match(dashboardHtml, /id="dashboardThemeToggle"/);
  assert.match(dashboardHtml, /id="dashboardThemeToggle" role="switch"[^>]*aria-checked="false"/);
  assert.match(dashboardHtml, /dashboard-theme-switch-track/);
  const accountOverview = dashboardHtml.match(
    /<div class="account-banner" id="accountOverview">([\s\S]*?)<div class="account-stat-grid">/
  )?.[1];
  assert.match(accountOverview || '', /<a class="dashboard-trade-link" href="\/trade\/" hidden>/);
  const sidebarNavigation = dashboardHtml.match(
    /<nav class="dashboard-side-nav"[\s\S]*?<\/nav>/
  )?.[0];
  assert.doesNotMatch(sidebarNavigation || '', /dashboard-trade-link/);
  assert.match(fundingForgeHtml, /const tradingActive = data\.status === 'active' && data\.tradingEnabled === true;/);
  assert.match(fundingForgeHtml, /tradeButton\.hidden = !tradingActive;/);
  assert.match(fundingForgeHtml, /dashboard-theme\.css'\) \+ '\?v=20261112-calendar-trade-counts'/);
  assert.match(dashboardStyles, /#dashboard \.dashboard-theme-toggle > span:last-child \{\s*min-width: 12px;\s*color: var\(--tx\);/);
  assert.match(dashboardStyles, /#dashboard \.dashboard-theme-toggle\[aria-checked="true"\] \.dashboard-theme-switch-thumb \{\s*background: var\(--tx\);/);
  assert.match(dashboardHtml, />TRADE<\/a>/);
  assert.match(dashboardHtml, /data-performance-range="1D"/);
  assert.match(dashboardHtml, /data-performance-range="1W"/);
  assert.match(dashboardHtml, /data-performance-range="1M"/);
  assert.match(dashboardHtml, /data-performance-range="ALL"/);
  assert.doesNotMatch(dashboardHtml, /data-performance-range="(?:7D|30D|90D)"/);
  assert.match(fundingForgeHtml, /const rangeMilliseconds = \{'1D':86400000,'1W':7\*86400000,'1M':30\*86400000\}/);
  assert.match(fundingForgeHtml, /const duration = \{'1D':1,'1W':7,'1M':30\}\[button\.dataset\.performanceRange\] \* 86400000/);
  assert.match(dashboardStyles, /#dashboard \.dashboard-sidebar \{\s*position: fixed;\s*inset: 0 auto 0 0;/);
  assert.match(dashboardStyles, /@media \(max-width: 999px\) \{[\s\S]*?#dashboard \.dashboard-sidebar \{\s*position: sticky;\s*inset: 0 auto auto;/);
  assert.match(dashboardStyles, /#dashboard \.dashboard-main\.wrap \{\s*grid-column: 2;/);
  assert.match(fundingForgeHtml, /function signOutFirebase\(\)/);
  assert.match(fundingForgeHtml, /signOutFirebase\(\)/);
  assert.match(fundingForgeHtml, /renderDeskPerformanceChart\(button\.dataset\.performanceRange\)/);
  assert.match(fundingForgeHtml, /const dashboardThemeStorageKey = 'crazyFundedDeskTheme'/);
  assert.match(fundingForgeHtml, /localStorage\.getItem\(dashboardThemeStorageKey\)/);
  assert.match(fundingForgeHtml, /localStorage\.setItem\(dashboardThemeStorageKey,activeTheme\)/);
  assert.match(fundingForgeHtml, /dashboard\.dataset\.theme = activeTheme/);
  assert.match(fundingForgeHtml, /dashboardThemeToggle\.setAttribute\('aria-checked',String\(activeTheme === 'light'\)\)/);
  assert.match(fundingForgeHtml, /activeTheme === 'dark' \? '☀' : '☾'/);
  assert.match(fundingForgeHtml, /activeTheme === 'light'\)\)/);
  assert.match(fundingForgeHtml, /const deskSignedMoney = value =>/);
  assert.match(fundingForgeHtml, /number > 0 \? '\+\$' : number < 0 \? '−\$'/);
  assert.doesNotMatch(fundingForgeHtml, /data-dashboard-theme/);
});

test('dashboard greeting uses morning, afternoon, and evening at local-hour boundaries', () => {
  const salutationFunction = fundingForgeHtml.match(/function dashboardSalutation\(hour\)\{[\s\S]*?\r?\n\}/);
  assert.ok(salutationFunction, 'expected the dashboard salutation helper');
  const getSalutation = new Function(`${salutationFunction[0]}; return dashboardSalutation;`)();
  assert.equal(getSalutation(11), 'Good morning, ');
  assert.equal(getSalutation(12), 'Good afternoon, ');
  assert.equal(getSalutation(17), 'Good afternoon, ');
  assert.equal(getSalutation(18), 'Good evening, ');
});

test('dashboard navigation remains horizontally accessible on small screens', () => {
  assert.match(dashboardStyles, /\.dashboard-brand \{\s*display: flex;\s*align-items: center;/);
  assert.match(dashboardStyles, /\.account-select-native \{\s*position: absolute !important;\s*width: 1px !important;/);
  assert.match(dashboardStyles, /@media \(max-width: 999px\)/);
  assert.match(dashboardStyles, /\.dashboard-side-nav \{[\s\S]*?overflow-x: auto/);
  assert.match(dashboardStyles, /#dashboard \.account-select-trigger \{\s*flex: 1;\s*min-width: 0;\s*max-width: 100%;/);
  assert.match(dashboardStyles, /#dashboard \.account-badges \{\s*display: flex;/);
  assert.match(dashboardStyles, /#dashboard \.account-badges \.dashboard-trade-link \.dashboard-nav-mark svg \{\s*width: 14px;\s*height: 14px;\s*fill: none;\s*stroke: currentColor;/);
  assert.match(dashboardStyles, /@media \(min-width: 1000px\) and \(max-width: 1200px\) \{[\s\S]*?#dashboard \.dashboard-rule-grid \{\s*display: grid;\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(dashboardStyles, /#dashboard \.dashboard-main \.btn-primary \{\s*background: var\(--ac\);\s*color: var\(--onac\);/);
  assert.match(dashboardStyles, /#dashboard \.dash-close \{\s*min-height: 40px;[\s\S]*?background: var\(--panel\);/);
});

test('dashboard amounts shorten on phones and preserve exact values elsewhere', () => {
  const numberDeclaration = fundingForgeHtml.match(/const deskNumber = [^\n]+/);
  const compactMoneyFunction = fundingForgeHtml.match(/function deskCompactMoney\(value,signed=false\)\{[\s\S]*?\n\}/);
  assert.ok(numberDeclaration);
  assert.ok(compactMoneyFunction);
  const formatCompactMoney = new Function(
    `${numberDeclaration[0]}\n${compactMoneyFunction[0]}\nreturn deskCompactMoney;`
  )();
  assert.equal(formatCompactMoney(10000), '$10k');
  assert.equal(formatCompactMoney(12500), '$12.5k');
  assert.equal(formatCompactMoney(-10000, true), '−$10k');
  assert.match(fundingForgeHtml, /matchMedia\('\(max-width: 640px\)'\)/);
  assert.match(fundingForgeHtml, /addEventListener\('change',updateDeskResponsiveMoney\)/);
  assert.match(fundingForgeHtml, /element\.title = exact/);
  assert.match(fundingForgeHtml, /function renderDeskAccountTitle\(size\)/);
  assert.match(fundingForgeHtml, /title\.setAttribute\('aria-label',exactAmount \+ ' challenge'\)/);
  assert.match(dashboardStyles, /@media \(max-width: 640px\) \{\s*#dashboard \.desk-account-title-full \{\s*display: none;/);
  assert.match(dashboardStyles, /@media \(min-width: 1000px\) and \(max-width: 1200px\)[\s\S]*?\.account-stat-grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(dashboardStyles, /#dashboard \.account-stat b \{\s*display: block;\s*min-width: 0;\s*overflow-wrap: anywhere;/);
  assert.match(dashboardStyles, /#dashboard \.desk-chart-tooltip strong,[\s\S]*?overflow-wrap: anywhere;/);
});

test('dashboard computes live drawdown only when current-day trading history is complete', () => {
  const numberDeclaration = fundingForgeHtml.match(/const deskNumber = [^\n]+/);
  const dateFunction = fundingForgeHtml.match(/const deskDate = value => \{[\s\S]*?\n\};/);
  const drawdownFunction = fundingForgeHtml.match(/function deskComputeDrawdownMetrics\(account,rules,trades,positions,today=new Date\(\)\)\{[\s\S]*?\n\}/);
  assert.ok(numberDeclaration);
  assert.ok(dateFunction);
  assert.ok(drawdownFunction);
  const calculateDrawdown = new Function(
    `${numberDeclaration[0]}\n${dateFunction[0]}\n${drawdownFunction[0]}\nreturn deskComputeDrawdownMetrics;`
  )();
  const today = new Date('2026-11-11T12:00:00.000Z');
  const account = {
    market_data_status: 'live',
    starting_balance: 10000,
    balance: 9900,
    equity: 9950,
  };
  const rules = {
    daily_drawdown_type: 'START_OF_DAY_EQUITY',
    max_drawdown_type: 'STATIC',
  };
  const trades = [{
    opened_at: '2026-11-11T09:00:00.000Z',
    closed_at: '2026-11-11T09:30:00.000Z',
    realized_pnl: -100,
  }];
  const positions = [{
    opened_at: '2026-11-11T10:00:00.000Z',
    floating_pnl: 50,
    market_data_status: 'live',
  }];

  const current = calculateDrawdown(account,rules,trades,positions,today);
  assert.equal(current.daily_percent_used, 0.5);
  assert.equal(current.max_percent_used, 0.5);

  const overnight = calculateDrawdown(account,rules,trades,[{
    ...positions[0],
    opened_at: '2026-11-10T23:00:00.000Z',
  }],today);
  assert.equal(overnight.daily_percent_used, null);

  const sparkRules = {
    daily_drawdown_type: 'START_OF_DAY_EQUITY',
    max_drawdown_type: 'TRAILING',
    high_water_mark: 12000,
    high_water_mark_tracking_complete: 1,
  };
  const spark = calculateDrawdown({
    ...account,
    balance: 11000,
    equity: 11000,
  },sparkRules,[],[],today);
  assert.ok(Math.abs(spark.max_percent_used - 100 / 12) < 1e-12);

  const legacySpark = calculateDrawdown({
    ...account,
    balance: 11000,
    equity: 11000,
  },{...sparkRules,high_water_mark_tracking_complete:0},[],[],today);
  assert.equal(legacySpark.max_percent_used, null);
});

test('calendar day cells show trade counts beside compact P/L on narrow screens', () => {
  const calendarRenderer = fundingForgeHtml.match(
    /function renderDeskActivity\(trades\)\{([\s\S]*?)\r?\n\}\r?\nfunction renderDeskSessionAnalytics/
  )?.[1];
  const calendarFormatter = fundingForgeHtml.match(/function formatDeskCalendarPnl\(value\)\{[\s\S]*?\n\}/);
  assert.ok(calendarRenderer);
  assert.ok(calendarFormatter);
  const formatCalendarPnl = new Function(
    'deskCompactMoneyQuery',
    `function formatDeskSessionPnl(value){return 'desktop:' + value;}\n${calendarFormatter[0]}\nreturn formatDeskCalendarPnl;`
  )({ matches: true });
  assert.equal(formatCalendarPnl(131800), '+132k');
  assert.equal(formatCalendarPnl(-344.9), '−345');
  assert.equal(formatCalendarPnl(45.6), '+45.6');
  assert.equal(formatCalendarPnl(1.25), '+1.25');
  assert.equal(formatCalendarPnl(999500), '+1m');
  assert.match(fundingForgeHtml, /function deskSetCalendarPnl\(element,value\)/);
  assert.match(fundingForgeHtml, /deskSetCalendarPnl\(pnl,activity\.pnl\)/);
  assert.match(fundingForgeHtml, /data-desk-calendar-pnl/);
  assert.match(fundingForgeHtml, /element\.title = deskSignedMoney\(number\)/);
  assert.match(calendarRenderer, /count\.textContent = String\(activity\.count\)/);
  assert.match(calendarRenderer, /detail\.append\(pnl,count\)/);
  assert.match(dashboardStyles, /#dashboard \.desk-calendar-detail \{\s*display: flex;\s*align-items: center;\s*justify-content: space-between;/);
  assert.match(dashboardStyles, /#dashboard \.desk-calendar-count \{\s*flex: none;/);
  assert.match(dashboardStyles, /#dashboard \.desk-calendar-pnl \{\s*display: block;\s*flex: 1;\s*width: auto;\s*min-width: 0;\s*overflow: hidden;/);
  assert.match(dashboardStyles, /@media \(max-width: 420px\) \{[\s\S]*?#dashboard \.desk-calendar-pnl \{\s*font-size: 7px;/);
  assert.match(dashboardStyles, /@media \(max-width: 420px\) \{[\s\S]*?#dashboard \.desk-calendar-count \{\s*font-size: 8px;/);
});

test('session analytics no longer includes the win-rate flip side or stray text', () => {
  const sessionRenderer = fundingForgeHtml.match(
    /function renderDeskSessionAnalytics\(trades\)\{([\s\S]*?)\n\}\nfunction formatDeskSessionPnl/
  )?.[1];
  assert.ok(sessionRenderer, 'expected the session analytics renderer');
  assert.doesNotMatch(sessionRenderer, /Session edge matrix|desk-session-face-title/);
  assert.match(sessionRenderer, /grid\.className = 'desk-session-grid'/);
  assert.match(sessionRenderer, /card\.className = 'desk-session-summary'/);
  assert.match(sessionRenderer, /desk-session-gauge-value/);
  assert.match(sessionRenderer, /gaugeLabel\.textContent = winRate === null \? '—' : winRate\.toFixed\(0\) \+ '%'/);
  assert.match(sessionRenderer, /tradesLabel\.textContent = 'Trades'/);
  assert.doesNotMatch(sessionRenderer, /Avg R|averageLabel|averageMetric/);
  assert.match(sessionRenderer, /net\.classList\.add\(session\.netPnl > 0 \? 'is-positive' : 'is-negative'\)/);
  assert.doesNotMatch(sessionRenderer, /desk-session-table|createElement\('table'\)/);
  assert.match(dashboardStyles, /#dashboard \.desk-session-summary \{\s*display: flex;[\s\S]*?background: var\(--panel2\);/);
  assert.match(dashboardStyles, /#dashboard \.desk-session-gauge-value \{\s*stroke: var\(--desk-session-gauge-color, var\(--ac\)\);/);
  assert.match(dashboardStyles, /#dashboard \.desk-session-net\.is-positive \{\s*color: var\(--up\);/);
  assert.match(dashboardStyles, /#dashboard \.desk-session-net\.is-negative \{\s*color: var\(--dn\);/);
  assert.doesNotMatch(sessionRenderer, /Asia 22:00|Win rate uses recorded P\/L|Avg R unavailable|matrixNote/);
  assert.doesNotMatch(sessionRenderer, /Win rate by session|Back to session matrix|barsNote\.textContent = '\.'/);
  assert.doesNotMatch(sessionRenderer, /desk-session-bars|data-session-flip/);
  assert.doesNotMatch(fundingForgeHtml, /createDeskSessionFlipButton|data-session-flip/);
});

test('trading statistics highlight shows only win rate', () => {
  const statisticsRenderer = fundingForgeHtml.match(
    /function renderDeskStatistics\(trades\)\{([\s\S]*?)\n\}\nfunction renderDeskActivity/
  )?.[1];
  assert.ok(statisticsRenderer, 'expected the trading statistics renderer');
  assert.match(statisticsRenderer, /meterLabel\.textContent = 'Win rate'/);
  assert.match(statisticsRenderer, /meterValue\.textContent = winRate === null/);
  assert.doesNotMatch(statisticsRenderer, /Realized P\/L|desk-stat-highlight-value|wins\.length \+ ' wins/);
  assert.doesNotMatch(statisticsRenderer, /meterNote|summaryValue|summaryMeta/);
  assert.match(dashboardStyles, /#dashboard \.desk-stat-highlight \{\s*display: grid;\s*grid-column: 1 \/ -1;\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(dashboardHtml, /class="desk-dashboard-panel desk-statistics-panel"/);
  assert.match(dashboardStyles, /#dashboard \.desk-statistics-panel \{\s*display: flex;\s*flex-direction: column;\s*min-width: 0;/);
  assert.match(dashboardStyles, /#dashboard \.desk-metrics-grid \{\s*display: grid;\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);\s*grid-auto-rows: 1fr;\s*flex: 1;/);
  assert.match(statisticsRenderer, /deskStatisticsNote'\)\.textContent = trades\.length \+ ' closed trades'/);
  assert.doesNotMatch(statisticsRenderer, /with recorded P\/L/);
});

test('dashboard theme stylesheet is scoped and contains both requested token palettes', () => {
  assert.match(fundingForgeHtml, /dashboardThemeStylesheetPath = \(window\.location\.protocol === 'file:' \? '\.\/dashboard-theme\.css' : '\/dashboard-theme\.css'\) \+ '\?v=20261112-calendar-trade-counts'/);
  for (const token of [
    '--bg: #0F1013',
    '--panel: #181A1F',
    '--panel2: #1F2229',
    '--line: #2E313A',
    '--tx: #F3F1EA',
    '--mu: #9D9CA6',
    '--up: #3FC48F',
    '--dn: #EF6B6B',
    '--warn: #F08A4B',
    '--ac: #D9B26A',
    '--onac: #1A1405',
    '--bg: #F6F4EF',
    '--panel: #FFFFFF',
    '--panel2: #F8F6F1',
    '--line: #E4DFD3',
    '--tx: #1D1C1A',
    '--mu: #6D6A62',
    '--up: #14805A',
    '--dn: #C4423C',
    '--warn: #B9600F',
    '--ac: #9A7420',
    '--onac: #FFFFFF'
  ]) {
    assert.ok(dashboardStyles.includes(token), `expected dashboard theme token ${token}`);
  }
  assert.match(dashboardStyles, /#dashboard\[data-theme="light"\]/);
});

test('Spark and Classic loss objectives show floor amounts and color-coded remaining meters', () => {
  const progressFunction = fundingForgeHtml.match(/function deskLossLimitProgress\(remainingPercent\)\{[\s\S]*?\r?\n\}/);
  const bufferFunction = fundingForgeHtml.match(/function deskSparkMaxLossBuffer\(currentEquity,threshold,lossAllowance\)\{[\s\S]*?\r?\n\}/);
  const classicDailyFloorFunction = fundingForgeHtml.match(/function deskClassicDailyLossFloor\(rules,limit,resetDate\)\{[\s\S]*?\r?\n\}/);
  const classicMaxFloorFunction = fundingForgeHtml.match(/function deskClassicMaxLossFloor\(startingBalance,rules,limit\)\{[\s\S]*?\r?\n\}/);
  const renderer = fundingForgeHtml.match(/function renderDeskObjectives\(\)\{[\s\S]*?\r?\n\s*\}\r?\nfunction renderDeskStatistics/)?.[0];
  assert.ok(progressFunction, 'expected the loss-limit progress calculation');
  assert.ok(bufferFunction, 'expected the Spark max-loss buffer calculation');
  assert.ok(classicDailyFloorFunction, 'expected the Classic daily floor calculation');
  assert.ok(classicMaxFloorFunction, 'expected the Classic static max-loss floor calculation');
  assert.ok(renderer, 'expected the dashboard objectives renderer');
  assert.match(renderer, /deskClassicDailyLossFloor\(rules,effectiveDailyLimit,resetDate\)/);
  assert.match(renderer, /deskClassicMaxLossFloor\(startingBalance,rules,maxLimit\)/);
  assert.match(renderer, /if\(isSparkOrClassic && threshold !== null && remaining\)/);
  assert.match(renderer, /else if\(isClassic && maxThreshold !== null/);
  assert.equal((fundingForgeHtml.match(/extra:\['3% \[EOD\] daily loss','7% \[EOD\] max loss'/g) || []).length, 2);
  assert.match(renderer, /deskLossLimitProgress\(\(1 - dailyDrawdown \/ effectiveDailyLimit\) \* 100\)/);
  assert.match(renderer, /deskMoney\(threshold\) \+ ' floor · ' \+ remaining\.progress\.toFixed\(1\) \+ '% remaining'/);
  assert.match(renderer, /deskSparkMaxLossBuffer\(currentEquity,maxThreshold,lossAllowance\)/);
  assert.match(renderer, /deskMoney\(maxThreshold\) \+ ' enforced floor · ' \+ progress\.toFixed\(1\) \+ '% remaining'/);
  const calculateProgress = new Function(`${progressFunction[0]}; return deskLossLimitProgress;`)();
  const calculateBuffer = new Function(`${progressFunction[0]}\n${bufferFunction[0]}; return deskSparkMaxLossBuffer;`)();
  const calculateClassicFloors = new Function(
    'const deskNumber = value => value !== null && value !== undefined && value !== \'\' && Number.isFinite(Number(value)) ? Number(value) : null;\n' +
    `${classicDailyFloorFunction[0]}\n${classicMaxFloorFunction[0]}\nreturn {deskClassicDailyLossFloor,deskClassicMaxLossFloor};`
  )();

  const safe = calculateBuffer(26390.23,25120.37,1750);
  assert.ok(Math.abs(safe.buffer - 1269.86) < 1e-9);
  assert.ok(Math.abs(safe.progress - 1269.86 / 1750 * 100) < 1e-9);
  assert.equal(safe.progressClass, 'is-up');

  assert.deepEqual(calculateBuffer(25995.37,25120.37,1750), {buffer:875,progress:50,progressClass:'is-warn'});
  assert.deepEqual(calculateBuffer(25557.87,25120.37,1750), {buffer:437.5,progress:25,progressClass:'is-warn'});
  assert.equal(calculateBuffer(25557.86,25120.37,1750).progressClass, 'is-dn');

  assert.deepEqual(calculateBuffer(25120.37,25120.37,1750), {buffer:0,progress:0,progressClass:'is-dn'});
  const belowFloor = calculateBuffer(25100,25120.37,1750);
  assert.ok(Math.abs(belowFloor.buffer + 20.37) < 1e-9);
  assert.equal(belowFloor.progress, 0);
  assert.equal(belowFloor.progressClass, 'is-dn');

  assert.deepEqual(calculateProgress((1 - 0 / 3) * 100), {progress:100,progressClass:'is-up'});
  assert.deepEqual(calculateProgress((1 - 1.5 / 3) * 100), {progress:50,progressClass:'is-warn'});
  assert.deepEqual(calculateProgress((1 - 2.25 / 3) * 100), {progress:25,progressClass:'is-warn'});
  assert.equal(calculateProgress((1 - 2.26 / 3) * 100).progressClass, 'is-dn');

  assert.equal(calculateClassicFloors.deskClassicDailyLossFloor({
    daily_drawdown_type: 'START_OF_DAY_EQUITY',
    starting_day_equity: 25000,
    starting_day_utc_date: '2026-11-12',
  },5,'2026-11-12'),23750);
  assert.equal(calculateClassicFloors.deskClassicDailyLossFloor({
    daily_drawdown_type: 'START_OF_DAY_BALANCE',
    starting_day_balance: 10000,
    starting_day_utc_date: '2026-11-11',
  },5,'2026-11-12'),null);
  assert.equal(calculateClassicFloors.deskClassicMaxLossFloor(25000,{max_drawdown_type:'STATIC'},10),22500);
  assert.equal(calculateClassicFloors.deskClassicMaxLossFloor(25000,{max_drawdown_type:'TRAILING'},10),null);
});

test('instant funding accounts do not display a phase badge', () => {
  const phaseBadgeFunction = fundingForgeHtml.match(/function shouldShowPhaseBadge\(account\)\{[\s\S]*?\r?\n\}/);
  assert.ok(phaseBadgeFunction, 'expected the account phase badge helper');
  assert.match(fundingForgeHtml, /phaseBadge\.hidden = !shouldShowPhaseBadge\(data\)/);
  const shouldShowPhaseBadge = new Function(`${phaseBadgeFunction[0]}; return shouldShowPhaseBadge;`)();
  assert.equal(shouldShowPhaseBadge({plan:'spark_instant',phaseNumber:1}), false);
  assert.equal(shouldShowPhaseBadge({plan:'instant',phaseNumber:1}), false);
  assert.equal(shouldShowPhaseBadge({plan:'spark_1step',phaseNumber:1}), true);
});
