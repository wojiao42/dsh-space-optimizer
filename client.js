/**
 * 客户端半侧：侧栏底部常驻的「优化空间」按钮 + 空间账本面板。
 *
 * 面板先摊数据、再让人确认：
 *   · 每个任务占了多少（日志 / 附件 / 临时暂存 / 投影缓存），其中多少能优化；
 *   · 当前任务单独标出；运行中的任务不可勾选（它的临时文件可能还在被读）；
 *   · 不属于任何任务的无主垃圾按类别列出；
 *   · 勾选之后才发回收请求，请求里只有 targetId，路径不离开 Host。
 *
 * 默认勾选策略：无主垃圾默认勾上（本来就是垃圾），**任务级项目默认不勾**
 * （清理任务级 spill 会让那段超大工具输出只剩摘要，得由用户自己点头）。
 *
 * @module @local/dsh-space-optimizer/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-space-optimizer',
  factory: (require) => {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;

    const NS = 'spaceOptimizer';

    const ZH = {
      label: '优化空间',
      title: '空间账本',
      subtitle: '先看清每个任务占了多少，再决定优化什么；会话记录不会被裁剪',
      scanning: '正在扫描…',
      rescan: '重新扫描',
      cancel: '取消',
      release: '确认优化',
      releasing: '正在优化…',
      freed: '已释放',
      close: '完成',
      failed: '操作失败',
      harnessData: 'Harness 数据合计',
      allTasks: '任务',
      unownedJunk: '无主垃圾',
      current: '当前',
      running: '运行中',
      subagent: '子任务',
      occupied: '占用',
      reclaimable: '可优化',
      noReclaim: '无可优化项',
      runningLocked: '运行中，暂不清理',
      log: '日志',
      attachments: '附件',
      shared: '共享',
      sharedOnce: '合计里只算一次',
      spill: '临时暂存',
      projection: '投影',
      superseded: '旧日志',
      selected: '已选',
      items: '项',
      fileUnit: '个文件',
      keptTitle: '保留不动',
      keptNote: '会话日志原样保留：其中的 stream 字段被用量、上下文、耗时等投影读取，无法安全瘦身',
      skippedCount: '项已跳过',
      keptBadge: '保留',
      failures: '项未能删除（可能正被占用）',
      selectAll: '全选垃圾',
      selectNone: '清空勾选',
      empty: '还没有任何任务',
      catNote: '说明',
      'cat.market-cache': '插件市场目录缓存',
      'cat.dead-temp': '无主临时文件',
      'cat.projection-orphan': '失效的投影缓存',
      'cat.attachment-orphan': '无主附件对象',
    };

    const EN = {
      label: 'Optimize space',
      title: 'Space ledger',
      subtitle: 'See what each task occupies before deciding; conversations are never trimmed',
      scanning: 'Scanning…',
      rescan: 'Rescan',
      cancel: 'Cancel',
      release: 'Optimize',
      releasing: 'Optimizing…',
      freed: 'Freed',
      close: 'Done',
      failed: 'Failed',
      harnessData: 'Harness data',
      allTasks: 'Tasks',
      unownedJunk: 'Unowned junk',
      current: 'Current',
      running: 'Running',
      subagent: 'Subagent',
      occupied: 'Occupies',
      reclaimable: 'Optimizable',
      noReclaim: 'Nothing to optimize',
      runningLocked: 'Running — not offered',
      log: 'Log',
      attachments: 'Attachments',
      shared: 'shared',
      sharedOnce: 'counted once in totals',
      spill: 'Temp spill',
      projection: 'Projection',
      superseded: 'Old log',
      selected: 'Selected',
      items: 'items',
      fileUnit: 'files',
      keptTitle: 'Kept as is',
      keptNote: 'Session logs are untouched: their stream field feeds usage, context and timing projections',
      skippedCount: 'skipped',
      keptBadge: 'keep',
      failures: 'item(s) could not be removed (likely in use)',
      selectAll: 'Select junk',
      selectNone: 'Clear',
      empty: 'No tasks yet',
      catNote: 'Note',
      'cat.market-cache': 'Plugin market cache',
      'cat.dead-temp': 'Unowned temp files',
      'cat.projection-orphan': 'Orphaned projection rows',
      'cat.attachment-orphan': 'Orphaned attachments',
    };

    const CSS = [
      // flex:none：侧栏页脚是 flex 容器，按钮不该被拉伸或压缩；尺寸由内容决定。
      '.sop-root{display:inline-flex;align-items:center;min-width:0;flex:none}',
      '.sop-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;cursor:pointer;padding:4px 8px;',
      'border:none;border-radius:var(--dsw-radius-sm,8px);background:0 0;font:inherit;',
      'font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.4;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.sop-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      // 焦点环自带一套：主题里管焦点环的规则（`:focus-visible{outline:none}` 与
      // pointer 模态下 `outline-color:#0000`）都是**文档级**的，照不到隔离的插槽子树，
      // 于是浏览器默认的黑色焦点环会露出来——点过哪个按钮，哪个就挂一圈黑框。
      // 这里鼠标点击不显示环，键盘聚焦给一个显式的蓝色环（保住可达性）。
      '.sop-btn:focus{outline:none}',
      '.sop-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#3964fe));outline-offset:1px}',
      '.sop-btn svg{flex:none;display:block;width:14px;height:14px}',
      '.sop-backdrop{position:fixed;inset:0;z-index:95;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;padding:20px}',
      '.sop-card{box-sizing:border-box;width:min(760px,100%);max-height:min(84vh,760px);display:flex;flex-direction:column;',
      'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,16px);overflow:hidden;',
      'background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));box-shadow:var(--dsw-elevation-panel,0 6px 24px rgba(0,0,0,.18));',
      'color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px)}',
      '.sop-head{padding:14px 18px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.sop-titleRow{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
      '.sop-title{font-size:15px;font-weight:600}',
      '.sop-headline{font-variant-numeric:tabular-nums;font-weight:600}',
      '.sop-sub{margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}',
      '.sop-body{padding:2px 18px 8px;overflow:auto}',
      '.sop-sec{margin-top:12px}',
      '.sop-secHead{display:flex;align-items:baseline;gap:8px;padding:4px 0;color:var(--dsw-alias-label-secondary);',
      'font-weight:600;font-size:12px;letter-spacing:.02em}',
      '.sop-secHeadMeta{margin-left:auto;font-weight:400;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-variant-numeric:tabular-nums}',
      '.sop-row{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.sop-row:last-child{border-bottom:none}',
      '.sop-row>input{margin:3px 0 0;flex:none}',
      '.sop-main{flex:1;min-width:0}',
      '.sop-top{display:flex;align-items:baseline;gap:8px}',
      '.sop-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sop-tags{flex:none;display:inline-flex;gap:4px}',
      '.sop-tag{flex:none;padding:0 6px;border-radius:6px;font-size:11px;line-height:17px;',
      'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}',
      '.sop-tag[data-kind="current"]{background:var(--dsw-alias-state-business-tertiary,rgba(59,130,246,.15));color:var(--dsw-alias-label-primary-bluish,var(--dsw-alias-label-primary))}',
      '.sop-tag[data-kind="running"]{background:var(--dsw-alias-state-success-tertiary,rgba(34,197,94,.15));color:var(--dsw-alias-state-success-primary,#22c55e)}',
      '.sop-occ{flex:none;margin-left:auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.sop-line{margin-top:2px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-size:12px;line-height:1.6}',
      '.sop-line b{color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.sop-can{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-label-secondary))}',
      '.sop-none{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}',
      '.sop-zero{opacity:.55}',
      '.sop-items{margin:4px 0 2px;padding:4px 0 2px 0;border-top:1px dashed var(--dsw-alias-border-l2)}',
      '.sop-item{display:flex;gap:10px;padding:2px 0;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));font-size:12px}',
      '.sop-itemName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',
      '.sop-itemSize{flex:none;font-variant-numeric:tabular-nums}',
      '.sop-more{cursor:pointer;background:0 0;border:none;padding:2px 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px}',
      '.sop-more:hover{color:var(--dsw-alias-label-secondary)}',
      '.sop-note{margin:8px 0 0;padding:8px 12px;border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}',
      '.sop-summary{margin:8px 0 0;padding:9px 12px;border-radius:var(--dsw-radius-md,10px);',
      'background:var(--dsw-alias-state-success-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.6}',
      '.sop-err{margin:8px 0 0;padding:9px 12px;border-radius:var(--dsw-radius-md,10px);',
      'background:var(--dsw-alias-state-error-tertiary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));font-size:12px;line-height:1.6}',
      '.sop-foot{display:flex;align-items:center;gap:8px;padding:11px 18px 13px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.sop-pick{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}',
      '.sop-spacer{flex:1}',
      '.sop-link{cursor:pointer;background:0 0;border:none;padding:4px 8px;border-radius:var(--dsw-radius-sm,8px);',
      'color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px}',
      '.sop-link:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.sop-link:disabled{opacity:.45;cursor:default}',
      '.sop-primary{cursor:pointer;border:none;border-radius:var(--dsw-radius-md,10px);padding:6px 14px;font:inherit;',
      'font-size:13px;background:var(--dsw-alias-state-business-primary,var(--dsw-alias-label-primary));color:#fff}',
      '.sop-primary:disabled{opacity:.45;cursor:default}',
    ].join('');

    /** 字节 → 人类可读。 */
    const fmtBytes = (value) => {
      const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
      if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(n >= 100 * 1024 * 1024 ? 0 : 1) + ' MB';
      if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
      return n === 0 ? '0' : Math.round(n) + ' B';
    };

    const asNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    const asArray = (value) => (Array.isArray(value) ? value : []);

    /**
     * 图标。**必须给内在的 width/height**：只有 viewBox 的 SVG 在 CSS 尚未生效时
     * 会按替换元素默认尺寸（300×150）渲染，把侧栏按钮撑大——实测症状就是
     * 「按钮首帧偏大，点开面板触发重渲染后才恢复正常」。
     * CSS 里的 `.sop-btn svg{width:14px;height:14px}` 保留作为兜底，但不再依赖它。
     */
    const SparkIcon = () =>
      h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 14,
          height: 14,
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M8 1.4l1.3 3.2 3.2 1.3-3.2 1.3L8 10.4 6.7 7.2 3.5 5.9l3.2-1.3L8 1.4z', fill: 'currentColor' }),
        h('path', {
          d: 'M4 10.6l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7L1.6 13l1.7-.7.7-1.7z',
          fill: 'currentColor',
          opacity: '0.72',
        }),
      );

    /** 直接订阅会话列表 observable，这样根作用域的侧栏页脚也能拿到标题与运行状态。 */
    function useSessionsSnapshot(sessionsSource, useSessions) {
      const sourceRef = React.useRef(sessionsSource);
      sourceRef.current = sessionsSource;
      const subscribe = React.useCallback((listener) => {
        const source = sourceRef.current;
        return typeof source?.subscribe === 'function' ? source.subscribe(listener) : () => {};
      }, []);
      const getSnapshot = React.useCallback(() => {
        const source = sourceRef.current;
        return typeof source?.getSnapshot === 'function' ? source.getSnapshot() : undefined;
      }, []);
      const injected = React.useSyncExternalStore(subscribe, getSnapshot, () => undefined);
      return injected ?? (typeof useSessions === 'function' ? useSessions((state) => state) : undefined);
    }

    /** 主视图里正打开的那个任务。 */
    function currentSessionIdOf(list) {
      for (const id of asArray(list?.ids)) {
        if (asNumber(list?.byId?.[id]?.retainedBy?.mainView) > 0) return id;
      }
      return undefined;
    }

    /** 收集一个可删除单元集合里的 targetId。 */
    const targetIdsOf = (items) => asArray(items).filter((item) => item.reclaimable === true).map((item) => item.targetId);

    /**
     * 可回收字节数/文件数：优先用 Host 给的汇总字段，缺了就自己从条目累加。
     * Host 一定会带这两个字段，但界面不该因为一个字段缺失就把 8 MB 显示成 0。
     */
    const reclaimableOf = (items, given, key) => {
      if (typeof given === 'number' && Number.isFinite(given)) return given;
      return asArray(items)
        .filter((item) => item.reclaimable === true)
        .reduce((total, item) => total + asNumber(item[key]), 0);
    };

    function SpaceOptimizerPanel({ useSessions, t, sessionsSource, wide = true }) {
      const tr = React.useCallback((key) => (typeof t === 'function' ? t(key) : key), [t]);
      const list = useSessionsSnapshot(sessionsSource, useSessions);
      const [open, setOpen] = React.useState(false);
      const [phase, setPhase] = React.useState('idle');
      const [ledger, setLedger] = React.useState(null);
      const [picked, setPicked] = React.useState(() => new Set());
      const [expanded, setExpanded] = React.useState(() => new Set());
      const [result, setResult] = React.useState(null);
      const [error, setError] = React.useState(null);

      const sessions = asArray(ledger?.sessions);
      const junk = asArray(ledger?.junk);
      const currentId = currentSessionIdOf(list);

      /** 把 Host 的账目和客户端才知道的标题 / 运行状态合起来（数值字段缺失时自行推算）。 */
      const rows = React.useMemo(() => {
        const built = sessions.map((session) => {
          const meta = list?.byId?.[session.id] ?? {};
          const running = meta.running === true;
          const current = session.id === currentId;
          const supersededItems = asArray(session.supersededItems);
          const spillItems = asArray(session.spillItems);
          const bytes = reclaimableOf([...supersededItems, ...spillItems], session.reclaimableBytes, 'bytes');
          const spill = reclaimableOf(spillItems, session.spillBytes, 'bytes');
          const superseded = reclaimableOf(supersededItems, session.supersededBytes, 'bytes');
          const log = asNumber(session.logBytes);
          const projection = asNumber(session.projectionBytes);
          return {
            session,
            title: meta.displayTitle ?? meta.title ?? session.id,
            current,
            running,
            subagent: session.origin === 'subagent',
            targets: targetIdsOf([...supersededItems, ...spillItems]),
            bytes,
            spill,
            superseded,
            log,
            projection,
            attachments: asNumber(session.attachmentBytes),
            shared: asNumber(session.attachmentSharedBytes),
            owned:
              typeof session.ownedBytes === 'number'
                ? session.ownedBytes
                : log + projection + bytes,
          };
        });
        built.sort(
          (left, right) =>
            Number(right.current) - Number(left.current) ||
            Number(right.running) - Number(left.running) ||
            right.owned - left.owned,
        );
        return built;
      }, [sessions, list, currentId]);

      const junkRows = React.useMemo(
        () =>
          junk.map((category) => ({
            category,
            targets: targetIdsOf(category.items),
            bytes: reclaimableOf(category.items, category.reclaimableBytes, 'bytes'),
            files: reclaimableOf(category.items, category.reclaimableFiles, 'files'),
            reclaimed: asArray(category.items).filter((item) => item.reclaimable === true).length,
          })),
        [junk],
      );

      const allJunkTargets = React.useMemo(() => junkRows.flatMap((row) => row.targets), [junkRows]);

      const load = React.useCallback(async () => {
        setPhase('scanning');
        setError(null);
        setResult(null);
        try {
          const response = await fetch('/space-optimizer/ledger', { cache: 'no-store' });
          const payload = await response.json();
          if (payload?.ok !== true) throw new Error(payload?.error ?? String(response.status));
          // 账本形状不对就别硬着头皮渲染：版本错配或代理截断时这里必须报错，而不是画出一个空面板。
          if (payload.ledger === null || typeof payload.ledger !== 'object') throw new Error('unexpected ledger payload');
          const next = payload.ledger;
          setLedger(next);
          // 默认只勾无主垃圾；任务级项目要用户自己点头。
          setPicked(
            new Set(
              asArray(next?.junk).flatMap((category) =>
                category.blocked !== undefined ? [] : targetIdsOf(category.items),
              ),
            ),
          );
          setPhase('ready');
        } catch (cause) {
          setError(String(cause?.message ?? cause));
          setPhase('error');
        }
      }, []);

      const openPanel = React.useCallback(() => {
        setOpen(true);
        setResult(null);
        void load();
      }, [load]);

      const closePanel = React.useCallback(() => {
        setOpen(false);
        setPhase('idle');
        setResult(null);
        setError(null);
      }, []);

      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') closePanel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [open, closePanel]);

      const toggleOne = (targets) => {
        setPicked((current) => {
          const next = new Set(current);
          const allPicked = targets.length > 0 && targets.every((id) => next.has(id));
          for (const id of targets) {
            if (allPicked) next.delete(id);
            else next.add(id);
          }
          return next;
        });
      };

      const toggleGroup = (ids) => {
        setPicked((current) => {
          const next = new Set(current);
          const allPicked = ids.length > 0 && ids.every((id) => next.has(id));
          for (const id of ids) {
            if (allPicked) next.delete(id);
            else next.add(id);
          }
          return next;
        });
      };

      // 运行中的任务不参与回收：它的临时文件可能还在被读。
      const selectableSessionTargets = rows
        .filter((row) => !row.running && !row.current)
        .flatMap((row) => row.targets);

      const run = React.useCallback(async () => {
        const targets = [...picked];
        if (targets.length === 0) return;
        setPhase('working');
        setError(null);
        try {
          const response = await fetch('/space-optimizer/reclaim', {
            method: 'POST',
            cache: 'no-store',
            // 自定义头是刻意的：它让跨源调用必须先过预检，而 Host 不应答预检，
            // 于是被访问的网页无法匿名触发删除。
            headers: { 'content-type': 'application/json', 'x-space-optimizer': '1' },
            body: JSON.stringify({ targets }),
          });
          const payload = await response.json();
          if (payload?.ok !== true) throw new Error(payload?.error ?? String(response.status));
          // 同上：缺 result 视为协议错误，别让 undefined 漏进渲染分支。
          if (payload.result === null || typeof payload.result !== 'object') throw new Error('unexpected reclaim payload');
          setResult(payload.result);
          if (payload.ledger !== undefined && payload.ledger !== null) setLedger(payload.ledger);
          setPicked(new Set());
          setPhase('done');
        } catch (cause) {
          setError(String(cause?.message ?? cause));
          setPhase('error');
        }
      }, [picked]);

      const pickedBytes = React.useMemo(() => {
        const byTarget = new Map();
        for (const session of sessions) {
          for (const item of [...asArray(session.supersededItems), ...asArray(session.spillItems)]) {
            if (item.reclaimable === true) byTarget.set(item.targetId, item.bytes);
          }
        }
        for (const category of junk) {
          for (const item of asArray(category.items)) {
            if (item.reclaimable === true) byTarget.set(item.targetId, item.bytes);
          }
        }
        let total = 0;
        for (const id of picked) total += byTarget.get(id) ?? 0;
        return total;
      }, [picked, sessions, junk]);

      const totals = ledger?.totals;
      const currentRow = rows.find((row) => row.current);
      // 只有真的拿到结果对象才算"已释放"，否则一律按扫描中/可优化展示。
      const hasResult = result !== null && typeof result === 'object';
      const headline =
        hasResult
          ? tr('freed') + ' ' + fmtBytes(result.freedBytes)
          : totals !== undefined && ledger !== null
            ? tr('reclaimable') + ' ' + fmtBytes(totals.reclaimable)
            : tr('scanning');

      const categoryTitle = (category) => {
        const key = 'cat.' + category.id;
        const localized = tr(key);
        return localized === key ? category.title : localized;
      };

      const renderItems = (rowKey, items) => {
        const selectable = asArray(items).filter((item) => item.reclaimable === true);
        const skipped = asArray(items).filter((item) => item.reclaimable !== true);
        const shown = expanded.has(rowKey) ? selectable : selectable.slice(0, 3);
        return h(
          'div',
          { className: 'sop-items' },
          shown.map((item) =>
            h(
              'div',
              { className: 'sop-item', key: item.targetId },
              h('span', { className: 'sop-itemName', title: item.path }, item.label ?? item.path),
              item.note !== undefined ? h('span', { className: 'sop-itemSize', style: { opacity: 0.75 } }, item.note) : null,
              h('span', { className: 'sop-itemSize' }, fmtBytes(item.bytes)),
            ),
          ),
          selectable.length > 3
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'sop-more',
                  onClick: () =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(rowKey)) next.delete(rowKey);
                      else next.add(rowKey);
                      return next;
                    }),
                },
                expanded.has(rowKey) ? '收起 / collapse' : `展开其余 ${selectable.length - 3} 项 / show ${selectable.length - 3} more`,
              )
            : null,
          skipped.length > 0
            ? h('div', { className: 'sop-item' }, h('span', { className: 'sop-itemName' }, skipped.length + ' ' + tr('skippedCount')), skipped[0]?.note !== undefined ? h('span', { className: 'sop-itemSize', style: { opacity: 0.75 } }, skipped[0].note) : null)
            : null,
        );
      };

      const panel =
        open === true
          ? ReactDOM.createPortal(
              h(
                'div',
                {
                  className: 'sop-backdrop',
                  onMouseDown: (event) => {
                    if (event.target === event.currentTarget) closePanel();
                  },
                },
                h(
                  'div',
                  {
                    className: 'sop-card',
                    role: 'dialog',
                    'aria-modal': 'true',
                    'aria-label': tr('title'),
                    'data-space-optimizer': 'panel',
                  },
                  h(
                    'div',
                    { className: 'sop-head' },
                    h(
                      'div',
                      { className: 'sop-titleRow' },
                      h('div', { className: 'sop-title' }, tr('title')),
                      h('div', { className: 'sop-headline' }, headline),
                    ),
                    h(
                      'div',
                      { className: 'sop-sub' },
                      tr('subtitle'),
                      totals !== undefined
                        ? h(
                            'div',
                            null,
                            tr('harnessData') + ' ' + fmtBytes(totals.sessions + totals.attachments + totals.junk) +
                              ' · ' + tr('allTasks') + ' ' + totals.sessionCount + ' · ' + tr('log') + ' ' + fmtBytes(totals.sessionLogs) +
                              (currentRow !== undefined
                                ? ' · ' + tr('current') + ' ' + fmtBytes(currentRow.owned)
                                : ''),
                          )
                        : null,
                    ),
                  ),
                  // 面板走 portal 渲染到 document.body，和按钮不在同一棵树里，
                  // 所以这份样式表也要跟着面板走（否则面板会掉回无样式）。
                  h('style', null, CSS),
                  h(
                    'div',
                    { className: 'sop-body' },
                    phase === 'scanning' ? h('div', { className: 'sop-note' }, tr('scanning')) : null,
                    // ── 任务 ──
                    h(
                      'div',
                      { className: 'sop-sec' },
                      h(
                        'div',
                        { className: 'sop-secHead' },
                        tr('allTasks'),
                        h(
                          'span',
                          { className: 'sop-secHeadMeta' },
                          rows.length + ' ' + tr('items') + ' · ' + fmtBytes(totals?.sessionReclaimable) + ' ' + tr('reclaimable'),
                        ),
                      ),
                      rows.length === 0 && phase !== 'scanning' ? h('div', { className: 'sop-note' }, tr('empty')) : null,
                      rows.map((row) => {
                        const session = row.session;
                        const locked = row.running || row.current;
                        const detail = [
                          tr('log') + ' ' + fmtBytes(row.log),
                          row.projection > 0 ? tr('projection') + ' ' + fmtBytes(row.projection) : null,
                        ]
                          .filter(Boolean)
                          .join(' · ');
                        const attachmentLine =
                          row.attachments > 0
                            ? tr('attachments') + ' ' + fmtBytes(row.attachments) +
                              (row.shared > 0
                                ? '（' + tr('shared') + ' ' + fmtBytes(row.shared) + '，' + tr('sharedOnce') + '）'
                                : '')
                            : null;
                        return h(
                          'label',
                          { className: 'sop-row' + (locked ? ' sop-zero' : ''), key: session.id },
                          h('input', {
                            type: 'checkbox',
                            checked: row.targets.length > 0 && row.targets.every((id) => picked.has(id)),
                            disabled: locked || row.targets.length === 0 || phase === 'working',
                            onChange: () => toggleOne(row.targets),
                          }),
                          h(
                            'div',
                            { className: 'sop-main' },
                            h(
                              'div',
                              { className: 'sop-top' },
                              h('span', { className: 'sop-name', title: row.title + ' · ' + session.id }, row.title),
                              h(
                                'span',
                                { className: 'sop-tags' },
                                row.current ? h('span', { className: 'sop-tag', 'data-kind': 'current' }, tr('current')) : null,
                                row.running ? h('span', { className: 'sop-tag', 'data-kind': 'running' }, tr('running')) : null,
                                row.subagent ? h('span', { className: 'sop-tag' }, tr('subagent')) : null,
                              ),
                              h('span', { className: 'sop-occ' }, tr('occupied') + ' ' + fmtBytes(row.owned)),
                            ),
                            h('div', { className: 'sop-line' }, detail, attachmentLine !== null ? h('span', null, ' · ' + attachmentLine) : null),
                            h(
                              'div',
                              { className: 'sop-line' },
                              row.bytes > 0
                                ? h(
                                    'span',
                                    { className: 'sop-can' },
                                    tr('reclaimable') + ' ' + fmtBytes(row.bytes),
                                    row.spill > 0 ? '（' + tr('spill') + ' ' + fmtBytes(row.spill) + '）' : '',
                                    row.superseded > 0 ? '（' + tr('superseded') + ' ' + fmtBytes(row.superseded) + '）' : '',
                                  )
                                : h('span', { className: 'sop-none' }, locked ? tr('runningLocked') : tr('noReclaim')),
                            ),
                          ),
                        );
                      }),
                    ),
                    // ── 无主垃圾 ──
                    h(
                      'div',
                      { className: 'sop-sec' },
                      h(
                        'div',
                        { className: 'sop-secHead' },
                        tr('unownedJunk'),
                        h(
                          'span',
                          { className: 'sop-secHeadMeta' },
                          fmtBytes(totals?.junkReclaimable) + ' ' + tr('reclaimable'),
                        ),
                      ),
                      junkRows.map((row) => {
                        const category = row.category;
                        const pickedHere = row.targets.length > 0 && row.targets.every((id) => picked.has(id));
                        const broken = category.blocked !== undefined;
                        return h(
                          'label',
                          { className: 'sop-row' + (broken || row.targets.length === 0 ? ' sop-zero' : ''), key: category.id },
                          h('input', {
                            type: 'checkbox',
                            checked: pickedHere,
                            disabled: broken || row.targets.length === 0 || phase === 'working',
                            onChange: () => toggleGroup(row.targets),
                          }),
                          h(
                            'div',
                            { className: 'sop-main' },
                            h(
                              'div',
                              { className: 'sop-top' },
                              h('span', { className: 'sop-name' }, categoryTitle(category)),
                              h('span', { className: 'sop-occ' }, fmtBytes(row.bytes)),
                            ),
                            h('div', { className: 'sop-line' }, category.note ?? ''),
                            broken ? h('div', { className: 'sop-line', style: { color: 'var(--dsw-alias-label-primary)' } }, category.blocked) : null,
                            asArray(category.items).length > 0 ? renderItems(category.id, category.items) : null,
                          ),
                        );
                      }),
                    ),
                    h('div', { className: 'sop-note' }, h('b', null, tr('keptTitle') + '：'), ledger?.kept ?? tr('keptNote')),
                    hasResult
                      ? h(
                          'div',
                          { className: 'sop-summary' },
                          tr('freed') + ' ' + fmtBytes(result.freedBytes) + '（' + result.freedFiles + ' ' + tr('fileUnit') + '）。',
                          asArray(result.failures).length > 0
                            ? ' ' + asArray(result.failures).length + ' ' + tr('failures')
                            : '',
                          result.stale > 0 ? ' ' + result.stale + ' ' + tr('skippedCount') : '',
                        )
                      : null,
                    error !== null ? h('div', { className: 'sop-err' }, tr('failed') + '：' + error) : null,
                  ),
                  h(
                    'div',
                    { className: 'sop-foot' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'sop-link',
                        disabled: phase === 'scanning' || phase === 'working',
                        onClick: () => {
                          const all = [...allJunkTargets];
                          const allPicked = all.length > 0 && all.every((id) => picked.has(id));
                          if (allPicked) setPicked(new Set());
                          else setPicked(new Set(all));
                        },
                      },
                      allJunkTargets.length > 0 && allJunkTargets.every((id) => picked.has(id)) ? tr('selectNone') : tr('selectAll'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'sop-link',
                        disabled: phase === 'scanning' || phase === 'working',
                        onClick: () => void load(),
                      },
                      tr('rescan'),
                    ),
                    h('div', { className: 'sop-spacer' }),
                    h(
                      'span',
                      { className: 'sop-pick' },
                      tr('selected') + ' ' + picked.size + ' ' + tr('items') + ' · ' + fmtBytes(pickedBytes),
                    ),
                    phase === 'done'
                      ? h('button', { type: 'button', className: 'sop-link', onClick: closePanel }, tr('cancel'))
                      : h('button', { type: 'button', className: 'sop-link', onClick: closePanel }, tr('cancel')),
                    phase === 'done'
                      ? h('button', { type: 'button', className: 'sop-primary', onClick: closePanel }, tr('close'))
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'sop-primary',
                            disabled: phase !== 'ready' || picked.size === 0,
                            onClick: () => void run(),
                          },
                          phase === 'working' ? tr('releasing') : tr('release') + ' ' + fmtBytes(pickedBytes),
                        ),
                  ),
                ),
              ),
              document.body,
            )
          : null;

      return h(
        'div',
        { className: 'sop-root', 'data-space-optimizer': 'button' },
        // 样式表必须留在组件树里：侧栏插槽子树与 document 之间有样式隔离，
        // 挂到 document.head 的那份**照不到这个按钮**（面板走 portal 到 body 所以照常），
        // 结果就是按钮露出 UA 默认外观、一直挂着一圈黑框。
        h('style', null, CSS),
        h(
          'button',
          {
            type: 'button',
            className: 'sop-btn',
            title: tr('label'),
            'aria-label': tr('label'),
            onClick: openPanel,
          },
          h(SparkIcon, null),
          wide ? tr('label') : null,
        ),
        panel,
      );
    }

    const inject = ['slots', 'locale', 'sessions'];

    /**
     * 样式表**不能**挂到 `document.head`（曾经这么试过，结果是按钮一直挂着一圈黑框）。
     *
     * 侧栏插槽渲染出来的子树与文档之间存在样式隔离——文档级样式表照不到这个按钮，
     * 而面板因为是 portal 到 `document.body` 才照常。所以两处各带一份树内 `<style>`：
     *   · `.sop-root` 里那份 → 管按钮（在隔离树里）
     *   · `.sop-card` 里那份 → 管面板（在 body 里）
     * 「首帧图标被撑大」那个老毛病由图标自身的内在 `width/height` 兜住，不靠样式表时机。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'space-optimizer: dictionaries');
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'space-optimizer',
            order: 60,
            locale: NS,
            inject: () => ({ sessionsSource: ctx.sessions?.list }),
          },
          SpaceOptimizerPanel,
        ),
      );
    }

    return { name: 'space-optimizer', inject, apply };
  },
});
