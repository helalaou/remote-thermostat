import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { GoogleConnection } from '../src/google/connection.ts';

const resource='enterprises/project-test/devices/device-test';
test('Google setup validates one-use owner state, PKCE and exactly one device before encrypted persistence',async(t)=>{
 const directory=mkdtempSync(join(tmpdir(),'nest-connection-'));const store=new Store(directory);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const config=readConfig({APP_ORIGIN:'https://example.test',GOOGLE_CLIENT_ID:'fake-client',GOOGLE_CLIENT_SECRET:'fake-secret',GOOGLE_DEVICE_ACCESS_PROJECT_ID:'project-test',TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('base64')});
 const calls:{url:string;init:RequestInit|undefined}[]=[];
 const fetcher:typeof fetch=async(input,init)=>{const url=String(input);calls.push({url,init});return Response.json(url.endsWith('/token')?{access_token:'fake-access',refresh_token:'fake-refresh',expires_in:3600}:{devices:[{type:'sdm.devices.types.THERMOSTAT',name:resource}]});};
 const connection=new GoogleConnection(config,store,fetcher);assert.equal(connection.connected,false);
 const url=new URL(await connection.authorizationUrl('owner-session'));
 assert.equal(url.hostname,'nestservices.google.com');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 await assert.rejects(()=>connection.complete('code',url.searchParams.get('state')!,'neighbor-session'));
 assert.equal(calls.length,0);
 await connection.complete('code',url.searchParams.get('state')!,'owner-session');
 assert.equal(connection.connected,true);assert.equal(connection.resource,resource);
 assert.ok(!store.get('google-refresh')?.includes('fake-refresh'));assert.equal(await connection.accessToken(),'fake-access');
 assert.equal(calls.length,2);assert.ok(new URLSearchParams(calls[0].init?.body as URLSearchParams).get('code_verifier'));
 await assert.rejects(()=>connection.complete('code',url.searchParams.get('state')!,'owner-session'));assert.equal(calls.length,2);
});
test('ambiguous thermostat discovery never persists a connection',async(t)=>{
 const directory=mkdtempSync(join(tmpdir(),'nest-multiple-'));const store=new Store(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const config=readConfig({GOOGLE_CLIENT_ID:'fake',GOOGLE_CLIENT_SECRET:'fake',GOOGLE_DEVICE_ACCESS_PROJECT_ID:'project-test',TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('base64')});
 const fetcher:typeof fetch=async(input)=>Response.json(String(input).endsWith('/token')?{access_token:'fake',refresh_token:'fake',expires_in:3600}:{devices:[{type:'sdm.devices.types.THERMOSTAT',name:resource},{type:'sdm.devices.types.THERMOSTAT',name:resource+'2'}]});
 const connection=new GoogleConnection(config,store,fetcher);const url=new URL(await connection.authorizationUrl('a'));
 await assert.rejects(()=>connection.complete('code',url.searchParams.get('state')!,'a'),/exactly one/);assert.equal(connection.connected,false);assert.equal(store.get('google-refresh'),undefined);
});
