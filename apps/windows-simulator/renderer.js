(() => {
  const $ = (id) => document.getElementById(id);
  const protocols = ["KNX","DALI","Matter","Casambi","MQTT","Modbus","AVR","Zigbee","Lutron","Media"];
  const types = ["light","dimmer","cct","rgb","blind","climate","sensor","switch","media","camera"];
  const roomNames = ["Entrance","Living Room","Dining","Kitchen","Family Lounge","Home Theatre","Master Bedroom","Master Bathroom","Bedroom 2","Bedroom 3","Guest Bedroom","Study","Gym","Terrace","Garage","Pool","Corridor","Utility","Garden","Security"];
  let devices = [], events = [], running = false, chaos = false, ticks = 0, timer = null;
  const faults = { latency:0, loss:0, offline:0, gateway:false, duplicates:false, reorder:false, malformed:false };

  const rand = (a,b) => Math.floor(Math.random()*(b-a+1))+a;
  const pick = (a) => a[Math.floor(Math.random()*a.length)];

  function makeDevice(i) {
    const type=pick(types), room=roomNames[i%roomNames.length], protocol=pick(protocols);
    const state={};
    if(["light","dimmer","cct","rgb","switch","media"].includes(type)) state.on=false;
    if(["dimmer","cct","rgb"].includes(type)) state.brightness=0;
    if(type==="cct") state.kelvin=2700;
    if(type==="rgb") state.hue=rand(0,359);
    if(type==="blind") state.position=0;
    if(["climate","sensor"].includes(type)) state.value=rand(18,30);
    return {id:`sim-${String(i+1).padStart(5,"0")}`,name:`${room} ${type.toUpperCase()} ${Math.ceil((i+1)/roomNames.length)}`,room,type,protocol,state,online:true};
  }

  function generate() {
    stop();
    const n=Math.min(5000,Math.max(10,Number($("deviceCount").value)||500));
    devices=Array.from({length:n},(_,i)=>makeDevice(i));
    $("residenceLabel").textContent=`Supreme Residence · ${n.toLocaleString()} virtual devices`;
    render(); log("SYSTEM",`Generated ${n} virtual devices across ${roomNames.length} rooms`);
  }

  function log(kind,msg) {
    events.unshift({time:new Date().toLocaleTimeString(),kind,msg});
    if(events.length>400) events.length=400;
    $("events").innerHTML=events.slice(0,160).map(e=>`<div class="event"><span class="time">${e.time}</span> <span class="kind">${e.kind}</span> ${e.msg}</div>`).join("");
    $("eventSummary").textContent=`${events.length} events · ${ticks.toLocaleString()} simulation ticks`;
  }

  function allowed(d) {
    if(!d.online) return false;
    if(Math.random()*100<faults.offline){d.online=false;return false;}
    if(Math.random()*100<faults.loss) return false;
    return true;
  }

  function mutate(d) {
    if(!allowed(d)) return;
    if(faults.latency) setTimeout(()=>mutateState(d),faults.latency); else mutateState(d);
  }

  function mutateState(d) {
    if(faults.malformed && Math.random()<0.01){log("FAULT",`${d.id} produced malformed state`);return;}
    const s=d.state;
    if(["light","dimmer","cct","rgb","switch","media"].includes(d.type)) s.on=Math.random()>.45;
    if(["dimmer","cct","rgb"].includes(d.type)) s.brightness=rand(0,100);
    if(d.type==="cct") s.kelvin=rand(2700,6500);
    if(d.type==="rgb") s.hue=rand(0,359);
    if(d.type==="blind") s.position=rand(0,100);
    if(["climate","sensor"].includes(d.type)) s.value=rand(18,30);
    log(d.protocol,d.id+` → ${d.type} state changed`);
    if(faults.duplicates) log("FAULT",`${d.id} duplicate event`);
  }

  function tick() {
    if(!running||!devices.length) return;
    const rate=Math.min(1000,Math.max(1,Number($("eventRate").value)||50));
    for(let i=0;i<Math.max(1,Math.ceil(rate/10));i++) mutate(pick(devices));
    ticks++;
    if(ticks%10===0) render();
  }

  function start(){if(!devices.length)generate();running=true;clearInterval(timer);timer=setInterval(tick,100);$("runBtn").textContent="Stop Stress Test";log("TEST","Stress test started");}
  function stop(){running=false;clearInterval(timer);timer=null;$("runBtn").textContent="Run Stress Test";}

  function render() {
    const total=devices.length, online=devices.filter(d=>d.online).length, on=devices.filter(d=>d.state.on===true).length;
    $("stats").innerHTML=[["Devices",total],["Online",online],["Lights ON",on],["Events",events.length],["Rate/s",Number($("eventRate").value)||50],["Faults",Object.values(faults).filter(Boolean).length]].map(x=>`<div class="stat"><small>${x[0]}</small><strong>${Number(x[1]).toLocaleString()}</strong></div>`).join("");
    $("rooms").innerHTML=roomNames.map(r=>{const ds=devices.filter(d=>d.room===r),ons=ds.filter(d=>d.state.on).length;return `<div class="room"><strong>${r}</strong><small>${ds.length} devices · ${ons} active</small><div class="meter"><i style="width:${ds.length?Math.round(ons/ds.length*100):0}%"></i></div></div>`;}).join("");
    $("protocols").innerHTML=protocols.map(p=>{const n=devices.filter(d=>d.protocol===p).length;return `<div class="protocol"><span>${p}</span><span class="ok">${n} virtual</span></div>`;}).join("");
  }

  function scenario(name,fn,desc){
    const b=document.createElement("div"); b.className="scenario";
    b.innerHTML=`<div><span>${name}</span><small>${desc}</small></div><button>Run</button>`;
    b.querySelector("button").onclick=()=>{fn();log("SCENARIO",name+" completed");};
    $("scenarios").appendChild(b);
  }

  $("generateBtn").onclick=generate;
  $("runBtn").onclick=()=>running?stop():start();
  $("chaosBtn").onclick=()=>{
    chaos=!chaos; $("chaosBtn").textContent="Chaos: "+(chaos?"ON":"OFF");
    faults.loss=chaos?5:0; faults.latency=chaos?250:0;
    $("loss").value=faults.loss; $("latency").value=faults.latency;
    $("lossValue").textContent=faults.loss+"%"; $("latencyValue").textContent=faults.latency+" ms";
    log("CHAOS",chaos?"Baseline chaos profile enabled":"Baseline chaos profile disabled"); render();
  };
  $("clearEvents").onclick=()=>{events=[];render();};
  [["latency","latencyValue"," ms"],["loss","lossValue","%"],["offline","offlineValue","%"]].forEach(([a,b,s])=>$(a).oninput=()=>{faults[a]=Number($(a).value);$(b).textContent=$(a).value+s;render();});
  document.querySelectorAll("[data-fault]").forEach(b=>b.onclick=()=>{
    const k=b.dataset.fault; faults[k]=!faults[k]; b.textContent=(faults[k]?"Disable ":"Enable ")+k.replace(/^./,x=>x.toUpperCase()); render(); log("FAULT",k+" injection "+(faults[k]?"enabled":"disabled"));
  });

  $("healthBtn").onclick=async()=>{
    try{const r=await window.supremeSimulator.gatewayRequest({url:$("gatewayUrl").value.replace(/\/$/,"")+"/healthz",token:$("gatewayToken").value});$("gatewayResult").textContent=JSON.stringify(r,null,2);log("GATEWAY","Health check "+r.status);}
    catch(e){$("gatewayResult").textContent=e.message;log("GATEWAY","Health check failed");}
  };

  $("snapshotBtn").onclick=async()=>{
    try{const r=await window.supremeSimulator.gatewayRequest({url:$("gatewayUrl").value.replace(/\/$/,"")+"/v1/simulation/import",method:"POST",token:$("gatewayToken").value,body:{source:"supreme-windows-simulator",devices}});$("gatewayResult").textContent=JSON.stringify(r,null,2);log("GATEWAY","Snapshot sent: "+r.status);}
    catch(e){$("gatewayResult").textContent=e.message;log("GATEWAY","Snapshot failed");}
  };

  scenario("1000-device burst",()=>{devices.forEach(d=>mutateState(d));},"Change every virtual device once.");
  scenario("All ON / All OFF",()=>{devices.forEach(d=>{if(d.state.on!==undefined)d.state.on=true;});render();setTimeout(()=>{devices.forEach(d=>{if(d.state.on!==undefined)d.state.on=false;});render();},300);},"Exercise bulk state convergence.");
  scenario("Gateway outage",()=>{faults.gateway=true;log("FAULT","Gateway marked offline");setTimeout(()=>{faults.gateway=false;log("RECOVERY","Gateway restored");},2000);},"Simulate a 2-second gateway outage.");
  scenario("Reconnect storm",()=>{devices.slice(0,Math.min(500,devices.length)).forEach(d=>{d.online=false;setTimeout(()=>d.online=true,rand(50,1000));});},"500-device randomized reconnect storm.");
  scenario("Invalid feedback",()=>{faults.malformed=true;setTimeout(()=>faults.malformed=false,1500);},"Inject malformed values for 1.5 seconds.");
  generate();
})();