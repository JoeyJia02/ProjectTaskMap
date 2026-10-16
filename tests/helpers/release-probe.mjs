// A child-only synthetic server: no .env loading, fixed service ports or runtime scripts.
import { pathToFileURL } from 'node:url';

const [appPath, rawConfig] = process.argv.slice(2);
const { createApp } = await import(pathToFileURL(appPath).href);
const runtime = createApp(JSON.parse(rawConfig));
const listener = runtime.app.listen(0, '127.0.0.1');
await new Promise((resolve, reject) => { listener.once('listening', resolve); listener.once('error', reject); });
process.send({ base: `http://127.0.0.1:${listener.address().port}` });
process.once('message', message => {
  if (message !== 'stop') return;
  listener.closeAllConnections();
  listener.close(() => { runtime.close(); process.exit(0); });
});
