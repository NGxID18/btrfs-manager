// --- UTILITIES & HELPERS ---
const $ = id => document.getElementById(id);
const cmd = args => cockpit.spawn(args, { superuser: "require" });
const parseSz = s => { const m = s.match(/([0-9.]+)\s*([a-zA-Z]+)/); return m ? parseFloat(m[1]) * ({"K":1024,"M":1048576,"G":1073741824,"T":1099511627776}[m[2][0].toUpperCase()]||1) : 0; };
const fmtSz = b => (b===0||isNaN(b)) ? "0 B" : (b/Math.pow(1024, Math.floor(Math.log(b)/Math.log(1024)))).toFixed(2) + " " + ["B","KiB","MiB","GiB","TiB"][Math.floor(Math.log(b)/Math.log(1024))];

// --- CUSTOM MODAL ENGINE ---
const Modal = {
    cb: null,
    show(title, msg, type = "alert", opts = null, cb = null) {
        $("generic-modal-title").innerText = title;
        $("generic-modal-message").innerText = msg;
        $("generic-modal-input-container").classList.toggle("hidden-element", type === "alert" || type === "confirm");
        $("generic-modal-input").classList.toggle("hidden-element", type !== "prompt");
        $("generic-modal-select").classList.toggle("hidden-element", type !== "select");
        
        if (type === "prompt") { $("generic-modal-input").value = opts || ""; setTimeout(() => $("generic-modal-input").focus(), 100); }
        if (type === "select") { $("generic-modal-select").innerHTML = opts.map(o => `<option value="${o.v}">${o.l}</option>`).join(""); }
        
        this.cb = cb;
        $("generic-modal").classList.remove("hidden-element");
    },
    close() { $("generic-modal").classList.add("hidden-element"); this.cb = null; },
    confirm() { 
        this.close(); 
        if(this.cb) this.cb(!$("generic-modal-select").classList.contains("hidden-element") ? $("generic-modal-select").value : $("generic-modal-input").value); 
    }
};
$("generic-modal-cancel").addEventListener("click", () => Modal.close());
$("generic-modal-confirm").addEventListener("click", () => Modal.confirm());

// --- CORE APP ENGINE ---
const App = {
    vols: [], hw: {}, mnt: {},

    async fetch() {
        if(!$("view-master").classList.contains("hidden-element")) $("disk-container").innerHTML = "<p class='loading-text'>Scanning BTRFS & Hardware...</p>";
        try {
            // Paralel eksekusi untuk BTRFS, Mounts, dan Hardware (lsblk)
            const [btrfsOut, mntOut, lsblkOut] = await Promise.all([
                cmd(["btrfs", "filesystem", "show"]),
                cmd(["findmnt", "-A", "-J", "-t", "btrfs"]).catch(() => "{}"),
                cmd(["lsblk", "-J", "-o", "PATH,MODEL,VENDOR,TYPE"])
            ]);

            // Mapping Mount Points
            this.mnt = {};
            const walk = (nodes) => nodes.forEach(n => { if(n.source) this.mnt[n.source] = n.target; if(n.children) walk(n.children); });
            walk(JSON.parse(mntOut).filesystems || []);

            // Mapping Hardware Info (Pewarisan Model dari Disk Induk ke Partisi Anak)
            this.hw = {};
            const parseHw = (nodes, parentModel) => nodes.forEach(n => {
                let model = [n.vendor, n.model].filter(Boolean).join(" ").trim() || parentModel;
                if(n.path) this.hw[n.path] = model || "Generic Storage";
                if(n.children) parseHw(n.children, model);
            });
            parseHw(JSON.parse(lsblkOut).blockdevices || []);

            this.parseBtrfs(btrfsOut);
        } catch(err) { $("disk-container").innerHTML = `<p class="text-danger mt-15">Critical Fetch Error: ${err.message}</p>`; }
    },

    parseBtrfs(out) {
        this.vols = out.split(/Label:\s+/i).filter(b => b.trim() !== "").map((block, idx) => {
            const mLabel = block.match(/^(?:'([^']*)'|(\S+))?\s+uuid:\s+([a-f0-9\-]+)/i);
            const uuid = mLabel ? mLabel[3] : "Unknown";
            const mPath = block.match(/path\s+(\/dev\/\S+)/i);
            const rootPath = mPath ? mPath[1] : "";
            const mountPoint = this.mnt[rootPath] || this.mnt[`UUID=${uuid}`] || this.mnt[rootPath+"1"] || this.mnt[rootPath+"2"] || "";
            
            let devs = [];
            let r = /devid\s+(\d+)\s+size\s+([0-9.]+\s?[a-zA-Z]+)\s+used\s+([0-9.]+\s?[a-zA-Z]+)\s+path\s+(\/dev\/\S+)/gi, match;
            while (match = r.exec(block)) devs.push({ id: match[1], size: match[2], path: match[4] });

            const rawSize = fmtSz(devs.reduce((sum, d) => sum + parseSize(d.size), 0));
            // Menyaring dan menggabungkan info hardware unik
            const hwList = [...new Set(devs.map(d => this.hw[d.path]))].filter(Boolean).join(" & ") || "Unknown Device";

            return { idx, label: (mLabel && (mLabel[1]||mLabel[2]) !== "none") ? (mLabel[1]||mLabel[2]) : "System/Root (No Label)", uuid, mountPoint, devs, rawSize, hwList, raid: "Loading...", usable: "Loading..." };
        });

        this.renderMaster();
        const activeIdx = $("detail-container").getAttribute("data-active-index");
        if(activeIdx !== null && !$("view-detail").classList.contains("hidden-element")) this.renderDetail(activeIdx);
        this.fetchDynamicMetrics();
    },

    async fetchDynamicMetrics() {
        for (let v of this.vols) {
            if (!v.mountPoint) { v.raid = "Mount required"; v.usable = "Locked (Not Mounted)"; this.updateUI(v); continue; }
            try {
                const [dfOut, hOut] = await Promise.all([ cmd(["btrfs", "filesystem", "df", v.mountPoint]), cmd(["df", "-B1", v.mountPoint]) ]);
                const dM = dfOut.match(/Data,\s*(.*?):/i), mM = dfOut.match(/Metadata,\s*(.*?):/i);
                v.raid = (dM ? `<span class="btrfs-code">Data: ${dM[1].toUpperCase()}</span>` : "") + (mM && dM && mM[1] !== dM[1] ? ` <span class="btrfs-code" style="background:#e2e8f0; color:#4a5568;">Meta: ${mM[1].toUpperCase()}</span>` : "");
                const dfLines = hOut.trim().split("\n");
                v.usable = dfLines.length > 1 ? fmtSz(parseInt(dfLines[1].trim().split(/\s+/)[1], 10)) : "Unknown";
            } catch(e) { v.raid = "Error"; v.usable = "Error"; }
            this.updateUI(v);
        }
    },

    updateUI(v) {
        if($(`master-usable-${v.idx}`)) $(`master-usable-${v.idx}`).innerHTML = v.usable;
        if($(`raid-display-${v.idx}`)) { $(`raid-display-${v.idx}`).innerHTML = v.raid; $(`usable-display-${v.idx}`).innerHTML = v.usable; }
    },

    renderMaster() {
        $("disk-container").innerHTML = this.vols.length ? this.vols.map(v => `
            <div class="btrfs-card hoverable animated-view h-100-col">
                <h3>${v.label}</h3>
                <p class="mb-5"><b>UUID:</b> <span class="btrfs-code">${v.uuid}</span></p>
                <p class="mb-5"><b>Hardware:</b> <span class="text-muted">${v.hwList}</span></p>
                <p class="mb-5"><b>Raw Capacity:</b> ${v.rawSize}</p>
                <p class="mb-5"><b>Usable Space:</b> <span id="master-usable-${v.idx}">${v.usable}</span></p>
                <p class="mb-15"><b>Mount Status:</b> ${v.mountPoint ? `<span class="text-success">${v.mountPoint}</span>` : `<span class="text-warning">Not Mounted</span> <button class="btn-primary btn-micro btn-action" data-action="mount-vol" data-uuid="${v.uuid}">Mount</button>`}</p>
                <button class="btn btn-secondary w-100 mt-auto btn-action" data-action="open-detail" data-index="${v.idx}">Manage Volume</button>
            </div>`).join('') : "<p class='mt-15'>No BTRFS filesystems found.</p>";
    },

    renderDetail(idx) {
        const v = this.vols.find(vol => vol.idx == idx);
        if (!v) return;
        $("detail-container").setAttribute("data-active-index", idx);

        const devHtml = v.devs.map(d => `<div class="topo-item"><span><span class="btrfs-code">${d.path}</span> <span class="text-muted">(ID: ${d.id} | Size: ${d.size})</span></span> ${v.mountPoint ? `<button class="btn btn-danger btn-sm btn-action" data-action="remove-dev" data-mount="${v.mountPoint}" data-devpath="${d.path}">Remove</button>` : ''}</div>`).join("");
        
        $("detail-container").innerHTML = `
            <h2 class="animated-view mb-25">${v.label}</h2>
            <div class="detail-layout-grid">
                <div class="detail-left-col animated-view">
                    <div class="btrfs-card">
                        <h4 class="section-title">System Information & Topology</h4>
                        <p class="mb-8"><b>UUID:</b> <span class="btrfs-code">${v.uuid}</span></p>
                        <p class="mb-8"><b>Hardware:</b> <span class="text-primary" style="font-weight:bold;">${v.hwList}</span></p>
                        <p class="mb-8"><b>Raw Capacity:</b> ${v.rawSize} <span class="text-muted">(Combined)</span></p>
                        <p class="mb-8"><b>Usable Space:</b> <span id="usable-display-${v.idx}" style="font-weight:bold;">${v.usable}</span></p>
                        <p class="mb-8"><b>Active Profile:</b> <span id="raid-display-${v.idx}">${v.raid}</span></p>
                        <p class="mb-25"><b>Mount Status:</b> ${v.mountPoint ? `<span class="text-success">${v.mountPoint}</span>` : `<span class="text-warning">Not Mounted</span>`}</p>
                        <p class="section-title mt-15">Physical Device Topology</p>
                        <div>${devHtml}</div>
                        ${v.mountPoint ? `<div class="advanced-topo-actions"><button class="btn btn-primary btn-sm btn-action" data-action="add-dev-modal" data-mount="${v.mountPoint}">Add Disk</button> <button class="btn btn-secondary btn-sm btn-action" data-action="convert-raid" data-mount="${v.mountPoint}">Convert RAID Profile</button> <button class="btn btn-secondary btn-sm btn-action" data-action="resize-vol" data-mount="${v.mountPoint}">Resize Volume</button></div>` : ''}
                    </div>
                    ${v.mountPoint ? `<div class="btrfs-card"><h4 class="section-title">Maintenance</h4><div class="flex-wrap-gap"><button class="btn btn-primary btn-sm btn-action" data-action="scrub" data-mount="${v.mountPoint}">Scrub</button> <button class="btn btn-secondary btn-sm btn-action" data-action="balance" data-mount="${v.mountPoint}">Balance (50%)</button> <button class="btn btn-secondary btn-sm btn-action" data-action="defrag" data-mount="${v.mountPoint}">Defrag+ZSTD</button></div><div id="maint-console-${v.mountPoint.replace(/\//g, '-')}" class="status-console hidden-element"></div></div>` : `<div class="warning-box"><p class="text-warning mb-5">Volume Locked</p><button class="btn btn-primary btn-sm btn-action" data-action="mount-vol" data-uuid="${v.uuid}">Mount Volume</button></div>`}
                </div>
                <div class="detail-right-col animated-view">
                    <div class="btrfs-card h-100-col">
                        <h4 class="section-title">Subvolumes & Snapshots</h4>
                        ${v.mountPoint ? `<div class="flex-wrap-gap mb-15"><input type="text" id="new-subvol-${v.idx}" placeholder="New subvolume name..." class="form-input flex-grow"><button class="btn btn-primary btn-sm btn-action" data-action="subvol-ops" data-op="create" data-mount="${v.mountPoint}" data-index="${v.idx}">Create</button> <button class="btn btn-secondary btn-sm btn-action" data-action="subvol-ops" data-op="snap-root" data-mount="${v.mountPoint}">Snap Root</button></div><div id="subvol-list-${v.idx}" class="subvol-list-full"><p class="p-15-muted">Loading...</p></div>` : '<p class="text-warning">Mount required to access Subvolumes.</p>'}
                    </div>
                </div>
            </div>`;
        if (v.mountPoint) this.fetchSubvols(v.mountPoint, v.idx);
    },

    async fetchSubvols(mount, idx) {
        try {
            const out = await cmd(["btrfs", "subvolume", "list", mount]);
            const html = out.trim().split("\n").filter(l => l.trim()).map(line => {
                const m = line.match(/ID\s+(\d+).*path\s+(.+)$/i);
                if (!m) return "";
                return `<div class="subvol-item animated-view"><div class="subvol-info"><span class="btrfs-code">/${m[2].trim()}</span><span class="text-muted">ID: ${m[1].trim()}</span></div><button class="btn btn-secondary btn-sm btn-action" data-action="manage-subvol" data-mount="${mount}" data-path="${m[2].trim()}" data-subid="${m[1].trim()}" data-index="${idx}">Manage</button></div>`;
            }).join("");
            $(`subvol-list-${idx}`).innerHTML = html || "<p class='mt-15 text-muted'>No custom subvolumes found.</p>";
        } catch(e) { $(`subvol-list-${idx}`).innerHTML = `<p class='text-danger mt-15'>Load failed: ${e.message}</p>`; }
    }
};

// --- GLOBAL EVENT DELEGATOR ---
document.body.addEventListener("click", e => {
    const tgt = e.target;
    if (!tgt.classList.contains("btn-action")) return;

    const action = tgt.getAttribute("data-action");
    const mnt = tgt.getAttribute("data-mount");
    const cBox = $(`maint-console-${(mnt || "").replace(/\//g, '-')}`) || { classList:{remove:()=>{}}, innerText:"" };
    const task = (msg, c, okMsg, ref = false) => { cBox.classList.remove("hidden-element"); cBox.innerText = msg; cmd(c).then(o => { cBox.innerText = `${okMsg}\n${o}`; if(ref) App.fetch(); }).catch(err => cBox.innerText = "Error:\n" + err.message); };

    switch(action) {
        case 'open-detail': $("view-master").classList.add("hidden-element"); $("view-detail").classList.remove("hidden-element"); App.renderDetail(tgt.getAttribute("data-index")); break;
        case 'mount-vol': Modal.show("Mount Volume", "Enter mount point directory:", "prompt", `/mnt/btrfs_${tgt.getAttribute("data-uuid").substring(0,8)}`, "Mount", (dir) => { if(dir) cmd(["sh", "-c", `mkdir -p ${dir} && mount UUID=${tgt.getAttribute("data-uuid")} ${dir}`]).then(()=>App.fetch()).catch(e=>Modal.show("Error", e.message, "alert")); }); break;
        case 'convert-raid': Modal.show("Online RAID Conversion", "Select new profile:", "select", [{v:"single",l:"Single"},{v:"raid0",l:"RAID 0"},{v:"raid1",l:"RAID 1"},{v:"raid10",l:"RAID 10"}], "Convert", (p) => { if(p) task(`Converting to ${p}...`, ["btrfs", "balance", "start", "-f", "-dconvert="+p, "-mconvert="+p, mnt], `Conversion to ${p} executed!`); }); break;
        case 'resize-vol': Modal.show("Resize Volume", "Target size (e.g. 'max', '+10G'):", "prompt", "max", "Resize", (sz) => { if(sz) task(`Resizing to ${sz}...`, ["btrfs", "filesystem", "resize", sz, mnt], "Resized!", true); }); break;
        case 'scrub': Modal.show("Start Scrub", `Start data scrubbing on ${mnt}?`, "confirm", null, "Start", () => task("Scrubbing...", ["btrfs", "scrub", "start", mnt], "Started. Check CLI for progress.")); break;
        case 'balance': Modal.show("Start Balance", `Rebalance blocks (50% usage) on ${mnt}?`, "confirm", null, "Start", () => task("Balancing...", ["btrfs", "balance", "start", "-dusage=50", mnt], "Done!")); break;
        case 'defrag': Modal.show("Defrag & Compress", `Run recursive ZSTD defragmentation?`, "confirm", null, "Start", () => task("Defragging...", ["btrfs", "filesystem", "defragment", "-r", "-czstd", mnt], "Defrag sent to kernel.")); break;
        case 'remove-dev': Modal.show("Remove Device", `Evacuate and remove ${tgt.getAttribute("data-devpath")}?`, "confirm", null, "Remove", () => task("Evacuating...", ["btrfs", "device", "remove", tgt.getAttribute("data-devpath"), mnt], "Removed!", true)); break;
        case 'manage-subvol': 
            $("manage-subvol-modal").classList.remove("hidden-element"); $("modal-subvol-path").innerText = "/" + tgt.getAttribute("data-path"); $("modal-subvol-id").innerText = "(ID: " + tgt.getAttribute("data-subid") + ")";
            document.querySelectorAll("#manage-subvol-modal .btn-action").forEach(b => { b.setAttribute("data-mount", mnt); b.setAttribute("data-path", tgt.getAttribute("data-path")); b.setAttribute("data-subid", tgt.getAttribute("data-subid")); b.setAttribute("data-index", tgt.getAttribute("data-index")); });
            break;
        case 'subvol-ops':
            $("manage-subvol-modal").classList.add("hidden-element");
            const op = tgt.getAttribute("data-op"); const p = tgt.getAttribute("data-path"); const i = tgt.getAttribute("data-index");
            const sName = (dt) => p ? `${p.split("/").pop()}_snap_${dt}` : `root_snap_${dt}`;
            
            if(op === "create") { const nm = $(`new-subvol-${i}`).value.trim(); if(!nm) return; cmd(["btrfs", "subvolume", "create", mnt === "/" ? `/${nm}` : `${mnt}/${nm}`]).then(()=>{ $(`new-subvol-${i}`).value = ""; App.fetchSubvols(mnt, i); }); }
            else if(op === "del") Modal.show("Delete", `Delete "${p}"?`, "confirm", null, "Delete", () => cmd(["btrfs", "subvolume", "delete", mnt === "/" ? `/${p}` : `${mnt}/${p}`]).then(()=>App.fetchSubvols(mnt, i)));
            else if(op.startsWith("snap")) Modal.show("Snapshot", "Name:", "prompt", sName(new Date().toISOString().replace(/[:.]/g,"-").slice(0,19)), "Create", (n) => { if(n) cmd(["btrfs", "subvolume", "snapshot", p ? (mnt==="/"?`/${p}`:`${mnt}/${p}`) : mnt, mnt==="/"?`/${n}`:`${mnt}/${n}`]).then(()=>App.fetchSubvols(mnt, i||tgt.getAttribute("data-index"))); });
            else if(op === "restore") Modal.show("Restore/Clone", "Target name:", "prompt", p.split("_snap_")[0]+"_restored", "Restore", (n) => { if(n) cmd(["btrfs", "subvolume", "snapshot", mnt==="/"?`/${p}`:`${mnt}/${p}`, mnt==="/"?`/${n}`:`${mnt}/${n}`]).then(()=>App.fetchSubvols(mnt, i)); });
            else if(op === "quota") Modal.show("Quota", `Set max limit (e.g. 50G):`, "prompt", "50G", "Apply", (l) => { if(l) cmd(["btrfs", "quota", "enable", mnt]).then(()=>cmd(["btrfs", "qgroup", "limit", l, mnt==="/"?`/${p}`:`${mnt}/${p}`]).then(()=>Modal.show("Success", "Quota Applied", "alert")).catch(e=>Modal.show("Error", e.message, "alert"))); });
            else if(op === "default") cmd(["btrfs", "subvolume", "set-default", tgt.getAttribute("data-subid"), mnt]).then(()=>Modal.show("Success", "Set as default root.", "alert")).catch(e=>Modal.show("Error", e.message, "alert"));
            break;
    }
});

$("btn-back-master").addEventListener("click", () => { $("view-detail").classList.add("hidden-element"); $("view-master").classList.remove("hidden-element"); $("detail-container").setAttribute("data-active-index", ""); });
$("btn-close-subvol-modal").addEventListener("click", () => $("manage-subvol-modal").classList.add("hidden-element"));

// --- BOOT ---
App.fetch();