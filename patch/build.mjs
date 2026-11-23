import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [clientPath, serverPath, outputDir] = process.argv.slice(2);
assert.ok(clientPath && serverPath && outputDir, 'Usage: node build.mjs CLIENT SERVER OUTPUT_DIR');
const sources = fileURLToPath(new URL('./sources/', import.meta.url));
const source = (name) => readFileSync(join(sources, name), 'utf8');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const readVerified = (file, hash) => {
  const text = readFileSync(file, 'utf8');
  assert.equal(sha(text), hash, `Unsupported input: ${file}`);
  return text;
};
function replaceOnce(text, original, replacement) {
  assert.equal(text.split(original).length - 1, 1, `Expected one match for ${original}`);
  return text.replace(original, () => replacement);
}

let client = readVerified(clientPath, 'e5f61017c214605ad2251948b0e53af63901b7337dd0b22c36feebb404b85654');
client = replaceOnce(client, 'from"./utils-CfAhq9cy.js";',
  'from"./utils-CfAhq9cy.js";import{Oh as __forgeAtom,Th as __forgeFamily,qu as __forgeUse}from"./utils-CfAhq9cy.js";');
client = replaceOnce(client, 'from"./entities-Y4q5SLTL.js";',
  'from"./entities-Y4q5SLTL.js";import{Q as __forgeQ,Z as __tpZ,F as __forgeRelationshipShells}from"./entities-Y4q5SLTL.js";');
client = replaceOnce(client, 'from"./usageLimits-i1WvFdCN.js";',
  'from"./usageLimits-i1WvFdCN.js";import{l as __tpLim}from"./usageLimits-i1WvFdCN.js";');
const projection = 'let fe=de,Y=Ul(fe)?.projection??null,';
client = replaceOnce(client, projection, projection +
  '__tpKey=S.environmentId+"\\n"+S.threadId,' +
  '__forgeChildren=__forgeCount(Y?.subagents??[],__forgeRelationshipShells(S))+__forgeUse(__forgeTree(__tpKey)),' +
  '__forgeSlots=Array.from({length:__forgeChildren},(_,i)=>i+1).join(" "),' +
  '__tpS=__tpSubA?__forgeUse(__tpSubA(__tpKey)):null,__tpP=__tpUI.usePub(__tpKey),');
const chat = 'let bv=(0,$.jsxs)(`div`,{ref:zn,className:`relative flex min-h-0';
client = replaceOnce(client, chat,
  'let __tpR=__tpApi.run({q:Y,yc:Dc,ys:vs,providers:Ko,sources:Vo?.usageLimitSources??XW,nowMs:Date.now(),limitsFor:__tpLim,settings:Vo?.settings,model:Wr?.modelSelection?.model,hasMore:Ve?.hasMoreHistory===!0,children:__tpS});__tpP.current=__tpR.pub;' + chat);
const column = '"data-chat-column":!0,inert:Ha';
client = replaceOnce(client, column,
  '"data-chat-column":!0,"data-forge-active-children":__forgeChildren,"data-forge-active-slots":__forgeSlots,' +
  '"data-tokpanel":__tpR.attrs["data-tokpanel"],"data-tokpanel-tone":__tpR.attrs["data-tokpanel-tone"],inert:Ha');
client = replaceOnce(client, 'q=p&&_?(0,$.jsx)(`aside`,{...u,"data-workspace-focus-key"',
  'q=p&&_?(0,$.jsxs)(`aside`,{...u,"data-workspace-focus-key"');
client = replaceOnce(client, '"data-thread-details-panel":`inline`,children:G}',
  '"data-thread-details-panel":`inline`,children:[G,__tpUI.node(n)]}');
const count = source('compiled-helper.js')
  .replace('$e(t.status)', '[`pending`,`running`,`waiting`].includes(t.status)')
  .replace('go(i.latestRunRequestedAt)>go(t.completedAt??t.startedAt??t.updatedAt)',
    'Date.parse(i.latestRunRequestedAt)>Date.parse(t.completedAt??t.startedAt??t.updatedAt)');
const sourceMap = '//# sourceMappingURL=' + basename(clientPath) + '.map';
client = replaceOnce(client, sourceMap,
  count + '\n' + source('compiled-tree.js') + '\n' + source('helper.js') + '\n');

let server = readVerified(serverPath, 'dd42a4f6ec75cf5cf32a1da225837656086fb4df3e03da7bd87fbd196412c8bf');
const core = replaceOnce(source('agentTree.mjs'), 'export function makeTokpanelAgentTree(', 'function makeTokpanelAgentTree(');
const route = 'const layerOtlpTracesProxyRoute = ';
server = replaceOnce(server, route, core + '\n' + source('route.js') + '\n' + route);
server = replaceOnce(server, 'layerOtlpTracesProxyRoute, layerAssetRoute,',
  'layerOtlpTracesProxyRoute, layerTokpanelAgentTreeRoute, layerAssetRoute,');

mkdirSync(outputDir, { recursive: true });
for (const [file, data] of [[clientPath, client], [serverPath, server]]) {
  const target = join(outputDir, basename(file));
  writeFileSync(target, data);
  console.log(JSON.stringify({ target, sha256: sha(data), bytes: Buffer.byteLength(data) }));
}
