import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { makeOperation, makeProject, PitchProof } from '../server/pitchproof';
import { Store } from '../server/store';
import { AppError, hash, randomToken } from '../server/errors';
import { assertSameOrigin, requestJson, resolveActor } from '../server/identity';
import { normalizeEntity, normalizeEvidence, insightsParameters, searchQloo } from '../server/providers/qloo';
import { directionResponseSchema, modelConfiguration, requireProviders, revisionPlan, synthesize, validateDirections } from '../server/providers/synthesis';
import { parseCommand, parseProjectInput } from '../server/validation';
import type { Command, Evidence, Project } from '../lib/pitchproof-types';
import { applyMigrations } from './helpers/database';
import { campaign, modelPilotProposal, geminiResponse, isCampaignReview } from './helpers/campaign';
const input = { brief: { product: 'Stride', description: 'Running shoes made for city running', category: 'Running footwear', market: 'London', audience: 'City runners', objective: 'Launch', constraints: '', website: '', productFacts: [{ id: 'F1', text: 'The supplied product is a running shoe.', source: 'user_supplied', sourceUrl: null }], callToAction: 'Explore the campaign' }, references: [{query:'Nike',role:'competitor'},{query:'Aesop',role:'aesthetic'},{query:'Patagonia',role:'audience'}] } as const;
const make = () => makeProject(parseProjectInput(input));
test('agencies can label multiple distinct reference brands with the same role',()=>{
  const sameRole={...input,references:input.references.map(reference=>({...reference,role:'competitor'}))};
  const parsed=parseProjectInput(sameRole);
  assert.equal(parsed.references.length,3);
  assert.ok(parsed.references.every(reference=>reference.role==='competitor'));
});
function confirmed(): Project { const p=make(); p.references.forEach((r,i)=>r.entity={id:`entity-${i}`,name:r.query,type:'urn:entity:brand',description:'',image:null,url:null}); return p; }
function command(p: Project, value: Command, commandId = randomToken()) { return { ...value, expectedVersion:p.version, commandId }; }
let mf: Miniflare; let db: D1Database; let store: Store;
before(async()=>{
  mf = new Miniflare({ modules:true, script:'export default { fetch() { return new Response("ok"); } }', compatibilityDate:'2026-05-01', d1Databases:['DB'] });
  db = await mf.getD1Database('DB') as unknown as D1Database;
  await applyMigrations(db);
  store = new Store(db);
});
after(async()=>{ await mf.dispose(); });
test('insufficient evidence cannot retry the same impossible synthesis or spend another provider call', async()=>{
  const p=confirmed(); p.operation=makeOperation(p,'research');
  p.operation.steps=p.operation.steps.map(step=>({...step,status:'complete',evidenceIds:[],error:'No supporting evidence returned'}));
  p.operation.phase='synthesis'; p.operation.state='failed'; p.operation.failureCode='INSUFFICIENT_EVIDENCE'; p.status='error';
  await store.create('sparse-retry-owner',p);
  const service=new PitchProof(store,{QLOO_API_KEY:'synthetic-key',MODEL_API_KEY:'synthetic-model-key'});
  const before=await db.prepare('SELECT SUM(calls) AS total FROM provider_usage').first<{total:number|null}>();
  await assert.rejects(()=>service.execute('sparse-retry-owner',p.id,command(p,{action:'retry'})),error=>error instanceof AppError&&error.code==='INSUFFICIENT_EVIDENCE');
  const after=await db.prepare('SELECT SUM(calls) AS total FROM provider_usage').first<{total:number|null}>();
  assert.equal(after?.total,before?.total);
  assert.equal((await store.read('sparse-retry-owner',p.id)).operation?.state,'failed');
});
test('Qloo normalization retains metric semantics and only supported geography', ()=>{
  assert.equal(normalizeEntity({entity_id:'x',name:'Example',properties:{image:{url:'javascript:alert(1)'},url:'https://example.com',description:'A real description'}})?.image,null);
  assert.equal(normalizeEntity({entity_id:'x',name:'Example',properties:{image:{url:'https://example.com/photo.jpg'}}})?.image,'https://example.com/photo.jpg');
  const p=confirmed(); const op=makeOperation(p,'research'); const step=op.steps[0];
  const evidence=normalizeEvidence({results:{entities:[{entity_id:'result-1',name:'Result',query:{measurements:{affinity:0.62}}}]}},op,step);
  assert.deepEqual(evidence[0].score,{value:0.62,metric:'query.measurements.affinity'});
  assert.equal(evidence[0].context.geographyApplied,false);
  assert.match(evidence[0].observation,/not measured customers/);
  assert.equal(insightsParameters('artist',['x'],'London')['filter.location.query'],undefined);
  assert.equal(insightsParameters('place',['x'],'London')['filter.location.query'],'London');
});
test('missing provider credentials fail without synthetic evidence',async()=>{
  assert.throws(()=>requireProviders({}),e=>e instanceof AppError && e.code==='QLOO_NOT_CONFIGURED');
  await assert.rejects(()=>searchQloo(undefined,'Nike'),e=>e instanceof AppError&&e.code==='QLOO_NOT_CONFIGURED');
  assert.equal(modelConfiguration({MODEL_API_KEY:'x'}).model,'gemini-2.5-flash');
  assert.equal(modelConfiguration({MODEL_API_KEY:'x',MODEL_PROVIDER:'arbitrary'}).configured,false);
});
test('synthesis rejects hallucinated citations and duplicate creative directions',()=>{
  const p=confirmed(); const op=makeOperation(p,'research');
  const evidence=op.steps.slice(0,2).flatMap(step=>normalizeEvidence({results:{entities:Array.from({length:3},(_,index)=>({entity_id:`observed-${index}`,name:`Observed ${index}`}))}},op,step));
  evidence.forEach((record,index)=>record.id=`real-${index+1}`);
  const direction={title:'One direction',hook:'Creative hook',audienceHypothesis:'A hypothesis',strategy:'A strategy',visuals:{description:'Visual treatment',palette:['#112233','#445566','#778899'],references:[evidence[0].entity.name]},channels:['Social'],evidenceIds:['E1','E2'],productFactIds:['F1'],campaign:campaign(['E1','E2']),testPlan:modelPilotProposal(),limitations:['Associations are not causal','Customers must validate']};
  const output={directions:[direction,{...direction,title:'Two direction',hook:'Second creative hook',campaign:campaign(['E1','E2'],1)},{...direction,title:'Three direction',hook:'Third creative hook',campaign:campaign(['E1','E2'],2)}]};
  const validated=validateDirections(output,evidence,op,p);
  assert.equal(validated.length,3);
  assert.deepEqual(validated[0].claims,evidence.slice(0,2).map(record=>({text:record.observation,evidenceIds:[record.id]})));
  const schema=JSON.parse(JSON.stringify(directionResponseSchema(['E1','E2'],['F1'])));
  assert.equal(schema.properties.directions.items.properties.evidenceIds.items.type,'string');
  assert.deepEqual(schema.properties.directions.items.properties.evidenceIds.items.enum,['E1','E2']);
  assert.deepEqual(schema.properties.directions.items.properties.productFactIds.items.enum,['F1']);
  assert.equal(schema.properties.directions.items.properties.campaign.properties.productRole,undefined);
  assert.equal(schema.properties.directions.items.properties.campaign.properties.callToAction,undefined);
  assert.equal(schema.properties.directions.items.properties.visuals.properties.references.items.enum,undefined);
  assert.equal(schema.properties.directions.items.additionalProperties,false);
  assert.deepEqual(Object.keys(schema.properties.directions.items.properties.testPlan.properties).sort(),['message']);
  assert.equal(schema.properties.directions.items.properties.testPlan.additionalProperties,false);
  assert.deepEqual(schema.properties.directions.items.properties.campaign.properties.device.enum,['participation','story','product_discovery']);
  assert.equal(schema.$schema,undefined);
  assert.equal(/minLength|maxLength|pattern/.test(JSON.stringify(schema)),false);
  assert.equal(schema.properties.directions.minItems,3);
  assert.equal(schema.properties.directions.maxItems,3);
  assert.equal(schema.properties.directions.items.properties.visuals.properties.references.maxItems,5);
  assert.throws(()=>validateDirections({directions:output.directions.slice(0,2)},evidence,op,p),e=>e instanceof AppError&&e.code==='MODEL_RESPONSE');
  const oversized=structuredClone(output);oversized.directions[0].channels=['x'.repeat(151)];
  assert.throws(()=>validateDirections(oversized,evidence,op,p),e=>e instanceof AppError&&e.code==='MODEL_RESPONSE');
  const invented=structuredClone(output);Object.assign(invented.directions[0],{claims:[{text:'The shoe provides comfort and durability.',evidenceIds:['real-1']}]});
  assert.throws(()=>validateDirections(invented,evidence,op,p),e=>e instanceof AppError&&e.code==='MODEL_RESPONSE');
  const seedReference=structuredClone(output);seedReference.directions[0].visuals.references=['Nike'];
  assert.equal(validateDirections(seedReference,evidence,op,p).length,3);
  const outside=structuredClone(output);outside.directions[0].visuals.references=['Unretrieved movie'];
  assert.throws(()=>validateDirections(outside,evidence,op,p),e=>e instanceof AppError&&e.code==='UNSUPPORTED_VISUAL_REFERENCE');
  const repeated=structuredClone(output);repeated.directions[0].evidenceIds=['E1','E1'];
  assert.throws(()=>validateDirections(repeated,evidence,op,p),e=>e instanceof AppError&&e.code==='INVALID_CITATIONS');
  assert.throws(()=>validateDirections({directions:[direction,direction,direction]},evidence,op,p),e=>e instanceof AppError&&e.code==='DUPLICATE_DIRECTIONS');
  const bad=structuredClone(output); bad.directions[0].evidenceIds=['invented','E2'];
  assert.throws(()=>validateDirections(bad,evidence,op,p),e=>e instanceof AppError&&e.code==='INVALID_CITATIONS');
  const multilingual=structuredClone(output);
  multilingual.directions.forEach((item,index)=>{item.title=['城市夜跑','邻里同行','日常创意'][index];item.hook=['कला यात्रा','किला यात्रा','काली यात्रा'][index];});
  assert.equal(validateDirections(multilingual,evidence,op,p).length,3);
  multilingual.directions[1].title=multilingual.directions[0].title;
  assert.throws(()=>validateDirections(multilingual,evidence,op,p),e=>e instanceof AppError&&e.code==='DUPLICATE_DIRECTIONS');
  multilingual.directions[1].title='另一个方向';
  multilingual.directions[1].hook=multilingual.directions[0].hook;
  assert.throws(()=>validateDirections(multilingual,evidence,op,p),e=>e instanceof AppError&&e.code==='DUPLICATE_DIRECTIONS');
});
test('unfinished Gemini output is reported before parsing a partial brief',async()=>{
  const p=confirmed();const op=makeOperation(p,'research');
  const rows=Array.from({length:3},(_,i)=>({entity_id:`entity-${i}`,name:`Observed ${i}`}));
  const evidence=op.steps.slice(0,2).flatMap(step=>normalizeEvidence({results:{entities:rows}},op,step));
  const original=globalThis.fetch;
  globalThis.fetch=async()=>Response.json({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'{"directions":['}]}}]});
  try { await assert.rejects(()=>synthesize({MODEL_API_KEY:'test'},op,evidence,p),e=>e instanceof AppError&&e.code==='MODEL_OUTPUT_LIMIT'); }
  finally { globalThis.fetch=original; }
});
test('canceling replacement research preserves the edited draft and its previous generation',async()=>{
 for(const failed of [false,true]){
  const p=confirmed();
  p.generations=[{id:'prior-generation',createdAt:p.createdAt,model:'synthetic-test',directions:[],evidenceIds:[],parentDirectionId:null,feedback:null,brief:structuredClone(p.brief)}];
  p.brief={...p.brief,product:'Updated product'};p.title='Updated product';
  p.operation=makeOperation(p,'research');p.status=failed?'error':'researching';
  if(failed){p.operation.state='failed';p.operation.error='Synthetic provider failure';}
  const owner=`replacement-cancel-${failed}`;await store.create(owner,p);
  const result=await new PitchProof(store,{}).execute(owner,p.id,command(p,{action:'cancel'}));
  assert.equal(result.status,'draft');assert.equal(result.operation,null);
  assert.equal(result.brief.product,'Updated product');assert.equal(result.generations[0].brief.product,'Stride');
 }
});
test('canceling a revision keeps the completed campaign available',async()=>{
 const p=confirmed();p.generations=[{id:'prior-generation',createdAt:p.createdAt,model:'synthetic-test',directions:[],evidenceIds:[],parentDirectionId:null,feedback:null,brief:structuredClone(p.brief)}];
 p.operation=makeOperation(p,'revision','More local community','parent-direction',['place','podcast']);p.status='researching';
 const owner='revision-cancel';await store.create(owner,p);
 const result=await new PitchProof(store,{}).execute(owner,p.id,command(p,{action:'cancel'}));
 assert.equal(result.status,'ready');assert.equal(result.operation,null);assert.equal(result.generations.length,1);
});
test('anonymous sessions have hashed cookies and other owners cannot read projects',async()=>{
  const first=await resolveActor(new Request('https://pitchproof.example/api/projects'),db); assert.match(first.cookie!,/HttpOnly; SameSite=Lax/); assert.match(first.cookie!,/Secure/);
  const cookie=first.cookie!.split(';')[0]; const token=cookie.split('=')[1];
  assert.ok(await db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').bind(await hash(token)).first());
  const second=await resolveActor(new Request('https://pitchproof.example/api/projects',{headers:{cookie}}),db); assert.equal(first.owner,second.owner);
  const p=make(); await store.create(first.owner,p);
  await assert.rejects(()=>store.read('someone-else',p.id),e=>e instanceof AppError&&e.status===404);
  const platform=await resolveActor(new Request('https://pitchproof.example/api/projects',{headers:{'oai-authenticated-user-id':'stable-id','oai-authenticated-user-email':'person@example.com'}}),db); assert.match(platform.owner,/^platform:/); assert.equal(platform.cookie,null);
});
test('same origin and bounded JSON are enforced',async()=>{
  assert.throws(()=>assertSameOrigin(new Request('https://pitchproof.example/api/projects',{method:'POST',headers:{origin:'https://attacker.example','content-type':'application/json'},body:'{}'})),e=>e instanceof AppError&&e.status===403);
  assert.doesNotThrow(()=>assertSameOrigin(new Request('https://pitchproof.example/api/projects',{method:'POST',headers:{origin:'https://pitchproof.example','content-type':'application/json'},body:'{}'})));
  await assert.rejects(()=>requestJson(new Request('https://pitchproof.example',{method:'POST',body:'x'.repeat(17000)})),e=>e instanceof AppError&&e.status===413);
});
test('CAS rejects stale writes without receipts and duplicate command is idempotent',async()=>{
  const service=new PitchProof(store,{}); const owner='cas-owner'; const p=make(); await store.create(owner,p);
  const cmd=command(p,{action:'cancel'}); const next=await service.execute(owner,p.id,cmd); assert.equal(next.version,1);
  assert.equal((await service.execute(owner,p.id,cmd)).version,1);
  await assert.rejects(()=>service.execute(owner,p.id,{...cmd,action:'start_research'}),e=>e instanceof AppError&&e.code==='COMMAND_REUSED');
  const stale=structuredClone(p); stale.title='must not replace';
  await assert.rejects(()=>store.save(owner,0,stale,{commandId:'stale-command',requestHash:'stale'}),e=>e instanceof AppError&&e.code==='STALE_VERSION');
  assert.equal(await store.receipt(owner,p.id,'stale-command','stale'),false);
  assert.notEqual((await store.read(owner,p.id)).title,'must not replace');
});
test('candidate confirmation binds owner, project, slot, and current references',async()=>{
  const owner='token-owner'; const p=make(); await store.create(owner,p); const token=randomToken(); const entity={id:'official-brand',name:'Official',type:'urn:entity:brand',description:'',image:null,url:null};
  await store.putCandidate(owner,p,0,'Official query',entity,token);
  await assert.rejects(()=>store.candidate('other',p,0,token),e=>e instanceof AppError&&e.code==='EXPIRED_CANDIDATE');
  await assert.rejects(()=>store.candidate(owner,p,1,token),e=>e instanceof AppError&&e.code==='EXPIRED_CANDIDATE');
  const updated=structuredClone(p);updated.references[0].query='Different';
  await assert.rejects(()=>store.candidate(owner,updated,0,token),e=>e instanceof AppError&&e.code==='EXPIRED_CANDIDATE');
  const service=new PitchProof(store,{}); const result=await service.execute(owner,p.id,command(p,{action:'confirm_reference',slot:0,token})); assert.equal(result.references[0].entity?.id,'official-brand');assert.equal(result.references[0].query,'Official query');
});
test('research advances run at most three queries together and preserve the complete ordered plan',async()=>{
  const owner='research-owner'; let p=confirmed(); await store.create(owner,p);
  const service=new PitchProof(store,{QLOO_API_KEY:'test-key',MODEL_API_KEY:'test-key'});
  p=await service.execute(owner,p.id,command(p,{action:'start_research'}));const plan=structuredClone(p.operation!);
  const original=globalThis.fetch;const urls:string[]=[];let inFlight=0;let peak=0;let release!:()=>void;let started!:()=>void;
  const releases:(()=>void)[]=[];let allStarted:Promise<void>;
  globalThis.fetch=async input=>{const index=urls.length;urls.push(String(input));inFlight++;peak=Math.max(peak,inFlight);const pending=new Promise<void>(resolve=>releases.push(resolve));if(inFlight===3)started();await pending;inFlight--;return Response.json({results:{entities:[{entity_id:`observed-${index}`,name:`Observed ${index}`,query:{affinity:0.34}}]}});};
  try {
    for(let batch=0;batch<3;batch++){
      release=()=>releases.splice(0).reverse().forEach(resolve=>resolve());allStarted=new Promise<void>(resolve=>started=resolve);
      const cmd=command(p,{action:'advance'});const advancing=service.execute(owner,p.id,cmd);await allStarted;
      assert.equal(urls.length,(batch+1)*3);assert.equal(inFlight,3);
      const active=await store.read(owner,p.id);assert.ok(active.operation?.leaseToken);
      await assert.rejects(()=>service.execute(owner,p.id,command(active,{action:'advance'})),error=>error instanceof AppError&&error.code==='OPERATION_BUSY');
      assert.equal((await service.execute(owner,p.id,cmd)).operation?.leaseToken,active.operation?.leaseToken);
      assert.equal(urls.length,(batch+1)*3);
      release();p=await advancing;
      assert.equal(p.evidence.length,(batch+1)*3);assert.equal(p.operation?.steps.filter(step=>step.status==='complete').length,(batch+1)*3);assert.equal(p.operation?.leaseToken,null);
      assert.equal(p.operation?.phase,batch===2?'synthesis':'research');
    }
    assert.equal(peak,3);assert.equal(plan.steps.length,9);
    assert.deepEqual(plan.steps.map(step=>[step.seedIds[0],step.category]),[['entity-0','brand'],['entity-0','place'],['entity-1','artist'],['entity-1','movie'],['entity-2','brand'],['entity-2','artist'],['entity-2','movie'],['entity-2','place'],['entity-2','podcast']]);
    assert.deepEqual(urls.map(url=>Object.fromEntries(new URL(url).searchParams)),plan.steps.map(step=>insightsParameters(step.category,step.seedIds,plan.brief.market)));
    assert.deepEqual(p.evidence.map(record=>({runId:record.runId,category:record.category,ids:record.context.referenceIds,roles:record.context.referenceRoles})),plan.steps.map(step=>({runId:plan.id,category:step.category,ids:step.seedIds,roles:step.seedRoles})));
    assert.deepEqual(p.operation!.steps.flatMap(step=>step.evidenceIds),p.evidence.map(record=>record.id));
    assert.equal(new Set(p.evidence.map(record=>record.id)).size,9);
    const usage=await db.prepare('SELECT calls FROM provider_usage WHERE owner_id=? AND day=?').bind(owner,new Date().toISOString().slice(0,10)).first<{calls:number}>();assert.equal(usage?.calls,9);
  } finally {release?.();globalThis.fetch=original;}
});
test('a failed research batch retains successful siblings and retries only unfinished queries',async()=>{
  const owner='partial-research-owner';let p=confirmed();await store.create(owner,p);const service=new PitchProof(store,{QLOO_API_KEY:randomToken(),MODEL_API_KEY:'key'});
  p=await service.execute(owner,p.id,command(p,{action:'start_research'}));const plan=structuredClone(p.operation!);const original=globalThis.fetch;const urls:string[]=[];
  let release!:()=>void;let started!:()=>void;const pending=new Promise<void>(resolve=>release=resolve);const allStarted=new Promise<void>(resolve=>started=resolve);
  globalThis.fetch=async input=>{const index=urls.length;urls.push(String(input));if(urls.length===3)started();if(index===1){await pending;return new Response('secret rate limit',{status:429});}if(index===2)return new Response('secret invalid JSON');return Response.json({results:{entities:[{entity_id:'retained',name:'Retained'}]}});};
  try{
    const advancing=service.execute(owner,p.id,command(p,{action:'advance'}));await allStarted;release();p=await advancing;
    assert.equal(urls.length,3);assert.equal(p.status,'error');assert.equal(p.operation?.failureCode,'PROVIDER_RATE_LIMIT');assert.doesNotMatch(p.error!,/secret/);assert.equal(p.operation?.leaseToken,null);
    assert.deepEqual(p.operation?.steps.map(step=>step.status),['complete','failed','failed','pending','pending','pending','pending','pending','pending']);
    assert.equal(p.evidence.length,1);const retained=structuredClone(p.evidence);
    assert.deepEqual((await store.read(owner,p.id)).evidence,retained);
    p=await service.execute(owner,p.id,command(p,{action:'retry'}));assert.equal(p.status,'researching');assert.equal(p.operation?.steps[0].status,'complete');
    globalThis.fetch=async input=>{urls.push(String(input));return Response.json({results:{entities:[{entity_id:`retry-${urls.length}`,name:'Retry result'}]}});};
    p=await service.execute(owner,p.id,command(p,{action:'advance'}));
    assert.deepEqual(urls.slice(3).map(url=>Object.fromEntries(new URL(url).searchParams)),plan.steps.slice(1,4).map(step=>insightsParameters(step.category,step.seedIds,plan.brief.market)));
    assert.deepEqual(p.evidence.slice(0,1),retained);assert.equal(p.evidence.length,4);assert.equal(p.operation?.steps.filter(step=>step.status==='complete').length,4);
    p=await service.execute(owner,p.id,command(p,{action:'cancel'}));assert.equal(p.operation,null);assert.equal(p.evidence.length,4);
  }finally{release?.();globalThis.fetch=original;}
});
test('canceled and replaced operations discard an already running batch',async()=>{
 const original=globalThis.fetch;
 try{
  for(const replace of [false,true]){
   const owner=`cancel-owner-${replace}`;let p=confirmed();await store.create(owner,p);const service=new PitchProof(store,{QLOO_API_KEY:randomToken(),MODEL_API_KEY:'key'});p=await service.execute(owner,p.id,command(p,{action:'start_research'}));
   let release!:()=>void;let called!:()=>void;let calls=0;const started=new Promise<void>(resolve=>called=resolve);const pending=new Promise<void>(resolve=>release=resolve);
   globalThis.fetch=async()=>{calls++;if(calls===3)called();await pending;return Response.json({results:{entities:[{entity_id:'late',name:'Late result'}]}});};
   try{
    const advancing=service.execute(owner,p.id,command(p,{action:'advance'}));await started;const current=await store.read(owner,p.id);let canceled=await service.execute(owner,p.id,command(current,{action:'cancel'}));if(replace)canceled=await service.execute(owner,p.id,command(canceled,{action:'start_research'}));
    release();const result=await advancing;assert.equal(result.operation?.id??null,canceled.operation?.id??null);assert.equal(result.evidence.length,0);assert.equal(calls,3);assert.equal((await store.read(owner,p.id)).evidence.length,0);
   }finally{release?.();}
  }
 }finally{globalThis.fetch=original;}
});
test('simultaneous advances send only one leased batch',async()=>{
 const owner='concurrent-research-owner';let p=confirmed();await store.create(owner,p);const service=new PitchProof(store,{QLOO_API_KEY:randomToken(),MODEL_API_KEY:'key'});p=await service.execute(owner,p.id,command(p,{action:'start_research'}));
 const original=globalThis.fetch;let calls=0;let release!:()=>void;let started!:()=>void;const pending=new Promise<void>(resolve=>release=resolve);const allStarted=new Promise<void>(resolve=>started=resolve);
 globalThis.fetch=async()=>{calls++;if(calls===3)started();await pending;return Response.json({results:{entities:[{entity_id:'winner',name:'Winner'}]}});};
 try{
  const outcomes=Promise.allSettled([service.execute(owner,p.id,command(p,{action:'advance'})),service.execute(owner,p.id,command(p,{action:'advance'}))]);await allStarted;release();const result=await outcomes;
  assert.equal(result.filter(item=>item.status==='fulfilled').length,1);const rejected=result.find(item=>item.status==='rejected');assert.ok(rejected?.status==='rejected'&&rejected.reason instanceof AppError&&['STALE_VERSION','OPERATION_BUSY'].includes(rejected.reason.code));
  assert.equal(calls,3);assert.equal((await store.read(owner,p.id)).evidence.length,3);
 }finally{release?.();globalThis.fetch=original;}
});
test('a completion write conflict preserves concurrent agency edits without repeating a batch',async()=>{
 const owner='completion-conflict-owner';let p=confirmed();await store.create(owner,p);
 let contended=false;
 class ContendedStore extends Store {
  override async save(actor:string,previousVersion:number,project:Project,receipt?:{commandId:string;requestHash:string}) {
   if(!receipt&&project.evidence.length===3&&!contended){
    contended=true;const concurrent=await store.read(actor,project.id);concurrent.title='Concurrent agency update';await store.save(actor,concurrent.version,concurrent);
   }
   return super.save(actor,previousVersion,project,receipt);
  }
 }
 const service=new PitchProof(new ContendedStore(db),{QLOO_API_KEY:randomToken(),MODEL_API_KEY:'key'});p=await service.execute(owner,p.id,command(p,{action:'start_research'}));
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({results:{entities:[{entity_id:`observed-${calls}`,name:`Observed ${calls}`}]}});};
 try{
  const result=await service.execute(owner,p.id,command(p,{action:'advance'}));
  assert.equal(contended,true);assert.equal(calls,3);assert.equal(result.title,'Concurrent agency update');assert.equal(result.evidence.length,3);assert.equal(new Set(result.evidence.map(record=>record.id)).size,3);assert.equal(result.operation?.steps.filter(step=>step.status==='complete').length,3);assert.equal(result.operation?.leaseToken,null);assert.deepEqual((await store.read(owner,p.id)).evidence,result.evidence);
 }finally{globalThis.fetch=original;}
});
test('results from an expired lease cannot overwrite its replacement batch',async()=>{
 const owner='expired-research-owner';let p=confirmed();await store.create(owner,p);const service=new PitchProof(store,{QLOO_API_KEY:randomToken(),MODEL_API_KEY:'key'});p=await service.execute(owner,p.id,command(p,{action:'start_research'}));
 const original=globalThis.fetch;let calls=0;let release!:()=>void;let started!:()=>void;const pending=new Promise<void>(resolve=>release=resolve);const allStarted=new Promise<void>(resolve=>started=resolve);
 globalThis.fetch=async()=>{const index=++calls;if(calls===3)started();if(index<=3)await pending;return Response.json({results:{entities:[{entity_id:index<=3?'obsolete':'replacement',name:index<=3?'Obsolete':'Replacement'}]}});};
 try{
  const advancing=service.execute(owner,p.id,command(p,{action:'advance'}));await allStarted;const expired=await store.read(owner,p.id);expired.operation!.leaseUntil=0;await store.save(owner,expired.version,expired);
  const replacement=await service.execute(owner,p.id,command(expired,{action:'advance'}));assert.equal(replacement.evidence.length,3);assert.ok(replacement.evidence.every(record=>record.entity.id==='replacement'));
  release();const result=await advancing;assert.equal(calls,6);assert.deepEqual(result.evidence,replacement.evidence);assert.deepEqual((await store.read(owner,p.id)).evidence,replacement.evidence);
 }finally{release?.();globalThis.fetch=original;}
});
test('a research quota failure retains admitted results and leaves unattempted steps pending',async()=>{
 const owner='research-quota-owner';const p=confirmed();p.operation=makeOperation(p,'research');p.status='researching';await store.create(owner,p);
 await db.prepare('INSERT INTO provider_usage(owner_id,day,calls) VALUES(?,?,119)').bind(owner,new Date().toISOString().slice(0,10)).run();
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({results:{entities:[{entity_id:'admitted',name:'Admitted'}]}});};
 try{
  const service=new PitchProof(store,{QLOO_API_KEY:randomToken(),MODEL_API_KEY:'key'});let result=await service.execute(owner,p.id,command(p,{action:'advance'}));
  assert.equal(calls,1);assert.equal(result.operation?.failureCode,'DAILY_LIMIT');assert.equal(result.evidence.length,1);assert.deepEqual(result.operation?.steps.map(step=>step.status),['complete','failed','pending','pending','pending','pending','pending','pending','pending']);
  const usage=await db.prepare('SELECT calls FROM provider_usage WHERE owner_id=? AND day=?').bind(owner,new Date().toISOString().slice(0,10)).first<{calls:number}>();assert.equal(usage?.calls,120);
  result=await service.execute(owner,p.id,command(result,{action:'retry'}));result=await service.execute(owner,p.id,command(result,{action:'advance'}));assert.equal(calls,1);assert.equal(result.operation?.failureCode,'DAILY_LIMIT');assert.equal(result.evidence.length,1);
 }finally{globalThis.fetch=original;}
});
test('a batch exceeding project history limits records failure without reinserting its evidence',async()=>{
 const owner='research-history-owner';const p=confirmed();p.operation=makeOperation(p,'research');p.status='researching';
 const [record]=normalizeEvidence({results:{entities:[{entity_id:'historic',name:'Historical'}]}},p.operation,p.operation.steps[0]);p.evidence=Array.from({length:179},(_,index)=>({...record,id:`historic-${index}`,observation:'A retained historical observation'}));await store.create(owner,p);
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({results:{entities:[{entity_id:'overflow',name:'Overflow'}]}});};
 try{
  const result=await new PitchProof(store,{QLOO_API_KEY:randomToken(),MODEL_API_KEY:'key'}).execute(owner,p.id,command(p,{action:'advance'}));assert.equal(calls,3);assert.equal(result.operation?.failureCode,'PROJECT_LIMIT');assert.equal(result.operation?.leaseToken,null);assert.deepEqual(result.evidence,p.evidence);assert.ok(result.operation?.steps.every(step=>step.status==='pending'));assert.deepEqual((await store.read(owner,p.id)).evidence,p.evidence);
 }finally{globalThis.fetch=original;}
});
test('editing inputs preserves historical evidence and unconfirms only changed references',async()=>{
 const owner='edit-owner';const p=confirmed();p.evidence=[{id:'historic'}] as Evidence[];await store.create(owner,p);const service=new PitchProof(store,{});const refs=p.references.map(({query,role})=>({query,role}));refs[1].query='New aesthetic';const result=await service.execute(owner,p.id,command(p,{action:'update_brief',brief:{...p.brief,product:'Updated'},references:refs}));assert.equal(result.evidence[0].id,'historic');assert.ok(result.references[0].entity);assert.equal(result.references[1].entity,null);assert.equal(result.title,'Updated');
});
test('command parsing accepts valid actions and rejects malformed control and feedback',()=>{
 assert.equal(parseCommand({action:'advance',expectedVersion:0,commandId:'command-123'}).action,'advance');
 assert.throws(()=>parseCommand({action:'revise',directionId:'x',feedback:'bad',expectedVersion:0,commandId:'command-123'}));
 assert.throws(()=>parseCommand({action:'advance',expectedVersion:-1,commandId:'command-123'}));
});
test('complete research, synthesis, feedback-led revision and decisions persist with immutable history',async()=>{
 const owner='workflow-owner';let p=confirmed();await store.create(owner,p);const service=new PitchProof(store,{QLOO_API_KEY:'test',MODEL_API_KEY:'test'});const original=globalThis.fetch;let qlooCalls=0;let plannerCalls=0;let modelCalls=0;let reviewCalls=0;let revisionPrompt='';
 globalThis.fetch=async (url,init)=>{
  if(String(url).includes('/v2/insights')){qlooCalls++;return Response.json({results:{entities:Array.from({length:6},(_,i)=>({entity_id:`research-${qlooCalls}-${i}`,name:`Observed ${qlooCalls}/${i}`,query:{affinity:0.5}}))}});}
  const body=JSON.parse(String(init?.body));if(isCampaignReview(body)){reviewCalls++;return geminiResponse(body,{issues:[]});}const text=body.contents[0].parts[0].text;
  if(text.startsWith('Choose the TWO')){plannerCalls++;assert.match(text,/local podcast campaign/);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({categories:['podcast','place']})}]}}]});}
  modelCalls++;const payload=JSON.parse(text);if(payload.feedback)revisionPrompt=text;const ids=payload.evidence.map((e:Evidence)=>e.id);
  assert.equal(body.generationConfig.responseMimeType,'application/json');
  assert.deepEqual(body.generationConfig.responseJsonSchema.properties.directions.items.properties.evidenceIds.items.enum,ids);
  const directions=Array.from({length:3},(_,i)=>({title:`Strategy ${i+1} generation ${modelCalls}`,hook:`Creative hook ${i+1}`,audienceHypothesis:'Taste reference hypothesis to validate',strategy:`Campaign strategy ${i+1}`,visuals:{description:`Visual treatment ${i+1}`,palette:['#112233','#445566','#778899'],references:[payload.evidence[0].entity.name]},channels:['Organic social'],evidenceIds:[ids[0],ids.at(-1)],productFactIds:['F1'],campaign:campaign([ids[0],ids.at(-1)],i),testPlan:modelPilotProposal(),limitations:['Associations are not purchase probabilities','Validate with actual customers']}));
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'Private reasoning is not structured output.'},{text:JSON.stringify({directions})}]}}]});
 };
 try{
  p=await service.execute(owner,p.id,command(p,{action:'start_research'}));while(p.operation)p=await service.execute(owner,p.id,command(p,{action:'advance'}));assert.equal(p.status,'ready');assert.equal(p.generations.length,1);assert.equal(qlooCalls,9);assert.equal(modelCalls,1);assert.equal(reviewCalls,1);assert.equal(p.evidence.length,54);
  assert.deepEqual(new Set(p.generations[0].evidenceIds),new Set(p.evidence.map(item=>item.id)),'The generation must expose collected evidence even when directions do not cite it.');
  assert.deepEqual(p.generations[0].references,p.references,"A generation retains its confirmed reference entities independently of future brief edits.");
  const originalGeneration=JSON.stringify(p.generations[0]);const oldEvidence=JSON.stringify(p.evidence);const parentId=p.generations[0].directions[0].id;
  p=await service.execute(owner,p.id,command(p,{action:'choose',directionId:parentId}));assert.equal(p.selectedDirectionId,parentId);
  p=await service.execute(owner,p.id,command(p,{action:'annotate',targetId:parentId,text:'Brand review note'}));assert.equal(p.annotations[parentId],'Brand review note');
  p=await service.execute(owner,p.id,command(p,{action:'revise',directionId:parentId,feedback:'Explore a local podcast campaign with clearer community voice'}));assert.equal(plannerCalls,1);assert.deepEqual([...new Set(p.operation!.steps.map(s=>s.category))],['podcast','place']);while(p.operation)p=await service.execute(owner,p.id,command(p,{action:'advance'}));
  assert.equal(p.generations.length,2);assert.equal(p.selectedDirectionId,null);assert.equal(p.generations[1].parentDirectionId,parentId);assert.match(p.generations[1].feedback!,/local podcast campaign/);assert.match(revisionPrompt,/local podcast campaign/);assert.equal(JSON.stringify(p.generations[0]),originalGeneration);assert.equal(JSON.stringify(p.evidence.slice(0,54)),oldEvidence);assert.equal(p.annotations[parentId],'Brand review note');assert.equal(qlooCalls,12);assert.equal(reviewCalls,2);
  const revisionIds=new Set(p.evidence.slice(54).map(e=>e.id));assert.ok(p.generations[1].evidenceIds.every(id=>revisionIds.has(id)));
  p=await service.execute(owner,p.id,command(p,{action:'reject',directionId:parentId,reason:'The new direction better fits the brief'}));assert.equal(p.selectedDirectionId,null);assert.equal(p.decisions.at(-1)?.decision,'rejected');assert.equal((await store.read(owner,p.id)).generations.length,2);
 }finally{globalThis.fetch=original;}
});
test('simultaneous CAS commands have one durable winner and only its receipt',async()=>{
 const owner='concurrent-owner';const p=make();await store.create(owner,p);const a=structuredClone(p);const b=structuredClone(p);a.title='First';b.title='Second';
 const outcomes=await Promise.allSettled([store.save(owner,0,a,{commandId:'first-command',requestHash:'first'}),store.save(owner,0,b,{commandId:'second-command',requestHash:'second'})]);
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);const result=await store.read(owner,p.id);assert.equal(result.version,1);assert.equal(Number(await store.receipt(owner,p.id,'first-command','first'))+Number(await store.receipt(owner,p.id,'second-command','second')),1);
});

test('unrelated slot confirmations preserve candidates and changed relevant inputs invalidate them',async()=>{
 const owner='independent-slot-owner';let p=make();await store.create(owner,p);const first=randomToken();const second=randomToken();const entity=(id:string)=>({id,name:id,type:'urn:entity:brand',description:'',image:null,url:null});await store.putCandidate(owner,p,0,p.references[0].query,entity('first'),first);await store.putCandidate(owner,p,1,p.references[1].query,entity('second'),second);const service=new PitchProof(store,{});p=await service.execute(owner,p.id,command(p,{action:'confirm_reference',slot:0,token:first}));p=await service.execute(owner,p.id,command(p,{action:'confirm_reference',slot:1,token:second}));assert.equal(p.references[0].entity?.id,'first');assert.equal(p.references[1].entity?.id,'second');const third=randomToken();await store.putCandidate(owner,p,2,p.references[2].query,entity('third'),third);const changed=structuredClone(p);changed.brief.market='Paris';await assert.rejects(()=>store.candidate(owner,changed,2,third),e=>e instanceof AppError&&e.code==='EXPIRED_CANDIDATE');
});
test('site-wide budget stops fresh anonymous owners after the daily cap without charging owner usage',async()=>{
 const day=new Date().toISOString().slice(0,10);await db.prepare('INSERT INTO provider_usage(owner_id,day,calls) VALUES(?,?,499) ON CONFLICT(owner_id,day) DO UPDATE SET calls=499').bind('__site_total__',day).run();await store.budget('last-allowed-owner');await assert.rejects(()=>store.budget('fresh-anonymous-owner'),e=>e instanceof AppError&&e.code==='SITE_DAILY_LIMIT');assert.equal(await db.prepare('SELECT calls FROM provider_usage WHERE owner_id=? AND day=?').bind('fresh-anonymous-owner',day).first(),null);await db.prepare('UPDATE provider_usage SET calls=0 WHERE owner_id=? AND day=?').bind('__site_total__',day).run();await db.prepare('INSERT INTO provider_usage(owner_id,day,calls) VALUES(?,?,120)').bind('owner-at-cap',day).run();await assert.rejects(()=>store.budget('owner-at-cap'),e=>e instanceof AppError&&e.code==='DAILY_LIMIT');const global=await db.prepare('SELECT calls FROM provider_usage WHERE owner_id=? AND day=?').bind('__site_total__',day).first<{calls:number}>();assert.equal(global?.calls,0);
});

test('empty successful research is a disclosed completed gap while other categories continue',async()=>{
 const owner='sparse-owner';let p=confirmed();await store.create(owner,p);const service=new PitchProof(store,{QLOO_API_KEY:randomToken(),MODEL_API_KEY:'key'});p=await service.execute(owner,p.id,command(p,{action:'start_research'}));const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({results:{entities:calls===1?[]:[{entity_id:'available',name:'Available evidence'}]}});};
 try{p=await service.execute(owner,p.id,command(p,{action:'advance'}));assert.equal(p.status,'researching');assert.equal(p.operation?.steps[0].status,'complete');assert.match(p.operation?.steps[0].error??'',/evidence gap/);assert.deepEqual(p.operation?.steps[0].evidenceIds,[]);assert.equal(calls,3);assert.equal(p.evidence.length,2);p=await service.execute(owner,p.id,command(p,{action:'advance'}));assert.equal(calls,6);assert.equal(p.evidence.length,5);assert.equal(p.operation?.steps.filter(s=>s.status==='complete').length,6);}finally{globalThis.fetch=original;}
});
test('empty Qloo search returns no candidates including documented no-result404',async()=>{
 const original=globalThis.fetch;try{globalThis.fetch=async()=>Response.json({results:[]});assert.deepEqual(await searchQloo('key','Unknown'),[]);globalThis.fetch=async()=>new Response('No results',{status:404});assert.deepEqual(await searchQloo('other-key','Unknown'),[]);}finally{globalThis.fetch=original;}
});

test('explicit positive research category requests are retained without a model override',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('No planning call should override an explicit research pair');};
 try {assert.deepEqual(await revisionPlan({MODEL_API_KEY:'test'},'Revise the tone. Research fresh artist and movie associations. Keep the same audience.',confirmed(),'existing-direction'),['artist','movie']);assert.equal(calls,0);} finally {globalThis.fetch=original;}
});

function pendingSynthesis() {
 const p=confirmed();const operation=makeOperation(p,'research');
 const rows=Array.from({length:3},(_,i)=>({entity_id:`observed-${i}`,name:`Observed ${i}`}));
 const evidence=operation.steps.slice(0,2).flatMap(step=>normalizeEvidence({results:{entities:rows}},operation,step));
 operation.phase='synthesis';operation.steps=operation.steps.map(step=>({...step,status:'complete',evidenceIds:evidence.filter(record=>record.category===step.category).map(record=>record.id)}));
 p.operation=operation;p.evidence=evidence;p.status='researching';
 const direction={id:'retained-direction',title:'Retained campaign',hook:'Retained campaign hook',audienceHypothesis:'A retained hypothesis',strategy:'A retained strategy',visuals:{description:'Retained treatment',palette:['#112233'],references:['Nike']},channels:['Social'],claims:[{text:evidence[0].observation,evidenceIds:[evidence[0].id]}],testPlan:{hypothesis:'A retained test',variants:['Control','Treatment'],metric:'Click rate',successCriterion:'Agency rule'},limitations:['A retained limitation']};
 p.generations=[{id:'retained-generation',createdAt:p.createdAt,model:'synthetic-legacy',directions:[direction],evidenceIds:evidence.map(record=>record.id),parentDirectionId:null,feedback:null,brief:structuredClone(p.brief)}];
 p.selectedDirectionId=direction.id;
 return p;
}
function campaignOutput(payload: {evidence:{id:string;entity:{name:string}}[]}) {
 const ids=[payload.evidence[0].id,payload.evidence.at(-1)!.id];
 return {directions:Array.from({length:3},(_,i)=>({title:`Proposed campaign ${i}`,hook:`Proposed campaign hook ${i}`,audienceHypothesis:'A creative audience hypothesis',strategy:'Connect the daily running ritual with the supplied footwear',campaign:campaign(ids,i),visuals:{description:'An original calendar and running sequence',palette:['#112233','#445566','#778899'],references:[payload.evidence[0].entity.name]},channels:['Social'],evidenceIds:ids,productFactIds:['F1'],testPlan:modelPilotProposal(),limitations:['Aggregate associations do not prove customer preference','Confirm product facts and production rights before use']}))};
}

test('review rejection and reviewer failures preserve all research and the previous generation',async()=>{
 const original=globalThis.fetch;
 const cases=[
  {label:'malformed JSON',code:'MODEL_REVIEW_RESPONSE',response:'not JSON'},
  {label:'missing issues',code:'MODEL_REVIEW_RESPONSE',response:{}},
  {label:'unsupported issue code',code:'MODEL_REVIEW_RESPONSE',response:{issues:[{directionIndex:1,code:'unknown',reason:'Invalid review code'}]}},
  {label:'out of bounds direction',code:'MODEL_REVIEW_RESPONSE',response:{issues:[{directionIndex:4,code:'weak_campaign',reason:'Invalid direction index'}]}},
  {label:'provider unavailable',code:'PROVIDER_ERROR',response:null},
 ];
 try{
  for(const [index,value] of cases.entries()){
   const owner=`review-failure-${index}`;const p=pendingSynthesis();await store.create(owner,p);
   const before=structuredClone(p);let generationRequests=0;let reviewRequests=0;
   globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(isCampaignReview(body)){reviewRequests++;return value.response===null?new Response('Unavailable',{status:503}):geminiResponse(body,value.response);}
    generationRequests++;return geminiResponse(body,campaignOutput(JSON.parse(body.input)));
   };
   const service=new PitchProof(store,{QLOO_API_KEY:'synthetic-key',MODEL_API_KEY:'synthetic-key',MODEL_NAME:'gemini-3.5-flash-lite'});
   const result=await service.execute(owner,p.id,command(p,{action:'advance'}));
   assert.equal(result.status,'error',value.label);assert.equal(result.operation?.state,'failed',value.label);
   assert.equal(result.operation?.failureCode,value.code,value.label);
   assert.doesNotMatch(result.operation?.error??'',/A concrete synthetic review defect|not JSON|Invalid review code|Invalid direction index|Unavailable/,'Provider-authored review text must not be exposed');
   if(value.code==='CAMPAIGN_REVIEW') assert.match(result.operation?.error??'',new RegExp(`found ${value.label} in direction 2`));
   assert.deepEqual(result.generations,before.generations,value.label);assert.deepEqual(result.evidence,before.evidence,value.label);assert.equal(result.selectedDirectionId,before.selectedDirectionId,value.label);
   const persisted=await store.read(owner,p.id);assert.deepEqual(persisted.generations,before.generations,value.label);assert.deepEqual(persisted.evidence,before.evidence,value.label);
   assert.equal(generationRequests,1);assert.ok(reviewRequests>=1);
  }
 }finally{globalThis.fetch=original;}
});

test('irrelevant quality findings do not block or trigger a repair',async()=>{
 const owner='quality-warning'; const p=pendingSynthesis(); await store.create(owner,p);
 const original=globalThis.fetch; let generations=0; let reviews=0;
 const codes=['feedback_conflict','weak_campaign','evidence_gap','confounded_test'];
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));
  if(isCampaignReview(body)){ reviews++; return geminiResponse(body,{issues:codes.map(code=>({directionIndex:2,code,reason:'Private reviewer text'}))}); }
  generations++; const input=JSON.parse(body.input);
  if(generations===2) { assert.ok(input.serverValidationFeedback.includes('CAMPAIGN_REVIEW')); assert.ok(!input.serverValidationFeedback.includes('UNSUPPORTED_PRODUCT_COPY')); }
  return geminiResponse(body,campaignOutput(input));
 };
 try {
  const result=await new PitchProof(store,{QLOO_API_KEY:'synthetic-key',MODEL_API_KEY:'synthetic-key',MODEL_NAME:'gemini-3.5-flash-lite'}).execute(owner,p.id,command(p,{action:'advance'}));
  assert.equal(result.status,'ready'); assert.equal(generations,1); assert.equal(reviews,1);
  assert.equal(result.generations.at(-1)?.directions[1].reviewWarnings,undefined);
  assert.equal(result.generations.at(-1)?.directions[1].unverifiedClaim,undefined);
  assert.doesNotMatch(JSON.stringify(result),/Private reviewer text/);
 } finally {globalThis.fetch=original;}
});

test('claim review repairs once and flags directions still unsupported',async()=>{
 const owner='claim-repair-review'; const p=pendingSynthesis(); await store.create(owner,p);
 const original=globalThis.fetch; let generations=0; let reviews=0;
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));
  if(isCampaignReview(body)){reviews++;return geminiResponse(body,{issues:[{directionIndex:2,code:'unsupported_claim',reason:'Private unverified claim'}]});}
  generations++;const input=JSON.parse(body.input);
  if(generations===2) assert.ok(input.serverValidationFeedback.includes('CAMPAIGN_REVIEW'));
  return geminiResponse(body,campaignOutput(input));
 };
 try {
  const result=await new PitchProof(store,{QLOO_API_KEY:'synthetic-key',MODEL_API_KEY:'synthetic-key',MODEL_NAME:'gemini-3.5-flash-lite'}).execute(owner,p.id,command(p,{action:'advance'}));
  assert.equal(result.status,'ready'); assert.equal(generations,2); assert.equal(reviews,2);
  assert.equal(result.generations.at(-1)?.directions[1].unverifiedClaim,true);
  assert.equal(result.generations.at(-1)?.directions[0].unverifiedClaim,undefined);
  assert.doesNotMatch(JSON.stringify(result),/Private unverified claim/);
  const day=new Date().toISOString().slice(0,10);
  assert.equal((await db.prepare('SELECT calls FROM provider_usage WHERE owner_id=? AND day=?').bind(owner,day).first<{calls:number}>())?.calls,4);
 } finally {globalThis.fetch=original;}
});

test('revision generation and review receive agency notes, evidence notes and latest rejected decisions',async()=>{
 const p=pendingSynthesis();const parent=p.generations[0].directions[0];
 const rejected={...structuredClone(parent),id:'rejected-direction',title:'Rejected night race',campaign:{...campaign(['historic-a','historic-b'],1),productRole:'The supplied shoe appears during preparation',callToAction:'Explore the campaign'}};p.generations[0].directions.push(rejected);
 p.annotations[parent.id]='Keep the quiet calendar mechanism';p.annotations[p.evidence[0].id]='Agency sees this as a tentative ritual cue';
 p.generations[0].feedback='Earlier preference for brighter production';
 p.decisions=[{directionId:rejected.id,decision:'rejected',reason:'Avoid competitive night racing',createdAt:p.createdAt},{directionId:parent.id,decision:'rejected',reason:'Old parent objection',createdAt:p.createdAt},{directionId:parent.id,decision:'selected',reason:'',createdAt:p.createdAt}];
 p.operation!.kind='revision';p.operation!.parentDirectionId=parent.id;p.operation!.feedback='Keep the calm ritual. Avoid speed claims.';
 const original=globalThis.fetch;const inputs:Record<string,unknown>[]=[];
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));const input=JSON.parse(body.input);
  inputs.push(isCampaignReview(body)?input.context:input);
  return geminiResponse(body,isCampaignReview(body)?{issues:[]}:campaignOutput(input));
 };
 try{
  const directions=await synthesize({MODEL_API_KEY:'synthetic-key',MODEL_NAME:'gemini-3.5-flash-lite'},p.operation!,p.evidence,p);
  assert.equal(directions.length,3);assert.equal(inputs.length,2);
  for(const input of inputs){
   assert.equal(input.feedback,'Keep the calm ritual. Avoid speed claims.');
   const context=input.revisionContext as {parentDirection:{id:string};agencyNote:string;evidenceNotes:{observation:string;agencyNote:string}[];previousFeedback:string;rejectedDirections:{title:string;proposition:string;mechanism:string;reason:string}[]};
   assert.equal(context.parentDirection.id,parent.id);assert.equal(context.agencyNote,'Keep the quiet calendar mechanism');assert.equal(context.previousFeedback,'Earlier preference for brighter production');
   assert.deepEqual(context.evidenceNotes,[{observation:p.evidence[0].observation,agencyNote:'Agency sees this as a tentative ritual cue'}]);
   assert.deepEqual(context.rejectedDirections,[{title:'Rejected night race',proposition:rejected.campaign!.proposition,mechanism:rejected.campaign!.mechanism,reason:'Avoid competitive night racing'}]);
  }
 }finally{globalThis.fetch=original;}
});

test('synthesis reserves both model calls and keeps the operation leased while review runs',async()=>{
 const owner='synthesis-reservation';const p=pendingSynthesis();await store.create(owner,p);
 const service=new PitchProof(store,{QLOO_API_KEY:'synthetic-key',MODEL_API_KEY:'synthetic-key',MODEL_NAME:'gemini-3.5-flash-lite'});
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(_url,init)=>{
  calls++;const body=JSON.parse(String(init?.body));const active=await store.read(owner,p.id);
  const usage=await db.prepare('SELECT calls FROM provider_usage WHERE owner_id = ? AND day = ?').bind(owner,new Date().toISOString().slice(0,10)).first<{calls:number}>();
  assert.equal(usage?.calls,2,'Both model calls must be reserved before sending either model request');
  assert.ok(active.operation?.leaseToken);assert.ok(active.operation!.leaseUntil-Date.now()>140_000);
  await assert.rejects(()=>service.execute(owner,p.id,command(active,{action:'advance'})),error=>error instanceof AppError&&error.code==='OPERATION_BUSY');
  return geminiResponse(body,isCampaignReview(body)?{issues:[]}:campaignOutput(JSON.parse(body.input)));
 };
 try{
  const result=await service.execute(owner,p.id,command(p,{action:'advance'}));
  assert.equal(calls,2);assert.equal(result.status,'ready');assert.equal(result.operation,null);assert.equal(result.generations.length,2);
  assert.ok(result.generations[1].directions.every(direction=>direction.campaign?.evidenceBridge.length===2));
  const persisted=await store.read(owner,p.id);
  assert.deepEqual(persisted.generations[1].directions,result.generations[1].directions);
  for(const direction of persisted.generations[1].directions){
   assert.match(direction.testPlan.budget!,/subject to agency approval/);
   assert.match(direction.testPlan.minimumData!,/floor alone cannot establish a winner/);
   assert.match(direction.testPlan.inconclusive!,/inconclusive pilot/);
  }
 }finally{globalThis.fetch=original;}
});

test('a daily quota with only one model call left prevents generation without dropping research',async()=>{
 const owner='single-model-slot';const p=pendingSynthesis();await store.create(owner,p);
 await db.prepare('INSERT INTO provider_usage(owner_id,day,calls) VALUES(?,?,119)').bind(owner,new Date().toISOString().slice(0,10)).run();
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('A model call must not start without a reserved reviewer slot');};
 try{
  const result=await new PitchProof(store,{QLOO_API_KEY:'synthetic-key',MODEL_API_KEY:'synthetic-key'}).execute(owner,p.id,command(p,{action:'advance'}));
  assert.equal(result.operation?.failureCode,'DAILY_LIMIT');assert.equal(calls,0);assert.deepEqual(result.generations,p.generations);assert.deepEqual(result.evidence,p.evidence);
  const usage=await db.prepare('SELECT calls FROM provider_usage WHERE owner_id=? AND day=?').bind(owner,new Date().toISOString().slice(0,10)).first<{calls:number}>();assert.equal(usage?.calls,119,'A rejected two-unit reservation must consume zero units');
 }finally{globalThis.fetch=original;}
});

test('demo quota override retains accounting while default limits still apply', async () => {
 const day = new Date().toISOString().slice(0, 10); const owner = 'demo-cap-owner';
 await db.prepare('INSERT INTO provider_usage(owner_id,day,calls) VALUES(?,?,120)').bind(owner,day).run();
 await db.prepare('INSERT INTO provider_usage(owner_id,day,calls) VALUES(?,?,500) ON CONFLICT(owner_id,day) DO UPDATE SET calls=500').bind('__site_total__',day).run();
 assert.equal(await store.budget(owner, 1, undefined, true), true);
 assert.equal((await db.prepare('SELECT calls FROM provider_usage WHERE owner_id=? AND day=?').bind(owner,day).first<{calls:number}>())?.calls, 121);
 assert.equal((await db.prepare('SELECT calls FROM provider_usage WHERE owner_id=? AND day=?').bind('__site_total__',day).first<{calls:number}>())?.calls, 501);
 await assert.rejects(() => store.budget(owner), e => e instanceof AppError && e.code === 'DAILY_LIMIT');
 await db.prepare('UPDATE provider_usage SET calls=0 WHERE owner_id=? AND day=?').bind('__site_total__',day).run();
});


test('demo flag bypasses caps through the service only when explicitly true', async () => {
 const day = new Date().toISOString().slice(0, 10); const owner = 'demo-service-owner'; const project = make();
 await store.create(owner, project);
 await db.prepare('INSERT INTO provider_usage(owner_id,day,calls) VALUES(?,?,120)').bind(owner,day).run();
 await db.prepare('INSERT INTO provider_usage(owner_id,day,calls) VALUES(?,?,500) ON CONFLICT(owner_id,day) DO UPDATE SET calls=500').bind('__site_total__',day).run();
 const original = globalThis.fetch; globalThis.fetch = async () => Response.json({results: []});
 try {
  const credential = randomToken();
  await assert.rejects(() => new PitchProof(store, {QLOO_API_KEY: credential, DEMO_UNLIMITED_DAILY_CAP: 'false'}).search(owner,project.id,0,'Test'), e => e instanceof AppError && e.code === 'DAILY_LIMIT');
  assert.deepEqual(await new PitchProof(store, {QLOO_API_KEY: credential, DEMO_UNLIMITED_DAILY_CAP: 'true'}).search(owner,project.id,0,'Test'), []);
  assert.equal((await db.prepare('SELECT calls FROM provider_usage WHERE owner_id=? AND day=?').bind(owner,day).first<{calls:number}>())?.calls, 121);
 } finally { globalThis.fetch = original; await db.prepare('UPDATE provider_usage SET calls=0 WHERE owner_id=? AND day=?').bind('__site_total__',day).run(); }
});
