import { expect, it, vi } from 'vitest';
import { ok } from '@baitonghub-linux-mcp/domain';
import { ToolRegistry } from '../tool-registry.js';

it('passes the trusted actor and rejects injected owner or observed facts',async()=>{
  const actor={clientId:'owner',clientName:'fixture'},execute=vi.fn(async()=>ok({}));
  const registry=new ToolRegistry({diagnosis:{execute}},actor,{serverProfileProvider:():'fleet'=>'fleet'});
  expect((await registry.invoke('diagnosis',{operation:'get',diagnosisId:'d'})).isError).not.toBe(true);
  expect(execute.mock.calls[0]?.[0]).toEqual(actor);
  expect((await registry.invoke('diagnosis',{operation:'get',diagnosisId:'d',ownerKey:'other'})).isError).toBe(true);
  expect((await registry.invoke('diagnosis',{operation:'get',diagnosisId:'d',observedFacts:[]})).isError).toBe(true);
  expect(execute).toHaveBeenCalledTimes(1);
});
it('is optional and excluded from core',()=>{
  const actor={clientId:'x',clientName:'x'};
  expect(new ToolRegistry({},actor).list().some(tool=>tool.name==='diagnosis')).toBe(false);
  expect(new ToolRegistry({diagnosis:{execute:async():Promise<ReturnType<typeof ok>>=>ok({})}},actor,{serverProfileProvider:():'core'=>'core'}).list().some(tool=>tool.name==='diagnosis')).toBe(false);
});
