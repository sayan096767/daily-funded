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
  assert.match(fundingForgeHtml, /desk-chart-threshold is-profit-target/);
  assert.match(fundingForgeHtml, /desk-chart-threshold is-max-loss/);
  assert.match(fundingForgeHtml, /account-status-badge is-active/);
  assert.match(fundingForgeHtml, /statusBadge\.classList\.toggle\('is-active',data\.status === 'active'\)/);
  assert.match(fundingForgeHtml, /statusBadge\.classList\.toggle\('is-rejected',rejected\)/);
  assert.match(fundingForgeHtml, /statusBadge\.classList\.toggle\('is-pending',pending\)/);
  assert.match(dashboardStyles, /#dashboard \.account-badge\.is-active[\s\S]*?background: var\(--upbg\);[\s\S]*?color: var\(--up\);/);
  assert.match(dashboardStyles, /#dashboard \.account-badge\.is-rejected[\s\S]*?background: var\(--dnbg\);[\s\S]*?color: var\(--dn\);/);
  assert.doesNotMatch(dashboardHtml, /accountEngineId/);
  assert.doesNotMatch(fundingForgeHtml, /engineIdBadge|ENGINE ['"] \+ data\.tradingEngineAccountId/);
});

test('dashboard controls retain working destinations and existing handlers', () => {
  assert.ok(dashboardHtml, 'expected the user dashboard section');
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
  assert.match(dashboardHtml, /class="dashboard-trade-link" href="\/trade\/"/);
  assert.match(dashboardHtml, /id="dashboardAccountAction"/);
  assert.match(dashboardHtml, /id="accountSelectTrigger"/);
  assert.match(dashboardHtml, /id="dashboardThemeToggle"/);
  assert.match(dashboardHtml, /Open trading platform/);
  assert.match(dashboardHtml, /data-performance-range="1D"/);
  assert.match(dashboardHtml, /data-performance-range="1W"/);
  assert.match(dashboardHtml, /data-performance-range="1M"/);
  assert.match(dashboardHtml, /data-performance-range="ALL"/);
  assert.doesNotMatch(dashboardHtml, /data-performance-range="(?:7D|30D|90D)"/);
  assert.match(fundingForgeHtml, /const rangeMilliseconds = \{'1D':86400000,'1W':7\*86400000,'1M':30\*86400000\}/);
  assert.match(fundingForgeHtml, /const duration = \{'1D':1,'1W':7,'1M':30\}\[button\.dataset\.performanceRange\] \* 86400000/);
  assert.doesNotMatch(fundingForgeHtml, /\.dashboard-sidebar\{position:fixed;|#dashboard\.active\{display:grid; grid-template-columns:248px/);
  assert.match(fundingForgeHtml, /function signOutFirebase\(\)/);
  assert.match(fundingForgeHtml, /signOutFirebase\(\)/);
  assert.match(fundingForgeHtml, /renderDeskPerformanceChart\(button\.dataset\.performanceRange\)/);
  assert.match(fundingForgeHtml, /const dashboardThemeStorageKey = 'crazyFundedDeskTheme'/);
  assert.match(fundingForgeHtml, /localStorage\.getItem\(dashboardThemeStorageKey\)/);
  assert.match(fundingForgeHtml, /localStorage\.setItem\(dashboardThemeStorageKey,activeTheme\)/);
  assert.match(fundingForgeHtml, /dashboard\.dataset\.theme = activeTheme/);
  assert.match(fundingForgeHtml, /activeTheme === 'dark' \? '☀ Light mode' : '☾ Dark mode'/);
  assert.match(fundingForgeHtml, /activeTheme === 'light'\)\)/);
  assert.match(fundingForgeHtml, /const deskSignedMoney = value =>/);
  assert.match(fundingForgeHtml, /number > 0 \? '\+\$' : number < 0 \? '−\$'/);
  assert.doesNotMatch(fundingForgeHtml, /data-dashboard-theme/);
});

test('dashboard navigation remains horizontally accessible on small screens', () => {
  assert.match(dashboardStyles, /\.dashboard-brand \{\s*display: flex;\s*align-items: center;/);
  assert.match(dashboardStyles, /\.account-select-native \{\s*position: absolute !important;\s*width: 1px !important;/);
  assert.match(dashboardStyles, /@media \(max-width: 999px\)/);
  assert.match(dashboardStyles, /\.dashboard-side-nav \{[\s\S]*?overflow-x: auto/);
  assert.match(dashboardStyles, /#dashboard \.account-select-trigger \{\s*flex: 1;\s*min-width: 0;\s*max-width: 100%;/);
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

test('calendar P/L labels fit narrow mobile day cells while retaining exact values in the title', () => {
  const calendarFormatter = fundingForgeHtml.match(/function formatDeskCalendarPnl\(value\)\{[\s\S]*?\n\}/);
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
  assert.match(dashboardStyles, /#dashboard \.desk-calendar-pnl \{\s*display: block;\s*width: 100%;\s*min-width: 0;\s*overflow: hidden;/);
  assert.match(dashboardStyles, /@media \(max-width: 420px\) \{[\s\S]*?#dashboard \.desk-calendar-pnl \{\s*font-size: 7px;/);
});

test('session analytics no longer includes the win-rate flip side or stray text', () => {
  const sessionRenderer = fundingForgeHtml.match(
    /function renderDeskSessionAnalytics\(trades\)\{([\s\S]*?)\n\}\nfunction formatDeskSessionPnl/
  )?.[1];
  assert.ok(sessionRenderer, 'expected the session analytics renderer');
  assert.match(sessionRenderer, /frontTitle\.textContent = 'Session edge matrix'/);
  assert.match(sessionRenderer, /headerRow[\s\S]*?'Win rate'/);
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
  assert.match(statisticsRenderer, /deskStatisticsNote'\)\.textContent = trades\.length \+ ' closed trades'/);
  assert.doesNotMatch(statisticsRenderer, /with recorded P\/L/);
});

test('dashboard theme stylesheet is scoped and contains both requested token palettes', () => {
  assert.match(fundingForgeHtml, /dashboardThemeStylesheetPath = window\.location\.protocol === 'file:' \? '\.\/dashboard-theme\.css' : '\/dashboard-theme\.css'/);
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
