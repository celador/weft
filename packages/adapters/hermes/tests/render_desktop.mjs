// Optional browser/component verification using SDK test doubles, NOT a full Desktop-window test.
// Run after e2e_catalog.py exports WEFT_E2E_JSON; dependencies are supplied by the caller.
// node tests/render_desktop.mjs <node_modules containing react, esbuild, playwright> <e2e.json> <output-dir>
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const [modules, evidence, output] = process.argv.slice(2)
if (!output) throw new Error('expected node_modules, E2E JSON, output directory')
const require = createRequire(path.resolve(modules, '../package.json'))
const { build } = require('esbuild')
const { chromium } = require('playwright')
const here = path.dirname(fileURLToPath(import.meta.url))
await fs.mkdir(output, { recursive: true })
const mock = `
import React from 'react';
export const host = {state: {
 cwd: {get: () => globalThis.fixture.agents.find(a=>a.open?.length)?.worktree || ''},
 gateway: {get: ()=>'component-test'}, activeSessionId: {get: ()=>'session-B'}
}};
export const useValue = atom => atom.get();
export const useQuery = () => ({data: globalThis.fixture, refetch(){}, error: globalThis.fixture.error});
export const Button = ({children,onClick})=>React.createElement('button',{onClick},children);
export const Badge = ({children})=>React.createElement('span',{className:'badge'},children);
`
const bundle = await build({
 stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
 import {Feed} from ${JSON.stringify(path.resolve(here,'../plugin/weft/desktop/plugin.js'))};
 globalThis.draw = () => createRoot(document.getElementById('root')).render(React.createElement(Feed,{ctx:{}}));`, resolveDir: here },
 bundle: true, write: false, format: 'iife',
 plugins: [{name:'test-sdk',setup(b){
   b.onResolve({filter:/^@hermes\/plugin-sdk$/},()=>({path:'sdk',namespace:'test'}));
   b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:mock,loader:'js',resolveDir:path.resolve(modules)}));
   b.onResolve({filter:/^react(?:-dom)?(?:\/.*)?$/},args=>({path:require.resolve(args.path)}));
 }}],
})
const result = JSON.parse(await fs.readFile(evidence,'utf8'))
if (!result.snapshots?.some(a=>a.open?.length)) throw new Error('E2E must supply a REAL conflict snapshot')
const browser = await chromium.launch({headless:true, channel: process.env.WEFT_UI_BROWSER || 'chrome'})
try {
 for (const [state, data] of Object.entries({conflict:{agents:result.snapshots},empty:{agents:[]},error:{agents:[],error:true}})) {
  const page = await browser.newPage({viewport:{width:400,height:850},deviceScaleFactor:1})
  const errors=[]; page.on('pageerror',e=>errors.push(e.message))
  await page.setContent(`<style>
   :root{--ui-text-secondary:#666;--ui-stroke-secondary:#ddd;--ui-accent:#816330}
   *{box-sizing:border-box}body{margin:0;background:#faf9f6;color:#242320;font:13px system-ui}
   .banner{padding:12px;border-bottom:1px solid #ddd;font-size:10px;color:#666}
   button{border:1px solid #ddd;border-radius:5px;padding:5px 9px;background:transparent;color:inherit;cursor:pointer}
   .badge{border:1px solid #ddd;border-radius:4px;padding:2px 5px;font-size:10px}
   h4{margin-bottom:4px}#root{height:790px}
   </style><div class=banner>Component verification · real local-gateway evidence<br>SDK test harness, not a Hermes Desktop screenshot</div><main id=root></main>`)
  await page.evaluate(data=>{globalThis.fixture=data},data)
  await page.addScriptTag({content:bundle.outputFiles[0].text})
  await page.evaluate(()=>globalThis.draw())
  if(state==='conflict') { await page.getByText('stale_assumption',{exact:true}).waitFor(); await page.getByText('pricing.py#calc_total',{exact:true}).first().waitFor() }
  if(state==='empty') await page.getByText('No linked sessions yet').waitFor()
  if(state==='error') await page.getByRole('button',{name:'Retry'}).click()
  if(errors.length) throw new Error(errors.join('\n'))
  await page.screenshot({path:path.join(output,`weft-${state}.png`),fullPage:true})
  console.log('PASS component state:',state)
  await page.close()
 }
} finally {await browser.close()}
