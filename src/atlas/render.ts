import type { AtlasGraph } from "./model.ts";

/**
 * Render a self-contained Project Atlas HTML page for a graph. Everything is
 * inlined (styles, script, data): no server, no CDN, works offline, and the file
 * is safe to email, commit, or open directly.
 *
 * The layout is a hand-rolled FORCE-DIRECTED graph on a `<canvas>` (no D3/CDN):
 * nodes repel, parent-child + dependency edges pull, and the graph settles into an
 * organic web. Each epic's cluster gets a soft tinted HULL so the (dense) overview
 * reads as grouped regions; dependency edges (`blocked_by`/`blocks` -> directed
 * arrows; `relates_to` -> dashed) are the point — hierarchy alone is a thin tree.
 * ALL nodes are shown (a "Dependencies only" toggle can focus the web). Pill-backed
 * labels, a hover tooltip, and a details panel round it out.
 *
 * Inspired by Project Atlas in linearstories (Ijonas Kisselbach), rethought for
 * planestories and Plane.
 */
export function renderAtlasHtml(graph: AtlasGraph): string {
	// Escape the JSON so a title containing "</script>" can't break out of the tag.
	const data = JSON.stringify(graph).replace(/</g, "\\u003c");
	const title = `${escapeHtml(graph.project)} — Project Atlas`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="dot"></span>
    <div>
      <div class="project" id="projectName"></div>
      <div class="sub" id="projectSub"></div>
    </div>
  </div>
  <div class="stats" id="stats"></div>
  <div class="actions">
    <input id="search" type="search" placeholder="Search title or ID…" autocomplete="off" />
    <button id="fit" title="Fit to view">Fit</button>
    <button id="reheat" title="Re-run the layout">Reheat</button>
    <button id="theme" title="Toggle light / dark" aria-label="Toggle theme">◐</button>
  </div>
</header>
<div class="filters" id="filters"></div>
<main>
  <div class="canvas" id="canvas">
    <canvas id="graph"></canvas>
    <div class="tooltip" id="tooltip" hidden></div>
    <div class="legend" id="legend"></div>
    <div class="settling" id="settling" hidden><span class="spin"></span> arranging…</div>
    <div class="empty" id="empty" hidden>No items match the current filters.</div>
  </div>
  <aside class="panel" id="panel" hidden></aside>
</main>
<footer class="foot">
  planestories atlas · inspired by Project Atlas (linearstories, Ijonas Kisselbach) · drag nodes · drag background to pan · scroll to zoom
</footer>
<script>
const GRAPH = ${data};
${SCRIPT}
</script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const STYLES = `
:root{
  --bg:#f4f6f9; --bg2:#eaeef3; --panel:#ffffff; --ink:#0f172a; --muted:#647089; --line:#e5e9f0;
  --card:#ffffff; --card-line:#e0e5ee; --shadow:0 1px 2px rgba(15,23,42,.05),0 8px 24px rgba(15,23,42,.07);
  --accent:#4f46e5; --epic:#7c3aed; --edge:#cdd4df; --pill:rgba(255,255,255,.82);
  --g-backlog:#9aa6b8; --g-unstarted:#6b7688; --g-started:#3b82f6; --g-completed:#22c55e; --g-cancelled:#ef4444; --g-unknown:#9aa6b8;
  --blocks:#ea6c34; --relates:#8b5cf6; --flag:#e0900d; --flag-bg:#fef3c7;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#0a0f1c; --bg2:#0d1424; --panel:#0f1826; --ink:#e8edf7; --muted:#8ea0bd; --line:#1b2740;
  --card:#131f34; --card-line:#243450; --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.45);
  --accent:#8b93ff; --epic:#b794ff; --edge:#2a3a58; --pill:rgba(19,31,52,.82);
  --g-started:#60a5fa; --g-completed:#4ade80; --g-cancelled:#f87171; --blocks:#f4915f; --relates:#a78bfa; --flag:#fbbf24; --flag-bg:#3a2f12;
}}
:root[data-theme=dark]{
  --bg:#0a0f1c; --bg2:#0d1424; --panel:#0f1826; --ink:#e8edf7; --muted:#8ea0bd; --line:#1b2740;
  --card:#131f34; --card-line:#243450; --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.45);
  --accent:#8b93ff; --epic:#b794ff; --edge:#2a3a58; --pill:rgba(19,31,52,.82);
  --g-started:#60a5fa; --g-completed:#4ade80; --g-cancelled:#f87171; --blocks:#f4915f; --relates:#a78bfa; --flag:#fbbf24; --flag-bg:#3a2f12;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  display:flex;flex-direction:column;-webkit-font-smoothing:antialiased}
.topbar{display:flex;align-items:center;gap:16px;padding:10px 16px;background:var(--panel);
  border-bottom:1px solid var(--line);flex-wrap:wrap;z-index:2}
.brand{display:flex;align-items:center;gap:10px;min-width:190px}
.brand .dot{width:11px;height:11px;border-radius:50%;background:radial-gradient(circle at 30% 30%,#8b93ff,var(--accent));
  box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent)}
.project{font-weight:680;font-size:15px;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:12px}
.stats{display:flex;gap:16px;color:var(--muted);font-size:12.5px;flex:1;flex-wrap:wrap}
.stats b{color:var(--ink);font-weight:650}
.stats .flag b{color:var(--flag)}
.actions{display:flex;gap:8px;align-items:center}
.actions input,.actions button{font:inherit;border:1px solid var(--card-line);background:var(--card);
  color:var(--ink);border-radius:9px;padding:6px 11px;transition:border-color .15s,background .15s}
.actions input{width:184px}
.actions input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent)}
.actions button{cursor:pointer}
.actions button:hover{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,var(--card))}
.filters{display:flex;flex-wrap:wrap;gap:6px;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--panel);z-index:2}
.chip{font-size:12px;border:1px solid var(--card-line);background:var(--card);color:var(--muted);
  border-radius:999px;padding:3px 11px;cursor:pointer;user-select:none;display:inline-flex;gap:6px;align-items:center;
  transition:border-color .15s,color .15s,background .15s}
.chip:hover{border-color:color-mix(in srgb,var(--accent) 45%,var(--card-line))}
.chip .sw{width:8px;height:8px;border-radius:50%}
.chip.on{color:var(--ink);border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,var(--card))}
.chip.flag.on{border-color:var(--flag);background:var(--flag-bg);color:var(--flag)}
.chip.dep.on{border-color:var(--blocks);background:color-mix(in srgb,var(--blocks) 14%,var(--card));color:var(--blocks)}
main{flex:1;display:flex;min-height:0}
.canvas{position:relative;flex:1;overflow:hidden;cursor:grab;
  background:radial-gradient(120% 120% at 50% 0%,var(--bg) 0%,var(--bg2) 100%)}
.canvas.grabbing{cursor:grabbing}
#graph{width:100%;height:100%;display:block;touch-action:none}
[hidden]{display:none!important}
.empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted)}
.tooltip{position:absolute;pointer-events:none;z-index:5;max-width:280px;background:var(--panel);
  border:1px solid var(--card-line);border-radius:9px;box-shadow:var(--shadow);padding:8px 10px;font-size:12.5px}
.tooltip .tt{font-weight:620;line-height:1.3;margin-bottom:2px}
.tooltip .tm{color:var(--muted);font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.tooltip .td{color:var(--muted);font-size:11.5px;margin-top:3px}
.legend{position:absolute;left:12px;bottom:12px;background:color-mix(in srgb,var(--panel) 82%,transparent);
  border:1px solid var(--line);border-radius:10px;padding:8px 11px;font-size:11.5px;color:var(--muted);
  display:flex;flex-direction:column;gap:5px;pointer-events:none;backdrop-filter:blur(6px)}
.legend .row{display:flex;align-items:center;gap:8px}
.legend .ln{width:22px;height:0;border-top:2px solid var(--blocks);border-radius:2px}
.legend .ln.rel{border-top:2px dashed var(--relates)}
.legend .ln.par{border-top:1.5px solid var(--edge)}
.legend .hl{width:14px;height:10px;border-radius:4px;background:color-mix(in srgb,var(--epic) 16%,transparent);border:1px solid color-mix(in srgb,var(--epic) 40%,transparent)}
.settling{position:absolute;right:14px;bottom:14px;background:color-mix(in srgb,var(--panel) 86%,transparent);
  border:1px solid var(--line);border-radius:999px;padding:5px 12px;font-size:11.5px;color:var(--muted);
  display:flex;align-items:center;gap:7px;backdrop-filter:blur(6px)}
.settling .spin{width:11px;height:11px;border-radius:50%;border:2px solid color-mix(in srgb,var(--accent) 30%,transparent);
  border-top-color:var(--accent);animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.panel{width:344px;max-width:44vw;background:var(--panel);border-left:1px solid var(--line);
  padding:16px 18px;overflow:auto;box-shadow:var(--shadow)}
.panel h2{margin:.1em 0 .25em;font-size:16px;line-height:1.3;letter-spacing:-.01em}
.panel .pid{font-family:ui-monospace,monospace;color:var(--muted);font-size:12px}
.panel .row{margin:13px 0;font-size:13px}
.panel .k{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;font-weight:600}
.panel .pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;border-radius:999px;padding:2px 10px;
  border:1px solid var(--card-line)}
.panel .pill .sw{width:8px;height:8px;border-radius:50%}
.panel .tags{display:flex;flex-wrap:wrap;gap:6px}
.panel .tag{font-size:11.5px;border:1px solid var(--card-line);border-radius:7px;padding:2px 8px;color:var(--muted)}
.panel .bar{height:6px;border-radius:4px;background:var(--card-line);overflow:hidden;margin-top:4px}
.panel .bar>span{display:block;height:100%;background:var(--g-completed);border-radius:4px}
.panel ul{margin:6px 0 0;padding-left:0;list-style:none}
.panel li{display:flex;gap:8px;align-items:flex-start;margin:5px 0}
.panel li .box{margin-top:2px;width:13px;height:13px;border:1.5px solid var(--card-line);border-radius:4px;flex:none}
.panel li.done .box{background:var(--g-completed);border-color:var(--g-completed)}
.panel li.done span{color:var(--muted);text-decoration:line-through}
.panel .dep{display:flex;gap:8px;align-items:baseline;margin:6px 0;cursor:pointer;padding:3px 6px;margin-left:-6px;border-radius:7px}
.panel .dep:hover{background:color-mix(in srgb,var(--accent) 8%,transparent)}
.panel .dep .mk{font-size:10.5px;color:var(--muted);white-space:nowrap;text-transform:uppercase;letter-spacing:.04em}
.panel .flags{background:var(--flag-bg);border:1px solid color-mix(in srgb,var(--flag) 40%,transparent);
  color:var(--flag);border-radius:9px;padding:9px 11px}
.panel .flags .k{color:var(--flag)}
.panel a.plane{display:inline-block;margin-top:8px;color:var(--accent);text-decoration:none;font-size:13px;font-weight:550}
.panel a.plane:hover{text-decoration:underline}
.panel .close{float:right;cursor:pointer;color:var(--muted);border:none;background:none;font-size:20px;line-height:1;padding:0 2px}
.panel .close:hover{color:var(--ink)}
.foot{padding:6px 16px;color:var(--muted);font-size:11.5px;border-top:1px solid var(--line);background:var(--panel);text-align:center}
`;

const SCRIPT = `
const GROUPS=["backlog","unstarted","started","completed","cancelled","unknown"];
const el=id=>document.getElementById(id);
const cv=el("graph"), canvas=el("canvas"), ctx=cv.getContext("2d"), tip=el("tooltip");

// --- Flatten the tree into nodes + parent/dependency edges --------------------
const NODES=[], byId=new Map();
(function flatten(list){for(const n of list){NODES.push(n); byId.set(n.id,n);
  if(n.children&&n.children.length)flatten(n.children);}})(GRAPH.nodes);

const parentOf=new Map(), childrenOf=new Map();
(function walk(list,parent){for(const n of list){ if(parent){parentOf.set(n.id,parent.id);
    (childrenOf.get(parent.id)||childrenOf.set(parent.id,[]).get(parent.id)).push(n.id);}
  if(n.children&&n.children.length)walk(n.children,n);}})(GRAPH.nodes,null);

const DEPS=(GRAPH.edges||[]).filter(e=>byId.has(e.source)&&byId.has(e.target));
const EDGES=[];
for(const [child,par] of parentOf) EDGES.push({s:par,t:child,type:"parent"});
for(const e of DEPS) EDGES.push({s:e.source,t:e.target,type:e.type});
const adj=new Map(); for(const n of NODES) adj.set(n.id,new Set());
for(const e of EDGES){adj.get(e.s).add(e.t);adj.get(e.t).add(e.s);}

// Nodes that participate in the dependency web (+ their parent epics for context).
const inDeps=new Set();
for(const e of DEPS){inDeps.add(e.source);inDeps.add(e.target);}
for(const id of [...inDeps]){const p=parentOf.get(id);if(p)inDeps.add(p);}

// A stable hue per epic so each cluster reads as its own soft-tinted region.
const epicHue=new Map();
{let i=0;for(const n of NODES){if(n.kind==="epic"){epicHue.set(n.id,(i*137.508)%360);i++;}}}
function hueOf(n){ if(n.kind==="epic")return epicHue.get(n.id);
  const p=parentOf.get(n.id); return p!==undefined&&epicHue.has(p)?epicHue.get(p):210; }

// --- Layout state -------------------------------------------------------------
const P=new Map();
(function seed(){const R=Math.max(220,Math.sqrt(NODES.length)*48);let i=0;
  for(const n of NODES){const a=i*2.399963,r=R*Math.sqrt(i/NODES.length);
    P.set(n.id,{x:Math.cos(a)*r,y:Math.sin(a)*r,vx:0,vy:0,r:n.kind==="epic"?11:6,pin:false}); i++;}
})();
const state={statusOn:new Set(),labelOn:new Set(),flaggedOnly:false,depsOnly:false,q:"",
  selected:null,hover:null,view:{x:0,y:0,scale:1}};
let alpha=1;

// --- Force simulation ---------------------------------------------------------
const REP=520, SPRING={parent:0.09,blocks:0.03,relates:0.02}, REST={parent:30,blocks:110,relates:120},
  GRAV=0.04, VDECAY=0.7, DECAY=0.012, AMIN=0.02;
function tick(){
  const arr=NODES,n=arr.length;
  // repulsion is O(n^2) — fine into the low thousands (a few seconds of one-time
  // settle on a ~700-node board). Barnes-Hut would be the next step for larger.
  for(let i=0;i<n;i++){const a=P.get(arr[i].id);
    for(let j=i+1;j<n;j++){const b=P.get(arr[j].id);
      let dx=a.x-b.x,dy=a.y-b.y,d2=dx*dx+dy*dy; if(d2<0.01){dx=Math.random()-0.5;dy=Math.random()-0.5;d2=dx*dx+dy*dy+0.01;}
      const f=REP/d2,fx=dx*f,fy=dy*f; a.vx+=fx*alpha;a.vy+=fy*alpha;b.vx-=fx*alpha;b.vy-=fy*alpha;}}
  for(const e of EDGES){const a=P.get(e.s),b=P.get(e.t);
    let dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||0.01;
    const f=(d-REST[e.type])/d*SPRING[e.type]*alpha,fx=dx*f,fy=dy*f; a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy;}
  for(const nd of arr){const p=P.get(nd.id);
    p.vx-=p.x*GRAV*alpha; p.vy-=p.y*GRAV*alpha;
    if(p.pin){p.vx=0;p.vy=0;continue;}       // dragged node: hold + discard force (no fling)
    p.vx*=VDECAY;p.vy*=VDECAY;p.x+=p.vx;p.y+=p.vy;}
  alpha*=(1-DECAY);
}

// --- Colours (read CSS vars so the canvas follows the theme) ------------------
let COL={};
function readColours(){const cs=getComputedStyle(document.documentElement);const g=k=>cs.getPropertyValue(k).trim();
  COL={ink:g("--ink"),muted:g("--muted"),card:g("--card"),cardLine:g("--card-line"),epic:g("--epic"),
    accent:g("--accent"),edge:g("--edge"),blocks:g("--blocks"),relates:g("--relates"),flag:g("--flag"),pill:g("--pill"),
    backlog:g("--g-backlog"),unstarted:g("--g-unstarted"),started:g("--g-started"),completed:g("--g-completed"),
    cancelled:g("--g-cancelled"),unknown:g("--g-unknown")};}
function nodeColour(n){return COL[n.statusGroup]||COL.unknown;}

// --- Visibility / focus -------------------------------------------------------
function visible(n){return !(state.depsOnly&&!inDeps.has(n.id));}
function matches(n){
  if(state.statusOn.size&&!state.statusOn.has(n.statusGroup))return false;
  if(state.labelOn.size&&!n.labels.some(l=>state.labelOn.has(l)))return false;
  if(state.flaggedOnly&&!(n.quality&&!n.quality.ok))return false;
  if(state.q){const h=(n.title+" "+(n.identifier||"")).toLowerCase();if(!h.includes(state.q))return false;}
  return true;}
function focusId(){return state.hover||state.selected;}
function dimmed(n){ if(!matches(n))return true;
  const f=focusId(); if(f&&f!==n.id&&!adj.get(f).has(n.id))return true; return false;}

// --- Geometry: convex hull for cluster blobs ----------------------------------
function hull(pts){ if(pts.length<3)return pts.slice();
  pts=pts.slice().sort((a,b)=>a.x-b.x||a.y-b.y);
  const cr=(o,a,b)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
  const lo=[];for(const p of pts){while(lo.length>=2&&cr(lo[lo.length-2],lo[lo.length-1],p)<=0)lo.pop();lo.push(p);}
  const up=[];for(let i=pts.length-1;i>=0;i--){const p=pts[i];while(up.length>=2&&cr(up[up.length-2],up[up.length-1],p)<=0)up.pop();up.push(p);}
  lo.pop();up.pop();return lo.concat(up);}
function drawHull(members,hue){
  const pts=members.map(id=>P.get(id)).filter(Boolean);
  if(pts.length<3)return;
  const h=hull(pts); if(h.length<3)return;
  let cx=0,cy=0;for(const p of h){cx+=p.x;cy+=p.y;}cx/=h.length;cy/=h.length;
  const pad=24;
  const ex=h.map(p=>{const dx=p.x-cx,dy=p.y-cy,d=Math.hypot(dx,dy)||1;return{x:p.x+dx/d*pad,y:p.y+dy/d*pad};});
  const n=ex.length,mid=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
  ctx.beginPath();let m0=mid(ex[n-1],ex[0]);ctx.moveTo(m0.x,m0.y);
  for(let i=0;i<n;i++){const cur=ex[i],nx=ex[(i+1)%n],m=mid(cur,nx);ctx.quadraticCurveTo(cur.x,cur.y,m.x,m.y);}
  ctx.closePath();
  ctx.fillStyle="hsla("+hue+",68%,55%,0.06)";ctx.fill();
  ctx.strokeStyle="hsla("+hue+",58%,55%,0.20)";ctx.lineWidth=1.1;ctx.stroke();
}

// --- Drawing ------------------------------------------------------------------
let dpr=1;
function resize(){dpr=window.devicePixelRatio||1;cv.width=canvas.clientWidth*dpr;cv.height=canvas.clientHeight*dpr;draw();}
function T(){const v=state.view;ctx.setTransform(v.scale*dpr,0,0,v.scale*dpr,v.x*dpr,v.y*dpr);}
function clip(s,n){return s.length>n?s.slice(0,n-1)+"…":s;}

function draw(){
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,cv.width,cv.height);
  T();
  const f=focusId(), sc=state.view.scale;
  // cluster hulls (only when a cluster is legible / not focusing / not deps-only)
  if(!f&&!state.depsOnly){
    for(const n of NODES){ if(n.kind!=="epic"||!visible(n))continue;
      const kids=(childrenOf.get(n.id)||[]).filter(id=>{const c=byId.get(id);return c&&c.kind!=="epic";});
      if(kids.length<2)continue;
      drawHull([n.id,...kids],epicHue.get(n.id)); }
  }
  // edges
  ctx.lineCap="round";
  for(const e of EDGES){const A=byId.get(e.s),B=byId.get(e.t);
    if(!visible(A)||!visible(B))continue;
    const a=P.get(e.s),b=P.get(e.t), involved=f&&(e.s===f||e.t===f);
    const faded=(dimmed(A)||dimmed(B))&&!involved;
    ctx.globalAlpha=faded?0.05:(f&&!involved?0.12:(e.type==="parent"?0.45:0.92));
    // gentle curve: bow the line out a touch for an organic look
    const mx=(a.x+b.x)/2,my=(a.y+b.y)/2,dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;
    const bow=Math.min(24,d*0.12),cxp=mx-dy/d*bow,cyp=my+dx/d*bow;
    ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.quadraticCurveTo(cxp,cyp,b.x,b.y);
    if(e.type==="relates"){ctx.setLineDash([5,5]);ctx.strokeStyle=COL.relates;ctx.lineWidth=involved?2.2:1.4;}
    else if(e.type==="blocks"){ctx.setLineDash([]);ctx.strokeStyle=COL.blocks;ctx.lineWidth=involved?2.4:1.6;}
    else{ctx.setLineDash([]);ctx.strokeStyle=COL.edge;ctx.lineWidth=involved?1.7:1;}
    ctx.stroke();
    if(e.type==="blocks")arrow(cxp,cyp,b,P.get(e.t).r);
  }
  ctx.setLineDash([]);ctx.globalAlpha=1;
  // nodes
  const showLabels=sc>1.35;
  for(const n of NODES){ if(!visible(n))continue; const p=P.get(n.id),dim=dimmed(n);
    const sel=state.selected===n.id, hov=state.hover===n.id, r=p.r*(hov?1.25:1);
    ctx.globalAlpha=dim?0.16:1;
    if((sel||hov)&&!dim){ctx.shadowColor=nodeColour(n);ctx.shadowBlur=16;}
    ctx.beginPath();ctx.arc(p.x,p.y,r,0,6.283);ctx.fillStyle=nodeColour(n);ctx.fill();
    ctx.shadowBlur=0;
    if(sel){ctx.lineWidth=2.6;ctx.strokeStyle=COL.accent;ctx.stroke();}
    else if(n.quality&&!n.quality.ok){ctx.lineWidth=2;ctx.strokeStyle=COL.flag;ctx.stroke();}
    else if(n.kind==="epic"){ctx.lineWidth=2.4;ctx.strokeStyle="hsl("+epicHue.get(n.id)+",70%,58%)";ctx.stroke();}
    else{ctx.lineWidth=1;ctx.strokeStyle="rgba(255,255,255,.35)";ctx.stroke();}
    if(!dim&&(n.kind==="epic"||sel||hov||showLabels))
      label(p.x+r+5,p.y,clip(n.title,n.kind==="epic"?30:26),n.kind==="epic");
  }
  ctx.globalAlpha=1;
  el("empty").hidden=NODES.some(n=>visible(n)&&matches(n));
}
function arrow(cx,cy,b,tr){ // arrowhead pointing into target b, tangent from control point
  let dx=b.x-cx,dy=b.y-cy,d=Math.hypot(dx,dy)||1;dx/=d;dy/=d;
  const tx=b.x-dx*(tr+2),ty=b.y-dy*(tr+2),s=6;
  ctx.beginPath();ctx.moveTo(tx,ty);
  ctx.lineTo(tx-dx*s-dy*s*0.55,ty-dy*s+dx*s*0.55);
  ctx.lineTo(tx-dx*s+dy*s*0.55,ty-dy*s-dx*s*0.55);
  ctx.closePath();ctx.fillStyle=ctx.strokeStyle;ctx.fill();
}
function label(x,y,text,bold){
  ctx.font=(bold?"640 ":"500 ")+"11px ui-sans-serif,system-ui,sans-serif";
  const w=ctx.measureText(text).width,padX=5,h=15;
  roundRect(x-3,y-h/2,w+padX*2,h,5);ctx.fillStyle=COL.pill;ctx.fill();
  ctx.fillStyle=COL.ink;ctx.textBaseline="middle";ctx.textAlign="left";ctx.fillText(text,x+padX-3,y+0.5);
}
function roundRect(x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}

// --- Hit testing + interaction ------------------------------------------------
function toWorld(mx,my){const v=state.view;return{x:(mx-v.x)/v.scale,y:(my-v.y)/v.scale};}
function nodeAt(mx,my){const w=toWorld(mx,my);let best=null,bd=1e9;
  for(const n of NODES){if(!visible(n))continue;const p=P.get(n.id),d=Math.hypot(p.x-w.x,p.y-w.y),rr=p.r+7/state.view.scale;
    if(d<rr&&d<bd){bd=d;best=n;}}return best;}
function relMouse(e){const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}

let drag=null;
canvas.addEventListener("mousedown",e=>{const m=relMouse(e),n=nodeAt(m.x,m.y);
  if(n){P.get(n.id).pin=true;drag={node:n,moved:false};}
  else drag={pan:true,x:e.clientX,y:e.clientY,vx:state.view.x,vy:state.view.y,moved:false};
  canvas.classList.add("grabbing");hideTip();});
window.addEventListener("mousemove",e=>{
  if(drag){ if(drag.pan){state.view.x=drag.vx+(e.clientX-drag.x);state.view.y=drag.vy+(e.clientY-drag.y);drag.moved=true;draw();}
    else{const m=relMouse(e),w=toWorld(m.x,m.y),p=P.get(drag.node.id);p.x=w.x;p.y=w.y;p.vx=0;p.vy=0;drag.moved=true;reheat(0.3);}
    return; }
  const m=relMouse(e),n=nodeAt(m.x,m.y),id=n?n.id:null;
  if(id!==state.hover){state.hover=id;canvas.style.cursor=id?"pointer":"grab";draw();}
  if(n)showTip(n,e); else hideTip();
});
window.addEventListener("mouseup",()=>{ if(!drag)return;
  if(drag.node){P.get(drag.node.id).pin=false; if(!drag.moved)select(drag.node.id);}
  else if(!drag.moved&&state.selected){state.selected=null;renderPanel();draw();}
  drag=null;canvas.classList.remove("grabbing");});
canvas.addEventListener("mouseleave",hideTip);
canvas.addEventListener("wheel",e=>{e.preventDefault();const m=relMouse(e);
  const f=e.deltaY<0?1.12:0.893,ns=Math.min(4.5,Math.max(0.12,state.view.scale*f));
  state.view.x=m.x-(m.x-state.view.x)*(ns/state.view.scale);
  state.view.y=m.y-(m.y-state.view.y)*(ns/state.view.scale);state.view.scale=ns;draw();hideTip();},{passive:false});
function select(id){state.selected=id;renderPanel();draw();}

// --- Tooltip ------------------------------------------------------------------
function esc(s){return (s==null?"":String(s)).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
function showTip(n,e){const pr=progress(n);
  let h='<div class="tt">'+esc(clip(n.title,80))+'</div>';
  h+='<div class="tm">'+esc(n.identifier||"unlinked")+' · '+esc(n.status||"—")+(n.kind==="epic"?" · Epic":"")+'</div>';
  const dc=depsOf(n.id).length; const extra=[];
  if(pr.total)extra.push(pr.done+"/"+pr.total+" criteria");
  if(dc)extra.push(dc+" dependenc"+(dc===1?"y":"ies"));
  if(extra.length)h+='<div class="td">'+extra.join(" · ")+'</div>';
  tip.innerHTML=h;tip.hidden=false;
  const r=canvas.getBoundingClientRect(),tw=tip.offsetWidth,th=tip.offsetHeight;
  let x=e.clientX-r.left+14,y=e.clientY-r.top+14;
  if(x+tw>r.width)x=e.clientX-r.left-tw-14; if(y+th>r.height)y=e.clientY-r.top-th-14;
  tip.style.left=x+"px";tip.style.top=y+"px";}
function hideTip(){tip.hidden=true;}
function progress(n){ if(n.criteria&&n.criteria.length)return{done:n.criteria.filter(c=>c.checked).length,total:n.criteria.length};
  return{done:n.statusGroup==="completed"?1:0,total:0};}

// --- Details panel ------------------------------------------------------------
function depsOf(id){const out=[];
  for(const e of DEPS){
    if(e.type==="blocks"&&e.target===id)out.push({node:byId.get(e.source),mark:"blocked by"});
    else if(e.type==="blocks"&&e.source===id)out.push({node:byId.get(e.target),mark:"blocks"});
    else if(e.type==="relates"&&(e.source===id||e.target===id))out.push({node:byId.get(e.source===id?e.target:e.source),mark:"relates"});}
  return out;}
function renderPanel(){const p=el("panel"),n=byId.get(state.selected);
  if(!n){p.hidden=true;return;} p.hidden=false;p.replaceChildren();
  const close=document.createElement("button");close.className="close";close.textContent="×";
  close.onclick=()=>{state.selected=null;renderPanel();draw();};p.appendChild(close);
  const h=document.createElement("h2");h.textContent=n.title;p.appendChild(h);
  if(n.identifier){const id=document.createElement("div");id.className="pid";
    id.textContent=n.identifier+" · "+(n.kind==="epic"?"Epic":"User story");p.appendChild(id);}
  const sr=rowEl("Status");const pill=document.createElement("span");pill.className="pill";
  const sw=document.createElement("span");sw.className="sw";sw.style.background="var(--g-"+n.statusGroup+")";
  pill.append(sw,document.createTextNode(n.status||"—"));sr.appendChild(pill);p.appendChild(sr);
  if(n.assignee)p.appendChild(row("Assignee",n.assignee));
  if(n.labels.length){const r=rowEl("Labels");const t=document.createElement("div");t.className="tags";
    for(const l of n.labels){const s=document.createElement("span");s.className="tag";s.textContent=l;t.appendChild(s);}
    r.appendChild(t);p.appendChild(r);}
  const deps=depsOf(n.id);
  if(deps.length){const r=rowEl("Dependencies ("+deps.length+")");
    for(const d of deps){if(!d.node)continue;const line=document.createElement("div");line.className="dep";
      const mk=document.createElement("span");mk.className="mk";mk.textContent=d.mark;line.appendChild(mk);
      const s=document.createElement("span");s.textContent=(d.node.identifier?d.node.identifier+" ":"")+clip(d.node.title,42);line.appendChild(s);
      line.onclick=()=>{state.selected=d.node.id;flyTo(d.node.id);renderPanel();};r.appendChild(line);}
    p.appendChild(r);}
  if(n.quality&&!n.quality.ok){const r=document.createElement("div");r.className="row flags";
    const k=document.createElement("div");k.className="k";k.textContent="Spec check";r.appendChild(k);
    r.appendChild(document.createTextNode(n.quality.flags.join(" · ")));p.appendChild(r);}
  if(n.criteria&&n.criteria.length){const done=n.criteria.filter(c=>c.checked).length;
    const r=rowEl("Acceptance criteria ("+done+"/"+n.criteria.length+")");
    const bar=document.createElement("div");bar.className="bar";const fill=document.createElement("span");
    fill.style.width=Math.round(done/n.criteria.length*100)+"%";bar.appendChild(fill);r.appendChild(bar);
    const ul=document.createElement("ul");
    for(const c of n.criteria){const li=document.createElement("li");if(c.checked)li.className="done";
      const b=document.createElement("span");b.className="box";li.appendChild(b);
      const s=document.createElement("span");s.textContent=c.text;li.appendChild(s);ul.appendChild(li);}
    r.appendChild(ul);p.appendChild(r);}
  if(n.url){const a=document.createElement("a");a.className="plane";a.href=n.url;a.target="_blank";
    a.rel="noreferrer";a.textContent="Open in Plane →";p.appendChild(a);}
}
function flyTo(id){const p=P.get(id);if(!p)return;const v=state.view;const s=Math.max(v.scale,1.4);
  v.scale=s;v.x=canvas.clientWidth/2-p.x*s;v.y=(canvas.clientHeight)/2-p.y*s;draw();}
function rowEl(k){const r=document.createElement("div");r.className="row";const kk=document.createElement("div");
  kk.className="k";kk.textContent=k;r.appendChild(kk);return r;}
function row(k,v){const r=rowEl(k);r.appendChild(document.createTextNode(v));return r;}

// --- Filters ------------------------------------------------------------------
function buildFilters(){const f=el("filters");f.replaceChildren();
  if(GRAPH.counts.edges){const c=chip("◆ Dependencies only",()=>{state.depsOnly=!state.depsOnly;fit();buildFilters();},state.depsOnly);
    c.classList.add("dep");f.appendChild(c);}
  for(const gname of GROUPS){if(!GRAPH.statuses.length&&gname==="unknown")continue;
    const c=chip(gname,()=>{tog(state.statusOn,gname);draw();buildFilters();},state.statusOn.has(gname));
    const sw=document.createElement("span");sw.className="sw";sw.style.background="var(--g-"+gname+")";c.prepend(sw);f.appendChild(c);}
  for(const l of GRAPH.labels){f.appendChild(chip(l,()=>{tog(state.labelOn,l);draw();buildFilters();},state.labelOn.has(l)));}
  if(GRAPH.counts.flagged){const c=chip("⚠ "+GRAPH.counts.flagged+" flagged",()=>{state.flaggedOnly=!state.flaggedOnly;draw();buildFilters();},state.flaggedOnly);
    c.classList.add("flag");f.appendChild(c);}
}
function chip(label,on,active){const b=document.createElement("span");b.className="chip"+(active?" on":"");
  b.append(document.createTextNode(label));b.onclick=on;return b;}
function tog(set,v){if(set.has(v))set.delete(v);else set.add(v);}

// --- Fit ----------------------------------------------------------------------
function fit(){let mnx=1e9,mny=1e9,mxx=-1e9,mxy=-1e9,any=false;
  for(const n of NODES){if(!visible(n))continue;any=true;const p=P.get(n.id);
    mnx=Math.min(mnx,p.x);mny=Math.min(mny,p.y);mxx=Math.max(mxx,p.x);mxy=Math.max(mxy,p.y);}
  if(!any){state.view={x:canvas.clientWidth/2,y:canvas.clientHeight/2,scale:1};draw();return;}
  const gw=(mxx-mnx)+140,gh=(mxy-mny)+140,w=canvas.clientWidth,h=canvas.clientHeight;
  const s=Math.min(state.depsOnly?2.2:3,Math.min(w/gw,h/gh))||1;
  state.view.scale=s;state.view.x=w/2-((mnx+mxx)/2)*s;state.view.y=h/2-((mny+mxy)/2)*s;draw();}

// --- Legend + header ----------------------------------------------------------
el("legend").innerHTML=
  '<div class="row"><span class="ln"></span> blocks (arrow → blocked)</div>'+
  '<div class="row"><span class="ln rel"></span> relates to</div>'+
  '<div class="row"><span class="ln par"></span> epic → story</div>'+
  '<div class="row"><span class="hl"></span> epic cluster</div>';
el("projectName").textContent=GRAPH.project;
el("projectSub").textContent=GRAPH.source==="board"?"live Plane board":"markdown file";
el("stats").innerHTML=
  '<span>Epics <b>'+GRAPH.counts.epics+'</b></span>'+
  '<span>Stories <b>'+GRAPH.counts.stories+'</b></span>'+
  '<span>Dependencies <b>'+(GRAPH.counts.edges||0)+'</b></span>'+
  (GRAPH.counts.flagged?'<span class="flag">Flagged <b>'+GRAPH.counts.flagged+'</b></span>':"");
el("search").addEventListener("input",e=>{state.q=e.target.value.trim().toLowerCase();draw();});
el("fit").onclick=fit;
el("reheat").onclick=()=>{reheat(0.9);};
el("theme").onclick=()=>{const r=document.documentElement;
  const cur=r.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light");
  r.setAttribute("data-theme",cur==="dark"?"light":"dark");readColours();draw();};

window.addEventListener("resize",resize);
// The canvas is a flex child: opening/closing the details panel changes its width
// WITHOUT a window resize. Observe the container so the bitmap always matches its box.
if(window.ResizeObserver)new ResizeObserver(()=>resize()).observe(canvas);

// --- Run ----------------------------------------------------------------------
let raf=null;
function loop(){ if(alpha>AMIN){tick();draw();raf=requestAnimationFrame(loop);}
  else{raf=null;el("settling").hidden=true;if(!fitted){fitted=true;fit();}} }
function reheat(a){alpha=Math.max(alpha,a||0.7);el("settling").hidden=false;if(!raf)raf=requestAnimationFrame(loop);}
let fitted=false;
readColours();resize();buildFilters();el("settling").hidden=false;
raf=requestAnimationFrame(loop);
`;
