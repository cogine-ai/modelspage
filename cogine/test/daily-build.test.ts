import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "../src/build.js";
import { sealRankingInput, type RankingInput } from "../src/ranking-input.js";
import { readRelease } from "../src/publish.js";
import { DirectoryStore } from "../src/store.js";
import { publishRelease } from "../src/publish.js";
const dirs:string[]=[];const oldKey=process.env.MODELSPAGE_INPUT_ENCRYPTION_KEY;
afterEach(async()=>{ if(oldKey===undefined)delete process.env.MODELSPAGE_INPUT_ENCRYPTION_KEY;else process.env.MODELSPAGE_INPUT_ENCRYPTION_KEY=oldKey;for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true}); });
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'daily-build-'));dirs.push(root);await mkdir(join(root,'cogine'));await cp(resolve('cogine/fixtures'),join(root,'cogine/fixtures'),{recursive:true});await mkdir(join(root,'cogine/config'));
 const policy=await Bun.file('cogine/config/popularity-policy.json').json();await Bun.write(join(root,'cogine/config/popularity-policy.json'),JSON.stringify(policy));
 const usage={collection:'allowed',redistribution:'allowed',evidence:'Synthetic fixture only'};
 await Bun.write(join(root,'cogine/config/rank-sources.json'),JSON.stringify({schema_version:1,sources:{'artificial-analysis':usage,openrouter:usage}}));
 const upstream=await Bun.file(join(root,'cogine/fixtures/upstream.json')).json();for(const f of upstream.facts)if(f.identity.request_model_id.includes('model-v1'))f.canonical_id='example-lab/model-v1';await Bun.write(join(root,'cogine/fixtures/upstream.json'),JSON.stringify(upstream));
 const source=(id:string,entries:any[])=>({schema_version:1,source_id:id,attempted_at:'2026-10-26T01:00:00Z',retrieved_at:'2026-10-26T01:00:00Z',data_as_of:null,data_as_of_precision:null,status:'success',complete_response:true,coverage_truncated:false,cutoff:'Synthetic',scope:'Synthetic',window:{start:null,end:null,label:'Synthetic'},usage,authentication_provided:false,endpoints:['https://example.invalid/'+id],raw_files:[],entries,issues:[],metadata:{}});
 const aa=source('artificial-analysis',[{source_model_id:'aa-model',source_slug:'model-v1',display_name:'Model V1 (High)',metric:'artificial_analysis_intelligence_index',value:12.5,value_unit:'index',index_version:4.3}]);
 const or=source('openrouter',[{source_model_id:'example-lab/model-v1',date:'2026-10-25',metric:'tokens',value:'20',value_unit:'tokens'}]);or.metadata={daily_tokens_totals:[{date:'2026-10-25',total_tokens:'100'}]};
 const input:RankingInput={schema_version:1,evaluation_date:'2026-10-26',policy,snapshots:[aa,or],catalogs:[]};process.env.MODELSPAGE_INPUT_ENCRYPTION_KEY='ef'.repeat(32);
 const path=join(root,'private.json');await Bun.write(path,JSON.stringify(sealRankingInput(input)));
 return{root,path,input,options:{root,fixture:true,rankingsInputPath:path,publishedAt:'2026-10-27T00:00:00Z',sequence:1}};
}
test('one fixed encrypted cohort builds C/P/N together, reproduces byte-for-byte, and survives a later publication clock',async()=>{
 const {root,options}=await fixture();const a=await build({...options,outDir:join(root,'a')});const b=await build({...options,outDir:join(root,'b')});
 expect(a.bundle.schema_version).toBe(2);expect(a.bundle.revision).toBe(b.bundle.revision);
 const model=a.bundle.facts.find(f=>f.identity.provider==='openrouter')!;expect(model.capability).toMatchObject({state:'known',value:{score:12.5,model_snapshot:'aa-model'}});expect(model.popularity).toMatchObject({state:'known',value:{weighted:{score:12/7,dates:['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-24','2026-10-25']}}});
 const later=await build({...options,publishedAt:'2026-10-28T00:00:00Z',sequence:2,outDir:join(root,'later')});expect(later.bundle.facts).toEqual(a.bundle.facts);
 const release=await readRelease(join(root,'a'));const store=new DirectoryStore(join(root,'bucket'));
 expect((await publishRelease(store,release,{allowFixture:true})).status).toBe('published');expect((await publishRelease(store,release,{allowFixture:true})).status).toBe('unchanged');
});
test('rebuilding the same cohort with its previous catalog preserves the active publication and freshness',async()=>{
 const {root,options}=await fixture();
 const legacyConfigPath=join(root,'cogine/fixtures/openrouter-config.json');
 const legacyConfig=await Bun.file(legacyConfigPath).json();
 legacyConfig.enabled=false;legacyConfig.usage={collection:'unverified',redistribution:'unverified',evidence:'Synthetic legacy weekly source is inactive; the fixed cohort supplies current ranking sources'};
 await Bun.write(legacyConfigPath,JSON.stringify(legacyConfig));
 const firstDir=join(root,'first');const first=await build({...options,outDir:firstDir});
 const store=new DirectoryStore(join(root,'bucket'));
 expect((await publishRelease(store,await readRelease(firstDir),{allowFixture:true})).status).toBe('published');
 const activeManifest=await store.get('v1/manifest.json');
 const nextDir=join(root,'next');const next=await build({...options,previousBundlePath:join(firstDir,first.manifest.objects.catalog.path),publishedAt:'2026-10-28T00:00:00Z',sequence:2,outDir:nextDir});
 expect(await publishRelease(store,await readRelease(nextDir),{allowFixture:true})).toEqual({status:'unchanged',sequence:1,revision:first.bundle.revision});
 expect(await store.get('v1/manifest.json')).toEqual(activeManifest);
 expect(await store.get(next.manifest.objects.catalog.path)).toBeNull();
});
test('current policy revocation overrides encrypted input and retained v2 catalog authority',async()=>{
 const {root,path,options}=await fixture();const first=await build({...options,outDir:join(root,'a')});const previous=join(root,'a',first.manifest.objects.catalog.path);
 const config=await Bun.file(join(root,'cogine/config/rank-sources.json')).json();config.sources.openrouter.redistribution='unverified';await Bun.write(join(root,'cogine/config/rank-sources.json'),JSON.stringify(config));
 await rm(path);const next=await build({...options,rankingsInputPath:undefined,previousBundlePath:previous,outDir:join(root,'next')});
 expect(next.bundle.schema_version).toBe(2);expect(next.bundle.source_revisions.find(s=>s.id==='observed-weighted-token-share-v1')!.usage.redistribution).toBe('unverified');expect(next.bundle.source_revisions.find(s=>s.id==='openrouter')!.usage.redistribution).toBe('unverified');
});
test('reviewed weights cannot silently reweight a previously collected cohort',async()=>{
 const {root,options,input}=await fixture();input.policy.weights={openrouter:.7,'vercel-ai-gateway':.2,'opencode-go-free':.1};await Bun.write(join(root,'cogine/config/popularity-policy.json'),JSON.stringify(input.policy));await expect(build({...options,outDir:join(root,'reweighted')})).rejects.toThrow('differs from the reviewed current policy');
});
