import * as signalR from "@microsoft/signalr";
import {
  calculatePositionPnl,
  normalizeMarketCandles,
  normalizeMarketQuote,
  normalizeMarketSymbols,
  normalizeTerminalPosition,
  normalizeTerminalTrade,
} from "./suppliedTerminalData.js";

const API_BASE = import.meta.env.DEV ? "" : "https://throbbing-bonus-6fed.dailyfunded.workers.dev";
const TRADING_API_BASE = import.meta.env.DEV ? "/api" : "https://daily-funded-api.onrender.com/api";
const TRADING_EVENTS_URL = "wss://throbbing-bonus-6fed.dailyfunded.workers.dev/trading/events";
window.CF_CONFIG = { mode: "live", api: TRADING_API_BASE, pollMs: 5000 };
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const SY={};
const TF={'1m':60,'5m':300,'15m':900,'1h':3600,'4h':14400,'1d':86400};
const IC={cursor:['<path d="M5 3l14 8-6 2-3 6z"/>','➤','Cursor'],cross:['<path d="M12 3v18M3 12h18"/>','✛','Crosshair'],trend:['<path d="M4 19L20 5"/><circle cx="4" cy="19" r="2"/><circle cx="20" cy="5" r="2"/>','📈','Trend line (Alt+T)'],ray:['<path d="M4 18L21 6"/><circle cx="4" cy="18" r="2"/>','↗','Ray'],hline:['<path d="M3 12h18"/><circle cx="12" cy="12" r="2"/>','➖','Horizontal line (Alt+H)'],vline:['<path d="M12 3v18"/><circle cx="12" cy="12" r="2"/>','❘','Vertical line (Alt+V)'],rect:['<path d="M5 6h14v12H5z"/>','▭','Rectangle (Alt+R)'],fib:['<path d="M2.67 3.52H21.36"/><path d="M2.67 8.60H20.84"/><path d="M2.67 13.64H21.36"/><path d="M3.19 18.73H21.36"/><circle cx="20.84" cy="8.60" r="1.77"/><circle cx="3.19" cy="18.73" r="1.77"/>','≡','Fib retracement (Alt+F)'],measure:['<path d="M3 17L17 3l4 4L7 21zM8 12l2 2M11 9l2 2M14 6l2 2"/>','📏','Measure'],magnet:['<path d="M6 4v8a6 6 0 0012 0V4h-4v8a2 2 0 01-4 0V4z"/>','🧲','Magnet mode'],hide:['<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>','👁','Hide drawings'],lock:['<path d="M6 11h12v9H6zM8 11V8a4 4 0 018 0v3"/>','🔒','Lock drawings'],trash:['<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>','🗑','Delete selected or all (Del)']};
const TOOLS=['cursor','cross','trend','ray','hline','vline','rect','fib','measure'];
let S={sym:'XAUUSD',tf:'1m',type:'candle',ind:{vol:1,sma:0,ema:0,bb:0},tool:'cursor',magnet:0,hide:0,lock:0,grid:1,up:'#2d7ff9',dn:'#ef5350',ac:'#8db82a',pack:'line',theme:'auto',side:'buy',ot:'market',one:0,order:TOOLS.slice(),off:[]};
try{Object.assign(S,JSON.parse(localStorage.getItem('cf_cfg')||'{}'))}catch(e){}
S.tool='cursor';S.side='buy';
const sv=()=>{try{localStorage.setItem('cf_cfg',JSON.stringify(S))}catch(e){}};
const P={},Q={},D={};
let bal=null,accountState=null,POS=[],ORD=[],HIS=[],DR=[],pend=null,sel=-1,mouse=null,drag=null,tab='p',nid=1;const PV={on:0};
let V={right:0,bw:8,ys:1,ysh:0},pw=0,ph=0,mn=0,mx=1,W=0,H=0,dpr=1;
const key=()=>S.sym+'|'+S.tf;
const dc=(y=S.sym)=>SY[y]?.d??5;
const fm=(n,d=dc())=>n!==null&&n!==undefined&&n!==''&&Number.isFinite(Number(n))?Number(n).toFixed(d):'--';
const validQuote=y=>{const q=Q[y];return q&&!q.stale&&q.market_state?.toLowerCase()!=='closed'&&Number.isFinite(q.bid)&&Number.isFinite(q.ask)};
const sp=y=>validQuote(y)?Q[y].ask-Q[y].bid:NaN,bid=y=>validQuote(y)?Q[y].bid:NaN,ask=y=>validQuote(y)?Q[y].ask:NaN;
function ensure(){if(!D[key()]){D[key()]=[];resetView();if(LIVE&&BOOT)void liveCandles(key())}}
function resetView(){V.lk=null;V.bw=8;V.ys=1;V.ysh=0;V.right=(D[key()]||[]).length-1+6}
const ACC=[];
let AI=0;try{const saved=localStorage.getItem('cf_acc');if(saved)ACC.selectedId=saved}catch(e){}
function accSave(){}
function accLoad(){const a=ACC[AI];if(!a){bal=null;accountState=null;POS=[];ORD=[];HIS=[];$('#an').textContent='Loading account…';$('#as').textContent='';return}
 const balance=accountState?.balance??a.balance;bal=balance!==null&&balance!==undefined&&Number.isFinite(Number(balance))?Number(balance):null;
 POS=Array.isArray(accountState?.positions)?accountState.positions.map(normalizeTerminalPosition).filter(Boolean):[];
 ORD=[];HIS=Array.isArray(accountState?.trades)?accountState.trades.map(normalizeTerminalTrade).filter(Boolean):[];
 $('#an').textContent=`${a.size?`$${Number(a.size).toLocaleString()} · `:''}${a.label||a.plan||a.id}`;
 const e=$('#as');e.textContent=`${String(a.status||'unavailable').toUpperCase()} · ${a.tradingEnabled?'Trading Enabled':'Trading Disabled'}`;e.style.color=a.tradingEnabled?'':'var(--sell)'}
/* toolbar */
function ico(k){let [s,e]=IC[k];if(k==='lock'&&!S.lock)s=OPENL;return S.pack==='emoji'?`<span class="em">${e}</span>`:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${S.pack==='bold'?2.8:1.25}" stroke-linecap="round" stroke-linejoin="round">${s}</svg>`}
function tbrOld(){const vis=S.order.filter(k=>!S.off.includes(k));
 $('#tb').innerHTML=`<button id="wt" title="Watchlist"><span class="em">☰</span></button><hr>`+vis.map(k=>`<button data-k="${k}" class="${S.tool===k?'on':''}" title="${IC[k][2]}">${ico(k)}</button>`).join('')+'<hr>'+['magnet','hide','lock','trash'].map(k=>`<button data-k="${k}" class="${S[k]?'on':''}" title="${IC[k][2]}">${ico(k)}</button>`).join('');
 $('#wt').onclick=()=>$('#wl').classList.toggle('o');
 $$('#tb [data-k]').forEach(b=>b.onclick=()=>{const k=b.dataset.k;pend=null;if(k==='trash'){const m=DR.filter(d=>d.sym===S.sym);if(sel>=0){DR.splice(sel,1);sel=-1}else DR=DR.filter(d=>d.sym!==S.sym)}else if(['magnet','hide','lock'].includes(k))S[k]=S[k]?0:1;else{S.tool=k;if(k!=='cursor')sel=-1}tbr();draw()});ftr()}
function wlr(){$('#wl').innerHTML=Object.keys(SY).map(y=>`<div class="wi ${y===S.sym?'a':''}" data-y="${escapeHtml(y)}"><div><b>${escapeHtml(y)}</b><small>${escapeHtml(SY[y].n)}</small></div><div style="text-align:right">${fm(bid(y),SY[y].d)}<small>${fm(ask(y),SY[y].d)}</small></div></div>`).join('');
 $$('#wl .wi').forEach(e=>e.onclick=()=>{S.sym=e.dataset.y;ensure();sel=-1;pend=null;ftr();tick(0)})}
/* chart */
const X=i=>pw-(V.right-i)*V.bw-V.bw/2,I=x=>V.right-(pw-x-V.bw/2)/V.bw,Y=p=>ph*(1-(p-mn)/(mx-mn)),PP=y=>mn+(1-y/ph)*(mx-mn);
function ma(a,n,ex){const o=[];let s=0,e=null;const k=2/(n+1);for(let i=0;i<a.length;i++){const c=a[i].c;if(ex){e=e===null?c:c*k+e*(1-k);o.push(i>=n?e:null)}else{s+=c;if(i>=n)s-=a[i-n].c;o.push(i>=n-1?s/n:null)}}return o}
function bb(a,n=20){const m=ma(a,n),u=[],l=[];a.forEach((_,i)=>{if(m[i]===null){u.push(null);l.push(null);return}let v=0;for(let j=i-n+1;j<=i;j++)v+=(a[j].c-m[i])**2;const sd=Math.sqrt(v/n);u.push(m[i]+2*sd);l.push(m[i]-2*sd)});return[m,u,l]}
const IND={
ema:{n:'Moving Average Exponential',ov:1,c:'#e056fd',p:{n:50},pr:[['n','Length',1,500]]},
bb:{n:'Bollinger Bands',ov:1,c:'#9b7cf4',p:{n:20,k:2},pr:[['n','Length',1,500],['k','Std dev multiplier',0.1,10,0.1]]},
macd:{n:'MACD',ov:0,c:'#2d7ff9',p:{f:12,s:26,g:9},pr:[['f','Fast length',1,500],['s','Slow length',1,500],['g','Signal length',1,500]]},
emac:{n:'EMA Cross',ov:1,c:'#e056fd',c2:'#2ecc71',p:{f:10,s:30},pr:[['f','Fast length',1,500],['s','Slow length',1,500]]},
};
function ixInit(){S.ix=S.ix||{};for(const k in IND){const s=S.ix[k]||{};S.ix[k]={on:s.on?1:0,c:s.c||IND[k].c,c2:s.c2||IND[k].c2||null,p:Object.assign({},IND[k].p,s.p||{})}}}
ixInit();
function smaV(v,n){const o=v.map(()=>null);let s=0,c=0;for(let i=0;i<v.length;i++){if(v[i]==null){s=0;c=0;continue}s+=v[i];c++;if(c>n){s-=v[i-n];c--}if(c===n)o[i]=s/n}return o}
function emaV(v,n){const o=v.map(()=>null),k=2/(n+1);let e=null;for(let i=0;i<v.length;i++){if(v[i]==null)continue;e=e==null?v[i]:v[i]*k+e*(1-k);o[i]=e}return o}
function rsiV(c,n){const o=c.map(()=>null);if(c.length<=n)return o;let g=0,l=0;for(let i=1;i<=n;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l-=d}g/=n;l/=n;o[n]=l===0?100:100-100/(1+g/l);for(let i=n+1;i<c.length;i++){const d=c[i]-c[i-1];g=(g*(n-1)+(d>0?d:0))/n;l=(l*(n-1)+(d<0?-d:0))/n;o[i]=l===0?100:100-100/(1+g/l)}return o}
function stochHL(a,k){const o=a.map(()=>null);for(let i=k-1;i<a.length;i++){let hi=-1e12,lo=1e12;for(let j=i-k+1;j<=i;j++){hi=Math.max(hi,a[j].h);lo=Math.min(lo,a[j].l)}o[i]=hi===lo?50:(a[i].c-lo)/(hi-lo)*100}return o}
function stochOf(v,k){const o=v.map(()=>null);for(let i=k-1;i<v.length;i++){let hi=-1e12,lo=1e12,bad=0;for(let j=i-k+1;j<=i;j++){if(v[j]==null){bad=1;break}hi=Math.max(hi,v[j]);lo=Math.min(lo,v[j])}if(!bad)o[i]=hi===lo?50:(v[i]-lo)/(hi-lo)*100}return o}
function drawInd(a,i0,i1,ph){
 const closes=a.map(c=>c.c),on=k=>S.ix[k].on,P=k=>S.ix[k].p,C=k=>S.ix[k].c;
 const seg=(arr,col,w=1.3,f=Y)=>{cx.beginPath();cx.strokeStyle=col;cx.lineWidth=w;let g=0;for(let i=i0;i<=i1;i++){if(arr[i]==null)continue;const x=X(i),y=f(arr[i]);g?cx.lineTo(x,y):cx.moveTo(x,y);g=1}cx.stroke()};
 if(on('ema'))seg(emaV(closes,P('ema').n),C('ema'));
 if(on('bb')){const n=P('bb').n,kk=P('bb').k,m=smaV(closes,n),u=[],l=[];m.forEach((mv,i)=>{if(mv==null){u.push(null);l.push(null);return}let v=0;for(let j=i-n+1;j<=i;j++)v+=(closes[j]-mv)**2;const sd=Math.sqrt(v/n);u.push(mv+kk*sd);l.push(mv-kk*sd)});
  cx.beginPath();let g=0;for(let i=i0;i<=i1;i++)if(u[i]!=null){g?cx.lineTo(X(i),Y(u[i])):cx.moveTo(X(i),Y(u[i]));g=1}for(let i=i1;i>=i0;i--)if(l[i]!=null)cx.lineTo(X(i),Y(l[i]));cx.closePath();cx.fillStyle=C('bb')+'22';cx.fill();seg(u,C('bb'),1);seg(l,C('bb'),1);seg(m,C('bb')+'99',1)}
 const cross=(f,s,col,col2)=>{seg(f,col);seg(s,col2);for(let i=i0+1;i<=i1;i++){if(f[i-1]==null||s[i-1]==null||f[i]==null||s[i]==null)continue;const up=f[i-1]<=s[i-1]&&f[i]>s[i],dn=f[i-1]>=s[i-1]&&f[i]<s[i];if(!up&&!dn)continue;const x=X(i);cx.beginPath();if(up){const y=Y(a[i].l)+10;cx.moveTo(x,y);cx.lineTo(x-5,y+8);cx.lineTo(x+5,y+8);cx.fillStyle='#2ecc71'}else{const y=Y(a[i].h)-10;cx.moveTo(x,y);cx.lineTo(x-5,y-8);cx.lineTo(x+5,y-8);cx.fillStyle='#ef5350'}cx.closePath();cx.fill()}};
 if(on('emac'))cross(emaV(closes,P('emac').f),emaV(closes,P('emac').s),C('emac'),S.ix.emac.c2);
 const subs=['macd'].filter(on),hb=Math.round(ph*.2);
 subs.forEach((k,j)=>{
  const t=ph-(j+1)*hb;let lo=0,hi=100,ser=[],lv=[],hist=null;
  if(k==='macd'){const p=P('macd'),ef=emaV(closes,p.f),es=emaV(closes,p.s),m=ef.map((x,i)=>x==null||es[i]==null?null:x-es[i]),sg=emaV(m,p.g);hist=m.map((x,i)=>x==null||sg[i]==null?null:x-sg[i]);let mn=0,mx=0;[m,sg,hist].forEach(ar=>ar.forEach(v=>{if(v!=null){mn=Math.min(mn,v);mx=Math.max(mx,v)}}));const pad=(mx-mn)*.08||1;lo=mn-pad;hi=mx+pad;ser=[[m,C('macd'),1.3],[sg,'#ff9f1a',1.3]];lv=[0]}
  const vy=v=>t+(hi-v)/((hi-lo)||1)*hb;
  cx.save();cx.beginPath();cx.rect(0,t,pw,hb);cx.clip();
  cx.fillStyle='#00000026';cx.fillRect(0,t,pw,hb);
  cx.strokeStyle='#7e929899';cx.lineWidth=1;cx.beginPath();cx.moveTo(0,t+.5);cx.lineTo(pw,t+.5);cx.stroke();
  cx.setLineDash([3,3]);cx.strokeStyle='#7e929888';lv.forEach(v=>{cx.beginPath();cx.moveTo(0,vy(v));cx.lineTo(pw,vy(v));cx.stroke()});cx.setLineDash([]);
  if(hist)for(let i=i0;i<=i1;i++){if(hist[i]==null)continue;const y0=vy(0),y1=vy(hist[i]);cx.fillStyle=hist[i]>=0?'#2ecc7180':'#ef535080';cx.fillRect(X(i)-Math.max(1,V.bw*.35),Math.min(y0,y1),Math.max(1,V.bw*.7),Math.max(1,Math.abs(y1-y0)))}
  ser.forEach(([arr,col,w])=>seg(arr,col,w,vy));
  cx.font='11px "Segoe UI",system-ui,sans-serif';cx.fillStyle=C(k);cx.textAlign='left';cx.textBaseline='top';cx.fillText(IND[k].n,6,t+3);
  cx.restore();
 });
}
function nice(r){const m=10**Math.floor(Math.log10(r)),f=r/m;return(f<1.5?1:f<3?2:f<7?5:10)*m}
function line(arr,c,i0,i1,w=1.3){cx.beginPath();cx.strokeStyle=c;cx.lineWidth=w;let g=0;for(let i=i0;i<=i1;i++){if(arr[i]==null)continue;g?cx.lineTo(X(i),Y(arr[i])):cx.moveTo(X(i),Y(arr[i]));g=1}cx.stroke()}
const gr=$('#gr');let cv=null,cx=null,lgdEl=null,PN=[],AP=0,mousePane=-1;
const candleStates={};
const chartNotice=document.createElement('div');
chartNotice.style.cssText='position:absolute;inset:0;display:grid;place-items:center;color:var(--mu);pointer-events:none;text-align:center;padding:20px';
$('#cw').appendChild(chartNotice);
function setChartNotice(text){chartNotice.textContent=text;chartNotice.style.display=text?'grid':'none'}
const LAYS={'1':{n:1,a:['a'],c:'1fr',r:'1fr'},'2v':{n:2,a:['a b'],c:'1fr 1fr',r:'1fr'},'2h':{n:2,a:['a','b'],c:'1fr',r:'1fr 1fr'},'3c':{n:3,a:['a b c'],c:'1fr 1fr 1fr',r:'1fr'},'3r':{n:3,a:['a','b','c'],c:'1fr',r:'1fr 1fr 1fr'},'3L':{n:3,a:['a b','a c'],c:'1fr 1fr',r:'1fr 1fr'},'3R':{n:3,a:['a c','b c'],c:'1fr 1fr',r:'1fr 1fr'},'3T':{n:3,a:['a a','b c'],c:'1fr 1fr',r:'1fr 1fr'},'3B':{n:3,a:['a b','c c'],c:'1fr 1fr',r:'1fr 1fr'}};
const LT={'1':'Single chart','2v':'2 charts side by side','2h':'2 charts stacked','3c':'3 columns','3r':'3 rows','3L':'1 left, 2 right','3R':'2 left, 1 right','3T':'1 top, 2 bottom','3B':'2 top, 1 bottom'};
S.lay=LAYS[S.lay]?S.lay:'1';
function load(p){cv=p.cv;cx=p.cx;V=p.V;W=p.W;H=p.H;dpr=p.dpr;lgdEl=p.lg;S.sym=p.sym;S.tf=p.tf}
function mkPane(){const el=document.createElement('div'),c=document.createElement('canvas'),lg=document.createElement('div'),i=PN.length;el.className='pn2';lg.className='lg2';el.append(c,lg);gr.appendChild(el);
 PN.push({el,cv:c,cx:c.getContext('2d'),lg,V:{right:0,bw:8,ys:1,ysh:0},W:0,H:0,dpr:1,sym:S.sym,tf:i?(['5m','15m','1h'][i-1]||S.tf):S.tf,m:null})}
function mark(){PN.forEach((p,j)=>p.el.classList.toggle('act',PN.length>1&&j===AP))}
function act(i){if(i===AP||!PN[i])return;const o=PN[AP];o.sym=S.sym;o.tf=S.tf;AP=i;load(PN[i]);pend=null;sel=-1;drag=null;ensure();mark();seg();lab();ftr();tick(0)}
function drawAll(){if(!PN.length)return;const a=PN[AP];a.sym=S.sym;a.tf=S.tf;
 PN.forEach((p,i)=>{if(i===AP)return;const s0=[cv,cx,V,W,H,dpr,lgdEl,S.sym,S.tf,pend,sel,drag,mouse];load(p);pend=null;sel=-1;drag=null;mouse=mousePane===i?(p.m||null):null;ensure();if(!V.right)resetView();draw1();[cv,cx,V,W,H,dpr,lgdEl,S.sym,S.tf,pend,sel,drag,mouse]=s0});
 load(a);if(!V.right)resetView();draw1()}
function draw(){drawAll()}
function setLay(k){const L=LAYS[k]||LAYS['1'];S.lay=LAYS[k]?k:'1';
 if(!PN.length){mkPane();AP=0;load(PN[0])}else{PN[AP].sym=S.sym;PN[AP].tf=S.tf}
 while(PN.length>L.n)PN.pop().el.remove();
 let ch=0;if(AP>=PN.length){AP=0;load(PN[0]);pend=null;sel=-1;ch=1}
 while(PN.length<L.n)mkPane();
 gr.style.gridTemplateAreas=L.a.map(r=>'"'+r+'"').join(' ');gr.style.gridTemplateColumns=L.c;gr.style.gridTemplateRows=L.r;
 PN.forEach((p,i)=>{p.el.style.gridArea='abc'[i]});gr.classList.toggle('multi',L.n>1);mark();sv();rs();if(ch){ensure();seg();lab();tick(0)}}
const pof=e=>PN.findIndex(p=>p.el.contains(e.target));
['pointerdown','wheel','dblclick'].forEach(t=>gr.addEventListener(t,e=>{const i=pof(e);if(i>=0)act(i)},true));
gr.addEventListener('pointermove',e=>{const i=pof(e);if(i<0)return;if(i!==AP&&!drag){const r=PN[i].cv.getBoundingClientRect();PN[i].m={x:e.clientX-r.left,y:e.clientY-r.top};mousePane=i;mouse=null;e.stopPropagation();draw()}else mousePane=AP},true);
function CV(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim()}
function isLt(){const t=document.documentElement.getAttribute('data-theme');return t==='light'||(t!=='dark'&&matchMedia('(prefers-color-scheme: light)').matches)}
function AC(){const c=S.ac;if(!isLt()||!/^#[0-9a-f]{6}$/i.test(c))return c;return '#'+[1,3,5].map(i=>Math.round(parseInt(c.substr(i,2),16)*.68).toString(16).padStart(2,'0')).join('')}
function lbl(t,x,y,bg,fg,al='left'){if(!fg||fg==='#fff'){fg='#fff';if(/^#[0-9a-f]{6}$/i.test(bg)){const r=parseInt(bg.substr(1,2),16),g=parseInt(bg.substr(3,2),16),b=parseInt(bg.substr(5,2),16);if((.299*r+.587*g+.114*b)/255>.55)fg='#111'}}cx.font='11px "Segoe UI",system-ui,sans-serif';const w=cx.measureText(t).width+10;const xx=al==='center'?x-w/2:x;cx.fillStyle=bg;cx.fillRect(xx,y-9,w,18);cx.fillStyle=fg;cx.textBaseline='middle';cx.textAlign='left';cx.fillText(t,xx+5,y)}
let OV=[],AXL=[];
function ovHit(x,y){for(let k=OV.length-1;k>=0;k--){const o=OV[k];if(!o.hov&&x>=o.x&&x<=o.x+o.w&&y>=o.y&&y<=o.y+o.h)return o}return null}
function hideXH(){return !!mouse&&OV.some(o=>mouse.x>=o.x&&mouse.x<=o.x+o.w&&mouse.y>=o.y&&mouse.y<=o.y+o.h)}
function ovLine(y,c,dash){cx.strokeStyle=c;cx.lineWidth=1.2;cx.setLineDash(dash);cx.beginPath();cx.moveTo(0,y);cx.lineTo(pw,y);cx.stroke();cx.setLineDash([])}
let pillR=0;
function pillAt(y,lots,val,vc,bc,filled,onX){cx.font='12px "Segoe UI",system-ui,sans-serif';cx.textBaseline='middle';cx.textAlign='left';
 const h=20,lw=cx.measureText(lots).width+14,vw=cx.measureText(val).width+14,xw=22,tw=lw+vw+xw,x0=Math.max(4,pw-tw-64),y0=y-h/2;
 rrect(x0,y0,tw,h,4);cx.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--pn').trim()||'#121b1e';cx.fill();
 if(filled){rrect(x0,y0,lw,h,4);cx.fillStyle=bc;cx.fill()}
 rrect(x0,y0,tw,h,4);cx.strokeStyle=bc;cx.lineWidth=1;cx.stroke();
 cx.fillStyle=filled?'#fff':CV('--mu');cx.fillText(lots,x0+7,y);
 cx.fillStyle=vc;cx.fillText(val,x0+lw+7,y);
 cx.strokeStyle=bc;cx.beginPath();cx.moveTo(x0+lw+vw+.5,y0+4);cx.lineTo(x0+lw+vw+.5,y0+h-4);cx.stroke();
 cx.fillStyle=CV('--mu');cx.fillText('✕',x0+lw+vw+6,y);
 OV.push({x:x0,y:y0,w:tw,h,hov:1});OV.push({x:x0+lw+vw,y:y0,w:xw,h,act:onX});pillR=x0+tw;return x0}
function ghostArr(){if(!PV.on||S.ot!=='market'||!SY[S.sym])return[];return[{ghost:1,sym:S.sym,side:S.side,lots:lots(),open:refPx(),tp:absLvl('tp'),sl:absLvl('sl')}]}
function drawPos(){OV=[];AXL=[];
 [...POS.filter(p=>p.sym===S.sym),...ghostArr()].forEach(p=>{const pk=(drag&&drag.m==='pl'&&(drag.p===p||(p.ghost&&drag.p&&drag.p.ghost))&&drag.v!=null)?drag.k:null,pv=pk?p[pk]:0;if(pk)p[pk]=drag.v;
  const dg=dc(p.sym),buy=p.side==='buy',col=buy?'#2d7ff9':'#ef5350',eY=Y(p.open),v=pl(p),lots=p.lots.toFixed(2);
  if(p.tp){const y=Y(p.tp),tv=pnlAt(p,p.tp);
   ovLine(y,CV('--tp'),[]);AXL.push([fm(p.tp,dg),y,CV('--tp')]);
   OV.push({x:0,y:y-5,w:pw,h:10,drag:{p,k:'tp'}});
   pillAt(y,lots,Number.isFinite(tv)?pls(tv)+' USD':'–',CV('--tp'),CV('--tp'),false,()=>{if(p.ghost)TPS.tp=null;else{p.tp=0;if(LIVE)liveModify(p)}tick(0)})}
  if(p.sl){const y=Y(p.sl),sv2=pnlAt(p,p.sl);
   ovLine(y,CV('--sl'),[]);AXL.push([fm(p.sl,dg),y,CV('--sl')]);
   OV.push({x:0,y:y-5,w:pw,h:10,drag:{p,k:'sl'}});
   pillAt(y,lots,Number.isFinite(sv2)?pls(sv2)+' USD':'–',CV('--sl'),CV('--sl'),false,()=>{if(p.ghost)TPS.sl=null;else{p.sl=0;if(LIVE)liveModify(p)}tick(0)})}
  ovLine(eY,col,[]);AXL.push([fm(p.open,dg),eY,col]);
  const ex=pillAt(eY,lots,p.ghost?'':Number.isFinite(v)?pls(v)+' USD':'–',v==null?CV('--mu'):v>=0?CV('--buy'):CV('--sell'),col,true,()=>{if(p.ghost)PV.on=0;else closeP(p);tick(0)});
  let bx=ex-6;
  [['sl','SL',CV('--sl')],['tp','TP',CV('--tp')]].forEach(([k,t,c])=>{if(p[k])return;const w=30,h=18,x0=bx-w,y0=eY-h/2;
   rrect(x0,y0,w,h,3);cx.fillStyle=CV('--pn');cx.fill();cx.strokeStyle=c;cx.lineWidth=1;cx.setLineDash([2,2]);cx.stroke();cx.setLineDash([]);
   cx.fillStyle=c;cx.font='11px "Segoe UI",system-ui,sans-serif';cx.textAlign='center';cx.textBaseline='middle';cx.fillText(t,x0+w/2,eY);cx.textAlign='left';
   OV.push({x:x0,y:y0,w,h,btn:true,drag:{p,k}});bx=x0-4});
 OV.push({x:bx,y:eY-10,w:pillR-bx,h:20,hov:1});
 if(pk)p[pk]=pv;
 })}
function ovDrag(y){const p=drag.p,dg=dc(p.sym),tk=Math.pow(10,-dg),buy=p.side==='buy',q=PP(y);if(!p.ghost&&!validQuote(p.sym))return;
 let v;if(drag.k==='tp')v=buy?Math.max(q,p.open+tk):Math.min(q,p.open-tk);else{const cur=buy?bid(p.sym):ask(p.sym),buf=tk;v=buy?Math.min(q,cur-buf):Math.max(q,cur+buf)}
 drag.v=+v.toFixed(dg);draw()}
function draw1(){const a=D[key()];if(!W)return;if(!a?.length){cx.setTransform(dpr,0,0,dpr,0,0);cx.clearRect(0,0,W,H);setChartNotice(candleStates[key()]||'Waiting for market data…');return}setChartNotice('');
 const cs=getComputedStyle(document.documentElement),mu=cs.getPropertyValue('--mu').trim(),gr=cs.getPropertyValue('--gd').trim(),tx=cs.getPropertyValue('--tx').trim(),bg=cs.getPropertyValue('--bg').trim();
 cx.setTransform(dpr,0,0,dpr,0,0);cx.clearRect(0,0,W,H);pw=W-72;ph=H-24;const bw=V.bw,i0=Math.max(0,Math.floor(V.right-pw/bw)-1),i1=Math.min(a.length-1,Math.ceil(V.right));
 let lo=1e12,hi=-1e12,vm=1;for(let i=i0;i<=i1;i++){lo=Math.min(lo,a[i].l);hi=Math.max(hi,a[i].h);vm=Math.max(vm,a[i].v)}if(lo>hi){lo=a[a.length-1].l;hi=lo+1}if(V.lk&&V.lk.k===key()){lo=V.lk.lo;hi=V.lk.hi}else V.lk={k:key(),lo,hi};
 const mid=(lo+hi)/2+V.ysh,hf=(hi-lo)/2*1.3*V.ys+1e-9;mn=mid-hf;mx=mid+hf;
 cx.font='11px "Segoe UI",system-ui,sans-serif';cx.textBaseline='middle';
 const stp=nice((mx-mn)/8);cx.lineWidth=1;
 for(let p=Math.ceil(mn/stp)*stp;p<mx;p+=stp){const y=Math.round(Y(p))+.5;if(S.grid){cx.strokeStyle=gr;cx.beginPath();cx.moveTo(0,y);cx.lineTo(pw,y);cx.stroke()}cx.fillStyle=mu;cx.textAlign='left';cx.fillText(fm(p),pw+8,y)}
 const ev=Math.max(1,Math.round(100/bw/ (TF[S.tf]>=86400?1:1)));
 for(let i=Math.ceil(i0/ev)*ev;i<=i1;i+=ev){const x=Math.round(X(i))+.5,d=new Date(a[i].t*1000);if(S.grid){cx.strokeStyle=gr;cx.beginPath();cx.moveTo(x,0);cx.lineTo(x,ph);cx.stroke()}cx.fillStyle=mu;cx.textAlign='center';cx.fillText(TF[S.tf]>=86400?d.toLocaleDateString([],{day:'2-digit',month:'short'}):d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false}),x,ph+12)}
 cx.strokeStyle=gr;cx.beginPath();cx.moveTo(pw+.5,0);cx.lineTo(pw+.5,H);cx.moveTo(0,ph+.5);cx.lineTo(W,ph+.5);cx.stroke();
 cx.save();cx.beginPath();cx.rect(0,0,pw,ph);cx.clip();
 if(S.ind.vol)for(let i=i0;i<=i1;i++){const c=a[i];cx.fillStyle=(c.c>=c.o?S.up:S.dn)+'55';const h=c.v/vm*ph*.16;cx.fillRect(X(i)-bw*.35,ph-h,Math.max(1,bw*.7),h)}
 if(false){const[m,u,l]=bb(a);cx.beginPath();for(let i=i0;i<=i1;i++)if(u[i]!=null)cx.lineTo(X(i),Y(u[i]));for(let i=i1;i>=i0;i--)if(l[i]!=null)cx.lineTo(X(i),Y(l[i]));cx.fillStyle='#9b7cf422';cx.fill();line(u,'#9b7cf4',i0,i1,1);line(l,'#9b7cf4',i0,i1,1);line(m,'#9b7cf488',i0,i1,1)}
 if(S.type==='candle'){const dw=Math.max(1,Math.round(dpr)),sn=v=>(dw%2?Math.floor(v*dpr)+.5:Math.round(v*dpr))/dpr,s1=v=>Math.round(v*dpr)/dpr;cx.imageSmoothingEnabled=true;cx.imageSmoothingQuality='high';
  for(let i=i0;i<=i1;i++){const c=a[i],col=c.c>=c.o?S.up:S.dn,x=X(i),wx=sn(x);cx.strokeStyle=col;cx.fillStyle=col;cx.lineWidth=dw/dpr;cx.lineCap='butt';cx.beginPath();cx.moveTo(wx,s1(Y(c.h)));cx.lineTo(wx,s1(Y(c.l)));cx.stroke();
   const bwd=Math.max(dw,Math.round(bw*.7*dpr))/dpr,bl=s1(wx-bwd/2),bt=s1(Y(Math.max(c.o,c.c))),bb2=s1(Y(Math.min(c.o,c.c)));cx.fillRect(bl,bt,bwd,Math.max(1/dpr,bb2-bt))}}
 else{cx.beginPath();for(let i=i0;i<=i1;i++)i===i0?cx.moveTo(X(i),Y(a[i].c)):cx.lineTo(X(i),Y(a[i].c));cx.strokeStyle=S.up;cx.lineWidth=1.8;cx.stroke();if(S.type==='area'){cx.lineTo(X(i1),ph);cx.lineTo(X(i0),ph);const g=cx.createLinearGradient(0,0,0,ph);g.addColorStop(0,S.up+'66');g.addColorStop(1,S.up+'00');cx.fillStyle=g;cx.fill()}}
 drawInd(a,i0,i1,ph);
 drawPos();
 ORD.filter(o=>o.sym===S.sym).forEach(o=>{const y=Y(o.price);cx.strokeStyle='#e0a030';cx.setLineDash([2,4]);cx.beginPath();cx.moveTo(0,y);cx.lineTo(pw,y);cx.stroke();cx.setLineDash([]);lbl(`${o.type.toUpperCase()} ${o.side.toUpperCase()} ${o.lots}`,8,y-11,'#e0a030','#111')});
 if(!S.hide){const q=(d,o)=>{dd(d,o,tx,mu);cx.setLineDash([]);if(d.txt&&d.p[0])lbl(d.txt,X(d.p[0].i)+6,Y(d.p[0].p)-14,d.col||AC(),d.tc||'#111')};DR.forEach((d,k)=>{if(d.sym===S.sym)q(d,k===sel)});if(pend)q(pend,1)}
 cx.restore();AXL.forEach(([t,y,c])=>lbl(t,pw,y,c));
 const L=a[a.length-1],lc=L.c>=L.o?S.up:S.dn,ly=Y(L.c);cx.strokeStyle=S.dn;cx.setLineDash([3,3]);cx.beginPath();cx.moveTo(0,ly);cx.lineTo(pw,ly);cx.stroke();cx.setLineDash([]);
 const rem=Math.max(0,L.t+TF[S.tf]-Math.floor(Date.now()/1000));lbl(fm(L.c),pw,ly-1,S.dn);lbl(rem>=3600?Math.floor(rem/3600)+'h':String(Math.floor(rem/60)).padStart(2,'0')+':'+String(rem%60).padStart(2,'0'),pw,ly+14,S.dn);
 if(!hideXH()&&(mouse&&mouse.x<pw&&mouse.y<ph&&S.tool!=='cursor'||mouse&&mouse.x<pw&&mouse.y<ph&&(!drag||drag.m==='p'))){cx.strokeStyle=tx;cx.lineWidth=1;cx.setLineDash([6,5]);cx.beginPath();cx.moveTo(mouse.x,0);cx.lineTo(mouse.x,ph);cx.moveTo(0,mouse.y);cx.lineTo(pw,mouse.y);cx.stroke();cx.setLineDash([]);cx.lineWidth=3;cx.lineCap='butt';cx.beginPath();cx.moveTo(mouse.x-8,mouse.y);cx.lineTo(mouse.x+8,mouse.y);cx.moveTo(mouse.x,mouse.y-8);cx.lineTo(mouse.x,mouse.y+8);cx.stroke();cx.lineWidth=1;lbl(fm(PP(mouse.y)),pw,mouse.y,'#44575d');const i=Math.round(I(mouse.x));if(a[i]){const d=new Date(a[i].t*1000);lbl(d.toLocaleString([],{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}),mouse.x,ph+12,'#44575d','#fff','center')}}
 const hi2=mouse&&a[Math.round(I(mouse.x))]||L;if(lgdEl){const uc=hi2.c>=hi2.o?'var(--buy)':'var(--sell)';lgdEl.innerHTML=`<b class="lt">${S.sym} · ${S.tf}</b><span class="lv"><i>O</i><b style="color:${uc}">${fm(hi2.o)}</b></span><span class="lv"><i>H</i><b style="color:${uc}">${fm(hi2.h)}</b></span><span class="lv"><i>L</i><b style="color:${uc}">${fm(hi2.l)}</b></span><span class="lv"><i>C</i><b style="color:${uc}">${fm(hi2.c)}</b></span>`}
}
const ARW=t=>['arrow','arrm','mu','md','ml','mr'].includes(t);
function ahHit(d,x,y){const p=d.p,x0=X(p[0].i),y0=Y(p[0].p),x1=X(p[1].i),y1=Y(p[1].p),s=d.sc||1;
 if(d.type==='text')return 'b';
 if(['mu','md','ml','mr'].includes(d.type)){return Math.hypot(x-(x0+14*s),y-(y0-14*s))<8?'sc':'b'}
 if(Math.hypot(x-x0,y-y0)<8)return 'p0';if(Math.hypot(x-x1,y-y1)<8)return 'p1';return 'b'}
function ahd(x,y,a,L,f){cx.beginPath();cx.moveTo(x,y);cx.lineTo(x-L*Math.cos(a-.4),y-L*Math.sin(a-.4));cx.lineTo(x-L*Math.cos(a+.4),y-L*Math.sin(a+.4));cx.closePath();f?cx.fill():cx.stroke()}
function dd(d,on,tx,mu){if(d.type==='pos'&&d.side&&d.sl==null){const q=d.p[1],e0=d.p[0].p,k0=Math.abs(q.p-e0);q.p=d.side==='short'?e0-k0:e0+k0}const c=d.col||AC(),p=d.p,x0=X(p[0].i),y0=Y(p[0].p),x1=X(p[1].i),y1=Y(p[1].p);cx.strokeStyle=c;cx.fillStyle=c;cx.lineWidth=(d.w||2)+(on?.8:0);cx.setLineDash(d.ls==='dash'?[8,5]:d.ls==='dot'?[2,4]:[]);cx.beginPath();
 if(d.type==='hline'){cx.moveTo(0,y0);cx.lineTo(pw,y0);cx.stroke();lbl(fm(p[0].p),pw,y0,c,d.tc||'#111')}
 else if(d.type==='vline'){cx.moveTo(x0,0);cx.lineTo(x0,ph);cx.stroke()}
 else if(d.type==='trend'||d.type==='ray'){let ex=x1,ey=y1;if(d.type==='ray'&&(x1!==x0||y1!==y0)){const k=3000/Math.hypot(x1-x0,y1-y0);ex=x0+(x1-x0)*k;ey=y0+(y1-y0)*k}cx.moveTo(x0,y0);cx.lineTo(ex,ey);cx.stroke();if(on){[[x0,y0],[x1,y1]].forEach(([x,y])=>{cx.beginPath();cx.arc(x,y,4,0,7);cx.fill()})}}
 else if(d.type==='rect'||d.type==='measure'){const up=p[1].p>=p[0].p;cx.fillStyle=d.type==='measure'?(up?'#2ecc7133':'#ef535033'):c+hx(d.fl??13);cx.fillRect(x0,y0,x1-x0,y1-y0);cx.strokeStyle=d.type==='measure'?(up?'#2ecc71':'#ef5350'):c;cx.strokeRect(x0,y0,x1-x0,y1-y0);
  if(d.type==='measure'){const dp=p[1].p-p[0].p,t=`${dp>=0?'+':''}${fm(dp)} (${(dp/p[0].p*100).toFixed(2)}%) · ${Math.round(p[1].i-p[0].i)} bars`;lbl(t,Math.min(x0,x1),Math.min(y0,y1)-12,'#44575d')}}
 else if(d.type==='path'||d.type==='brush'){if(d.hi){cx.globalAlpha=.35;cx.lineWidth=14;cx.lineCap='square'}p.forEach((q,k)=>{k?cx.lineTo(X(q.i),Y(q.p)):cx.moveTo(X(q.i),Y(q.p))});cx.stroke();cx.globalAlpha=1;cx.lineCap='butt';if(d.type==='path')p.forEach((q,k)=>{cx.beginPath();cx.arc(X(q.i),Y(q.p),3.5,0,7);cx.fill();cx.fillStyle=d.tc||c;cx.textAlign='left';cx.fillText('XABCD'[k]||'',X(q.i)+6,Y(q.p)-9);cx.fillStyle=c})}
 else if(d.type==='pos'){const g=pg(d),sy=SY[d.sym]||SY[S.sym],lt=d.lots||.1,tk=Math.pow(10,-sy.d),w=Math.max(2,g.xr-g.xl),L=g.t>=g.e,bgc=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()||'#fff';
 cx.setLineDash([]);cx.lineWidth=1;
 cx.fillStyle=d.lc?d.lc+'40':'rgba(242,54,69,.2)';cx.fillRect(g.xl,Math.min(g.ye,g.ys),w,Math.abs(g.ys-g.ye));
 cx.fillStyle=d.fc?d.fc+'40':'rgba(8,153,129,.22)';cx.fillRect(g.xl,Math.min(g.ye,g.yt),w,Math.abs(g.yt-g.ye));
 cx.strokeStyle='#f23645';cx.beginPath();cx.moveTo(g.xl,g.ys);cx.lineTo(g.xr,g.ys);cx.stroke();
 cx.strokeStyle='#089981';cx.beginPath();cx.moveTo(g.xl,g.yt);cx.lineTo(g.xr,g.yt);cx.stroke();
 cx.strokeStyle='#868993';cx.beginPath();cx.moveTo(g.xl,g.ye);cx.lineTo(g.xr,g.ye);cx.stroke();
 const f=v=>Number(v).toLocaleString('en-US',{maximumFractionDigits:2}),info=(n,pr)=>{const df=Math.abs(pr-g.e);return n+': '+fm(df)+' ('+(df/g.e*100).toFixed(3)+'%) '+Math.round(df/tk).toLocaleString('en-US')+', Amount: '+f(df*sy.c*lt)};
 const pnl=(L?P[d.sym]-g.e:g.e-P[d.sym])*sy.c*lt,rr=Math.abs(g.t-g.e)/(Math.abs(g.s-g.e)||1),xc=(g.xl+g.xr)/2,cl=y=>Math.max(14,Math.min(ph-14,y));
 if(d.tx!==0)plb([info('Stop',g.s)],xc,cl(g.ys+(g.ys<g.ye?-16:16)),'#f23645');
 if(d.tx!==0)plb([info('Target',g.t)],xc,cl(g.yt+(g.yt<g.ye?-16:16)),'#089981');
 if(d.tx!==0)plb(['Open P&L: '+pnl.toFixed(2)+', Qty: '+lt,'Risk/Reward Ratio: '+(+rr.toFixed(2))],xc,g.ye,'#089981');
 if(on)[[g.xl,g.ys],[g.xl,g.ye],[g.xl,g.yt],[g.xr,g.ye]].forEach(([x,y])=>{rrect(x-6,y-6,12,12,4);cx.fillStyle=bgc;cx.fill();cx.strokeStyle='#2962ff';cx.lineWidth=2;cx.stroke()})}
 else if(d.type==='zoom'){cx.fillStyle=tx+'22';cx.fillRect(x0,y0,x1-x0,y1-y0);cx.strokeStyle=mu;cx.setLineDash([4,3]);cx.strokeRect(x0,y0,x1-x0,y1-y0)}
 else if(d.type==='arrow'||d.type==='arrm'){const a=Math.atan2(y1-y0,x1-x0);cx.moveTo(x0,y0);cx.lineTo(x1,y1);cx.stroke();if(d.type==='arrow'){cx.beginPath();cx.arc(x0,y0,3.5,0,7);cx.stroke();ahd(x1,y1,a,12,1)}else ahd(x1,y1,a,16,0);if(on)[[x0,y0],[x1,y1]].forEach(([x,y])=>{cx.beginPath();cx.arc(x,y,4,0,7);cx.fill()})}
 else if(['mu','md','ml','mr'].includes(d.type)){const P={mu:[[0,-14],[12,-2],[5,-2],[5,12],[-5,12],[-5,-2],[-12,-2]],md:[[0,14],[12,2],[5,2],[5,-12],[-5,-12],[-5,2],[-12,2]],ml:[[-14,0],[-2,-12],[-2,-5],[12,-5],[12,5],[-2,5],[-2,12]],mr:[[14,0],[2,-12],[2,-5],[-12,-5],[-12,5],[2,5],[2,12]]}[d.type].map(([u,v])=>[u*(d.sc||1),v*(d.sc||1)]);cx.beginPath();P.forEach(([u,v],k)=>k?cx.lineTo(x0+u,y0+v):cx.moveTo(x0+u,y0+v));cx.closePath();cx.stroke();if(on){cx.beginPath();cx.arc(x0+14*(d.sc||1),y0-14*(d.sc||1),4,0,7);cx.fill()}}
 else if(d.type==='emoji'){cx.font='26px "Segoe UI Emoji",serif';cx.textAlign='center';cx.fillText(d.txt||'😀',x0,y0);cx.font='11px "Segoe UI",system-ui,sans-serif'}
 else if(d.type==='fib'){[0,.236,.382,.5,.618,.786,1].forEach((f,k)=>{const pr=p[1].p+(p[0].p-p[1].p)*f,y=Y(pr);cx.strokeStyle=['#7e9298','#ef5350','#e0a030','#2ecc71','#26b5a8','#2d7ff9','#7e9298'][k];cx.lineWidth=(d.w||1.2)+(on?.8:0);cx.beginPath();cx.moveTo(Math.min(x0,x1),y);cx.lineTo(Math.max(x0,x1),y);cx.stroke();cx.fillStyle=d.tc||cx.strokeStyle;cx.textAlign='left';cx.fillText(`${f} (${fm(pr)})`,Math.min(x0,x1)+4,y-7)});cx.strokeStyle=mu;cx.setLineDash([3,3]);cx.beginPath();cx.moveTo(x0,y0);cx.lineTo(x1,y1);cx.stroke();cx.setLineDash([])}}
function sd(x,y,a,b,c,d,r){const dx=c-a,dy=d-b,l=dx*dx+dy*dy,t=l?Math.max(r?-1e9:0,Math.min(r?1e9:1,((x-a)*dx+(y-b)*dy)/l)):0;return Math.hypot(x-(a+t*dx),y-(b+t*dy))}
function hit(x,y){if(S.lock||S.hide)return-1;for(let k=DR.length-1;k>=0;k--){const d=DR[k];if(d.sym!==S.sym)continue;const p=d.p,x0=X(p[0].i),y0=Y(p[0].p),x1=X(p[1].i),y1=Y(p[1].p);let h=0;
 if(d.type==='hline')h=Math.abs(y-y0)<6;else if(d.type==='vline')h=Math.abs(x-x0)<6;else if(d.type==='text'){cx.font='11px "Segoe UI",system-ui,sans-serif';const tw=cx.measureText(d.txt||'Text').width+10;h=x>=x0&&x<=x0+6+tw&&y>=y0-23&&y<=y0-5}else if(d.type==='arrow'||d.type==='arrm')h=sd(x,y,x0,y0,x1,y1)<7;else if(['mu','md','ml','mr'].includes(d.type))h=Math.abs(x-x0)<16*(d.sc||1)&&Math.abs(y-y0)<18*(d.sc||1);else if(d.type==='emoji')h=Math.abs(x-x0)<16&&Math.abs(y-y0+10)<16;else if(d.type==='path'||d.type==='brush'){for(let j=1;j<p.length;j++)if(sd(x,y,X(p[j-1].i),Y(p[j-1].p),X(p[j].i),Y(p[j].p))<7)h=1}else if(d.type==='trend'||d.type==='ray')h=sd(x,y,x0,y0,x1,y1,d.type==='ray')<7;
 else if(d.type==='pos'){const g=pg(d);h=x>=g.xl-6&&x<=g.xr+6&&y>=Math.min(g.ys,g.yt)-6&&y<=Math.max(g.ys,g.yt)+6}else{h=x>=Math.min(x0,x1)-5&&x<=Math.max(x0,x1)+5&&y>=Math.min(y0,y1)-5&&y<=Math.max(y0,y1)+5}if(h)return k}return-1}
function pt(x,y){let i=I(x),p=PP(y);if(S.magnet){const a=D[key()],c=a[Math.round(i)];if(c){i=Math.round(i);p=[c.o,c.h,c.l,c.c].reduce((m,v)=>Math.abs(v-p)<Math.abs(m-p)?v:m)}}return{i,p}}
function rs(){PN.forEach(p=>{const r=p.el.getBoundingClientRect();p.dpr=Math.max(2,devicePixelRatio||1);p.W=r.width;p.H=r.height;p.cv.width=Math.max(1,Math.round(r.width*p.dpr));p.cv.height=Math.max(1,Math.round(r.height*p.dpr))});if(PN[AP]){const p=PN[AP];W=p.W;H=p.H;dpr=p.dpr}draw()}
new ResizeObserver(rs).observe($('#cw'));
function commit(){if(pend.type==='pos')posFix(pend);if(pend.type==='zoom'){zoomTo(pend);pend=null;S.tool='cursor';tbr();draw();return}DR.push(pend);sel=DR.length-1;pend=null;if(!S.stay)S.tool='cursor';tbr();draw()}
const rel=e=>{const r=cv.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}};
function posIn(d,x,y){const g=pg(d);return x>=g.xl-6&&x<=g.xr+6&&y>=Math.min(g.ys,g.yt)-6&&y<=Math.max(g.ys,g.yt)+6}
gr.addEventListener('pointerdown',e=>{const{x,y}=rel(e);cv.setPointerCapture(e.pointerId);DR.forEach(d=>{if(d.type==='pos'&&d.sym===S.sym)d.tx=posIn(d,x,y)?1:0});
 const ovh=x<=pw?ovHit(x,y):null;if(ovh){if(ovh.act)ovh.act();else if(ovh.btn){drag={m:'pl',p:ovh.drag.p,k:ovh.drag.k,nw:1,y0:y}}else if(ovh.drag)drag={m:'pl',p:ovh.drag.p,k:ovh.drag.k};ftr();draw();return}
 if(x>pw&&!(S.tool==='cursor'&&!S.lock&&hit(x,y)>=0&&DR[hit(x,y)].type==='text')){drag={m:'y',y,ys:V.ys};return}
  if(y>ph&&x<=pw){drag={m:'x',x,bw:V.bw};return}
 if(!['cursor','cross'].includes(S.tool)){const p=pt(x,y);if(pend){const n=pend.p.length;pend.p[n-1]=p;if(n<(NP[pend.type]||2))pend.p.push(p);else commit()}else{pdn={x,y};pend={...DEF,type:(S.tool==='long'||S.tool==='short')?'pos':S.tool,side:(S.tool==='long'||S.tool==='short')?S.tool:undefined,sym:S.sym,p:[p,p]};const tt=S.tool;if(tt==='text')pend.txt='Text';if(tt==='emoji')pend.txt='😀';if(tt==='brush')drag={m:'b'};if(tt==='hl'){pend.type='brush';pend.hi=1;pend.col='#f5c518';drag={m:'b'}}if(['hline','vline','text','emoji','mu','md','ml','mr'].includes(tt)){commit();if(tt==='text'||tt==='emoji')dset()}}return}
 if(S.tool==='cursor'&&sel>=0&&DR[sel]&&DR[sel].type==='pos'&&!DR[sel].lk&&!S.lock){const hk=ph2(DR[sel],x,y);if(hk){drag={m:'h',k:hk,d:DR[sel],s:pt(x,y),o:JSON.parse(JSON.stringify(DR[sel].p)),sl:DR[sel].sl};ftr();draw();return}}
 if(S.tool==='cursor'&&!S.lock){const hh=hit(x,y);if(hh>=0&&(ARW(DR[hh].type)||DR[hh].type==='text')&&!DR[hh].lk){sel=hh;const d=DR[hh],hk=ahHit(d,x,y);drag=hk==='sc'?{m:'sc',d}:hk==='b'?{m:'am',d,ax:X(d.p[0].i),ay:Y(d.p[0].p),sx:x,sy:y,o:JSON.parse(JSON.stringify(d.p))}:{m:'ap',d,k:hk==='p1'?1:0};ftr();draw();return}}
 sel=S.tool==='cursor'?hit(x,y):-1;if(sel<0)drag={m:'p',x,y,right:V.right,ysh:V.ysh};else if(DR[sel].type==='pos'&&!DR[sel].lk&&!S.lock){drag={m:'h',k:'e',d:DR[sel],s:pt(x,y),o:JSON.parse(JSON.stringify(DR[sel].p)),sl:DR[sel].sl}}ftr();draw()});
gr.addEventListener('pointermove',e=>{const{x,y}=rel(e);if(drag&&e.pointerType==='mouse'&&e.buttons===0)endDrag();mouse={x,y};navUp();if(drag&&drag.m==='h')posDrag(x,y);if(drag&&drag.m==='pl'){if(Math.abs(y-drag.y0)>3)drag.moved=1;ovDrag(y)}
 if(pend&&pend.type!=='brush')pend.p[pend.p.length-1]=pt(x,y);if(drag&&drag.m==='b'&&pend)pend.p.push(pt(x,y));
 if(drag&&(drag.m==='am'||drag.m==='ap'||drag.m==='sc')){const q=pt(x,y),d=drag.d;if(drag.m==='am'){const nx=Math.max(0,Math.min(pw,drag.ax+(x-drag.sx))),ny=Math.max(0,Math.min(ph,drag.ay+(y-drag.sy))),dI=I(nx)-I(drag.ax),dP=PP(ny)-PP(drag.ay);d.p=[{i:drag.o[0].i+dI,p:drag.o[0].p+dP},{i:drag.o[1].i+dI,p:drag.o[1].p+dP}]}else if(drag.m==='ap')d.p[drag.k]={i:q.i,p:q.p};else d.sc=Math.max(.3,Math.min(5,Math.hypot(x-X(d.p[0].i),y-Y(d.p[0].p))/19.8))}
 if(drag){if(drag.m==='x'){V.lk=null;V.bw=Math.max(2,Math.min(40,drag.bw*Math.exp((x-drag.x)*.006)))}else if(drag.m==='y'){V.ys=Math.max(.1,Math.min(10,drag.ys*Math.exp((y-drag.y)*.006)))}else if(drag.m==='p'){if(!drag.mv&&Math.hypot(x-drag.x,y-drag.y)<4)return draw();drag.mv=1;const n=D[key()].length;V.right=Math.max(5,Math.min(n+80,drag.right-(x-drag.x)/V.bw));V.ysh=drag.ysh+(y-drag.y)*(mx-mn)/ph}}
 draw()});
gr.addEventListener('pointerup',e=>{if(drag&&drag.m==='b'&&pend)commit();else if(pend&&pdn&&!NP[pend.type]&&pend.type!=='brush'&&pend.p.length===2){const{x,y}=rel(e);if(Math.hypot(x-pdn.x,y-pdn.y)>8){pend.p[1]=pt(x,y);commit()}}if(drag&&drag.m==='pl'&&drag.v!=null&&(!drag.nw||drag.moved)){if(drag.p.ghost)TPS[drag.k]=+drag.v.toFixed(dc());else drag.p[drag.k]=drag.v;ftr();draw()}pdn=null;drag=null});gr.addEventListener('pointerleave',e=>{if(e.relatedTarget&&NAV.contains(e.relatedTarget))return;mouse=null;mousePane=-1;navUp();draw()},true);
function endDrag(){if(drag&&drag.m==='b'&&pend)commit();pdn=null;drag=null}
gr.addEventListener('pointercancel',endDrag);gr.addEventListener('lostpointercapture',()=>{if(drag&&drag.m==='p')endDrag()});
gr.addEventListener('dblclick',e=>{if(rel(e).x>pw){V.ys=1;V.ysh=0;draw()}else if(sel>=0)dset()});
gr.addEventListener('wheel',e=>{e.preventDefault();V.lk=null;V.bw=Math.max(2,Math.min(40,V.bw*(e.deltaY<0?1.12:.89)));draw()},{passive:false});
addEventListener('keydown',e=>{if(/INPUT|SELECT/.test(e.target.tagName))return;const m={t:'trend',h:'hline',v:'vline',r:'rect',f:'fib'};
 if(e.key==='Escape'){pend=null;S.tool='cursor';sel=-1;tbr();draw()}
 else if((e.key==='Delete'||e.key==='Backspace')&&sel>=0&&!DR[sel].lk){DR.splice(sel,1);sel=-1;ftr();draw()}
 else if(e.altKey&&m[e.key.toLowerCase()]){e.preventDefault();S.tool=m[e.key.toLowerCase()];tbr()}});
/* trading */
const pl=p=>validQuote(p.sym)?calculatePositionPnl(p,Q[p.sym]):p.pnl;
const pnlAt=(p,price)=>calculatePositionPnl(p,{bid:price,ask:price});
const pls=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?(Number(v)>=0?'+':'')+Number(v).toFixed(2):'–';
function toast(t){const e=$('#ts');e.textContent=t;e.style.display='block';clearTimeout(toast.h);toast.h=setTimeout(()=>e.style.display='none',2600)}
const lots=()=>Number($('#vl').value),num=id=>Number($(id).value);
let submitting=0;
function place(){if(!ACC[AI]?.tradingEnabled)return toast('Trading is disabled for this account');if(!accountState||Date.now()-accountStateUpdatedAt>15000)return toast('Current account state is unavailable. No order was placed.');if(!validQuote(S.sym))return toast('A fresh, open-market quote is required. No order was placed.');
 const y=S.sym,l=lots(),tp=absLvl('tp'),sl=absLvl('sl'),t=S.ot,b=S.side==='buy',px=b?ask(y):bid(y);
 if(t!=='market')return toast('Limit and stop orders are unavailable until server-side execution is implemented.');
 if(!Number.isFinite(l)||l<=0)return toast('Enter a valid order volume');
 if(tp&&(b?tp<=px:tp>=px))return toast('Take profit must be '+(b?'above':'below')+' the entry price');
 if(sl&&(b?sl>=px:sl<=px))return toast('Stop loss must be '+(b?'below':'above')+' the entry price');
 if(submitting)return;
 void liveOrder({symbol:y,side:S.side.toUpperCase(),volume:l,order_type:'MARKET',take_profit:tp||null,stop_loss:sl||null})}
function closeP(p){return liveClose(p)}
function md(h,ok,okt='Confirm'){$('#mb').innerHTML=h+(ok?`<div class="two" style="margin-top:14px"><button id="mc">Cancel</button><button id="mo" style="background:var(--ac);color:#0d1416;font-weight:700">${okt}</button></div>`:'');$('#md').classList.add('o');if(ok){$('#mc').onclick=()=>$('#md').classList.remove('o');$('#mo').onclick=()=>{$('#md').classList.remove('o');ok()}}}
$('#md').onclick=e=>{if(e.target.id==='md')$('#md').classList.remove('o')};
$('#go').onclick=()=>{if(!ACC[AI]?.tradingEnabled)return toast('Trading is disabled for this account');if(!validQuote(S.sym))return toast('A fresh, open-market quote is required. No order was placed.');if(S.ot!=='market')return toast('Limit and stop orders are unavailable until server-side execution is implemented.');
 if(S.one)return place();const px=S.side==='buy'?ask(S.sym):bid(S.sym);md(`<h3>Review ${S.side.toUpperCase()} ${escapeHtml(S.sym)}</h3>${[['Type','Market'],['Volume',lots()+' lots'],['Displayed price',fm(px)],['Take profit',absLvl('tp')||'–'],['Stop loss',absLvl('sl')||'–']].map(r=>`<div class="row"><span>${r[0]}</span><b>${r[1]}</b></div>`).join('')}`,place,'Place order')};
$$('[data-s]').forEach(b=>b.onclick=()=>{S.side=b.dataset.s;PV.on=1;ui();tick(0)});
$('#ot').onchange=e=>{S.ot=e.target.value;if(S.ot!=='market')toast('Limit and stop orders are unavailable until server-side execution is implemented.');ui()};
function holdStep(d){$('#vl').value=Math.max(.01,Math.round((lots()+d)*100)/100).toFixed(2);ui()}
function holdBtn(b,d){let t1=null,t2=null;const stop=()=>{clearTimeout(t1);clearInterval(t2);t1=t2=null};
 b.addEventListener('pointerdown',e=>{e.preventDefault();stop();holdStep(d);t1=setTimeout(()=>{t2=setInterval(()=>holdStep(d),90)},400)});
 ['pointerup','pointerleave','pointercancel'].forEach(ev=>b.addEventListener(ev,stop))}
holdBtn($('#vm'),-.01);holdBtn($('#vp'),.01);
$('#oc').onclick=()=>{S.one=S.one?0:1;sv();ui()};['#vl','#pr'].forEach(i=>$(i).oninput=ui);
['tp','sl'].forEach(k=>{const el=$('#'+k);
 el.addEventListener('blur',()=>ui());
 el.addEventListener('input',()=>{const v=parseFloat(el.value);TPS[k]=isNaN(v)?null:+v.toFixed(dc());ui()});
 $('#'+k+'x').onclick=()=>{TPS[k]=null;ui()};
 holdRep($('#'+k+'m'),()=>stepLvl(k,-1));holdRep($('#'+k+'p'),()=>stepLvl(k,1))});
const TPS={tp:null,sl:null};
const refPx=()=>S.side==='buy'?ask(S.sym):bid(S.sym);
function absLvl(k){return TPS[k]==null?0:TPS[k]}
function holdRep(b,fn){let t1=null,t2=null;const stop=()=>{clearTimeout(t1);clearInterval(t2)};b.addEventListener('pointerdown',e=>{e.preventDefault();stop();fn();t1=setTimeout(()=>{t2=setInterval(fn,90)},400)});['pointerup','pointerleave','pointercancel'].forEach(ev=>b.addEventListener(ev,stop))}
function stepLvl(k,d){const st=Math.pow(10,-dc())*10,b=S.side==='buy',dflt=((k==='tp')===b?1:-1)*st*10;TPS[k]=+((TPS[k]==null?refPx()+dflt:TPS[k])+d*st).toFixed(dc());ui()}
function renderLvl(){const ref=refPx(),d=dc(),tk=Math.pow(10,-d),b=S.side==='buy';
 ['tp','sl'].forEach(k=>{const el=$('#'+k),inf=$('#'+k+'i');
  if(document.activeElement!==el)el.value=TPS[k]==null?'':fm(TPS[k],d);
  if(TPS[k]==null){inf.textContent='';return}
  if(!Number.isFinite(ref)){inf.textContent='Live price estimate unavailable';return}
  const pl2=(TPS[k]-ref)*(b?1:-1),pct=pl2/ref*100,sg=v=>(v>=0?'+':'')+v.toLocaleString('en-US',{maximumFractionDigits:2});
  inf.innerHTML=`<span class="${pl2>=0?'up':'dn'}">${sg(pct)} % from live price · USD risk is server-calculated</span>`})}
function brchUi(){const account=ACC[AI],accountOff=!!account&&!account.tradingEnabled,disabled=!account?.tradingEnabled||!accountState||Date.now()-accountStateUpdatedAt>15000||!validQuote(S.sym)||submitting;document.body.classList.toggle('brch',accountOff);$('#brb').style.display=accountOff?'block':'none';$('#go').disabled=disabled;$('#qs').disabled=$('#qb').disabled=disabled;if(accountOff){PV.on=0}}
function ui(){brchUi();renderLvl();const y=S.sym,b=S.side==='buy',px=b?ask(y):bid(y);$$('[data-s]').forEach(e=>e.classList.toggle('on',e.dataset.s===S.side));$('#oc').classList.toggle('on',!!S.one);$('#prw').style.display=S.ot==='market'?'none':'block';
 $('#go').className=b?'':'s';$('#go').textContent=validQuote(y)?`Review ${S.side.toUpperCase()} ${y}  ${fm(px)}`:'Market data unavailable';
 $('#sb').textContent=fm(bid(y));$('#sa').textContent=fm(ask(y));$('#smg').textContent=accountState?.used_margin==null?'–':'$'+Number(accountState.used_margin).toFixed(2);$('#srk').textContent='–'}
/* tables */
function tbl(){let h='';
 if(tab==='p')h=POS.length?`<table><tr><th>Symbol</th><th>Type</th><th>Lots</th><th>Open</th><th>Current</th><th>TP</th><th>SL</th><th>P/L (USD)</th><th></th></tr>${POS.map(p=>{const v=pl(p),d=dc(p.sym);return`<tr><td>${escapeHtml(p.sym)}</td><td class="${p.side==='buy'?'up':'dn'}">${p.side.toUpperCase()}</td><td>${p.lots}</td><td>${fm(p.open,d)}</td><td>${fm(p.side==='buy'?bid(p.sym):ask(p.sym),d)}</td><td>${p.tp?fm(p.tp,d):'–'}</td><td>${p.sl?fm(p.sl,d):'–'}</td><td class="${v==null?'':v>=0?'up':'dn'}">${pls(v)}</td><td><button class="x" data-c="${escapeHtml(p.id)}">Close</button></td></tr>`}).join('')}</table>`:'<div class="emp">No open positions. Positions appear here after an order is filled.</div>';
 if(tab==='o')h='<div class="emp">Pending orders and cancellation are unavailable until server-side pending-order execution is implemented.</div>';
 if(tab==='h')h=HIS.length?`<table><tr><th>Time</th><th>Symbol</th><th>Type</th><th>Lots</th><th>Open</th><th>Close</th><th>Exit</th><th>P/L</th></tr>${HIS.map(x=>`<tr><td>${x.t instanceof Date&&Number.isFinite(x.t.getTime())?x.t.toLocaleTimeString():'–'}</td><td>${escapeHtml(x.sym)}</td><td>${escapeHtml(x.side)}</td><td>${x.lots}</td><td>${fm(x.open,dc(x.sym))}</td><td>${fm(x.close,dc(x.sym))}</td><td>${escapeHtml(x.why)}</td><td class="${Number.isFinite(x.pl)?x.pl>=0?'up':'dn':''}">${pls(x.pl)}</td></tr>`).join('')}</table>`:'<div class="emp">No closed trades yet.</div>';
 $('#tw').innerHTML=h;$$('[data-c]').forEach(b=>b.onclick=()=>{const p=POS.find(x=>x.id===b.dataset.c);if(p)void closeP(p);tick(0)})}
$$('#tbs [data-t]').forEach(b=>b.onclick=()=>{tab=b.dataset.t;$$('#tbs [data-t]').forEach(x=>x.classList.toggle('on',x===b));tbl()});
$('#ca').onclick=async()=>{if(!POS.length)return;$('#ca').disabled=true;try{for(const p of [...POS])await closeP(p)}finally{$('#ca').disabled=false;tick(0)}};
/* tick */
function tick(){const y=S.sym,q=Q[y],m=n=>n!==null&&n!==undefined&&n!==''&&Number.isFinite(Number(n))?'$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'–';
 if(y&&SY[y]){$('#hs').textContent=$('#ts1').textContent=y;const status=validQuote(y)?'Live':q?.market_state?.toLowerCase()==='closed'?'Market closed':q?'Stale':marketStatusText;$('#hn').textContent=`${SY[y].n} · ${status}`;$('#hn').title=SY[y].n;$('#hn').style.color=validQuote(y)?'var(--buy)':q?.market_state?.toLowerCase()==='closed'?'var(--sell)':'var(--warn)';}
 {const pb=$('#pb');if(pb){pb.textContent=fm(bid(y));$('#pa').textContent=fm(ask(y));$('#ps').textContent=fm(sp(y))}}
 {const pbl=$('#pbal');if(pbl){pbl.textContent=m(accountState?.balance);$('#peq').textContent=m(accountState?.equity);$('#pfm').textContent=m(accountState?.free_margin??accountState?.available_margin)}}
 const total=accountState?.open_pnl;$('#pl').textContent=m(total);$('#pl').className=total!==null&&total!==undefined&&Number.isFinite(Number(total))?(Number(total)>0?'up':Number(total)<0?'dn':''):'';
 wlr();tbl();ui();if(typeof qpu==='function')qpu();draw()}
/* menus & settings */
function pop(btn,h){const p=$('#pp'),r=btn.getBoundingClientRect();p.innerHTML=h;p.style.left=r.left+'px';p.style.top=r.bottom+6+'px';p.classList.toggle('o');requestAnimationFrame(()=>{if(!p.classList.contains('o'))return;const q=p.getBoundingClientRect();p.style.left=Math.max(8,Math.min(q.left,innerWidth-q.width-8))+'px';p.style.top=Math.max(8,Math.min(q.top,innerHeight-q.height-8))+'px'});return p}
$('#hbd').onclick=e=>{e.stopPropagation();const rw=(l,i)=>`<div style="display:flex;justify-content:space-between;gap:28px;padding:6px 8px"><span style="color:var(--mu)">${l}</span><b id="${i}" style="font-variant-numeric:tabular-nums">–</b></div>`;const p=pop($('#hbd'),rw('Balance','pbal')+rw('Equity','peq')+rw('Free margin','pfm'));p.style.left=Math.max(8,Math.min(parseFloat(p.style.left),innerWidth-p.offsetWidth-8))+'px';p.onclick=ev=>ev.stopPropagation();tick(0)};
$('#sd').onclick=e=>{e.stopPropagation();const y=S.sym,rw=(l,i,v)=>`<div style="display:flex;justify-content:space-between;gap:28px;padding:6px 8px"><span style="color:var(--mu)">${l}</span><b id="${i}" style="font-variant-numeric:tabular-nums">${v}</b></div>`;const p=pop($('#sd'),rw('Bid','pb',fm(bid(y)))+rw('Ask','pa',fm(ask(y)))+rw('Spread','ps',fm(sp(y))));p.onclick=ev=>ev.stopPropagation()};
$('#bi').onclick=e=>{e.stopPropagation();const IORD=['ema','vol','bb','macd','emac'];const row=k=>k==='vol'?`<div style="display:flex;align-items:center;padding:3px 6px"><label style="display:flex;gap:8px;align-items:center;flex:1"><input type="checkbox" data-i="vol" ${S.ind.vol?'checked':''}>Volume</label></div>`:`<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 6px"><label style="display:flex;gap:8px;align-items:center;flex:1"><input type="checkbox" data-i="${k}" ${S.ix[k].on?'checked':''}>${IND[k].n}</label><button class="x" data-g="${k}" title="Settings" style="margin-left:8px">⚙</button></div>`;const p=pop(e.target,`<div style="padding:4px 6px;color:var(--mu);font-size:12px">Indicator name</div>`+IORD.map(row).join(''));p.onclick=ev=>{ev.stopPropagation();const g=ev.target.closest('[data-g]');if(g){p.classList.remove('o');ixSet(g.dataset.g)}};$$('[data-i]').forEach(c=>c.onchange=()=>{const k=c.dataset.i;if(k==='vol')S.ind.vol=c.checked?1:0;else S.ix[k].on=c.checked?1:0;sv();draw()})};
function ixSet(k){const I=IND[k],s=S.ix[k];const h=`<h3>${I.n}</h3><div class="row"><span>Show on chart</span><input type="checkbox" id="ix_on" ${s.on?'checked':''}></div><div class="row"><span>${I.c2?'Fast line colour':'Colour'}</span><input type="color" id="ix_c" value="${s.c}"></div>`+(I.c2?`<div class="row"><span>Slow line colour</span><input type="color" id="ix_c2" value="${s.c2}"></div>`:'')+I.pr.map(([pk,lb,mn,mx,st=1])=>`<div class="row"><span>${lb}</span><input class="in" type="number" style="width:110px" data-p="${pk}" value="${s.p[pk]}" min="${mn}" max="${mx}" step="${st}"></div>`).join('')+`<div class="two" style="margin-top:14px"><button id="ix_r">Reset</button><button id="ix_d" style="background:var(--ac);color:#0d1416;font-weight:700">Done</button></div>`;md(h);
 $('#ix_on').onchange=e=>{s.on=e.target.checked?1:0;sv();draw()};
 $('#ix_c').oninput=e=>{s.c=e.target.value;sv();draw()};
 if(I.c2)$('#ix_c2').oninput=e=>{s.c2=e.target.value;sv();draw()};
 $$('#mb [data-p]').forEach(inp=>inp.onchange=()=>{const pr=I.pr.find(x=>x[0]===inp.dataset.p);let v=+inp.value;if(!isFinite(v))v=s.p[inp.dataset.p];v=Math.max(pr[2],Math.min(pr[3],v));s.p[inp.dataset.p]=v;inp.value=v;sv();draw()});
 $('#ix_r').onclick=()=>{s.p=Object.assign({},I.p);s.c=I.c;if(I.c2)s.c2=I.c2;sv();draw();ixSet(k)};
 $('#ix_d').onclick=()=>$('#md').classList.remove('o');
}
addEventListener('click',()=>$('#pp').classList.remove('o'));
function lic(k){const L={'1':'','2v':'<path d="M12 5v14"/>','2h':'<path d="M4 12h16"/>','3c':'<path d="M9.3 5v14M14.7 5v14"/>','3r':'<path d="M4 9.7h16M4 14.3h16"/>','3L':'<path d="M12 5v14M12 12h8"/>','3R':'<path d="M12 5v14M4 12h8"/>','3T':'<path d="M4 12h16M12 12v7"/>','3B':'<path d="M4 12h16M12 5v7"/>'}[k];return G('<rect x="4" y="5" width="16" height="14" rx="2"/>'+L,1)}
$('#br').onclick=e=>{e.stopPropagation();const b=e.currentTarget,r=b.getBoundingClientRect();$('#pp').classList.remove('o');
 const rows=[['1',['1']],['2',['2v','2h']],['3',['3c','3r','3L','3R','3T','3B']]];
 const p=pop(b,rows.map(([n,ks])=>'<div class="lr"><span>'+n+'</span>'+ks.map(k=>'<button data-l="'+k+'" class="'+(S.lay===k?'on':'')+'" title="'+LT[k]+'">'+lic(k)+'</button>').join('')+'</div>').join(''));
 p.style.left=Math.max(8,Math.min(r.left,innerWidth-260))+'px';
 p.onclick=ev=>{ev.stopPropagation();const l=ev.target.closest('[data-l]');if(!l)return;setLay(l.dataset.l);$('#pp').classList.remove('o')}};$('#bf').onclick=()=>{document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen().catch(()=>toast('Fullscreen is blocked in this view'))};
$('#tfs').innerHTML=Object.keys(TF).map(f=>`<button data-f="${f}">${f}</button>`).join('');
function seg(){$$('#tfs button').forEach(b=>b.classList.toggle('on',b.dataset.f===S.tf));$$('#tys button').forEach(b=>b.classList.toggle('on',b.dataset.t===S.type))}
$$('#tfs button').forEach(b=>b.onclick=()=>{S.tf=b.dataset.f;ensure();sv();seg();draw()});$$('#tys button').forEach(b=>b.onclick=()=>{S.type=b.dataset.t;sv();seg();draw()});
function theme(){const r=document.documentElement;S.theme==='auto'?r.removeAttribute('data-theme'):r.setAttribute('data-theme',S.theme);r.style.setProperty('--ac',S.ac)}
function settings(){const R=()=>{md(`<h3>Terminal settings</h3>
 <div class="row"><span>Toolbar icon style</span><select class="in" id="s1" style="width:130px"><option value="line">Line</option><option value="bold">Bold</option><option value="emoji">Emoji</option></select></div>
 <div class="row"><span>Theme</span><select class="in" id="s2" style="width:130px"><option value="auto">Auto</option><option value="dark">Dark</option><option value="light">Light</option></select></div>
 <div class="row"><span>Bullish candle</span><input type="color" id="s3" value="${S.up}"></div><div class="row"><span>Bearish candle</span><input type="color" id="s4" value="${S.dn}"></div><div class="row"><span>Accent colour</span><input type="color" id="s5" value="${S.ac}"></div>
 <div class="row"><span>Chart grid</span><input type="checkbox" id="s6" ${S.grid?'checked':''}></div>
 <h3 style="margin-top:14px">Drawing toolbar</h3>${S.order.map((k,i)=>`<div class="row"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-v="${k}" ${S.off.includes(k)?'':'checked'}>${IC[k][2].replace(/ \(.*/,'')}</label><span><button class="x" data-m="${i}:-1">▲</button> <button class="x" data-m="${i}:1">▼</button></span></div>`).join('')}
 <div class="two" style="margin-top:14px"><button id="sr">Reset defaults</button><button id="sd" style="background:var(--ac);color:#0d1416;font-weight:700">Done</button></div>`);
 $('#s1').value=S.pack;$('#s2').value=S.theme;
 const A=()=>{sv();theme();tbr();draw()};
 $('#s1').onchange=e=>{S.pack=e.target.value;A()};$('#s2').onchange=e=>{S.theme=e.target.value;A()};
 $('#s3').oninput=e=>{S.up=e.target.value;A()};$('#s4').oninput=e=>{S.dn=e.target.value;A()};$('#s5').oninput=e=>{S.ac=e.target.value;A()};$('#s6').onchange=e=>{S.grid=e.target.checked?1:0;A()};
 $$('[data-v]').forEach(c=>c.onchange=()=>{const k=c.dataset.v;S.off=c.checked?S.off.filter(x=>x!==k):S.off.concat(k);A()});
 $$('[data-m]').forEach(b=>b.onclick=()=>{const[i,d]=b.dataset.m.split(':').map(Number),j=i+d;if(j<0||j>=S.order.length)return;[S.order[i],S.order[j]]=[S.order[j],S.order[i]];A();R()});
 $('#sr').onclick=()=>{Object.assign(S,{pack:'line',theme:'auto',up:'#2d7ff9',dn:'#ef5350',ac:'#8db82a',grid:1,order:TOOLS.slice(),off:[]});A();R()};$('#sd').onclick=()=>$('#md').classList.remove('o')};R()}
$('#gs').onclick=settings;
$('#opx').onclick=()=>{PV.on=0;$('main').classList.add('nop')};
/* floating drawing toolbar */
const ft=$('#ft'),DEF={w:2,ls:'solid',fl:13},hx=n=>Math.round(n*2.55).toString(16).padStart(2,'0'),G=(p,w=1.7)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const tgt=()=>(sel>=0&&DR[sel])||null;
function setp(k,v){const t=tgt();if(!t)return;if(t.lk&&k!=='lk')return toast('Unlock the drawing to edit it');if(t===DEF&&k==='txt')return toast('Place the drawing first');t[k]=v;if(t!==DEF&&k!=='txt')DEF[k]=v;if(k==='col'||k==='tc'||k==='fc'||k==='lc'){const i=ft.querySelector(`[data-f="${k}"] i`);if(i)i.style.background=v}else ftr();draw()}
function rmT(t){if(t===pend)pend=null;else{DR.splice(sel,1);sel=-1}tbr();draw()}
function posBar(t){return `<span class="gp" id="fg" title="Drag to move">${G('<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',2.6)}</span>`
+`<button data-f="clone" title="Clone">${G('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M17.5 14v7M14 17.5h7"/>')}</button>`
+`<button data-f="tc" title="Text colour"><b style="font:700 17px Georgia,serif">T</b><i style="background:${t.tc||'#111111'}"></i></button>`
+`<button data-f="fc" title="Profit zone colour">${G('<path d="M4 12l7-7 8 8-7 7z"/><path d="M20 16c0 1.5-1 2.5-2 2.5S16 17.5 16 16c0-1 2-3 2-3s2 2 2 3z"/>')}<i style="background:${t.fc||'#089981'}"></i></button>`
+`<button data-f="lc" title="Loss zone colour">${G('<path d="M4 12l7-7 8 8-7 7z"/><path d="M20 16c0 1.5-1 2.5-2 2.5S16 17.5 16 16c0-1 2-3 2-3s2 2 2 3z"/>')}<i style="background:${t.lc||'#f23645'}"></i></button>`
+`<button data-f="col" title="Line colour">${G('<path d="M3 19c3-1 4-5 7-6s2 4 5 2 4-6 6-6"/><path d="M10 13l-1 4"/><path d="M17 9l3 3"/>',1.1)}<i style="background:${t.col||S.ac}"></i></button>`
+`<button data-f="label" title="Label text">${G('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 8v8M8 12h8"/>')}</button>`
+`<button data-f="set" title="Settings">${G('<path d="M12 3l8 4.6v9.2L12 21l-8-4.2V7.6z"/><circle cx="12" cy="12" r="3"/>')}</button>`
+`<button data-f="lk" title="Lock" class="${t.lk?'on':''}">${G(t.lk?IC.lock[0]:'<path d="M6 11h12v9H6zM8 11V8a4 4 0 017.5-1"/>')}</button>`
+`<button data-f="del" title="Delete">${G(IC.trash[0])}</button>`
+`<button data-f="more" title="More">${G('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>')}</button>`
+`<input type="color" id="fc" style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;left:60px;top:30px">`}
function ftr(){const t=tgt();if(!t){ft.style.display='none';return}const c=t.col||S.ac,ls=t.ls||'solid',cw=$('#cw');
 ft.innerHTML=t.type==='pos'?posBar(t):`<span class="gp" id="fg" title="Drag to move">${G('<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><path d="M17 14v6M14 17h6"/>')}</span><button data-f="col" title="Line colour">${G('<path d="M3 19c3-1 4-5 7-6s2 4 5 2 4-6 6-6"/><path d="M10 13l-1 4"/><path d="M17 9l3 3"/>',1.1)}<i style="background:${c}"></i></button><button data-f="tc" title="Text colour"><b style="font:700 17px Georgia,serif">T</b><i style="background:${t.tc||'#111111'}"></i></button><button data-f="w" title="Line width" style="min-width:58px">${G('<path d="M3 12h18"/>')}<span>${t.w||2}px</span></button><button data-f="ls" title="Line style">${G(ls==='dash'?'<path d="M3 12h4M10 12h4M17 12h4"/>':ls==='dot'?'<path d="M4 12h.01M9 12h.01M14 12h.01M19 12h.01"/>':'<path d="M3 12h18"/>',ls==='dot'?3:1.7)}</button><button data-f="set" title="Settings">${G('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><circle cx="12" cy="12" r="3"/>')}</button><button data-f="lk" title="Lock" class="${t.lk?'on':''}">${G(t.lk?IC.lock[0]:'<path d="M6 11h12v9H6zM8 11V8a4 4 0 017.5-1"/>')}</button><button data-f="del" title="Delete">${G(IC.trash[0])}</button><button data-f="more" title="More">${G('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>')}</button><input type="color" id="fc" style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;left:60px;top:30px">`;
 ft.style.display='flex';
 if(S.fp){ft.style.left=Math.max(0,Math.min(S.fp.x,cw.clientWidth-ft.offsetWidth))+'px';ft.style.top=Math.max(0,Math.min(S.fp.y,cw.clientHeight-ft.offsetHeight))+'px';ft.style.transform='none'}
 ft.querySelectorAll('[data-f]').forEach(b=>b.onclick=e=>{e.stopPropagation();const k=b.dataset.f,t=tgt();if(!t)return;
  if(k==='fc'||k==='lc'){const i=$('#fc');i.value=t[k]||(k==='fc'?'#089981':'#f23645');i.oninput=()=>setp(k,i.value);i.click()}
  else if(k==='col'||k==='tc'){const i=$('#fc');i.value=t[k]||(k==='col'?S.ac:'#111111');i.oninput=()=>setp(k,i.value);i.click()}
  else if(k==='w')setp('w',[1,2,3,4][([1,2,3,4].indexOf(t.w||2)+1)%4]);
  else if(k==='ls')setp('ls',{solid:'dash',dash:'dot',dot:'solid'}[t.ls||'solid']);
  else if(k==='set')dset();
  else if(k==='lk'){if(t===DEF)return toast('Place a drawing first');t.lk=!t.lk;ftr()}
  else if(k==='del'){if(t===DEF)return;if(t.lk)return toast('Unlock the drawing to delete it');rmT(t)}
  else if(k==='more')more(b)
  else if(k==='label')dset()
  else if(k==='clone'){const c=JSON.parse(JSON.stringify(t));c.lk=0;c.p.forEach(q=>{q.i-=6});DR.push(c);sel=DR.length-1;ftr();draw()}});
 const g=$('#fg');g.onpointerdown=e=>{e.preventDefault();g.setPointerCapture(e.pointerId);const r=ft.getBoundingClientRect(),c=cw.getBoundingClientRect(),ox=e.clientX-r.left,oy=e.clientY-r.top;
  g.onpointermove=ev=>{const x=Math.max(0,Math.min(ev.clientX-c.left-ox,cw.clientWidth-ft.offsetWidth)),y=Math.max(0,Math.min(ev.clientY-c.top-oy,cw.clientHeight-ft.offsetHeight));S.fp={x,y};ft.style.left=x+'px';ft.style.top=y+'px';ft.style.transform='none'};
  g.onpointerup=()=>{g.onpointermove=null;sv()}}}
function more(b){const t=tgt();$('#pp').classList.remove('o');const p=pop(b,'<label data-a="clone">Clone drawing</label><label data-a="front">Bring to front</label><label data-a="reset">Reset style</label>');p.onclick=e=>{const a=e.target.dataset.a;if(!a||t===DEF)return;
 if(a==='clone'){const c=JSON.parse(JSON.stringify(t));c.lk=0;c.p.forEach(q=>{q.i-=6});DR.push(c);sel=DR.length-1}
 else if(a==='front'&&sel>=0){DR.push(DR.splice(sel,1)[0]);sel=DR.length-1}
 else if(a==='reset'){delete t.col;delete t.tc;t.w=2;t.ls='solid';t.fl=13}
 ftr();draw()}}
function dset(){const t=tgt();if(!t)return;const o=(a,l)=>`<option value="${a}" ${(t.ls||'solid')===a?'selected':''}>${l}</option>`;
 md(`<h3>Drawing settings</h3><div class="row"><span>Line colour</span><input type="color" id="d1" value="${t.col||S.ac}"></div><div class="row"><span>Text colour</span><input type="color" id="d2" value="${t.tc||'#111111'}"></div><div class="row"><span>Line width</span><select class="in" id="d3" style="width:110px">${[1,2,3,4].map(n=>`<option ${n===(t.w||2)?'selected':''}>${n}</option>`).join('')}</select></div><div class="row"><span>Line style</span><select class="in" id="d4" style="width:110px">${o('solid','Solid')}${o('dash','Dashed')}${o('dot','Dotted')}</select></div><div class="row"><span>Fill opacity</span><input type="range" id="d5" min="0" max="60" value="${t.fl??13}"></div><div class="row"><span>Label text</span><input class="in" id="d6" style="width:150px" value="${t.txt||''}" placeholder="Add a label"></div>${t.type==='emoji'?'<div class="row" style="flex-wrap:wrap">'+['😀','🚀','📈','📉','🔥','💰','⚠️','🎯'].map(e=>`<button class="x" data-e="${e}">${e}</button>`).join('')+'</div>':''}<div class="two" style="margin-top:14px"><button id="d7">Delete</button><button id="d8" style="background:var(--ac);color:#0d1416;font-weight:700">Done</button></div>`);
 $('#d1').oninput=e=>setp('col',e.target.value);$('#d2').oninput=e=>setp('tc',e.target.value);$('#d3').onchange=e=>setp('w',+e.target.value);$('#d4').onchange=e=>setp('ls',e.target.value);$('#d5').oninput=e=>setp('fl',+e.target.value);$('#d6').oninput=e=>setp('txt',e.target.value);$$('#mb [data-e]').forEach(b=>b.onclick=()=>{setp('txt',b.dataset.e);$('#d6').value=b.dataset.e});setTimeout(()=>{const f=$('#d6');if(f){f.focus();f.select()}},50);
 $('#d7').onclick=()=>{$('#md').classList.remove('o');if(t!==DEF&&!t.lk)rmT(t)};$('#d8').onclick=()=>$('#md').classList.remove('o')}
/* sidebar v2 */
let pdn=null;const NP={path:5},OPENL=`<path d='M6 11h12v9H6zM8 11V8a4 4 0 017.5-1'/>`,GR={trend:['trend','ray','hline','vline'],fib:['fib','rect'],pos:['long','short'],brush:['brush','hl'],arrows:['arrow','arrm','mu','md','ml','mr']},FIX1=['measure','zoom'],FIX2=['magnet','stay','lock','hide'];
TOOLS.length=0;TOOLS.push('cursor','trend','fib','path','pos','brush','arrows','text','emoji');delete IC.cross;
Object.assign(IC,{
cursor:[`<path d='M12 3v6M12 15v6M3 12h6M15 12h6'/><circle cx='12' cy='12' r='.9'/>`,'✛','Crosshair'],
fib:[`<path d='M2.67 3.52H21.36'/><path d='M2.67 8.60H20.84'/><path d='M2.67 13.64H21.36'/><path d='M3.19 18.73H21.36'/><circle cx='20.84' cy='8.60' r='1.77'/><circle cx='3.19' cy='18.73' r='1.77'/>`,'≡','Fib retracement (Alt+F)'],
path:[`<path d='M7.84 5.9L9.36 8.53M6.49 6.14L4.55 16.97M11.96 9.05L15.61 6.29M9.2 11.89L5.36 17.31M12.05 11.33L18.09 15.18M17.65 7.04L19.32 14.3'/><circle cx='6.84' cy='4.17' r='2'/><circle cx='17.2' cy='5.09' r='2'/><circle cx='10.36' cy='10.26' r='2'/><circle cx='4.2' cy='18.94' r='2'/><circle cx='19.77' cy='16.25' r='2'/>`,'⛓','Pattern (5 clicks, Enter to finish early)'],
pos:[`<path d='M6.65 5.24H20.44M6.65 10.38H17.32M6.65 18.76H20.44M8.25 12.3h.01M10.89 13.44h.01M13.53 14.58h.01M16.14 15.69h.01M18.79 16.83h.01'/><circle cx='4.34' cy='5.24' r='1.77'/><circle cx='4.34' cy='10.38' r='1.77'/><circle cx='19.63' cy='10.38' r='1.77'/><circle cx='4.34' cy='18.76' r='1.77'/>`,'⚖','Long / short position'],
brush:[`<path d='M0.84 20.97C2.67 19.44 4.57 17.16 5.90 14.11C6.67 12.40 8.38 11.25 10.29 11.25C12.95 11.25 14.48 13.35 14.48 15.63C14.48 18.30 12.57 20.40 10.29 20.51C7.62 20.74 4.95 20.74 0.84 20.97Z'/><path d='M17.90 3.14L14.86 6.19C13.71 7.33 13.79 9.54 14.86 10.49C16.00 11.52 17.90 11.52 19.05 10.49L23.12 6.68'/>`,'🖌','Brush'],
text:[`<path d='M5 5h14M12 5v14M9 19h6'/>`,'T','Text note'],
emoji:[`<circle cx='12' cy='12' r='9'/><path d='M8.5 14c1 1.8 5 1.8 7 0M9 9.5h.01M15 9.5h.01'/>`,'☺','Emoji'],
zoom:[`<circle cx='11' cy='11' r='6.5'/><path d='M16 16l5 5M11 8v6M8 11h6'/>`,'🔍','Zoom in (drag a box)'],
magnet:[`<path d='M5 3v9a7 7 0 0014 0V3h-4v9a3 3 0 01-6 0V3zM5 7h4M15 7h4'/>`,'🧲','Magnet mode'],
stay:[`<path d='M3 18l1-4 9-9 3 3-9 9z'/><rect x='14' y='15' width='7' height='6' rx='1'/><path d='M15.5 15v-1.5a2 2 0 014 0V15'/>`,'✏','Stay in drawing mode'],
hide:[`<path d='M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z'/><circle cx='10' cy='10' r='2.2'/><path d='M13 21l1-3 6-6 2 2-6 6z'/>`,'👁','Hide all drawings'],
layers:[`<path d='M12 3l9 5-9 5-9-5z'/><path d='M3 13l9 5 9-5'/>`,'☰','Object tree']});
Object.assign(IC,{
hl:[`<path d='M14 5.5l4.5 4.5-7.5 7.5-4.5-4.5z'/><path d='M4 20.5h6'/>`,'🖍','Highlighter'],
arrow:[`<path d='M6 18L17 7M10 7h7v7'/><circle cx='5' cy='19' r='1.6'/>`,'↗','Arrow'],
arrm:[`<path d='M5 19L14 10'/><path d='M8 4h12v12l-3-3-5 5-4-4 5-5-3-3z'/>`,'➚','Arrow Marker'],
mu:[`<path d='M12 3l7 8h-4v10H9V11H5z'/>`,'⬆','Arrow Mark Up'],
md:[`<path d='M12 21l7-8h-4V3H9v10H5z'/>`,'⬇','Arrow Mark Down'],
ml:[`<path d='M3 12l8-7v4h10v6H11v4z'/>`,'⬅','Arrow Mark Left'],
mr:[`<path d='M21 12l-8-7v4H3v6h10v4z'/>`,'➡','Arrow Mark Right'],
arrows:[`<path d='M6 18L17 7M10 7h7v7'/><circle cx='5' cy='19' r='1.6'/>`,'↗','Arrows']});
IC.lock[2]='Lock all drawings';IC.trash[2]='Remove drawings (Del)';IC.long=[IC.pos[0],'⚖','Long Position'];IC.short=[IC.pos[0],'⚖','Short Position'];
S.order=S.order.filter(k=>TOOLS.includes(k));TOOLS.forEach(k=>S.order.includes(k)||S.order.push(k));S.off=S.off.filter(k=>TOOLS.includes(k));S.gv=S.gv||{};S.gv.pos=S.gv.pos||'long';S.gv.brush=S.gv.brush||'brush';S.gv.arrows=S.gv.arrows||'arrow';if(!GR.brush.includes(S.gv.brush))S.gv.brush='brush';if(!GR.arrows.includes(S.gv.arrows))S.gv.arrows='arrow';if(!IC[S.tool])S.tool='cursor';
const curk=k=>GR[k]&&GR[k].includes(S.gv[k])?S.gv[k]:k;
function tbr(){const bt=(k,on,kk=k)=>`<button data-k="${k}" class="${on?'on':''}${GR[k]?' gr':''}" title="${IC[kk][2]}">${ico(kk)}</button>`;
 $('#tb').innerHTML=S.order.filter(k=>!S.off.includes(k)).map(k=>bt(k,GR[k]?GR[k].includes(S.tool):S.tool===k,curk(k))).join('')+'<hr>'+FIX1.map(k=>bt(k,S.tool===k)).join('')+'<hr>'+FIX2.map(k=>bt(k,S[k])).join('')+'<hr>'+bt('trash',0)+'<span style="flex:1"></span>'+bt('layers',0);
 $$('#tb [data-k]').forEach(b=>{const k=b.dataset.k;b.onclick=e=>{
  if(GR[k]&&GR[k].includes(S.tool)){e.stopPropagation();return fly(b,k)}
  pend=null;
  if(k==='trash'){if(sel>=0){if(!DR[sel].lk){DR.splice(sel,1);sel=-1}}else DR=DR.filter(d=>d.sym!==S.sym)}
  else if(k==='layers')return tree();
  else if(FIX2.includes(k)){S[k]=S[k]?0:1;sv()}
  else{S.tool=curk(k);if(S.tool!=='cursor')sel=-1}
  tbr();draw()};
  b.oncontextmenu=e=>{e.preventDefault();if(GR[k])fly(b,k)}});
 ftr()}
function fly(b,k){const r=b.getBoundingClientRect();$('#pp').classList.remove('o');const p=pop(b,GR[k].map(v=>`<label data-v="${v}">${ico(v)}<span>${IC[v][2]}</span></label>`).join(''));p.style.left=r.right+6+'px';p.style.top=r.top+'px';p.onclick=e=>{const l=e.target.closest('[data-v]');if(!l)return;const v=l.dataset.v;S.gv[k]=v;S.tool=v;sel=-1;sv();tbr();draw()}}
function tree(){const L=DR.map((d,i)=>[d,i]).filter(([d])=>d.sym===S.sym);
 md(`<h3>Object tree</h3>${L.length?L.map(([d,i])=>`<div class="row"><span data-n="${i}" style="cursor:pointer;flex:1">${(IC[d.type]?IC[d.type][2]:d.type).replace(/ \(.*/,'')} ${d.txt||''} · ${fm(d.p[0].p)}</span><button class="x" data-x="${i}">Delete</button></div>`).join(''):'<div class="emp">No drawings on this symbol.</div>'}<div class="two" style="margin-top:14px"><button id="tcl">Close</button><button id="tcr" style="background:var(--ac);color:#0d1416;font-weight:700">Delete all</button></div>`);
 $$('#mb [data-n]').forEach(e=>e.onclick=()=>{sel=+e.dataset.n;$('#md').classList.remove('o');ftr();draw()});
 $$('#mb [data-x]').forEach(e=>e.onclick=()=>{DR.splice(+e.dataset.x,1);sel=-1;ftr();draw();tree()});
 $('#tcl').onclick=()=>$('#md').classList.remove('o');$('#tcr').onclick=()=>{DR=DR.filter(d=>d.sym!==S.sym);sel=-1;ftr();draw();$('#md').classList.remove('o')}}
function zoomTo(d){const a=D[key()],i0=Math.min(d.p[0].i,d.p[1].i),i1=Math.max(d.p[0].i,d.p[1].i),p0=Math.min(d.p[0].p,d.p[1].p),p1=Math.max(d.p[0].p,d.p[1].p);if(i1-i0<2||p1-p0<=0)return;
 V.bw=Math.max(2,Math.min(40,pw/(i1-i0+1)));V.right=i1;V.lk=null;let lo=1e12,hi=-1e12;const a0=Math.max(0,Math.floor(V.right-pw/V.bw)-1),a1=Math.min(a.length-1,Math.ceil(V.right));for(let i=a0;i<=a1;i++){lo=Math.min(lo,a[i].l);hi=Math.max(hi,a[i].h)}
 const m0=(lo+hi)/2,h0=(hi-lo)/2*1.3||1e-9;V.ys=Math.max(.02,(p1-p0)/2/h0);V.ysh=(p0+p1)/2-m0}
addEventListener('keydown',e=>{if(e.key==='Enter'&&pend&&pend.type==='path'&&pend.p.length>2){pend.p.pop();commit()}});
$('#bw').onclick=()=>$('#wl').classList.toggle('o');
$('#tcol').onclick=()=>{const c=$('#tb').classList.toggle('c');$('#tcol').textContent=c?'›':'‹'};
/* sidebar scroll arrows */
const tbe=$('#tb');let ly=null;
['up','dn'].forEach(k=>{const b=document.createElement('button');b.id='ta'+k;b.className='tar';b.setAttribute('aria-label',k==='up'?'Scroll toolbar up':'Scroll toolbar down');b.innerHTML=`<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'><path d='${k==='up'?'M6 15l6-6 6 6':'M6 9l6 6 6-6'}'/></svg>`;document.body.appendChild(b)});
const tau=$('#taup'),tad=$('#tadn');
function tar(y){const r=tbe.getBoundingClientRect(),mx=tbe.scrollHeight-tbe.clientHeight,ov=mx>2&&!tbe.classList.contains('c')&&r.width>0,lx=r.left+r.width/2-17+'px';
 tau.style.left=tad.style.left=lx;tau.style.top=r.top+4+'px';tad.style.top=r.bottom-26+'px';
 tau.classList.toggle('o',ov&&y!=null&&y<r.top+r.height*.3&&tbe.scrollTop>2);
 tad.classList.toggle('o',ov&&y!=null&&y>r.top+r.height*.7&&tbe.scrollTop<mx-2)}
tbe.addEventListener('mousemove',e=>{ly=e.clientY;tar(ly)});
tbe.addEventListener('mouseleave',e=>{if(!(e.relatedTarget&&e.relatedTarget.classList&&e.relatedTarget.classList.contains('tar')))tar(null)});
[tau,tad].forEach(b=>b.addEventListener('mouseleave',e=>{if(e.relatedTarget!==tbe&&!tbe.contains(e.relatedTarget))tar(null)}));
tau.onclick=()=>{tbe.scrollTo({top:0,behavior:'smooth'});setTimeout(()=>tar(ly),450)};
tad.onclick=()=>{tbe.scrollTo({top:tbe.scrollHeight,behavior:'smooth'});setTimeout(()=>tar(ly),450)};
/* instrument picker */
let GRP={};
const getPriceDigits=symbol=>symbol?.includes('JPY')?3:['BTCUSD','ETHUSD','US30','USTEC','US500','GER40','UK100','AUS200','XAUUSD','UKOIL','USOIL'].includes(symbol)?2:5;
function rebuildGroups(){GRP={};const names={FOREX:'Forex',METALS:'Metals',CRYPTO:'Crypto',ENERGY:'Energy',INDEX:'Indices'};for(const y of Object.keys(SY)){const key=String(SY[y].category||'OTHER').toUpperCase(),name=names[key]||'Other';(GRP[name]||(GRP[name]=[])).push(y)}}
function pick(){md(`<h3>Select instrument</h3><input class="in" id="ps" placeholder="Search symbol or name" autocomplete="off"><div id="pl2" style="margin-top:6px"></div>`);
 const R=()=>{const q=$('#ps').value.trim().toLowerCase();$('#pl2').innerHTML=Object.entries(GRP).map(([g,l])=>{const it=l.filter(y=>!q||y.toLowerCase().includes(q)||SY[y].n.toLowerCase().includes(q));return it.length?`<div style="color:var(--mu);font-size:11.5px;margin:10px 0 4px">${escapeHtml(g)}</div>`+it.map(y=>`<div class="row" data-y2="${escapeHtml(y)}" style="cursor:pointer"><span><b>${escapeHtml(y)}</b> <small style="color:var(--mu)">${escapeHtml(SY[y].n)}</small></span><span>${fm(bid(y),SY[y].d)}</span></div>`).join(''):''}).join('')||'<div class="emp">No match</div>';
  $$('#pl2 [data-y2]').forEach(e=>e.onclick=()=>{S.sym=e.dataset.y2;ensure();sel=-1;pend=null;$('#md').classList.remove('o');ftr();tick(0)})};
 $('#ps').oninput=R;R();$('#ps').focus()}
$('#ts1').onclick=pick;$('#ts1').title='Select instrument';
$('#bt').onclick=()=>$('#ct').classList.toggle('bc');$$('#tbs [data-t]').forEach(b=>b.addEventListener('click',()=>$('#ct').classList.remove('bc')));
/* chart navigation strip: shows when the pointer is in the bottom of the chart */
const NAV=document.createElement('div');NAV.id='nav';
NAV.innerHTML=[['out','<path d=\'M5 12h14\'/>','Zoom out'],['in','<path d=\'M12 5v14M5 12h14\'/>','Zoom in'],['l','<path d=\'M15 5l-7 7 7 7\'/>','Scroll back'],['r','<path d=\'M9 5l7 7-7 7\'/>','Scroll forward'],['reset','<path d=\'M4 12a8 8 0 1 0 2.3-5.6\'/><path d=\'M4 4v4h4\'/>','Reset view']].map(([k,p,t])=>`<button data-n="${k}" title="${t}">${G(p)}</button>`).join('');
gr.parentElement.appendChild(NAV);
function navUp(){if(!mouse){NAV.classList.remove('o');return}const g=gr.getBoundingClientRect(),r=NAV.getBoundingClientRect(),px=mouse.x+g.left,py=mouse.y+g.top,m=40;NAV.classList.toggle('o',px>=r.left-m&&px<=r.right+m&&py>=r.top-m&&py<=r.bottom+m)}
NAV.addEventListener('pointerleave',()=>NAV.classList.remove('o'));
NAV.addEventListener('pointerdown',e=>e.stopPropagation());
NAV.addEventListener('click',e=>{const b=e.target.closest('[data-n]');if(!b)return;const n=D[key()].length,a=b.dataset.n;V.lk=null;if(a==='out')V.bw=Math.max(2,V.bw/1.25);else if(a==='in')V.bw=Math.min(40,V.bw*1.25);else if(a==='l')V.right=Math.max(5,V.right-10);else if(a==='r')V.right=Math.min(n+80,V.right+10);else{V.bw=8;V.right=n+5;V.ys=1;V.ysh=0}draw()});
/* dropdowns */
const TFN={'1m':'1 minute','5m':'5 minutes','15m':'15 minutes','1h':'1 hour','4h':'4 hours','1d':'1 day'},TYN={candle:'Candles',line:'Line',area:'Area'};
function lab(){const I={candle:`<path d='M8 3v3M8 18v3M16 5v3M16 15v4'/><rect x='6' y='6' width='4' height='12'/><rect x='14' y='8' width='4' height='7'/>`,line:`<path d='M3 17l5-6 4 3 8-9'/>`,area:`<path d='M3 18l5-7 4 3 8-8v12z'/>`};$('#tfd').textContent=S.tf;$('#tyd').innerHTML=G(I[S.type]);$('#tyd').title='Chart type: '+TYN[S.type]}
function dd2(b,items,cur,fn){$('#pp').classList.remove('o');const p=pop(b,items.map(([v,n])=>`<label data-v="${v}" style="${v===cur?'color:var(--ac);font-weight:700':''}">${n}</label>`).join(''));p.onclick=e=>{const l=e.target.closest('[data-v]');if(l){fn(l.dataset.v);lab()}}}
$('#tfd').onclick=e=>{e.stopPropagation();dd2(e.currentTarget,Object.keys(TFN).map(k=>[k,TFN[k]]),S.tf,v=>$$('#tfs button').find(x=>x.dataset.f===v).click())};
$('#tyd').onclick=e=>{e.stopPropagation();dd2(e.currentTarget,Object.keys(TYN).map(k=>[k,TYN[k]]),S.type,v=>$$('#tys button').find(x=>x.dataset.t===v).click())};
lab();
/* top bar v2 */
const bar=$('.ctop'),mk=(id,h,o,c,t)=>{const b=document.createElement('button');b.id=id;b.className=c;b.title=t;b.innerHTML=h;b.style.order=o;bar.appendChild(b);return b},sepr=o=>{const i=document.createElement('i');i.className='sp';i.style.order=o;bar.appendChild(i)};
mk('adb',G(`<circle cx='12' cy='12' r='9'/><path d='M12 8v8M8 12h8'/>`),0,'btn','Select instrument').onclick=pick;
[1,3,5,8,24,27].forEach(sepr);
$('#tfd').style.order=2;$('#tyd').style.order=4;$('#bi').style.order=6;$('#bi').textContent='ƒx Indicators';
const bwb=$('#bw');bwb.style.order=7;bwb.title='Watchlist';bwb.innerHTML=G(`<path d='M9 6h11M9 12h11M9 18h11'/><circle cx='4.5' cy='6' r='1.3' fill='currentColor'/><circle cx='4.5' cy='12' r='1.3' fill='currentColor'/><circle cx='4.5' cy='18' r='1.3' fill='currentColor'/>`,2.2);bwb.setAttribute('aria-label','Watchlist');
let UH=[JSON.stringify(DR)],UR=[],svd=UH[0];
function undo(){if(UH.length<2)return toast('Nothing to undo');UR.push(UH.pop());DR=JSON.parse(UH[UH.length-1]);sel=-1;ftr();draw()}
function redo(){if(!UR.length)return toast('Nothing to redo');const j=UR.pop();UH.push(j);DR=JSON.parse(j);sel=-1;ftr();draw()}
mk('un',G(`<path d='M9 14L4 9l5-5'/><path d='M4 9h10a6 6 0 010 12h-3'/>`),9,'btn','Undo (Ctrl+Z)').onclick=undo;
mk('re',G(`<path d='M15 14l5-5-5-5'/><path d='M20 9H10a6 6 0 000 12h3'/>`),10,'btn','Redo (Ctrl+Y)').onclick=redo;
addEventListener('keydown',e=>{if(/INPUT|SELECT/.test(e.target.tagName))return;const k=e.key.toLowerCase();if((e.ctrlKey||e.metaKey)&&k==='z'){e.preventDefault();e.shiftKey?redo():undo()}else if((e.ctrlKey||e.metaKey)&&k==='y'){e.preventDefault();redo()}});
setInterval(()=>{const j=JSON.stringify(DR);if(j!==UH[UH.length-1]){UH.push(j);if(UH.length>60)UH.shift();UR=[]}$('#svs').textContent=j===svd?'Saved':'Unsaved'},300);
const brb=$('#br');brb.style.order=20;brb.style.marginLeft='auto';brb.title='Screen layout';brb.innerHTML=G(`<rect x='4' y='4' width='16' height='16' rx='2'/>`);
function saveL(){try{localStorage.setItem('cf_layout',JSON.stringify({DR,ind:S.ind,type:S.type,tf:S.tf,sym:S.sym}));svd=JSON.stringify(DR);toast('Layout saved')}catch(e){toast('Saving is not available here')}}
function loadL(){try{const o=JSON.parse(localStorage.getItem('cf_layout')||'null');if(!o)return toast('No saved layout yet');DR=o.DR||[];S.ind=o.ind||S.ind;S.type=o.type||S.type;S.tf=o.tf||S.tf;S.sym=o.sym||S.sym;ensure();sel=-1;seg();lab();sv();ftr();tick(0);toast('Layout loaded')}catch(e){toast('Could not load the layout')}}
mk('sv0',`<span>Save<small id='svs'>Saved</small></span>`,21,'btn','Save layout').onclick=saveL;
mk('sv1',G(`<path d='M6 9l6 6 6-6'/>`),22,'btn','Layout options').onclick=e=>{e.stopPropagation();const r=e.currentTarget.getBoundingClientRect();$('#pp').classList.remove('o');const p=pop(e.currentTarget,"<label data-a='s'>Save layout</label><label data-a='l'>Load saved layout</label><label data-a='c'>Clear drawings on this symbol</label>");p.style.left=Math.max(8,Math.min(r.left,innerWidth-200))+'px';p.onclick=ev=>{const a=ev.target.dataset.a;if(a==='s')saveL();if(a==='l')loadL();if(a==='c'){DR=DR.filter(d=>d.sym!==S.sym);sel=-1;ftr();draw()}}};
mk('jmp',G(`<path d='M6 6l6 6-6 6M13 6l6 6-6 6'/>`),23,'btn','Jump to latest candle').onclick=()=>{V.right=D[key()].length-1+6;draw()};
mk('cam',G(`<path d='M4 8h3l2-3h6l2 3h3v11H4z'/><circle cx='12' cy='13' r='3.5'/>`),25,'btn','Chart snapshot').onclick=()=>{try{const t=document.createElement('canvas');t.width=cv.width;t.height=cv.height;const c=t.getContext('2d');c.fillStyle=getComputedStyle($('#cw')).backgroundColor;c.fillRect(0,0,t.width,t.height);c.drawImage(cv,0,0);md(`<h3>Chart snapshot</h3><img alt='Chart snapshot' style='width:100%;border-radius:8px;border:1px solid var(--bd)' src='${t.toDataURL('image/png')}'><p style='color:var(--mu)'>Right-click or long-press the image to save it.</p>`)}catch(e){toast('Snapshot is not available here')}};
const bfb=$('#bf');bfb.style.order=26;bfb.title='Fullscreen';bfb.innerHTML=G(`<path d='M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'/>`);
mk('qs','Sell',30,'qb','Sell at market').onclick=()=>{if(!ACC[AI]?.tradingEnabled)return toast('Trading is disabled for this account');if(!accountState||Date.now()-accountStateUpdatedAt>15000)return toast('Current account state is unavailable.');if(!validQuote(S.sym))return toast('A fresh, open-market quote is required.');S.side='sell';S.ot='market';$('#ot').value='market';$('main').classList.remove('nop');PV.on=1;ui();tick(0)};
const qsp=document.createElement('span');qsp.id='qsp';qsp.className='qsp';qsp.style.order=29;bar.appendChild(qsp);
mk('qb','Buy',28,'qb','Buy at market').onclick=()=>{if(!ACC[AI]?.tradingEnabled)return toast('Trading is disabled for this account');if(!accountState||Date.now()-accountStateUpdatedAt>15000)return toast('Current account state is unavailable.');if(!validQuote(S.sym))return toast('A fresh, open-market quote is required.');S.side='buy';S.ot='market';$('#ot').value='market';$('main').classList.remove('nop');PV.on=1;ui();tick(0)};
mk('cvr',G(`<path d='M9 5l7 7-7 7'/>`),31,'btn','Hide or show order panel').onclick=()=>$('main').classList.toggle('nop');
function qupd(){const y=S.sym;$('#qs').textContent=fm(bid(y));$('#qb').textContent=fm(ask(y));qsp.textContent=fm(sp(y))}
setInterval(qupd,250);qupd();

/* long / short position tool */
function pg(d){const e=d.p[0].p,t=d.p[1].p,s=d.sl!=null?d.sl:2*e-t,a=Math.min(d.p[0].i,d.p[1].i),b=Math.max(d.p[0].i,d.p[1].i);return{e,t,s,xl:X(a),xr:X(b),ye:Y(e),yt:Y(t),ys:Y(s)}}
function rrect(x,y,w,h,r){cx.beginPath();cx.moveTo(x+r,y);cx.arcTo(x+w,y,x+w,y+h,r);cx.arcTo(x+w,y+h,x,y+h,r);cx.arcTo(x,y+h,x,y,r);cx.arcTo(x,y,x+w,y,r);cx.closePath()}
function plb(lines,xc,yc,bg){cx.font='12px "Segoe UI",system-ui,sans-serif';cx.textBaseline='middle';cx.textAlign='center';const lh=16,w=Math.max(...lines.map(t=>cx.measureText(t).width))+18,h=lines.length*lh+6,x=Math.max(2,Math.min(pw-w-2,xc-w/2));rrect(x,yc-h/2,w,h,4);cx.fillStyle=bg;cx.fill();cx.fillStyle='#fff';lines.forEach((t,k)=>cx.fillText(t,x+w/2,yc-h/2+3+lh*(k+.5)));cx.textAlign='left'}
function posFix(d){const q0=d.p[0],q1={...d.p[1]};d.p[1]=q1;const e=q0.p,L=d.side!=='short';let dt=Math.abs(q1.p-e);if(dt<(mx-mn)*.02)dt=(mx-mn)*.1;q1.p=L?e+dt:e-dt;d.sl=L?e-dt:e+dt;const a=Math.min(q0.i,q1.i);let b=Math.max(q0.i,q1.i);if(b-a<3)b=a+Math.max(6,Math.round(pw/V.bw*.2));q0.i=a;q1.i=b;d.lots=lots()}
function ph2(d,x,y){const g=pg(d);for(const[k,hx,hy]of[['s',g.xl,g.ys],['t',g.xl,g.yt],['r',g.xr,g.ye],['e',g.xl,g.ye]])if(Math.hypot(x-hx,y-hy)<10)return k;return''}
function posDrag(x,y){const g=drag,d=g.d,c=pt(x,y),e=d.p[0].p,L=d.side!=='short',tk=Math.pow(10,-(SY[d.sym]||SY[S.sym]).d);
 if(g.k==='e'){const di=c.i-g.s.i,dp=c.p-g.s.p;d.p[0].i=g.o[0].i+di;d.p[1].i=g.o[1].i+di;d.p[0].p=g.o[0].p+dp;d.p[1].p=g.o[1].p+dp;if(g.sl!=null)d.sl=g.sl+dp}
 else if(g.k==='s')d.sl=L?Math.min(c.p,e-tk):Math.max(c.p,e+tk);
 else if(g.k==='t')d.p[1].p=L?Math.max(c.p,e+tk):Math.min(c.p,e-tk);
 else if(g.k==='r')d.p[1].i=Math.max(d.p[0].i+2,c.i);
 draw()}
const CROSS_CUR=`url("data:image/svg+xml;utf8,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><path d='M12 1v9M12 14v9M1 12h9M14 12h9' stroke='#000' stroke-opacity='.5' stroke-width='4' fill='none'/><path d='M12 1v9M12 14v9M1 12h9M14 12h9' stroke='#fff' stroke-width='1.6' fill='none'/></svg>")}") 12 12, crosshair`;
gr.addEventListener('pointermove',e=>{if(drag||!cv)return;const{x,y}=rel(e);let cs='';const oh=ovHit(x,y);if(oh&&oh.drag)cs='ns-resize';if(!cs&&S.tool==='cursor'&&!S.lock){if(sel>=0&&DR[sel]&&DR[sel].type==='pos'){const k=ph2(DR[sel],x,y);if(k)cs={s:'ns-resize',t:'ns-resize',e:'move',r:'ew-resize'}[k]}if(!cs){const h=hit(x,y);if(h>=0&&DR[h].type==='pos')cs='move'}}if(!cs&&x<pw&&y<ph){const q=D[key()],ci=Math.round(I(x)),c=q&&q[ci];if(c&&Math.abs(X(ci)-x)<=V.bw/2+1&&y>=Y(c.h)-2&&y<=Y(c.l)+2)cs='pointer'}cv.style.cursor=cs||(x<pw&&y<ph&&!hideXH()?'none':(x>pw&&y<ph?'ns-resize':(y>ph&&x<=pw?'ew-resize':CROSS_CUR)))});
/* quick access pairs (max 3) */
const QMAX=3;
function qpClean(){S.qp=(Array.isArray(S.qp)?S.qp:['XAUUSD','EURUSD','BTCUSD']).filter((y,i,a)=>SY[y]&&a.indexOf(y)===i).slice(0,QMAX)}
function qpb(){qpClean();const q=$('#qp');q.innerHTML=S.qp.map(y=>`<button class="qc" data-q="${y}" title="${SY[y].n}"><b>${y}</b><small id="qv_${y}">–</small></button>`).join('')+`<button class="qe" id="qed" title="Edit quick access pairs (max ${QMAX})" aria-label="Edit quick access pairs"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>`;
 $$('#qp [data-q]').forEach(b=>b.onclick=()=>{const y=b.dataset.q;if(y===S.sym)return;S.sym=y;ensure();sel=-1;pend=null;ftr();tick(0)});
 $('#qed').onclick=qpEdit;qpu()}
function qpu(){$$('#qp [data-q]').forEach(b=>{const y=b.dataset.q,s=$('#qv_'+y),q=Q[y];b.classList.toggle('on',y===S.sym);if(s){s.textContent=validQuote(y)?`${fm(q.mid,SY[y].d)} · LIVE`:q?.market_state?.toLowerCase()==='closed'?'CLOSED':q?'STALE':'OFFLINE';s.className=validQuote(y)?'up':'dn'}})}
function qpEdit(){const L=Object.keys(SY);md(`<h3>Quick access pairs</h3><div style="color:var(--mu);margin-bottom:8px">Choose up to ${QMAX} pairs to show in the top bar.</div>${L.map(y=>`<div class="row"><label style="display:flex;gap:8px;align-items:center;flex:1;cursor:pointer"><input type="checkbox" data-y="${y}" ${S.qp.includes(y)?'checked':''}><b>${y}</b> <small style="color:var(--mu)">${SY[y].n}</small></label></div>`).join('')}<div class="two" style="margin-top:14px"><button id="qr">Reset</button><button id="qd" style="background:var(--ac);color:#0d1416;font-weight:700">Done</button></div>`);
 $$('#mb [data-y]').forEach(c=>c.onchange=()=>{const y=c.dataset.y;if(c.checked){if(S.qp.length>=QMAX){c.checked=false;return toast('Maximum '+QMAX+' pairs')}S.qp.push(y)}else S.qp=S.qp.filter(x=>x!==y);sv();qpb()});
 $('#qr').onclick=()=>{S.qp=['XAUUSD','EURUSD','BTCUSD'];sv();qpb();qpEdit()};$('#qd').onclick=()=>$('#md').classList.remove('o')}
qpb();
/* Live service adapter */
const CFG=Object.assign({mode:'live',api:TRADING_API_BASE,pollMs:5000},window.CF_CONFIG||{}),LIVE=CFG.mode==='live';
let BOOT=0,api,veil;
const _al=accLoad;
let liveState;
let liveCandles;
let liveOrder,liveClose,liveModify;
let liveBoot;
/* Use the application's authenticated trading API and market-data services. */
const FIREBASE_CONFIG={apiKey:"AIzaSyArsv-HojE9hn_3BAcJVFh5zp4XS9Dw480",authDomain:"daily-funded.firebaseapp.com",projectId:"daily-funded",storageBucket:"daily-funded.firebasestorage.app",messagingSenderId:"1080360028653",appId:"1:1080360028653:web:9afa42197ba011c1613fe4",measurementId:"G-Y7SP58FQ6H"};
const auth=(()=>{if(!window.firebase)throw new Error('Crazy Funded sign-in could not be loaded.');if(!window.firebase.apps.length)window.firebase.initializeApp(FIREBASE_CONFIG);return window.firebase.auth()})();
let authUser=null,authResolved=false,previousUid=null,marketSymbols=[],providerToSymbols=new Map(),marketConnection=null,marketRetry=null,marketStreamReady=false,marketStatusText='Connecting to market data…',positionSocket=null,positionRetry=null,accountTimer=null,marketTimer=null,accountRequest=0,accountStateUpdatedAt=0,accountError='';
const quoteTimes={};
veil=function(message,retry,signIn){let panel=$('#lv');if(!panel){panel=document.createElement('div');panel.id='lv';panel.style.cssText='position:fixed;inset:0;z-index:999;background:var(--bg);color:var(--tx);display:grid;place-items:center;text-align:center;padding:24px';document.body.appendChild(panel)}panel.replaceChildren();if(!message){panel.style.display='none';return}panel.style.display='grid';const content=document.createElement('div'),text=document.createElement('div');text.style.marginBottom='12px';text.textContent=message;content.appendChild(text);if(signIn){const link=document.createElement('a');link.href=import.meta.env.DEV?'/FundingForge.html':'/';link.textContent='Return to Crazy Funded sign in';content.appendChild(link)}if(retry){const button=document.createElement('button');button.className='btn';button.textContent='Retry';button.onclick=()=>location.reload();content.appendChild(button)}panel.appendChild(content)};
api=async function(method,path,body){if(!authUser)throw Object.assign(new Error('Sign in with your CRAZY FUNDED account to use trading.'),{code:'authentication_required'});const send=async(force)=>{const token=await authUser.getIdToken(force),response=await fetch(CFG.api+path,{method,headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),Authorization:`Bearer ${token}`},body:body?JSON.stringify(body):undefined}),payload=await response.json().catch(()=>null);return{response,payload}};let result=await send(false);if(result.response.status===401)result=await send(true);if(!result.response.ok){const error=new Error(result.payload?.error||result.payload?.message||`Trading service error (${result.response.status}).`);error.code=result.payload?.code||(result.response.status===401?'authentication_required':undefined);error.positionMayBeOpen=result.payload?.position_may_be_open===true;throw error}if(result.payload?.success===false)throw new Error(result.payload.error||'Trading service rejected the request.');return result.payload};
const marketApi=async path=>{const response=await fetch(API_BASE+path,{headers:{Accept:'application/json'}}),payload=await response.json().catch(()=>null);if(!response.ok)throw new Error(payload?.error||payload?.message||`Market service error (${response.status}).`);return payload};
function applyLiveCandle(symbol,timestamp,price){for(const chartKey of Object.keys(D)){const[y,tf]=chartKey.split('|'),candles=D[chartKey];if(y!==symbol||!candles.length)continue;const time=Math.floor(timestamp/(TF[tf]*1000))*TF[tf],last=candles[candles.length-1];if(time<last.t)continue;if(time>last.t)candles.push({t:time,o:price,h:price,l:price,c:price,v:0});else{last.h=Math.max(last.h,price);last.l=Math.min(last.l,price);last.c=price}}}
function setQuote(raw,symbol=raw?.symbol){symbol=String(symbol||'').trim().toUpperCase();const quote=normalizeMarketQuote(raw,{streamReady:marketStreamReady,symbol});if(!quote){const state=raw?.market_state||raw?.marketState;if(SY[symbol]&&String(state).toLowerCase()==='closed'){Q[symbol]={symbol,bid:null,ask:null,mid:null,timestamp:raw.timestamp,market_state:state,stale:true};marketStatusText='Market closed';return true}return false}if(!SY[quote.symbol]||quoteTimes[quote.symbol]!==undefined&&quote.timestampMs<quoteTimes[quote.symbol])return false;quoteTimes[quote.symbol]=quote.timestampMs;Q[quote.symbol]=quote;if(!quote.stale){P[quote.symbol]=quote.mid;applyLiveCandle(quote.symbol,quote.timestampMs,quote.mid);marketStatusText='Live market data';for(const position of POS.filter(item=>item.sym===quote.symbol)){position.pnl=calculatePositionPnl(position,quote);position.market_data_status='live'}}else marketStatusText=String(quote.market_state).toLowerCase()==='closed'?'Market closed':'Market data stale';return true}
function markQuotesStale(message='Market data offline'){marketStreamReady=false;marketStatusText=message;for(const symbol of Object.keys(Q))Q[symbol]={...Q[symbol],stale:true};tick()}
async function refreshQuotes(){if(!marketSymbols.length)return;try{const result=await marketApi(`/market/quotes?symbols=${encodeURIComponent(marketSymbols.map(item=>item.symbol).join(','))}`);for(const quote of result.quotes||[])setQuote(quote);for(const error of result.errors||[]){const symbol=String(error?.symbol||'').toUpperCase();if(Q[symbol])Q[symbol]={...Q[symbol],stale:true};if(symbol===S.sym)marketStatusText=error.message||'Market data unavailable'}if(!marketStreamReady)for(const symbol of Object.keys(Q))Q[symbol]={...Q[symbol],stale:true};tick()}catch(error){markQuotesStale(error.message||'Market data unavailable')}}
function receiveTick(raw){if(!raw||typeof raw!=='object')return;const provider=String(raw.symbol||'').trim().toUpperCase(),symbols=providerToSymbols.get(provider);if(!symbols?.length)return;for(const symbol of symbols)setQuote(raw,symbol);tick()}
async function syncMarket(){if(!marketConnection||marketConnection.state!==signalR.HubConnectionState.Connected)return;await refreshQuotes();await marketConnection.invoke('Subscribe',[...new Set(marketSymbols.filter(item=>item.provider==='biquote'&&item.providerSymbol).map(item=>item.providerSymbol))]);marketStreamReady=true;for(const quote of Object.values(Q)){const age=Date.now()-quoteTimes[quote.symbol];quote.stale=quote.provider_stale||!Number.isFinite(age)||age< -60000||age>5*60*1000||String(quote.market_state).toLowerCase()==='closed'}marketStatusText='Live market data';tick()}
async function startMarketFeed(){if(marketConnection||!marketSymbols.some(item=>item.provider==='biquote'&&item.providerSymbol))return;marketConnection=new signalR.HubConnectionBuilder().withUrl('https://biquote.io/hubs/tick',{withCredentials:false}).withAutomaticReconnect().configureLogging(signalR.LogLevel.Error).build();marketConnection.on('ReceiveTick',receiveTick);marketConnection.onreconnecting(()=>markQuotesStale('Reconnecting to market data…'));marketConnection.onreconnected(()=>syncMarket().catch(error=>{markQuotesStale(error.message);void marketConnection.stop()}));marketConnection.onclose(()=>{markQuotesStale();if(BOOT&&!marketRetry)marketRetry=setTimeout(()=>{marketRetry=null;marketConnection=null;void startMarketFeed()},5000)});try{await marketConnection.start();await syncMarket()}catch(error){markQuotesStale(error.message||'Market data connection failed');if(marketConnection.state!==signalR.HubConnectionState.Disconnected)await marketConnection.stop();if(!marketRetry)marketRetry=setTimeout(()=>{marketRetry=null;marketConnection=null;void startMarketFeed()},5000)}}
async function stopMarketFeed(){if(marketRetry)clearTimeout(marketRetry);marketRetry=null;const connection=marketConnection;marketConnection=null;marketStreamReady=false;if(connection&&connection.state!==signalR.HubConnectionState.Disconnected)await connection.stop()}
liveState=async function(){const account=ACC[AI];if(!account)return;const request=++accountRequest;try{const query=`?account_id=${encodeURIComponent(account.id)}`,[state,rules,trades]=await Promise.all([api('GET','/trading/accounts'+query),api('GET','/trading/account-rules'+query),api('GET','/trading/trades'+query)]);if(request!==accountRequest||ACC[AI]!==account)return;if(!state.account||!Array.isArray(state.positions)||!Array.isArray(trades.trades))throw new Error('Trading service returned incomplete account data.');accountState={...state.account,rules:rules.rules||state.rules||null,positions:state.positions,trades:trades.trades};accountStateUpdatedAt=Date.now();accountError='';account.balance=state.account.balance;account.status=state.account.status||account.status;account.tradingEnabled=String(account.status).toLowerCase()==='active'&&account.tradingEnabled===true;_al();tick()}catch(error){if(request!==accountRequest)return;const message=error.message||'Account service unavailable';if(message!==accountError)toast(message);accountError=message;tick()}};
liveCandles=async function(chartKey=key()){const[y,tf]=chartKey.split('|');if(!SY[y]||!TF[tf])return;candleStates[chartKey]='Loading historical candles…';if(chartKey===key())draw();try{const params=new URLSearchParams({symbol:y,interval:tf,limit:'700'}),result=await marketApi(`/market/candles?${params}`),candles=normalizeMarketCandles(result.bars);if(!candles.length)throw new Error(`No historical candles are available for ${y}.`);D[chartKey]=candles;candleStates[chartKey]='';if(chartKey===key()){resetView();draw()}}catch(error){candleStates[chartKey]=error.message||'Historical candles unavailable';if(chartKey===key())draw()}};
liveOrder=async function(order){if(submitting)return;submitting=1;ui();try{const result=await api('POST','/trading/positions',{account_id:ACC[AI].id,...order});if(!result.position||result.position.status!=='open')throw new Error('Trading service did not confirm an open position.');TPS.tp=null;TPS.sl=null;PV.on=0;await liveState();toast('Position opening confirmed by the server.')}catch(error){if(error.positionMayBeOpen){await liveState();toast('The server could not confirm protection sync. Check positions before retrying; the position may already be open.')}else toast(error.message||'Order was rejected.');await liveState()}finally{submitting=0;ui()}};
liveClose=async function(position){try{const result=await api('POST','/trading/positions/close',{position_id:position.id});if(result.position?.id!==position.id||result.position.status!=='closed')throw new Error('Trading service did not confirm the position close.');await liveState();toast('Position close confirmed by the server.')}catch(error){toast(error.message||'Position close failed.');await liveState()}};
liveModify=async function(position){try{const result=await api('POST','/trading/positions/modify',{position_id:position.id,take_profit:position.tp||null,stop_loss:position.sl||null});if(result.position?.id!==position.id||result.position.status!=='open')throw new Error('Trading service did not confirm the protection update.');await liveState();toast('Protection update confirmed by the server.')}catch(error){toast(error.message||'Protection update failed.');await liveState()}};
liveBoot=async function(){const generation=++accountRequest;BOOT=0;if(accountTimer)clearInterval(accountTimer);if(marketTimer)clearInterval(marketTimer);if(positionRetry)clearTimeout(positionRetry);positionSocket?.close();positionSocket=null;await stopMarketFeed();ACC.length=0;AI=0;accountState=null;accountStateUpdatedAt=0;accountError='';for(const symbol of Object.keys(Q))delete Q[symbol];for(const symbol of Object.keys(P))delete P[symbol];for(const chart of Object.keys(D))delete D[chart];for(const symbol of Object.keys(quoteTimes))delete quoteTimes[symbol];_al();try{const results=await Promise.allSettled([marketApi('/market/symbols'),authUser?api('GET','/my/accounts'):Promise.resolve(null)]);if(generation!==accountRequest)return;if(results[0].status==='rejected')throw results[0].reason;const payload=results[0].value;marketSymbols=normalizeMarketSymbols(payload.symbols,getPriceDigits);if(!marketSymbols.length)throw new Error('The market service returned no enabled symbols.');for(const symbol of Object.keys(SY))delete SY[symbol];providerToSymbols=new Map();for(const item of marketSymbols){SY[item.symbol]={n:item.name,d:item.digits,category:item.category,provider:item.provider,providerSymbol:item.providerSymbol};if(item.provider==='biquote'&&item.providerSymbol)providerToSymbols.set(item.providerSymbol,[...(providerToSymbols.get(item.providerSymbol)||[]),item.symbol])}rebuildGroups();let rows=[],accountLoadError=null;if(authUser){if(results[1].status==='fulfilled'&&Array.isArray(results[1].value))rows=results[1].value;else accountLoadError=results[1].status==='rejected'?results[1].reason:new Error('Trading service returned an invalid account list.')}rows.forEach(account=>{if(account&&typeof account.id==='string')ACC.push({...account})});if(ACC.length){const savedId=ACC.selectedId,selected=ACC.findIndex(item=>item.id===savedId);AI=selected>=0?selected:Math.max(0,ACC.findIndex(item=>item.status==='active'&&item.tradingEnabled===true));ACC.selectedId=ACC[AI].id;try{localStorage.setItem('cf_acc',ACC.selectedId)}catch{}}if(!SY[S.sym])S.sym=SY.XAUUSD?'XAUUSD':marketSymbols[0].symbol;S.ot='market';S.qp=(S.qp||['XAUUSD','EURUSD','BTCUSD']).filter(symbol=>SY[symbol]).slice(0,QMAX);if(!S.qp.length)S.qp=[S.sym];BOOT=1;accLoad();if(!authUser)$('#an').textContent='Sign in required';else if(accountLoadError)$('#an').textContent=accountLoadError.code==='authentication_required'?'Sign in required':'Account unavailable';else if(!ACC.length)$('#an').textContent='No trading accounts';qpb();wlr();await liveCandles(key());ensure();setLay(S.lay);if(ACC.length){await liveState();accountTimer=setInterval(()=>void liveState(),CFG.pollMs);void connectPositionEvents()}else if(accountLoadError){accountError=accountLoadError.message||'Account service unavailable';if(accountLoadError.code==='authentication_required')veil(accountError,false,true);else toast(accountError)}await refreshQuotes();await startMarketFeed();marketTimer=setInterval(()=>{if(!marketStreamReady||Object.values(Q).some(quote=>Date.now()-quoteTimes[quote.symbol]>5*60*1000))void refreshQuotes()},5000);if(!authUser)veil('Sign in to your CRAZY FUNDED account to use the trading terminal.',false,true);else if(!accountLoadError)veil(null);tick()}catch(error){if(generation!==accountRequest)return;marketStatusText=error.message||'Market data unavailable';candleStates[key()]=marketStatusText;$('#an').textContent=authUser?'Account unavailable':'Sign in required';if(authUser)toast(marketStatusText);else veil('Sign in to your CRAZY FUNDED account to use the trading terminal.',false,true);tick()}};
async function connectPositionEvents(){const account=ACC[AI];if(!account||!authUser)return;try{const result=await api('POST','/trading/events/token',{account_id:account.id});if(ACC[AI]!==account)return;if(typeof result.ticket!=='string'||!result.ticket)throw new Error('Trading service returned an invalid position-event ticket.');positionSocket=new WebSocket(`${TRADING_EVENTS_URL}?ticket=${encodeURIComponent(result.ticket)}`);positionSocket.onmessage=event=>{let update;try{update=JSON.parse(event.data)}catch{return}if(update.account_id===account.id)void liveState()};positionSocket.onclose=()=>{if(ACC[AI]===account&&!positionRetry)positionRetry=setTimeout(()=>{positionRetry=null;void connectPositionEvents()},3000)}}catch(error){if(ACC[AI]!==account)return;toast(error.message||'Position event connection unavailable');if(!positionRetry)positionRetry=setTimeout(()=>{positionRetry=null;void connectPositionEvents()},5000)}}
auth.onAuthStateChanged(user=>{authUser=user;if(!authResolved){authResolved=true;previousUid=user?.uid||null;void liveBoot();return}if((user?.uid||null)!==previousUid){previousUid=user?.uid||null;void liveBoot()}});

/* account switcher */
accLoad();
$('#acc').onclick=e=>{e.stopPropagation();const r=e.currentTarget.getBoundingClientRect(),m=n=>n!==null&&n!==undefined&&Number.isFinite(Number(n))?'$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'–';
 const rows=ACC.map((a,i)=>`<div data-a="${i}" style="display:flex;justify-content:space-between;align-items:center;gap:18px;padding:9px 10px;border-radius:8px;cursor:pointer;${i===AI?'background:var(--p2)':''}"><div><div style="font-weight:600">${escapeHtml(a.label||a.plan||a.id)}${i===AI?' <span style="color:var(--act)">&#10003;</span>':''}</div><small style="color:var(--mu)">${escapeHtml(a.id)}</small> <small style="color:${a.tradingEnabled?'var(--buy)':'var(--sell)'}">${escapeHtml(a.status||'Unavailable')}</small></div><b style="font-variant-numeric:tabular-nums">${m(i===AI?bal:a.balance)}</b></div>`).join('');
 const p=pop(e.currentTarget,`<div style="padding:4px 10px 8px;color:var(--mu);font-size:11.5px">SWITCH ACCOUNT</div>${rows}`);
 p.style.minWidth='340px';p.style.left=Math.max(8,Math.min(r.left,innerWidth-p.offsetWidth-8))+'px';
 p.onclick=ev=>{ev.stopPropagation();const d=ev.target.closest('[data-a]');if(!d)return;const i=+d.dataset.a;p.classList.remove('o');if(i===AI)return;
  accSave();accountRequest++;AI=i;ACC.selectedId=ACC[AI].id;try{localStorage.setItem('cf_acc',ACC.selectedId)}catch(x){}pend=null;sel=-1;PV.on=0;accountState=null;accountStateUpdatedAt=0;accountError='';accLoad();tick();if(positionRetry)clearTimeout(positionRetry);positionSocket?.close();positionSocket=null;void liveState();void connectPositionEvents();toast('Switched to '+(ACC[AI].label||ACC[AI].plan||ACC[AI].id))}};
$('#acc').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.currentTarget.click()}};
try{matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>{theme();draw()})}catch(e){}
theme();ensure();setLay(S.lay);tbr();seg();wlr();tick(0);setInterval(()=>tick(),500);

/* ===== responsive / touch ===== */
const MQ=matchMedia('(max-width:900px)');
function mobileInit(){if(MQ.matches){$('main').classList.add('nop');$('#ct').classList.add('bc');$('#wl').classList.remove('o')}else{$('main').classList.remove('nop');$('#ct').classList.remove('bc')}requestAnimationFrame(rs)}
mobileInit();
try{MQ.addEventListener('change',mobileInit)}catch(e){MQ.addListener&&MQ.addListener(mobileInit)}
addEventListener('orientationchange',()=>setTimeout(rs,250));addEventListener('resize',()=>rs());
if(window.visualViewport)visualViewport.addEventListener('resize',()=>rs());
$('#wl').addEventListener('click',()=>{if(MQ.matches)$('#wl').classList.remove('o')});
const TP=new Map();let pinch=null;
gr.addEventListener('pointerdown',e=>{if(e.pointerType!=='touch')return;TP.set(e.pointerId,{x:e.clientX,y:e.clientY});
 if(TP.size===2){const[a,b]=[...TP.values()];pinch={d:Math.hypot(a.x-b.x,a.y-b.y)||1,bw:V.bw};drag=null;pend=null;e.stopPropagation();e.preventDefault()}else if(TP.size>2)e.stopPropagation()},true);
gr.addEventListener('pointermove',e=>{if(e.pointerType!=='touch'||!TP.has(e.pointerId))return;TP.set(e.pointerId,{x:e.clientX,y:e.clientY});
 if(TP.size>=2&&pinch){const[a,b]=[...TP.values()],d=Math.hypot(a.x-b.x,a.y-b.y)||1;V.lk=null;V.bw=Math.max(2,Math.min(40,pinch.bw*d/pinch.d));drag=null;e.stopPropagation();draw()}},true);
['pointerup','pointercancel'].forEach(t=>gr.addEventListener(t,e=>{if(e.pointerType!=='touch')return;TP.delete(e.pointerId);if(TP.size<2)pinch=null;if(TP.size===0){mouse=null;navUp()}},true));
