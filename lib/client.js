// dsh-petdex-pet client half: floating petdex pet in the DSH web GUI.
// Standard bundle-client shape (0811): __ModuleLoader__.load({id, factory}),
// factory returns { name, apply }; client kernel calls apply(ctx) on mount and
// the returned dispose() on unmount. Zero platform deps: vanilla DOM, CSS
// injected inline, sprite sheet frame player driven by /petdex-pet/state.
//
// Sprite player: petdex spritesheet is an 8-column grid of 192x208 frames;
// state → row (see petdex pet-states.ts: idle=0, running-right=1, ...,
// review=8). The host reports the canonical state list; we animate the current
// state's row by stepping background-position-x through its frames.
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-petdex-pet',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const ROUTE = '/petdex-pet';
    const STATE_URL = ROUTE + '/state';
    const PETS_URL = ROUTE + '/pets';
    const PET_URL = ROUTE + '/pet';
    const AVAILABLE_URL = ROUTE + '/available';
    const INSTALL_URL = ROUTE + '/install';
    const ASSETS_URL = ROUTE + '/assets';
    const PREVIEW_URL = ROUTE + '/preview';
    const EVENTS_URL = ROUTE + '/events';

    const POLL_MS = 2000;
    const TICK_MS = 100;
    // cfg.size is now a percentage (40–150); 100% renders at SIZE_BASE_PX width.
    const SIZE_BASE_PX = 110;

    // Extract a pet slug from a petdex install command, a pet page URL, or a
    // bare slug. Examples accepted:
    //   doraemon
    //   npx petdex@latest install doraemon
    //   petdex install doraemon
    //   https://petdex.dev/pets/doraemon
    const parsePetCode = (text) => {
      const s = String(text || '').trim();
      if (s === '') return null;
      if (/^[a-z0-9][a-z0-9-]*$/.test(s)) return s;
      const m = /(?:petdex\.dev\/pets\/|install\s+)([a-z0-9][a-z0-9-]*)/i.exec(s);
      return m ? m[1] : null;
    };

    // Short labels for every spritesheet row (state-preview tiles).
    const STATE_LABELS = {
      idle: '空闲',
      'running-right': '向右跑',
      'running-left': '向左跑',
      waving: '挥手',
      jumping: '跳跃',
      failed: '失败',
      waiting: '等待',
      running: '奔跑',
      review: '思考',
    };

    // Defaults; replaced by /state payload.
    let cfg = { pet: 'gon', size: 100, enabled: true, petStates: [] };
    let state = 'idle';
    let frameW = 192;
    let frameH = 208;
    let cols = 8;
    let rows = 9;
    let sheetUrl = '';
    let sheetLoaded = false;

    // Row lookup: id → { row, frames, durationMs }.
    let stateRows = new Map();

    const CSS = `
[dsh-petdex-pet-root] { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  font-family: system-ui, sans-serif; user-select: none; touch-action: none; }
[dsh-petdex-pet-root] .dpp-stage { position: relative; display: grid; place-items: center;
  filter: drop-shadow(0 4px 6px rgba(0,0,0,.25)); pointer-events: none; }
[dsh-petdex-pet-root] .dpp-sprite { pointer-events: none; image-rendering: pixelated; }
[dsh-petdex-pet-root] .dpp-hitarea { position: absolute; inset: 0; cursor: grab;
  pointer-events: auto; touch-action: none; z-index: 3; border-radius: 8px; }
[dsh-petdex-pet-root] .dpp-hitarea.dragging { cursor: grabbing; }
[dsh-petdex-pet-root] .dpp-card { position: absolute; left: 50%; top: calc(100% + 14px);
  transform: translateX(-50%); width: max-content; min-width: 110px; padding: 6px 10px;
  background: rgba(27,30,40,.94); backdrop-filter: blur(10px) saturate(1.15);
  border: 1px solid rgba(255,255,255,.10); border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0,0,0,.38), 0 3px 8px rgba(0,0,0,.28);
  color: #E8EBF2; font-size: 11px; display: grid; gap: 4px; z-index: 1;
  opacity: 0; visibility: hidden; pointer-events: none;
  transition: opacity .15s ease-out, transform .15s ease-out, visibility 0s linear .2s; }
[dsh-petdex-pet-root]:hover .dpp-card { opacity: 1; visibility: visible; pointer-events: auto;
  transition: opacity .2s cubic-bezier(.16,1,.3,1), transform .2s cubic-bezier(.16,1,.3,1), visibility 0s;
  transition-delay: .06s; }
[dsh-petdex-pet-root] .dpp-card .dpp-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
[dsh-petdex-pet-root] .dpp-name { font-weight: 600; color: #E8EBF2; }
[dsh-petdex-pet-root] .dpp-state { background: rgba(86,134,254,.16); color: #B7C8FE;
  border-radius: 5px; padding: 2px 6px; font-size: 10px; font-weight: 600; }
[dsh-petdex-pet-root] .dpp-menu { display: none; position: absolute; left: 50%; top: calc(100% + 10px);
  transform: translateX(-50%); width: max-content; gap: 6px; padding: 6px; border-radius: 8px;
  background: rgba(20,20,28,.92); border: 1px solid rgba(255,255,255,.10); z-index: 4;
  max-height: 60vh; overflow-y: auto; }
[dsh-petdex-pet-root] .dpp-menu.open { display: grid; }
[dsh-petdex-pet-root] .dpp-menu button { border: 0; border-radius: 6px; padding: 4px 10px;
  font-size: 11px; cursor: pointer; background: rgba(255,255,255,.14); color: #E8EBF2;
  text-align: left; white-space: nowrap; display: flex; align-items: center; gap: 8px; }
[dsh-petdex-pet-root] .dpp-menu button:hover { background: rgba(255,255,255,.28); }
[dsh-petdex-pet-root] .dpp-menu .dpp-current { opacity: .55; cursor: default; }
[dsh-petdex-pet-root] .dpp-menu .dpp-thumb { width: 32px; height: 35px; flex: none;
  background-repeat: no-repeat; background-position: 0 0; border-radius: 4px;
  background-size: 256px 315px; image-rendering: pixelated; }
[dsh-petdex-pet-root] .dpp-menu .dpp-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
[dsh-petdex-pet-root] .dpp-menu .dpp-kind { font-size: 10px; color: rgba(232,235,242,.55); flex: none; }
[dsh-petdex-pet-root] .dpp-close { position: absolute; top: -8px; right: -8px; z-index: 5;
  width: 20px; height: 20px; border-radius: 50%; border: 1px solid rgba(255,255,255,.2);
  background: rgba(30,32,42,.92); color: #E8EBF2; font-size: 12px; line-height: 1;
  cursor: pointer; display: none; align-items: center; justify-content: center;
  padding: 0; }
[dsh-petdex-pet-root]:hover .dpp-close { display: flex; }
[dsh-petdex-pet-root] .dpp-close:hover { background: rgba(200,60,60,.9); }
[dsh-petdex-pet-root] .dpp-statusbox { position: absolute; left: 50%; bottom: calc(100% + 12px);
  transform: translateX(-50%); max-width: 200px; padding: 7px 12px; border-radius: 12px;
  background: rgba(27,30,40,.94); backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,.14);
  color: #E8EBF2; font-size: 12px; line-height: 1.45; text-align: center; font-weight: 500;
  pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  box-shadow: 0 8px 24px rgba(0,0,0,.35); }
[dsh-petdex-pet-root] .dpp-statusbox::after { content: ''; position: absolute; top: 100%; left: 50%;
  transform: translateX(-50%); border: 7px solid transparent; border-top-color: rgba(27,30,40,.94);
  filter: drop-shadow(0 1px 0 rgba(255,255,255,.06)); }
[dsh-petdex-pet-root] .dpp-statusbox { transition: opacity .3s ease-out, visibility 0s; }
[dsh-petdex-pet-root] .dpp-statusbox.hidden { opacity: 0; visibility: hidden;
  transition: opacity .3s ease-out, visibility 0s linear .35s; }
`;

    // ---- settings section (设置 → 宠物, a dedicated top-level entry) ----
    // Registers a `settings.section` so the pet config (pet/size/enabled)
    // appears as its OWN nav entry in the DSH settings panel — not inside the
    // built-in Plugins section. Fully defensive: if slots/React are
    // unavailable, the section is skipped and the pet still works.
    //
    // IMPORTANT: every control writes through the plugin's own HTTP routes
    // (/petdex-pet/*), NOT through the settings scope. The settings seam
    // deliberately refuses browser writes to plugin namespaces
    // (settings-not-exposed), so scope.set() there silently no-ops; the Node
    // half persists through the owner-side settings scope instead.
    let _react = null;
    try { _react = require('react'); } catch {}

    function registerSettingsSection(ctx, react) {
      const slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined;
      if (!slots || !react) return null;
      const h = react.createElement;
      const useEffect = react.useEffect;
      const useState = react.useState;
      const useRef = react.useRef;

      // Shared fetch helpers (loopback to the Node half).
      const fetchJSON = async (url, opts) => {
        try {
          const res = await fetch(url, { cache: 'no-store', ...opts });
          return res.ok ? await res.json() : null;
        } catch { return null; }
      };
      const postJSON = async (url, body) => {
        try {
          return await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        } catch { return null; }
      };
      const deleteJSON = async (url) => {
        try {
          const res = await fetch(url, { method: 'DELETE' });
          return res.ok;
        } catch { return false; }
      };

      // Thumbnail style: show sprite frame 0 (idle) scaled to 40px wide.
      const thumbStyle = (url) => ({
        width: 40, height: 43, flex: 'none', borderRadius: 6,
        backgroundImage: 'url("' + url + '")', backgroundRepeat: 'no-repeat',
        backgroundSize: '320px 387px', backgroundPosition: '0 0',
        imageRendering: 'pixelated', border: '1px solid rgba(255,255,255,.12)',
      });
      const cardStyle = { background: 'rgba(255,255,255,.05)', border: '1px solid rgba(128,128,128,.22)', borderRadius: 12, padding: '12px 14px' };
      const inputStyle = { width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', font: 'inherit' };
      const btnStyle = { border: '1px solid rgba(128,128,128,.35)', borderRadius: 8, padding: '6px 12px', background: 'rgba(255,255,255,.08)', color: 'inherit', cursor: 'pointer', font: 'inherit' };
      const switchTrackStyle = (on) => ({ position: 'relative', flex: 'none', width: 46, height: 26, borderRadius: 999, border: '1px solid rgba(128,128,128,.45)', padding: 0, cursor: 'pointer', background: on ? 'rgba(86,134,254,.9)' : 'rgba(128,128,128,.35)', transition: 'background .18s' });
      const switchKnobStyle = (on) => ({ position: 'absolute', top: 2, left: on ? 22 : 2, width: 20, height: 20, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.45)', transition: 'left .18s' });

      // One animated tile for one spritesheet row (used in the state preview).
      function StateTile({ url, meta, cols, width }) {
        const [idx, setIdx] = useState(0);
        const row = Math.max(0, meta.row | 0);
        const frames = Math.max(1, meta.frames | 0);
        const durationMs = meta.durationMs > 0 ? meta.durationMs : 800;
        useEffect(() => {
          setIdx(0);
          const per = Math.max(40, durationMs / frames);
          const t = setInterval(() => setIdx((i) => (i + 1) % frames), per);
          return () => clearInterval(t);
        }, [row, frames, durationMs]);
        const w = Math.max(24, width | 0);
        const hPx = Math.round((w * 208) / 192);
        const style = {
          width: w + 'px', height: hPx + 'px', borderRadius: 6,
          backgroundImage: 'url("' + url + '")', backgroundRepeat: 'no-repeat',
          backgroundSize: (w * (cols || 8)) + 'px ' + (hPx * 9) + 'px',
          backgroundPosition: (-idx * w) + 'px ' + (-row * hPx) + 'px',
          imageRendering: 'pixelated', border: '1px solid rgba(255,255,255,.14)',
          backgroundColor: 'rgba(255,255,255,.05)',
        };
        return h('div', { style: { display: 'grid', gap: 4, placeItems: 'center' } },
          h('div', { style }),
          h('div', { style: { fontSize: 10, opacity: 0.65 } }, STATE_LABELS[meta.id] ?? meta.id));
      }

      // ---- the settings section body ----
      // All controls write through the plugin's HTTP API / state; see the note
      // at the top of registerSettingsSection for why not the settings scope.
      function PetSettingsSection(props) {
        const [status, setStatus] = useState(null);     // { pet, displayName, state, text, spriteFile, enabled, size }
        const [pets, setPets] = useState(null);          // installed pets
        const [showGallery, setShowGallery] = useState(false);
        const [gallery, setGallery] = useState(null);    // available gallery pets
        const [busy, setBusy] = useState(null);          // slug being installed
        const [deleting, setDeleting] = useState(null);  // slug being deleted
        const [sizeVal, setSizeVal] = useState(100);
        const [sizeDirty, setSizeDirty] = useState(false);
        const [enabledVal, setEnabledVal] = useState(true);
        const [galQuery, setGalQuery] = useState('');   // gallery search text
        const [galLimit, setGalLimit] = useState(60); // rows shown so far
        const [installCmd, setInstallCmd] = useState(''); // install-by-code input
        const [cmdBusy, setCmdBusy] = useState(false);
        const [cmdMsg, setCmdMsg] = useState(null);      // { ok, text } install result
        const sizeTimer = useRef(null);

        const reload = async () => {
          const [st, pl] = await Promise.all([fetchJSON(STATE_URL), fetchJSON(PETS_URL)]);
          if (st) {
            setStatus(st);
            // adopt server truth unless the user is mid-drag on the slider
            if (typeof st.size === 'number' && !sizeDirty) setSizeVal(st.size);
            if (typeof st.enabled === 'boolean') setEnabledVal(st.enabled);
          }
          if (pl) setPets(pl);
        };
        useEffect(() => {
          reload();
          const t = setInterval(reload, 3000);
          return () => { clearInterval(t); if (sizeTimer.current !== null) clearTimeout(sizeTimer.current); };
        }, []);

        const openGallery = async () => {
          setShowGallery(!showGallery);
          setGalLimit(60);
          if (!gallery) {
            const g = await fetchJSON(AVAILABLE_URL);
            if (g && Array.isArray(g.pets)) setGallery(g.pets);
          }
        };
        const install = async (slug) => {
          setBusy(slug);
          await postJSON(INSTALL_URL, { slug });
          setBusy(null);
          setShowGallery(false);
          setGallery(null);
          reload();
        };
        // Install by pasting a petdex install command / pet page URL / slug.
        const installByCode = async () => {
          const slug = parsePetCode(installCmd);
          if (slug === null) {
            setCmdMsg({ ok: false, text: '无法识别：请粘贴安装命令（如 npx petdex@latest install doraemon）、宠物链接或 slug' });
            return;
          }
          setCmdBusy(true);
          setCmdMsg(null);
          const res = await postJSON(INSTALL_URL, { slug });
          setCmdBusy(false);
          if (res && res.ok) {
            const data = await res.json().catch(() => ({}));
            setCmdMsg({ ok: true, text: '安装成功：' + (data.displayName ?? data.slug ?? slug) });
            setInstallCmd('');
            reload();
          } else {
            let msg = '安装失败';
            if (res) {
              const j = await res.json().catch(() => ({}));
              msg = '安装失败' + (j && j.error ? '：' + j.error : '');
            }
            setCmdMsg({ ok: false, text: msg });
          }
        };
        const switchPet = async (slug) => {
          await postJSON(PET_URL, { pet: slug });
          reload();
        };
        // Size slider → debounced POST; the Node half resizes the pet and the
        // /state poll (plus SSE) confirms the applied value.
        const setSize = (n) => {
          setSizeVal(n);
          setSizeDirty(true);
          if (sizeTimer.current !== null) clearTimeout(sizeTimer.current);
          sizeTimer.current = setTimeout(async () => {
            sizeTimer.current = null;
            await postJSON(PET_URL, { size: n });
            setSizeDirty(false);
            reload();
          }, 250);
        };
        const toggleEnabled = async () => {
          const next = !enabledVal;
          setEnabledVal(next);
          await postJSON(PET_URL, { enabled: next });
          reload();
        };
        const removePet = async (slug) => {
          if (!window.confirm('确定要删除宠物「' + slug + '」吗？将同时移除本地文件。')) return;
          setDeleting(slug);
          try {
            await deleteJSON(PETS_URL + '/' + encodeURIComponent(slug));
          } catch {}
          setDeleting(null);
          reload();
        };

        const aPet = status ? { pet: status.pet, displayName: status.displayName, spriteFile: status.spriteFile ?? 'spritesheet.webp' } : { pet: 'gon', displayName: 'gon', spriteFile: 'spritesheet.webp' };
        const aText = status ? status.text : '空闲';
        const disabled = enabledVal === false;

        return h('div', { style: { display: 'grid', gap: '14px', maxWidth: 560 } },
          // --- status preview (synced with DSH) ---
          h('div', { style: { ...cardStyle, display: 'flex', alignItems: 'center', gap: 14 } },
            disabled
              ? h('div', { style: { opacity: 0.6, fontSize: 13 } }, '宠物已关闭')
              : h(react.Fragment, null,
                h('div', { style: thumbStyle(ASSETS_URL + '/' + aPet.pet + '/' + aPet.spriteFile) }),
                h('div', { style: { display: 'grid', gap: 2 } },
                  h('div', { style: { fontSize: 16, fontWeight: 600 } }, aPet.displayName),
                  h('div', { style: { fontSize: 12, opacity: 0.65 } }, aText)))),
          // --- state preview: every spritesheet row animated ---
          (status && Array.isArray(status.petStates) && status.petStates.length > 0)
            ? h('div', { style: cardStyle },
                h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '状态预览（全部动作）'),
                h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))', gap: 10 } },
                  status.petStates.map((meta) => h(StateTile, {
                    key: meta.id,
                    url: ASSETS_URL + '/' + aPet.pet + '/' + aPet.spriteFile,
                    meta: meta,
                    cols: 8,
                    width: 48,
                  }))))
            : null,
          // --- installed pets (thumbnail + name, click to switch; 🗑 deletes) ---
          h('div', { style: { display: 'grid', gap: 8 } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, '我的宠物'),
            !pets ? h('div', { style: { opacity: 0.5, fontSize: 12 } }, '加载中…')
              : h('div', { style: { display: 'grid', gap: 8 } },
                pets.map((p) => {
                  const isCurrent = p.slug === status?.pet;
                  return h('div', { key: p.slug, style: { display: 'flex', alignItems: 'center', gap: 8 } },
                    h('button', {
                      style: { ...btnStyle, display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', flex: 1, minWidth: 0, opacity: isCurrent ? 1 : 0.8, outline: isCurrent ? '1px solid rgba(120,160,255,.6)' : 'none' },
                      onClick: () => switchPet(p.slug),
                      title: isCurrent ? '当前宠物' : '点击切换到此宠物',
                    },
                      h('span', { style: thumbStyle(ASSETS_URL + '/' + p.slug + '/' + (p.spriteFile ?? 'spritesheet.webp')) }),
                      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (isCurrent ? '★ ' : '') + p.displayName)),
                    h('button', {
                      style: { ...btnStyle, padding: '6px 8px', color: '#ff9a9a', borderColor: 'rgba(255,120,120,.45)', flex: 'none' },
                      onClick: () => removePet(p.slug),
                      disabled: deleting === p.slug || busy !== null,
                      title: '删除「' + p.displayName + '」及本地文件',
                    }, deleting === p.slug ? '…' : '🗑'));
                }))),
          // --- install by petdex install code (e.g. npx petdex@latest install doraemon) ---
          h('div', { style: cardStyle },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '按安装代码一键安装'),
            h('div', { style: { fontSize: 11, opacity: 0.6, marginBottom: 8 } }, '粘贴 petdex.dev 页面上的安装命令、宠物链接或直接输入 slug，方便添加图库里没有列出的宠物'),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', {
                type: 'search',
                placeholder: 'npx petdex@latest install doraemon',
                value: installCmd,
                onChange: (e) => setInstallCmd(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); installByCode(); } },
                style: { ...inputStyle, flex: 1, padding: '6px 10px' },
                disabled: cmdBusy,
              }),
              h('button', {
                style: { ...btnStyle, flex: 'none', whiteSpace: 'nowrap' },
                onClick: () => installByCode(),
                disabled: cmdBusy || installCmd.trim() === '',
              }, cmdBusy ? '安装中…' : '安装')),
            cmdMsg && h('div', { style: { fontSize: 11, marginTop: 6, color: cmdMsg.ok ? '#9be3a0' : '#ff9a9a' } }, cmdMsg.text)),
          // --- add pet from gallery (searchable; previews proxied same-origin) ---
          h('div', { style: { display: 'grid', gap: 8 } },
            h('button', { style: btnStyle, onClick: openGallery }, showGallery ? '收起图库' : '➕ 从 petdex 图库添加…'),
            showGallery && (!gallery
              ? h('div', { style: { opacity: 0.5, fontSize: 12 } }, '加载图库中…')
              : h(react.Fragment, null,
                h('input', {
                  type: 'search',
                  placeholder: '搜索宠物名称 / 类型…',
                  value: galQuery,
                  onChange: (e) => { setGalQuery(e.target.value); setGalLimit(60); },
                  style: { ...inputStyle, padding: '6px 10px' },
                }),
                (() => {
                  const q = galQuery.trim().toLowerCase();
                  const filtered = gallery.filter((p) => {
                    if (!q) return true;
                    return ((p.slug ?? '') + ' ' + (p.displayName ?? '') + ' ' + (p.kind ?? '')).toLowerCase().indexOf(q) !== -1;
                  });
                  if (filtered.length === 0) {
                    return h('div', { style: { opacity: 0.5, fontSize: 12 } }, '没有匹配的宠物');
                  }
                  const shown = filtered.slice(0, galLimit);
                  return h(react.Fragment, null,
                    h('div', { style: { fontSize: 11, opacity: 0.6 } }, '图库共 ' + gallery.length + ' 只，匹配 ' + filtered.length + ' 只（显示前 ' + shown.length + ' 只）'),
                    h('div', { style: { display: 'grid', gap: 6, maxHeight: 260, overflowY: 'auto', border: '1px solid rgba(128,128,128,.2)', borderRadius: 8, padding: 8 } },
                      shown.map((p) => h('button', {
                        key: p.slug,
                        style: { ...btnStyle, display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left' },
                        onClick: () => install(p.slug),
                        disabled: busy === p.slug,
                      },
                        h('span', { style: thumbStyle(PREVIEW_URL + '/' + p.slug) }),
                        h('span', { style: { flex: 1, minWidth: 0 } }, p.displayName),
                        h('span', { style: { fontSize: 11, opacity: 0.5 } }, busy === p.slug ? '安装中…' : (p.kind ?? ''))))),
                    filtered.length > shown.length
                      ? h('button', {
                          style: { ...btnStyle, justifyContent: 'center' },
                          onClick: () => setGalLimit((n) => n + 60),
                        }, '加载更多 ' + (filtered.length - shown.length) + ' 只…')
                      : null);
                })()))),
          // --- size (percentage slider) ---
          h('div', { style: cardStyle },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 } },
              h('span', { style: { fontSize: 13, fontWeight: 600 } }, '宠物大小'),
              h('span', { style: { fontSize: 12, fontWeight: 600 } }, sizeVal + '%')),
            h('input', {
              type: 'range', min: 40, max: 150, step: 5,
              value: sizeVal,
              onChange: (e) => setSize(Number(e.target.value)),
              style: { width: '100%', accentColor: 'rgba(86,134,254,.9)', cursor: 'pointer' },
            }),
            h('div', { style: { fontSize: 11, opacity: 0.5, marginTop: 6 } }, '拖动滑块调整宠物大小')),
          // --- enabled (switch) ---
          h('div', { style: { ...cardStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
            h('div', { style: { display: 'grid', gap: 2 } },
              h('span', { style: { fontSize: 13, fontWeight: 600 } }, '启用宠物'),
              h('span', { style: { fontSize: 11, opacity: 0.55 } }, enabledVal ? '右下角可见' : '右下角已隐藏')),
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': enabledVal,
              onClick: () => toggleEnabled(),
              style: switchTrackStyle(enabledVal),
            }, h('span', { style: switchKnobStyle(enabledVal) }))));
      }

      let sectionDisposer = null;
      try {
        sectionDisposer = slots.register({
          name: 'settings.section',
          id: 'pet',
          order: 30,
          label: () => '宠物',
          children: { 'settings.pet.item': { kind: 'list', scope: 'root' } },
        }, PetSettingsSection);
      } catch (e) {
        console.error('[dsh-petdex-pet] settings section register failed:', e);
      }
      return typeof sectionDisposer === 'function' ? sectionDisposer : null;
    }

    function apply(ctx = {}) {
      const sectionDispose = registerSettingsSection(ctx, _react);
      const petDispose = mountPet(ctx);
      // Diagnostic: expose section registration state on the pet root.
      const root = document.querySelector('[dsh-petdex-pet-root]');
      if (root) root.setAttribute('data-card-state', typeof sectionDispose === 'function' ? 'ok' : 'skipped');
      return () => {
        try { if (typeof sectionDispose === 'function') sectionDispose(); } catch {}
        try { if (typeof petDispose === 'function') petDispose(); } catch {}
      };
    }

    // The pet mounting body was the previous apply; rename for clarity.
    function mountPet(ctx = {}) {
      // ---- DOM ----
      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);

      const root = document.createElement('div');
      root.setAttribute('dsh-petdex-pet-root', '');
      const stage = document.createElement('div');
      stage.className = 'dpp-stage';
      const sprite = document.createElement('div');
      sprite.className = 'dpp-sprite';
      const hitarea = document.createElement('div');
      hitarea.className = 'dpp-hitarea';
      stage.appendChild(sprite);
      stage.appendChild(hitarea);

      // Close (×) button — hides the pet persistently.
      const closeBtn = document.createElement('button');
      closeBtn.className = 'dpp-close';
      closeBtn.textContent = '×';
      closeBtn.title = '关闭宠物';
      closeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await fetch(PET_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
          });
        } catch {}
        root.style.display = 'none';
        menu.classList.remove('open');
      });

      // Status text box — synced with DSH activity. It auto-hides: shown on every
      // state/text change, then fades out once the same state persists ~5s
      // (so a lingering "空闲" does not stay on screen forever).
      const statusBox = document.createElement('div');
      statusBox.className = 'dpp-statusbox';
      statusBox.textContent = '空闲';
      let lastStatusText = null;
      let statusTimer = null;
      const updateStatus = (text) => {
        if (text === lastStatusText) return; // same state → keep existing countdown
        lastStatusText = text;
        statusBox.textContent = text;
        statusBox.classList.remove('hidden');
        if (statusTimer !== null) clearTimeout(statusTimer);
        statusTimer = setTimeout(() => statusBox.classList.add('hidden'), 5000);
      };

      const card = document.createElement('div');
      card.className = 'dpp-card';
      card.innerHTML = '<div class="dpp-row"><span class="dpp-name"></span><span class="dpp-state"></span></div>';

      const menu = document.createElement('div');
      menu.className = 'dpp-menu';

      root.appendChild(closeBtn);
      root.appendChild(stage);
      root.appendChild(statusBox);
      root.appendChild(card);
      root.appendChild(menu);
      document.body.appendChild(root);

      const nameEl = card.querySelector('.dpp-name');
      const stateEl = card.querySelector('.dpp-state');

      // ---- sizing ----
      const pxSize = () => Math.round((cfg.size || 100) * SIZE_BASE_PX / 100);
      const applySize = () => {
        const w = pxSize();
        const h = Math.round((w * frameH) / frameW);
        stage.style.width = w + 'px';
        stage.style.height = h + 'px';
        sprite.style.width = w + 'px';
        sprite.style.height = h + 'px';
        sprite.style.backgroundSize = (w * cols) + 'px ' + (h * rows) + 'px';
      };

      // ---- sprite frame animation ----
      let frameIndex = 0;
      let frameTimer = null;
      let lastRow = -1;
      // set while a hover greeting animation is playing; refresh() then skips
      // overriding the sprite until the greeting finishes
      let hoverActive = false;
      // while running, cycle the direction variants (running / running-right /
      // running-left) so more of the spritesheet rows appear in live use
      const RUN_VARIANTS = ['running', 'running-right', 'running-left'];
      let runVariant = 0;

      const applySprite = () => {
        if (!sheetUrl) return;
        sprite.style.backgroundImage = 'url("' + sheetUrl + '")';
        sheetLoaded = true;
      };

      const playState = (id) => {
        const meta = stateRows.get(id);
        if (!meta) return;
        if (meta.row !== lastRow) {
          lastRow = meta.row;
          frameIndex = 0;
        }
        const w = pxSize();
        const hPx = (w * frameH) / frameW;
        sprite.style.backgroundPosition =
          (-frameIndex * w) + 'px ' + (-meta.row * hPx) + 'px';
        if (frameTimer !== null) { clearInterval(frameTimer); frameTimer = null; }
        const per = Math.max(40, meta.durationMs / (meta.frames || 1));
        frameTimer = setInterval(() => {
          frameIndex = (frameIndex + 1) % (meta.frames || 1);
          sprite.style.backgroundPosition =
            (-frameIndex * w) + 'px ' + (-meta.row * hPx) + 'px';
        }, per);
      };

      // ---- polling ----
      let pollTimer = null;
      let sse = null;

      const refresh = async () => {
        try {
          const res = await fetch(STATE_URL, { cache: 'no-store' });
          if (!res.ok) return;
          const data = await res.json();
          const prevPet = cfg.pet;
          cfg = { ...cfg, pet: data.pet, displayName: data.displayName, size: data.size ?? cfg.size, enabled: data.enabled, petStates: data.petStates ?? [] };
          state = data.state ?? 'idle';
          // enabled=false → hide the pet (close button). enabled=true → show.
          if (data.enabled === false && root.style.display !== 'none') {
            root.style.display = 'none';
          } else if (data.enabled !== false && root.style.display === 'none') {
            root.style.display = '';
          }
          stateRows = new Map((data.petStates ?? []).map((s) => [s.id, s]));
          if (stateRows.size === 0) {
            // Fallback canonical table if host omits it.
            stateRows = new Map([
              ['idle', { row: 0, frames: 6, durationMs: 1100 }],
              ['running-right', { row: 1, frames: 8, durationMs: 1060 }],
              ['running-left', { row: 2, frames: 8, durationMs: 1060 }],
              ['waving', { row: 3, frames: 4, durationMs: 700 }],
              ['jumping', { row: 4, frames: 5, durationMs: 840 }],
              ['failed', { row: 5, frames: 8, durationMs: 1220 }],
              ['waiting', { row: 6, frames: 6, durationMs: 1010 }],
              ['running', { row: 7, frames: 6, durationMs: 820 }],
              ['review', { row: 8, frames: 6, durationMs: 1030 }],
            ]);
          }
          const spriteFile = data.spriteFile ?? 'spritesheet.webp';
          if (data.pet !== prevPet || !sheetUrl || sheetUrl.indexOf(spriteFile) === -1) {
            sheetUrl = ASSETS_URL + '/' + data.pet + '/' + spriteFile;
            sheetLoaded = false;
            applySprite();
          }
          nameEl.textContent = data.displayName ?? data.pet;
          stateEl.textContent = state;
          updateStatus(typeof data.text === 'string' && data.text !== '' ? data.text : state);
          applySize();
          // while a hover greeting is playing, don't let the poll override it
          if (!hoverActive) {
            let live = state;
            if (live === 'running') {
              runVariant = (runVariant + 1) % RUN_VARIANTS.length;
              live = RUN_VARIANTS[runVariant];
            }
            playState(live);
          }
        } catch {
          // host not reachable yet — retry next poll
        }
      };

      // ---- drag ----
      let dragging = false;
      let dragMoved = false;
      let startX = 0, startY = 0, baseLeft = 0, baseTop = 0;

      const onPointerDown = (e) => {
        if (e.button !== 0) return; // left button only
        dragging = true;
        dragMoved = false;
        startX = e.clientX; startY = e.clientY;
        const rect = root.getBoundingClientRect();
        baseLeft = rect.left; baseTop = rect.top;
        root.style.left = baseLeft + 'px';
        root.style.top = baseTop + 'px';
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        hitarea.setPointerCapture(e.pointerId);
        hitarea.classList.add('dragging');
      };
      const onPointerMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 4) dragMoved = true;
        if (dragMoved) {
          root.style.left = Math.max(0, Math.min(baseLeft + dx, window.innerWidth - root.offsetWidth)) + 'px';
          root.style.top = Math.max(0, Math.min(baseTop + dy, window.innerHeight - root.offsetHeight)) + 'px';
        }
      };
      const onPointerUp = (e) => {
        if (!dragging) return;
        dragging = false;
        hitarea.classList.remove('dragging');
        if (!dragMoved) toggleMenu();
      };
      const toggleMenu = async () => {
        const open = menu.classList.toggle('open');
        if (open) await renderMenu();
      };
      const renderMenu = async () => {
        menu.innerHTML = '';
        // --- installed pets (thumbnail + name) ---
        const pets = await (async () => {
          try {
            const res = await fetch(PETS_URL, { cache: 'no-store' });
            if (!res.ok) return [];
            return await res.json();
          } catch { return []; }
        })();
        const title = document.createElement('div');
        title.textContent = '👋 ' + (cfg.displayName ?? cfg.pet);
        title.style.cssText = 'padding:2px 10px;font-weight:600;font-size:11px;color:#E8EBF2;';
        menu.appendChild(title);
        for (const p of pets) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:6px;';
          const btn = document.createElement('button');
          const thumb = document.createElement('span');
          thumb.className = 'dpp-thumb';
          thumb.style.backgroundImage = 'url("' + ASSETS_URL + '/' + p.slug + '/' + (p.spriteFile ?? 'spritesheet.webp') + '")';
          const label = document.createElement('span');
          label.className = 'dpp-label';
          label.textContent = (p.slug === cfg.pet ? '★ ' : '') + p.displayName;
          btn.appendChild(thumb);
          btn.appendChild(label);
          btn.style.flex = '1';
          if (p.slug === cfg.pet) btn.className = 'dpp-current';
          else btn.addEventListener('click', (e) => { e.stopPropagation(); switchPet(p.slug); });
          row.appendChild(btn);
          const del = document.createElement('button');
          del.textContent = '🗑';
          del.title = '删除 ' + p.displayName + '（移除本地文件）';
          del.style.cssText = 'flex:none;padding:4px 8px;color:#ff9a9a;';
          del.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!window.confirm('确定要删除宠物「' + p.displayName + '」吗？将同时移除本地文件。')) return;
            del.disabled = true;
            del.textContent = '…';
            try {
              await fetch(PETS_URL + '/' + encodeURIComponent(p.slug), { method: 'DELETE' });
            } catch {}
            await refresh();
            renderMenu();
          });
          row.appendChild(del);
          menu.appendChild(row);
        }
        // --- add pet from gallery ---
        const addBtn = document.createElement('button');
        addBtn.textContent = '➕ 添加宠物…';
        addBtn.addEventListener('click', (e) => { e.stopPropagation(); renderGallery(); });
        menu.appendChild(addBtn);
        // --- install by petdex install code ---
        const installCodeBtn = document.createElement('button');
        installCodeBtn.textContent = '⌨️ 按安装代码安装…';
        installCodeBtn.addEventListener('click', (e) => { e.stopPropagation(); renderInstall(); });
        menu.appendChild(installCodeBtn);
        // --- close ---
        const closeBtnItem = document.createElement('button');
        closeBtnItem.textContent = '❌ 关闭宠物';
        closeBtnItem.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await fetch(PET_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ enabled: false }),
            });
          } catch {}
          root.style.display = 'none';
          menu.classList.remove('open');
        });
        menu.appendChild(closeBtnItem);
      };

      // Gallery: list available pets from petdex.dev and install on click.
      const renderGallery = async () => {
        menu.innerHTML = '';
        const back = document.createElement('button');
        back.textContent = '← 返回';
        back.addEventListener('click', (e) => { e.stopPropagation(); renderMenu(); });
        menu.appendChild(back);
        const hint = document.createElement('div');
        hint.style.cssText = 'padding:2px 10px;font-size:11px;color:rgba(232,235,242,.6);';
        hint.textContent = '从 petdex 图库添加:';
        menu.appendChild(hint);
        let entries = [];
        try {
          const res = await fetch(AVAILABLE_URL, { cache: 'no-store' });
          if (res.ok) {
            const data = await res.json();
            entries = data.pets ?? [];
          }
        } catch {}
        if (entries.length === 0) {
          const empty = document.createElement('div');
          empty.textContent = '加载图库失败或已全部安装';
          empty.style.cssText = 'padding:4px 10px;font-size:11px;color:rgba(232,235,242,.6);';
          menu.appendChild(empty);
          return;
        }
        const search = document.createElement('input');
        search.type = 'search';
        search.placeholder = '搜索名称 / 类型…';
        search.style.cssText = 'margin:0 6px 6px;padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#E8EBF2;font:inherit;font-size:11px;';
        menu.appendChild(search);
        const box = document.createElement('div');
        box.style.cssText = 'display:grid;gap:6px;max-height:40vh;overflow-y:auto;';
        menu.appendChild(box);
        const renderList = (queryText) => {
          box.innerHTML = '';
          const q = (queryText ?? '').trim().toLowerCase();
          const filtered = entries.filter((p) => {
            if (!q) return true;
            return ((p.slug ?? '') + ' ' + (p.displayName ?? '') + ' ' + (p.kind ?? '')).toLowerCase().indexOf(q) !== -1;
          });
          if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = '没有匹配的宠物';
            empty.style.cssText = 'padding:4px 10px;font-size:11px;color:rgba(232,235,242,.6);';
            box.appendChild(empty);
            return;
          }
          const count = document.createElement('div');
          count.textContent = '共 ' + entries.length + ' 个，匹配 ' + filtered.length + ' 个（显示前 ' + Math.min(shown, filtered.length) + ' 个），可用搜索筛选';
          count.style.cssText = 'padding:2px 10px;font-size:11px;color:rgba(232,235,242,.6);';
          box.appendChild(count);
          for (const p of filtered.slice(0, shown)) {
            const btn = document.createElement('button');
            btn.style.cssText = 'display:flex;align-items:center;gap:8px;text-align:left;';
            const thumb = document.createElement('span');
            thumb.style.cssText = 'width:36px;height:39px;flex:none;border-radius:4px;background-image:url("' + PREVIEW_URL + '/' + p.slug + '");background-repeat:no-repeat;background-position:0 0;background-size:288px 351px;background-color:rgba(255,255,255,.06);image-rendering:pixelated;';
            btn.appendChild(thumb);
            const label = document.createElement('span');
            label.className = 'dpp-label';
            label.textContent = p.displayName;
            const kind = document.createElement('span');
            kind.className = 'dpp-kind';
            kind.textContent = p.kind ?? '';
            btn.appendChild(label);
            btn.appendChild(kind);
            btn.addEventListener('click', async (e) => {
              e.stopPropagation();
              if (btn.disabled) return;
              btn.textContent = '安装中…';
              btn.disabled = true;
              try {
                const res = await fetch(INSTALL_URL, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ slug: p.slug }),
                });
                if (res.ok) {
                  menu.classList.remove('open');
                  refresh();
                } else {
                  const err = await res.json().catch(() => ({}));
                  btn.textContent = '失败: ' + (err.error ?? res.status);
                  btn.disabled = false;
                }
              } catch {
                btn.textContent = '失败';
                btn.disabled = false;
              }
            });
            box.appendChild(btn);
          }
          if (filtered.length > shown) {
            const more = document.createElement('button');
            more.textContent = '加载更多 ' + (filtered.length - shown) + ' 个…';
            more.addEventListener('click', (e) => {
              e.stopPropagation();
              shown += 60;
              renderList(search.value);
            });
            box.appendChild(more);
          }
        };
        let shown = 60;
        renderList('');
        search.addEventListener('input', (e) => { e.stopPropagation(); renderList(search.value); });
      };

      // Install by pasting a petdex install command / pet page URL / slug.
      const renderInstall = async () => {
        menu.innerHTML = '';
        const back = document.createElement('button');
        back.textContent = '← 返回';
        back.addEventListener('click', (e) => { e.stopPropagation(); renderMenu(); });
        menu.appendChild(back);
        const hint = document.createElement('div');
        hint.style.cssText = 'padding:2px 10px;font-size:11px;color:rgba(232,235,242,.6);';
        hint.textContent = '粘贴安装命令、宠物链接或 slug:';
        menu.appendChild(hint);
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;padding:0 6px 6px;';
        const input = document.createElement('input');
        input.type = 'search';
        input.placeholder = 'npx petdex@latest install doraemon';
        input.style.cssText = 'flex:1;min-width:0;padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#E8EBF2;font:inherit;font-size:11px;';
        const btn = document.createElement('button');
        btn.textContent = '安装';
        const status = document.createElement('div');
        status.style.cssText = 'padding:2px 10px 6px;font-size:11px;color:rgba(232,235,242,.7);white-space:normal;';
        const doInstall = async () => {
          const slug = parsePetCode(input.value);
          if (slug === null || btn.disabled) {
            if (slug === null) {
              status.style.color = '#ff9a9a';
              status.textContent = '无法识别：请粘贴安装命令、宠物链接或 slug';
            }
            return;
          }
          btn.disabled = true;
          btn.textContent = '安装中…';
          status.textContent = '';
          try {
            const res = await fetch(INSTALL_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ slug }),
            });
            if (res.ok) {
              const data = await res.json().catch(() => ({}));
              status.style.color = '#9be3a0';
              status.textContent = '安装成功：' + (data.displayName ?? data.slug ?? slug);
              input.value = '';
              await refresh();
              setTimeout(() => { menu.classList.remove('open'); }, 900);
            } else {
              const err = await res.json().catch(() => ({}));
              status.style.color = '#ff9a9a';
              status.textContent = '安装失败' + (err && err.error ? '：' + err.error : '');
            }
          } catch {
            status.style.color = '#ff9a9a';
            status.textContent = '安装失败';
          }
          btn.disabled = false;
          btn.textContent = '安装';
        };
        input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); doInstall(); } });
        btn.addEventListener('click', (e) => { e.stopPropagation(); doInstall(); });
        row.appendChild(input);
        row.appendChild(btn);
        menu.appendChild(row);
        menu.appendChild(status);
        setTimeout(() => { try { input.focus(); } catch {} }, 50);
      };

      const switchPet = async (slug) => {
        try {
          await fetch(PET_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pet: slug }),
          });
        } catch {}
        menu.classList.remove('open');
        refresh();
      };

      hitarea.addEventListener('pointerdown', onPointerDown);
      hitarea.addEventListener('pointermove', onPointerMove);
      hitarea.addEventListener('pointerup', onPointerUp);
      hitarea.addEventListener('pointercancel', onPointerUp);

      // ---- hover interaction: wave at the pointer, then resume live state ----
      let hoverTimer = null;
      const stopHover = () => {
        if (hoverTimer !== null) { clearTimeout(hoverTimer); hoverTimer = null; }
        if (hoverActive) {
          hoverActive = false;
          playState(state);
        }
      };
      const onHoverEnter = () => {
        if (dragging || hoverActive) return;
        hoverActive = true;
        // Randomly greet: wave or think (review state is preview-only in live
        // use, so make it reachable here).
        playState(Math.random() < 0.5 ? 'waving' : 'review');
        hoverTimer = setTimeout(stopHover, 1600);
      };
      hitarea.addEventListener('pointerenter', onHoverEnter);
      hitarea.addEventListener('pointerleave', stopHover);

      // ---- visibility: pause timers when tab hidden ----
      const onVisibility = () => {
        if (document.visibilityState === 'visible') {
          if (pollTimer === null) pollTimer = setInterval(refresh, POLL_MS);
          refresh();
        } else {
          if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
        }
      };
      document.addEventListener('visibilitychange', onVisibility);

      // ---- init ----
      applySize();
      refresh();
      pollTimer = setInterval(refresh, POLL_MS);
      try {
        sse = new EventSource(EVENTS_URL);
        sse.onmessage = () => refresh();
      } catch {}

      // ---- dispose ----
      const dispose = () => {
        if (pollTimer !== null) clearInterval(pollTimer);
        if (frameTimer !== null) clearInterval(frameTimer);
        if (sse !== null) sse.close();
        document.removeEventListener('visibilitychange', onVisibility);
        hitarea.removeEventListener('pointerdown', onPointerDown);
        hitarea.removeEventListener('pointermove', onPointerMove);
        hitarea.removeEventListener('pointerup', onPointerUp);
        hitarea.removeEventListener('pointercancel', onPointerUp);
        hitarea.removeEventListener('pointerenter', onHoverEnter);
        hitarea.removeEventListener('pointerleave', stopHover);
        if (hoverTimer !== null) clearTimeout(hoverTimer);
        if (statusTimer !== null) clearTimeout(statusTimer);
        root.remove();
        style.remove();
      };
      return dispose;
    }

    module.exports = { name: 'dsh-petdex-pet', inject: ['slots', 'settingsScope'], apply };
    return module.exports;
  }
});
