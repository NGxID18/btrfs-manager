// --- UTILITIES & FAILSAFE HELPERS ---
const $ = id => document.getElementById(id);
const on = (id, evt, cb) => { const e = $(id); if(e) e.addEventListener(evt, cb); };
const cmd = args => cockpit.spawn(args, { superuser: "require" });
const parseSize = s => { const m = s.match(/([0-9.]+)\s*([a-zA-Z]+)/); return m ? parseFloat(m[1]) * ({"K":1024,"M":1048576,"G":1073741824,"T":1099511627776}[m[2][0].toUpperCase()]||1) : 0; };
const formatSize = b => (b===0||isNaN(b)) ? "0 B" : (b/Math.pow(1024, Math.floor(Math.log(b)/Math.log(1024)))).toFixed(2) + " " + ["B","KiB","MiB","GiB","TiB"][Math.floor(Math.log(b)/Math.log(1024))];

// --- CUSTOM MODAL ENGINE ---
const Modal = {
    cb: null,
    show(title, msg, type = "alert", opts = null, cb = null) {
        try {
            $("generic-modal-title").innerText = title;
            $("generic-modal-message").innerText = msg;
            $("generic-modal-input-container").classList.toggle("hidden-element", type === "alert" || type === "confirm");
            $("generic-modal-input").classList.toggle("hidden-element", type !== "prompt");
            $("generic-modal-select").classList.toggle("hidden-element", type !== "select");
            
            if (type === "prompt") { $("generic-modal-input").value = opts || ""; setTimeout(() => $("generic-modal-input").focus(), 100); }
            if (type === "select") { $("generic-modal-select").innerHTML = opts.map(o => `<option value="${o.v}">${o.l}</option>`).join(""); }
            
            this.cb = cb;
            $("generic-modal").classList.remove("hidden-element");
        } catch (e) { console.error("Modal Error:", e); }
    },
    close() { if($("generic-modal")) $("generic-modal").classList.add("hidden-element"); this.cb = null; },
    confirm() { 
        const actionCallback = this.cb; 
        this.close(); 
        if(actionCallback) actionCallback(!$("generic-modal-select").classList.contains("hidden-element") ? $("generic-modal-select").value : $("generic-modal-input").value); 
    }
};

function customAlert(title, message) { Modal.show(title, message, "alert", null, null); }
function customConfirm(title, message, confirmBtnText, onConfirm) { Modal.show(title, message, "confirm", null, onConfirm); }
function customPrompt(title, message, defaultVal, confirmBtnText, onConfirm) { Modal.show(title, message, "prompt", defaultVal, onConfirm); }
function customSelect(title, message, options, confirmBtnText, onConfirm) { Modal.show(title, message, "select", options, onConfirm); }

// --- DEVICE FETCHING ---
const getEmptyDevices = () => {
    return cmd(["lsblk", "-J", "-o", "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT"]).then(data => {
        const extractEmpty = (devs) => devs.reduce((acc, d) => {
            if (d.children) return acc.concat(extractEmpty(d.children));
            if (!d.fstype && !d.mountpoint && (d.type === "disk" || d.type === "part")) acc.push(d);
            return acc;
        }, []);
        return extractEmpty(JSON.parse(data).blockdevices || []);
    });
};

// --- CORE APP ENGINE ---
const App = {
    vols: [], hw: {}, mnt: {},

    async fetch() {
        if($("view-master") && !$("view-master").classList.contains("hidden-element") && $("disk-container")) {
            $("disk-container").innerHTML = "<p class='loading-text'>Scanning BTRFS & Hardware...</p>";
        }
        try {
            const [btrfsOut, mntOut, lsblkOut] = await Promise.all([
                cmd(["btrfs", "filesystem", "show"]),
                cmd(["findmnt", "-A", "-J", "-t", "btrfs"]).catch(() => "{}"),
                cmd(["lsblk", "-J", "-o", "PATH,MODEL,VENDOR,TYPE"]).catch(() => "{}")
            ]);

            this.mnt = {};
            const walk = (nodes) => nodes.forEach(n => { if(n.source) this.mnt[n.source] = n.target; if(n.children) walk(n.children); });
            walk(JSON.parse(mntOut).filesystems || []);

            this.hw = {};
            const parseHw = (nodes, parentModel) => nodes.forEach(n => {
                let model = [n.vendor, n.model].filter(Boolean).join(" ").trim() || parentModel;
                if(n.path) this.hw[n.path] = model || "Generic Storage";
                if(n.children) parseHw(n.children, model);
            });
            parseHw(JSON.parse(lsblkOut).blockdevices || []);

            this.parseBtrfs(btrfsOut);
        } catch(err) { 
            if($("disk-container")) $("disk-container").innerHTML = `<p class="text-danger mt-15">Critical Fetch Error: ${err.message}</p>`; 
        }
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
            while ((match = r.exec(block))) devs.push({ id: match[1], size: match[2], path: match[4] });

            const rawSize = formatSize(devs.reduce((sum, d) => sum + parseSize(d.size), 0));
            const hwList = [...new Set(devs.map(d => this.hw[d.path]))].filter(Boolean).join(" & ") || "Unknown Device";

            return { idx, label: (mLabel && (mLabel[1]||mLabel[2]) !== "none") ? (mLabel[1]||mLabel[2]) : "System/Root (No Label)", uuid, mountPoint, devs, rawSize, hwList, raid: "Loading...", usable: "Loading..." };
        });

        this.renderMaster();
        const activeIdx = $("detail-container") ? $("detail-container").getAttribute("data-active-index") : null;
        if(activeIdx !== null && $("view-detail") && !$("view-detail").classList.contains("hidden-element")) this.renderDetail(activeIdx);
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
                v.usable = dfLines.length > 1 ? formatSize(parseInt(dfLines[1].trim().split(/\s+/)[1], 10)) : "Unknown";
            } catch(e) { v.raid = "Error"; v.usable = "Error"; }
            this.updateUI(v);
        }
    },

    updateUI(v) {
        if($(`master-usable-${v.idx}`)) $(`master-usable-${v.idx}`).innerHTML = v.usable;
        if($(`raid-display-${v.idx}`)) { $(`raid-display-${v.idx}`).innerHTML = v.raid; $(`usable-display-${v.idx}`).innerHTML = v.usable; }
    },

    renderMaster() {
        if(!$("disk-container")) return;
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
        if(!$("detail-container")) return;
        const v = this.vols.find(vol => vol.idx == idx);
        if (!v) return;
        $("detail-container").setAttribute("data-active-index", idx);

        const devHtml = v.devs.map(d => `<div class="topo-item"><span><span class="btrfs-code">${d.path}</span> <span class="text-muted">(ID: ${d.id} | Size: ${d.size})</span></span> ${v.mountPoint ? `<button class="btn btn-danger btn-sm btn-action" data-action="remove-dev" data-mount="${v.mountPoint}" data-devpath="${d.path}">Remove</button>` : ''}</div>`).join("");
        
        // PENGEMBALIAN TOMBOL "CHECK SCRUB" KE DALAM UI
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
                    ${v.mountPoint ? `<div class="btrfs-card"><h4 class="section-title">Maintenance</h4><div class="flex-wrap-gap"><button class="btn btn-primary btn-sm btn-action" data-action="scrub" data-mount="${v.mountPoint}">Scrub</button> <button class="btn btn-secondary btn-sm btn-action" data-action="scrub-status" data-mount="${v.mountPoint}">Check Scrub</button> <button class="btn btn-secondary btn-sm btn-action" data-action="balance" data-mount="${v.mountPoint}">Balance (50%)</button> <button class="btn btn-secondary btn-sm btn-action" data-action="defrag" data-mount="${v.mountPoint}">Defrag+ZSTD</button></div><div id="maint-console-${v.mountPoint.replace(/\//g, '-')}" class="status-console hidden-element"></div></div>` : `<div class="warning-box"><p class="text-warning mb-5">Volume Locked</p><button class="btn btn-primary btn-sm btn-action" data-action="mount-vol" data-uuid="${v.uuid}">Mount Volume</button></div>`}
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
        if(!$(`subvol-list-${idx}`)) return;
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
    const tgt = e.target.closest(".btn-action");
    if (!tgt) return;

    const action = tgt.getAttribute("data-action");
    const mnt = tgt.getAttribute("data-mount");
    
    const task = (msg, c, okMsg, ref = false) => { 
        const boxId = `maint-console-${(mnt || "").replace(/\//g, '-')}`;
        const updateBox = (text) => { const b = $(boxId); if(b) { b.classList.remove("hidden-element"); b.innerText = text; } };
        updateBox(msg);
        cmd(c).then(o => { updateBox(`${okMsg}\n${o}`); if(ref) App.fetch(); }).catch(err => updateBox("Error:\n" + err.message)); 
    };

    try {
        switch(action) {
            case 'open-detail': $("view-master").classList.add("hidden-element"); $("view-detail").classList.remove("hidden-element"); App.renderDetail(tgt.getAttribute("data-index")); break;
            case 'mount-vol': customPrompt("Mount Volume", "Enter mount point directory:", `/mnt/btrfs_${tgt.getAttribute("data-uuid").substring(0,8)}`, "Mount", (dir) => { if(dir) cmd(["sh", "-c", `mkdir -p ${dir} && mount UUID=${tgt.getAttribute("data-uuid")} ${dir}`]).then(()=>App.fetch()).catch(e=>customAlert("Error", e.message)); }); break;
            case 'convert-raid': customSelect("Online RAID Conversion", "Select new profile:", [{v:"single",l:"Single"},{v:"raid0",l:"RAID 0"},{v:"raid1",l:"RAID 1"},{v:"raid10",l:"RAID 10"}], "Convert", (p) => { if(p) task(`Converting to ${p}...`, ["btrfs", "balance", "start", "-f", "-dconvert="+p, "-mconvert="+p, mnt], `Conversion to ${p} executed!`); }); break;
            case 'resize-vol': customPrompt("Resize Volume", "Target size (e.g. 'max', '+10G'):", "max", "Resize", (sz) => { if(sz) task(`Resizing to ${sz}...`, ["btrfs", "filesystem", "resize", sz, mnt], "Resized!", true); }); break;
            case 'scrub': customConfirm("Start Scrub", `Start data scrubbing on ${mnt}?`, "Start", () => task("Scrubbing...", ["btrfs", "scrub", "start", mnt], "Started. Click 'Check Scrub' for progress.")); break;
            // PEMANGGILAN FUNGSI CHECK SCRUB
            case 'scrub-status': task("Fetching scrub status...", ["btrfs", "scrub", "status", mnt], "Scrub Status:"); break;
            case 'balance': customConfirm("Start Balance", `Rebalance blocks (50% usage) on ${mnt}?`, "Start", () => task("Balancing...", ["btrfs", "balance", "start", "-dusage=50", mnt], "Done!")); break;
            case 'defrag': customConfirm("Defrag & Compress", `Run recursive ZSTD defragmentation?`, "Start", () => task("Defragging...", ["btrfs", "filesystem", "defragment", "-r", "-czstd", mnt], "Defrag sent to kernel.")); break;
            case 'remove-dev': customConfirm("Remove Device", `Evacuate and remove ${tgt.getAttribute("data-devpath")}?`, "Remove", () => task("Evacuating...", ["btrfs", "device", "remove", tgt.getAttribute("data-devpath"), mnt], "Removed!", true)); break;
            
            case 'add-dev-modal':
                if(!$("add-dev-modal")) return;
                $("add-dev-modal").classList.remove("hidden-element"); $("modal-mount-target").innerText = mnt;
                $("btn-confirm-add-dev").setAttribute("data-mount", mnt); $("btn-confirm-add-dev").disabled = true;
                $("modal-disk-select").innerHTML = `<option value="">Scanning for empty block devices...</option>`;
                getEmptyDevices().then(devs => {
                    if(devs.length === 0) $("modal-disk-select").innerHTML = `<option value="">No safe empty disks found!</option>`;
                    else { $("modal-disk-select").innerHTML = devs.map(d => `<option value="/dev/${d.name}">/dev/${d.name} (${d.size} - Unallocated)</option>`).join(""); $("btn-confirm-add-dev").disabled = false; }
                }).catch(err => $("modal-disk-select").innerHTML = `<option value="">Error: ${err.message}</option>`);
                break;
            
            case 'manage-subvol': 
                if(!$("manage-subvol-modal")) return;
                $("manage-subvol-modal").classList.remove("hidden-element"); $("modal-subvol-path").innerText = "/" + tgt.getAttribute("data-path"); $("modal-subvol-id").innerText = "(ID: " + tgt.getAttribute("data-subid") + ")";
                document.querySelectorAll("#manage-subvol-modal .btn-action").forEach(b => { b.setAttribute("data-mount", mnt); b.setAttribute("data-path", tgt.getAttribute("data-path")); b.setAttribute("data-subid", tgt.getAttribute("data-subid")); b.setAttribute("data-index", tgt.getAttribute("data-index")); });
                break;
            
            case 'subvol-ops':
                if($("manage-subvol-modal")) $("manage-subvol-modal").classList.add("hidden-element");
                const op = tgt.getAttribute("data-op"); const p = tgt.getAttribute("data-path"); const i = tgt.getAttribute("data-index");
                const sName = (dt) => p ? `${p.split("/").pop()}_snap_${dt}` : `root_snap_${dt}`;
                
                if(op === "create") { const nm = $(`new-subvol-${i}`)?.value.trim(); if(!nm) { customAlert("Error", "Name required!"); return;} cmd(["btrfs", "subvolume", "create", mnt === "/" ? `/${nm}` : `${mnt}/${nm}`]).then(()=>{ if($(`new-subvol-${i}`)) $(`new-subvol-${i}`).value = ""; App.fetchSubvols(mnt, i); }).catch(e=>customAlert("Failed", e.message)); }
                else if(op === "del") customConfirm("Delete", `Delete "${p}"?`, "Delete", () => cmd(["btrfs", "subvolume", "delete", mnt === "/" ? `/${p}` : `${mnt}/${p}`]).then(()=>App.fetchSubvols(mnt, i)).catch(e=>customAlert("Failed", e.message)));
                else if(op.startsWith("snap")) customPrompt("Snapshot", "Name:", sName(new Date().toISOString().replace(/[:.]/g,"-").slice(0,19)), "Create", (n) => { if(n) cmd(["btrfs", "subvolume", "snapshot", p ? (mnt==="/"?`/${p}`:`${mnt}/${p}`) : mnt, mnt==="/"?`/${n}`:`${mnt}/${n}`]).then(()=>App.fetchSubvols(mnt, i||tgt.getAttribute("data-index"))).catch(e=>customAlert("Failed", e.message)); });
                else if(op === "restore") customPrompt("Restore/Clone", "Target name:", p.split("_snap_")[0]+"_restored", "Restore", (n) => { if(n) cmd(["btrfs", "subvolume", "snapshot", mnt==="/"?`/${p}`:`${mnt}/${p}`, mnt==="/"?`/${n}`:`${mnt}/${n}`]).then(()=>App.fetchSubvols(mnt, i)).catch(e=>customAlert("Failed", e.message)); });
                else if(op === "quota") customPrompt("Quota", `Set max limit (e.g. 50G):`, "50G", "Apply", (l) => { if(l) cmd(["btrfs", "quota", "enable", mnt]).then(()=>cmd(["btrfs", "qgroup", "limit", l, mnt==="/"?`/${p}`:`${mnt}/${p}`]).then(()=>customAlert("Success", "Quota Applied")).catch(e=>customAlert("Error", e.message))).catch(e=>customAlert("Error", "Failed to enable quota module: " + e.message)); });
                else if(op === "default") customConfirm("Set Default", `Make ID ${tgt.getAttribute("data-subid")} default?`, "Confirm", () => cmd(["btrfs", "subvolume", "set-default", tgt.getAttribute("data-subid"), mnt]).then(()=>customAlert("Success", "Set as default root.")).catch(e=>customAlert("Error", e.message)));
                break;
        }
    } catch(err) { customAlert("Execution Error", err.message); }
});

// --- INIT LISTENERS ---
on("generic-modal-cancel", "click", () => Modal.close());
on("generic-modal-confirm", "click", () => Modal.confirm());
on("btn-back-master", "click", () => { $("view-detail").classList.add("hidden-element"); $("view-master").classList.remove("hidden-element"); $("detail-container").setAttribute("data-active-index", ""); });
on("btn-close-subvol-modal", "click", () => $("manage-subvol-modal").classList.add("hidden-element"));
on("btn-close-add-modal", "click", () => $("add-dev-modal").classList.add("hidden-element"));

on("btn-confirm-add-dev", "click", (e) => {
    const mnt = e.target.getAttribute("data-mount"); const newDev = $("modal-disk-select").value; if(!newDev) return;
    $("add-dev-modal").classList.add("hidden-element");
    
    const boxId = `maint-console-${(mnt || "").replace(/\//g, '-')}`;
    const updateBox = (text) => { const b = $(boxId); if(b) { b.classList.remove("hidden-element"); b.innerText = text; } };
    
    updateBox(`Merging ${newDev}...`);
    cmd(["btrfs", "device", "add", "-f", newDev, mnt])
        .then(o => { updateBox(`Added successfully.\n\n${o}`); App.fetch(); })
        .catch(e => updateBox("Failed: " + e.message));
});

// --- RAID CREATION ---
on("btn-create-raid", "click", () => {
    $("raid-form").classList.remove("hidden-element"); $("format-status").classList.add("hidden-element");
    $("available-disks").innerHTML = "Scanning block devices...";
    getEmptyDevices().then(devs => {
        $("available-disks").innerHTML = devs.map(d => `<label class="disk-label-item"><input type="checkbox" name="tgt-disk" value="/dev/${d.name}"> <span class="btrfs-code">/dev/${d.name}</span> - Capacity: ${d.size}</label>`).join("") || "<span class='text-danger'>No safe empty disks found.</span>";
        $("btn-execute-format").disabled = !devs.length;
    }).catch(err => $("available-disks").innerHTML = "Scan failed: " + err.message);
});
on("btn-cancel-format", "click", () => $("raid-form").classList.add("hidden-element"));
on("btn-refresh", "click", () => App.fetch());
on("btn-execute-format", "click", () => {
    const disks = Array.from(document.querySelectorAll('input[name="tgt-disk"]:checked')).map(cb => cb.value);
    const prof = $("raid-profile").value; const lbl = $("volume-label").value.trim();
    if (!disks.length) return ($("format-status").innerText = "Error: No disks selected!", $("format-status").classList.remove("hidden-element"), $("format-status").style.color = "var(--btn-danger)");
    let c = ["mkfs.btrfs", "-d", prof, "-m", prof, "-f"]; if (lbl) c.push("-L", lbl); c.push(...disks);
    $("format-status").classList.remove("hidden-element"); $("format-status").style.color = "var(--btn-primary)"; $("format-status").innerText = "> Formatting..."; $("btn-execute-format").disabled = true;
    cmd(c).then(() => { $("format-status").style.color = "var(--console-text)"; $("format-status").innerText = "Success!"; App.fetch(); setTimeout(() => { $("raid-form").classList.add("hidden-element"); $("btn-execute-format").disabled = false; }, 3000); }).catch(e => { $("format-status").style.color = "var(--btn-danger)"; $("format-status").innerText = "Failed:\n" + e.message; $("btn-execute-format").disabled = false; });
});

// --- BOOT ---
App.fetch();