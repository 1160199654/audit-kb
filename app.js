
(function(){
'use strict';

/* ============================================================
   0. 全局状态
   ============================================================ */
/* 站点配置：public 版走明文 <script> 注入（file:// 可用）
              vault  版走加密 .bin + WebCrypto（仅 http/https） */
var CFG = window.KB_CONFIG || {base:'data/', enc:false, label:'public'};
/* 品牌名统一取自构建配置（build.py 的 BRAND）：
   改名字只改那一处，顶栏 / 欢迎页大字 / 浏览器标签会一起变 */
var BR  = (CFG.brand && CFG.brand.name) || '自用审计知识库';
var BRS = (CFG.brand && CFG.brand.sub)  || 'INTERNAL KNOWLEDGE BASE';
var ENC_KEY = null;          // vault 模式的 CryptoKey
var STAT = {pages:0,chars:0,shards:0,cats:{}};
var TREE = [];
var META = null;
var M = [];              // 扁平化的 meta 对象
var idIdx = {};          // id -> meta
var seqIdx = [];         // 顺序 id 数组（上一篇/下一篇用）
var shardCache = {};
var PAGE_SIZE = 60;

var S = {
  q:'', full:false, cat:'', page:0, results:[], mode:'welcome',
  cur:null, kws:[], sel:-1, tab:'tree',
  fs:parseFloat(localStorage.getItem('kb_fs')||'15.5'),
  theme:localStorage.getItem('kb_theme')||'light',
  sideHidden: localStorage.getItem('kb_side')==='0'
};

/* ============================================================
   1. 工具函数
   ============================================================ */
function $(id){ return document.getElementById(id); }
function esc(s){
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function reEsc(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function fmt(n){ return String(n).replace(/\B(?=(\d{3})+(?!\d))/g,','); }
function wc(n){ return n>=10000 ? (n/10000).toFixed(1)+' 万字' : fmt(n)+' 字'; }
function debounce(fn,ms){ var t; return function(){ var a=arguments,c=this; clearTimeout(t); t=setTimeout(function(){ fn.apply(c,a); },ms); }; }
function store(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
function read(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }

var toastTimer;
function toast(msg){
  var el=$('toast'); el.textContent=msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(function(){ el.classList.remove('show'); },2000);
}
function progress(p){
  var bar=$('topline').firstElementChild;
  bar.style.width = p<=0?'0':(p*100).toFixed(1)+'%';
  if(p>=1) setTimeout(function(){ bar.style.width='0'; },400);
}
function loading(on,title,sub,p){
  var el=$('loading');
  if(on){
    el.style.display='flex';
    $('ldTxt').textContent = title||'加载中…';
    $('ldSub').textContent = sub||'';
    $('ldBar').style.width = ((p||0)*100).toFixed(0)+'%';
  } else el.style.display='none';
}

/* ============================================================
   1b. 本机访问记录（localStorage，全程不联网）
   ------------------------------------------------------------
   只记四类事件：页面载入 / 解锁成功 / 打开篇目 / 检索。
   存储为紧凑数组 [秒级时间戳, 事件码, 参数…]，超出上限按 2/3 截断。
   ============================================================ */
var VLOG_KEY = 'kb_vlog', VLOG_MAX = 3000;
var VLOG_EV = {
  b: ['载入', 'boot'],
  u: ['解锁', 'unlock'],
  o: ['打开', 'open'],
  s: ['检索', 'search']
};

function vlogAll(){
  try{
    var a = JSON.parse(read(VLOG_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  }catch(e){ return []; }
}

function vlogAdd(ev, o){
  o = o || {};
  var row = [Math.floor(Date.now()/1000), ev];
  if(ev === 'o'){ row.push(o.id, o.t || '', o.c || ''); }
  else if(ev === 's'){ row.push(o.q || '', o.n || 0, o.full ? 1 : 0); }
  var a = vlogAll();
  a.push(row);
  if(a.length > VLOG_MAX) a = a.slice(a.length - Math.floor(VLOG_MAX * 2 / 3));
  try{ store(VLOG_KEY, JSON.stringify(a)); }catch(e){}
}

/* 检索记录做 1.2 秒静默合并：连续敲字只留最后一次，且同条件不重复记 */
var vlogSearchTimer, vlogSearchLast = '';
function vlogSearch(q, n, full){
  clearTimeout(vlogSearchTimer);
  if(!q) return;
  vlogSearchTimer = setTimeout(function(){
    var k = q + '\u0000' + n + '\u0000' + (full ? 1 : 0);
    if(k === vlogSearchLast) return;
    vlogSearchLast = k;
    vlogAdd('s', {q: q, n: n, full: full});
  }, 1200);
}

function pad2(x){ return x < 10 ? '0' + x : '' + x; }
function vlogTime(ts){
  var d = new Date(ts * 1000);
  return d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate())
       + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function datestamp(){
  var d = new Date();
  return d.getFullYear() + pad2(d.getMonth()+1) + pad2(d.getDate())
       + '_' + pad2(d.getHours()) + pad2(d.getMinutes());
}

function vlogStats(){
  var a = vlogAll(), ids = {}, days = {}, st = {open:0, search:0, unlock:0, boot:0};
  a.forEach(function(r){
    if(r[1] === 'o'){ st.open++; ids[r[2]] = 1; }
    else if(r[1] === 's') st.search++;
    else if(r[1] === 'u') st.unlock++;
    else if(r[1] === 'b') st.boot++;
    var d = new Date(r[0] * 1000);
    days[d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate()] = 1;
  });
  st.uniq = Object.keys(ids).length;
  st.days = Object.keys(days).length;
  st.total = a.length;
  return st;
}

function vlogRowText(r){
  if(r[1] === 'o') return r[3] || ('#' + r[2]);
  if(r[1] === 's') return r[2] || '';
  if(r[1] === 'u') return '内部版口令校验通过';
  return '打开站点';
}

function renderVlog(){
  var st = vlogStats(), a = vlogAll().slice().reverse();
  $('vlogStats').innerHTML =
      '<div class="s"><b>' + fmt(st.uniq) + '</b><span>打开过的不重复篇目</span></div>'
    + '<div class="s"><b>' + fmt(st.search) + '</b><span>检索次数</span></div>'
    + '<div class="s"><b>' + fmt(st.days) + '</b><span>使用天数</span></div>'
    + '<div class="s"><b>' + fmt(st.unlock) + '</b><span>解锁次数</span></div>';

  var box = $('vlogList');
  if(!a.length){
    box.innerHTML = '<div class="vl-empty">还没有记录。<br>打开任意一篇、做一次检索，这里就会留下痕迹。</div>';
    return;
  }
  var h = '<table><thead><tr><th style="width:120px">时间</th><th style="width:56px">动作</th><th>内容</th></tr></thead><tbody>';
  a.slice(0, 400).forEach(function(r){
    var m = VLOG_EV[r[1]] || ['未知', ''];
    var tx;
    if(r[1] === 'o'){
      tx = '<a data-vopen="' + r[2] + '" href="#p' + r[2] + '">' + esc(r[3] || ('#' + r[2])) + '</a>'
         + (r[4] ? ' <span style="color:var(--ink3)">· ' + esc(r[4]) + '</span>' : '');
    } else if(r[1] === 's'){
      tx = '<code>' + esc(r[2]) + '</code> <span style="color:var(--ink3)">· 命中 '
         + fmt(r[3] || 0) + ' 篇' + (r[4] ? ' · 全文' : '') + '</span>';
    } else if(r[1] === 'u'){
      tx = '内部版口令校验通过';
    } else {
      tx = '打开站点';
    }
    h += '<tr><td class="tm">' + vlogTime(r[0]) + '</td>'
       + '<td><span class="ev ev-' + m[1] + '">' + m[0] + '</span></td>'
       + '<td class="tx">' + tx + '</td></tr>';
  });
  h += '</tbody></table>';
  if(a.length > 400) h += '<div class="vl-empty" style="padding:12px">只显示最近 400 条，导出可取得全部 ' + fmt(a.length) + ' 条</div>';
  box.innerHTML = h;
  box.querySelectorAll('[data-vopen]').forEach(function(el){
    el.addEventListener('click', function(e){
      e.preventDefault();
      closeVlog();
      openDoc(+el.getAttribute('data-vopen'));
    });
  });
}

function vlogDownload(name, text, mime){
  try{
    var url = URL.createObjectURL(new Blob([text], {type: mime}));
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 1500);
    toast('已导出 ' + name);
  }catch(e){ toast('导出失败：' + (e.message || e)); }
}

function vlogCsv(){
  var rows = [['时间', '动作', '内容', '篇目ID', '命中数', '检索模式']];
  vlogAll().forEach(function(r){
    var m = VLOG_EV[r[1]] || ['未知', ''];
    rows.push([
      vlogTime(r[0]), m[0], vlogRowText(r),
      r[1] === 'o' ? r[2] : '',
      r[1] === 's' ? (r[3] || 0) : '',
      r[1] === 's' ? (r[4] ? '全文' : '快速') : ''
    ]);
  });
  var csv = '\ufeff' + rows.map(function(r){
    return r.map(function(x){
      return '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
    }).join(',');
  }).join('\r\n');
  vlogDownload('知识库访问记录_' + datestamp() + '.csv', csv, 'text/csv;charset=utf-8');
}

function vlogJson(){
  var st = vlogStats(), out = [];
  vlogAll().forEach(function(r){
    var m = VLOG_EV[r[1]] || ['未知', ''];
    var o = {time: vlogTime(r[0]), ts: r[0], event: m[0], text: vlogRowText(r)};
    if(r[1] === 'o'){ o.id = r[2]; o.category = r[4] || ''; }
    if(r[1] === 's'){ o.query = r[2]; o.hits = r[3] || 0; o.mode = r[4] ? 'full' : 'quick'; }
    out.push(o);
  });
  vlogDownload('知识库访问记录_' + datestamp() + '.json',
    JSON.stringify({profile: CFG.profile, exported: vlogTime(Math.floor(Date.now()/1000)),
                    summary: st, records: out}, null, 2),
    'application/json;charset=utf-8');
}

var vlogClearArm = 0;
function vlogClear(){
  var b = $('vlogClear');
  if(!vlogClearArm){
    vlogClearArm = 1;
    b.textContent = '再点一次确认清空';
    setTimeout(function(){ vlogClearArm = 0; b.textContent = '清空记录'; }, 4000);
    return;
  }
  vlogClearArm = 0;
  b.textContent = '清空记录';
  try{ localStorage.removeItem(VLOG_KEY); }catch(e){}
  renderVlog();
  toast('记录已清空');
}

function openVlog(){ renderVlog(); $('vlog').classList.add('show'); }
function closeVlog(){ $('vlog').classList.remove('show'); }

/* ============================================================
   2. 高亮（跳过 HTML 标签，避免破坏结构）
   ============================================================ */
function hlText(txt,kws){
  if(!kws || !kws.length) return txt;
  var out = txt;
  for(var i=0;i<kws.length;i++){
    var k = kws[i];
    if(!k) continue;
    try{ out = out.replace(new RegExp('('+reEsc(k)+')','gi'),'\u0001$1\u0002'); }catch(e){}
  }
  return out.replace(/\u0001/g,'<mark>').replace(/\u0002/g,'</mark>');
}
function hlHTML(html,kws){
  if(!kws || !kws.length) return html;
  var parts = String(html).split(/(<[^>]+>)/);
  for(var i=0;i<parts.length;i+=2) parts[i]=hlText(parts[i],kws);
  return parts.join('');
}

/* ============================================================
   3. 轻量 Markdown 渲染
   ============================================================ */
function inlineMD(s){
  s = esc(s);
  s = s.replace(/`([^`]+)`/g,function(_,c){ return '<code>'+c+'</code>'; });
  s = s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g,'$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
function renderMD(md,kws){
  var lines = String(md).replace(/\r\n/g,'\n').split('\n');
  var out=[], i=0, n=lines.length;
  function hl(s){ return hlHTML(inlineMD(s),kws); }

  while(i<n){
    var ln = lines[i];

    if(/^\s*```/.test(ln)){
      var buf=[]; i++;
      while(i<n && !/^\s*```/.test(lines[i])){ buf.push(lines[i]); i++; }
      i++;
      out.push('<pre><code>'+esc(buf.join('\n'))+'</code></pre>');
      continue;
    }
    if(/^\s*([-*_])\1{2,}\s*$/.test(ln)){ out.push('<hr>'); i++; continue; }

    var m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(ln);
    if(m){
      var lv = Math.min(m[1].length,4);
      out.push('<h'+lv+'>'+hl(m[2].replace(/\s*#+\s*$/,''))+'</h'+lv+'>');
      i++; continue;
    }

    if(ln.indexOf('|')>=0 && i+1<n && /^\s*\|?[\s:\-|]{3,}\|?\s*$/.test(lines[i+1]) && /-/.test(lines[i+1])){
      var rows=[ln]; i+=2;
      while(i<n && lines[i].indexOf('|')>=0 && lines[i].trim()!==''){ rows.push(lines[i]); i++; }
      function cells(row){
        var r = row.trim();
        if(r.charAt(0)==='|') r=r.slice(1);
        if(r.charAt(r.length-1)==='|') r=r.slice(0,-1);
        return r.split('|').map(function(x){ return x.trim(); });
      }
      var h='<table><thead><tr>';
      cells(rows[0]).forEach(function(c){ h+='<th>'+hl(c)+'</th>'; });
      h+='</tr></thead><tbody>';
      for(var k=1;k<rows.length;k++){
        h+='<tr>';
        cells(rows[k]).forEach(function(c){ h+='<td>'+hl(c)+'</td>'; });
        h+='</tr>';
      }
      out.push(h+'</tbody></table>');
      continue;
    }

    /* 引用：剥离 > 前缀后递归渲染，保留块内的表格 / 列表 / 标题 */
    if(/^\s*>/.test(ln)){
      var q=[];
      while(i<n && /^\s*>/.test(lines[i])){ q.push(lines[i].replace(/^\s*>\s?/,'')); i++; }
      out.push('<blockquote>'+renderMD(q.join('\n'),kws)+'</blockquote>');
      continue;
    }

    if(/^\s*(?:[-+*]|\d+[.)])\s+/.test(ln)){
      var ordered = /^\s*\d+[.)]\s+/.test(ln);
      var items=[];
      while(i<n){
        var l2=lines[i];
        if(/^\s*(?:[-+*]|\d+[.)])\s+/.test(l2)){
          items.push(l2.replace(/^\s*(?:[-+*]|\d+[.)])\s+/,'')); i++;
        } else if(/^\s{2,}\S/.test(l2) && items.length){
          items[items.length-1]+=' '+l2.trim(); i++;
        } else break;
      }
      var tag = ordered?'ol':'ul';
      out.push('<'+tag+'>'+items.map(function(x){ return '<li>'+hl(x)+'</li>'; }).join('')+'</'+tag+'>');
      continue;
    }

    if(ln.trim()===''){ i++; continue; }

    var p=[ln]; i++;
    while(i<n && lines[i].trim()!=='' && !/^\s{0,3}(#{1,6})\s/.test(lines[i])
          && !/^\s*(?:[-+*]|\d+[.)])\s+/.test(lines[i]) && !/^\s*>/.test(lines[i])
          && !/^\s*```/.test(lines[i])
          && !(lines[i].indexOf('|')>=0 && i+1<n && /^\s*\|?[\s:\-|]{3,}\|?\s*$/.test(lines[i+1]))){
      p.push(lines[i]); i++;
    }
    out.push('<p>'+p.map(function(x){ return hl(x); }).join('<br>')+'</p>');
  }
  return out.join('\n');
}

/* ============================================================
   4. 数据加载
   ============================================================ */
function loadScript(src,ok,fail){
  var s=document.createElement('script');
  s.src=src;
  s.onload=function(){ ok&&ok(); };
  s.onerror=function(){ fail&&fail(); };
  document.head.appendChild(s);
}

/* 明文模式下的全局变量名 */
var GLOBALS = {stat:'__STAT', tree:'__TREE', meta:'__META'};
function globalName(name){
  return GLOBALS[name] || ('__S'+String(name).replace('shard_',''));
}

/* ---- 加密通道 ---- */
function b64ToBuf(b64){
  var s = atob(b64), u = new Uint8Array(s.length);
  for(var i=0;i<s.length;i++) u[i]=s.charCodeAt(i);
  return u.buffer;
}
function bufToB64(buf){
  var u = new Uint8Array(buf), s='';
  for(var i=0;i<u.length;i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
function restoreKey(){
  if(!CFG.enc || ENC_KEY) return Promise.resolve(ENC_KEY);
  var raw = null;
  try{ raw = sessionStorage.getItem('kb_key'); }catch(e){}
  if(!raw) return Promise.resolve(null);
  return crypto.subtle.importKey('raw', b64ToBuf(raw), {name:'AES-GCM'}, true, ['decrypt'])
    .then(function(k){ ENC_KEY = k; return k; })
    .catch(function(){ return null; });
}
function deriveKey(pw, saltB64, iterations){
  var enc = new TextEncoder();
  return crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey'])
    .then(function(base){
      return crypto.subtle.deriveKey(
        {name:'PBKDF2', salt: b64ToBuf(saltB64), iterations: iterations, hash:'SHA-256'},
        base, {name:'AES-GCM', length:256}, true, ['decrypt']);
    });
}
function decryptBuf(buf){
  var iv = new Uint8Array(buf, 0, 12);
  var ct = new Uint8Array(buf, 12);
  return crypto.subtle.decrypt({name:'AES-GCM', iv: iv}, ENC_KEY, ct);
}

/* 数据文件是「先 gzip 再加密」，解密后需解压 */
function gunzip(buf){
  if(typeof DecompressionStream !== 'function'){
    return Promise.reject(new Error('浏览器不支持 DecompressionStream，请使用较新版本的 Chrome / Edge / Safari'));
  }
  var ds = new DecompressionStream('gzip');
  var stream = new Blob([buf]).stream().pipeThrough(ds);
  return new Response(stream).arrayBuffer();
}

/* 统一入口：name = stat | tree | meta | shard_N */
function loadData(name, ok, fail){
  if(!CFG.enc){
    var g = globalName(name);
    if(window[g] !== undefined){ ok(window[g]); return; }
    loadScript(CFG.base + name + '.js', function(){ ok(window[g]); }, fail);
    return;
  }
  if(!ENC_KEY){ if(fail) fail(new Error('locked')); else toast('尚未解锁'); return; }
  fetch(CFG.base + name + '.bin')
    .then(function(r){
      if(!r.ok) throw new Error('HTTP '+r.status+' · '+name);
      return r.arrayBuffer();
    })
    .then(decryptBuf)
    .then(gunzip)
    .then(function(pt){ ok(JSON.parse(new TextDecoder().decode(pt))); })
    .catch(function(e){
      console.error('[vault]', name, e);
      if(fail) fail(e); else toast('数据读取失败：'+name);
    });
}

var metaLoading=false, metaWaiters=[];
function ensureMeta(cb){
  if(META){ cb(); return; }
  metaWaiters.push(cb);
  if(metaLoading) return;
  metaLoading=true;
  progress(.3);
  loadData('meta', function(arr){
    META = arr || [];
    M=[]; idIdx={}; seqIdx=[];
    for(var i=0;i<META.length;i++){
      var r = META[i];
      var o = { id:r[0], t:r[1], p:r[2]||[], rel:r[3], c:r[4]||0, v:r[5]||'',
                snip:r[6]||'', arch:r[7]||0, sh:r[8]||0, src:r[9]||0 };
      o.lt = o.t.toLowerCase();
      o.lp = o.p.join(' / ').toLowerCase();
      o.ls = o.snip.toLowerCase();
      o.hay = o.lt+' \u0001 '+o.lp+' \u0001 '+o.ls;
      M.push(o); idIdx[o.id]=o; seqIdx.push(o.id);
    }
    progress(1);
    var ws=metaWaiters; metaWaiters=[];
    ws.forEach(function(f){ try{ f(); }catch(e){ console.error(e); } });
  }, function(){
    metaLoading=false;
    toast('索引加载失败：请确认 data/ 目录完整');
  });
}
function ensureShard(si,cb,fail){
  if(shardCache[si]){ cb(shardCache[si]); return; }
  loadData('shard_'+si, function(arr){
    var map = {};
    (arr||[]).forEach(function(p){ map[p[0]] = p[1]; });
    shardCache[si]=map; cb(map);
  }, function(){
    if(fail) fail(); else toast('正文分片 shard_'+si+' 加载失败');
  });
}

/* ============================================================
   5. 目录树（懒加载：展开时才构建子节点）
   ============================================================ */
function renderTree(){
  var box=$('paneTree');
  box.innerHTML='';
  var frag=document.createDocumentFragment();

  function countLeaf(nd){
    var n=0;
    (function rec(x){ if(x.i!==undefined) n++; (x.c||[]).forEach(rec); })(nd);
    return n;
  }

  function build(nodes, host, depth, inExt){
    nodes.forEach(function(nd){
      var row=document.createElement('div');
      /* 外部参考分支：顶层节点名以 📖 开头，整棵子树标记为外部 */
      var isExt = inExt || /^📖/.test(nd.n);
      if(nd.c && nd.c.length){
        var open = false;  // 默认全折叠
        var cnt = countLeaf(nd);
        row.className='tn dir'+(depth===0?' lv0':'')+(isExt?' extdir':'');
        row.style.paddingLeft = (6 + depth*12) + 'px';
        row.innerHTML = '<span class="tw '+(open?'open':'closed')+'"></span>'
                      + '<span class="lb">'+esc(nd.n)+(cnt?'<span class="num">'+cnt+'</span>':'')+'</span>';
        row.title = nd.n + ' · ' + cnt + ' 篇';

        var child=document.createElement('div');
        child.className='tchild';
        child.style.display = open?'block':'none';
        var built=false;

        row.addEventListener('click',function(e){
          e.stopPropagation();
          var visible = child.style.display!=='none';
          if(visible){
            child.style.display='none';
            row.querySelector('.tw').className='tw closed';
          } else {
            if(!built){ build(nd.c, child, depth+1, isExt); built=true; }
            child.style.display='block';
            row.querySelector('.tw').className='tw open';
          }
        });
        host.appendChild(row); host.appendChild(child);
      } else {
        row.className='tn file'+(isExt?' ext':'');
        row.style.paddingLeft = (6 + depth*12 + 16) + 'px';
        row.setAttribute('data-id',nd.i);
        row.innerHTML='<span class="lb">'+esc(nd.n)
                    + (nd.v?'<span class="tag">'+esc(nd.v)+'</span>':'')
                    + '</span>';
        row.title = nd.n + (nd.v?' · '+nd.v:'');
        row.addEventListener('click',function(){ openDoc(nd.i); });
        host.appendChild(row);
      }
    });
  }
  build(TREE, frag, 0);
  box.appendChild(frag);
  if(S.cur!=null) markTree(S.cur);
}

function markTree(id){
  var box=$('paneTree');
  var prev=box.querySelector('.tn.on'); if(prev) prev.classList.remove('on');
  var el=box.querySelector('.tn.file[data-id="'+id+'"]');
  if(!el) return;
  el.classList.add('on');
  /* 逐级展开祖先（懒加载节点可能尚未构建，故按父容器链向上打开） */
  var p=el.parentElement;
  while(p && p!==box){
    if(p.classList && p.classList.contains('tchild')){
      p.style.display='block';
      var sib=p.previousElementSibling;
      if(sib && sib.querySelector('.tw')) sib.querySelector('.tw').className='tw open';
    }
    p=p.parentElement;
  }
  el.scrollIntoView({block:'nearest'});
}

/* ============================================================
   6. 检索
   ============================================================ */
function parseQuery(raw){
  var out={cat:'',ph:[],terms:[],exc:[]};
  var s=String(raw||'');
  s=s.replace(/分类[:：]\s*([^\s]+)/g,function(_,c){ out.cat=c; return ' '; });
  s=s.replace(/["“]([^"”]+)["”]/g,function(_,p){ out.ph.push(p); return ' '; });
  s.split(/\s+/).forEach(function(t){
    if(!t) return;
    if(t.charAt(0)==='-'||t.charAt(0)==='—'){ if(t.length>1) out.exc.push(t.slice(1).toLowerCase()); }
    else out.terms.push(t.toLowerCase());
  });
  return out;
}
function matchOne(hay,parsed){
  for(var i=0;i<parsed.exc.length;i++){ if(hay.indexOf(parsed.exc[i])>=0) return false; }
  for(var j=0;j<parsed.ph.length;j++){ if(hay.indexOf(parsed.ph[j].toLowerCase())<0) return false; }
  for(var k=0;k<parsed.terms.length;k++){ if(hay.indexOf(parsed.terms[k])<0) return false; }
  return true;
}
function scoreMeta(o,parsed){
  var sc=0;
  for(var i=0;i<parsed.ph.length;i++){
    var p=parsed.ph[i].toLowerCase();
    if(o.lt.indexOf(p)>=0) sc+=200;
    if(o.lp.indexOf(p)>=0) sc+=60;
    if(o.ls.indexOf(p)>=0) sc+=15;
  }
  for(var j=0;j<parsed.terms.length;j++){
    var t=parsed.terms[j];
    if(o.lt.indexOf(t)>=0) sc+=100;
    if(o.lp.indexOf(t)>=0) sc+=30;
    if(o.ls.indexOf(t)>=0) sc+=10;
  }
  return sc;
}
function activeKws(parsed){
  var k=parsed.ph.concat(parsed.terms).filter(function(x){ return x; });
  var seen={}, out=[];
  k.forEach(function(x){ var y=x.toLowerCase(); if(!seen[y]){ seen[y]=1; out.push(x); } });
  return out;
}
function whereHit(o,parsed){
  var tags=[];
  function add(x){ if(tags.indexOf(x)<0) tags.push(x); }
  parsed.ph.forEach(function(raw){
    var p=raw.toLowerCase();
    if(o.lt.indexOf(p)>=0) add('标题');
    else if(o.lp.indexOf(p)>=0) add('路径');
    else if(o.ls.indexOf(p)>=0) add('摘要');
  });
  parsed.terms.forEach(function(t){
    if(o.lt.indexOf(t)>=0) add('标题');
    else if(o.lp.indexOf(t)>=0) add('路径');
    else if(o.ls.indexOf(t)>=0) add('摘要');
  });
  return tags;
}

function filterCandidates(){
  var catLow = S.cat?S.cat.toLowerCase():'';
  var out=[];
  for(var i=0;i<M.length;i++){
    var o=M[i];
    if(window.__ONLY_OWN && o.src!==0) continue;
    if(!S.cat && !window.__INCLUDE_ARCH && o.arch) continue;
    if(catLow && (o.p[0]||'').toLowerCase()!==catLow) continue;
    out.push(o);
  }
  return out;
}

function searchMetaOnly(){
  ensureMeta(function(){
    var parsed=parseQuery(S.q);
    var cand=filterCandidates();
    var res=[], maxSc=1;
    for(var i=0;i<cand.length;i++){
      var o=cand[i];
      if(!matchOne(o.hay,parsed)) continue;
      var sc=scoreMeta(o,parsed);
      if(sc<=0) continue;
      if(sc>maxSc) maxSc=sc;
      res.push({o:o,sc:sc,snip:o.snip,where:whereHit(o,parsed)});
    }
    res.sort(function(a,b){ return b.sc-a.sc || (a.o.src-b.o.src) || a.o.c-b.o.c; });
    res.forEach(function(r){ r.pct = Math.max(8, Math.round(r.sc/maxSc*100)); });
    S.results=res; S.kws=activeKws(parsed); S.page=0; S.sel=-1;
    showResults();
  });
}

var fullRun=0;
function searchFull(){
  ensureMeta(function(){
    var parsed=parseQuery(S.q);
    var cand=filterCandidates();
    var runId=++fullRun;
    var hits=[], maxSc=1;
    var byShard={};
    cand.forEach(function(o){ (byShard[o.sh]=byShard[o.sh]||[]).push(o); });
    var shardIds=Object.keys(byShard).map(Number).sort(function(a,b){ return a-b; });
    if(!shardIds.length){ S.results=[]; S.kws=activeKws(parsed); showResults(); return; }

    loading(true,'正在扫描正文','0 / '+shardIds.length+' 个分片',0);
    var idx=0;

    function step(){
      if(runId!==fullRun) return;
      if(idx>=shardIds.length){
        loading(false);
        hits.sort(function(a,b){ return b.sc-a.sc || (a.o.src-b.o.src) || a.o.c-b.o.c; });
        hits.forEach(function(r){ r.pct = Math.max(8, Math.round(r.sc/maxSc*100)); });
        S.results=hits; S.kws=activeKws(parsed); S.page=0; S.sel=-1;
        showResults();
        return;
      }
      var si=shardIds[idx];
      ensureShard(si,function(map){
        if(runId!==fullRun) return;
        var list=byShard[si];
        for(var k=0;k<list.length;k++){
          var o=list[k], txt=map[o.id];
          if(!txt) continue;
          var low=txt.toLowerCase();
          if(!matchOne(low,parsed)) continue;
          var sc=scoreMeta(o,parsed)+8;
          if(sc>maxSc) maxSc=sc;
          hits.push({o:o,sc:sc,snip:makeSnip(txt,parsed),where:['正文']});
        }
        idx++;
        loading(true,'正在扫描正文',(idx)+' / '+shardIds.length+' 个分片 · 已命中 '+hits.length+' 篇',idx/shardIds.length);
        progress(idx/shardIds.length);
        setTimeout(step,0);
      },function(){ idx++; setTimeout(step,0); });
    }
    step();
  });
}
/* 摘要清洗：去掉外部归档篇首的「来源/原路径/说明」样板文字 */
function cleanSnip(s,title){
  var t = String(s||'');
  t = t.replace(/^\s*来源[:：][\s\S]*?原路径[:：][\s\S]*?(说明[:：][\s\S]*?)?(?=\S{8,})/,'');
  t = t.replace(/来源[:：]\s*MY聊审计[^。\n]*?（网页版\s*cas-guide）?/g,'');
  t = t.replace(/原路径[:：][^说\n]*/g,'');
  t = t.replace(/说明[:：]\s*外部汇编资料[^。\n]*。?/g,'');
  if(title){
    var tt=String(title).replace(/\s+/g,'');
    var head=t.replace(/\s+/g,'').slice(0,tt.length+4);
    if(head.indexOf(tt)===0) t = t.slice(t.replace(/\s+/g,'').indexOf(tt)+tt.length || tt.length);
  }
  t = t.replace(/[#*`>|]/g,' ').replace(/\s+/g,' ').trim();
  return t;
}
function makeSnip(txt,parsed){  var low=txt.toLowerCase();
  var key='';
  if(parsed.ph.length) key=parsed.ph[0].toLowerCase();
  else if(parsed.terms.length) key=parsed.terms[0].toLowerCase();
  var pos = key?low.indexOf(key):-1;
  if(pos<0) pos=0;
  var start=Math.max(0,pos-50), end=Math.min(txt.length,pos+110);
  var s=txt.slice(start,end).replace(/[#*`>|]/g,' ').replace(/\s+/g,' ').trim();
  return (start>0?'…':'')+s+(end<txt.length?'…':'');
}

/* ============================================================
   7. 结果渲染
   ============================================================ */
function showResults(){
  S.mode='results';
  switchTab('res');
  $('resCnt').textContent = S.results.length ? String(S.results.length) : '';

  var box=$('paneRes');
  var total=S.results.length;
  if(S.q) vlogSearch(S.q, total, S.full);   // 检索留痕（静默合并，翻页不重复记）
  var pages=Math.max(1,Math.ceil(total/PAGE_SIZE));
  if(S.page>=pages) S.page=pages-1;
  var slice=S.results.slice(S.page*PAGE_SIZE,(S.page+1)*PAGE_SIZE);

  var parsedCond = esc(S.q);

  var html='<div class="rhead"><div class="n">'
    + (total ? '命中 <b>'+fmt(total)+'</b> 篇' : '没有命中')
    + '<span class="mode'+(S.full?' full':'')+'">'+(S.full?'全文':'快速')+'</span>'
    + (S.cat?'<span class="mode">'+esc(S.cat)+'</span>':'')
    + (window.__ONLY_OWN?'<span class="mode">仅自有</span>':'')
    + (window.__INCLUDE_ARCH?'<span class="mode">含归档</span>':'')
    + '</div>'
    + (total?'<div class="cond">第 '+(S.page+1)+' / '+pages+' 页</div>':'')
    + '</div>';

  if(!total){
    html += '<div class="tip">条件：<em>'+parsedCond+'</em>'
         + (S.full?'':'　快速模式只搜标题 / 目录 / 摘要前 130 字')
         + '</div>'
         + '<div class="empty"><span class="big">∅</span>'
         + '没有找到匹配的篇目<br><br>'
         + '<button class="btn primary" id="goFull" style="margin:4px 0 10px">扫描全部正文（'+fmt(STAT.chars)+' 字 · 约 1–3 秒）</button>'
         + '<div style="font-size:12px;line-height:2.1;margin-top:6px">'
         + '也可以试试：<br>'
         + '· 缩短关键词，或去掉 <code>分类:</code> 限定<br>'
         + '· 分类下拉选「— 仅归档区 —」查历史版本<br>'
         + '· 用 <code>"精确短语"</code> 代替多个散词</div></div>';
  } else {
    if(!S.full && total<8){
      html += '<div class="tip">仅 '+total+' 篇——快速模式只覆盖标题与摘要。'
            + '<a id="goFull">扫描全部正文</a>（'+fmt(STAT.chars)+' 字）可找到更多。</div>';
    }
    slice.forEach(function(r,idx){
      var o=r.o;
      html+='<div class="ritem'+(idx===S.sel?' sel':'')+'" data-id="'+o.id+'" data-i="'+idx+'">';
      html+='<div class="rt">'+hlHTML(esc(o.t),S.kws)+'</div>';
      html+='<div class="rp">'+hlHTML(esc(o.p.join(' / ')||'根目录'),S.kws)
           + '<span class="sep">·</span>'+wc(o.c)
           + (o.v?'<span class="sep">·</span>'+esc(o.v):'')
           + (o.src?'<span class="sep">·</span><span class="badge-ext">外部</span>':'')
           + (o.arch?' <span class="badge-arch">归档</span>':'')
           + '</div>';
      var sn = cleanSnip(r.snip,o.t);
      if(sn && sn.length>6) html+='<div class="rs">'+hlHTML(esc(sn),S.kws)+'</div>';
      html+='<div class="rw">'
          + (r.where||[]).map(function(w){ return '<span class="hit">'+w+'</span>'; }).join('')
          + '<span class="mark-bg"><i style="width:'+(r.pct||10)+'%"></i></span>'
          + '</div>';
      html+='</div>';
    });
    if(pages>1){
      html+='<div class="pager">'
          + '<button class="btn" data-pg="'+(S.page-1)+'"'+(S.page<=0?' disabled':'')+'>← 上一页</button>'
          + '<span>'+fmt(S.page*PAGE_SIZE+1)+'–'+fmt(Math.min(total,(S.page+1)*PAGE_SIZE))+' / '+fmt(total)+'</span>'
          + '<button class="btn" data-pg="'+(S.page+1)+'"'+(S.page>=pages-1?' disabled':'')+'>下一页 →</button>'
          + '</div>';
    }
  }
  box.innerHTML=html;

  var gf=box.querySelector('#goFull');
  if(gf) gf.addEventListener('click',function(){ setFull(true); doSearch(); });
  box.querySelectorAll('.ritem').forEach(function(el){
    el.addEventListener('click',function(){ openDoc(+el.getAttribute('data-id')); });
  });
  box.querySelectorAll('[data-pg]').forEach(function(b){
    b.addEventListener('click',function(){
      var p=+b.getAttribute('data-pg');
      if(p<0||p>=pages) return;
      S.page=p; S.sel=-1; showResults();
    });
  });
  box.scrollTop=0;
  if(S.cur==null) renderSearchPanel();
}

/* ---- 主区检索概览（未打开具体篇目时显示） ---- */
function renderSearchPanel(){
  var w=$('welcome');
  w.className='panel';
  w.style.display='block';
  $('art').style.display='none';
  $('toc').classList.remove('show');
  tocHeadings=[];

  var total=S.results.length;
  var byCat={}, own=0, ext=0;
  S.results.forEach(function(r){
    var k=r.o.p[0]||'（根目录）';
    byCat[k]=(byCat[k]||0)+1;
    if(r.o.src) ext++; else own++;
  });
  var cats=Object.keys(byCat).sort(function(a,b){ return byCat[b]-byCat[a]; }).slice(0,9);
  var maxN=cats.length?byCat[cats[0]]:1;

  var qShow = esc(S.q).replace(/&quot;/g,'"');
  var h='';
  h+='<div class="eyebrow">'+(total?'检索概览':'没有命中')+'</div>';
  h+='<h1><span class="quo">「</span>'+qShow+'<span class="quo">」</span></h1>';

  if(!total){
    h+='<div class="lede">在 <b>'+fmt(STAT.pages)+'</b> 篇资料中没有找到匹配项。'
     + '<br>当前为 <span class="k">'+(S.full?'全文':'快速')+'</span> 模式'
     + (S.full?'':'——只覆盖标题、目录与摘要前 130 字，正文尚未扫描。')
     + '</div>';
    h+='<div class="sect" style="margin-top:26px"><h2><span class="idx">·</span>换个方式试试</h2><div class="hints">'
     + '· 点左侧「<b>扫描全部正文</b>」按钮，或按 <code>Ctrl F</code> 切到全文模式<br>'
     + '· 缩短关键词：<code>收入确认</code> 比 <code>新收入准则下的收入确认时点</code> 更容易命中<br>'
     + '· 去掉 <code>分类:</code> 限定、或在分类下拉选「— 仅归档区 —」查历史版本<br>'
     + '· 用 <code>"精确短语"</code> 代替多个散词'
     + '</div></div>';
    w.innerHTML=h;
    return;
  }

  h+='<div class="lede">在 <b>'+fmt(STAT.pages)+'</b> 篇资料中匹配到 <b>'+fmt(total)+'</b> 篇'
   + '　<span class="k">'+(S.full?'全文':'快速')+'</span>'
   + (S.cat?'　<span class="k">'+esc(S.cat)+'</span>':'')
   + (window.__ONLY_OWN?'　<span class="k">仅自有</span>':'')
   + (window.__INCLUDE_ARCH?'　<span class="k">含归档</span>':'')
   + '<br>自有成果 <b>'+fmt(own)+'</b> 篇 · 外部参考 <b>'+fmt(ext)+'</b> 篇</div>';

  h+='<div class="sect" style="margin-top:30px"><h2><span class="idx">·</span>命中分布（点一行只看该目录）</h2><div class="dist">';
  cats.forEach(function(k){
    h+='<button data-cat2="'+esc(k)+'"><span class="nm">'+esc(k)+'</span>'
     + '<span class="bar"><i style="width:'+Math.max(4,Math.round(byCat[k]/maxN*100))+'%"></i></span>'
     + '<span class="ct">'+byCat[k]+'</span></button>';
  });
  h+='</div></div>';

  h+='<div class="sect"><h2><span class="idx">·</span>读的时候</h2><div class="hints">'
   + '· 点左侧任一条目打开正文；长文右侧会自动出现「本篇目录」，滚动时高亮当前小节<br>'
   + '· <code>[</code> <code>]</code> 翻上一篇 / 下一篇，<code>↑</code> <code>↓</code> 在结果里移动、<code>Enter</code> 打开<br>'
   + '· 每篇文章都可以复制<b>直链</b>（<code>🔗 链接</code>），形如 <code>index.html#p4151</code>，发给同事能直接打开'
   + (!S.full?'<br>· 结果偏少时，按 <code>Ctrl F</code> 或点顶部「全文」，扫描全部 3,526 万字正文':'')
   + '</div></div>';

  w.innerHTML=h;
  $('main').scrollTop=0;
  w.querySelectorAll('[data-cat2]').forEach(function(b){
    b.addEventListener('click',function(){
      var c=b.getAttribute('data-cat2');
      S.cat=(c==='（根目录）'?'':c);
      $('catSel').value=S.cat;
      window.__ONLY_OWN=false; window.__INCLUDE_ARCH=false;
      doSearch();
    });
  });
}

/* 结果列表键盘导航 */
function moveSel(d){
  if(S.mode!=='results' || !S.results.length) return;
  var items=$('paneRes').querySelectorAll('.ritem');
  if(!items.length) return;
  var cur=items[0].parentElement.querySelector('.ritem.sel');
  var i = cur ? +cur.getAttribute('data-i') : -1;
  i = Math.max(0, Math.min(items.length-1, i+d));
  items.forEach(function(el){ el.classList.remove('sel'); });
  items[i].classList.add('sel');
  items[i].scrollIntoView({block:'nearest'});
  S.sel=i;
}
function activateSel(){
  var el=$('paneRes').querySelector('.ritem.sel') || $('paneRes').querySelector('.ritem');
  if(el) openDoc(+el.getAttribute('data-id'));
}

/* ============================================================
   8. 打开文章
   ============================================================ */
function openDoc(id){
  var o = idIdx[id];
  if(!o){ ensureMeta(function(){ openDoc(id); }); return; }
  S.cur=id;
  vlogAdd('o', {id:id, t:o.t, c:(o.p && o.p[0]) || ''});
  if(location.hash!=='#p'+id){
    try{ history.pushState(null,'','#p'+id); }catch(e){ location.hash='p'+id; }
  }
  $('welcome').style.display='none';
  var art=$('art'); art.style.display='block';

  /* —— 标题体系重组：面包屑 → 主标题 → 元信息 → 操作条 —— */
  var crumb = '<div class="crumb">'
    + '<a data-home="1">⌂ 首页</a><span class="sp">/</span>'
    + (o.p.length
        ? o.p.map(function(x,i){
            return '<a data-cat="'+esc(o.p[0])+'" title="只看「'+esc(o.p[0])+'」">'+esc(x)+'</a>'
                 + (i<o.p.length-1?'<span class="sp">/</span>':'');
          }).join('')
        : '<span class="cur">根目录</span>')
    + '</div>';

  var metaBits = [];
  if(o.v) metaBits.push('<span class="vtag">'+esc(o.v)+'</span>');
  metaBits.push('<span>'+wc(o.c)+'</span>');
  if(o.src) metaBits.push('<span class="badge-ext">外部参考</span>');
  if(o.arch) metaBits.push('<span class="badge-arch">历史归档</span>');
  var fname = String(o.rel||'').split(/[\\/]/).pop();
  if(fname) metaBits.push('<span title="'+esc(o.rel)+'">'+esc(fname)+'</span>');

  var head = '<div class="art-head">'+crumb
           + '<h1 class="art-title">'+esc(o.t)+'</h1>'
           + '<div class="art-meta">'+metaBits.join('<span class="sepdot">·</span>')+'</div>'
           + '<div class="art-bar" id="artBar">'
           +   '<button class="btn" id="navPrev" title="上一页 [">← 上一篇</button>'
           +   '<button class="btn" id="navNext" title="下一页 ]">下一篇 →</button>'
           +   '<span style="flex:1"></span>'
           +   '<button class="btn" id="btnLink" title="复制本篇直链">🔗 链接</button>'
           +   '<button class="btn" id="btnCopy" title="复制正文">⧉ 全文</button>'
           + '</div></div>';

  /* 外部资料的版权提示常驻在正文顶部 */
  var extNote = o.src
    ? '<div class="tip" style="border-radius:8px;margin:16px 0 0;border:1px solid var(--line)">'
      + '<b style="color:var(--ext)">外部汇编资料</b>　仅供内部学习速查，不得对外分发、不得作为执业依据；条文引用请回溯发布机关原文。'
      + '</div>'
    : '';

  art.innerHTML = '<div class="wrap">'+head
    + '<div id="artBody" style="min-height:140px"><div class="empty">正文载入中…</div></div>'
    + '</div>';

  /* 面包屑与操作 */
  art.querySelector('[data-home]').addEventListener('click',function(){ goHome(); });
  art.querySelectorAll('[data-cat]').forEach(function(a){
    a.addEventListener('click',function(){
      var c=a.getAttribute('data-cat');
      $('catSel').value=c; S.cat=c; window.__ONLY_OWN=false; window.__INCLUDE_ARCH=false;
      $('q').value=''; S.q='';
      switchTab('tree');
      toast('已筛选：'+c);
    });
  });

  var prevId = prevOf(id), nextId = nextOf(id);
  var np=$('navPrev'), nn=$('navNext');
  if(np){
    if(prevId==null) np.setAttribute('disabled','');
    np.addEventListener('click',function(){ if(prevId!=null) openDoc(prevId); });
  }
  if(nn){
    if(nextId==null) nn.setAttribute('disabled','');
    nn.addEventListener('click',function(){ if(nextId!=null) openDoc(nextId); });
  }
  $('btnLink').addEventListener('click',function(){
    copyText(location.origin+location.pathname+'#p'+id).then(function(){
      toast('直链已复制');
    });
  });
  $('btnCopy').addEventListener('click',function(){ copyText(art._raw||''); });

  ensureShard(o.sh,function(map){
    var txt = map[id];
    if(!txt){ $('artBody').innerHTML='<div class="empty">未找到正文（分片数据异常）</div>'; return; }
    art._raw = txt;
    var body=$('artBody');
    body.innerHTML = extNote + renderMD(txt,S.kws);

    /* 去掉与页面主标题重复的首个 H1（含「_v5_」这类轻微差异） */
    var firstH1 = body.querySelector('h1');
    if(firstH1 && similarTitle(firstH1.textContent, o.t)) firstH1.remove();

    buildTOC();
    setupArtBar();
    $('main').scrollTop=0;
    progress(1);
  });
  markTree(id);
  store('kb_last',String(id));
  pushRecent(id);
}
function norm(s){ return String(s||'').replace(/\s+/g,'').toLowerCase(); }

/* 标题近似判定：忽略标点与版本号差异，取字符集重合度 */
function similarTitle(a,b){
  function key(s){
    return String(s||'')
      .replace(/[_\-—–·．.、,，:：;；!！?？"'“”‘’《》〈〉()（）\[\]【】]/g,'')
      .replace(/v\d+(?:\.\d+)*/gi,'')
      .replace(/\s+/g,'').toLowerCase();
  }
  var x=key(a), y=key(b);
  if(!x||!y) return false;
  if(x===y) return true;
  if(x.indexOf(y)===0 || y.indexOf(x)===0) return true;
  var i=0, m=Math.min(x.length,y.length);
  while(i<m && x.charAt(i)===y.charAt(i)) i++;
  return i>=15 || (i>=8 && i/m>=0.8);
}

function prevOf(id){
  var i=seqIdx.indexOf(id);
  return i>0 ? seqIdx[i-1] : null;
}
function nextOf(id){
  var i=seqIdx.indexOf(id);
  return (i>=0 && i<seqIdx.length-1) ? seqIdx[i+1] : null;
}

/* 文章内目录 */
var tocHeadings=[], tocRaf=null;
function buildTOC(){
  var body=$('artBody'), toc=$('toc');
  tocHeadings=[];
  var hs = body.querySelectorAll('h2,h3');
  if(hs.length<3){ toc.classList.remove('show'); toc.innerHTML=''; return; }
  hs.forEach(function(h,i){
    var id='sec'+i;
    h.id=id;
    tocHeadings.push({id:id, el:h, lv:h.tagName==='H2'?2:3, txt:h.textContent.trim()});
  });
  var h='<div class="toc-h">本篇目录</div>';
  tocHeadings.forEach(function(t){
    h+='<a href="#'+t.id+'" data-t="'+t.id+'" class="lv'+t.lv+'" title="'+esc(t.txt)+'">'+esc(t.txt)+'</a>';
  });
  toc.innerHTML=h;
  toc.classList.add('show');
  toc.querySelectorAll('a').forEach(function(a){
    a.addEventListener('click',function(e){
      e.preventDefault();
      var t=document.getElementById(a.getAttribute('data-t'));
      if(t) scrollToEl(t);
    });
  });
  toc.querySelectorAll('a').forEach(function(a){ a.classList.remove('cur'); });
}
function scrollToEl(el){
  var main=$('main');
  var top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 66;
  main.scrollTo({top:top, behavior:'smooth'});
}
function spyTOC(){
  if(!tocHeadings.length) return;
  var main=$('main');
  var y = main.scrollTop + 90;
  var cur=null;
  for(var i=0;i<tocHeadings.length;i++){
    var el=tocHeadings[i].el;
    var top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
    if(top<=y) cur=tocHeadings[i].id; else break;
  }
  var links=$('toc').querySelectorAll('a');
  links.forEach(function(a){ a.classList.toggle('cur', a.getAttribute('data-t')===cur); });
}
function setupArtBar(){
  var bar=$('artBar');
  if(!bar) return;
  var main=$('main');
  var onScroll=function(){
    bar.classList.toggle('stuck', main.scrollTop>120);
    spyTOC();
  };
  main.removeEventListener('scroll',main._artScroll||function(){});
  main._artScroll=onScroll;
  main.addEventListener('scroll',onScroll,{passive:true});
}

function copyText(t){
  if(!t){ toast('暂无内容'); return Promise.resolve(); }
  if(navigator.clipboard && navigator.clipboard.writeText){
    return navigator.clipboard.writeText(t).then(function(){
      if(t.length>60) toast('已复制全文');
      return true;
    },function(){ return fallback(); });
  }
  return Promise.resolve(fallback());
  function fallback(){
    var ta=document.createElement('textarea');
    ta.value=t; ta.style.position='fixed'; ta.style.left='-9999px';
    document.body.appendChild(ta); ta.select();
    var ok=false;
    try{ ok=document.execCommand('copy'); toast(ok?(t.length>60?'已复制全文':'已复制'):'复制失败，请手动选择'); }catch(e){ toast('复制失败'); }
    document.body.removeChild(ta);
    return ok;
  }
}

/* 最近阅读 */
function pushRecent(id){
  var list=[];
  try{ list=JSON.parse(read('kb_recent')||'[]'); }catch(e){ list=[]; }
  list = list.filter(function(x){ return x!==id; });
  list.unshift(id);
  list = list.slice(0,8);
  store('kb_recent',JSON.stringify(list));
}

/* ============================================================
   9. 首页
   ============================================================ */
var HOT=['固定资产','收入确认','内控缺陷','经济责任审计','审计报告','政府补助','小金库','舞弊','合同审计','绩效评价','三重一大','往来款'];

function renderWelcome(){
  var w=$('welcome');
  w.className='home';
  w.style.display='block'; $('art').style.display='none';
  $('toc').classList.remove('show');
  S.mode='welcome'; S.cur=null; tocHeadings=[];
  if(location.hash){
    try{ history.replaceState(null,'',location.pathname+location.search); }catch(e){ location.hash=''; }
  }

  var recent=[];
  try{ recent=JSON.parse(read('kb_recent')||'[]'); }catch(e){}
  recent = recent.map(function(id){ return idIdx[id]; }).filter(Boolean);

  var PUB = CFG.profile === 'public';
  var h='';
  h+='<div class="home-hero">'
   + '<div class="eyebrow">'+esc(BRS)+'</div>'
   + '<h1>'+esc(BR)+'</h1>'
   + '<div class="lede">'
   + (PUB
      ? '审计实务、专题研究与培训材料的公开检索入口。'
        + '全部数据随页面加载，<b>无需登录、可离线、可直链分享</b>。'
      : '把 <b>自有成果</b> 与 <b>外部准则汇编</b> 放在同一个搜索框里。'
        + '全部数据落在本地，可离线、可直链、可断网使用。')
   + '</div>'
   + '</div>';

  h+='<div class="statstrip">'
   + '<div><b>'+fmt(STAT.pages||STAT.own||0)+'</b><span>收录篇目</span></div>'
   + (!PUB?'<div><b>'+fmt(STAT.ext||0)+'</b><span>外部参考</span></div>':'')
   + '<div><b>'+(STAT.chars>=1e4?fmt(Math.round(STAT.chars/1e4)):fmt(STAT.chars))+'</b><span>总字数（万）</span></div>'
   + '<div><b>'+fmt(STAT.cats?Object.keys(STAT.cats).length:0)+'</b><span>一级分类</span></div>'
   + '</div>';

  /* ① 从这里开始 */
  h+='<div class="sect"><h2><span class="idx">1</span>从这里开始</h2><div class="actions">'
   + '<div class="action" data-act="browse"><span class="ic">'
   +   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
   +   '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
   +   '</span><b>按目录浏览</b><span>左侧目录树逐级展开，适合已知去处的查找</span></div>'
   + '<div class="action" data-act="search"><span class="ic">'
   +   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">'
   +   '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>'
   +   '</span><b>按关键词检索</b><span>停在检索框敲 <code>/</code>，全文 '+(STAT.chars>=1e4?fmt(Math.round(STAT.chars/1e4)):fmt(STAT.chars))+' 万字可扫</span></div>'
   + '<div class="action" data-act="recent"><span class="ic">'
   +   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'
   +   '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>'
   +   '</span><b>继续上次阅读</b><span>'+(recent.length?'从最近 '+recent.length+' 篇里挑':'暂无记录，读过的篇目会自动出现在这里')+'</span></div>'
   + '</div></div>';

  /* ② 最近阅读 */
  if(recent.length){
    h+='<div class="sect"><h2><span class="idx">2</span>最近阅读</h2><div class="recent">';
    recent.forEach(function(o){
      h+='<a data-rid="'+o.id+'"><span class="rn">'+o.id+'</span><span class="rt">'+esc(o.t)+'</span>'
       + (o.src?'<span class="badge-ext">外部</span>':'')+'</a>';
    });
    h+='</div></div>';
  }

  /* ③ 检索语法 */
  h+='<div class="sect"><h2><span class="idx">'+(recent.length?3:2)+'</span>检索语法速查</h2>'
   + '<table class="gram">'
   + '<tr><td><code>固定资产 折旧</code></td><td>空格分隔＝<b>且</b>，每个词都要命中才返回</td></tr>'
   + '<tr><td><code>&quot;收入确认&quot;</code></td><td>引号内是<b>精确短语</b>，不拆词，命中权重最高</td></tr>'
   + '<tr><td><code>-银行</code></td><td>减号开头＝<b>排除</b>含该词的结果</td></tr>'
   + '<tr><td><code>分类:审计知识库</code></td><td>限定到某个<b>一级目录</b>，等价于用分类下拉</td></tr>'
   + '<tr><td>快速 / 全文</td><td>快速只搜标题·目录·摘要（秒出）；全文扫描全部正文（1–3 秒，带进度）</td></tr>'
   + '</table></div>';

  /* ④ 常用关键词 */
  h+='<div class="sect"><h2><span class="idx">'+(recent.length?4:3)+'</span>常用词试试</h2>'
   + '<div class="chips" id="hotWords">'
   + HOT.map(function(x){ return '<b data-w="'+esc(x)+'">'+esc(x)+'</b>'; }).join('')
   + '</div></div>';

  /* ⑤ 资料构成 */
  h+='<div class="sect"><h2><span class="idx">'+(recent.length?5:4)+'</span>这些资料是什么</h2>'
   + '<div class="notes">'
   + (PUB
      ? '<p>收录 <b>审计实务方法、专题研究、培训与考核材料、CPA 备考笔记</b> 等 '+fmt(STAT.pages||0)+' 篇，'
        + '按一级目录分为 '+fmt(STAT.cats?Object.keys(STAT.cats).length:0)+' 类，均为本所整理的可公开内容。</p>'
        + '<p>不含事务所内部制度、客户项目文档与第三方汇编资料。</p>'
      : '<p><b>自有成果</b>（'+fmt(STAT.own||0)+' 篇）　来自 <code>成果/</code> 下全部 .md：制度文件体系、审计知识库及各专题。'
        + '归档区（历史版本）默认不进检索结果，但仍可在目录树里浏览，或把分类下拉切到「— 仅归档区 —」。</p>'
        + '<div class="note-ext"><b>外部参考</b>（'+fmt(STAT.ext||0)+' 篇）　来自 <code>外部资料/MY聊审计-准则库/</code>，'
        + '2026-10-20 抓取自公开网页版，为第三方汇编。<br>'
        + '① 仅供内部学习速查，<b>不得对外分发</b>；② <b>不得作为执业依据</b>，条文引用须回溯财政部等发布机关原文；'
        + '③ 未做版本甄别，<b>不得当作最新版</b>。详见该目录下 <code>00_来源与版权说明.md</code>。</div>')
   + '</div></div>';

  /* ⑥ 小技巧 */
  h+='<div class="sect"><h2><span class="idx">'+(recent.length?6:5)+'</span>几个顺手的用法</h2>'
   + '<div class="notes">'
   + '<p>· <b>直链</b>：地址栏形如 <code>index.html#p12</code> 指向具体某篇，可直接发给同事。</p>'
   + (!PUB?'<p>· <b>只看自己写的</b>：分类下拉选「— 仅自有成果 —」，一次排除全部外部参考。</p>':'')
   + '<p>· <b>长文定位</b>：正文右侧会自动生成「本篇目录」，随滚动高亮当前小节。</p>'
   + '<p>· <b>纯键盘</b>：<code>/</code> 检索、<code>↑↓</code> 选结果、<code>Enter</code> 打开、<code>[</code> <code>]</code> 翻篇，'
   + '按 <code>?</code> 看全部快捷键。</p>'
   + '</div></div>';

  /* ⑦ 版本信息 */
  h+='<div style="margin-top:40px;padding-top:16px;border-top:1px solid var(--line);'
   + 'font-size:11px;color:var(--ink3);line-height:2">'
   + '数据截至 <b style="color:var(--ink2)">'+esc(STAT.built||'—')+'</b>　·　'
   + fmt(STAT.pages||0)+' 篇　·　'+(STAT.chars>=1e4?fmt(Math.round(STAT.chars/1e4)):fmt(STAT.chars))+' 万字　·　'
   + (PUB?'公开版':'内部完整版')
   + '</div>';

  w.innerHTML=h;

  w.querySelectorAll('#hotWords b').forEach(function(el){
    el.addEventListener('click',function(){
      $('q').value=el.getAttribute('data-w');
      syncSearchUI();
      doSearch();
    });
  });
  w.querySelectorAll('[data-rid]').forEach(function(a){
    a.addEventListener('click',function(){ openDoc(+a.getAttribute('data-rid')); });
  });
  w.querySelectorAll('.action').forEach(function(a){
    a.addEventListener('click',function(){
      var act=a.getAttribute('data-act');
      if(act==='browse'){ switchTab('tree'); setSide(true); $('paneTree').scrollTop=0; }
      else if(act==='search'){ $('q').focus(); }
      else if(act==='recent'){ var f=w.querySelector('.recent a'); if(f) f.click(); else $('q').focus(); }
    });
  });
  $('main').scrollTop=0;
}

/* ============================================================
   10. 搜索建议面板
   ============================================================ */
var sugSel=-1;
function getHistory(){
  try{ return JSON.parse(read('kb_hist')||'[]'); }catch(e){ return []; }
}
function pushHistory(q){
  q=(q||'').trim(); if(!q) return;
  var list=getHistory().filter(function(x){ return x!==q; });
  list.unshift(q); store('kb_hist',JSON.stringify(list.slice(0,12)));
}
function openSug(){
  var box=$('sug');
  var hist=getHistory();
  var h='';
  if(hist.length){
    h+='<div class="sg-h"><span>最近检索</span><a data-clearhist="1">清除</a></div>';
    hist.slice(0,8).forEach(function(q){
      h+='<div class="sg-i" data-q="'+esc(q)+'"><span class="ic">⏱</span><em>'+esc(q)+'</em></div>';
    });
  }
  h+='<div class="sg-h"><span>常用词</span></div>';
  HOT.slice(0,8).forEach(function(q){
    h+='<div class="sg-i" data-q="'+esc(q)+'"><span class="ic">#</span><em>'+esc(q)+'</em></div>';
  });
  box.innerHTML=h;
  box.classList.add('show');
  sugSel=-1;
  box.querySelectorAll('[data-q]').forEach(function(el){
    el.addEventListener('mousedown',function(e){
      e.preventDefault();
      $('q').value=el.getAttribute('data-q');
      syncSearchUI(); closeSug(); doSearch();
    });
  });
  var ch=box.querySelector('[data-clearhist]');
  if(ch) ch.addEventListener('mousedown',function(e){
    e.preventDefault(); store('kb_hist','[]'); openSug();
  });
}
function closeSug(){ $('sug').classList.remove('show'); sugSel=-1; }

/* ============================================================
   11. 交互
   ============================================================ */
function syncSearchUI(){
  var has = !!$('q').value.trim();
  $('searchbox').classList.toggle('hasval',has);
}
function setFull(v){
  S.full = !!v;
  $('btnFull').classList.toggle('on',S.full);
  $('btnQuick').classList.toggle('on',!S.full);
}
function doSearch(){
  var q=$('q').value.trim();
  S.q=q;
  syncSearchUI();
  if(!q){ $('resCnt').textContent=''; goHome(); return; }
  closeSug();
  S.cur=null;                       // 新检索回到概览，不保留上一篇正文
  if(S.full) searchFull(); else searchMetaOnly();
}
function goHome(){
  renderWelcome();
  switchTab('tree');
  $('resCnt').textContent='';
}
function switchTab(t){
  S.tab=t;
  $('tabTree').classList.toggle('on',t==='tree');
  $('tabRes').classList.toggle('on',t==='res');
  $('paneTree').style.display = t==='tree'?'block':'none';
  $('paneRes').style.display  = t==='res'?'block':'none';
  $('treeTools').style.display= t==='tree'?'flex':'none';
}
function setSide(show){
  S.sideHidden=!show;
  $('side').classList.toggle('hide',!show);
  $('btnSide').classList.toggle('on',show);
  store('kb_side',show?'1':'0');
}
function applyFS(){
  document.documentElement.style.setProperty('--fs',S.fs+'px');
  store('kb_fs',String(S.fs));
}
function applyTheme(){
  document.documentElement.setAttribute('data-theme',S.theme);
  $('btnTheme').textContent = S.theme==='dark'?'☀️':'🌙';
  store('kb_theme',S.theme);
}
function buildCatSelect(){
  var sel=$('catSel');
  var PUB = CFG.profile === 'public';
  var agg={};
  Object.keys(STAT.cats||{}).forEach(function(k){
    var key=k.replace(/^📦 归档区 \/ /,'');
    agg[key]=(agg[key]||0)+STAT.cats[k];
  });
  var keys=Object.keys(agg).sort(function(a,b){
    var ea=/^📖/.test(a)?1:0, eb=/^📖/.test(b)?1:0;
    return ea-eb || agg[b]-agg[a];
  });
  var h='<option value="">全部分类</option>';
  keys.forEach(function(k){ h+='<option value="'+esc(k)+'">'+esc(k)+' · '+agg[k]+'</option>'; });
  if(!PUB){
    h+='<option value="__OWN__">— 仅自有成果 —</option>';
    h+='<option value="__ARCH__">— 仅归档区 —</option>';
  }
  sel.innerHTML=h;
}

/* ============================================================
   12. 启动
   ============================================================ */
function boot(){
  applyFS(); applyTheme();
  if(CFG.enc && !ENC_KEY){
    restoreKey().then(function(k){ if(k) startData(); else showUnlock(); });
  } else {
    startData();
  }
}

/* 先取统计与目录树，再进入主界面 */
function startData(){
  loadData('stat', function(s){
    STAT = s || STAT;
    loadData('tree', function(t){
      TREE = t || [];
      startApp();
    }, function(){ toast('目录加载失败，暂时无法浏览'); });
  }, function(){ toast('统计数据加载失败'); });
}

/* ---- 口令解锁（仅 vault 版） ---- */
var lockBusy=false;
function lockErr(msg){
  var e = document.getElementById('lockErr');
  if(!e) return;
  e.textContent = msg || '';
  e.style.opacity = msg ? '1' : '0';
}
function showUnlock(){
  var box = document.createElement('div');
  box.id = 'lock';
  box.innerHTML =
    '<div class="lk-card">'
  +   '<div class="lk-badge">🔒</div>'
  +   '<h1>内部版 · 需要访问口令</h1>'
  +   '<p class="lk-sub">本页包含所内制度与第三方汇编资料，仅限授权人员访问。<br>口令由管理员单独下发。</p>'
  +   '<div class="lk-row">'
  +     '<input id="lockPw" type="password" placeholder="输入访问口令" autocomplete="current-password" spellcheck="false">'
  +     '<button id="lockGo" class="lk-btn">进入</button>'
  +   '</div>'
  +   '<div id="lockErr" class="lk-err"></div>'
  +   '<p class="lk-foot">口令仅在本机用于解密，不会上传。<br>关闭浏览器后需重新输入。</p>'
  + '</div>';
  document.body.appendChild(box);
  document.documentElement.setAttribute('data-locked','1');
  var pw = document.getElementById('lockPw');
  pw.focus();
  pw.addEventListener('keydown', function(e){ if(e.key==='Enter') doUnlock(); });
  document.getElementById('lockGo').addEventListener('click', doUnlock);
}

function doUnlock(){
  if(lockBusy) return;
  var pw = (document.getElementById('lockPw')||{}).value || '';
  if(!pw){ lockErr('请输入口令'); return; }
  lockBusy = true;
  var btn = document.getElementById('lockGo');
  if(btn){ btn.textContent='验证中…'; btn.disabled=true; }
  lockErr('');

  fetch(CFG.unlock || (CFG.base + '_key.json'))
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(function(k){
      return deriveKey(pw, k.salt, k.iter).then(function(key){
        return fetch(CFG.base + (k.check || '_check.bin'))
          .then(function(r){ return r.arrayBuffer(); })
          .then(function(buf){
            var iv = new Uint8Array(buf,0,12), ct = new Uint8Array(buf,12);
            return crypto.subtle.decrypt({name:'AES-GCM', iv:iv}, key, ct)
              .then(function(){
                ENC_KEY = key;
                return crypto.subtle.exportKey('raw', key);
              })
              .then(function(raw){
                try{ sessionStorage.setItem('kb_key', bufToB64(raw)); }catch(e){}
                return true;
              });
          })
          .catch(function(){ return false; });
      });
    })
    .then(function(ok){
      lockBusy = false;
      if(ok){
        var el = document.getElementById('lock');
        if(el) el.remove();
        document.documentElement.removeAttribute('data-locked');
        vlogAdd('u');                    // 解锁留痕（不含口令、不含派生密钥）
        startData();
      } else {
        if(btn){ btn.textContent='进入'; btn.disabled=false; }
        lockErr('口令不正确，请向管理员确认');
        var p = document.getElementById('lockPw');
        if(p){ p.value=''; p.focus(); }
      }
    })
    .catch(function(e){
      lockBusy = false;
      if(btn){ btn.textContent='进入'; btn.disabled=false; }
      lockErr('无法读取密钥信息，请检查网络或联系管理员');
      console.error(e);
    });
}

function startApp(){
  buildCatSelect(); setSide(!S.sideHidden);
  $('btnSide').classList.toggle('on',!S.sideHidden);

  /* 品牌名：三个版本各自取自己的配置，值不同则显示不同 */
  document.title = BR + ' · 全文检索';
  var bt = document.querySelector('.brand .txt');
  if(bt) bt.innerHTML = esc(BR) + '<small>' + esc(BRS) + '</small>';

  $('stats').innerHTML = (CFG.profile==='public'
      ? '<b>'+fmt(STAT.pages||0)+'</b> 篇<br>'
      : '<b>'+fmt(STAT.own||0)+'</b> 自有 · <b>'+fmt(STAT.ext||0)+'</b> 外部<br>')
    + fmt(Math.round((STAT.chars||0)/1e4))+' 万字 · '+esc(STAT.built||'');
  renderTree();

  /* 直链必须早于 renderWelcome（后者会清 hash） */
  var mInit=/^#p(\d+)$/.exec(location.hash);
  var sp=new URLSearchParams(location.search||'');
  var qInit=sp.get('q');
  if(mInit){
    var initId=+mInit[1];
    ensureMeta(function(){
      if(idIdx[initId]) openDoc(initId);
      else { toast('未找到该篇目：#p'+initId); renderWelcome(); }
    });
  } else if(qInit || sp.get('cat') || sp.get('own')==='1' || sp.get('full')==='1'){
    if(sp.get('full')==='1') setFull(true);
    var cInit=sp.get('cat');
    if(cInit){ S.cat=cInit; $('catSel').value=cInit; }
    if(sp.get('own')==='1'){ window.__ONLY_OWN=true; $('catSel').value='__OWN__'; }
    if(qInit){ $('q').value=qInit; syncSearchUI(); }
    ensureMeta(function(){
      if(qInit) doSearch();
      else { switchTab('tree'); toast('已限定分类：'+(cInit||'仅自有成果')); }
    });
  } else {
    renderWelcome();
  }

  var qEl=$('q');
  qEl.addEventListener('input',debounce(function(){
    syncSearchUI();
    if(!qEl.value.trim() && S.mode!=='welcome'){ goHome(); }
    else if(qEl.value.trim()) doSearch();
  },220));
  qEl.addEventListener('focus',function(){ if(!qEl.value.trim()) openSug(); });
  qEl.addEventListener('blur',function(){ setTimeout(closeSug,150); });
  qEl.addEventListener('keydown',function(e){
    if(e.key==='Enter'){ e.preventDefault(); doSearch(); qEl.blur(); }
    else if(e.key==='Escape'){ qEl.value=''; syncSearchUI(); doSearch(); qEl.blur(); }
  });

  $('btnClearQ').addEventListener('click',function(){ qEl.value=''; syncSearchUI(); doSearch(); qEl.focus(); });
  $('btnQuick').addEventListener('click',function(){ setFull(false); if(qEl.value.trim()) doSearch(); });
  $('btnFull').addEventListener('click',function(){ setFull(true); if(qEl.value.trim()) doSearch(); else toast('全文模式：搜索将扫描全部正文'); });

  $('brandHome').addEventListener('click',goHome);
  $('tabTree').addEventListener('click',function(){ switchTab('tree'); });
  $('tabRes').addEventListener('click',function(){ switchTab('res'); });
  $('btnSide').addEventListener('click',function(){ setSide($('side').classList.contains('hide')); });
  $('btnTheme').addEventListener('click',function(){ S.theme=S.theme==='dark'?'light':'dark'; applyTheme(); });
  $('fsUp').addEventListener('click',function(){ S.fs=Math.min(21,S.fs+0.5); applyFS(); });
  $('fsDown').addEventListener('click',function(){ S.fs=Math.max(12,S.fs-0.5); applyFS(); });

  $('catSel').addEventListener('change',function(){
    var v=this.value;
    window.__ONLY_OWN = (v==='__OWN__');
    if(v==='__ARCH__'){ window.__INCLUDE_ARCH=true; S.cat=''; }
    else { window.__INCLUDE_ARCH=false; S.cat=(v==='__OWN__'?'':v); }
    if(qEl.value.trim()) doSearch();
    else if(S.mode==='results') doSearch();
  });

  $('btnExpAll').addEventListener('click',function(){
    /* 只展开一级目录（含 5,282 节点的全展开要 9 秒，日常不需要） */
    Array.prototype.slice.call($('paneTree').querySelectorAll('.tn.dir.lv0')).forEach(function(r){
      var tw=r.querySelector('.tw');
      if(tw && tw.className.indexOf('closed')>=0) r.click();
    });
  });
  $('btnColAll').addEventListener('click',function(){
    renderTree();               // 重建为初始 20 行，顺带释放已展开的节点内存
    $('paneTree').scrollTop=0;
    if(S.cur!=null) markTree(S.cur);
  });

  /* 快捷键面板 */
  $('btnKbd').addEventListener('click',function(){ $('kbd').classList.add('show'); });
  $('kbdClose').addEventListener('click',function(){ $('kbd').classList.remove('show'); });
  $('kbd').addEventListener('click',function(e){ if(e.target===this) this.classList.remove('show'); });

  /* 本机访问记录面板 */
  $('btnVlog').addEventListener('click',openVlog);
  $('vlogClose').addEventListener('click',closeVlog);
  $('vlog').addEventListener('click',function(e){ if(e.target===this) closeVlog(); });
  $('vlogCsv').addEventListener('click',vlogCsv);
  $('vlogJson').addEventListener('click',vlogJson);
  $('vlogClear').addEventListener('click',vlogClear);
  vlogAdd('b');                      // 页面载入留痕

  document.addEventListener('keydown',function(e){
    var inInput = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    var mod = e.ctrlKey || e.metaKey;

    if(mod && e.key.toLowerCase()==='k'){ e.preventDefault(); qEl.focus(); qEl.select(); return; }
    if(mod && e.key.toLowerCase()==='b'){ e.preventDefault(); setSide($('side').classList.contains('hide')); return; }
    if(mod && e.key.toLowerCase()==='j'){ e.preventDefault(); S.theme=S.theme==='dark'?'light':'dark'; applyTheme(); return; }
    if(mod && e.key.toLowerCase()==='h'){ e.preventDefault(); goHome(); return; }
    if(mod && e.key.toLowerCase()==='f'){ e.preventDefault(); setFull(!S.full); if(qEl.value.trim()) doSearch(); return; }

    if(e.key==='Escape'){
      if($('vlog').classList.contains('show')){ closeVlog(); return; }
      if($('kbd').classList.contains('show')){ $('kbd').classList.remove('show'); return; }
      closeSug();
      return;
    }
    if(inInput) return;

    if(e.key==='/'){ e.preventDefault(); qEl.focus(); return; }
    if(e.key==='?'||(e.shiftKey&&e.key==='/')){ e.preventDefault(); $('kbd').classList.toggle('show'); return; }
    if(e.key==='ArrowDown'){ e.preventDefault(); moveSel(1); return; }
    if(e.key==='ArrowUp'){ e.preventDefault(); moveSel(-1); return; }
    if(e.key==='Enter' && S.mode==='results'){ e.preventDefault(); activateSel(); return; }
    if(e.key==='[' && S.cur!=null){ e.preventDefault(); var p=prevOf(S.cur); if(p!=null) openDoc(p); return; }
    if(e.key===']' && S.cur!=null){ e.preventDefault(); var n=nextOf(S.cur); if(n!=null) openDoc(n); return; }
  });

  /* 前进 / 后退 */
  window.addEventListener('hashchange',function(){
    var m=/^#p(\d+)$/.exec(location.hash);
    if(m){
      var id=+m[1];
      if(S.cur!==id) ensureMeta(function(){ if(idIdx[id]) openDoc(id); });
    } else if(S.mode!=='welcome'){ goHome(); }
  });

  /* 空闲预载索引 */
  setTimeout(function(){ ensureMeta(function(){}); },500);
}

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot);
else boot();
})();
