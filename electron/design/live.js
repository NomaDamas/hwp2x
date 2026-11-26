window.HwpLive = Base => class extends Base {
  state = { snapshot: { phase: 'idle', files: [], counts: {}, makeMarkdown: true, autoBackup: false }, newRun: true, auto: null, issues: null, issueOffset: 0, page: 'overview', filter: 'all', query: '', offset: 0, sel: null, dialog: false, consent: false, error: '', notice: '', busy: false, narrow: false, cleanup: undefined, cleanAck: [false, false, false] };
  onResize = () => { const narrow = window.innerWidth < 760; if (narrow !== this.state.narrow) this.setState({ narrow }); };
  componentDidMount() { this.alive = true; this.onResize(); window.addEventListener('resize', this.onResize); window.addEventListener('keydown', this.onKey); const api=window.hwp2x; this.offHancom=api?.onHancomStatus?.(value=>{if(this.alive&&value&&typeof value.message==='string'){this.setState({notice:value.message});this.poke();}}); this.offNotice=api?.onNotice?.(value=>{if(this.alive&&value&&typeof value.message==='string')this.setState({notice:value.message,error:value.kind==='error'?value.message:this.state.error});}); this.refresh(); }
  componentWillUnmount() { this.alive = false; clearTimeout(this.timer); this.offHancom?.(); this.offNotice?.(); window.removeEventListener('resize', this.onResize); window.removeEventListener('keydown', this.onKey); }
  // Modal keyboard contract: Esc closes, Tab/Shift+Tab stay inside the open dialog, and closing returns focus to the control that opened it.
  onKey = event => {
    const dialog = document.querySelector('[role=dialog][aria-modal=true]');
    if (!dialog) return;
    if (event.key === 'Escape') { event.preventDefault(); this.closeModal(); return; }
    if (event.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea,[tabindex="0"]')];
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1], at = items.indexOf(document.activeElement);
    if (event.shiftKey ? at <= 0 : at === -1 || at === items.length - 1) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
  };
  focusDialog = () => { const from = document.activeElement; if (from && from !== document.body && !from.closest('[role=dialog]')) this.opener = from; setTimeout(() => document.querySelector('[role=dialog] button:not([disabled])')?.focus(), 0); };
  closeModal = () => { const back = this.opener; this.opener = null; this.setState({ log: null, dialog: false, consent: false }, () => { if (back?.isConnected && !back.disabled) back.focus(); }); };
  // A control that disables itself while its action runs drops focus to <body>; give it back once the action ends.
  keepFocus() { const from = document.activeElement; return () => { if (from && from !== document.body && from.isConnected && !from.disabled && (document.activeElement === document.body || !document.activeElement)) from.focus(); }; }
  bridge() {
    const api = window.hwp2x;
    if (!api || typeof api.state !== 'function') throw new Error('hwp2x 앱 창에서 실행해 주세요. 변환 기능에 연결되지 않았습니다.');
    return api;
  }
  // One polling loop. Every request gets a number; an answer that is not the newest is dropped and does not
  // reschedule, so a poke (filter, search, page, action) replaces the loop instead of starting a second one.
  // The engine pages the list on its side: the window only ever holds the current page (at most 100 files).
  query() { const st = this.state; return { offset: st.offset, limit: 100, filter: st.page === 'files' ? st.filter : 'attention', query: st.page === 'files' ? st.query.trim() : '', selectedId: st.sel ?? undefined }; }
  poke = () => { if (this.alive) this.refresh(); };
  async refresh() {
    clearTimeout(this.timer);
    const seq = this.seq = (this.seq || 0) + 1;
    let connected = true;
    try {
      const api = this.bridge();
      // 자동 변환이 켜져 있고 파일 탭이 열려 있을 때만 미처리 목록을 같은 요청 번호로 함께 받는다.
      const wantIssues = this.state.page === 'files' && !!this.state.auto?.enabled && typeof api.autoIssues === 'function';
      const [snapshot, auto, cleanup, issues] = await Promise.all([api.state(this.query()), typeof api.autoState === 'function' ? api.autoState().catch(() => null) : null, typeof api.cleanupState === 'function' ? api.cleanupState().catch(() => null) : null, wantIssues ? api.autoIssues({ offset: this.state.issueOffset, limit: 100 }).catch(() => null) : null]);
      if (!this.alive || seq !== this.seq) return;
      const next = { error: this.state.error.startsWith('상태를') || this.state.error.startsWith('hwp2x 앱') ? '' : this.state.error };
      if (snapshot && Array.isArray(snapshot.files)) next.snapshot = snapshot;
      // 자동 변환을 켜면 진행과 미처리를 한 화면(파일 탭)에서 본다.
      // 켜지면 파일 화면으로, 트레이·안전 중단 등 화면 밖에서 꺼지면 사유가 보이는 자동 변환 화면으로 옮긴다.
      if (auto && typeof auto === 'object') {
        next.auto = auto;
        const was = !!this.state.auto?.enabled;
        if (auto.enabled && !was && this.state.page === 'overview') Object.assign(next, { page: 'files', sel: null, offset: 0, issueOffset: 0, issues: null });
        if (!auto.enabled && was && this.state.page === 'files') Object.assign(next, { page: 'auto', issues: null, issueOffset: 0 });
      }
      if (cleanup && typeof cleanup === 'object' && typeof cleanup.phase === 'string') next.cleanup = cleanup;
      if (issues && Array.isArray(issues.items)) {
        next.issues = issues;
        // Retried items leave the list; if that empties a later page, step back to the last page that still has items.
        const total = Number(issues.total || 0);
        if (!issues.items.length && this.state.issueOffset > 0) { next.issueOffset = total > 0 ? Math.floor((total - 1) / 100) * 100 : 0; setTimeout(this.poke, 0); }
      }
      this.setState(next);
    }
    catch (error) { connected = !!window.hwp2x; if (this.alive && seq === this.seq) this.setState({ error: connected ? '상태를 불러오지 못했습니다: ' + (error.message || String(error)) : error.message }); }
    finally { if (this.alive && connected && seq === this.seq) this.timer = setTimeout(this.poke, ['scanning', 'converting'].includes(this.state.snapshot.phase) || this.cleanBusy() ? 500 : this.state.auto?.enabled ? 1000 : 1500); }
  }
  cleanBusy() { return ['running', 'rollingBack'].includes(this.state.cleanup?.phase); }
  async call(method, ...args) {
    const api = this.bridge();
    if (typeof api[method] !== 'function') throw new Error('지원하지 않는 기능입니다: ' + method);
    const value = await api[method](...args);
    if (value && typeof value === 'object' && 'enabled' in value && 'processed' in value) this.setState({ auto: value });
    if (/^cleanup/.test(method) && value && typeof value === 'object' && typeof value.phase === 'string') this.setState({ cleanup: value });
    this.poke();
    return value;
  }
  async act(action) {
    if (this.busyLock) return;
    this.busyLock = true;
    const restore = this.keepFocus();
    this.setState({ busy: true, error: '', notice: '' });
    try { await action(); }
    catch (error) { window.hwp2x?.reportError?.(error.message || String(error), error.stack); this.setState({ error: '작업을 완료하지 못했습니다: ' + String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }); }
    finally { this.busyLock = false; this.setState({ busy: false }, () => setTimeout(restore, 0)); }
  }
  // 로그 보기: the newest part of today's log, shown as-is so it can be read or copied whole.
  openLog() { return this.act(async () => { const log = await this.call('readLog'); const first = !this.state.log; this.setState({ log: { ...log, copied: 0 } }, first ? this.focusDialog : undefined); }); }
  async choose(start) {
    const root = await this.call('pickFolder');
    if (!root) return;
    const scanned = await this.call('scan', root);
    if (start && scanned?.total) await this.call('start', { makeMarkdown: scanned.makeMarkdown !== false });
  }
  bytes(value) { return value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : value >= 1024 ? (value / 1024).toFixed(1) + ' KB' : (value || 0) + ' B'; }
  renderVals() {
    const st = this.state, s = st.snapshot, files = s.files || [], cnt = s.counts || {}, phase = s.phase, auto = st.auto, autoOn = !!auto?.enabled;
    const busy = st.busy || phase === 'scanning' || phase === 'converting';
    const colors = { ok: ['#e6f5ee','#13744e','#1f9d6b'], diff: ['#fbf2df','#8a5c05','#d89b1c'], fail: ['#fbe9e7','#a8302a','#d8473b'], conv: ['#eceefc','#2f3bb0','#4353d6'], wait: ['#f0f0ed','#5b5f66','#a2a6ad'], skipped: ['#f0f0ed','#5b5f66','#a2a6ad'], deleted: ['#eef0ec','#3f5a4b','#6f9a83'] };
    const labels = { ok: '변환됨', diff: '일부 차이', fail: '실패', conv: '변환 중', wait: '대기', skipped: '이미 변환됨(건너뜀)', deleted: '백업됨' };
    // A failure that needs the user to look at the document keeps status 'fail' (so the 실패 filter still finds it) but reads differently.
    const needsUser = file => file.status === 'fail' && /^처리하지 못함/.test(file.reason || file.message || '');
    const labelOf = file => needsUser(file) ? '처리하지 못함' : labels[file.status] || file.status;
    const t = { navOverview:'특정 폴더 변환',navAuto:'전체 자동 변환',navFiles:'파일',navSettings:'설정',engine:'변환 엔진',verifier:'검증 범위',readyHead:'HWP 문서를 찾아 같은 폴더에 HWPX로 저장합니다.',readyBody:'아래에서 폴더를 고르고 변환을 누르면 하위 폴더까지 모두 변환합니다. 원본은 지우지 않습니다.',start: s.total && phase==='idle' ? `${s.total}개 파일 변환` : s.root ? '검색 후 변환' : '폴더 선택 후 변환',settingsLink:'설정 변경',slots:'동시 작업',attention:'확인이 필요한 파일',viewAll:'모두 보기',noIssues:'확인이 필요한 파일이 없습니다.',storage:'저장공간',openBackup:'백업 폴더 열기',saveReport:'변환 결과 저장',deleteBtn:'원본 백업',autoBanner:'자동 백업은 별도의 보존 인증이 있는 파일에만 적용됩니다.',searchPh:'파일 이름 검색',colName:'파일',colStatus:'상태',checkItems:'확인 항목',openHwp:'원본 열기',openFolder:'폴더 열기',dlgTitle:'원본 백업',dlgBody:'변환이 끝난 원본(변환됨·일부 차이)을 백업 폴더에 복사합니다. 원래 자리의 파일은 지우지 않습니다.',dlgTarget:'대상 파일',dlgSize:'원본 용량',consent:'원본을 백업 폴더에 복사하는 데 동의합니다.',cancel:'취소' };
    const color = status => colors[status] || colors.wait;
    const goFiles = filter => () => this.setState({ page:'files', filter, offset:0, sel:null }, this.poke);
    const autoLocked = '전체 자동 변환이 켜져 있는 동안에는 바꿀 수 없습니다. 자동 변환을 중지한 뒤 사용하세요.';
    // While originals are being moved to the backup or restored, nothing may start a run or change settings.
    const clean = st.cleanup, cleanBusy = this.cleanBusy(), cleanLocked = clean?.phase === 'rollingBack' ? '원본을 원래 위치로 복구하는 중에는 바꿀 수 없습니다. 복구가 끝난 뒤 사용하세요.' : '원본 백업 후 삭제가 진행 중에는 바꿀 수 없습니다. 끝나거나 취소한 뒤 사용하세요.';
    const cleanStuck = !cleanBusy && clean?.phase === 'error' && !!clean?.canRollback, cleanStuckMsg = '원본 정리 중 오류가 있었습니다. 설정의 [원래 위치로 복구]를 먼저 실행해 주세요.';
    const guard = go => () => cleanStuck ? this.setState({ error: cleanStuckMsg }) : cleanBusy ? this.setState({ error: cleanLocked }) : autoOn ? this.setState({ error: autoLocked }) : go();
    const action = (method, ...args) => () => this.act(() => this.call(method, ...args));
    const total = s.total ?? 0, filteredTotal = s.filteredTotal ?? files.length, offset = s.offset ?? st.offset, pct = Number(s.percent || 0), completed = s.completed || 0;
    const done = phase === 'done', running = phase === 'scanning' || phase === 'converting', stopping = phase === 'converting' && /^(일시정지|중지) 중입니다/.test(s.message || ''), active = running || phase === 'paused' || (phase === 'done' && !st.newRun) || (phase === 'stopped' && !st.newRun);
    const phaseLabel = ({idle:'준비됨',scanning:'파일 검색 중',converting:'변환 및 검증 중',paused:'일시정지됨',stopped:'중지됨',done:'완료'})[phase];
    const selected = st.sel == null ? undefined : s.selected?.id === st.sel ? s.selected : files.find(file => file.id === st.sel);
    const eligibleCount = s.eligibleCount ?? 0, sizes = s.summarySizes || {};
    const canBackup = done && eligibleCount > 0 && !busy && !autoOn && !cleanBusy && !!s.backupDir;
    const reasonOf = file => file.reason || (file.status === 'diff' ? '내용 차이 또는 서식 보존 제한 · 원본 유지' : '');
    const byHancom = file => (file.checks || []).some(check => /내용 비교 생략/.test(check.value || ''));
    const userHelp = '보안 수준을 낮추지 마세요. 한컴오피스 한글에서 이 문서를 직접 열어 확인(암호·보안 경고 등)한 뒤 다시 시도하세요. 원본은 그대로 둡니다.';
    // 전체 자동 변환이 넘기지 못한 파일: why it stopped and what the user can do, matched on the engine's reason text.
    const guideOf = text => /보안|암호|password|사용자 확인/i.test(text) ? userHelp
      : /권한|permission|access|EACCES|EPERM/i.test(text) ? '이 폴더에 파일을 만들 권한이 없습니다. 권한을 받은 뒤 다시 작업하세요. 원본은 그대로 둡니다.'
      : /사용 중|잠김|lock|EBUSY/i.test(text) ? '다른 프로그램이 파일을 쓰고 있습니다. 문서를 닫은 뒤 다시 작업하세요.'
      : /시간|timeout|응답/i.test(text) ? '한글이 제때 응답하지 않았습니다. 다른 한글 창을 닫은 뒤 다시 작업하세요.'
      : /손상|열 수 없|corrupt|damaged/i.test(text) ? '문서가 손상되었을 수 있습니다. 한글에서 직접 열리는지 확인하고, 백업본이 있으면 그것을 쓰세요.'
      : /찾을 수 없|없습니다|ENOENT|not found/i.test(text) ? '파일이 옮겨졌거나 지워졌습니다. 위치를 확인하세요. 다음 검색 때 다시 찾습니다.'
      : '원본은 그대로 둡니다. 원인을 해결한 뒤 다시 작업할 수 있습니다. 계속 실패하면 [설정 › 상세 로그]를 확인하세요.';
    const ago = at => { const ms = typeof at === 'number' ? at : Date.parse(at); if (!Number.isFinite(ms)) return ''; const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000)); return sec < 60 ? `${sec}초` : sec < 3600 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${Math.floor(sec / 3600)}시간 ${Math.floor(sec % 3600 / 60)}분`; };
    const helpOf = file => file.status === 'ok' || file.status === 'diff' ? (byHancom(file) ? '한컴오피스 한글이 직접 변환했습니다. 원본과 내용 비교는 하지 않았습니다. 원본은 그대로 둡니다.' : '글자·그림을 원본과 비교했습니다. 전체 서식이 같은지는 확인하지 않았습니다. 원본은 그대로 둡니다.') : file.status === 'skipped' ? '같은 이름의 결과 파일이 이미 있어 덮어쓰지 않았습니다. 원본은 그대로 둡니다.' : needsUser(file) ? userHelp : file.status === 'fail' ? '원본은 그대로 둡니다. 원인을 해결한 뒤 다시 시도할 수 있습니다.' : '';
    const press = go => event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); go(); } };
    const statusIcon = {ok:'ok',diff:'diff',fail:'fail',conv:'converting',wait:'waiting',skipped:'waiting',deleted:'backedup'};
    const mapped = file => { const c = color(file.status); return { icon:`./assets/status/status-${statusIcon[file.status]||'waiting'}.svg`,name:file.name,dir:file.dir,reason:reasonOf(file),hasReason:!!reasonOf(file),size:this.bytes(file.size),xsize:file.targetSize ? this.bytes(file.targetSize) : '—',status:labelOf(file),bg:c[0],fg:c[1],dot:c[2],sel:st.sel === file.id ? '#f0f1fc':'transparent',go:() => this.setState({sel:file.id}),key:press(() => this.setState({sel:file.id})) }; };
    // The engine filters, searches and pages; files is already the page to draw, so it is never re-filtered or re-counted here.
    const rows = st.page === 'files' ? files.map(mapped) : [];
    const turn = to => () => this.setState({ offset: to, sel: null }, this.poke);
    const hasPrev = offset > 0, hasNext = offset + files.length < filteredTotal;
    const detail = selected && !(autoOn && st.page === 'files') ? { ...mapped(selected),reasonLabel:'처리 결과',reason:selected.message || labelOf(selected),help:helpOf(selected),checks:(selected.checks || []).map(check=>({...check,color:(colors[{green:'ok',amber:'diff',red:'fail'}[check.color]]||[])[1]||'#18191b'})),primary:'다시 시도' } : null;
    const toggle = (label,desc,on,go) => ({label,desc,isToggle:true,onLabel:on?'켬':'끔',go,rowGo:go,role:'switch',ariaOn:on?'true':'false',tab:0,cur:'pointer',key:event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();go();}},track:on?'#4353d6':'#fff',trackBd:on?'#4353d6':'#8a8e95',knob:on?'#fff':'#5b5f66',knobL:on?'23px':'3px'});
    const locked = phase === 'scanning' || phase === 'converting' || phase === 'paused';
    const lockedReason = phase === 'paused' ? '일시정지된 작업을 이어하거나 중지한 뒤 바꿀 수 있습니다' : '변환 중에는 바꿀 수 없습니다';
    // Settings never start or replace a run; the engine itself refuses changes during a scan or conversion.
    const settings = options => cleanBusy ? this.setState({ error: cleanLocked }) : autoOn ? this.setState({ error: autoLocked }) : this.act(() => this.call('configure', options));
    const sections = [
      {title:'성능',rows:[{label:'동시 작업 수',desc:'변환 작업을 동시에 실행할 수입니다.',isSeg:true,opts:[1,2,3,4,6].map(workers => ({label:String(workers),bg:s.workers===workers?'#fff':'transparent',sh:s.workers===workers?'0 1px 2px rgba(0,0,0,.12)':'none',fg:'#18191b',on:s.workers===workers?'true':'false',go:()=>settings({workers}),key:press(()=>settings({workers}))}))}]},
      {title:'변환 및 원본 처리',rows:[toggle('AI가 읽기 편한 md 파일도 생성','HWPX와 함께 Markdown 문서를 저장합니다.',s.makeMarkdown!==false,()=>settings({makeMarkdown:s.makeMarkdown===false})),{label:'원본 자동 삭제 미지원',desc:'변환 중에는 원본을 지우지 않습니다. 지우려면 아래 [원본 백업 후 삭제]에서 직접 확인하고 시작하세요.',isTag:true,tag:'원본 유지',tagBg:colors.wait[0],tagFg:colors.wait[1]},{label:'백업 위치',desc:'사용자가 선택한 폴더를 리포트와 향후 인증 백업 위치로 사용합니다.',mono:s.backupDir || '선택하지 않음',isBtn:true,btn:cleanBusy?'정리 중 잠김':'위치 변경',go:guard(()=>this.act(async()=>{const backupDir=await this.call('pickFolder');if(backupDir)await this.call('configure',{backupDir});}))}]},
      {title:'검색 범위',rows:[{label:'검색할 폴더',desc:'이 위치와 모든 하위 폴더의 HWP 문서를 검색합니다. 처음에는 메인 드라이브가 선택됩니다.',mono:s.root || '선택하지 않음',isBtn:true,btn:cleanBusy?'정리 중 잠김':autoOn?'자동 변환 중 잠김':locked?'변환 중 잠김':'폴더 선택',go:()=>cleanBusy?this.setState({error:cleanLocked}):autoOn?this.setState({error:autoLocked}):locked?this.setState({error:lockedReason}):this.act(async()=>{await this.choose(false);this.setState({newRun:true,page:'overview'});})}]},
      {title:'변환 엔진',rows:[...(s.hancomCandidates||[]).map(candidate=>({label:candidate.name,desc:candidate.path+(candidate.available===false?' · 사용 불가: '+(candidate.unavailableReason||'COM 등록 없음'):''),mono:candidate.version?('버전 '+candidate.version):'',isBtn:candidate.available!==false&&s.hancomPath!==candidate.path,btn:'이 버전 사용',go:()=>settings({hancomPath:candidate.path}),isTag:s.hancomPath===candidate.path||candidate.available===false,tag:s.hancomPath===candidate.path?'사용 중':'사용 불가',tagBg:s.hancomPath===candidate.path?colors.ok[0]:colors.fail[0],tagFg:s.hancomPath===candidate.path?colors.ok[1]:colors.fail[1]})),{label:'kordoc 4.24.42',desc:(s.hancomCandidates||[]).length?'한컴 오류 시 자동 전환하지 않음 · 수동 선택 시 사용':'한컴오피스 한글이 감지되지 않아 대체 엔진으로 사용합니다.',isBtn:!!s.hancomPath,btn:'대체 엔진 사용',go:()=>settings({hancomPath:''}),isTag:!s.hancomPath,tag:'사용 중',tagBg:colors.wait[0],tagFg:colors.wait[1]},{label:'한컴 다시 감지',desc:'설치하거나 제거한 뒤 다시 확인합니다. 찾은 설치본은 위 목록에 나오고 [이 버전 사용]으로 고릅니다.',mono:s.hancomDetectNote||'',isBtn:true,btn:'다시 감지',go:guard(()=>this.act(()=>this.call('detectHancom')))},{label:'한컴 직접 선택',desc:'자동으로 찾지 못하면 설치 폴더의 Hwp.exe를 직접 고르세요. 고른 위치는 저장되어 다음 실행에도 가장 먼저 사용됩니다. 다른 버전이나 kordoc을 고르면 해제됩니다.',isBtn:true,btn:'Hwp.exe 선택',go:guard(()=>this.act(()=>this.call('pickHancom')))}]},
      {title:'지원',rows:[{label:'상세 로그',desc:'현재 로그의 최근 200KB를 보고 복사합니다.',isBtn:true,btn:'로그 보기',go:()=>this.openLog()},{label:'버그 리포트',desc:'개인정보 경고를 확인한 뒤 GitHub 작성 초안을 외부 브라우저로 엽니다. 로그 끝부분도 초안에 담기며 긴 내용은 생략됩니다. 자동 게시하지 않습니다.',isBtn:true,btn:'작성 초안 열기',go:()=>this.act(()=>this.call('reportBug'))},{label:'로그 폴더',desc:'문제 진단에 쓰는 최근 로그 파일이 있는 폴더를 엽니다.',isBtn:true,btn:'로그 폴더 열기',go:()=>this.act(()=>this.call('openLogs'))}]}
    ];
    const nav = [['overview','특정 폴더 변환','','convert'],['auto','전체 자동 변환',autoOn?'켜짐':'','refresh'],['files','파일',String(autoOn?Number(auto?.pendingIssues||0):total),'file'],['settings','설정','','settings']].map(([page,label,count,icon])=>({label,count,dis:page==='overview'&&autoOn?'true':undefined,op:page==='overview'&&autoOn?0.5:1,icon:`./assets/icons/${icon}.svg`,iconColor:st.page===page?'#4353d6':'#5b5f66',bg:st.page===page?'rgba(0,0,0,.06)':'transparent',fw:st.page===page?600:500,pill:st.page===page?'#4353d6':'transparent',cur:st.page===page?'page':undefined,go:page==='overview'&&autoOn?()=>this.setState({error:autoLocked}):()=>this.setState({page,sel:null,offset:0},this.poke),key:press(page==='overview'&&autoOn?()=>this.setState({error:autoLocked}):()=>this.setState({page,sel:null,offset:0},this.poke))}));
    // 자동 변환이 켜져 있으면 파일 탭이 진행 상태와 미처리 파일(사유·조치·다시 작업)을 함께 보여준다.
    const autoWatching = autoOn && auto?.phase === 'watching';
    const autoPhaseLabel = ({scanning:'검색 중',converting:'변환 중',waiting:'대기 중',idle:'대기 중',done:'한 바퀴 완료',watching:'완료 · 감시 체제로 전환됨',paused:'일시정지됨'})[auto?.phase] || '실행 중';
    // 개수는 매 갱신마다 새로 받는 pendingIssues가 기준이다(파일 화면 밖에서도 정확). 목록 total은 페이지 계산에만 쓴다.
    const issueItems = st.issues?.items || [], issueTotal = Number(auto?.pendingIssues ?? st.issues?.total ?? 0), listTotal = Number(st.issues?.total ?? issueTotal), issueOffset = st.issueOffset, issueRetrying = Number(auto?.retrying || 0);
    const issueBlock = cleanBusy ? cleanLocked : cleanStuck ? cleanStuckMsg : '';
    const issueTurn = to => () => this.setState({ issueOffset: to }, this.poke);
    const issueRows = issueItems.map(item => {
      const failed = item.status === 'failed', text = String(item.message || item.reason || ''), user = /^처리하지 못함/.test(text) && /보안|암호|사용자 확인|승인/.test(text);
      const tone = failed ? 'fail' : 'conv', c = color(tone), name = item.name || item.source;
      const can = failed && !issueBlock && !st.busy;
      return { name, path: item.source, reason: item.reason || '', message: item.message && item.message !== item.reason ? item.message : '', guide: guideOf(text),
        status: failed ? (user ? '처리하지 못함' : '실패') : item.status === 'retrying' ? '다시 작업 중' : '다시 작업 대기',
        meta: `시도 ${Number(item.attempts || 0)}회 · ${ago(item.updatedAt)} 전${failed ? ' 실패' : ''}`,
        icon: `./assets/status/status-${failed ? 'fail' : 'converting'}.svg`, bg: c[0], fg: c[1],
        isFailed: failed, btnDisabled: !can, btnOpacity: can ? 1 : 0.45, btnTitle: failed ? issueBlock : '', label: `${name} 다시 작업`,
        retry: () => failed && (issueBlock ? this.setState({ error: issueBlock }) : this.act(() => this.call('autoRetryIssue', item.source))),
        openDisabled: st.busy, openOpacity: st.busy ? 0.45 : 1,
        openLabel: `${name} 원본 열기`, open: () => this.act(() => this.call('autoOpenIssue', item.source, false)),
        folderLabel: `${name} 폴더 열기`, folder: () => this.act(() => this.call('autoOpenIssue', item.source, true)) };
    });
    const filesAuto = autoOn && st.page === 'files';
    // 원본 백업 후 삭제: only the current list's verified ok .hwp files; the engine re-checks every file before deleting.
    const cp = clean?.phase, cleanTotal = Number(clean?.total || 0), cleanDone = Number(clean?.processed || 0), cleanPct = Math.max(0, Math.min(100, Number(clean?.percent || 0)));
    const cleanAcked = st.cleanAck.every(Boolean), cleanBlock = !clean ? '정리 상태를 불러오는 중입니다.' : cleanStuck ? cleanStuckMsg : clean.canRollback ? '이전 정리 기록을 복구할 수 있는 동안에는 새로 시작할 수 없습니다. 필요하면 [원래 위치로 복구]를 먼저 실행하세요.' : autoOn ? '전체 자동 변환을 중지한 뒤 시작할 수 있습니다.' : locked ? '변환이 끝나거나 중지된 뒤 시작할 수 있습니다.' : !s.backupDir ? '먼저 위 [백업 위치]를 고르세요.' : '';
    const canClean = !!clean && !cleanBusy && !cleanBlock && cleanAcked && !st.busy;
    const cleanTone = cp === 'error' ? 'fail' : cp === 'done' ? 'ok' : cp === 'running' || cp === 'rollingBack' ? 'conv' : 'wait';
    const ackText = ['서식까지 같다는 보증(무손실 인증)이 아님을 이해합니다. 한컴으로 변환한 파일은 내용 비교도 생략되었습니다.', '확인이 끝난 원본은 같은 폴더의 숨김 안전보관본과 백업 폴더 복사본으로 계속 보존됨을 이해합니다(영구 삭제 아님, 디스크 공간 확보 아님).', '원래 이름의 파일은 원래 위치에서 사라진다는 것을 이해합니다.'];
    for (const sec of sections) for (const r of sec.rows) if (r.isBtn) r.btnName = `${r.label} ${r.btn}`;
    return { t,nav,sections,
      cleanBackup:s.backupDir||'선택하지 않음',cleanBusy,cleanIdle:!cleanBusy,cleanShowProgress:!!clean&&cp!=='idle',
      cleanPhase:({idle:'대기',running:'백업 후 삭제 중',rollingBack:'원래 위치로 복구 중',done:'완료',cancelled:'취소됨',rolledBack:'복구됨',error:'오류'})[cp]||(clean?cp:'확인 중'),
      cleanBg:color(cleanTone)[0],cleanFg:color(cleanTone)[1],cleanDot:color(cleanTone)[2],
      cleanCount:`${cleanDone.toLocaleString()} / ${cleanTotal.toLocaleString()}개`,cleanPct:Math.floor(cleanPct)+'%',cleanBar:cleanPct+'%',
      cleanMessage:clean?.message||'',cleanIsError:cp==='error',cleanNote:cleanBusy?'':cleanBlock||(cleanAcked?'':'위 세 항목을 모두 확인해야 시작할 수 있습니다.'),
      acks:ackText.map((text,i)=>({text,on:!!st.cleanAck[i],dis:cleanBusy,change:event=>this.setState({cleanAck:st.cleanAck.map((v,j)=>j===i?event.target.checked:v)})})),
      cleanStartDisabled:!canClean,cleanStartOpacity:canClean?1:0.45,
      cleanStart:()=>{ if(canClean) this.act(async()=>{ await this.call('cleanupStart', true); this.setState({cleanAck:[false,false,false]}); }); else if(cleanBlock) this.setState({error:cleanBlock}); },
      cleanCanCancel:cp==='running',cleanCancel:()=>this.act(()=>this.call('cleanupCancel')),
      cleanCanRollback:!cleanBusy&&!!clean?.canRollback,cleanRollback:()=>this.act(()=>this.call('cleanupRollback')),
error:st.error,notice:st.notice||(st.busy?'작업 중입니다…':s.message),engName:s.hancomName || '확인 중',engDot:s.hancomName?'#1f9d6b':'#a2a6ad',verifierName:s.hancomPath?'한컴 변환 · 내용 비교 생략':'글자·그림 비교',noticeText:st.error?'':st.notice,
      logOpen:!!st.log,logText:st.log?.text||'로그가 아직 없습니다.',logPath:st.log?.path||'',logInfo:st.log?(st.log.copied?`클립보드에 복사했습니다 (${st.log.copied.toLocaleString()}자). 메신저나 이슈에 바로 붙여넣으세요.`:`최근 기록 ${(st.log.text||'').split('\n').filter(Boolean).length.toLocaleString()}줄`):'',
      copyLog:()=>this.act(async()=>{ const log=await this.call('copyLog'); this.setState({log:{...log,copied:log.text.length}}); }),refreshLog:()=>this.openLog(),closeLog:this.closeModal,
      pgOverview:st.page==='overview'&&!autoOn,goOverviewKey:press(()=>this.setState({page:autoOn?'auto':'overview',offset:0},this.poke)),sideLabel:`${phaseLabel||''} ${pct}% · 진행 화면으로 이동`,pgAuto:st.page==='auto',pgFiles:st.page==='files',pgSettings:st.page==='settings',goOverview:()=>this.setState({page:autoOn?'auto':'overview',offset:0},this.poke),goSettings:()=>this.setState({page:'settings'}),goIssues:goFiles(cnt.fail?'fail':'diff'),showIdle:!active,showActive:active,
      idleSummary:(s.root ? `검색 위치 ${s.root} · 하위 폴더 모두 포함` : '폴더를 선택해 주세요')+' · 원본 유지',rootLabel:s.root||'선택하지 않음',chooseFolder:guard(()=>this.act(async()=>{ const root=await this.call('pickFolder'); if(root) await this.call('scan',root); this.setState({newRun:true}); })),start:guard(()=>this.act(async()=>{ if (s.total && phase==='idle') { this.setState({newRun:false}); return this.call('start',{makeMarkdown:s.makeMarkdown!==false}); } if (!s.root) return this.choose(true); const scanned = await this.call('scan', s.root); this.setState({newRun:false}); if (scanned?.total) await this.call('start',{makeMarkdown:scanned.makeMarkdown!==false}); })),startDisabled:busy||autoOn||cleanBusy||cleanStuck,startOpacity:busy||autoOn||cleanBusy||cleanStuck?0.45:1,
      mdOn:s.makeMarkdown!==false,toggleMd:guard(()=>this.act(()=>this.call('configure',{makeMarkdown:s.makeMarkdown===false}))),
      autoOn,autoOff:!autoOn,autoPhase:autoOn?autoPhaseLabel:'꺼짐',autoBg:color(autoWatching?'ok':autoOn?'conv':'wait')[0],autoFg:color(autoWatching?'ok':autoOn?'conv':'wait')[1],autoDot:color(autoWatching?'ok':autoOn?'conv':'wait')[2],
      autoWatching,autoWatchNote:'접근 가능한 위치의 이번 검색·처리가 끝났습니다. 미처리 파일은 [파일] 화면에서 사유와 조치를 확인하세요. 새 파일은 감시와 주기 검색으로 찾으며 기존 HWPX는 덮어쓰지 않습니다.',
      goAutoFiles:()=>this.setState({page:'files',sel:null,offset:0,issueOffset:0},this.poke),
      // 파일 탭: 자동 변환 중이면 진행 띠 + 미처리 목록, 아니면 기존 특정 폴더 결과 목록.
      filesAuto,filesManual:!filesAuto,filesHead:filesAuto?'파일 · 전체 자동 변환':t.navFiles,
      filesAutoBusy:filesAuto&&!autoWatching,filesAutoNote:autoWatching?'모든 위치를 한 번 처리했고 새 파일을 감시하고 있습니다. 아래는 넘기지 못한 파일입니다.':`${autoPhaseLabel} · ${auto?.message||''}`,
      filesAutoCounts:`처리 ${Number(auto?.processed||0).toLocaleString()}개 · 미처리 ${issueTotal.toLocaleString()}개`+(issueRetrying?` · 다시 작업 중 ${issueRetrying.toLocaleString()}개`:''),
      issueTotalLabel:issueTotal.toLocaleString()+'개',issuesLoading:filesAuto&&!st.issues,issuesEmpty:filesAuto&&!!st.issues&&!issueTotal,issueRows,issueLockNote:issueBlock,
      issueShowPager:listTotal>100||(issueOffset>0&&listTotal>0),issuePageLabel:listTotal&&issueItems.length?`${(issueOffset+1).toLocaleString()}–${(issueOffset+issueItems.length).toLocaleString()} / ${listTotal.toLocaleString()}개`:'',
      issuePrevDisabled:!issueOffset,issuePrevOpacity:issueOffset?1:0.45,issueNextDisabled:issueOffset+issueItems.length>=listTotal,issueNextOpacity:issueOffset+issueItems.length<listTotal?1:0.45,
      issuePrev:issueTurn(Math.max(0,issueOffset-100)),issueNext:issueTurn(issueOffset+100),
      autoMessage:auto?.message||(auto?'전체 자동 변환이 꺼져 있습니다.':'자동 변환 상태를 불러오는 중입니다.'),autoRoots:(auto?.roots||[]).join(' · ')||'—',autoProcessed:Number(auto?.processed||0).toLocaleString(),autoFailed:Number(auto?.failed||0).toLocaleString(),
      autoBackground:!!auto?.background,autoResume:!!auto?.resumeAtLogin,autoDisabled:st.busy||!auto||cleanBusy||(cleanStuck&&!autoOn),autoOpacity:st.busy||!auto||cleanBusy||(cleanStuck&&!autoOn)?0.45:1,
      autoCloseNote:auto?.background?'창을 닫을 때 취소 · 트레이에서 계속 · 완전 종료를 선택합니다. 트레이에서 계속하면 자동 검색·변환은 멈추지 않습니다.':'현재 창을 닫으면 취소 또는 완전 종료를 선택합니다. 트레이에서 계속하려면 이 설정을 켜세요.',
      autoStart:()=>cleanStuck?this.setState({error:cleanStuckMsg}):cleanBusy?this.setState({error:cleanLocked}):this.act(async()=>{ await this.call('autoStart'); this.setState({page:'files',sel:null,offset:0,issueOffset:0},this.poke); }),autoStop:()=>this.act(async()=>{ await this.call('autoStop'); if(this.state.page==='files') this.setState({page:'auto'},this.poke); }),
      toggleBackground:event=>cleanBusy?this.setState({error:cleanLocked}):this.act(()=>this.call('autoConfigure',{background:event.target.checked})),toggleResume:event=>cleanBusy?this.setState({error:cleanLocked}):this.act(()=>this.call('autoConfigure',{resumeAtLogin:event.target.checked})),
      sideAuto:autoOn&&st.page!=='files'&&!st.narrow,sideAutoLabel:`전체 자동 변환 ${autoPhaseLabel} · 파일 화면으로 이동`,sideAutoPhase:autoPhaseLabel,sideAutoCount:`미처리 ${issueTotal.toLocaleString()}개`,goAutoFilesKey:press(()=>this.setState({page:'files',sel:null,offset:0,issueOffset:0},this.poke)),
      shellCols:st.narrow?'minmax(0,1fr)':'228px minmax(0,1fr)',shellRows:st.narrow?'auto minmax(0,1fr)':'minmax(0,1fr)',sideDir:st.narrow?'row':'column',sideWrap:st.narrow?'wrap':'nowrap',sideExtra:!st.narrow,idlePad:st.narrow?'24px 20px':'0 64px',activePad:st.narrow?'20px 16px':'30px 36px 24px',heroCols:st.narrow?'minmax(0,1fr)':'minmax(0,1fr) auto',headSize:st.narrow?'26px':'36px',contentRadius:st.narrow?'0':'8px',
      statCols:st.narrow?'repeat(2,minmax(0,1fr))':'repeat(4,minmax(0,1fr))',splitCols:st.narrow?'minmax(0,1fr)':'minmax(0,1.15fr) minmax(0,1fr)',filesDir:st.narrow?'column':'row',pagePad:st.narrow?'16px 16px 0':'24px 28px 0',searchW:st.narrow?'100%':'240px',detailW:st.narrow?'auto':'340px',
      sideProgress:active&&!autoOn&&st.page!=='overview'&&!st.narrow,sidePhase:phaseLabel,phaseLabel,phaseBg:color(done?'ok':phase==='paused'?'wait':'conv')[0],phaseFg:color(done?'ok':phase==='paused'?'wait':'conv')[1],phaseDot:color(done?'ok':phase==='paused'?'wait':'conv')[2],
      heroMain:phase==='scanning'?`${total}개 파일 발견`:`${completed} / ${total}개 처리`,heroSub:s.root || '',pctInt:String(Math.floor(pct)),pctDec:'.'+Math.floor(pct*10)%10+'%',pctColor:done?'#13744e':'#18191b',pctLabel:pct+'%',barW:pct+'%',
      segs:['ok','diff','fail','skipped','deleted'].map(key=>({w:(total?(cnt[key]||0)/total*100:0)+'%',c:color(key)[2]})),legend:['ok','diff','fail','conv','wait','skipped'].map(key=>({label:labels[key],n:cnt[key]||0,c:color(key)[2]})),
      stats:[{label:'경과 시간',value:Math.floor(s.elapsed||0),unit:'초',sub:done?'완료 · 멈춤':phase==='paused'?'일시정지 · 멈춤':'실제 작업 경과',color:'#18191b',cur:'default'},{label:'처리한 파일',value:completed,unit:'개',sub:'처리 결과 보기',color:'#18191b',cur:'pointer',role:'button',tab:0,go:goFiles('all'),key:press(goFiles('all'))},{label:'변환됨',value:cnt.ok||0,unit:'개',sub:'원본 유지 · 서식 무손실 미확인',color:'#13744e',cur:'pointer',role:'button',tab:0,go:goFiles('ok'),key:press(goFiles('ok'))},{label:'실패',value:cnt.fail||0,unit:'개',sub:'원본 유지 · 다시 시도 가능',color:'#a8302a',cur:'pointer',role:'button',tab:0,go:goFiles('fail'),key:press(goFiles('fail'))}],
      notDone:!done&&phase!=='stopped',isDone:done||phase==='stopped',canPause:running&&phase==='converting'||phase==='paused',canNewRun:done||phase==='stopped',controlDisabled:st.busy||stopping,chooseFolderAgain:guard(()=>this.act(async()=>{ const root=await this.call('pickFolder'); if(!root) return; await this.call('scan',root); this.setState({newRun:true,page:'overview'}); })),runAgain:guard(()=>this.act(async()=>{ if(!s.root) return; const scanned=await this.call('scan',s.root); this.setState({newRun:false,page:'overview'}); if(scanned?.total) await this.call('start',{makeMarkdown:scanned.makeMarkdown!==false}); })),stopRun:action('stop'),pauseLabel:phase==='paused'?'이어하기':'일시정지',togglePause:action(phase==='paused'?'start':'pause'),slotMeta:`${cnt.conv||0}개 실행 중`,lanes:(s.activeFiles||[]).map((file,index)=>({n:String(index+1),name:file.name,stage:file.message||'변환 중'})),laneNote:stopping?s.message:phase==='paused'?'진행 중인 파일을 마친 뒤 대기합니다.':phase==='scanning'?'파일을 검색하고 있습니다.':'',meters:[{label:'동시 작업',value:Number(s.workers||0)+'개'},{label:'처리 경과',value:Math.floor(s.elapsed||0)+'초'}],
      issues:st.page==='overview'?files.slice(0,20).map(file=>({...mapped(file),go:()=>this.setState({page:'files',filter:file.status,offset:0,sel:file.id},this.poke),key:press(()=>this.setState({page:'files',filter:file.status,offset:0,sel:file.id},this.poke))})):[],noIssues:!(cnt.fail||cnt.diff||cnt.skipped),issueCount:(cnt.fail||0)+(cnt.diff||0)+(cnt.skipped||0),storageRows:[{label:'새로 만든 HWPX',value:this.bytes(sizes.target)},{label:'변환된 원본 HWP',value:this.bytes(sizes.source)}],storageTip:'변환이 끝나도 원본은 지우지 않습니다. 전체 서식이 같은지 인증하는 기능은 아직 없습니다.',openBackup:action('openBackup'),saveReport:action('saveReport'),backupFolderDisabled:!s.backupDir||st.busy,backupFolderOpacity:s.backupDir&&!st.busy?1:0.45,reportDisabled:st.busy||!done,reportOpacity:done&&!st.busy?1:0.45,
      backupBannerOn:s.autoBackup,bulkDisabled:!canBackup,bulkOpacity:canBackup?1:0.45,okCountLabel:eligibleCount+'개',openDelete:()=>{if(canBackup)this.setState({dialog:true,consent:false},this.focusDialog);},
      query:st.query,onQuery:event=>this.setState({query:event.target.value,offset:0,sel:null},this.poke),filters:['all','wait','ok','diff','fail','skipped'].map(key=>({label:key==='all'?'전체':labels[key],count:key==='all'?total:cnt[key]||0,bg:st.filter===key?'#18191b':'#fff',fg:st.filter===key?'#fff':'#18191b',bd:st.filter===key?'#18191b':'#dcdcd8',on:st.filter===key?'true':'false',go:goFiles(key),key:press(goFiles(key))})),rows,cols:detail?'minmax(0,1fr) 70px 70px 140px':'minmax(0,1fr) 90px 90px 140px',rowsMore:!filteredTotal?'해당하는 파일이 없습니다.':'',pageLabel:filteredTotal?`${(offset+1).toLocaleString()}–${(offset+files.length).toLocaleString()} / ${filteredTotal.toLocaleString()}개`:'',showPager:filteredTotal>100||offset>0,prevDisabled:!hasPrev,nextDisabled:!hasNext,prevOpacity:hasPrev?1:0.45,nextOpacity:hasNext?1:0.45,prevPage:turn(Math.max(0,offset-100)),nextPage:turn(offset+100),detail,closeDetail:()=>this.setState({sel:null},this.poke),retryDisabled:busy||locked||autoOn||!selected||!['fail','diff'].includes(selected.status),retryOpacity:busy||locked||autoOn||!selected||!['fail','diff'].includes(selected.status)?0.45:1,retry:guard(action('retry',st.sel)),resultDisabled:!selected?.target,openResult:action('openResult',st.sel),openFile:action('openFile',st.sel),openFolder:action('openFolder',st.sel),
      dialogOpen:st.dialog,delCount:eligibleCount+'개',delSize:this.bytes(sizes.source),keepNote:'백업 위치: '+(s.backupDir||'선택하지 않음')+' · 원래 자리의 원본은 그대로 둡니다.',modes:[],consent:st.consent,toggleConsent:event=>this.setState({consent:event.target.checked}),noConsent:!st.consent||!canBackup,confirmOpacity:st.consent&&canBackup?1:0.45,confirmLabel:'원본 백업',closeDelete:this.closeModal,confirmDelete:()=>{if(st.consent&&canBackup){this.closeModal();this.act(()=>this.call('backup',true));}}
    };
  }
};
