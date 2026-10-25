import { serve } from '@hono/node-server';
import { readConfig } from './config.ts';
import { Store } from './store.ts';
import { createApp } from './app.ts';

const config=readConfig();
const store=new Store(config.dataDir);
const app=createApp({config,store});
const server=serve({fetch:app.fetch,port:config.port,hostname:config.host},()=>{
  console.log(`Neighbor Thermostat listening at ${config.origin}. Google connection is ${store.get('google-refresh')?'configured':'not connected'}.`);
});
const maintenance=setInterval(()=>store.prune(),3_600_000);maintenance.unref();
function shutdown(){clearInterval(maintenance);server.close(()=>{store.close();process.exit(0);});setTimeout(()=>process.exit(1),10_000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
