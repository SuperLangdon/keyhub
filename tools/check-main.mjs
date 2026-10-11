import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
try {
  await import(pathToFileURL(resolve(process.argv[2])).href);
  console.log('OK');
} catch (e) {
  console.log(e.stack.split('\n').slice(0, 6).join('\n'));
}
