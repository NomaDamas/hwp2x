window.HwpLive = Base => class extends Base {
  state = { snapshot: { phase: 'idle', files: [], counts: {}, makeMarkdown: true, autoBackup: false }, page: 'overview', filter: 'all', query: '', sel: null, dialog: false, consent: false, error: '', busy: false, narrow: false };
  onResize = () => { const narrow = window.innerWidth < 760; if (narrow !== this.state.narrow) this.setState({ narrow }); };
  componentDidMount() { this.alive = true; this.onResize(); window.addEventListener('resize', this.onResize); this.refresh(); }
  componentWillUnmount() { this.alive = false; clearTimeout(this.timer); window.removeEventListener('resize', this.onResize); }
  bridge() {
    const api = window.hwp2x;
    if (!api || typeof api.state !== 'function') throw new Error('hwp2x 앱 창에서 실행해 주세요. 변환 기능에 연결되지 않았습니다.');
    return api;
  }
  async refresh() {
    let connected = true;
    try { const snapshot = await this.bridge().state(); if (this.alive && snapshot && Array.isArray(snapshot.files)) this.setState({ snapshot, error: this.state.error.startsWith('상태를') || this.state.error.startsWith('hwp2x 앱') ? '' : this.state.error }); }
    catch (error) { connected = !!window.hwp2x; if (this.alive) this.setState({ error: connected ? '상태를 불러오지 못했습니다: ' + (error.message || String(error)) : error.message }); }
    finally { if (this.alive && connected) this.timer = setTimeout(() => this.refresh(), ['scanning', 'converting'].includes(this.state.snapshot.phase) ? 500 : 1500); }
  }
  async call(method, ...args) {
    const api = this.bridge();
    if (typeof api[method] !== 'function') throw new Error('지원하지 않는 기능입니다: ' + method);
    const value = await api[method](...args);
    if (value && typeof value === 'object' && Array.isArray(value.files)) this.setState({ snapshot: value });
    return value;
  }
  async act(action) {
    if (this.state.busy) return;
    this.setState({ busy: true, error: '' });
    try { await action(); }
    catch (error) { this.setState({ error: '작업을 완료하지 못했습니다: ' + (error.message || String(error)) }); }
    finally { this.setState({ busy: false }); }
  }
  async choose(start) {
    const root = await this.call('pickFolder');
    if (!root) return;
    await this.call('scan', root);
    if (start && this.state.snapshot.files.length) await this.call('start', { makeMarkdown: this.state.snapshot.makeMarkdown !== false });
  }
  bytes(value) { return value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : value >= 1024 ? (value / 1024).toFixed(1) + ' KB' : (value || 0) + ' B'; }
  renderVals() {
    const st = this.state, s = st.snapshot, files = s.files || [], cnt = s.counts || {}, phase = s.phase;
    const busy = st.busy || phase === 'scanning' || phase === 'converting';
    const colors = { ok: ['#e6f5ee','#13744e','#1f9d6b'], diff: ['#fbf2df','#8a5c05','#d89b1c'], fail: ['#fbe9e7','#a8302a','#d8473b'], conv: ['#eceefc','#2f3bb0','#4353d6'], wait: ['#f0f0ed','#5b5f66','#a2a6ad'], skipped: ['#f0f0ed','#5b5f66','#a2a6ad'], deleted: ['#eef0ec','#3f5a4b','#6f9a83'] };
    const labels = { ok: '텍스트·블록 일치', diff: '일부 차이', fail: '실패', conv: '변환 중', wait: '대기', skipped: '건너뜀', deleted: '백업됨' };
    const t = { navOverview:'개요',navFiles:'파일',navSettings:'설정',engine:'변환 엔진',verifier:'검증 범위',readyHead:'HWP 문서를 찾아 같은 폴더에 HWPX로 저장합니다.',readyBody:'폴더를 선택하면 검색 후 변환합니다. 텍스트·블록 비교는 전체 서식 보존을 보증하지 않으므로 원본은 유지합니다.',start: files.length ? '검색한 파일 변환' : '폴더 선택 후 변환',settingsLink:'설정 변경',slots:'동시 작업',attention:'확인이 필요한 파일',viewAll:'모두 보기',noIssues:'확인이 필요한 파일이 없습니다.',storage:'저장공간',openBackup:'백업 폴더 열기',saveReport:'검증 리포트 저장',deleteBtn:'보존 검증된 원본 백업',autoBanner:'자동 백업은 별도의 보존 인증이 있는 파일에만 적용됩니다.',searchPh:'파일 이름 검색',colName:'파일',colStatus:'상태',checkItems:'텍스트·블록 비교 항목',openHwp:'원본 열기',openFolder:'폴더 열기',dlgTitle:'보존 검증된 원본 백업',dlgBody:'텍스트·블록 일치만으로는 대상이 되지 않습니다. 별도의 보존 인증이 있는 파일에만 적용합니다.',dlgTarget:'대상 파일',dlgSize:'원본 용량',rptItem:'검증 항목',rptCompared:'비교한 파일',rptMatch:'결과',consent:'검증 리포트를 확인했으며 인증된 원본의 백업 처리에 동의합니다.',cancel:'취소' };
    const color = status => colors[status] || colors.wait;
    const goFiles = filter => () => this.setState({ page:'files', filter, sel:null });
    const action = (method, ...args) => () => this.act(() => this.call(method, ...args));
    const total = s.total ?? files.length, pct = Number(s.percent || 0), completed = s.completed || 0;
    const done = phase === 'done', active = phase !== 'idle';
    const phaseLabel = ({idle:'준비됨',scanning:'파일 검색 중',converting:'변환 및 검증 중',paused:'일시정지됨',done:'완료'})[phase];
    const selected = files.find(file => file.id === st.sel);
    const eligible = files.filter(file => file.backupEligible === true && file.status === 'ok');
    const canBackup = done && eligible.length > 0 && !busy;
    const mapped = file => { const c = color(file.status); return { name:file.name,dir:file.dir,size:this.bytes(file.size),xsize:file.targetSize ? this.bytes(file.targetSize) : '—',status:labels[file.status] || file.status,bg:c[0],fg:c[1],dot:c[2],sel:st.sel === file.id ? '#f0f1fc':'transparent',go:() => this.setState({sel:file.id}) }; };
    const rows = files.filter(file => (st.filter === 'all' || file.status === st.filter) && file.name.toLocaleLowerCase().includes(st.query.trim().toLocaleLowerCase())).map(mapped);
    const detail = selected ? { ...mapped(selected),reasonLabel:'처리 결과',reason:selected.message || labels[selected.status],help:'텍스트·블록 비교만 수행하며 전체 서식 보존은 확인되지 않았습니다. 원본을 유지합니다.',checks:selected.checks || [],primary:'다시 시도' } : null;
    const toggle = (label,desc,on,go) => ({label,desc,isToggle:true,onLabel:on?'켬':'끔',go,rowGo:go,role:'switch',ariaOn:on?'true':'false',tab:0,cur:'pointer',key:event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();go();}},track:on?'#4353d6':'#fff',trackBd:on?'#4353d6':'#8a8e95',knob:on?'#fff':'#5b5f66',knobL:on?'23px':'3px'});
    const settings = options => this.act(() => this.call('configure', options));
    const sections = [
      {title:'성능',rows:[{label:'동시 작업 수',desc:'변환 작업을 동시에 실행할 수입니다.',isSeg:true,opts:[1,2,3,4,6].map(workers => ({label:String(workers),bg:s.workers===workers?'#fff':'transparent',sh:s.workers===workers?'0 1px 2px rgba(0,0,0,.12)':'none',fg:'#18191b',go:()=>settings({workers})}))}]},
      {title:'변환 및 원본 처리',rows:[toggle('AI가 읽기 편한 md 파일도 생성','HWPX와 함께 Markdown 문서를 저장합니다.',s.makeMarkdown!==false,()=>settings({makeMarkdown:s.makeMarkdown===false})),{label:'원본 자동 삭제 미지원',desc:'현재 검증은 텍스트·블록 비교만 제공합니다. 전체 레이아웃 보존을 인증하지 않으므로 원본은 항상 유지합니다.',isTag:true,tag:'원본 유지',tagBg:colors.wait[0],tagFg:colors.wait[1]},{label:'백업 위치',desc:'사용자가 선택한 폴더를 리포트와 향후 인증 백업 위치로 사용합니다.',mono:s.backupDir || '선택하지 않음',isBtn:true,btn:'위치 변경',go:()=>this.act(async()=>{const backupDir=await this.call('pickFolder');if(backupDir)await this.call('configure',{backupDir});})}]},
      {title:'검색 범위',rows:[{label:'검색할 폴더',desc:'선택한 폴더의 HWP 문서를 검색합니다.',mono:s.root || '선택하지 않음',isBtn:true,btn:'폴더 선택',go:()=>this.act(()=>this.choose(false))}]},
      {title:'엔진',rows:[{label:s.hancomName || '엔진 상태 확인 중',desc:'텍스트·블록 비교 · 원본 유지',isTag:true,tag:'실제 변환',tagBg:colors.conv[0],tagFg:colors.conv[1]}]}
    ];
    const sum = key => files.reduce((value,file)=>value+(file[key]||0),0);
    const nav = [['overview','개요',''],['files','파일',String(total)],['settings','설정','']].map(([page,label,count])=>({label,count,bg:st.page===page?'rgba(0,0,0,.06)':'transparent',fw:st.page===page?600:500,pill:st.page===page?'#4353d6':'transparent',go:()=>this.setState({page,sel:null})}));
    return { t,nav,sections,error:st.error,notice:st.busy?'작업 중입니다…':s.message,engName:s.hancomName || '확인 중',engDot:s.hancomName?'#1f9d6b':'#a2a6ad',
      pgOverview:st.page==='overview',pgFiles:st.page==='files',pgSettings:st.page==='settings',goOverview:()=>this.setState({page:'overview'}),goSettings:()=>this.setState({page:'settings'}),goIssues:goFiles(cnt.fail?'fail':'diff'),showIdle:!active,showActive:active,
      idleSummary:(s.root || '폴더를 선택해 주세요')+' · 원본 유지',start:()=>this.act(()=>files.length ? this.call('start',{makeMarkdown:s.makeMarkdown!==false}) : this.choose(true)),startDisabled:busy,startOpacity:busy?0.45:1,
      mdOn:s.makeMarkdown!==false,toggleMd:()=>this.act(()=>this.call('configure',{makeMarkdown:s.makeMarkdown===false})),
      shellCols:st.narrow?'minmax(0,1fr)':'228px minmax(0,1fr)',shellRows:st.narrow?'auto minmax(0,1fr)':'minmax(0,1fr)',sideDir:st.narrow?'row':'column',sideWrap:st.narrow?'wrap':'nowrap',sideExtra:!st.narrow,idlePad:st.narrow?'24px 20px':'0 64px',headSize:st.narrow?'26px':'36px',contentRadius:st.narrow?'0':'8px',
      statCols:st.narrow?'repeat(2,minmax(0,1fr))':'repeat(4,minmax(0,1fr))',splitCols:st.narrow?'minmax(0,1fr)':'minmax(0,1.15fr) minmax(0,1fr)',filesDir:st.narrow?'column':'row',pagePad:st.narrow?'16px 16px 0':'24px 28px 0',searchW:st.narrow?'100%':'240px',detailW:st.narrow?'auto':'340px',
      sideProgress:active&&st.page!=='overview'&&!st.narrow,sidePhase:phaseLabel,phaseLabel,phaseBg:color(done?'ok':phase==='paused'?'wait':'conv')[0],phaseFg:color(done?'ok':'conv')[1],phaseDot:color(done?'ok':'conv')[2],
      heroMain:phase==='scanning'?`${total}개 파일 발견`:`${completed} / ${total}개 처리`,heroSub:s.root || '',pctInt:String(Math.floor(pct)),pctDec:'.'+Math.floor(pct*10)%10+'%',pctColor:done?'#13744e':'#18191b',pctLabel:pct+'%',barW:pct+'%',
      segs:['ok','diff','fail','skipped','deleted'].map(key=>({w:(total?(cnt[key]||0)/total*100:0)+'%',c:color(key)[2]})),legend:['ok','diff','fail','conv','wait','skipped'].map(key=>({label:labels[key],n:cnt[key]||0,c:color(key)[2]})),
      stats:[{label:'경과 시간',value:Math.floor(s.elapsed||0),unit:'초',sub:'실제 작업 경과',color:'#18191b',cur:'default'},{label:'처리한 파일',value:completed,unit:'개',sub:'처리 결과 보기',color:'#18191b',cur:'pointer',go:goFiles('all')},{label:'텍스트·블록 일치',value:cnt.ok||0,unit:'개',sub:'전체 서식 보존 미확인',color:'#13744e',cur:'pointer',go:goFiles('ok')},{label:'실패',value:cnt.fail||0,unit:'개',sub:'원본 유지 · 다시 시도 가능',color:'#a8302a',cur:'pointer',go:goFiles('fail')}],
      notDone:!done,isDone:done,pauseLabel:phase==='paused'?'계속':'일시정지',togglePause:action(phase==='paused'?'start':'pause'),slotMeta:`${cnt.conv||0}개 실행 중`,lanes:files.filter(file=>file.status==='conv').map((file,index)=>({n:String(index+1),name:file.name,stage:file.message||'변환 중',w:'0%'})),laneNote:phase==='paused'?'진행 중인 파일을 마친 뒤 대기합니다.':phase==='scanning'?'파일을 검색하고 있습니다.':'',meters:[{label:'동시 작업',value:Number(s.workers||0)+'개',w:'0%'},{label:'처리 경과',value:Math.floor(s.elapsed||0)+'초',w:Math.min(100,pct)+'%'}],
      issues:files.filter(file=>file.status==='fail'||file.status==='diff').map(file=>({...mapped(file),reason:file.message,go:()=>this.setState({page:'files',filter:file.status,sel:file.id})})),noIssues:!(cnt.fail||cnt.diff),issueCount:(cnt.fail||0)+(cnt.diff||0),storageRows:[{label:'새로 만든 HWPX',value:this.bytes(sum('targetSize'))},{label:'원본 HWP',value:this.bytes(sum('size'))}],storageTip:'텍스트·블록 일치만으로 원본을 삭제하지 않습니다. 현재 전체 레이아웃 보존 인증은 지원하지 않습니다.',openBackup:action('openBackup'),saveReport:action('saveReport'),backupFolderDisabled:!s.backupDir||st.busy,backupFolderOpacity:s.backupDir&&!st.busy?1:0.45,reportDisabled:st.busy||!done,reportOpacity:done&&!st.busy?1:0.45,
      autoOn:s.autoBackup,bulkDisabled:!canBackup,bulkOpacity:canBackup?1:0.45,okCountLabel:eligible.length+'개',openDelete:()=>{if(canBackup)this.setState({dialog:true,consent:false});},
      query:st.query,onQuery:event=>this.setState({query:event.target.value}),filters:['all','wait','ok','diff','fail','skipped'].map(key=>({label:key==='all'?'전체':labels[key],count:key==='all'?total:cnt[key]||0,bg:st.filter===key?'#18191b':'#fff',fg:st.filter===key?'#fff':'#18191b',bd:st.filter===key?'#18191b':'#dcdcd8',go:goFiles(key)})),rows,cols:detail?'minmax(0,1fr) 70px 70px 140px':'minmax(0,1fr) 90px 90px 140px',rowsMore:rows.length?'':'해당하는 파일이 없습니다.',detail,closeDetail:()=>this.setState({sel:null}),retryDisabled:busy||!selected||!['fail','diff'].includes(selected.status),retryOpacity:busy||!selected||!['fail','diff'].includes(selected.status)?0.45:1,retry:action('retry',st.sel),openFile:action('openFile',st.sel),openFolder:action('openFolder',st.sel),
      dialogOpen:st.dialog,delCount:eligible.length+'개',delSize:this.bytes(eligible.reduce((n,file)=>n+file.size,0)),report:[],keepNote:'별도의 보존 인증이 없는 원본은 모두 유지합니다.',modes:[],consent:st.consent,toggleConsent:event=>this.setState({consent:event.target.checked}),noConsent:!st.consent||!canBackup,confirmOpacity:st.consent&&canBackup?1:0.45,confirmLabel:'동의하고 백업',closeDelete:()=>this.setState({dialog:false}),confirmDelete:()=>{if(st.consent&&canBackup)this.act(async()=>{await this.call('backup',true);this.setState({dialog:false,consent:false});});}
    };
  }
};
