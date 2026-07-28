import type { AtlasGraph } from "./model.ts";

/**
 * Render a self-contained Project Atlas HTML page for a graph. Everything is
 * inlined (styles, script, data): no server, no CDN, works offline, and the file
 * is safe to email, commit, or open directly.
 *
 * The layout is a hand-rolled FORCE-DIRECTED graph on a `<canvas>` (no D3/CDN):
 * nodes repel, parent-child + dependency edges pull, and the graph settles into an
 * organic web. Dependency edges (`blocked_by`/`blocks` -> directed arrows;
 * `relates_to` -> dashed) are the point — hierarchy alone is a thin tree. ALL nodes
 * are shown (unconnected ones drift to the edges).
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
    <button id="theme" title="Toggle theme" aria-label="Toggle theme">◐</button>
  </div>
</header>
<div class="filters" id="filters"></div>
<main>
  <div class="canvas" id="canvas">
    <canvas id="graph"></canvas>
    <div class="legend" id="legend"></div>
    <div class="empty" id="empty" hidden>No items match the current filters.</div>
  </div>
  <aside class="panel" id="panel" hidden></aside>
</main>
<footer class="foot">
  planestories atlas · inspired by Project Atlas (linearstories, Ijonas Kisselbach) · drag nodes, drag background to pan, scroll to zoom
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
  --bg:#f6f7f9; --panel:#ffffff; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0;
  --card:#ffffff; --card-line:#dfe4ea; --shadow:0 1px 2px rgba(15,23,42,.06),0 4px 12px rgba(15,23,42,.05);
  --accent:#4f46e5; --epic:#6d28d9; --link:#c7ccd6; --edge:#cbd2dc;
  --g-backlog:#94a3b8; --g-unstarted:#64748b; --g-started:#2563eb; --g-completed:#16a34a; --g-cancelled:#ef4444; --g-unknown:#94a3b8;
  --blocks:#e0672f; --relates:#8b5cf6; --flag:#d97706; --flag-bg:#fef3c7;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#0b1220; --panel:#111a2b; --ink:#e6ebf5; --muted:#93a1b8; --line:#1f2b40;
  --card:#141f33; --card-line:#25344f; --shadow:0 1px 2px rgba(0,0,0,.35),0 6px 18px rgba(0,0,0,.35);
  --accent:#818cf8; --epic:#a78bfa; --link:#2c3a56; --edge:#31425f;
  --g-started:#60a5fa; --g-completed:#4ade80; --g-cancelled:#f87171; --blocks:#f4915f; --relates:#a78bfa; --flag:#fbbf24; --flag-bg:#3a2f12;
}}
:root[data-theme=dark]{
  --bg:#0b1220; --panel:#111a2b; --ink:#e6ebf5; --muted:#93a1b8; --line:#1f2b40;
  --card:#141f33; --card-line:#25344f; --shadow:0 1px 2px rgba(0,0,0,.35),0 6px 18px rgba(0,0,0,.35);
  --accent:#818cf8; --epic:#a78bfa; --link:#2c3a56; --edge:#31425f;
  --g-started:#60a5fa; --g-completed:#4ade80; --g-cancelled:#f87171; --blocks:#f4915f; --relates:#a78bfa; --flag:#fbbf24; --flag-bg:#3a2f12;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  display:flex;flex-direction:column}
.topbar{display:flex;align-items:center;gap:16px;padding:10px 16px;background:var(--panel);
  border-bottom:1px solid var(--line);flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;min-width:200px}
.brand .dot{width:10px;height:10px;border-radius:50%;background:var(--accent)}
.project{font-weight:650;font-size:15px}
.sub{color:var(--muted);font-size:12px}
.stats{display:flex;gap:14px;color:var(--muted);font-size:12.5px;flex:1;flex-wrap:wrap}
.stats b{color:var(--ink);font-weight:600}
.stats .flag b{color:var(--flag)}
.actions{display:flex;gap:8px;align-items:center}
.actions input,.actions button{font:inherit;border:1px solid var(--card-line);background:var(--card);
  color:var(--ink);border-radius:8px;padding:6px 10px}
.actions input{width:180px}
.actions button{cursor:pointer}
.actions button:hover{border-color:var(--accent)}
.filters{display:flex;flex-wrap:wrap;gap:6px;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
.chip{font-size:12px;border:1px solid var(--card-line);background:var(--card);color:var(--muted);
  border-radius:999px;padding:3px 10px;cursor:pointer;user-select:none;display:inline-flex;gap:6px;align-items:center}
.chip .sw{width:8px;height:8px;border-radius:50%}
.chip.on{color:var(--ink);border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,var(--card))}
.chip.flag.on{border-color:var(--flag);background:var(--flag-bg);color:var(--flag)}
main{flex:1;display:flex;min-height:0}
.canvas{position:relative;flex:1;overflow:hidden;cursor:grab}
.canvas.grabbing{cursor:grabbing}
#graph{width:100%;height:100%;display:block;touch-action:none}
[hidden]{display:none!important}
.empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted)}
.legend{position:absolute;left:12px;bottom:12px;background:color-mix(in srgb,var(--panel) 88%,transparent);
  border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:11.5px;color:var(--muted);
  display:flex;flex-direction:column;gap:4px;pointer-events:none;backdrop-filter:blur(3px)}
.legend .row{display:flex;align-items:center;gap:7px}
.legend .ln{width:22px;height:0;border-top:2px solid var(--blocks)}
.legend .ln.rel{border-top:2px dashed var(--relates)}
.legend .ln.par{border-top:1.5px solid var(--edge)}
.panel{width:340px;max-width:44vw;background:var(--panel);border-left:1px solid var(--line);
  padding:16px 18px;overflow:auto}
.panel h2{margin:.1em 0 .2em;font-size:16px;line-height:1.3}
.panel .pid{font-family:ui-monospace,monospace;color:var(--muted);font-size:12px}
.panel .row{margin:12px 0;font-size:13px}
.panel .k{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
.panel .tags{display:flex;flex-wrap:wrap;gap:6px}
.panel .tag{font-size:11.5px;border:1px solid var(--card-line);border-radius:6px;padding:2px 7px;color:var(--muted)}
.panel ul{margin:6px 0 0;padding-left:0;list-style:none}
.panel li{display:flex;gap:8px;align-items:flex-start;margin:5px 0}
.panel li .box{margin-top:2px;width:13px;height:13px;border:1.5px solid var(--card-line);border-radius:4px;flex:none}
.panel li.done .box{background:var(--g-completed);border-color:var(--g-completed)}
.panel li.done span{color:var(--muted);text-decoration:line-through}
.panel .dep{display:flex;gap:8px;align-items:center;margin:5px 0;cursor:pointer}
.panel .dep:hover{color:var(--accent)}
.panel .dep .mk{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted)}
.panel .flags{background:var(--flag-bg);border:1px solid color-mix(in srgb,var(--flag) 40%,transparent);
  color:var(--flag);border-radius:8px;padding:8px 10px}
.panel .flags .k{color:var(--flag)}
.panel a.plane{display:inline-block;margin-top:6px;color:var(--accent);text-decoration:none;font-size:13px}
.panel a.plane:hover{text-decoration:underline}
.panel .close{float:right;cursor:pointer;color:var(--muted);border:none;background:none;font-size:18px}
.foot{padding:6px 16px;color:var(--muted);font-size:11.5px;border-top:1px solid var(--line);background:var(--panel);text-align:center}
`;

const SCRIPT = `
const GROUPS=["backlog","unstarted","started","completed","cancelled","unknown"];
const el=id=>document.getElementById(id);
const cv=el("graph"), canvas=el("canvas"), ctx=cv.getContext("2d");

// --- Flatten the tree into nodes + parent/dependency edges --------------------
const NODES=[], byId=new Map();
(function flatten(list){for(const n of list){
  NODES.push(n); byId.set(n.id,n);
  if(n.children&&n.children.length)flatten(n.children);
}})(GRAPH.nodes);

const parentOf=new Map();
(function walk(list,parent){for(const n of list){
  if(parent)parentOf.set(n.id,parent.id);
  if(n.children&&n.children.length)walk(n.children,n);
}})(GRAPH.nodes,null);

// Edge list: parent (structural) + dependency (blocks/relates).
const EDGES=[];
for(const [child,par] of parentOf) EDGES.push({s:par,t:child,type:"parent"});
for(const e of (GRAPH.edges||[])) if(byId.has(e.source)&&byId.has(e.target)) EDGES.push({s:e.source,t:e.target,type:e.type});
// Adjacency for neighbour highlighting.
const adj=new Map(); for(const n of NODES) adj.set(n.id,new Set());
for(const e of EDGES){adj.get(e.s).add(e.t);adj.get(e.t).add(e.s);}

// --- Layout state (per-node physics) -----------------------------------------
const P=new Map();
(function seed(){const R=Math.max(200,Math.sqrt(NODES.length)*46);let i=0;
  for(const n of NODES){const a=i*2.399963; const r=R*Math.sqrt(i/NODES.length);
    P.set(n.id,{x:Math.cos(a)*r,y:Math.sin(a)*r,vx:0,vy:0,r:radius(n),pin:false}); i++;}
})();
function radius(n){return n.kind==="epic"?11:6;}

const state={statusOn:new Set(),labelOn:new Set(),flaggedOnly:false,q:"",selected:null,hover:null,
  view:{x:0,y:0,scale:1}};
let alpha=1;

// --- Force simulation ---------------------------------------------------------
// Tuned for hundreds of nodes: tight parent clusters (stories hug their epic),
// modest repulsion so it doesn't blow up into a sparse gas, firm gravity so the
// whole graph stays compact enough to read when fit to the viewport.
const REP=520, SPRING={parent:0.09,blocks:0.03,relates:0.02},
  REST={parent:30,blocks:110,relates:120}, GRAV=0.04, VDECAY=0.7, DECAY=0.012, AMIN=0.02;
function tick(){
  const arr=NODES; const n=arr.length;
  // repulsion is O(n^2) per tick — fine into the low thousands of nodes (a few
  // seconds of one-time settle on a ~700-node board; interactive after it cools).
  // A Barnes-Hut approximation would be the next step for much larger graphs.
  for(let i=0;i<n;i++){const a=P.get(arr[i].id);
    for(let j=i+1;j<n;j++){const b=P.get(arr[j].id);
      let dx=a.x-b.x, dy=a.y-b.y, d2=dx*dx+dy*dy; if(d2<0.01){dx=(Math.random()-0.5);dy=(Math.random()-0.5);d2=dx*dx+dy*dy+0.01;}
      const f=REP/d2, fx=dx*f, fy=dy*f;
      a.vx+=fx*alpha; a.vy+=fy*alpha; b.vx-=fx*alpha; b.vy-=fy*alpha;
    }}
  // springs
  for(const e of EDGES){const a=P.get(e.s), b=P.get(e.t);
    let dx=b.x-a.x, dy=b.y-a.y, d=Math.sqrt(dx*dx+dy*dy)||0.01;
    const k=SPRING[e.type], rest=REST[e.type], f=(d-rest)/d*k*alpha;
    const fx=dx*f, fy=dy*f; a.vx+=fx; a.vy+=fy; b.vx-=fx; b.vy-=fy;
  }
  // gravity to origin + integrate
  for(const nd of arr){const p=P.get(nd.id);
    p.vx-=p.x*GRAV*alpha; p.vy-=p.y*GRAV*alpha;
    // A pinned (dragged) node holds position AND discards accumulated force, so
    // releasing it doesn't fling it across the canvas.
    if(p.pin){p.vx=0;p.vy=0;continue;}
    p.vx*=VDECAY; p.vy*=VDECAY; p.x+=p.vx; p.y+=p.vy;
  }
  alpha*=(1-DECAY);
}
let raf=null;
function run(){ if(raf)return; const step=()=>{ if(alpha>AMIN){tick();} draw(); if(alpha>AMIN){raf=requestAnimationFrame(step);} else {raf=null;} }; raf=requestAnimationFrame(step); }
function reheat(a){ alpha=Math.max(alpha,a||0.7); run(); }

// --- Colours (read CSS vars so theme applies to the canvas) -------------------
let COL={};
function readColours(){const cs=getComputedStyle(document.documentElement);const g=k=>cs.getPropertyValue(k).trim();
  COL={ink:g("--ink"),muted:g("--muted"),card:g("--card"),cardLine:g("--card-line"),epic:g("--epic"),
    accent:g("--accent"),edge:g("--edge"),blocks:g("--blocks"),relates:g("--relates"),flag:g("--flag"),
    backlog:g("--g-backlog"),unstarted:g("--g-unstarted"),started:g("--g-started"),completed:g("--g-completed"),
    cancelled:g("--g-cancelled"),unknown:g("--g-unknown")};
}
function nodeColour(n){return COL[n.statusGroup]||COL.unknown;}

// --- Filters / focus ----------------------------------------------------------
function matches(n){
  if(state.statusOn.size&&!state.statusOn.has(n.statusGroup))return false;
  if(state.labelOn.size&&!n.labels.some(l=>state.labelOn.has(l)))return false;
  if(state.flaggedOnly&&!(n.quality&&!n.quality.ok))return false;
  if(state.q){const h=(n.title+" "+(n.identifier||"")).toLowerCase();if(!h.includes(state.q))return false;}
  return true;
}
function focusId(){return state.hover||state.selected;}
function dimmed(n){
  if(!matches(n))return true;
  const f=focusId();
  if(f&&f!==n.id&&!adj.get(f).has(n.id))return true;
  return false;
}

// --- Drawing ------------------------------------------------------------------
let dpr=1;
function resize(){dpr=window.devicePixelRatio||1;
  cv.width=canvas.clientWidth*dpr; cv.height=canvas.clientHeight*dpr; draw();}
function T(){const v=state.view; ctx.setTransform(v.scale*dpr,0,0,v.scale*dpr, v.x*dpr, v.y*dpr);}
function draw(){
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,cv.width,cv.height);
  T();
  const f=focusId();
  // edges
  ctx.lineWidth=1;
  for(const e of EDGES){const a=P.get(e.s), b=P.get(e.t);
    const involved=f&&(e.s===f||e.t===f);
    const faded=(dimmed(byId.get(e.s))||dimmed(byId.get(e.t)))&&!involved;
    ctx.globalAlpha=faded?0.06:(f&&!involved?0.15:(e.type==="parent"?0.5:0.9));
    ctx.beginPath();
    if(e.type==="relates"){ctx.setLineDash([4,4]);ctx.strokeStyle=COL.relates;ctx.lineWidth=involved?2:1.3;}
    else if(e.type==="blocks"){ctx.setLineDash([]);ctx.strokeStyle=COL.blocks;ctx.lineWidth=involved?2.2:1.5;}
    else{ctx.setLineDash([]);ctx.strokeStyle=COL.edge;ctx.lineWidth=involved?1.6:1;}
    ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
    if(e.type==="blocks"){arrow(a,b,P.get(e.t).r);}
  }
  ctx.setLineDash([]);ctx.globalAlpha=1;
  // nodes
  const showLabels=state.view.scale>1.15;
  for(const n of NODES){const p=P.get(n.id);const dim=dimmed(n);
    ctx.globalAlpha=dim?0.18:1;
    ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,6.283);
    ctx.fillStyle=nodeColour(n);ctx.fill();
    // ring: epic accent / flagged amber / selected accent
    const sel=state.selected===n.id;
    if(sel){ctx.lineWidth=2.5;ctx.strokeStyle=COL.accent;ctx.stroke();}
    else if(n.quality&&!n.quality.ok){ctx.lineWidth=2;ctx.strokeStyle=COL.flag;ctx.stroke();}
    else if(n.kind==="epic"){ctx.lineWidth=2;ctx.strokeStyle=COL.epic;ctx.stroke();}
    if((showLabels||sel||state.hover===n.id)&&!dim){
      ctx.globalAlpha=1;ctx.fillStyle=COL.ink;
      ctx.font=(n.kind==="epic"?"600 ":"")+ (11)+"px ui-sans-serif,system-ui,sans-serif";
      ctx.textAlign="left";ctx.textBaseline="middle";
      ctx.fillText(clip(n.title,34), p.x+p.r+4, p.y);
    }
  }
  ctx.globalAlpha=1;
  el("empty").hidden=NODES.some(matches);
}
function arrow(a,b,tr){let dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;dx/=d;dy/=d;
  const tx=b.x-dx*(tr+1.5), ty=b.y-dy*(tr+1.5), s=5;
  ctx.beginPath();ctx.moveTo(tx,ty);
  ctx.lineTo(tx-dx*s-dy*s*0.6, ty-dy*s+dx*s*0.6);
  ctx.lineTo(tx-dx*s+dy*s*0.6, ty-dy*s-dx*s*0.6);
  ctx.closePath();ctx.fillStyle=ctx.strokeStyle;ctx.fill();
}
function clip(s,n){return s.length>n?s.slice(0,n-1)+"…":s;}

// --- Hit testing + interaction ------------------------------------------------
function toWorld(mx,my){const v=state.view;return{x:(mx-v.x)/v.scale,y:(my-v.y)/v.scale};}
function nodeAt(mx,my){const w=toWorld(mx,my);let best=null,bd=1e9;
  for(const n of NODES){const p=P.get(n.id);const d=Math.hypot(p.x-w.x,p.y-w.y);
    const rr=p.r+6/state.view.scale; if(d<rr&&d<bd){bd=d;best=n;}}
  return best;}
function relMouse(e){const r=canvas.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}

let drag=null;
canvas.addEventListener("mousedown",e=>{const m=relMouse(e);const n=nodeAt(m.x,m.y);
  if(n){const p=P.get(n.id);drag={node:n,moved:false};p.pin=true;canvas.classList.add("grabbing");}
  else{drag={pan:true,x:e.clientX,y:e.clientY,vx:state.view.x,vy:state.view.y,moved:false};canvas.classList.add("grabbing");}
});
window.addEventListener("mousemove",e=>{
  if(drag){
    if(drag.pan){state.view.x=drag.vx+(e.clientX-drag.x);state.view.y=drag.vy+(e.clientY-drag.y);drag.moved=true;draw();}
    else{const m=relMouse(e);const w=toWorld(m.x,m.y);const p=P.get(drag.node.id);p.x=w.x;p.y=w.y;p.vx=0;p.vy=0;drag.moved=true;reheat(0.3);}
    return;
  }
  const m=relMouse(e);const n=nodeAt(m.x,m.y);const id=n?n.id:null;
  if(id!==state.hover){state.hover=id;canvas.style.cursor=id?"pointer":"grab";draw();}
});
window.addEventListener("mouseup",e=>{ if(!drag)return;
  const wasNode=drag.node, moved=drag.moved;
  if(wasNode){P.get(wasNode.id).pin=false; if(!moved)select(wasNode.id);}
  else if(!moved){ if(state.selected){state.selected=null;renderPanel();draw();} }
  drag=null;canvas.classList.remove("grabbing");
});
canvas.addEventListener("wheel",e=>{e.preventDefault();const m=relMouse(e);
  const f=e.deltaY<0?1.1:0.9,ns=Math.min(4,Math.max(0.15,state.view.scale*f));
  state.view.x=m.x-(m.x-state.view.x)*(ns/state.view.scale);
  state.view.y=m.y-(m.y-state.view.y)*(ns/state.view.scale);
  state.view.scale=ns;draw();},{passive:false});

function select(id){state.selected=id;renderPanel();draw();}

// --- Details panel ------------------------------------------------------------
function renderPanel(){const p=el("panel");const n=byId.get(state.selected);
  if(!n){p.hidden=true;return;} p.hidden=false;p.replaceChildren();
  const close=document.createElement("button");close.className="close";close.textContent="×";
  close.onclick=()=>{state.selected=null;renderPanel();draw();};p.appendChild(close);
  const h=document.createElement("h2");h.textContent=n.title;p.appendChild(h);
  if(n.identifier){const id=document.createElement("div");id.className="pid";
    id.textContent=n.identifier+" · "+(n.kind==="epic"?"Epic":"User story");p.appendChild(id);}
  p.appendChild(row("Status",n.status||"—"));
  if(n.assignee)p.appendChild(row("Assignee",n.assignee));
  if(n.labels.length){const r=rowEl("Labels");const t=document.createElement("div");t.className="tags";
    for(const l of n.labels){const s=document.createElement("span");s.className="tag";s.textContent=l;t.appendChild(s);}
    r.appendChild(t);p.appendChild(r);}
  // dependencies of this node
  const deps=depsOf(n.id);
  if(deps.length){const r=rowEl("Dependencies");
    for(const d of deps){const line=document.createElement("div");line.className="dep";
      const mk=document.createElement("span");mk.className="mk";mk.textContent=d.mark;line.appendChild(mk);
      const s=document.createElement("span");s.textContent=(d.node.identifier?d.node.identifier+" ":"")+d.node.title;line.appendChild(s);
      line.onclick=()=>{state.selected=d.node.id;focusOn(d.node.id);renderPanel();};
      r.appendChild(line);}
    p.appendChild(r);}
  if(n.quality&&!n.quality.ok){const r=document.createElement("div");r.className="row flags";
    const k=document.createElement("div");k.className="k";k.textContent="Spec check";r.appendChild(k);
    r.appendChild(document.createTextNode(n.quality.flags.join(" · ")));p.appendChild(r);}
  if(n.criteria&&n.criteria.length){const r=rowEl("Acceptance criteria ("+n.criteria.filter(c=>c.checked).length+"/"+n.criteria.length+")");
    const ul=document.createElement("ul");
    for(const c of n.criteria){const li=document.createElement("li");if(c.checked)li.className="done";
      const b=document.createElement("span");b.className="box";li.appendChild(b);
      const s=document.createElement("span");s.textContent=c.text;li.appendChild(s);ul.appendChild(li);}
    r.appendChild(ul);p.appendChild(r);}
  if(n.url){const a=document.createElement("a");a.className="plane";a.href=n.url;a.target="_blank";
    a.rel="noreferrer";a.textContent="Open in Plane →";p.appendChild(a);}
}
function depsOf(id){const out=[];
  for(const e of (GRAPH.edges||[])){if(!byId.has(e.source)||!byId.has(e.target))continue;
    if(e.type==="blocks"&&e.target===id)out.push({node:byId.get(e.source),mark:"⟶ blocked by"});
    else if(e.type==="blocks"&&e.source===id)out.push({node:byId.get(e.target),mark:"blocks ⟶"});
    else if(e.type==="relates"&&(e.source===id||e.target===id))out.push({node:byId.get(e.source===id?e.target:e.source),mark:"~ relates"});
  }
  return out;}
function focusOn(id){const p=P.get(id);if(!p)return;const v=state.view;
  v.x=canvas.clientWidth/2-p.x*v.scale; v.y=canvas.clientHeight/2-p.y*v.scale; draw();}
function rowEl(k){const r=document.createElement("div");r.className="row";const kk=document.createElement("div");
  kk.className="k";kk.textContent=k;r.appendChild(kk);return r;}
function row(k,v){const r=rowEl(k);r.appendChild(document.createTextNode(v));return r;}

// --- Filters ------------------------------------------------------------------
function buildFilters(){const f=el("filters");f.replaceChildren();
  for(const gname of GROUPS){if(!GRAPH.statuses.length&&gname==="unknown")continue;
    const c=chip(gname,()=>{tog(state.statusOn,gname);draw();buildFilters();},state.statusOn.has(gname));
    const sw=document.createElement("span");sw.className="sw";sw.style.background="var(--g-"+gname+")";
    c.prepend(sw);f.appendChild(c);}
  for(const l of GRAPH.labels){f.appendChild(chip(l,()=>{tog(state.labelOn,l);draw();buildFilters();},state.labelOn.has(l)));}
  if(GRAPH.counts.flagged){const c=chip("⚠ "+GRAPH.counts.flagged+" flagged",()=>{state.flaggedOnly=!state.flaggedOnly;draw();buildFilters();},state.flaggedOnly);
    c.classList.add("flag");f.appendChild(c);}
}
function chip(label,on,active){const b=document.createElement("span");b.className="chip"+(active?" on":"");
  b.append(document.createTextNode(label));b.onclick=on;return b;}
function tog(set,v){if(set.has(v))set.delete(v);else set.add(v);}

// --- Fit ----------------------------------------------------------------------
function fit(){let minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9;
  for(const n of NODES){const p=P.get(n.id);minx=Math.min(minx,p.x);miny=Math.min(miny,p.y);maxx=Math.max(maxx,p.x);maxy=Math.max(maxy,p.y);}
  if(minx>maxx){state.view={x:canvas.clientWidth/2,y:canvas.clientHeight/2,scale:1};draw();return;}
  const gw=(maxx-minx)+120, gh=(maxy-miny)+120, w=canvas.clientWidth, h=canvas.clientHeight;
  const s=Math.min(3,Math.min(w/gw,h/gh))||1;
  state.view.scale=s; state.view.x=w/2-((minx+maxx)/2)*s; state.view.y=h/2-((miny+maxy)/2)*s; draw();
}

// --- Legend + header ----------------------------------------------------------
el("legend").innerHTML=
  '<div class="row"><span class="ln"></span> blocks (arrow → blocked)</div>'+
  '<div class="row"><span class="ln rel"></span> relates to</div>'+
  '<div class="row"><span class="ln par"></span> epic → story</div>';
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
// WITHOUT a window resize. Observe the container so the bitmap always matches its
// box (otherwise a stale bitmap gets stretched -> elliptical nodes + hit-test drift).
if(window.ResizeObserver)new ResizeObserver(()=>resize()).observe(canvas);
readColours();resize();buildFilters();
// Settle the layout to (near) equilibrium, THEN fit once — fitting mid-motion
// framed a sprawling, still-expanding cloud.
const settle=()=>{ if(alpha>AMIN){tick();draw();requestAnimationFrame(settle);} else {fit();draw();} };
requestAnimationFrame(settle);
`;
