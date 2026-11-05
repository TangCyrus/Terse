import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

export const root = process.cwd();
export const load = file => import(pathToFileURL(path.join(root, 'source', file)));
export const PQueue = (await load('index.ts')).default;
export const EventEmitter = createRequire(path.join(root, 'package.json'))('eventemitter3');
export const source = file => fs.readFileSync(path.join(root, 'source', file), 'utf8');
export const ast = file => ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
export function nodes(tree) {
  const output = [];
  const visit = node => { output.push(node); ts.forEachChild(node, visit); };
  visit(tree);
  return output;
}
export { ts };
export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
export async function within(promise, milliseconds = 500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Acceptance wait deadline exceeded')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
