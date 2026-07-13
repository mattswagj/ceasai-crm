const store={};
global.localStorage={getItem:k=>k in store?store[k]:null,setItem:(k,v)=>store[k]=String(v),removeItem:k=>delete store[k]};
const _el=()=>({value:"",innerHTML:"",textContent:"",disabled:false,classList:{add(){},remove(){}},focus(){},setSelectionRange(){},closest(){return null},querySelector(){return _el()}});
global.document={querySelector:()=>_el(),createElement:()=>_el(),body:{appendChild(){},insertAdjacentHTML(){}},addEventListener(){},querySelectorAll:()=>[]};
const fakeSb={from:()=>({select(){return this},order(){return this},eq(){return this},limit(){return this},range(){return Promise.resolve({data:[]})},maybeSingle(){return Promise.resolve({data:null})},insert(){return this},update(){return this},delete(){return this}}),auth:{onAuthStateChange(){},getUser:()=>Promise.resolve({data:{user:null}})},functions:{invoke(){}}};
global.window={supabase:{createClient:()=>fakeSb},addEventListener(){},scrollTo(){},open(){}};
global.navigator={clipboard:{writeText(){}}};
global.URL={createObjectURL:()=>"",revokeObjectURL(){}};
global.Blob=class{};
