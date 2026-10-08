import type {Logger} from './logging.js';

type ByteProgress={completedBytes:number;totalBytes:number};
export type WorkerProgress={stage:string;completedStages:number;totalStages:number;extraction?:ByteProgress;staging?:ByteProgress;operation?:ByteProgress;package?:{state?:string};fakelib?:{state?:string;size?:number|null}};
type Context={requestId:string;task:string;kind:string};

const measuredBytes=(value:WorkerProgress)=>{
  const candidates=[value.extraction,value.staging,value.operation].filter((bytes):bytes is ByteProgress=>bytes!==undefined),bytes=candidates.length===1?candidates[0]:undefined;
  return bytes&&Number.isSafeInteger(bytes.completedBytes)&&Number.isSafeInteger(bytes.totalBytes)&&bytes.completedBytes>=0&&bytes.totalBytes>=bytes.completedBytes?bytes:undefined;
};
export const validWorkerProgress=(value:unknown):value is WorkerProgress=>{
  if(!value||typeof value!=='object')return false;const event=value as WorkerProgress,hasBytes=event.extraction!==undefined||event.staging!==undefined||event.operation!==undefined;
  return typeof event.stage==='string'&&event.stage.length<120&&Number.isInteger(event.completedStages)&&event.totalStages===7&&event.completedStages>=0&&event.completedStages<=7&&(!hasBytes||measuredBytes(event)!==undefined);
};

export function throttleWorkerProgress(sink:(value:WorkerProgress)=>Promise<void>,now=Date.now){
  let last='',lastStage='',lastAt=-Infinity;
  return async(value:WorkerProgress)=>{
    const bytes=measuredBytes(value),key=JSON.stringify(value),stage=JSON.stringify([value.stage,value.package?.state,value.fakelib?.state,value.completedStages,value.totalStages]);
    if(key===last)return;
    const time=now(),complete=bytes!==undefined&&bytes.completedBytes===bytes.totalBytes||value.completedStages===value.totalStages;
    if(last&&stage===lastStage&&!complete&&time-lastAt<5_000)return;
    await sink(value);
    last=key;lastStage=stage;lastAt=time;
  };
}

export function workerProgressLogger(log:Pick<Logger,'write'>,context:Context,now=Date.now){
  return throttleWorkerProgress(async value=>{
    const bytes=measuredBytes(value),completedBytes=bytes?.completedBytes,totalBytes=bytes?.totalBytes;
    const percent=completedBytes===undefined||!totalBytes?undefined:completedBytes===totalBytes?100:Math.floor(completedBytes/totalBytes*100);
    const fields={...context,stage:value.stage,...(value.package?.state?{state:value.package.state}:{}),...(value.fakelib?.state?{libraryState:value.fakelib.state}:{}),completedStages:value.completedStages,totalStages:value.totalStages,...(completedBytes===undefined?{}:{completedBytes,totalBytes}),...(value.fakelib?.size==null?{}:{libraryBytes:value.fakelib.size}),...(percent===undefined?{}:{percent})};
    await log.write('INFO','worker.task_progress',undefined,fields);
  },now);
}
