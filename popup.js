console.log("Popup loaded");

// Stored polylines + grid info for deferred drawing
let _pendingDraw = null;

// ── CONVERT & PREVIEW ──────────────────────────────────────────────────────
document.getElementById("draw").onclick = async () => {
  const file = document.getElementById("img").files[0];
  if (!file) { alert("Upload an image first"); return; }

  const drawBtn = document.getElementById("draw");
  drawBtn.disabled = true;
  drawBtn.textContent = "Processing…";

  const reader = new FileReader();
  reader.onload = async function(e) {
    const img = new Image();
    img.src = e.target.result;
    img.onload = async () => {
      const [tab] = await chrome.tabs.query({active:true,currentWindow:true});

      const [{result: cardRect}] = await chrome.scripting.executeScript({
        target:{tabId:tab.id}, world:"MAIN",
        func:() => {
          const bg = document.querySelector('[data-testid="card-background"]');
          if (bg) { const r=bg.getBoundingClientRect(); return {w:r.width,h:r.height}; }
          return null;
        }
      });

      if (!cardRect) {
        alert("Card not found. Are you on the Draw step?");
        drawBtn.disabled = false;
        drawBtn.textContent = "Convert & Preview →";
        return;
      }

      const CW = Math.round(cardRect.w);
      const CH = Math.round(cardRect.h);
      const S  = Math.min(CW / img.naturalWidth, CH / img.naturalHeight);
      const GW = Math.round(img.naturalWidth * S);
      const GH = Math.round(img.naturalHeight * S);

      const canvas = document.getElementById("hidden");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      canvas.width = GW; canvas.height = GH;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, GW, GH);
      ctx.drawImage(img, 0, 0, GW, GH);

      // Threshold to B&W
      let px = ctx.getImageData(0, 0, GW, GH);
      for (let i = 0; i < px.data.length; i += 4) {
        const v = (px.data[i]+px.data[i+1]+px.data[i+2])/3 < 128 ? 0 : 255;
        px.data[i]=px.data[i+1]=px.data[i+2]=v; px.data[i+3]=255;
      }
      ctx.putImageData(px, 0, 0);

      // Auto-crop
      let minX=GW,minY=GH,maxX=0,maxY=0;
      for (let y=0;y<GH;y++) for (let x=0;x<GW;x++)
        if (px.data[(y*GW+x)*4] < 128) {
          if(x<minX)minX=x; if(x>maxX)maxX=x;
          if(y<minY)minY=y; if(y>maxY)maxY=y;
        }
      const PAD=1;
      minX=Math.max(0,minX-PAD); minY=Math.max(0,minY-PAD);
      maxX=Math.min(GW-1,maxX+PAD); maxY=Math.min(GH-1,maxY+PAD);
      const FW=maxX-minX, FH=maxY-minY;

      // Crop canvas
      const tmp=document.createElement('canvas');
      tmp.width=FW; tmp.height=FH;
      const tctx=tmp.getContext('2d',{willReadFrequently:true});
      tctx.fillStyle="#ffffff"; tctx.fillRect(0,0,FW,FH);
      tctx.drawImage(canvas,minX,minY,FW,FH,0,0,FW,FH);
      px=tctx.getImageData(0,0,FW,FH);
      for (let i=0;i<px.data.length;i+=4) {
        const v=(px.data[i]+px.data[i+1]+px.data[i+2])/3<128?0:255;
        px.data[i]=px.data[i+1]=px.data[i+2]=v; px.data[i+3]=255;
      }
      tctx.putImageData(px,0,0);

      // Build grid
      const grid=new Uint8Array(FW*FH);
      for (let i=0;i<FW*FH;i++) grid[i]=px.data[i*4]<128?1:0;

      // Distance transform
      const dist=new Float32Array(FW*FH);
      for (let i=0;i<FW*FH;i++) dist[i]=grid[i]?999:0;
      for (let y=1;y<FH-1;y++) for (let x=1;x<FW-1;x++) {
        if(!grid[y*FW+x]) continue;
        dist[y*FW+x]=Math.min(dist[y*FW+x],dist[(y-1)*FW+x]+1,dist[y*FW+(x-1)]+1,dist[(y-1)*FW+(x-1)]+1.414,dist[(y-1)*FW+(x+1)]+1.414);
      }
      for (let y=FH-2;y>0;y--) for (let x=FW-2;x>0;x--) {
        if(!grid[y*FW+x]) continue;
        dist[y*FW+x]=Math.min(dist[y*FW+x],dist[(y+1)*FW+x]+1,dist[y*FW+(x+1)]+1,dist[(y+1)*FW+(x-1)]+1.414,dist[(y+1)*FW+(x+1)]+1.414);
      }
      let maxDist=0;
      for (let i=0;i<FW*FH;i++) if(dist[i]<999&&dist[i]>maxDist) maxDist=dist[i];
      maxDist=Math.max(1,maxDist);

      // Build polylines (horizontal runs + vertical fallback)
      const polylines=[];
      const coveredH=new Uint8Array(FW*FH);
      for (let y=0;y<FH;y++) {
        let inRun=false,runStart=0,distSum=0;
        for (let x=0;x<=FW;x++) {
          const on=x<FW&&grid[y*FW+x];
          if(on&&!inRun){inRun=true;runStart=x;distSum=0;}
          else if(on&&inRun){distSum+=dist[y*FW+x];}
          else if(!on&&inRun){
            inRun=false;
            const len=x-runStart;
            const avgDist=distSum/Math.max(1,len);
            const pressure=Math.min(1.0,Math.max(0.05,avgDist/maxDist));
            polylines.push({pts:[[runStart,y],[x-1,y]],pressure});
            for(let fx=runStart;fx<=x-1;fx++) coveredH[y*FW+fx]=1;
          }
        }
      }
      for (let x=0;x<FW;x++) {
        let inRun=false,runStart=0,distSum=0;
        for (let y=0;y<=FH;y++) {
          const on=y<FH&&grid[y*FW+x]&&!coveredH[y*FW+x];
          if(on&&!inRun){inRun=true;runStart=y;distSum=0;}
          else if(on&&inRun){distSum+=dist[y*FW+x];}
          else if(!on&&inRun){
            inRun=false;
            const len=y-runStart;
            const avgDist=distSum/Math.max(1,len);
            const pressure=Math.min(1.0,Math.max(0.05,avgDist/maxDist));
            polylines.push({pts:[[x,runStart],[x,y-1]],pressure});
          }
        }
      }

      console.log(`Card:${CW}x${CH} Grid:${FW}x${FH} Strokes:${polylines.length}`);

      // ── RENDER PREVIEW ────────────────────────────────────────────────────
      const previewCanvas = document.getElementById("preview-canvas");
      const PREVIEW_W = 264; // fits 300px popup with 18px padding each side
      const scale = PREVIEW_W / FW;
      const PREVIEW_H = Math.round(FH * scale);
      previewCanvas.width  = FW;
      previewCanvas.height = FH;
      previewCanvas.style.width  = PREVIEW_W + "px";
      previewCanvas.style.height = PREVIEW_H + "px";

      const pctx = previewCanvas.getContext("2d");
      pctx.fillStyle = "#111111";
      pctx.fillRect(0, 0, FW, FH);

      for (const stroke of polylines) {
        const pts = stroke.pts;
        const pressure = stroke.pressure;
        // Map pressure → stroke width (thin lines are hairline, thick fills are wider)
        const lineWidth = Math.max(0.5, pressure * 3);
        // Map pressure → green alpha (thick = bright green, thin = dimmer)
        const alpha = 0.35 + pressure * 0.65;
        pctx.strokeStyle = `rgba(0, 229, 160, ${alpha})`;
        pctx.lineWidth = lineWidth;
        pctx.lineCap = "round";
        pctx.lineJoin = "round";
        pctx.beginPath();
        pctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) pctx.lineTo(pts[i][0], pts[i][1]);
        pctx.stroke();
      }

      // Show preview panel
      document.getElementById("stroke-count-num").textContent = polylines.length.toLocaleString();
      document.getElementById("preview-panel").style.display = "block";
      drawBtn.textContent = "Convert & Preview →";
      drawBtn.disabled = false;

      // Store for confirm step
      _pendingDraw = { polylines, FW, FH, cardRect };
    };
  };
  reader.readAsDataURL(file);
};

// ── CONFIRM & DRAW ─────────────────────────────────────────────────────────
document.getElementById("confirm-draw").onclick = async () => {
  if (!_pendingDraw) return;
  const { polylines, FW, FH, cardRect } = _pendingDraw;

  const confirmBtn = document.getElementById("confirm-draw");
  const drawBtn    = document.getElementById("draw");
  confirmBtn.disabled = true;
  drawBtn.disabled = true;

  // Show progress panel
  const total = polylines.length;
  document.getElementById("prog-total").textContent = total;
  document.getElementById("prog-done").textContent  = "0";
  document.getElementById("prog-left").textContent  = total;
  document.getElementById("progress-pct").textContent = "0%";
  document.getElementById("progress-bar").style.width = "0%";
  document.getElementById("progress-panel").style.display = "block";

  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});

  await chrome.scripting.executeScript({
    target:{tabId:tab.id},world:"MAIN",
    func:()=>{
      if(!PointerEvent.prototype._adPatched){
        const orig=PointerEvent.prototype.getCoalescedEvents;
        PointerEvent.prototype.getCoalescedEvents=function(){
          try{const r=orig?orig.call(this):[];return r&&r.length>0?r:[this];}catch(e){return[this];}
        };
        PointerEvent.prototype._adPatched=true;
      }
    }
  });

  // We draw in batches and poll back progress via a shared global on the page
  await chrome.scripting.executeScript({
    target:{tabId:tab.id},world:"MAIN",
    func:()=>{ window.__adProgress={done:0,total:0,running:true}; }
  });

  // Kick off drawing (non-blocking — returns immediately)
  chrome.scripting.executeScript({
    target:{tabId:tab.id},world:"MAIN",
    func:drawOnPage,args:[polylines,FW,FH,cardRect]
  });

  // Poll progress every 200ms
  const poll = setInterval(async () => {
    let prog;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target:{tabId:tab.id},world:"MAIN",
        func:()=>window.__adProgress||null
      });
      prog = result;
    } catch(_) { clearInterval(poll); return; }

    if (!prog) return;
    const done = prog.done;
    const pct  = total > 0 ? Math.round((done / total) * 100) : 0;

    document.getElementById("progress-bar").style.width = pct + "%";
    document.getElementById("progress-pct").textContent = pct + "%";
    document.getElementById("prog-done").textContent    = done;
    document.getElementById("prog-left").textContent    = Math.max(0, total - done);

    if (!prog.running) {
      clearInterval(poll);
      document.getElementById("progress-bar").style.width = "100%";
      document.getElementById("progress-pct").textContent = "100%";
      document.getElementById("prog-done").textContent    = total;
      document.getElementById("prog-left").textContent    = "0";
      document.getElementById("progress-panel").querySelector(".progress-label::before");

      // Stop pulse on the dot by swapping class
      const label = document.getElementById("progress-panel").querySelector(".progress-label");
      if (label) label.style.setProperty("--pulse", "none");

      confirmBtn.disabled = false;
      drawBtn.disabled    = false;
    }
  }, 200);
};

// ── DRAW ON PAGE (injected) ────────────────────────────────────────────────
async function drawOnPage(polylines, FW, FH, cardRect) {
  console.log("[AutoDraw] strokes:",polylines.length,"grid:",FW,FH);
  const canvas=document.querySelector('[data-testid="card-studio-customizations"]');
  if(!canvas){alert("Canvas not found.");return;}

  const bg=document.querySelector('[data-testid="card-background"]');
  if(!bg){alert("Card background not found.");return;}
  const r=bg.getBoundingClientRect();
  const cL=r.left, cT=r.top, cW=r.width, cH=r.height;

  const S=Math.min(cW/FW, cH/FH);
  const offX=(cW-FW*S)/2;
  const offY=(cH-FH*S)/2;
  console.log(`[AutoDraw] S:${S.toFixed(3)} off:(${offX.toFixed(1)},${offY.toFixed(1)})`);

  if(!window.__adProgress) window.__adProgress={done:0,total:polylines.length,running:true};
  window.__adProgress.total   = polylines.length;
  window.__adProgress.running = true;
  window.__adProgress.done    = 0;

  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const mkP=(type,x,y,buttons,pressure)=>new PointerEvent(type,{
    bubbles:true,cancelable:true,composed:true,
    pointerId:1,pointerType:"pen",isPrimary:true,
    buttons,button:0,
    pressure:pressure??0,
    clientX:x,clientY:y,screenX:x,screenY:y,movementX:0,movementY:0,view:window,
  });
  const tx=x=>cL+offX+x*S;
  const ty=y=>cT+offY+y*S;

  let drawn=0;
  for(const stroke of polylines){
    const pts = stroke.pts ?? stroke;
    const pressure = stroke.pressure ?? 0.5;
    if(pts.length<2) continue;
    const [x0,y0]=pts[0],[xe,ye]=pts[pts.length-1];
    canvas.dispatchEvent(mkP("pointerdown",tx(x0),ty(y0),1,pressure));
    await sleep(30);
    for(const [x,y] of pts){
      document.body.dispatchEvent(mkP("pointermove",tx(x),ty(y),1,pressure));
      await sleep(20);
    }
    document.body.dispatchEvent(mkP("pointerup",tx(xe),ty(ye),0,0));
    await sleep(60);
    drawn++;
    window.__adProgress.done = drawn;
  }
  window.__adProgress.running = false;
  console.log("[AutoDraw] Done. Strokes:",drawn);
}