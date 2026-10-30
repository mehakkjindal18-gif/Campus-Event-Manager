/* app.js - connects your Campus Event Manager page to the C engine (campus.wasm).
 * Load it AFTER your existing inline <script>, and after campus.js.
 * All logic (clash, weekday, day plan, DL projection, sorting) is done in C.
 * This file only holds data, calls C, and draws the screens. */
(() => {
const KEY = 'cem-v1', ADMIN_PW = 'admin123', BUFFER = 30;
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

/* ---------- data (stored in the browser) ---------- */
const SEED = [
  {id:'e1',title:'CTF OPS 101: Boot Camp',date:20261027,start:570,end:690,venue:'Block A',org:'CySecSphere',contact:'cysec@cu.example',desc:'Hands-on capture-the-flag workshop.',seats:42},
  {id:'e2',title:'AI & Campus Futures',date:20261103,start:780,end:900,venue:'Auditorium',org:'Tech Council',contact:'tech@cu.example',desc:'Guest lecture on AI in education.',seats:120},
  {id:'e4',title:'NSS Community Day',date:20261104,start:810,end:990,venue:'Main Ground',org:'NSS Unit',contact:'nss@cu.example',desc:'Community service drive (DL eligible).',seats:60},
  {id:'e3',title:'Design Thinking Studio',date:20261105,start:600,end:720,venue:'Innovation Lab',org:'Design Club',contact:'design@cu.example',desc:'Workshop on problem framing.',seats:28},
  {id:'e5',title:'Campus Hackathon',date:20261106,start:540,end:1020,venue:'Block B',org:'Coding Club',contact:'code@cu.example',desc:'Eight-hour build sprint.',seats:40}
];
const SUBJ = [['Mathematics',24,22],['Digital_Electronics',22,19],['Biology',20,16],['Communication',18,13],['Programming',22,20]];
const TT = {}; { const base=[[540,590],[600,650],[660,710],[840,890],[900,950]];
  for (let d=1; d<=5; d++) TT[d] = base.map((t,i)=>[t[0],t[1],SUBJ[(i+d)%5][0]]); }

let S = JSON.parse(localStorage.getItem(KEY) || 'null') || {reg:[],att:[],certs:[],added:[],del:[]};
const save = () => localStorage.setItem(KEY, JSON.stringify(S));
const events = () => SEED.filter(e=>!S.del.includes(e.id)).concat(S.added);
const byId = id => events().find(e=>e.id===id);

/* ---------- helpers ---------- */
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2,'0');
const hhmm = m => pad(m/60|0)+':'+pad(m%60);
const parts = n => ({y:n/10000|0, m:(n/100|0)%100, d:n%100});
const dshort = n => { const p=parts(n); return pad(p.d)+' '+MON[p.m-1].toUpperCase(); };
const today = () => { const d=new Date(); return d.getFullYear()*10000+(d.getMonth()+1)*100+d.getDate(); };
const toNum = iso => +iso.replace(/-/g,'');
const toMin = t => { const [h,m]=t.split(':'); return +h*60 + +m; };
const left = e => e.seats - (S.reg.includes(e.id)?1:0);
const subjName = s => s.replace(/_/g,' ');
const btn = (label,act,primary) => `<button class="mini-btn ${primary?'primary':''}" data-act="${act}">${label}</button>`;
const card = (title,body) => `<div class="dash-card" style="margin-bottom:11px"><h4>${title}</h4>${body}</div>`;

/* ---------- C engine ---------- */
let C = null;
const badge = document.createElement('div');
badge.style.cssText = 'font-size:10px;margin:0 0 10px;color:#8a939e';
function engineReady(m) {
  C = {
    wd:  m.cwrap('get_weekday','number',['number','number','number']),
    dim: m.cwrap('get_days_in_month','number',['number','number']),
    dlDate: m.cwrap('dl_apply_date','string',['number','number','number']),
    clash:  m.cwrap('find_clash','string',['string']),
    plan:   m.cwrap('plan_day','string',['string']),
    proj:   m.cwrap('attendance_projection','string',['string']),
    sort:   m.cwrap('sort_events','string',['string'])
  };
  badge.textContent = '● C engine (WebAssembly) running'; badge.style.color = '#1e8e59';
  go(cur);
}
if (typeof createCampus === 'function') createCampus().then(engineReady).catch(()=>{ badge.textContent='● C engine failed to load'; });
else badge.textContent = '● C engine not found - add campus.js and campus.wasm';

/* day plan for one event: returns parsed lines */
function planFor(e) {
  const p = parts(e.date), wd = C.wd(p.d,p.m,p.y);
  const lec = (TT[wd]||[]).map(l=>`${l[0]} ${l[1]} ${l[2]}`).join('\n');
  const rows = C.plan(`${e.start} ${e.end} ${BUFFER}\n${lec}`).trim().split('\n').map(l=>l.split(' '));
  return {rows, wd, apply: C.dlDate(p.d,p.m,p.y)};
}
const upcomingReg = () => S.reg.map(byId).filter(e=>e && e.date>=today());
function missedBySubject() {
  const miss = {};
  upcomingReg().forEach(e => planFor(e).rows.forEach(r => { if (r[0]==='LECTURE' && r[4]==='APPLY_DL') miss[r[3]] = (miss[r[3]]||0)+1; }));
  return miss;
}
function projection() {
  const miss = missedBySubject();
  return C.proj(SUBJ.map(s=>`${s[0]} ${s[1]} ${s[2]} ${miss[s[0]]||0}`).join('\n')).trim().split('\n').map(l=>l.split(' '));
}
const needC = () => C ? '' : `<div class="empty">The C engine is not loaded yet. Make sure campus.js and campus.wasm are next to this page and open it through a web server (not by double-clicking the file).</div>`;

/* ---------- views ---------- */
let cur = 'overview', cal = {y:2026, m:11}, selDay = null, selEv = null, adminOK = false;
const view = (title, html) => { document.getElementById('pageTitle').textContent = title; portalView.innerHTML = badge.outerHTML + html; portalView.classList.remove('portal-view'); void portalView.offsetWidth; portalView.classList.add('portal-view'); };

function evRow(e) {
  return `<div class="event"><div class="date">${dshort(e.date)}<small>${hhmm(e.start)}</small></div><div><strong>${esc(e.title)}</strong><small>${esc(e.venue)} · ${left(e)} seats left</small></div><span>${S.reg.includes(e.id)?'<span class="status green">Registered</span>':btn('Details','open:'+e.id,true)}</span></div>`;
}
function sortedIds(list) { return C.sort(list.map(e=>`${e.id} ${e.date} ${e.start}`).join('\n')).trim().split('\n').filter(Boolean); }
function sorted(list) { return C ? sortedIds(list).map(byId) : list; }

function vOverview() {
  let low = '--';
  if (C) { const p = projection(); low = Math.min(...p.map(r=>+r[2])).toFixed(0)+'%'; }
  const dl = C ? Object.values(missedBySubject()).reduce((a,b)=>a+b,0) : 0;
  view('Overview', `<div class="stats"><div class="stat"><span>Registered events</span><strong>${pad(S.reg.length)}</strong></div><div class="stat"><span>Lowest projected attendance</span><strong>${low}</strong></div><div class="stat"><span>Lectures needing DL</span><strong>${pad(dl)}</strong></div><div class="stat"><span>Certificates</span><strong>${pad(S.certs.length)}</strong></div></div>
  <div class="portal-actions" style="margin-top:11px">${btn('Event calendar','page:calendar',true)}${btn("Today's events",'page:today')}${btn('Day planner','page:planner')}</div>
  ${card('Upcoming registered events', C ? (sorted(upcomingReg()).map(evRow).join('')||'<div class="empty">No registrations yet.</div>') : needC())}`);
}

function vCalendar() {
  const {y,m} = cal; let cells = '';
  if (C) {
    const first = C.wd(1,m,y), n = C.dim(m,y), t = today();
    for (let i=0;i<first;i++) cells += '<div></div>';
    for (let d=1; d<=n; d++) {
      const key = y*10000+m*100+d, has = events().filter(e=>e.date===key).length;
      cells += `<div class="cal-cell ${has?'eventday':''} ${key===t?'today':''}" data-act="day:${key}" style="cursor:pointer"><strong>${d}</strong>${has?`<span class="chip good">${has} event${has>1?'s':''}</span>`:''}</div>`;
    }
  }
  const list = selDay ? sorted(events().filter(e=>e.date===selDay)) : [];
  const e = selEv && byId(selEv);
  const detail = e ? card(esc(e.title), `<p style="font-size:11px;line-height:1.7;color:#4a5565">${dshort(e.date)} ${parts(e.date).y} · ${hhmm(e.start)}-${hhmm(e.end)} · ${esc(e.venue)}<br>Organiser: ${esc(e.org)} (${esc(e.contact)})<br>${esc(e.desc)}<br><b>${left(e)}</b> seats left</p>${S.reg.includes(e.id)?'<span class="status green">Registered</span>':btn('Register','reg:'+e.id,true)}`) : '';
  view('Event calendar', `<div class="portal-actions">${btn('‹ Prev','mon:-1')}${btn('Next ›','mon:1')}<b style="font-size:12px;align-self:center">${MON[m-1]} ${y}</b></div>
  ${C ? `<div class="calendar-grid" style="margin-bottom:12px">${DAYS.map(d=>`<b style="font-size:9px;color:#8a939e">${d}</b>`).join('')}${cells}</div>` : needC()}
  ${selDay ? card(dshort(selDay)+' events', list.map(evRow).join('')||'<div class="empty">No events on this day.</div>') : ''}${detail}`);
}

function vToday() {
  view("Today's events", C ? card('Happening today', sorted(events().filter(e=>e.date===today())).map(evRow).join('')||'<div class="empty">No events today.</div>') + (selEv?'':'') : needC());
}

function vPlanner() {
  const list = sorted(upcomingReg());
  view('Day planner', !C ? needC() : list.map(e => {
    const pl = planFor(e);
    const rows = pl.rows.filter(r=>r[0]!=='SUMMARY').map(r => r[0]==='EVENT'
      ? `<div class="planner-row" style="background:#f0f2f6"><b>${hhmm(+r[1])}</b><span><b>${esc(e.title)}</b></span><span class="chip good">Event</span></div>`
      : `<div class="planner-row"><b>${hhmm(+r[1])}</b><span>${esc(subjName(r[3]))}</span><span class="chip ${r[4]==='ATTEND'?'good':'warn'}">${r[4]==='ATTEND'?'Attend':'Apply DL'}</span></div>`).join('');
    const sm = pl.rows.find(r=>r[0]==='SUMMARY');
    return card(`${esc(e.title)} · ${DAYS[pl.wd]} ${dshort(e.date)}`, rows + `<p style="font-size:10px;color:#6b7684">${sm[1]} lecture(s) need DL · apply by <b>${pl.apply}</b></p>`);
  }).join('') || '<div class="dash-card"><div class="empty">Register for an event to get your day plan.</div></div>');
}

function vAttendance() {
  view('DL & attendance', !C ? needC() : card('Projection after registered events (75% required)',
    `<div class="planner-row" style="grid-template-columns:1.4fr repeat(3,1fr);font-weight:700"><span>Subject</span><span>Now</span><span>DL rejected</span><span>DL approved</span></div>` +
    projection().map(r=>`<div class="planner-row" style="grid-template-columns:1.4fr repeat(3,1fr);${r[4]==='1'?'background:#fdeaea':''}"><span>${esc(subjName(r[0]))}</span><span>${r[1]}%</span><span class="chip ${r[4]==='1'?'warn':'good'}">${r[2]}%${r[4]==='1'?' ⚠':''}</span><span>${r[3]}%</span></div>`).join('')));
}

function vHistory() {
  const reg = S.reg.map(byId).filter(Boolean);
  const attended = S.att.map(byId).filter(Boolean);
  view('History & certificates',
    card('Registered events', reg.map(e=>`<div class="event"><div class="date">${dshort(e.date)}</div><div><strong>${esc(e.title)}</strong></div><span>${S.att.includes(e.id)?'<span class="status green">Attended</span>':(e.date<=today()?btn('Mark attended','att:'+e.id,true):'<span class="status">Upcoming</span>')}</span></div>`).join('')||'<div class="empty">Nothing registered yet.</div>') +
    card('Certificates & achievements', S.certs.map(c=>`<div class="cert-row"><span><strong>${esc(c.title)}</strong><small style="display:block;color:#8a939e">${esc((byId(c.id)||{}).title||'')} · ${esc(c.date)}</small></span><span class="status green">${esc(c.result)}</span><span></span></div>`).join('')||'<div class="empty">No certificates yet.</div>') +
    (attended.length ? card('Add a certificate', `<div class="filter-row"><select id="cEv">${attended.map(e=>`<option value="${e.id}">${esc(e.title)}</option>`).join('')}</select><input id="cTitle" placeholder="Certificate title"><select id="cRes"><option>Participation</option><option>Winner</option><option>Runner-up</option></select><input id="cDate" type="date"></div>${btn('Save certificate','cert',true)}`) : ''));
}

function vAdmin() {
  if (!adminOK) { view('Admin', card('Admin login', `<div class="filter-row"><input id="pw" type="password" placeholder="Password"></div>${btn('Login','login',true)}`)); return; }
  const f = (id,ph,type='text') => `<input id="${id}" type="${type}" placeholder="${ph}">`;
  view('Admin', card('Add event', `<div class="filter-row" style="flex-wrap:wrap">${f('aT','Title')}${f('aD','','date')}${f('aS','','time')}${f('aE','','time')}${f('aV','Venue')}${f('aO','Organiser')}${f('aC','Contact')}${f('aN','Seats','number')}${f('aX','Description')}</div>${btn('Add event','add',true)}`) +
    card('Delete events', events().map(e=>`<div class="event"><div class="date">${dshort(e.date)}</div><div><strong>${esc(e.title)}</strong></div>${btn('Delete','del:'+e.id)}</div>`).join('')));
}

const PAGES = {overview:vOverview, calendar:vCalendar, today:vToday, planner:vPlanner, attendance:vAttendance, certificates:vHistory, history:vHistory, admin:vAdmin};
function go(p) {
  cur = PAGES[p] ? p : 'overview';
  document.querySelectorAll('.side button').forEach(b=>b.classList.toggle('active', b.dataset.page===cur || (cur==='history'&&b.dataset.page==='certificates')));
  PAGES[cur]();
}
window.navigate = go;

/* ---------- actions ---------- */
function register(id) {
  const e = byId(id);
  if (!C) return alert('C engine not loaded.');
  if (S.reg.includes(id)) return alert('You are already registered.');
  if (e.date < today()) return alert('This event has already passed.');
  if (left(e) < 1) return alert('No seats left.');
  const reg = S.reg.map(byId).filter(Boolean).map(r=>`${r.id} ${r.date} ${r.start} ${r.end}`).join('\n');
  const res = C.clash(`${e.date} ${e.start} ${e.end}\n${reg}`).trim();
  if (res.startsWith('CLASH') && !confirm('Time clash with "'+byId(res.split(' ')[1]).title+'". Register anyway?')) return;
  S.reg.push(id); save(); alert('Registration confirmed.'); go('planner');
}
const ACTIONS = {
  page: a => go(a),
  mon: a => { cal.m += +a; if (cal.m>12){cal.m=1;cal.y++} if (cal.m<1){cal.m=12;cal.y--} go('calendar'); },
  day: a => { selDay=+a; selEv=null; go('calendar'); },
  open: a => { selEv=a; cur==='today'?go('today'):go('calendar'); },
  reg: register,
  att: a => { S.att.push(a); save(); go('history'); },
  cert: () => { S.certs.push({id:cEv.value,title:cTitle.value||'Certificate',result:cRes.value,date:cDate.value||''}); save(); go('history'); },
  login: () => { if (pw.value===ADMIN_PW) { adminOK=true; go('admin'); } else alert('Wrong password.'); },
  add: () => { if (!aT.value||!aD.value||!aS.value||!aE.value) return alert('Fill title, date and times.');
    if (toMin(aE.value)<=toMin(aS.value)) return alert('End time must be after start time.');
    S.added.push({id:'x'+Date.now(),title:aT.value,date:toNum(aD.value),start:toMin(aS.value),end:toMin(aE.value),venue:aV.value||'TBA',org:aO.value||'-',contact:aC.value||'-',desc:aX.value||'',seats:+aN.value||50}); save(); go('admin'); },
  del: a => { if (SEED.some(e=>e.id===a)) S.del.push(a); else S.added = S.added.filter(e=>e.id!==a); S.reg = S.reg.filter(x=>x!==a); save(); go('admin'); }
};
portalView.addEventListener('click', ev => {
  const b = ev.target.closest('[data-act]'); if (!b) return;
  const i = b.dataset.act.indexOf(':'), name = i<0 ? b.dataset.act : b.dataset.act.slice(0,i), arg = i<0 ? '' : b.dataset.act.slice(i+1);
  if (ACTIONS[name]) ACTIONS[name](arg);
});

/* ---------- sidebar: add Today's events, History and Admin ---------- */
const nav = document.querySelector('.side nav');
[['today',"Today's Events",1],['admin','Admin',0]].forEach(([p,label,after]) => {
  const b = document.createElement('button'); b.dataset.page = p; b.textContent = label;
  b.addEventListener('click', () => go(p));
  if (after) nav.insertBefore(b, nav.children[2]); else nav.appendChild(b);
});
nav.querySelector('[data-page="certificates"]').textContent = 'History & Certificates';
const k = document.querySelector('.dash-top .kicker'); if (k) k.textContent = new Date().toDateString();
go('overview');
})();
