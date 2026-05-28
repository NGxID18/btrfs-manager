let mountMap = {};
let parsedVolumesData = []; 

const runCmd = (cmd) => cockpit.spawn(cmd, { superuser: "require" });
const el = (id) => document.getElementById(id);

// --- GLOBAL: FETCH EMPTY DEVICES ---
const getEmptyDevices = () => {
    return runCmd(["lsblk", "-J", "-o", "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT"]).then(data => {
        const extractEmpty = (devs) => devs.reduce((acc, d) => {
            if (d.children) return acc.concat(extractEmpty(d.children));
            if (!d.fstype && !d.mountpoint) acc.push(d);
            return acc;
        }, []);
        return extractEmpty(JSON.parse(data).blockdevices || []);
    });
};

// --- 1. DATA FETCHING & PARSING ---
function fetchBtrfsData() {
    if(!el("view-master").classList.contains("hidden-element")) {
        el("disk-container").innerHTML = "<p style='font-size: 18px; font-weight: bold; animation: fadeInSlideUp 0.5s ease;'>Loading system data...</p>";
    }

    runCmd(["findmnt", "-A", "-J", "-t", "btrfs"])
        .then(mntData => {
            mountMap = {};
            try {
                const parsed = JSON.parse(mntData);
                const walk = (nodes) => nodes.forEach(n => {
                    if (n.source) mountMap[n.source] = n.target;
                    if (n.children) walk(n.children);
                });
                if (parsed.filesystems) walk(parsed.filesystems);
            } catch(e) {}
            return runCmd(["btrfs", "filesystem", "show"]);
        })
        .catch(() => runCmd(["btrfs", "filesystem", "show"])) 
        .then(out => processBtrfsData(out))
        .catch(err => el("disk-container").innerHTML = `<p style="color:var(--btn-danger); font-size:16px;">Load failed: ${err.message}</p>`);
}

function processBtrfsData(rawData) {
    const blocks = rawData.split(/Label:\s+/).filter(b => b.trim() !== "");
    
    parsedVolumesData = blocks.map((block, index) => {
        const labelMatch = block.match(/^(.*?)?\s+uuid:\s+([a-z0-9\-]+)/);
        const label = (labelMatch && labelMatch[1] && labelMatch[1].trim() !== "none") ? labelMatch[1].replace(/'/g, "").trim() : "System/Root (No Label)";
        const uuid = labelMatch ? labelMatch[2] : "-";
        
        const pathMatch = block.match(/path\s+(\/dev\/\S+)/);
        const firstPath = pathMatch ? pathMatch[1] : "-";
        
        const sizeMatch = block.match(/size\s+([0-9.]+\s?[GMKT]iB?)/i);
        const totalSize = sizeMatch ? sizeMatch[1] : "Unknown";

        const mountPoint = mountMap[firstPath] || mountMap[`UUID=${uuid}`] || mountMap[firstPath + "1"] || (label === "System/Root (No Label)" ? "/" : "");

        let devices = [];
        const devRegex = /devid\s+(\d+)\s+size\s+([0-9.]+\s?[a-zA-Z]+)\s+used\s+([0-9.]+\s?[a-zA-Z]+)\s+path\s+(\/dev\/\S+)/g;
        let match;
        while ((match = devRegex.exec(block))) {
            devices.push({ id: match[1], size: match[2], path: match[4] });
        }

        return { index, label, uuid, totalSize, mountPoint, devices };
    });

    renderMasterView();
    
    const activeIdx = el("detail-container").getAttribute("data-active-index");
    if(!el("view-detail").classList.contains("hidden-element") && activeIdx !== null) {
        renderDetailView(activeIdx);
    }
}

// --- 2. RENDER MASTER VIEW ---
function renderMasterView() {
    const container = el("disk-container");
    if (!parsedVolumesData.length) {
        container.innerHTML = "<p style='font-size:16px;'>No BTRFS filesystems found.</p>";
        return;
    }

    container.innerHTML = parsedVolumesData.map((vol, i) => `
        <div class="btrfs-card hoverable animated-view" style="animation-delay: ${i * 0.1}s;">
            <h3>💽 ${vol.label}</h3>
            <p style="margin-bottom: 5px;"><b>UUID:</b> <span class="btrfs-code">${vol.uuid}</span></p>
            <p style="margin-bottom: 5px;"><b>Capacity:</b> ${vol.totalSize}</p>
            <p><b>Mount:</b> ${vol.mountPoint ? `<span style="color:#38a169; font-weight:bold;">${vol.mountPoint}</span>` : `<span style="color:#d69e2e; font-weight:bold;">Not Mounted</span>`}</p>
            
            <button class="btn btn-secondary btn-block btn-action" data-action="open-detail" data-index="${vol.index}" style="margin-top:auto;">⚙️ Manage Volume</button>
        </div>
    `).join('');
}

// --- 3. RENDER DETAIL VIEW (ASYMMETRICAL LAYOUT) ---
function renderDetailView(idx) {
    const vol = parsedVolumesData.find(v => v.index == idx);
    if (!vol) return;
    
    el("detail-container").setAttribute("data-active-index", idx);

    let devHtml = vol.devices.map(d => `
        <div class="topo-item"><span><span class="btrfs-code">${d.path}</span> <small style="color:var(--text-muted); font-size:13px; margin-left:5px;">(ID: ${d.id} | Size: ${d.size})</small></span>
        ${vol.mountPoint ? `<button class="btn-danger-sm btn-action" data-action="remove-dev" data-mount="${vol.mountPoint}" data-devpath="${d.path}">Remove Disk</button>` : ''}
        </div>
    `).join("");
    
    devHtml += vol.mountPoint ? `<div class="topo-add-btn"><button class="btn btn-secondary btn-sm btn-action" data-action="add-dev-modal" data-mount="${vol.mountPoint}">➕ Add Disk to Volume</button></div>` 
                          : `<p style="color:orange; font-size:14px; margin-top:5px;">Mount volume to manage devices.</p>`;

    const html = `
        <h2 class="animated-view" style="margin-top:0; margin-bottom:25px;">💽 ${vol.label}</h2>
        
        <div class="detail-layout-grid">
            
            <div class="detail-left-col animated-view" style="animation-delay: 0.1s;">
                
                <div class="btrfs-card" style="margin-bottom: 0;">
                    <h4 class="topo-title">ℹ️ Information & Topology</h4>
                    <p style="margin-bottom: 8px;"><b>UUID:</b> <span class="btrfs-code">${vol.uuid}</span></p>
                    <p style="margin-bottom: 8px;"><b>Capacity:</b> ${vol.totalSize}</p>
                    <p style="margin-bottom: 25px;"><b>Mount Status:</b> ${vol.mountPoint ? `<span style="color:#38a169; font-weight:bold;">Mounted at ${vol.mountPoint}</span>` : `<span style="color:#d69e2e; font-weight:bold;">Not Mounted (Locked)</span>`}</p>
                    
                    <p class="topo-title" style="margin-top: 25px;">Physical Device Topology</p>
                    <div>${devHtml}</div>
                </div>

                ${vol.mountPoint ? `
                <div class="btrfs-card" style="margin-bottom: 0;">
                    <div class="maintenance-section" style="margin:0; padding:0; border:none; background:transparent;">
                        <h4>🛠 Maintenance & Optimization</h4>
                        <div class="btn-group">
                            <button class="btn btn-primary btn-sm btn-action" data-action="scrub-start" data-mount="${vol.mountPoint}">Start Scrub</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="scrub-status" data-mount="${vol.mountPoint}">Scrub Status</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="balance" data-mount="${vol.mountPoint}">Balance (50%)</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="defrag" data-mount="${vol.mountPoint}">Defragment</button>
                        </div>
                        <div id="maint-console-${vol.mountPoint.replace(/\//g, '-')}" class="status-console hidden-element"></div>
                    </div>
                </div>
                ` : ''}

            </div>

            <div class="detail-right-col animated-view" style="animation-delay: 0.2s;">
                
                <div class="btrfs-card" style="margin-bottom: 0; height: 100%; display: flex; flex-direction: column;">
                    <h4 class="topo-title">📂 Subvolumes & Snapshots</h4>
                    ${vol.mountPoint ? `
                    <div style="margin-bottom: 15px; display:flex; gap:10px; flex-wrap: wrap;">
                        <input type="text" id="new-subvol-${vol.index}" placeholder="New subvolume name..." class="form-input" style="flex-grow:1;">
                        <button class="btn btn-primary btn-sm btn-action" data-action="add-subvol" data-mount="${vol.mountPoint}" data-index="${vol.index}">➕ Add</button>
                        <button class="btn btn-secondary btn-sm btn-action" data-action="snap-root" data-mount="${vol.mountPoint}">📸 Snapshot Root</button>
                    </div>
                    <div id="subvol-list-${vol.index}" class="subvol-list-full"><p style="padding:15px; animation: pulseGlow 2s infinite;">Loading subvolumes...</p></div>
                    ` : '<p style="color:#d69e2e; font-weight:bold;">Mount this volume to access Subvolumes.</p>'}
                </div>

            </div>

        </div>
    `;

    el("detail-container").innerHTML = html;
    if (vol.mountPoint) loadSubvols(vol.mountPoint, vol.index);
}

// --- 4. EVENT DISPATCHER (ROUTING & ACTIONS) ---
document.body.addEventListener("click", e => {
    const tgt = e.target;
    if (!tgt.classList.contains("btn-action")) return;

    const action = tgt.getAttribute("data-action");
    const mount = tgt.getAttribute("data-mount");
    const consoleId = `maint-console-${(mount || "").replace(/\//g, '-')}`;
    const cBox = el(consoleId) || { innerText: '', classList: { remove:()=>{} } };

    const runTask = (msg, cmd, successMsg = null, refresh = false) => {
        cBox.classList.remove("hidden-element");
        cBox.innerText = msg;
        runCmd(cmd).then(out => {
            cBox.innerText = successMsg ? `${successMsg}\n${out}` : out;
            if (refresh) fetchBtrfsData();
        }).catch(err => cBox.innerText = "Error: " + err.message);
    };

    switch(action) {
        // ROUTING
        case 'open-detail':
            el("view-master").classList.add("hidden-element");
            el("view-detail").classList.remove("hidden-element");
            renderDetailView(tgt.getAttribute("data-index"));
            break;

        // SUBVOLUMES
        case 'add-subvol':
            const idx = tgt.getAttribute("data-index");
            const name = el(`new-subvol-${idx}`).value.trim();
            if (!name) return alert("Subvolume name cannot be empty!");
            runCmd(["btrfs", "subvolume", "create", mount === "/" ? `/${name}` : `${mount}/${name}`])
                .then(() => { el(`new-subvol-${idx}`).value = ""; loadSubvols(mount, idx); })
                .catch(err => alert("Failed:\n" + err.message));
            break;
        case 'del-subvol':
            const path = tgt.getAttribute("data-path");
            if(confirm(`Delete subvolume "${path}"?`)) {
                runCmd(["btrfs", "subvolume", "delete", mount === "/" ? `/${path}` : `${mount}/${path}`])
                    .then(() => loadSubvols(mount, tgt.closest('.subvol-list-full').id.split('-').pop()))
                    .catch(err => alert("Failed:\n" + err.message));
            }
            break;
        case 'snap-root':
            takeSnapshot(mount, "");
            break;
        case 'snap-subvol':
            takeSnapshot(mount, tgt.getAttribute("data-path"));
            break;
        case 'restore-subvol':
            restoreSnapshot(mount, tgt.getAttribute("data-path"), tgt.closest('.subvol-list-full').id.split('-').pop());
            break;

        // MAINTENANCE
        case 'scrub-start':
            if(confirm(`Start Scrub on ${mount}?`)) runTask("Starting scrub...", ["btrfs", "scrub", "start", mount], "(Click 'Scrub Status' to monitor progress)");
            break;
        case 'scrub-status':
            runTask("Fetching status...", ["btrfs", "scrub", "status", mount]);
            break;
        case 'balance':
            if(confirm(`Start Balance on ${mount}?`)) runTask("Balancing (this may take time)...", ["btrfs", "balance", "start", "-dusage=50", mount], "Success!");
            break;
        case 'defrag':
            if(confirm(`Start Defragmentation on ${mount}?`)) runTask("Defragmenting...", ["btrfs", "filesystem", "defragment", "-r", mount], "Defrag command sent.");
            break;
        case 'remove-dev':
            const dev = tgt.getAttribute("data-devpath");
            if(confirm(`WARNING: Evacuating and removing ${dev} from ${mount}.\nProceed?`)) runTask(`Evacuating ${dev}...`, ["btrfs", "device", "remove", dev, mount], `Successfully removed ${dev}.`, true);
            break;
        
        // MODAL TRIGGER
        case 'add-dev-modal':
            el("add-dev-modal").classList.remove("hidden-element");
            el("modal-mount-target").innerText = mount;
            el("btn-confirm-add-dev").setAttribute("data-mount", mount);
            el("btn-confirm-add-dev").disabled = true;
            el("modal-disk-select").innerHTML = `<option value="">Scanning for empty devices...</option>`;
            
            getEmptyDevices().then(devs => {
                if(devs.length === 0) {
                    el("modal-disk-select").innerHTML = `<option value="">No unallocated disks found!</option>`;
                } else {
                    el("modal-disk-select").innerHTML = devs.map(d => `<option value="/dev/${d.name}">/dev/${d.name} (${d.size} - Unallocated)</option>`).join("");
                    el("btn-confirm-add-dev").disabled = false;
                }
            }).catch(err => el("modal-disk-select").innerHTML = `<option value="">Error: ${err.message}</option>`);
            break;
    }
});

// Nativigasi Kembali ke Master
el("btn-back-master").addEventListener("click", () => {
    el("view-detail").classList.add("hidden-element");
    el("view-master").classList.remove("hidden-element");
    el("detail-container").setAttribute("data-active-index", "");
    
    // Retrigger animasi di master view
    document.querySelectorAll('#disk-container .btrfs-card').forEach(card => {
        card.classList.remove('animated-view');
        void card.offsetWidth; // Trigger reflow
        card.classList.add('animated-view');
    });
});

// --- MODAL ACTION LISTENERS ---
el("btn-close-modal").addEventListener("click", () => el("add-dev-modal").classList.add("hidden-element"));
el("btn-confirm-add-dev").addEventListener("click", (e) => {
    const mount = e.target.getAttribute("data-mount");
    const newDev = el("modal-disk-select").value;
    if(!newDev) return;
    
    el("add-dev-modal").classList.add("hidden-element");
    
    const consoleId = `maint-console-${(mount || "").replace(/\//g, '-')}`;
    const cBox = el(consoleId) || { innerText: '', classList: { remove:()=>{} } };
    cBox.classList.remove("hidden-element");
    cBox.innerText = `Adding ${newDev} to ${mount}...`;

    runCmd(["btrfs", "device", "add", "-f", newDev, mount])
        .then(out => {
            cBox.innerText = `Success adding ${newDev}!\n\nRecommend running Balance next.\n\n${out}`;
            fetchBtrfsData();
        })
        .catch(err => cBox.innerText = "Error adding device: " + err.message);
});

// --- 5. SUBVOLUME & SNAPSHOT LOGIC ---
function loadSubvols(mount, idx) {
    const list = el(`subvol-list-${idx}`);
    if(!list) return;
    list.innerHTML = "<p style='padding:15px; font-style: italic;'>Scanning subvolumes...</p>";

    runCmd(["btrfs", "subvolume", "list", mount])
        .then(out => {
            const html = out.trim().split("\n").filter(l => l.trim()).map((line, i) => {
                const m = line.match(/path\s+(.+)$/);
                if (!m) return "";
                const p = m[1];
                return `<div class="subvol-item animated-view" style="animation-delay: ${i * 0.05}s;">
                            <span>📁 <b class="btrfs-code" style="font-size:14px;">${p}</b></span>
                            <div class="subvol-actions">
                                <button class="btn-restore btn-action" data-action="restore-subvol" data-mount="${mount}" data-path="${p}">🔄 Restore</button>
                                <button class="btn-snapshot btn-action" data-action="snap-subvol" data-mount="${mount}" data-path="${p}">📸 Snapshot</button>
                                <button class="btn-danger-sm btn-action" data-action="del-subvol" data-mount="${mount}" data-path="${p}">Delete</button>
                            </div>
                        </div>`;
            }).join("");
            list.innerHTML = html || "<p style='padding:15px; color:var(--text-muted);'>No custom subvolumes.</p>";
        }).catch(err => list.innerHTML = `<p style='padding:15px; color:var(--btn-danger);'>Failed: ${err.message}</p>`);
}

function takeSnapshot(mount, subvol) {
    const dt = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defName = subvol ? `${subvol.split("/").pop()}_snap_${dt}` : `root_snap_${dt}`;
    const name = prompt(`Enter new snapshot name:\n(Source: ${subvol || "Root Volume"})`, defName);
    if (!name) return;

    const src = subvol ? (mount === "/" ? `/${subvol}` : `${mount}/${subvol}`) : mount;
    const dst = mount === "/" ? `/${name}` : `${mount}/${name}`;
    
    runCmd(["btrfs", "subvolume", "snapshot", src, dst])
        .then(() => fetchBtrfsData()) 
        .catch(err => alert("Snapshot failed:\n" + err.message));
}

function restoreSnapshot(mount, snap, idx) {
    let defTgt = snap.split("_snap_")[0];
    if (defTgt === snap) defTgt += "_restored"; 
    
    const tgt = prompt(`🔄 RESTORE / CLONE\n\nSource: ${snap}\nTarget subvolume name:`, defTgt);
    if (!tgt) return;

    const src = mount === "/" ? `/${snap}` : `${mount}/${snap}`;
    const dst = mount === "/" ? `/${tgt}` : `${mount}/${tgt}`;

    runCmd(["btrfs", "subvolume", "snapshot", src, dst])
        .then(() => { alert("✅ Restore successful!"); loadSubvols(mount, idx); })
        .catch(err => alert("❌ Restore failed:\n" + err.message));
}

// --- 6. RAID CREATION LOGIC ---
const formRaid = el("raid-form");
const statusTxt = el("format-status");
const btnExec = el("btn-execute-format");

el("btn-create-raid").addEventListener("click", () => {
    formRaid.classList.remove("hidden-element");
    statusTxt.innerText = "";
    statusTxt.classList.add("hidden-element");
    
    const box = el("available-disks");
    box.innerHTML = "Deep scanning block devices...";
    
    getEmptyDevices().then(safeDevs => {
        const html = safeDevs.map(d => `<label class="disk-label-item"><input type="checkbox" name="tgt-disk" value="/dev/${d.name}"> <span class="btrfs-code">/dev/${d.name}</span> - ${d.size} (Unallocated)</label>`).join("");
        box.innerHTML = html || "<span style='color:var(--btn-danger); font-weight:bold;'>No safe empty disks found.</span>";
        btnExec.disabled = !html;
    }).catch(err => box.innerHTML = "Scan failed: " + err.message);
});

el("btn-cancel-format").addEventListener("click", () => formRaid.classList.add("hidden-element"));
el("btn-refresh").addEventListener("click", () => {
    el("btn-refresh").style.transform = "rotate(180deg)"; // Animasi putar
    setTimeout(() => el("btn-refresh").style.transform = "none", 300);
    fetchBtrfsData();
});

btnExec.addEventListener("click", () => {
    const disks = Array.from(document.querySelectorAll('input[name="tgt-disk"]:checked')).map(cb => cb.value);
    const prof = el("raid-profile").value;
    const lbl = el("volume-label").value.trim();

    if (!disks.length) {
        statusTxt.innerText = "Error: No disks selected!";
        statusTxt.classList.remove("hidden-element");
        statusTxt.style.color = "var(--btn-danger)";
        return;
    }
    
    let cmd = ["mkfs.btrfs", "-d", prof, "-m", prof, "-f"];
    if (lbl) cmd.push("-L", lbl);
    cmd.push(...disks);

    statusTxt.classList.remove("hidden-element");
    statusTxt.style.color = "var(--btn-primary)";
    statusTxt.innerText = "> " + cmd.join(" ") + "\nFormatting...";
    btnExec.disabled = true;

    runCmd(cmd).then(() => {
        statusTxt.style.color = "var(--console-text)";
        statusTxt.innerText = "Volume created successfully!";
        fetchBtrfsData();
        setTimeout(() => { formRaid.classList.add("hidden-element"); btnExec.disabled = false; }, 3000);
    }).catch(err => {
        statusTxt.style.color = "var(--btn-danger)";
        statusTxt.innerText = "Format failed:\n" + err.message;
        btnExec.disabled = false;
    });
});

// Initialization
fetchBtrfsData();