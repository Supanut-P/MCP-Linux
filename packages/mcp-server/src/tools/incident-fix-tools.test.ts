import { expect, it, vi } from 'vitest';
import { ok } from '@baitonghub-linux-mcp/domain';
import { ToolRegistry } from '../tool-registry.js';

it('uses the trusted actor and rejects injected source or owner claims',async()=>{
  const actor={clientId:'owner',clientName:'fixture'},execute=vi.fn(async()=>ok({}));
  const registry=new ToolRegistry({incidentFix:{execute}},actor,{serverProfileProvider:():'fleet'=>'fleet'});
  expect((await registry.invoke('incident_fix',{operation:'status',fixId:'fix'})).isError).not.toBe(true);
  expect(execute.mock.calls[0]?.[0]).toEqual(actor);
  expect((await registry.invoke('incident_fix',{operation:'status',fixId:'fix',ownerKey:'other'})).isError).toBe(true);
  expect((await registry.invoke('incident_fix',{operation:'status',fixId:'fix',currentLink:'current'})).isError).toBe(true);
  expect(execute).toHaveBeenCalledTimes(1);
});
it('is optional and excluded from core',()=>{
  const actor={clientId:'x',clientName:'x'};
  expect(new ToolRegistry({},actor).list().some(tool=>tool.name==='incident_fix')).toBe(false);
  expect(new ToolRegistry({incidentFix:{execute:async():Promise<ReturnType<typeof ok>>=>ok({})}},actor,{serverProfileProvider:():'core'=>'core'}).list().some(tool=>tool.name==='incident_fix')).toBe(false);
});
