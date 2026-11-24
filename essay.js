// ═══════════════════════════════════════════════════════════════
//  TCF Task 3 范文背诵（每天一篇）
//
//  · 数据：essays.json（36 篇高频话题范文，每篇 开头/论点一/论点二/让步/结论）
//  · 每天：到期复习的范文全部出现 + 新学 N 篇（默认 1 篇，可在 ⚙️ 改）
//  · 新范文：先分段背（看中文提纲 → 开口说 → Enter 看法语 → ← 记住 / → 没记住，
//            没记住的段落排到后面再来），再计时整篇复述（可录音回放），最后自评
//  · 复习：直接整篇复述；没记住就降两级、明天再见（和单词/句子同一套间隔）
//  依赖 app.js 里的全局函数：loadSRS / saveSRS / balancedDueDate / addDaysToSeed /
//  todayDateSeed / loadAnsweredToday / markAnsweredToday / loadAudioIndex / playMp3 /
//  fallbackTTS / escapeHtml / SRS_INTERVALS
// ═══════════════════════════════════════════════════════════════

(function() {
    const MODE        = 'essay';
    const DEFAULT_NEW = 1;
    const TARGET_SEC  = 210; // 3 分 30 秒

    let essays   = [];
    let todayQ   = [];      // 今天的范文队列 [{essay, isNew}]
    let cur      = null;    // 当前 {essay, isNew}
    let step     = null;    // 'intro' | 'seg' | 'full' | 'fullReveal' | 'done'
    let segQueue = [];      // 分段背诵的段落下标队列
    let segShown = false;
    let timer    = null, timerStart = 0;
    let rec      = null, recChunks = [], recUrl = null;

    const $ = id => document.getElementById(id);

    function newLimit() {
        const v = parseInt(localStorage.getItem('fr_new_' + MODE));
        return v > 0 ? v : DEFAULT_NEW;
    }

    // ─── 今日队列 ──────────────────────────────────────────────
    function buildToday() {
        const today = todayDateSeed();
        const srs   = loadSRS(MODE);
        const done  = loadAnsweredToday(MODE);
        const doneSet = new Set(done.ids);
        const learnedNewToday = (done.newIds || []).length;

        const due = essays.filter(e => srs[e.id] && srs[e.id].dueDate <= today && !doneSet.has(e.id))
                          .sort((a, b) => srs[a.id].dueDate - srs[b.id].dueDate);
        const fresh = essays.filter(e => !srs[e.id] && !doneSet.has(e.id))
                            .slice(0, Math.max(0, newLimit() - learnedNewToday));

        todayQ = due.map(e => ({ essay: e, isNew: false })).concat(fresh.map(e => ({ essay: e, isNew: true })));
        // 让 markAnsweredToday 能记下哪些是今天的新篇（app.js 里的全局变量）
        todayProgressInfo = { newIds: fresh.map(e => e.id), reviewIds: due.map(e => e.id) };
    }

    function header() {
        const srs     = loadSRS(MODE);
        const done    = new Set(loadAnsweredToday(MODE).ids);
        const info    = todayProgressInfo || { newIds: [], reviewIds: [] };
        const rDone   = info.reviewIds.filter(id => done.has(id)).length;
        const nDone   = info.newIds.filter(id => done.has(id)).length;
        const learned = essays.filter(e => srs[e.id]).length;
        $('progress-info').textContent = '今日复习 ' + rDone + '/' + info.reviewIds.length +
            ' · 新学 ' + nDone + '/' + info.newIds.length + ' · 已学 ' + learned + ' / ' + essays.length;
        $('count').innerText = todayQ.length;
    }

    // ─── 发音 ──────────────────────────────────────────────────
    function say(text) {
        if (!text) return;
        if (!playMp3(text)) fallbackTTS(text);
    }

    function stopAudio() {
        if (window.currentAudio) window.currentAudio.pause();
        if (window.speechSynthesis) window.speechSynthesis.cancel();
    }

    // ─── 计时与录音 ────────────────────────────────────────────
    function fmt(sec) {
        const m = Math.floor(sec / 60), s = sec % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function startTimer() {
        stopTimer();
        timerStart = Date.now();
        const el = $('essay-timer');
        const tick = function() {
            const sec = Math.floor((Date.now() - timerStart) / 1000);
            el.textContent = fmt(sec) + ' / 目标 3:30';
            el.className = 'essay-timer' + (sec > 240 ? ' over' : sec >= 180 ? ' good' : '');
        };
        tick();
        timer = setInterval(tick, 500);
    }

    function stopTimer() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    async function toggleRecord() {
        const btn = $('essay-rec-btn');
        if (rec && rec.state === 'recording') { rec.stop(); return; }
        if (!navigator.mediaDevices || !window.MediaRecorder) {
            btn.textContent = '此浏览器不支持录音';
            btn.disabled = true;
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            recChunks = [];
            rec = new MediaRecorder(stream);
            rec.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
            rec.onstop = function() {
                stream.getTracks().forEach(t => t.stop());
                if (recUrl) URL.revokeObjectURL(recUrl);
                recUrl = URL.createObjectURL(new Blob(recChunks, { type: rec.mimeType || 'audio/webm' }));
                btn.textContent = '🎙 重新录音';
                btn.classList.remove('recording');
                const play = $('essay-play-rec');
                if (play) play.style.display = '';
            };
            rec.start();
            btn.textContent = '⏹ 停止录音';
            btn.classList.add('recording');
        } catch (e) {
            btn.textContent = '没有麦克风权限';
        }
    }

    function stopRecording() {
        if (rec && rec.state === 'recording') rec.stop();
    }

    function playRecording() {
        if (!recUrl) return;
        stopAudio();
        window.currentAudio = new Audio(recUrl);
        window.currentAudio.play();
    }

    // ─── 渲染 ──────────────────────────────────────────────────
    function tagHTML(e) {
        return '<div class="sentence-tag">Task 3 · ' + escapeHtml(e.cat_cn) + ' · 第 ' + e.id + ' 篇</div>';
    }

    function render() {
        stopTimer();
        header();
        const area = $('essay-area');
        if (!cur) {
            cur = todayQ[0] || null;
            if (!cur) {
                step = 'done';
                const allLearned = essays.every(x => loadSRS(MODE)[x.id]);
                area.innerHTML = '<h3 class="essay-done">今日任务达成！🎉</h3>' +
                    '<p class="essay-note">' + (allLearned
                        ? '全部 ' + essays.length + ' 篇范文都背过了，之后每天只剩到期复习。' : '明天会有新的范文和到期复习。') + '</p>' +
                    '<button class="action-btn" onclick="goHome()">返回主页</button>';
                return;
            }
            step = 'intro';
        }
        const e = cur.essay;

        if (step === 'intro') {
            area.innerHTML = tagHTML(e) +
                '<div class="essay-title">' + escapeHtml(e.title_cn) + '</div>' +
                '<div class="essay-q" onclick="essaySay(\'q\')" title="点击听">🔊 ' + escapeHtml(e.question) + '</div>' +
                '<div class="essay-qcn">' + escapeHtml(e.question_cn) + '</div>' +
                '<div class="essay-plan">' + e.parts.map(p => '<span>' + p.label_cn + '</span>').join(' → ') + '</div>' +
                '<p class="essay-note">' + (cur.isNew ? '新范文：先分段背，再整篇复述。' : '复习：直接整篇复述，记不清再分段看。') + '</p>' +
                '<div class="essay-row">' +
                (cur.isNew
                    ? '<button class="action-btn" onclick="essayGo(\'seg\')">开始分段背诵 <small>Enter</small></button>'
                    : '<button class="action-btn" onclick="essayGo(\'full\')">开始整篇复述 <small>Enter</small></button>' +
                      '<button class="action-btn sub-btn" onclick="essayGo(\'seg\')">先分段过一遍</button>') +
                '</div>';
            return;
        }

        if (step === 'seg') {
            const i = segQueue[0];
            const p = e.parts[i];
            const doneCount = e.parts.length - new Set(segQueue).size;
            area.innerHTML = tagHTML(e) +
                '<div class="essay-dots">' + e.parts.map((x, k) =>
                    '<span class="' + (k === i ? 'on' : (segQueue.includes(k) ? '' : 'ok')) + '">' + x.label_cn + '</span>').join('') + '</div>' +
                '<div class="essay-seg-label">' + p.label_cn + ' · ' + p.label + '</div>' +
                '<div class="essay-outline">' + escapeHtml(p.cn) + '</div>' +
                (segShown
                    ? '<div class="essay-fr" onclick="essaySay(' + i + ')" title="点击再听一遍">' + escapeHtml(p.fr) + '</div>' +
                      '<div class="sentence-judge-row" style="display:flex">' +
                      '<button class="btn-remembered" onclick="essayJudgeSeg(true)">✅ 记住了 <small>←</small></button>' +
                      '<button class="btn-forgotten" onclick="essayJudgeSeg(false)">❌ 没记住 <small>→</small></button></div>' +
                      '<p class="essay-note">按空格再听一遍</p>'
                    : '<div id="sentence-hint">先按提纲开口说这一段，再按 Enter 看法语</div>' +
                      '<button class="action-btn sub-btn" onclick="essayReveal()">看法语 <small>Enter</small></button>') +
                '<p class="essay-note">已过 ' + doneCount + ' / ' + e.parts.length + ' 段</p>';
            return;
        }

        if (step === 'full') {
            area.innerHTML = tagHTML(e) +
                '<div class="essay-q" onclick="essaySay(\'q\')" title="点击听">🔊 ' + escapeHtml(e.question) + '</div>' +
                '<div class="essay-qcn">' + escapeHtml(e.question_cn) + '</div>' +
                '<div class="essay-plan">' + e.parts.map(p => '<span>' + p.label_cn + '</span>').join(' → ') + '</div>' +
                '<div id="essay-timer" class="essay-timer">0:00 / 目标 3:30</div>' +
                '<p class="essay-note">不看稿，整篇说一遍（3 到 4 分钟）。可以录音，说完回放对比。</p>' +
                '<div class="essay-row">' +
                '<button class="action-btn sub-btn" id="essay-rec-btn" onclick="essayRecord()">🎙 录音</button>' +
                '<button class="action-btn" onclick="essayFinishFull()">说完了，看范文 <small>Enter</small></button></div>';
            startTimer();
            return;
        }

        if (step === 'fullReveal') {
            const sec = Math.floor((Date.now() - timerStart) / 1000);
            area.innerHTML = tagHTML(e) +
                '<div class="essay-qcn">用时 ' + fmt(sec) + (sec < 180 ? '（偏短，考试要说满 3 分钟以上）' : sec > 270 ? '（偏长）' : '（时长合适）') + '</div>' +
                '<div class="essay-row">' +
                '<button class="action-btn sub-btn" id="essay-play-rec" onclick="essayPlayRec()" style="' + (recUrl ? '' : 'display:none') + '">▶️ 听我的录音</button>' +
                '<button class="action-btn sub-btn" onclick="essaySay(\'all\')">🔊 听范文 <small>空格</small></button></div>' +
                e.parts.map((p, k) => '<div class="essay-full-part"><b onclick="essaySay(' + k + ')">' + p.label_cn + ' 🔊</b> ' + escapeHtml(p.fr) + '</div>').join('') +
                (e.expressions.length ? '<details class="essay-more"><summary>关键表达</summary><ul>' +
                    e.expressions.map(x => '<li>' + escapeHtml(x) + '</li>').join('') + '</ul></details>' : '') +
                (e.variants.length ? '<details class="essay-more"><summary>变体题目怎么改</summary><ul>' +
                    e.variants.map(x => '<li>' + escapeHtml(x) + '</li>').join('') + '</ul></details>' : '') +
                '<div class="sentence-judge-row" style="display:flex">' +
                '<button class="btn-remembered" onclick="essayJudgeFull(true)">✅ 基本说出来了 <small>←</small></button>' +
                '<button class="btn-forgotten" onclick="essayJudgeFull(false)">❌ 还不熟 <small>→</small></button></div>';
            return;
        }
    }

    // ─── 操作 ──────────────────────────────────────────────────
    function go(next) {
        stopAudio();
        if (next === 'seg') { segQueue = cur.essay.parts.map((_, k) => k); segShown = false; }
        if (next === 'full') { recUrl = null; }
        step = next;
        render();
    }

    function reveal() {
        if (step !== 'seg' || segShown) return;
        segShown = true;
        render();
        say(cur.essay.parts[segQueue[0]].fr);
    }

    function judgeSeg(ok) {
        if (step !== 'seg' || !segShown) return;
        stopAudio();
        const i = segQueue.shift();
        if (!ok) segQueue.push(i); // 没记住：排到后面再来
        segShown = false;
        if (segQueue.length === 0) { go('full'); return; }
        render();
    }

    function finishFull() {
        if (step !== 'full') return;
        stopTimer();
        stopRecording();
        step = 'fullReveal';
        render();
    }

    function judgeFull(ok) {
        if (step !== 'fullReveal') return;
        stopAudio();
        const id  = cur.essay.id;
        const srs = loadSRS(MODE);
        const old = srs[id];
        let level;
        if (ok) level = old ? Math.min((old.level || 0) + 1, SRS_INTERVALS.length - 1) : 0;
        else    level = old ? Math.max(0, (old.level || 0) - 2) : 0;
        srs[id] = { level: level, dueDate: ok ? balancedDueDate(srs, SRS_INTERVALS[level]) : addDaysToSeed(todayDateSeed(), 1) };
        saveSRS(MODE, srs);
        markAnsweredToday(MODE, id);
        todayQ = todayQ.filter(x => x.essay.id !== id);
        cur = null;
        render();
    }

    function sayPart(k) {
        const e = cur && cur.essay;
        if (!e) return;
        if (k === 'q') return say(e.question);
        if (k === 'all') {
            // 依次播放五段
            let n = 0;
            const next = function() {
                if (n >= e.parts.length) return;
                say(e.parts[n++].fr);
                if (window.currentAudio) window.currentAudio.onended = next;
            };
            next();
            return;
        }
        say(e.parts[k].fr);
    }

    // ─── 入口 / 退出 / 设置 ────────────────────────────────────
    async function start() {
        currentMode = MODE;
        $('learning-ui').style.display = 'none';
        $('essay-area').style.display = 'block';
        $('mode-overlay').style.display = 'none';
        $('limit-label').textContent = '每日新学篇数（到期复习全部出现）：';
        $('limit-input').value = newLimit();
        const [res] = await Promise.all([fetch('essays.json'), loadAudioIndex()]);
        essays = await res.json();
        cur = null;
        buildToday();
        render();
    }

    function exit() {
        stopTimer();
        stopRecording();
        stopAudio();
        cur = null; step = null;
        $('essay-area').style.display = 'none';
        $('essay-area').innerHTML = '';
        $('learning-ui').style.display = 'flex';
    }

    function saveSettings(val) {
        localStorage.setItem('fr_new_' + MODE, val);
        cur = null;
        buildToday();
        render();
    }

    document.addEventListener('keydown', function(e) {
        if (currentMode !== MODE || $('modal').style.display === 'block') return;
        if (e.key === ' ') {
            // 空格：再听一遍（分段没看答案前不播放，免得提前听到）
            e.preventDefault();
            if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
            if (step === 'seg' && segShown) say(cur.essay.parts[segQueue[0]].fr);
            else if (step === 'intro' || step === 'full') say(cur.essay.question);
            else if (step === 'fullReveal') {
                // 整篇范文较长：正在播放就停，否则从头播放
                if (window.currentAudio && !window.currentAudio.paused) stopAudio();
                else sayPart('all');
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (step === 'intro') go(cur.isNew ? 'seg' : 'full');
            else if (step === 'seg') reveal();
            else if (step === 'full') finishFull();
        } else if (e.key === 'ArrowLeft') {
            if (step === 'seg') { e.preventDefault(); judgeSeg(true); }
            else if (step === 'fullReveal') { e.preventDefault(); judgeFull(true); }
        } else if (e.key === 'ArrowRight') {
            if (step === 'seg') { e.preventDefault(); judgeSeg(false); }
            else if (step === 'fullReveal') { e.preventDefault(); judgeFull(false); }
        }
    });

    window.startEssay      = start;
    window.essayExit       = exit;
    window.essaySaveSettings = saveSettings;
    window.essayGo         = go;
    window.essayReveal     = reveal;
    window.essayJudgeSeg   = judgeSeg;
    window.essayFinishFull = finishFull;
    window.essayJudgeFull  = judgeFull;
    window.essayRecord     = toggleRecord;
    window.essayPlayRec    = playRecording;
    window.essaySay        = sayPart;
})();
