const express = require('express');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const app = express();
app.use(express.urlencoded({extended:true}));
app.use(express.json());

const DB = '/etc/xray/users.json';
const DOMAIN = process.env.XTOOL_DOMAIN || 'localhost';
const IPSTATE_DIR = '/var/lib/xtool';
const IP_WINDOW_SECONDS = 600; // 10 menit

function readDB(){ return JSON.parse(fs.readFileSync(DB,'utf8')); }
function b64(s){ return Buffer.from(s,'utf8').toString('base64'); }
function uuid(){ return execSync('cat /proc/sys/kernel/random/uuid').toString().trim(); }
function genPass(){ return execSync('openssl rand -hex 16').toString().trim(); }
function humanBytes(n){ if(!n||n<=0) return '0 B'; const u=['B','KB','MB','GB','TB']; let i=0; while(n>=1024&&i<u.length-1){n/=1024;i++;} return n.toFixed(2)+' '+u[i]; }
function giB(n){ return n*1024*1024*1024; }
function now(){ return Math.floor(Date.now()/1000); }
function emailKey(email){ return email.replace(/@/g,'_'); }
function currentIpCount(email){
  try{
    const f=path.join(IPSTATE_DIR, 'ip.'+emailKey(email));
    if(!fs.existsSync(f)) return 0;
    const cutoff = now() - IP_WINDOW_SECONDS;
    const ips = new Set();
    const lines = fs.readFileSync(f,'utf8').split(/\n/);
    for(const ln of lines){
      if(!ln.trim()) continue; const [ts,ip] = ln.trim().split(/\s+/);
      if(+ts >= cutoff && ip) ips.add(ip);
    }
    return ips.size;
  }catch(e){ return 0; }
}

function vmessLink(user,id,port,secure){
  const obj={ v:'2', ps:user, add:DOMAIN, port:String(port), id, aid:'0', net:'ws', type:'', host:DOMAIN, path:'/vmess', tls:secure?'tls':'' };
  return 'vmess://'+b64(JSON.stringify(obj));
}
function vlessLink(user,id,port,secure){
  const q=new URLSearchParams({ encryption:'none', security: secure?'tls':'none', type:'ws', host:DOMAIN, path:'/vless' });
  return `vless://${id}@${DOMAIN}:${port}?${q.toString()}#${encodeURIComponent(user)}`;
}
function trojanLink(user,pwd,port,secure){
  const q=new URLSearchParams({ security: secure?'tls':'none', type:'ws', host:DOMAIN, path:'/trojan' });
  return `trojan://${pwd}@${DOMAIN}:${port}?${q.toString()}#${encodeURIComponent(user)}`;
}

function calcQuota(u){
  const used = u.used_bytes||0;
  const qgb = u.quota_gb||0;
  const quota = qgb>0 ? giB(qgb) : 0;
  const remain = quota>0 ? Math.max(0, quota-used) : null;
  const pct = quota>0 ? Math.min(100, Math.round((used*100)/quota)) : 0;
  return {used, quota, remain, pct};
}

function enforce(u){
  const {used, quota} = calcQuota(u);
  const ipNow = currentIpCount(u.email);
  const ipLim = u.ip_limit||0;
  const overQuota = quota>0 && used >= quota;
  const overIp = ipLim>0 && ipNow > ipLim;
  if((overQuota || overIp) && u.enabled !== false){
    try{ execSync(`/usr/bin/xuser disable ${u.email}`); }catch(e){}
    return {overQuota, overIp, disabledNow:true};
  }
  return {overQuota, overIp, disabledNow:false};
}

function barHTML(pct, label, danger){
  const cl = danger? 'fill danger':'fill';
  return `<div class="bar"><div class="${cl}" style="width:${Math.max(0,Math.min(100,pct))}%"></div><div class="barlabel">${label}</div></div>`;
}

app.get('/',(req,res)=>{ res.redirect('/dashboard'); });

app.get('/dashboard',(req,res)=>{
  const db=readDB();
  const total=db.users.length;
  const active=db.users.filter(u=>u.enabled!==false).length;
  const disabled=total-active;
  const limited=db.users.filter(u=> (u.quota_gb>0)||(u.ip_limit>0)).length;
  const body=`
  <link rel="stylesheet" href="/ui.css"/>
  <div class="wrap">
    <h1>Xray Panel</h1>
    <div class="grid">
      <div class="card"><div class="k">Total User</div><div class="v">${total}</div></div>
      <div class="card"><div class="k">Aktif</div><div class="v">${active}</div></div>
      <div class="card"><div class="k">Nonaktif</div><div class="v">${disabled}</div></div>
      <div class="card"><div class="k">Punya Limit</div><div class="v">${limited}</div></div>
    </div>
    <div class="actions">
      <a class="btn" href="/users">Kelola User</a>
      <a class="btn" href="/create">Buat User</a>
      <a class="btn" href="/limits">Monitor Limit</a>
    </div>
  </div>`;
  res.send(html('Dashboard',body));
});

app.get('/users',(req,res)=>{
  const db=readDB();
  const rows=db.users.map(u=>{
    const {used, quota, pct} = calcQuota(u);
    const ipNow = currentIpCount(u.email);
    const ipLim = u.ip_limit||0;
    const over = enforce(u);
    const usedTxt = humanBytes(used);
    const bar = quota>0 ? barHTML(pct, `${usedTxt} / ${humanBytes(quota)} (${pct}%)`, over.overQuota) : '<div class="tag">Unlimited</div>';
    const ipPct = ipLim>0 ? Math.min(100, Math.round(ipNow*100/ipLim)) : 0;
    const ipBar = ipLim>0 ? barHTML(ipPct, `${ipNow}/${ipLim} IP`, over.overIp) : '<div class="tag">No IP limit</div>';
    return `<tr${(over.overQuota||over.overIp)?' style="outline:2px solid #f97316"':''}>
      <td>${u.username}</td>
      <td>${u.protocol.toUpperCase()}</td>
      <td>${u.enabled!==false?'✅':'⛔'}</td>
      <td>${bar}</td>
      <td>${ipBar}</td>
      <td><a class="btn sm" href="/show/${encodeURIComponent(u.email)}">Detail</a></td>
    </tr>`; }).join('');
  const body=`<link rel="stylesheet" href="/ui.css"/><div class="wrap">
    <h1>Daftar User</h1>
    <div class="actions"><a class="btn" href="/create">+ User Baru</a><a class="btn" href="/limits">Monitor Limit</a></div>
    <table class="tbl"><thead><tr>
      <th>User</th><th>Proto</th><th>Status</th><th>Quota Usage</th><th>IP Usage</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody></table></div>`;
  res.send(html('Users',body));
});

app.get('/limits',(req,res)=>{
  const db=readDB();
  const lim=db.users.filter(u=> (u.quota_gb>0)||(u.ip_limit>0));
  const rows=lim.map(u=>{
    const {used, quota, pct} = calcQuota(u);
    const ipNow = currentIpCount(u.email);
    const ipLim = u.ip_limit||0;
    const over = enforce(u);
    const bar = quota>0 ? barHTML(pct, `${humanBytes(used)} / ${humanBytes(quota)} (${pct}%)`, over.overQuota) : '<div class="tag">Unlimited</div>';
    const ipPct = ipLim>0 ? Math.min(100, Math.round(ipNow*100/ipLim)) : 0;
    const ipBar = ipLim>0 ? barHTML(ipPct, `${ipNow}/${ipLim} IP`, over.overIp) : '<div class="tag">No IP limit</div>';
    return `<tr>
      <td>${u.username}</td>
      <td>${u.protocol.toUpperCase()}</td>
      <td>${bar}</td>
      <td>${ipBar}</td>
      <td><a class="btn sm" href="/show/${encodeURIComponent(u.email)}">Detail</a></td>
    </tr>`; }).join('');
  const body=`<link rel="stylesheet" href="/ui.css"/>
  <div class="wrap"><h1>Monitor Limit (Quota & IP)</h1>
  <table class="tbl"><thead><tr>
    <th>User</th><th>Proto</th><th>Quota Usage</th><th>IP Usage</th><th></th>
  </tr></thead><tbody>${rows}</tbody></table>
  <div class="actions"><a class="btn" href="/users">Kembali</a></div>
  </div>`;
  res.send(html('Monitor Limit',body));
});

app.get('/create',(req,res)=>{
  const body=`<link rel="stylesheet" href="/ui.css"/>
  <div class="wrap"><h1>Buat User</h1>
  <form method="POST" action="/create" class="form">
    <label>Protocol
      <select name="protocol" required>
        <option value="vmess">VMess</option>
        <option value="vless">VLESS</option>
        <option value="trojan">Trojan</option>
      </select>
    </label>
    <label>Username <input name="username" required placeholder="contoh: user01"></label>
    <label>Quota (GB, 0=unlimited) <input name="quota" type="number" min="0" value="0"></label>
    <label>IP Limit (0=unlimited) <input name="ip_limit" type="number" min="0" value="0"></label>
    <label>Masa Aktif (hari) <input name="days" type="number" min="1" value="30"></label>
    <button class="btn" type="submit">Buat</button>
  </form></div>`;
  res.send(html('Create',body));
});

app.post('/create',(req,res)=>{
  const {protocol, username} = req.body;
  let {quota, ip_limit, days} = req.body;
  quota = parseInt(quota||'0',10); ip_limit=parseInt(ip_limit||'0',10); days=parseInt(days||'30',10);
  if(!protocol||!username) return res.status(400).send('bad');

  let id = protocol==='trojan' ? genPass() : uuid();
  const email = execSync(`/usr/bin/xuser add ${protocol} ${username} ${id} ${days} ${quota} ${ip_limit}`).toString().trim();
  res.redirect('/show/'+encodeURIComponent(email));
});

app.get('/show/:email',(req,res)=>{
  const email = req.params.email;
  const db=readDB();
  const u=db.users.find(x=>x.email===email);
  if(!u) return res.status(404).send('Not found');
  const {used, quota, pct} = calcQuota(u);
  const ipNow = currentIpCount(u.email);
  const ipLim = u.ip_limit||0;
  const over = enforce(u);
  const usedTxt = humanBytes(used);
  const bar = quota>0 ? barHTML(pct, `${usedTxt} / ${humanBytes(quota)} (${pct}%)`, over.overQuota) : '<div class="tag">Unlimited</div>';
  const ipPct = ipLim>0 ? Math.min(100, Math.round(ipNow*100/ipLim)) : 0;
  const ipBar = ipLim>0 ? barHTML(ipPct, `${ipNow}/${ipLim} IP`, over.overIp) : '<div class="tag">No IP limit</div>';

  const id = u.id; const user=u.username; const proto=u.protocol;
  const l80  = (proto==='vmess'? vmessLink(user,id,80,false)   : (proto==='vless'? vlessLink(user,id,80,false)  : trojanLink(user,id,80,false)));
  const l443 = (proto==='vmess'? vmessLink(user,id,443,true)   : (proto==='vless'? vlessLink(user,id,443,true)  : trojanLink(user,id,443,true)));

  const body=`<link rel="stylesheet" href="/ui.css"/>
  <div class="wrap"><h1>Detail User: ${user}</h1>
  <div class="grid">
    <div class="card"><div class="k">Protocol</div><div class="v">${proto.toUpperCase()}</div></div>
    <div class="card"><div class="k">Email</div><div class="v">${email}</div></div>
    <div class="card"><div class="k">Quota</div><div class="v">${bar}</div></div>
    <div class="card"><div class="k">IP</div><div class="v">${ipBar}</div></div>
    <div class="card"><div class="k">Status</div><div class="v">${u.enabled!==false?'✅ Aktif':'⛔ Nonaktif'}</div></div>
  </div>
  <h2>Share Links</h2>
  <div class="links">
    <div><b>WS (80)</b><br><code>${l80}</code></div>
    <div><b>WSS (443 TLS)</b><br><code>${l443}</code></div>
  </div>
  <div class="actions">
    <form method="POST" action="/toggle" style="display:inline">
      <input type="hidden" name="email" value="${email}">
      <button class="btn ${u.enabled!==false?'warn':'ok'}" type="submit">${u.enabled!==false?'Disable':'Enable'}</button>
    </form>
    <a class="btn" href="/users">Kembali</a>
  </div>
  </div>`;
  res.send(html('User',body));
});

app.post('/toggle',(req,res)=>{
  let body=''; req.on('data',d=>body+=d); req.on('end',()=>{
    const params=new URLSearchParams(body); const email=params.get('email');
    const db=readDB(); const u=db.users.find(x=>x.email===email);
    if(!u) return res.status(404).send('not found');
    if(u.enabled!==false){ execSync(`/usr/bin/xuser disable ${email}`); } else { execSync(`/usr/bin/xuser enable ${email}`); }
    res.redirect('/show/'+encodeURIComponent(email));
  });
});

app.get('/ui.css',(req,res)=>{
  res.type('text/css').send(`
  :root{ --bg:#0b1220; --fg:#e6eefb; --mut:#98a2b3; --card:#121a2b; --acc:#22d3ee; --danger:#ef4444; --ok:#22c55e; }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,Segoe UI,Roboto}
  h1,h2{margin:0 0 12px} .wrap{max-width:1100px;margin:24px auto;padding:0 16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin:16px 0}
  .card{background:var(--card);padding:16px;border-radius:16px;box-shadow:0 8px 20px rgba(0,0,0,.25)}
  .k{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
  .v{font-size:16px;font-weight:600;margin-top:6px}
  .actions{display:flex;gap:10px;margin:12px 0 24px;flex-wrap:wrap}
  .btn{background:var(--acc);border:none;color:#003541;padding:10px 14px;border-radius:12px;font-weight:700;text-decoration:none;display:inline-block}
  .btn.sm{padding:6px 10px;border-radius:10px}
  .btn.warn{background:#f97316;color:#1b0b00}
  .btn.ok{background:#22c55e;color:#002b0e}
  .form{display:grid;gap:12px;max-width:520px}
  input,select{width:100%;padding:10px 12px;border-radius:10px;border:1px solid #22304d;background:#0c1526;color:var(--fg)}
  table.tbl{width:100%;border-collapse:separate;border-spacing:0 8px}
  .tbl th{color:var(--mut);text-align:left;padding:8px}
  .tbl td{background:var(--card);padding:12px;border-top:1px solid #1a2336;border-bottom:1px solid #1a2336;vertical-align:top}
  code{display:block;word-break:break-all;background:#0c1526;border:1px solid #22304d;padding:8px;border-radius:8px}
  .tag{display:inline-block;padding:6px 10px;border:1px solid #22304d;border-radius:10px;background:#0c1526}
  .bar{position:relative;height:14px;background:#0c1526;border-radius:999px;border:1px solid #22304d;overflow:hidden}
  .fill{position:absolute;left:0;top:0;bottom:0;background:var(--ok)}
  .fill.danger{background:var(--danger)}
  .barlabel{margin-top:6px;font-size:12px;color:var(--mut)}
  `);
});

function html(title, body){
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title} · Xray Panel</title></head><body>${body}</body></html>`
}

const PORT = 3000;
app.listen(PORT, ()=>console.log('Xray Panel listening on', PORT));