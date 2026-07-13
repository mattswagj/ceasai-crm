const day=86400000, now=Date.now(); const iso=d=>new Date(now-d*day).toISOString();
state.user={id:'u1',email:'o@x.com'}; state.org={id:'o1',daily_cap:100};
state.contacts=[
 {id:'c1',title:'Iron Gym',email:'a@iron.com',city:'Atlanta',status:'Contacted',tags:['biz:Gym','st:GA'],last_contacted_at:iso(5),source:'mindbody'},
 {id:'c2',title:'Zen Yoga',city:'Tampa',status:'New',tags:['biz:Yoga / Pilates','st:FL','ig:zenyoga'],source:'mindbody'},
 {id:'c3',title:'Warm Lead',city:'Athens',status:'Replied',tags:['biz:Gym','st:GA','ig:warmlead'],source:'IG keyword: COACH'},
 {id:'c4',title:'Box Club',email:'b@box.com',city:'Macon',status:'Contacted',tags:['biz:MMA / Boxing','st:GA'],last_contacted_at:iso(1),source:'mindbody'},
 {id:'c5',title:'No Contact Gym',city:'Rome',status:'New',tags:['biz:Gym','st:GA'],source:'mindbody'}];
state.events=[
 {id:'e1',contact_id:'c1',channel:'email',status:'sent',subject:'quick question about Iron Gym',sent_at:iso(5)},
 {id:'e2',contact_id:'c4',channel:'email',status:'sent',subject:'quick question about Box Club',sent_at:iso(1)},
 {id:'e3',contact_id:'c1',channel:'email',status:'replied',subject:null,personalization:{}},
 {id:'e4',channel:'meeting',status:'sent'}];
computeMetrics();
let pass=0,fail=0;
const t=(n,got,want)=>{const ok=JSON.stringify(got)===JSON.stringify(want);ok?pass++:fail++;
  console.log((ok?'PASS':'FAIL')+' '+n+(ok?'':'  got='+JSON.stringify(got)+' want='+JSON.stringify(want)));};
t('bizType tag decode', bizType(state.contacts[1]), 'Yoga / Pilates');
t('state tag decode', stOf(state.contacts[1]), 'FL');
t('ig tag decode', igOf(state.contacts[1]), 'zenyoga');
t('inbound detection', isInbound(state.contacts[2]), true);
t('metrics emails sent', state.metrics.emails, 2);
t('metrics meetings', state.metrics.meetings, 1);
t('metrics responses = replies+inbound', state.metrics.responses, 2);
state.search='';
state.segment={type:'Gym',state:'',hasEmail:false,warm:false};
t('segment type=Gym', segFilter(state.contacts).map(c=>c.id), ['c1','c3','c5']);
state.segment={type:'',state:'GA',hasEmail:true,warm:false};
t('segment GA + hasEmail', segFilter(state.contacts).map(c=>c.id), ['c1','c4']);
state.segment={type:'',state:'',hasEmail:false,warm:true};
t('segment warm only', segFilter(state.contacts).map(c=>c.id), ['c3']);
state.segment={type:'',state:'',hasEmail:false,warm:false};
state.search='zen'; t('search box', segFilter(state.contacts).map(c=>c.id), ['c2']); state.search='';
state.segment={type:'',state:'',hasEmail:false,warm:false,noContact:true};
t('needs-contact-info filter finds unreachable leads', segFilter(state.contacts).map(c=>c.id), ['c5']);
state.segment={type:'',state:'',hasEmail:false,warm:false,noContact:false};
t('SMS NOT in free channels', OUT_CHANNELS.includes('sms'), false);
t('SMS eligibility warm-only (TCPA)', eligibleFor('sms').map(c=>c.id), ['c3']);
t('c1 (sent 5d ago) due for follow-up', (seqState(state.contacts[0])||{}).due, true);
t('c4 (sent 1d ago) NOT due', (seqState(state.contacts[3])||{}).due, false);
t('replied lead excluded from sequence', seqState(state.contacts[2]), null);
t('never-contacted not a follow-up', seqState(state.contacts[1]), null);
t('dueList = c1', dueList().map(x=>x.c.id), ['c1']);
t('due step channel = email', dueList()[0].step.channel, 'email');
t('IG msg personalized', /Zen Yoga/.test(genMsg(state.contacts[1],'instagram_dm')), true);
t('LinkedIn msg personalized', /Zen Yoga/.test(genMsg(state.contacts[1],'linkedin')), true);
t('email merge {{title}}/{{city}}', mergeMail('re: {{title}} in {{city}}', state.contacts[0]), 're: Iron Gym in Atlanta');
t('named templates default', tplsGet().length, 2);
t('active template', activeTpl().name, 'Template B');
t('per-template report renders', /Iron Gym/.test(tplReport()), true);
// regression: a follow-up queue must survive a re-render (was being clobbered by the segment queue)
state.q={queue:['c1'],idx:0,text:'',_sig:'due|instagram_dm|1'};
t('due queue survives re-render', isDueQueue('instagram_dm'), true);
panelQueue('instagram_dm');
t('due queue not clobbered by segment', state.q.queue, ['c1']);
state.q._sig='';
panelQueue('instagram_dm');
t('normal queue rebuilds from segment', state.q.queue.length>0, true);

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
