/**
 * The compare page: one self-contained document. No external script, style, font or image is
 * referenced, so opening it makes no request beyond this server (§6.11).
 */
export function comparePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>bytecut compare</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1c1e;--muted:#6b6b70;--line:#d8d8dc;--accent:#0a6cff;--panel:#f5f5f7}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#f2f2f4;--muted:#9b9ba1;--line:#38383c;--accent:#5aa0ff;--panel:#212124}}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:16px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px 24px;align-items:baseline}
h1{font-size:16px;margin:0;font-weight:600}
.muted{color:var(--muted)}
main{padding:16px;max-width:1400px;margin:0 auto}
.controls{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:16px}
select,button{font:inherit;background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 10px}
.stage{position:relative;display:inline-block;max-width:100%;background:var(--panel);line-height:0;user-select:none;touch-action:none}
.stage img{display:block;max-width:100%;height:auto}
.stage .after{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.handle{position:absolute;top:0;bottom:0;width:2px;background:var(--accent);transform:translateX(-1px);cursor:ew-resize}
.handle::after{content:"";position:absolute;top:50%;left:50%;width:28px;height:28px;margin:-14px;border-radius:50%;background:var(--accent);opacity:.9}
.labels{display:flex;justify-content:space-between;margin-top:8px;gap:16px;flex-wrap:wrap}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
.pair video{width:100%;background:#000}
table{border-collapse:collapse;margin-top:24px;width:100%;max-width:720px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
th{color:var(--muted);font-weight:500}
tr.on td{background:var(--panel)}
.err{padding:16px;color:#c0392b}
</style>
</head>
<body>
<header><h1 id="title">bytecut compare</h1><span class="muted" id="sub"></span></header>
<main id="app"><p class="muted">Loading…</p></main>
<script>
(function(){
  var base=location.pathname.replace(/[^\\/]*$/,'');
  var app=document.getElementById('app');
  function fmt(n){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(2)+' MB'}
  function el(tag,attrs,kids){var e=document.createElement(tag);for(var k in attrs||{}){if(k==='text')e.textContent=attrs[k];else e.setAttribute(k,attrs[k])}(kids||[]).forEach(function(c){e.appendChild(c)});return e}
  fetch(base+'data.json').then(function(r){return r.json()}).then(render).catch(function(e){app.innerHTML='';app.appendChild(el('p',{class:'err',text:'Could not load: '+e}))});

  function render(d){
    document.getElementById('title').textContent=d.source.path;
    document.getElementById('sub').textContent=fmt(d.source.bytes)+(d.source.width?' · '+d.source.width+'×'+d.source.height:'')+' original';
    app.innerHTML='';
    var shown=d.outputs.filter(function(o){return o.role!=='poster'});
    if(!shown.length){app.appendChild(el('p',{class:'err',text:'This file has no outputs to compare.'}));return}
    var picker=el('select',{'aria-label':'Output'});
    shown.forEach(function(o,i){
      var label=o.format+(o.codec?' ('+o.codec+')':'')+' · '+o.width+'w · '+fmt(o.bytes);
      picker.appendChild(el('option',{value:String(i),text:label}));
    });
    var controls=el('div',{class:'controls'},[el('label',{text:'Compare with '},[picker])]);
    var stage=el('div');
    app.appendChild(controls);app.appendChild(stage);
    var table=el('table');app.appendChild(table);

    function row(label,value){return el('tr',{},[el('th',{text:label}),el('td',{text:value})])}
    function details(o){
      table.innerHTML='';
      var saved=d.source.bytes>0?Math.round((1-o.bytes/d.source.bytes)*100):0;
      table.appendChild(row('File',o.path));
      table.appendChild(row('Size',fmt(o.bytes)+' ('+(saved>=0?'-':'+')+Math.abs(saved)+'% vs original)'));
      table.appendChild(row('Dimensions',o.width+'×'+o.height));
      if(o.encoder)table.appendChild(row('Encoder',o.encoder));
      if(o.quality!=null)table.appendChild(row('Quality',String(o.quality)));
      if(o.crf!=null)table.appendChild(row('CRF',String(o.crf)));
      if(o.score!=null&&o.search)table.appendChild(row(o.search.metric,o.score.toFixed(1)+' (target '+o.search.target+(o.scorer?', '+o.scorer:'')+')'));
    }

    function slider(o){
      stage.innerHTML='';
      var wrap=el('div',{class:'stage'});
      var before=el('img',{src:base+'file/original',alt:'Original'});
      var after=el('img',{src:base+'file/'+o.index,alt:'Optimized',class:'after'});
      var handle=el('div',{class:'handle'});
      wrap.appendChild(before);wrap.appendChild(after);wrap.appendChild(handle);
      var pos=50;
      function set(p){pos=Math.max(0,Math.min(100,p));after.style.clipPath='inset(0 0 0 '+pos+'%)';handle.style.left=pos+'%'}
      set(50);
      function move(ev){var r=wrap.getBoundingClientRect();set((ev.clientX-r.left)/r.width*100)}
      wrap.addEventListener('pointerdown',function(ev){wrap.setPointerCapture(ev.pointerId);move(ev);wrap.onpointermove=move});
      wrap.addEventListener('pointerup',function(){wrap.onpointermove=null});
      stage.appendChild(wrap);
      stage.appendChild(el('div',{class:'labels'},[
        el('span',{class:'muted',text:'Original · '+fmt(d.source.bytes)}),
        el('span',{class:'muted',text:'Optimized · '+fmt(o.bytes)})]));
    }

    function pair(o){
      stage.innerHTML='';
      var a=el('video',{src:base+'file/original',controls:'',muted:'',loop:'',playsinline:'',preload:'metadata'});
      var b=el('video',{src:base+'file/'+o.index,controls:'',muted:'',loop:'',playsinline:'',preload:'metadata'});
      a.muted=b.muted=true;
      if(d.poster){b.poster=base+'file/'+d.poster.index}
      var lock=false;
      function link(x,y){
        x.addEventListener('play',function(){y.play().catch(function(){})});
        x.addEventListener('pause',function(){y.pause()});
        x.addEventListener('seeking',function(){if(!lock){lock=true;y.currentTime=x.currentTime;setTimeout(function(){lock=false},50)}});
      }
      link(a,b);link(b,a);
      stage.appendChild(el('div',{class:'pair'},[
        el('figure',{style:'margin:0'},[a,el('figcaption',{class:'muted',text:'Original · '+fmt(d.source.bytes)})]),
        el('figure',{style:'margin:0'},[b,el('figcaption',{class:'muted',text:'Optimized · '+fmt(o.bytes)})])]));
    }

    function show(){
      var o=shown[Number(picker.value)];
      details(o);
      if(d.source.kind==='video')pair(o);else slider(o);
    }
    picker.addEventListener('change',show);
    show();
  }
})();
</script>
</body>
</html>
`;
}
