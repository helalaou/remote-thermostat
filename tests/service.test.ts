import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.ts';
import { ThermostatService,type DeviceClient } from '../src/service.ts';
import { GoogleApiError } from '../src/google/sdm.ts';
import { parseThermostat,type SdmCommand } from '../src/domain/thermostat.ts';
const resource='enterprises/fake/devices/fake';
function snapshot(mode='HEAT',heat=20){const p='sdm.devices.traits.';return parseThermostat({name:resource,type:'sdm.devices.types.THERMOSTAT',traits:{[p+'Connectivity']:{status:'ONLINE'},[p+'ThermostatMode']:{mode,availableModes:['HEAT','OFF']},[p+'ThermostatEco']:{mode:'OFF',availableModes:['MANUAL_ECO','OFF']},[p+'ThermostatTemperatureSetpoint']:{heatCelsius:heat}}},resource);}
function setup(t:TestContext,client:DeviceClient|null){const path=mkdtempSync(join(tmpdir(),'nest-service-'));const store=new Store(path);t.after(()=>{store.close();rmSync(path,{recursive:true,force:true});});return{store,service:new ThermostatService({store,client:()=>client,policy:{}})};}
test('multiple viewers share one cache and one in-flight read',async(t)=>{
 let reads=0;const client={getDevice:async()=>{reads++;await new Promise(r=>setTimeout(r,10));return snapshot();},execute:async()=>{}};
 const {service}=setup(t,client);await Promise.all([service.status(),service.status(),service.status()]);assert.equal(reads,1);await service.status();assert.equal(reads,1);
});
test('fresh device state rejects old UI heat request after mode changes',async(t)=>{
 let state=snapshot();let writes=0;const client={getDevice:async()=>state,execute:async()=>{writes++;}};const {service}=setup(t,client);
 await service.status();state=snapshot('OFF');const response=await service.command('guest',randomUUID(),{type:'heat',heatCelsius:22},()=>true);assert.equal(response.status,409);assert.equal(writes,0);
});
test('accepted commands only confirm matching readback; replay never sends twice',async(t)=>{
 let heat=20;let writes=0;const client={getDevice:async()=>snapshot('HEAT',heat),execute:async(command:SdmCommand)=>{writes++;if('heatCelsius'in command.params)heat=command.params.heatCelsius;}};const {service}=setup(t,client);
 const id=randomUUID();const input={type:'heat',heatCelsius:22};const response=await service.command('guest',id,input,()=>true);assert.equal(response.body.confirmed,true);assert.equal(writes,1);
 assert.deepEqual(await service.command('guest',id,input,()=>true),response);assert.equal(writes,1);
 await assert.rejects(()=>service.command('other',id,input,()=>true),/already been used/);
 await assert.rejects(()=>service.command('guest',id,{type:'heat',heatCelsius:23},()=>true),/already been used/);
});
test('empty Google acceptance is not false success',async(t)=>{
 const {service}=setup(t,{getDevice:async()=>snapshot(),execute:async()=>({})});const result=await service.command('guest',randomUUID(),{type:'heat',heatCelsius:22},()=>true);assert.equal(result.body.accepted,true);assert.equal(result.body.confirmed,false);
});
test('timeout is uncertain and cannot be replayed into another command',async(t)=>{
 let writes=0;const {service}=setup(t,{getDevice:async()=>snapshot(),execute:async()=>{writes++;throw new GoogleApiError('OUTCOME_UNKNOWN','Uncertain.',{outcomeUnknown:true});}});const id=randomUUID();const command={type:'heat',heatCelsius:22};
 const result=await service.command('guest',id,command,()=>true);assert.equal(result.body.outcomeUnknown,true);await service.command('guest',id,command,()=>true);assert.equal(writes,1);
});
test('simultaneous writes are rejected and revoked session is checked again after read',async(t)=>{
 let release:()=>void=()=>{};let writes=0;let allowed=true;
 const {service}=setup(t,{getDevice:async()=>{await new Promise<void>(r=>{release=r;});return snapshot();},execute:async()=>{writes++;}});
 const first=service.command('guest',randomUUID(),{type:'heat',heatCelsius:22},()=>allowed);
 await assert.rejects(()=>service.command('guest',randomUUID(),{type:'heat',heatCelsius:23},()=>true),/in progress/);
 allowed=false;release();assert.equal((await first).status,403);assert.equal(writes,0);
});
test('Google quota blocks subsequent reads and commands and survives a fresh service',async(t)=>{
 let reads=0;const client={getDevice:async()=>{reads++;throw new GoogleApiError('RATE_LIMITED','Wait.',{status:429,retryAfterSeconds:90});},execute:async()=>{}};
 const {service,store}=setup(t,client);const first=await service.status();assert.equal(first.stale,true);assert.equal(reads,1);
 const second=new ThermostatService({store,client:()=>client,policy:{}});const next=await second.status();assert.equal(next.stale,true);assert.ok(next.retryAfterSeconds!>0);assert.equal(reads,1);
});
test('hourly command quota includes every command type and prevents dispatch',async(t)=>{
 let writes=0;const {service,store}=setup(t,{getDevice:async()=>snapshot(),execute:async()=>{writes++;}});
 for(let i=0;i<100;i++)store.reserve('google-commands',[{max:100,windowMs:3_600_000}],Date.now()-120_000+i);
 const result=await service.command('guest',randomUUID(),{type:'mode',mode:'OFF'},()=>true);assert.equal(result.status,429);assert.equal(writes,0);
});
test('fan ON readback does not falsely confirm a different timer duration',async(t)=>{
 const state={...snapshot(),hasFan:true,fanTimerMode:'ON' as const,fanTimerTimeout:new Date(Date.now()+60000).toISOString()};
 const {service}=setup(t,{getDevice:async()=>state,execute:async()=>({})});const result=await service.command('guest',randomUUID(),{type:'fan',timerMode:'ON',durationSeconds:3600},()=>true);
 assert.equal(result.body.accepted,true);assert.equal(result.body.confirmed,false);
});
test('application attempts are bounded before request/audit persistence, while replay remains free',async(t)=>{
 const {service,store}=setup(t,null);
 for(let i=0;i<20;i++)await service.command('guest',randomUUID(),{type:'heat',heatCelsius:22},()=>true);
 await assert.rejects(()=>service.command('guest',randomUUID(),{type:'heat',heatCelsius:22},()=>true),/Too many/);
 const count=store.db.prepare('SELECT count(*) AS n FROM requests').get() as {n:number};assert.equal(count.n,20);
});
test('a reset during read never publishes the previous connection snapshot',async(t)=>{
 let release:()=>void=()=>{};const {service}=setup(t,{getDevice:async()=>{await new Promise<void>(r=>{release=r;});return snapshot();},execute:async()=>{}});
 const pending=service.status();service.reset();release();const result=await pending;assert.equal(result.stale,true);assert.equal(result.snapshot,undefined);
});
