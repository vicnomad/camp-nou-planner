"use client";

import { useState, useCallback, useMemo, useEffect, useRef, type MutableRefObject } from "react";
import { db } from "@/lib/firebase";
import { doc, setDoc, getDoc } from "firebase/firestore";
import type { Department, Employee, SolveResult, ScheduleEntry, CoverageSlot, DayKey, StoreHours } from "@/lib/types";
import { DAYS_KEYS, DAY_LABELS, DAY_SHORT } from "@/lib/types";
import { weekLabel, shiftWeek, weekIsoId } from "@/lib/week";
import { printA3 } from "@/lib/printA3";
import type { WeekOverride } from "@/app/page";

const SOLVER_URL = process.env.NEXT_PUBLIC_SOLVER_URL || "https://camp-nou-engine.vercel.app";

interface WeekEvent { type: "match" | "inventory"; close?: string; extra?: { from: string; to: string; min: number; max: number }; }

interface Props {
  department: Department; employees: Employee[]; allEmployees: Employee[];
  weekOverrides: Record<string, WeekOverride>;
  schedule: SolveResult | null; onSchedule: (r: SolveResult | null) => void;
  showToast: (msg: string) => void; generateRef: MutableRefObject<(() => void) | null>;
  weekMonday: string; onWeekChange: (m: string) => void;
}

function hh(m: number) { const x=((m%1440)+1440)%1440; return String(Math.floor(x/60)).padStart(2,"0")+":"+String(x%60).padStart(2,"0"); }
function tm(t: string) { const [h,m]=t.split(":").map(Number); return h*60+m; }
function initials(name: string) { return name.split(",")[0].slice(0,2).toUpperCase(); }

export default function GridView({ department, employees, allEmployees, weekOverrides, schedule, onSchedule, showToast, generateRef, weekMonday, onWeekChange }: Props) {
  const [mode, setMode] = useState<"dia"|"semana">("dia");
  const [dayIdx, setDayIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selectedEmp, setSelectedEmp] = useState<string>("");
  const [events, setEvents] = useState<Record<string, WeekEvent>>({});
  const [eventModal, setEventModal] = useState<{day:DayKey;event:WeekEvent}|null>(null);
  const [editedSchedule, setEditedSchedule] = useState<SolveResult|null>(null);

  const params = department.params;
  const color = department.color;
  const displaySchedule = editedSchedule ?? schedule;

  const weekDocId = `${department.id}_${weekIsoId(weekMonday)}`;

  // Load week events
  useEffect(() => {
    getDoc(doc(db,"weeks",weekDocId)).then(s => { if(s.exists()) setEvents(s.data().events??{}); else setEvents({}); });
  }, [weekDocId]);

  useEffect(() => { setEditedSchedule(null); }, [schedule]);

  const mergedStoreHours = useMemo(() => {
    const m: Record<string,StoreHours> = {};
    for (const d of DAYS_KEYS) {
      m[d] = { ...params.store_hours[d] };
      const ev = events[d];
      if (ev?.type==="match") { m[d].special="match"; if(ev.close) m[d].close=ev.close; }
      else if (ev?.type==="inventory") { m[d].special="inventory"; if(ev.extra) m[d].extra=ev.extra; }
      else { delete m[d].special; delete m[d].extra; }
    }
    return m;
  }, [params.store_hours, events]);

  async function saveEvents(ne: Record<string,WeekEvent>) { setEvents(ne); await setDoc(doc(db,"weeks",weekDocId),{events:ne},{merge:true}); }
  function addEvent(day:DayKey,ev:WeekEvent) { saveEvents({...events,[day]:ev}); setEventModal(null); showToast(`Evento añadido al ${DAY_LABELS[day]}`); }
  function removeEvent(day:DayKey) { const n={...events}; delete n[day]; saveEvents(n); setEventModal(null); }

  const handleGenerate = useCallback(async () => {
    if (editedSchedule && !confirm("Se descartarán los ajustes manuales. ¿Continuar?")) return;
    setLoading(true);
    try {
      const solverEmps = employees.map(emp => {
        const abs = (emp.absences??[]).filter(a=>Array.isArray(a.days)&&a.days.length>0);
        return { id:emp.id, name:emp.name, weekly_hours:emp.weekly_hours, availability:emp.availability,
          ...(emp.fixed?{fixed:emp.fixed}:{}), ...(abs.length>0?{absences:abs}:{}) };
      });
      // Build solver params based on demand mode
      const mode2 = params.demand_mode ?? "billing";
      const solverParams: Record<string, unknown> = { ...params, store_hours: mergedStoreHours };

      if (mode2 === "billing") {
        // Apply billing_pct to store billing → dept billing
        const pct = (params.billing_pct ?? 100) / 100;
        const deptDaily: Record<string, number> = {};
        for (const d of DAYS_KEYS) deptDaily[d] = Math.round((params.billing?.daily?.[d] ?? 0) * pct);
        solverParams.billing = { ...params.billing, daily: deptDaily };
      } else if (mode2 === "cajas") {
        // Cajas: compute demand_curve from billing × profile / ticket / clients_per_cash
        const ticket = params.ticket_medio ?? 25;
        const cpcH = params.clients_per_cash_hour ?? 15;
        const curve: Record<string, { from: string; to: string; min: number; max: number }[]> = {};
        for (const d of DAYS_KEYS) {
          const sh2 = mergedStoreHours[d];
          if (!sh2) continue;
          const dayBill = params.billing?.daily?.[d] ?? 0;
          const profName = sh2.special === "match" ? "match" : "normal";
          const prof = params.billing?.profiles?.[profName] ?? {};
          const bands: { from: string; to: string; min: number; max: number }[] = [];
          for (const [hrS, pct] of Object.entries(prof).sort(([a],[b]) => +a - +b)) {
            const hr = +hrS;
            if (!pct) continue;
            const clientsPerHour = dayBill * (pct as number) / 100 / ticket;
            const cajas = Math.max(1, Math.ceil(clientsPerHour / cpcH));
            bands.push({ from: `${String(hr).padStart(2,"0")}:00`, to: `${String(hr+1).padStart(2,"0")}:00`, min: cajas, max: cajas + 1 });
          }
          curve[d] = bands;
        }
        solverParams.demand_curve = curve;
        solverParams.billing = { ...params.billing, daily: Object.fromEntries(DAYS_KEYS.map(d => [d, 0])) };
      } else if (mode2 === "cobertura") {
        // Coverage mode: send demand_curve, zero out billing
        const curve: Record<string, { from: string; to: string; min: number; max: number }[]> = {};
        const bands = params.coverage_bands ?? [];
        for (const d of DAYS_KEYS) curve[d] = bands;
        solverParams.demand_curve = curve;
        solverParams.billing = { ...params.billing, daily: Object.fromEntries(DAYS_KEYS.map(d => [d, 0])) };
      }

      const payload = { department:{id:department.id,name:department.name}, params:solverParams, employees:solverEmps };
      const res = await fetch(`${SOLVER_URL}/api/solve`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const result: SolveResult = await res.json();
      onSchedule(result);
      setEditedSchedule(null);
      await setDoc(doc(db,"schedules",weekDocId),{ weekStart:weekMonday, weekIso:weekIsoId(weekMonday), department:department.id, ...result });
      showToast(`<b>${result.status}</b> · Objetivo ${result.objective}${result.warnings.length>0?` · ${result.warnings.length} avisos`:""}`);
    } catch(e) { showToast(`Error: ${e instanceof Error?e.message:"desconocido"}`); }
    finally { setLoading(false); }
  }, [department,employees,params,mergedStoreHours,weekDocId,weekMonday,onSchedule,showToast,editedSchedule]);

  useEffect(() => { generateRef.current=handleGenerate; return()=>{generateRef.current=null;}; }, [handleGenerate,generateRef]);

  function handleManualEdit(empId:string,day:DayKey,newStart:string,newHours:number) {
    const base = displaySchedule; if(!base) return;
    const ns = JSON.parse(JSON.stringify(base)) as SolveResult;
    ns.schedule[empId][day] = {start:newStart,end:hh(tm(newStart)+newHours*60),hours:newHours,code:"normal"};
    ns.coverage[day] = recalcCoverage(day,ns,employees,params,mergedStoreHours);
    setEditedSchedule(ns);
  }

  // Inactive employees for display
  const inactiveIds = new Set(Object.entries(weekOverrides).filter(([,v])=>v.active===false).map(([k])=>k));

  return (
    <>
      <div className="gridbar">
        <div style={{display:"flex",alignItems:"center",gap:4,background:"var(--paper)",border:"1px solid var(--line)",borderRadius:11,padding:"3px 4px",boxShadow:"var(--shadow)"}}>
          <button onClick={()=>onWeekChange(shiftWeek(weekMonday,-1))} style={{border:"none",background:"transparent",cursor:"pointer",padding:"5px 8px",borderRadius:8,fontSize:14,color:"var(--ink-2)",fontWeight:700}}>‹</button>
          <span style={{fontFamily:"'Spline Sans Mono'",fontSize:12,fontWeight:600,padding:"0 6px",whiteSpace:"nowrap"}}>{weekLabel(weekMonday)}</span>
          <button onClick={()=>onWeekChange(shiftWeek(weekMonday,1))} style={{border:"none",background:"transparent",cursor:"pointer",padding:"5px 8px",borderRadius:8,fontSize:14,color:"var(--ink-2)",fontWeight:700}}>›</button>
        </div>
        <div className="gridtoggle">
          <button className={`gt ${mode==="dia"?"active":""}`} onClick={()=>setMode("dia")}>Por día</button>
          <button className={`gt ${mode==="semana"?"active":""}`} onClick={()=>setMode("semana")}>Semana completa</button>
        </div>
        {/* Worker selector — inline in toolbar */}
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <select className="sel" value={selectedEmp} onChange={e=>setSelectedEmp(e.target.value)} style={{minWidth:130,fontSize:12}}>
            <option value="">Todos</option>
            {employees.map(emp=><option key={emp.id} value={emp.id}>{emp.name}</option>)}
          </select>
          {selectedEmp && displaySchedule && (
            <button className="btn btn-ghost" style={{padding:"5px 8px",fontSize:10}} onClick={()=>{
              const text = buildFichaText(selectedEmp, employees, displaySchedule, department, weekMonday, params);
              navigator.clipboard.writeText(text).then(()=>showToast("Copiado ✓"));
            }}>
              <svg className="ico" viewBox="0 0 24 24" style={{width:12,height:12}}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          )}
        </div>
        <div className="spacer"/>
        {loading && <span className="spinner" style={{borderColor:"var(--garnet)",borderTopColor:"#fff"}}/>}
        {displaySchedule && (
          <button className="btn btn-ghost" onClick={() => printA3(department, employees, displaySchedule, mergedStoreHours, weekLabel(weekMonday))}>
            <svg className="ico" viewBox="0 0 24 24"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2M6 14h12v7H6Z"/></svg> Cuadrante A3
          </button>
        )}
      </div>

      {/* Ficha individual */}
      {selectedEmp && (<FichaView empId={selectedEmp} employees={employees} schedule={displaySchedule} department={department} weekMonday={weekMonday} params={params} />)}

      {!selectedEmp && mode==="dia" && (<>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14,flexWrap:"wrap"}}>
          <div className="days" style={{marginBottom:0}}>
            {DAYS_KEYS.map((d,i)=>(
              <div key={d} className={`day ${i===dayIdx?"active":""}`} onClick={()=>setDayIdx(i)}>
                {DAY_SHORT[d]}
                {events[d]?.type==="match"&&<span className="matchbadge">Partido</span>}
                {events[d]?.type==="inventory"&&<span className="matchbadge" style={{background:"#e7e0fb",color:"#5b32b0"}}>Invent.</span>}
                <button onClick={e=>{e.stopPropagation();setEventModal({day:d,event:events[d]??{type:"match"}});}} style={{background:"none",border:"none",cursor:"pointer",fontSize:10,color:"var(--ink-3)",marginLeft:2,padding:0}}>⚙</button>
              </div>
            ))}
          </div>
          <div style={{marginLeft:"auto",display:"flex",flexWrap:"wrap",gap:8,alignItems:"center",opacity:.7,fontSize:10}}>
            <span><span className="lgsw" style={{background:color,display:"inline-block",width:12,height:9,borderRadius:3,verticalAlign:"middle",marginRight:3}}/> Norm.</span>
            <span><span style={{background:"#d4940a",display:"inline-block",width:12,height:9,borderRadius:3,verticalAlign:"middle",marginRight:3}}/> Compl.</span>
            <span><span className="lgsw lg-vac" style={{display:"inline-block",width:12,height:9,borderRadius:3,verticalAlign:"middle",marginRight:3}}/> Aus.</span>
            <span style={{color:"var(--ink-3)"}}><b>DLB</b> libre · <b>VCN</b> vac · <b>FRC</b> fest · <b>DEC</b> conv · <b>BJA</b> baja</span>
          </div>
        </div>
        <div className="card">
          <div className="chead">
            <h3>Cuadrante · {DAY_LABELS[DAYS_KEYS[dayIdx]]}{events[DAYS_KEYS[dayIdx]]?.type==="match"?" · Partido":events[DAYS_KEYS[dayIdx]]?.type==="inventory"?" · Inventario":""}</h3>
            <span className="sub">desde apertura − montaje</span>
          </div>
          {displaySchedule ? (
            <div className="gwrap"><DayGrid day={DAYS_KEYS[dayIdx]} params={params} storeHours={mergedStoreHours} employees={employees} allEmployees={allEmployees} inactiveIds={inactiveIds} weekOverrides={weekOverrides} schedule={displaySchedule} color={color} onManualEdit={handleManualEdit}/></div>
          ) : (
            <div className="cardpad" style={{textAlign:"center",color:"var(--ink-3)",padding:40}}>Pulsa <b>Generar</b> para calcular el cuadrante</div>
          )}
        </div>
      </>)}

      {!selectedEmp && mode==="semana" && (<div>
        {displaySchedule ? DAYS_KEYS.map(d=>(
          <div key={d} className="dayblock">
            <h5>{DAY_LABELS[d]} {events[d]?.type==="match"&&<span className="dbtag match">Partido</span>}{events[d]?.type==="inventory"&&<span className="dbtag inv">Inventario</span>}</h5>
            <div className="gscroll"><DayGrid day={d} params={params} storeHours={mergedStoreHours} employees={employees} allEmployees={allEmployees} inactiveIds={inactiveIds} weekOverrides={weekOverrides} schedule={displaySchedule} color={color} onManualEdit={handleManualEdit}/></div>
          </div>
        )) : <div className="card cardpad" style={{textAlign:"center",color:"var(--ink-3)",padding:40}}>Pulsa <b>Generar</b></div>}
      </div>)}

      {/* Weekly complementary summary */}
      {displaySchedule && (() => {
        const dpw2 = params.days_per_week ?? 5;
        let totalCompl = 0;
        for (const emp of employees) {
          const hpd2 = emp.weekly_hours / dpw2;
          for (const d of DAYS_KEYS) {
            const e = displaySchedule.schedule?.[emp.id]?.[d];
            if (e?.code === "normal" && e.hours) {
              const ex = e.hours - hpd2;
              if (ex > 0) totalCompl += ex;
            }
          }
        }
        return totalCompl > 0 ? (
          <div style={{ marginTop: 10, padding: "8px 14px", background: "#fdf4dd", border: "1px solid #e8c96a", borderRadius: 10, fontSize: 13, fontWeight: 600, color: "#8a5e00" }}>
            Complementarias semana ({department.name}): {totalCompl}h
          </div>
        ) : null;
      })()}

      {displaySchedule && displaySchedule.warnings.length>0 && (
        <div style={{marginTop:14,background:"#fdf0d6",border:"1px solid var(--gold-deep)",borderRadius:12,padding:"12px 16px"}}>
          <b style={{color:"var(--gold-deep)"}}>Avisos ({displaySchedule.warnings.length})</b>
          {displaySchedule.warnings.map((w,i)=><p key={i} style={{fontSize:12,color:"var(--ink-2)",marginTop:4}}>{w}</p>)}
        </div>
      )}

      {eventModal && <EventModal event={eventModal.event} day={eventModal.day} onSave={ev=>addEvent(eventModal.day,ev)} onRemove={()=>removeEvent(eventModal.day)} onClose={()=>setEventModal(null)} hasEvent={!!events[eventModal.day]}/>}
    </>
  );
}

/* Event Modal (unchanged) */
function EventModal({event,day,onSave,onRemove,onClose,hasEvent}:{event:WeekEvent;day:DayKey;onSave:(e:WeekEvent)=>void;onRemove:()=>void;onClose:()=>void;hasEvent:boolean}) {
  const [ev,setEv]=useState<WeekEvent>(event);
  return <div className="modal-overlay" onClick={onClose}><div className="modal" onClick={e=>e.stopPropagation()} style={{width:400}}>
    <div className="modal-head"><h3>Evento — {DAY_LABELS[day]}</h3><button className="editbtn" onClick={onClose} style={{background:"transparent"}}>✕</button></div>
    <div className="modal-body">
      <div className="form-field"><label>Tipo</label><div style={{display:"flex",gap:8}}>
        <button className={`prof ${ev.type==="match"?"active":""}`} onClick={()=>setEv({...ev,type:"match"})}>Partido ⚽</button>
        <button className={`prof ${ev.type==="inventory"?"active":""}`} onClick={()=>setEv({...ev,type:"inventory"})}>Inventario 📦</button>
      </div></div>
      {ev.type==="match"&&<div className="form-field"><label>Cierre ampliado</label><input className="timeinput" value={ev.close??"23:00"} onChange={e=>setEv({...ev,close:e.target.value})}/></div>}
      {ev.type==="inventory"&&<><div style={{display:"flex",gap:10}}><div className="form-field" style={{flex:1}}><label>Desde</label><input className="timeinput" value={ev.extra?.from??"21:00"} onChange={e=>setEv({...ev,extra:{...(ev.extra??{from:"21:00",to:"01:00",min:2,max:3}),from:e.target.value}})}/></div><div className="form-field" style={{flex:1}}><label>Hasta</label><input className="timeinput" value={ev.extra?.to??"01:00"} onChange={e=>setEv({...ev,extra:{...(ev.extra??{from:"21:00",to:"01:00",min:2,max:3}),to:e.target.value}})}/></div></div><div style={{display:"flex",gap:10}}><div className="form-field" style={{flex:1}}><label>Mín</label><input className="num" type="number" value={ev.extra?.min??2} onChange={e=>setEv({...ev,extra:{...(ev.extra??{from:"21:00",to:"01:00",min:2,max:3}),min:+e.target.value}})}/></div><div className="form-field" style={{flex:1}}><label>Máx</label><input className="num" type="number" value={ev.extra?.max??3} onChange={e=>setEv({...ev,extra:{...(ev.extra??{from:"21:00",to:"01:00",min:2,max:3}),max:+e.target.value}})}/></div></div></>}
    </div>
    <div className="modal-foot">{hasEvent&&<button className="btn-danger" onClick={onRemove}>Quitar evento</button>}<div className="spacer"/><button className="btn btn-ghost" onClick={onClose}>Cancelar</button><button className="btn btn-go" onClick={()=>onSave(ev)}>Guardar</button></div>
  </div></div>;
}

/* Coverage recalc */
function recalcCoverage(day:DayKey,sched:SolveResult,employees:Employee[],params:Department["params"],storeHours:Record<string,StoreHours>):CoverageSlot[] {
  const sh=storeHours[day]; if(!sh) return [];
  const openM=tm(sh.open); const cr=tm(sh.close); const closeM=cr<=openM?cr+1440:cr;
  const preM=openM-(params.preopen?.minutes??30); const postM=closeM+(params.postclose?.minutes??30);
  let endM=postM; if(sh.extra){const et=tm(sh.extra.to);endM=Math.max(endM,et<=openM?et+1440:et);}
  const t0=preM; const n=Math.ceil((endM-t0)/30); const cov=new Array(n).fill(0);
  for(const emp of employees){const e=sched.schedule?.[emp.id]?.[day];if(!e||e.code!=="normal"||!e.start)continue;const s=tm(e.start);const sl=(e.hours??0)*2;for(let i=0;i<sl;i++){const idx=Math.round((s+i*30-t0)/30);if(idx>=0&&idx<n)cov[idx]++;}}
  const billing=params.billing;const prod=billing?.productivity_eur_per_person_hour??420;const db2=billing?.daily?.[day]??0;const pn=sh.special==="match"?"match":"normal";const prof=billing?.profiles?.[pn]??{};
  return cov.map((a,k)=>{const m=t0+k*30;const open=m>=openM&&m<closeM;let tgt=0;if(open&&db2>0){const hr=Math.floor(m/60)%24;const pct=prof[String(hr)]??0;tgt=pct>0?Math.max(1,Math.round(db2*pct/100/prod)):1;}return{time:hh(m),target:tgt,assigned:a};});
}

/* DayGrid — with COMPL column, overrides indicators */
function DayGrid({day,params,storeHours,employees,allEmployees,inactiveIds,weekOverrides,schedule,color,onManualEdit}:{
  day:DayKey;params:Department["params"];storeHours:Record<string,StoreHours>;
  employees:Employee[];allEmployees:Employee[];inactiveIds:Set<string>;weekOverrides:Record<string,WeekOverride>;
  schedule:SolveResult;color:string;
  onManualEdit:(empId:string,day:DayKey,start:string,hours:number)=>void;
}) {
  const sh=storeHours[day]; if(!sh) return null;
  const openM=tm(sh.open);const cr=tm(sh.close);const closeM=cr<=openM?cr+1440:cr;
  const preM=openM-(params.preopen?.minutes??30);const postM=closeM+(params.postclose?.minutes??30);
  let endM=postM;if(sh.extra){const et=tm(sh.extra.to);endM=Math.max(endM,et<=openM?et+1440:et);}
  const t0=preM;const slotCount=Math.ceil((endM-t0)/30);
  const isOpen=(m:number)=>m>=openM&&m<closeM;
  const isBand=(m:number)=>m<openM||m>=closeM;
  const covMap:Record<string,CoverageSlot>={};(schedule.coverage?.[day]??[]).forEach(c=>{covMap[c.time]=c;});

  // Live ACONSEJADO: computed from current params, not solver snapshot
  const liveTarget:Record<string,number>={};
  {
    const mode2=params.demand_mode??"billing";
    const billing=params.billing;
    const prod=billing?.productivity_eur_per_person_hour??420;
    const profName=sh.special==="match"?"match":"normal";
    const prof=billing?.profiles?.[profName]??{};
    if(mode2==="billing"){
      const storeBill=billing?.daily?.[day]??0;
      const pct2=params.billing_pct??100;
      const deptBill=storeBill*pct2/100;
      for(let m2=openM;m2<closeM;m2+=30){const hr=Math.floor(m2/60)%24;const p=prof[String(hr)]??0;liveTarget[hh(m2)]=(p>0&&deptBill>0)?Math.max(1,Math.round(deptBill*p/100/prod)):1;}
    }else if(mode2==="cajas"){
      const storeBill=billing?.daily?.[day]??0;
      const ticket=params.ticket_medio??25;
      const cpc=params.clients_per_cash_hour??15;
      for(let m2=openM;m2<closeM;m2+=30){const hr=Math.floor(m2/60)%24;const p=prof[String(hr)]??0;liveTarget[hh(m2)]=(p>0&&storeBill>0&&ticket>0)?Math.max(1,Math.ceil(storeBill*p/100/ticket/cpc)):0;}
    }
    // cobertura: liveTarget stays empty, uses covMap.target as fallback
  }
  const dragRef=useRef<{empId:string;mode:"move"|"start"|"end";origStart:number;origSlots:number;startX:number}|null>(null);
  const [dragPreview,setDragPreview]=useState<{empId:string;startSlot:number;slots:number}|null>(null);
  function onPD(e:React.PointerEvent,empId:string,ss:number,sl:number,ck:number){e.preventDefault();dragRef.current={empId,origStart:ss,origSlots:sl,mode:ck===ss?"start":ck===ss+sl-1?"end":"move",startX:e.clientX};setDragPreview({empId,startSlot:ss,slots:sl});(e.target as HTMLElement).setPointerCapture(e.pointerId);}
  function onPM(e:React.PointerEvent){if(!dragRef.current)return;const dr=dragRef.current;const dx=Math.round((e.clientX-dr.startX)/24);if(dr.mode==="move")setDragPreview({empId:dr.empId,startSlot:Math.max(0,Math.min(slotCount-dr.origSlots,dr.origStart+dx)),slots:dr.origSlots});else if(dr.mode==="end")setDragPreview({empId:dr.empId,startSlot:dr.origStart,slots:Math.max(1,dr.origSlots+dx)});else setDragPreview({empId:dr.empId,startSlot:Math.max(0,dr.origStart+dx),slots:Math.max(1,dr.origSlots-dx)});}
  function onPU(){if(!dragRef.current||!dragPreview){dragRef.current=null;setDragPreview(null);return;}onManualEdit(dragRef.current.empId,day,hh(t0+dragPreview.startSlot*30),dragPreview.slots/2);dragRef.current=null;setDragPreview(null);}

  const dpw=params.days_per_week??5;

  // Show all employees (active + inactive grayed)
  const showEmployees = allEmployees;

  return (
    <div onPointerMove={onPM} onPointerUp={onPU}>
      {/* HEADER */}
      <div className="ghead"><div className="grow">
        <div className="gmeta"><div className="c-obs"/><div className="c-name" style={{fontWeight:700}}>Empleado</div><div className="c-base">Base</div><div className="c-ent">Entrada</div><div className="c-tot">Total</div><div className="c-compl">C</div></div>
        <div className="cells">{Array.from({length:slotCount},(_,k)=>{const m=t0+k*30;if(m%60!==0)return null;const band=isBand(m);return <div key={k} className={`hourcell ${band?"bandhead":""}`}>{hh(m)}</div>;})}</div>
      </div></div>

      {/* EMPLOYEES */}
      {showEmployees.map(emp=>{
        const inactive = inactiveIds.has(emp.id);
        const hasOverride = !!weekOverrides[emp.id];
        const entry:ScheduleEntry|undefined = schedule.schedule?.[emp.id]?.[day];
        const isOff = inactive || !entry || entry.code==="off";
        const isVac = !inactive && entry?.code && entry.code!=="normal" && entry.code!=="off";
        const isWorking = !isOff && !isVac;
        const hpd = emp.weekly_hours/dpw;
        const baseSlots = Math.round(hpd*2);

        let ssSlot=-1, shSlots=0;
        if(isWorking&&entry?.start){ssSlot=Math.round((tm(entry.start)-t0)/30);shSlots=(entry.hours??hpd)*2;}
        const dp=dragPreview?.empId===emp.id?dragPreview:null;
        const dS=dp?dp.startSlot:ssSlot;const dSl=dp?dp.slots:shSlots;

        // Week totals for the Total column
        let weekH=0;
        for(const d2 of DAYS_KEYS){const e2=schedule.schedule?.[emp.id]?.[d2];if(e2?.code==="normal"&&e2.hours)weekH+=e2.hours;}

        // Day-specific complementary: excess of THIS day only
        let dayHours = isWorking ? (entry?.hours ?? hpd) : 0;
        if(dp&&isWorking){ dayHours = dp.slots/2; weekH = weekH - (entry?.hours??hpd) + dayHours; }
        const dayCompl = Math.max(0, dayHours - hpd);

        return (
          <div key={emp.id} className="grow" style={inactive?{opacity:.35}:{}}>
            <div className="gmeta">
              <div className="c-obs">{hasOverride&&<span style={{display:"inline-block",width:6,height:6,borderRadius:3,background:"#d4940a",marginLeft:4}}/>}</div>
              <div className="c-name">
                <div className="avmini" style={{background:inactive?"#bbb":color}}>{initials(emp.name)}</div>
                <div className="nm"><b>{emp.name}</b><span>{(() => { const av = emp.availability; const label = typeof av === "string" ? av : "⋯"; const cls = typeof av === "string" ? av : "F"; return <span className={`pill p-${cls}`}>{label}</span>; })()}{emp.fixed&&<svg className="lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>}</span></div>
              </div>
              <div className="c-base"><b>{emp.weekly_hours}</b></div>
              <div className="c-ent">{inactive?"INACT":isWorking?entry?.start:isVac?(entry?.code??"VCN").toUpperCase():"DLB"}</div>
              <div className="c-tot"><b>{isWorking?entry?.hours:0}</b></div>
              <div className="c-compl" style={{color:dayCompl>0?"#b87800":"var(--ink-3)"}}><b style={{fontFamily:"'Spline Sans Mono'",fontSize:11}}>{dayCompl>0?`${dayCompl}h`:"0h"}</b></div>
            </div>
            <div className="cells">{Array.from({length:slotCount},(_,k)=>{
              const m=t0+k*30;const band=isBand(m);const he=(m+30)%60===0;
              if(isVac) return <div key={k} className={`cell w vac ${k===0?"s":""} ${k===slotCount-1?"e":""} ${he?"hourend":""}`} style={{"--dc":color} as React.CSSProperties}><div className="fill"/>{k===Math.floor(slotCount/2)&&<span className="entlabel dark">{(entry?.code??"AUS").toUpperCase().slice(0,3)}</span>}</div>;
              const inS=isWorking&&k>=dS&&k<dS+dSl;
              if(inS){const iS=k===dS,iE=k===dS+dSl-1;const comp=(k-dS)>=baseSlots;return <div key={k} className={`cell w ${iS?"s":""} ${iE?"e":""} ${he?"hourend":""} ${band?"band":""}`} style={{"--dc":comp?"#d4940a":color,cursor:"grab"} as React.CSSProperties} onPointerDown={e=>onPD(e,emp.id,dS,dSl,k)}><div className="fill"/>{iS&&<span className="entlabel">{hh(t0+dS*30)}</span>}</div>;}
              return <div key={k} className={`cell ${he?"hourend":""} ${band?"band":""}`}/>;
            })}</div>
          </div>
        );
      })}

      {/* ROW 1: PERSONAS (real) — with semaphore vs Aconsejado */}
      <div className="crow">
        <div className="gmeta"><div className="c-obs"/><div className="c-name" style={{fontSize:10}}>PERSONAS</div><div className="c-base"/><div className="c-ent"/><div className="c-tot"><b>{(() => { let t=0; for(const e of showEmployees){ const en=schedule.schedule?.[e.id]?.[day]; if(en?.code==="normal"&&en.hours) t+=en.hours; } return t; })()}h</b></div><div className="c-compl"><b>{(() => { let w=0; for(const e of showEmployees){ const en=schedule.schedule?.[e.id]?.[day]; if(en?.code==="normal") w++; } return w; })()}</b><small>trab.</small></div></div>
        <div className="cells">{Array.from({length:slotCount},(_,k)=>{
          const m=t0+k*30;const ts=hh(m);const cov=covMap[ts];const open=isOpen(m);const he=(m+30)%60===0;
          const a=cov?.assigned??0;
          const tgt=liveTarget[ts]??covMap[ts]?.target??0; // live first, solver fallback
          let bg="transparent",col="var(--ink-3)";
          if(open&&tgt>0){if(a<tgt){bg="#fdecec";col="var(--bad)";}else if(a===tgt){bg="#e7f4ee";col="var(--ok)";}else{bg="#fdf0d6";col="var(--gold-deep)";}}
          else if(a>0){bg="#f5f7fa";}
          return <div key={k} className={`ccell ${he?"hourend":""}`} style={{background:bg,color:col}}>{a>0?a:""}</div>;
        })}</div>
      </div>
      {/* ROW 2: ACONSEJADO (live from current params) */}
      <div className="crow" style={{borderTop:"1px solid var(--line-2)",height:32,opacity:.7}}>
        <div className="gmeta"><div className="c-obs"/><div className="c-name" style={{fontSize:10,color:"var(--ink-3)"}}>ACONSEJADO</div><div className="c-base"/><div className="c-ent"/><div className="c-tot"/><div className="c-compl"/></div>
        <div className="cells">{Array.from({length:slotCount},(_,k)=>{
          const m=t0+k*30;const ts=hh(m);const open=isOpen(m);const he=(m+30)%60===0;
          const tgt=liveTarget[ts]??covMap[ts]?.target??0;
          return <div key={k} className={`ccell ${he?"hourend":""}`} style={{color:"var(--ink-3)",fontSize:10}}>{open&&tgt>0?tgt:""}</div>;
        })}</div>
      </div>
    </div>
  );
}

/* ── Worker Ficha ── */
const ABSENCE_LABELS: Record<string,string> = {
  VCN:"Vacaciones",VAA:"Vacaciones año anterior",FRC:"Festivo recuperado",
  DEC:"Día de convenio",BJA:"Baja",DLB:"Día libre",vacation:"Vacaciones",
};

function dayDate(weekMonday2: string, idx: number): string {
  const d = new Date(weekMonday2+"T00:00:00");
  d.setDate(d.getDate()+idx);
  return `${d.getDate()}/${d.getMonth()+1}`;
}

function fichaLine(entry: ScheduleEntry|undefined, hpd: number): string {
  if (!entry || entry.code === "off") return "Libre";
  if (entry.code === "normal" && entry.start && entry.end) {
    const h = entry.hours ?? hpd;
    const compl = Math.max(0, h - hpd);
    return compl > 0 ? `${entry.start} a ${entry.end} (${hpd}h + ${compl}h compl.)` : `${entry.start} a ${entry.end} (${h}h)`;
  }
  return ABSENCE_LABELS[entry.code] ?? entry.code.toUpperCase();
}

function buildFichaText(empId: string, employees: Employee[], sched: SolveResult, dept: Department, weekMon: string, params: Department["params"]): string {
  const emp = employees.find(e=>e.id===empId);
  if (!emp) return "";
  const dpw = params.days_per_week ?? 5;
  const hpd = emp.weekly_hours / dpw;
  const lines = [`Horario · ${emp.name} · ${dept.name}`, weekLabel(weekMon), ""];
  let total = 0;
  DAYS_KEYS.forEach((d, i) => {
    const entry = sched?.schedule?.[empId]?.[d];
    const line = fichaLine(entry, hpd);
    lines.push(`${DAY_LABELS[d]} ${dayDate(weekMon,i)}: ${line}`);
    if (entry?.code === "normal" && entry.hours) total += entry.hours;
  });
  lines.push("", `Total: ${total}h`);
  return lines.join("\n");
}

function FichaView({empId,employees,schedule,department,weekMonday:wm,params}:{empId:string;employees:Employee[];schedule:SolveResult|null;department:Department;weekMonday:string;params:Department["params"]}) {
  const emp = employees.find(e=>e.id===empId);
  if (!emp) return null;
  if (!schedule) return <div className="card cardpad" style={{color:"var(--ink-3)",textAlign:"center",padding:30}}>Genera el cuadrante primero</div>;
  const dpw = params.days_per_week ?? 5;
  const hpd = emp.weekly_hours / dpw;
  let total = 0;
  return (
    <div className="card" style={{maxWidth:500}}>
      <div className="chead"><h3>{emp.name}</h3><span className="sub">{emp.weekly_hours}h/sem · {hpd}h/día</span></div>
      <div className="cardpad" style={{fontSize:13}}>
        {DAYS_KEYS.map((d,i) => {
          const entry = schedule.schedule?.[empId]?.[d];
          const line = fichaLine(entry, hpd);
          if (entry?.code === "normal" && entry.hours) total += entry.hours;
          const isWork = entry?.code === "normal";
          return <div key={d} style={{display:"flex",gap:10,padding:"5px 0",borderBottom:"1px solid var(--line-2)"}}>
            <span style={{width:70,fontWeight:600,color:"var(--ink-2)",fontSize:12}}>{DAY_LABELS[d]} {dayDate(wm,i)}</span>
            <span style={{color: isWork ? "var(--ink)" : "var(--ink-3)", fontWeight: isWork ? 500 : 400}}>{line}</span>
          </div>;
        })}
        <div style={{marginTop:10,fontWeight:700,fontSize:14}}>Total: {total}h</div>
      </div>
    </div>
  );
}
