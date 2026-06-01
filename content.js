console.log("Popup loaded");

document.getElementById("draw").onclick = async () => {
  const file = document.getElementById("img").files[0];
  if (!file) { alert("Upload an image first"); return; }

  const reader = new FileReader();
  reader.onload = async function(e) {
    const img = new Image();
    img.src = e.target.result;
    img.onload = async () => {
      const W = img.naturalWidth, H = img.naturalHeight;
      const canvas = document.getElementById("hidden");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      canvas.width = W; canvas.height = H;

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0);

      // Threshold to pure B&W
      let px = ctx.getImageData(0, 0, W, H);
      for (let i = 0; i < px.data.length; i += 4) {
        const v = (px.data[i]+px.data[i+1]+px.data[i+2])/3 < 128 ? 0 : 255;
        px.data[i]=px.data[i+1]=px.data[i+2]=v; px.data[i+3]=255;
      }
      ctx.putImageData(px, 0, 0);

      // Auto-crop to dark pixel bounding box
      px = ctx.getImageData(0, 0, W, H);
      let minX=W,minY=H,maxX=0,maxY=0;
      for (let y=0;y<H;y++) for (let x=0;x<W;x++)
        if (px.data[(y*W+x)*4] < 128) {
          if(x<minX)minX=x; if(x>maxX)maxX=x;
          if(y<minY)minY=y; if(y>maxY)maxY=y;
        }
      const PAD=2;
      minX=Math.max(0,minX-PAD); minY=Math.max(0,minY-PAD);
      maxX=Math.min(W-1,maxX+PAD); maxY=Math.min(H-1,maxY+PAD);
      const GW=maxX-minX, GH=maxY-minY;
      console.log(`Image: ${W}x${H}, content: ${GW}x${GH}`);

      const tmp = document.createElement('canvas');
      tmp.width=GW; tmp.height=GH;
      const tctx = tmp.getContext('2d', { willReadFrequently: true });
      tctx.fillStyle="#ffffff"; tctx.fillRect(0,0,GW,GH);
      tctx.drawImage(canvas, minX,minY,GW,GH, 0,0,GW,GH);
      px = tctx.getImageData(0,0,GW,GH);
      for (let i=0;i<px.data.length;i+=4) {
        const v=(px.data[i]+px.data[i+1]+px.data[i+2])/3<128?0:255;
        px.data[i]=px.data[i+1]=px.data[i+2]=v; px.data[i+3]=255;
      }
      tctx.putImageData(px,0,0);

      // Build binary grid
      let grid = new Uint8Array(GW*GH);
      for (let i=0;i<GW*GH;i++) grid[i] = px.data[i*4]<128 ? 1 : 0;

      // --- Find connected components and classify as FILLED vs LINE ---
      // A region is "filled" if its area/perimeter^2 ratio is high (compact)
      // A region is a "line" if it's long and thin (low ratio)
      const labels = new Int32Array(GW*GH).fill(-1);
      const components = []; // [{pixels:[], perimeterPx, area}]

      // Flood fill to label components
      let nextLabel = 0;
      for (let sy=0;sy<GH;sy++) for (let sx=0;sx<GW;sx++) {
        if (!grid[sy*GW+sx] || labels[sy*GW+sx]>=0) continue;
        const label = nextLabel++;
        const pixels = [];
        const stack = [[sx,sy]];
        labels[sy*GW+sx] = label;
        while (stack.length) {
          const [cx,cy] = stack.pop();
          pixels.push([cx,cy]);
          for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) {
            if (!dx&&!dy) continue;
            const nx=cx+dx,ny=cy+dy;
            if (nx>=0&&nx<GW&&ny>=0&&ny<GH&&grid[ny*GW+nx]&&labels[ny*GW+nx]<0) {
              labels[ny*GW+nx]=label;
              stack.push([nx,ny]);
            }
          }
        }
        // Compute bounding box and estimate "thickness" via area vs bbox
        let bx0=GW,by0=GH,bx1=0,by1=0;
        for (const [x,y] of pixels) {
          if(x<bx0)bx0=x;if(x>bx1)bx1=x;
          if(y<by0)by0=y;if(y>by1)by1=y;
        }
        const bboxW=bx1-bx0+1, bboxH=by1-by0+1;
        const bboxArea=bboxW*bboxH;
        const fillRatio=pixels.length/bboxArea; // 1.0=solid rectangle, low=thin line
        const minDim=Math.min(bboxW,bboxH);
        // Classify: if min dimension > 8px AND fill ratio > 0.35 → filled shape
        const isFilled = minDim > 8 && fillRatio > 0.35;
        components.push({label, pixels, bx0,by0,bx1,by1, fillRatio, minDim, isFilled});
      }
      console.log(`Components: ${components.length}, filled: ${components.filter(c=>c.isFilled).length}`);

      // --- For LINE components: Zhang-Suen skeleton then chain-follow ---
      // --- For FILLED components: trace the outer contour ---

      // Zhang-Suen on a sub-grid
      function skeletonize(subgrid, w, h) {
        const g = new Uint8Array(subgrid);
        const G=(x,y)=>(x<0||x>=w||y<0||y>=h)?0:g[y*w+x];
        let changed=true;
        while(changed){
          changed=false;
          for(let pass=0;pass<2;pass++){
            const rem=[];
            for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++){
              if(!g[y*w+x]) continue;
              const p2=G(x,y-1),p3=G(x+1,y-1),p4=G(x+1,y),
                    p5=G(x+1,y+1),p6=G(x,y+1),p7=G(x-1,y+1),
                    p8=G(x-1,y),p9=G(x-1,y-1);
              const B=p2+p3+p4+p5+p6+p7+p8+p9;
              if(B<2||B>6) continue;
              const r=[p2,p3,p4,p5,p6,p7,p8,p9,p2];
              let A=0;for(let i=0;i<8;i++)if(r[i]===0&&r[i+1]===1)A++;
              if(A!==1) continue;
              if(pass===0){if(p2*p4*p6!==0||p4*p6*p8!==0)continue;}
              else{if(p2*p4*p8!==0||p2*p6*p8!==0)continue;}
              rem.push(y*w+x);
            }
            if(rem.length){changed=true;rem.forEach(i=>g[i]=0);}
          }
        }
        return g;
      }

      // Trace outer contour of a filled region (Moore neighborhood contour tracing)
      function traceContour(pixels, bx0, by0, bx1, by1) {
        const w=bx1-bx0+2, h=by1-by0+2;
        const mask=new Uint8Array(w*h);
        for(const [x,y] of pixels) mask[(y-by0+1)*w+(x-bx0+1)]=1;
        // Find topmost-leftmost pixel
        let sx=-1,sy=-1;
        outer: for(let y=0;y<h;y++) for(let x=0;x<w;x++)
          if(mask[y*w+x]){sx=x;sy=y;break outer;}
        if(sx<0) return [];
        // Moore neighborhood contour tracing (Jacob's stopping criterion)
        const dirs=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
        const contour=[];
        let cx=sx,cy=sy,startDir=6; // start looking left-up
        let prevX=sx,prevY=sy-1; // the "background" pixel we came from
        // find entry direction
        for(let d=0;d<8;d++){
          const [dx,dy]=dirs[d];
          if(!mask[(sy+dy)*w+(sx+dx)]){startDir=d;break;}
        }
        let dir=startDir;
        const maxSteps=pixels.length*4+8;
        for(let step=0;step<maxSteps;step++){
          contour.push([cx+bx0-1,cy+by0-1]);
          // find next boundary pixel: rotate CCW from (dir+6)%8
          let found=false;
          for(let i=0;i<8;i++){
            const nd=(dir+6+i)%8;
            const [dx,dy]=dirs[nd];
            const nx=cx+dx,ny=cy+dy;
            if(nx>=0&&nx<w&&ny>=0&&ny<h&&mask[ny*w+nx]){
              dir=(nd+4)%8; // backtrack direction
              if(nx===sx&&ny===sy&&step>1){found=true;break;}
              cx=nx;cy=ny;found=true;break;
            }
          }
          if(!found||( cx===sx&&cy===sy&&step>1)) break;
        }
        return contour;
      }

      // RDP simplification
      function rdp(pts, eps) {
        if(pts.length<=2) return pts;
        let maxD=0,maxI=0;
        const [x1,y1]=pts[0],[x2,y2]=pts[pts.length-1];
        const dx=x2-x1,dy=y2-y1,len=Math.sqrt(dx*dx+dy*dy);
        for(let i=1;i<pts.length-1;i++){
          const [px,py]=pts[i];
          const d=len===0?Math.sqrt((px-x1)**2+(py-y1)**2):Math.abs(dy*px-dx*py+x2*y1-y2*x1)/len;
          if(d>maxD){maxD=d;maxI=i;}
        }
        if(maxD>eps){
          const l=rdp(pts.slice(0,maxI+1),eps);
          const r=rdp(pts.slice(maxI),eps);
          return [...l.slice(0,-1),...r];
        }
        return [pts[0],pts[pts.length-1]];
      }

      // Chain-follow skeleton pixels into polylines
      function chainFollow(skelGrid, w, h) {
        const visited=new Uint8Array(w*h);
        const polylines=[];
        const nbrs=(x,y)=>{
          const n=[];
          for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
            if(!dx&&!dy) continue;
            const nx=x+dx,ny=y+dy;
            if(nx>=0&&nx<w&&ny>=0&&ny<h&&skelGrid[ny*w+nx]&&!visited[ny*w+nx])
              n.push([nx,ny]);
          }
          return n;
        };
        const walk=(sx,sy)=>{
          const pts=[[sx,sy]]; visited[sy*w+sx]=1;
          let cx=sx,cy=sy;
          while(true){
            const nb=nbrs(cx,cy);
            if(!nb.length) break;
            let best=nb[0],bestScore=-Infinity;
            if(pts.length>=2&&nb.length>1){
              const [px,py]=pts[pts.length-2];
              const ddx=cx-px,ddy=cy-py;
              for(const [nx,ny] of nb){
                const s=(nx-cx)*ddx+(ny-cy)*ddy;
                if(s>bestScore){bestScore=s;best=[nx,ny];}
              }
            }
            const [nx,ny]=best;
            visited[ny*w+nx]=1; pts.push([nx,ny]);
            cx=nx;cy=ny;
          }
          return pts;
        };
        // endpoints first
        for(let y=0;y<h;y++) for(let x=0;x<w;x++){
          if(!skelGrid[y*w+x]||visited[y*w+x]) continue;
          let deg=0;
          for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
            if(!dx&&!dy)continue;
            const nx=x+dx,ny=y+dy;
            if(nx>=0&&nx<w&&ny>=0&&ny<h&&skelGrid[ny*w+nx])deg++;
          }
          if(deg<=1){const c=walk(x,y);if(c.length>=2)polylines.push(rdp(c,1.5));}
        }
        for(let y=0;y<h;y++) for(let x=0;x<w;x++){
          if(!skelGrid[y*w+x]||visited[y*w+x]) continue;
          const c=walk(x,y);if(c.length>=2)polylines.push(rdp(c,1.5));
        }
        return polylines;
      }

      const allPolylines = [];

      for (const comp of components) {
        if (comp.pixels.length < 4) continue; // skip noise

        if (comp.isFilled) {
          // Trace outer contour and simplify
          const contour = traceContour(comp.pixels, comp.bx0, comp.by0, comp.bx1, comp.by1);
          if (contour.length >= 2) {
            const simplified = rdp(contour, 1.5);
            // Close the shape
            if (simplified.length >= 2) {
              simplified.push(simplified[0]);
              allPolylines.push(simplified);
            }
          }
        } else {
          // Skeletonize and chain-follow
          const w=comp.bx1-comp.bx0+1, h=comp.by1-comp.by0+1;
          const sub=new Uint8Array(w*h);
          for(const [x,y] of comp.pixels) sub[(y-comp.by0)*w+(x-comp.bx0)]=1;
          const skel=skeletonize(sub,w,h);
          const chains=chainFollow(skel,w,h);
          for(const chain of chains){
            // Offset back to global coords
            allPolylines.push(chain.map(([x,y])=>[x+comp.bx0,y+comp.by0]));
          }
        }
      }

      console.log(`Total polylines: ${allPolylines.length}`);
      if(!allPolylines.length){alert("No lines found.");return;}

      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
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
      await chrome.scripting.executeScript({
        target:{tabId:tab.id},world:"MAIN",
        func:drawOnPage,args:[allPolylines,GW,GH]
      });
    };
  };
  reader.readAsDataURL(file);
};

async function drawOnPage(polylines, GW, GH) {
  console.log("[AutoDraw] polylines:",polylines.length,"grid:",GW,GH);
  const canvas=document.querySelector('[data-testid="card-studio-customizations"]');
  if(!canvas){alert("Canvas not found.");return;}

  const bg=document.querySelector('[data-testid="card-background"]');
  let cL,cT,cW,cH;
  if(bg){const r=bg.getBoundingClientRect();cL=r.left;cT=r.top;cW=r.width;cH=r.height;}
  else{
    const r=canvas.getBoundingClientRect(),RAT=1202/754;
    if(r.width/r.height>RAT){cH=r.height;cW=cH*RAT;cL=r.left+(r.width-cW)/2;cT=r.top;}
    else{cW=r.width;cH=cW/RAT;cL=r.left;cT=r.top+(r.height-cH)/2;}
  }

  const S=Math.min(cW/GW,cH/GH);
  const offX=(cW-GW*S)/2, offY=(cH-GH*S)/2;
  console.log(`[AutoDraw] card:${cW.toFixed(0)}x${cH.toFixed(0)} S:${S.toFixed(3)}`);

  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const mkP=(type,x,y,buttons)=>new PointerEvent(type,{
    bubbles:true,cancelable:true,composed:true,
    pointerId:1,pointerType:"mouse",isPrimary:true,
    buttons,button:type==="pointerup"?0:(buttons>0?0:-1),
    pressure:buttons>0?0.5:0,
    clientX:x,clientY:y,screenX:x,screenY:y,
    movementX:0,movementY:0,view:window,
  });
  const tx=x=>cL+offX+x*S, ty=y=>cT+offY+y*S;

  let drawn=0;
  for(const line of polylines){
    if(line.length<2) continue;
    canvas.dispatchEvent(mkP("pointerdown",tx(line[0][0]),ty(line[0][1]),1));
    await sleep(30);
    for(const [x,y] of line){
      document.body.dispatchEvent(mkP("pointermove",tx(x),ty(y),1));
      await sleep(20);
    }
    const last=line[line.length-1];
    document.body.dispatchEvent(mkP("pointerup",tx(last[0]),ty(last[1]),0));
    await sleep(60);
    drawn++;
  }
  console.log("[AutoDraw] Done. Strokes:",drawn);
  alert(`Done! ${drawn} strokes.`);
}