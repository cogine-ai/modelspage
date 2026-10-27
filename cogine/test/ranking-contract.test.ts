import { expect, test } from "bun:test";
import { bundle, known, model, capability, seal } from "./contract-fixture.js";
import { observedPopularity } from "../src/observed-popularity.js";
import { project } from "../src/projection.js";
import { validateBundle } from "../src/schema.js";
import { verifyRelease } from "../src/client.js";
import { assertPublishable } from "../src/publish.js";
import { applyCorrections } from "../src/corrections.js";
import type { Bundle, Fact, Popularity } from "../src/types.js";
const dates=Array.from({length:7},(_,i)=>`2026-10-${19+i}`);
const policy={id:"synthetic-union",window_days:7,weights_status:"accepted" as const,weights:{platform:1}};
function popularity(score:number):Fact<Popularity>{
 const result=observedPopularity(policy,dates,new Map([["platform",new Map(dates.map(date=>[date,score]))]]));
 return known({source_id:policy.id,source_model_id:"synthetic/model",position:1,ranking_eligible:true,weighted:{method_id:policy.id,score:result.score!,dates,weights:policy.weights,sources:result.evidence}},policy.id);
}
export function rankingContractFixture():Bundle{
 const base=bundle();const source=base.source_revisions[0]!;
 return bundle({schema_version:2,module_compatibility:{projection:2,min_consumer_version:"2.0.0"},ranking_defaults:{capability_profile_id:"fixture-profile",popularity_source_id:policy.id,policy_id:policy.id},source_revisions:[structuredClone(source),{...structuredClone(source),id:"platform"},{...structuredClone(source),id:policy.id,window:{start:dates[0]!,end:dates.at(-1)!},popularity_method:{id:policy.id,dates,weights:policy.weights}}],facts:[model("popular",{popularity:popularity(9),capability:capability(1)}),model("zero",{popularity:popularity(0)}),model("unknown-strong",{capability:capability(99)})]});
}
test("v2 default indexes compare observed score and known zero, then C/N, while retaining legacy v1 support",async()=>{
 const input=validateBundle(rankingContractFixture());
 const available=input.facts.map(f=>({identity:f.identity,display_name:f.display_name}));
 expect(project(available,input).popularity.map(f=>f.identity.request_model_id)).toEqual(["popular","zero","unknown-strong"]);
 const release=seal(input);expect((await verifyRelease(release.manifest,async()=>release.catalog)).bundle.schema_version).toBe(2);
 const old=seal(bundle());expect((await verifyRelease(old.manifest,async()=>old.catalog)).bundle.schema_version).toBe(1);
 const invalid=rankingContractFixture();invalid.schema_version=1;expect(()=>validateBundle(invalid)).toThrow("requires catalog v2");
});
test("an eligible weighted method cannot mix old windows, weights or native positions",()=>{
 for(const kind of ["dates","weights","native"]){
  const input=rankingContractFixture(), fact=input.facts[0]!.popularity;
  if(fact.state!=="known")throw new Error("fixture");
  if(kind==="dates")fact.value.weighted!.dates=dates.map(date=>new Date(Date.parse(date)-86400000).toISOString().slice(0,10));
  if(kind==="weights")fact.value.weighted!.weights={platform:.5,other:.5};
  if(kind==="native")delete fact.value.weighted;
  expect(()=>validateBundle(input)).toThrow("current method/window");
 }
 const historical=rankingContractFixture();const fact=historical.facts[0]!.popularity;
 if(fact.state!=="known")throw new Error("fixture");
 fact.value.ranking_eligible=false;fact.value.weighted!.dates=dates.map(date=>new Date(Date.parse(date)-86400000).toISOString().slice(0,10));
 for(const evidence of Object.values(fact.value.weighted!.sources)){evidence.daily_shares=Object.fromEntries(fact.value.weighted!.dates.map(date=>[date,9]));}
 expect(validateBundle(historical).facts[0]!.popularity.state).toBe("known");
});
test("stale eligible corrections are rejected instead of being silently rewritten by new data",()=>{
 const input=rankingContractFixture();const correctionValue=structuredClone(input.facts[0]!.popularity);
 if(correctionValue.state!=="known")throw new Error("fixture");
 correctionValue.value.weighted!.dates=dates.map(date=>new Date(Date.parse(date)-86400000).toISOString().slice(0,10));
 input.corrections=[{id:"old-popularity",identity:input.facts[0]!.identity,field:"popularity",action:"replace",value:correctionValue,reason:"Synthetic old window",evidence:"Synthetic",reviewed_by:"test",reviewed_at:input.published_at,sequence:1}];
 input.facts=applyCorrections(input.facts,input.corrections);
 expect(()=>validateBundle(input)).toThrow("current method/window");
});
test("revoking a component's public usage disables composite comparison and publication",()=>{
 const input=rankingContractFixture();input.fixture=false;
 input.source_revisions.find(s=>s.id==="platform")!.usage.redistribution="unverified";
 validateBundle(input);
 const available=input.facts.map(f=>({identity:f.identity,display_name:f.display_name}));
 expect(project(available,input).popularity[0]!.identity.request_model_id).toBe("unknown-strong");
 expect(()=>assertPublishable(input)).toThrow("component platform");
});
