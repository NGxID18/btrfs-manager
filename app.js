let mountMap = {};
let parsedVolumesData = []; 

const runCmd = (cmd) => cockpit.spawn(cmd, { superuser: "require" });
const el = (id) => document.getElementById(id);

// --- CUSTOM NATIVE MODAL LOGIC ---
let activeModalCallback = null;

function showCustomModal(title, message, isPrompt, defaultInput, confirmBtnText, callback) {
    el("generic-modal-title").innerText = title;
    el("generic-modal-message").innerText = message;
    el("generic-modal-confirm").innerText = confirmBtnText || "OK";

    if (isPrompt) {
        el("generic-modal-input-container").classList.remove("hidden-element");
        el("generic-modal-input").value = defaultInput || "";
        setTimeout(() => el("generic-modal-input").focus(), 100);
    } else {
        el("generic-modal-input-container").classList.add("hidden-element");
    }

    activeModalCallback = callback;
    el("generic-modal").classList.remove("hidden-element");
}

el("generic-modal-cancel").addEventListener("click", () => {
    el("generic-modal").classList.add("hidden-element");
    activeModalCallback = null;
});

el("generic-modal-confirm").addEventListener("click", () => {
    el("generic-modal").classList.add("hidden-element");
    const val = el("generic-modal-input").value;
    if (activeModalCallback) activeModalCallback(val);
});

// Modal Helpers
function customAlert(title, message) { showCustomModal(title, message, false, null, "OK", () => {}); }
function customConfirm(title, message, confirmBtnText, onConfirm) { showCustomModal(title, message, false, null, confirmBtnText, onConfirm); }
function customPrompt(title, message, defaultVal, confirmBtnText, onConfirm) { showCustomModal(title, message, true, defaultVal, confirmBtnText, onConfirm); }

// --- DEVICE FETCHING ---
const getEmptyDevices = () => {
    return runCmd(["lsblk", "-J", "-o", "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT"]).then(data => {
        const extractEmpty = (devs) => devs.reduce((acc, d) => {
            if (d.children) return acc.concat(extractEmpty(d.children));
            if (!d.fstype && !d.mountpoint && (d.type === "disk" || d.type === "part")) acc.push(d);
            return acc;
        }, []);
        return extractEmpty(JSON.parse(data).blockdevices || []);
    });
};

// --- 1. DATA FETCHING ---
function fetchBtrfsData() {
    if(!el("view-master").classList.contains("hidden-element")) {
        el("disk-container").innerHTML = "<p style='font-size: 18px; font-weight: bold; animation: fadeInSlideUp 0.5s ease;'>Scanning BTRFS storage system...</p>";
    }

    Promise.all([
        runCmd(["findmnt", "-A", "-J", "-t", "btrfs"]).catch(() => "{}"), 
        runCmd(["btrfs", "filesystem", "show"])
    ])
    .then(([mntData, btrfsData]) => {
        mountMap = {};
        try {
            const parsed = JSON.parse(mntData);
            const walk = (nodes) => nodes.forEach(n => {
                if (n.source) mountMap[n.source] = n.target;
                if (n.children) walk(n.children);
            });
            if (parsed.filesystems) walk(parsed.filesystems);
        } catch(e) {}
        processBtrfsData(btrfsData);
    })
    .catch(err => el("disk-container").innerHTML = `<p style="color:var(--btn-danger); font-size:16px;">Failed to load BTRFS: ${err.message}</p>`);
}

function processBtrfsData(rawData) {
    const blocks = rawData.split(/Label:\s+/i).filter(b => b.trim() !== "");
    
    parsedVolumesData = blocks.map((block, index) => {
        const labelMatch = block.match(/^(?:'([^']*)'|(\S+))?\s+uuid:\s+([a-f0-9\-]+)/i);
        let label = "System/Root (No Label)";
        if (labelMatch) {
            if (labelMatch[1]) label = labelMatch[1].trim();
            else if (labelMatch[2] && labelMatch[2].toLowerCase() !== "none") label = labelMatch[2].trim();
        }
        const uuid = labelMatch ? labelMatch[3] : "Unknown";
        const pathMatch = block.match(/path\s+(\/dev\/\S+)/i);
        const firstPath = pathMatch ? pathMatch[1] : "";
        const sizeMatch = block.match(/size\s+([0-9.]+\s?[GMKT]iB?)/i);
        const totalSize = sizeMatch ? sizeMatch[1] : "Unknown";

        const mountPoint = mountMap[firstPath] || mountMap[`UUID=${uuid}`] || mountMap[firstPath + "1"] || mountMap[firstPath + "2"] || (label === "System/Root (No Label)" ? "/" : "");

        let devices = [];
        const devRegex = /devid\s+(\d+)\s+size\s+([0-9.]+\s?[a-zA-Z]+)\s+used\s+([0-9.]+\s?[a-zA-Z]+)\s+path\s+(\/dev\/\S+)/gi;
        let match;
        while ((match = devRegex.exec(block))) {
            devices.push({ id: match[1], size: match[2], path: match[4] });
        }

        return { index, label, uuid, totalSize, mountPoint, devices };
    });

    renderMasterView();
    const activeIdx = el("detail-container").getAttribute("data-active-index");
    if(!el("view-detail").classList.contains("hidden-element") && activeIdx !== null) renderDetailView(activeIdx);
}

// --- 2. RENDER MASTER VIEW ---
function renderMasterView() {
    const container = el("disk-container");
    if (!parsedVolumesData.length) return container.innerHTML = "<p style='font-size:16px;'>No BTRFS filesystems detected on the system.</p>";

    container.innerHTML = parsedVolumesData.map((vol, i) => `
        <div class="btrfs-card hoverable animated-view" style="animation-delay: ${i * 0.1}s;">
            <h3>${vol.label}</h3>
            <p style="margin-bottom: 5px;"><b>UUID:</b> <span class="btrfs-code">${vol.uuid}</span></p>
            <p style="margin-bottom: 5px;"><b>Capacity:</b> ${vol.totalSize}</p>
            <p><b>Mount Status:</b> ${vol.mountPoint ? 
                `<span style="color:#38a169; font-weight:bold;">Mounted at ${vol.mountPoint}</span>` : 
                `<span style="color:#d69e2e; font-weight:bold; margin-right:10px;">Not Mounted</span> <button class="btn-primary btn-action" style="padding: 2px 8px; font-size: 12px; border:none; border-radius:3px; cursor:pointer;" data-action="mount-vol" data-uuid="${vol.uuid}">Mount</button>`}</p>
            <button class="btn btn-secondary btn-block btn-action" data-action="open-detail" data-index="${vol.index}" style="margin-top:auto;">Manage Volume</button>
        </div>
    `).join('');
}

// --- 3. RENDER DETAIL VIEW ---
function renderDetailView(idx) {
    const vol = parsedVolumesData.find(v => v.index == idx);
    if (!vol) return;
    el("detail-container").setAttribute("data-active-index", idx);

    let devHtml = vol.devices.map(d => `
        <div class="topo-item"><span><span class="btrfs-code">${d.path}</span> <small style="color:var(--text-muted); font-size:13px; margin-left:5px;">(ID: ${d.id} | Size: ${d.size})</small></span>
        ${vol.mountPoint ? `<button class="btn-danger-sm btn-action" data-action="remove-dev" data-mount="${vol.mountPoint}" data-devpath="${d.path}">Remove</button>` : ''}
        </div>
    `).join("");
    
    let advancedTopoHtml = '';
    if (vol.mountPoint) {
        advancedTopoHtml = `
            <div style="margin-top: 15px; display:flex; gap:10px; flex-wrap:wrap; border-top: 1px dashed var(--border-dashed); padding-top: 15px;">
                <button class="btn btn-primary btn-sm btn-action" data-action="add-dev-modal" data-mount="${vol.mountPoint}">Add Disk</button>
                <button class="btn btn-secondary btn-sm btn-action" data-action="convert-raid" data-mount="${vol.mountPoint}">Convert RAID Profile</button>
                <button class="btn btn-secondary btn-sm btn-action" data-action="resize-vol" data-mount="${vol.mountPoint}">Resize Volume</button>
            </div>
        `;
    }

    const html = `
        <h2 class="animated-view" style="margin-top:0; margin-bottom:25px;">${vol.label}</h2>
        <div class="detail-layout-grid">
            <div class="detail-left-col animated-view" style="animation-delay: 0.1s;">
                <div class="btrfs-card" style="margin-bottom: 0;">
                    <h4 class="topo-title">System Information & Topology</h4>
                    <p style="margin-bottom: 8px;"><b>UUID:</b> <span class="btrfs-code">${vol.uuid}</span></p>
                    <p style="margin-bottom: 8px;"><b>Total Capacity:</b> ${vol.totalSize}</p>
                    <p style="margin-bottom: 25px;"><b>Mount Status:</b> ${vol.mountPoint ? `<span style="color:#38a169; font-weight:bold;">Mounted at ${vol.mountPoint}</span>` : `<span style="color:#d69e2e; font-weight:bold;">Not Mounted (Locked)</span>`}</p>
                    
                    <p class="topo-title" style="margin-top: 25px;">Physical Device Topology</p>
                    <div>${devHtml}</div>
                    ${advancedTopoHtml}
                </div>

                ${vol.mountPoint ? `
                <div class="btrfs-card" style="margin-bottom: 0;">
                    <div class="maintenance-section" style="margin:0; padding:0; border:none; background:transparent;">
                        <h4 style="border-bottom: 1px solid var(--border-color); padding-bottom: 10px; margin-bottom: 15px;">Advanced Maintenance & Optimization</h4>
                        <div class="btn-group">
                            <button class="btn btn-primary btn-sm btn-action" data-action="scrub-start" data-mount="${vol.mountPoint}">Start Scrub</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="scrub-status" data-mount="${vol.mountPoint}">Check Scrub</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="balance" data-mount="${vol.mountPoint}">Balance (50%)</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="defrag-compress" data-mount="${vol.mountPoint}">Defrag + Compress ZSTD</button>
                        </div>
                        <div id="maint-console-${vol.mountPoint.replace(/\//g, '-')}" class="status-console hidden-element"></div>
                    </div>
                </div>
                ` : `
                <div style="padding: 15px; background: rgba(214, 158, 46, 0.1); border-left: 4px solid #d69e2e; border-radius: 4px;">
                    <p style="margin: 0 0 10px 0; font-weight: bold; color: #d69e2e;">Volume Not Mounted</p>
                    <p style="margin: 0 0 15px 0; font-size: 14px;">This volume must be mounted to access subvolumes and advanced maintenance features.</p>
                    <button class="btn btn-primary btn-sm btn-action" data-action="mount-vol" data-uuid="${vol.uuid}">Mount Volume</button>
                </div>
                `}
            </div>

            <div class="detail-right-col animated-view" style="animation-delay: 0.2s;">
                <div class="btrfs-card" style="margin-bottom: 0; height: 100%; display: flex; flex-direction: column;">
                    <h4 class="topo-title">Subvolume, Quota & Snapshot Management</h4>
                    ${vol.mountPoint ? `
                    <div style="margin-bottom: 15px; display:flex; gap:10px; flex-wrap: wrap;">
                        <input type="text" id="new-subvol-${vol.index}" placeholder="New subvolume name..." class="form-input" style="flex-grow:1;">
                        <button class="btn btn-primary btn-sm btn-action" data-action="add-subvol" data-mount="${vol.mountPoint}" data-index="${vol.index}">Add</button>
                        <button class="btn btn-secondary btn-sm btn-action" data-action="snap-root" data-mount="${vol.mountPoint}">Snapshot Root</button>
                    </div>
                    <div id="subvol-list-${vol.index}" class="subvol-list-full"><p style="padding:15px; color:var(--text-muted);">Loading subvolumes...</p></div>
                    ` : '<p style="color:#d69e2e; font-weight:bold;">Mount this volume first to access Subvolumes.</p>'}
                </div>
            </div>
        </div>
    `;

    el("detail-container").innerHTML = html;
    if (vol.mountPoint) loadSubvols(vol.mountPoint, vol.index);
}

// --- 4. EVENT DISPATCHER & LOGIC ---
document.body.addEventListener("click", e => {
    const tgt = e.target;
    if (!tgt.classList.contains("btn-action")) return;

    const action = tgt.getAttribute("data-action");
    const mount = tgt.getAttribute("data-mount");
    const consoleId = `maint-console-${(mount || "").replace(/\//g, '-')}`;
    const cBox = el(consoleId) || { innerText: '', classList: { remove:()=>{} } };

    const runTask = (msg, cmd, successMsg = null, refresh = false) => {
        cBox.classList.remove("hidden-element"); cBox.innerText = msg;
        runCmd(cmd).then(out => {
            cBox.innerText = successMsg ? `${successMsg}\n${out}` : out;
            if (refresh) fetchBtrfsData();
        }).catch(err => cBox.innerText = "Execution Error:\n" + err.message);
    };

    switch(action) {
        case 'open-detail':
            el("view-master").classList.add("hidden-element");
            el("view-detail").classList.remove("hidden-element");
            renderDetailView(tgt.getAttribute("data-index"));
            break;

        case 'mount-vol':
            const volUuid = tgt.getAttribute("data-uuid");
            customPrompt(
                "Mount Volume", 
                "Enter the directory location (mount point) to attach this volume.\nExample: /mnt/data or /media/btrfs\n\nIf the directory doesn't exist, the system will create it automatically.", 
                `/mnt/btrfs_${volUuid.substring(0,8)}`, 
                "Mount",
                (targetDir) => {
                    if (targetDir && targetDir.trim() !== "") {
                        runCmd(["sh", "-c", `mkdir -p ${targetDir} && mount UUID=${volUuid} ${targetDir}`])
                            .then(() => fetchBtrfsData())
                            .catch(err => customAlert("Mount Failed", err.message));
                    }
                }
            );
            break;

        case 'convert-raid':
            customPrompt(
                "Online RAID Profile Conversion",
                "Select a new profile (single, raid0, raid1, raid10).\nWARNING: Ensure you have enough disks (e.g., RAID10 requires min 4 disks).\n\nEnter new profile:",
                "raid10",
                "Convert",
                (newProfile) => {
                    if(newProfile && newProfile.trim() !== "") {
                        runTask(`Starting online profile conversion to ${newProfile.toLowerCase()}. This process reorganizes blocks and may take a long time...`, 
                        ["btrfs", "balance", "start", "-dconvert=" + newProfile.toLowerCase(), "-mconvert=" + newProfile.toLowerCase(), mount], 
                        `Conversion to ${newProfile.toLowerCase()} successfully triggered!`);
                    }
                }
            );
            break;
            
        case 'resize-vol':
            customPrompt(
                "Online Volume Resize",
                "Enter target size (e.g., 'max' to fill remaining disk, '+10G' to expand by 10GB, '-5G' to shrink).\n\nEnter size:",
                "max",
                "Resize",
                (size) => {
                    if(size && size.trim() !== "") {
                        runTask(`Executing resize ${size}...`, ["btrfs", "filesystem", "resize", size, mount], `Successfully resized!`, true);
                    }
                }
            );
            break;

        case 'defrag-compress':
            customConfirm(
                "Defragment & Compress",
                `Start recursive defragmentation with Transparent Compression (ZSTD) on ${mount}?\nThis will compress existing data in the background.`,
                "Start Defrag",
                () => runTask("Sending defrag & ZSTD compression command...", ["btrfs", "filesystem", "defragment", "-r", "-czstd", mount], "Command successfully sent to Kernel.")
            );
            break;

        case 'set-quota':
            const qPath = mount === "/" ? `/${tgt.getAttribute("data-path")}` : `${mount}/${tgt.getAttribute("data-path")}`;
            customPrompt(
                "Quota Management (QGROUPS)",
                `Enter the maximum capacity limit for this subvolume (e.g., 50G, 100G, 500M).\n\nQuota limit for ${qPath}:`,
                "50G",
                "Apply Limit",
                (limit) => {
                    if(limit && limit.trim() !== '') {
                        cBox.classList.remove("hidden-element"); cBox.innerText = "Enabling Quota support...";
                        runCmd(["btrfs", "quota", "enable", mount]).then(() => {
                            cBox.innerText = `Setting limit ${limit} on subvolume...`;
                            runCmd(["btrfs", "qgroup", "limit", limit, qPath])
                                .then(() => { cBox.innerText = `Success! Quota ${limit} applied to ${qPath}`; })
                                .catch(err => cBox.innerText = "Failed to set limit:\n" + err.message);
                        }).catch(err => cBox.innerText = "Failed to enable Kernel Quota module:\n" + err.message);
                    }
                }
            );
            break;

        case 'set-default':
            const subId = tgt.getAttribute("data-subid");
            customConfirm(
                "Set Default Mount",
                `Set Subvolume ID ${subId} as Default?\n\nIf enabled, when the disk is mounted, the system will automatically read this subvolume as its Root.`,
                "Set as Default",
                () => {
                    runCmd(["btrfs", "subvolume", "set-default", subId, mount])
                        .then(() => customAlert("Success", `ID ${subId} is now the default mount.`))
                        .catch(err => customAlert("Failed", err.message));
                }
            );
            break;

        case 'add-subvol':
            const idx = tgt.getAttribute("data-index");
            const name = el(`new-subvol-${idx}`).value.trim();
            if (!name) { customAlert("Error", "Subvolume name cannot be empty!"); return; }
            runCmd(["btrfs", "subvolume", "create", mount === "/" ? `/${name}` : `${mount}/${name}`])
                .then(() => { el(`new-subvol-${idx}`).value = ""; loadSubvols(mount, idx); })
                .catch(err => customAlert("Failed", err.message));
            break;
            
        case 'del-subvol':
            const path = tgt.getAttribute("data-path");
            customConfirm(
                "Delete Subvolume",
                `Permanently delete subvolume "${path}"?`,
                "Delete",
                () => {
                    runCmd(["btrfs", "subvolume", "delete", mount === "/" ? `/${path}` : `${mount}/${path}`])
                        .then(() => loadSubvols(mount, tgt.closest('.subvol-list-full').id.split('-').pop()))
                        .catch(err => customAlert("Failed", err.message));
                }
            );
            break;
            
        case 'snap-root': takeSnapshot(mount, ""); break;
        case 'snap-subvol': takeSnapshot(mount, tgt.getAttribute("data-path")); break;
        case 'restore-subvol': restoreSnapshot(mount, tgt.getAttribute("data-path"), tgt.closest('.subvol-list-full').id.split('-').pop()); break;
        
        case 'scrub-start': 
            customConfirm("Start Scrub", `Start Scrub on ${mount}?`, "Start", () => runTask("Starting scrub...", ["btrfs", "scrub", "start", mount], "(Click 'Check Scrub Status' to monitor progress)")); 
            break;
            
        case 'scrub-status': runTask("Fetching status...", ["btrfs", "scrub", "status", mount]); break;
        
        case 'balance': 
            customConfirm("Start Balance", `Start Balance process on ${mount}?`, "Start", () => runTask("Balance process running...", ["btrfs", "balance", "start", "-dusage=50", mount], "Validation successful!")); 
            break;
            
        case 'remove-dev':
            const dev = tgt.getAttribute("data-devpath");
            customConfirm(
                "Remove Device",
                `WARNING: Evacuating and removing ${dev} from ${mount}.\nProceed?`,
                "Remove",
                () => runTask(`Evacuating ${dev}...`, ["btrfs", "device", "remove", dev, mount], `Successfully removed ${dev}.`, true)
            );
            break;
            
        case 'add-dev-modal':
            el("add-dev-modal").classList.remove("hidden-element");
            el("modal-mount-target").innerText = mount;
            el("btn-confirm-add-dev").setAttribute("data-mount", mount);
            el("btn-confirm-add-dev").disabled = true;
            el("modal-disk-select").innerHTML = `<option value="">Scanning for empty block devices...</option>`;
            
            getEmptyDevices().then(devs => {
                if(devs.length === 0) el("modal-disk-select").innerHTML = `<option value="">No safe empty disks found!</option>`;
                else {
                    el("modal-disk-select").innerHTML = devs.map(d => `<option value="/dev/${d.name}">/dev/${d.name} (${d.size} - Unallocated)</option>`).join("");
                    el("btn-confirm-add-dev").disabled = false;
                }
            }).catch(err => el("modal-disk-select").innerHTML = `<option value="">Error: ${err.message}</option>`);
            break;
    }
});

el("btn-back-master").addEventListener("click", () => {
    el("view-detail").classList.add("hidden-element");
    el("view-master").classList.remove("hidden-element");
    el("detail-container").setAttribute("data-active-index", "");
    
    document.querySelectorAll('#disk-container .btrfs-card').forEach(card => {
        card.classList.remove('animated-view');
        void card.offsetWidth; 
        card.classList.add('animated-view');
    });
});

el("btn-close-modal").addEventListener("click", () => el("add-dev-modal").classList.add("hidden-element"));
el("btn-confirm-add-dev").addEventListener("click", (e) => {
    const mount = e.target.getAttribute("data-mount");
    const newDev = el("modal-disk-select").value;
    if(!newDev) return;
    el("add-dev-modal").classList.add("hidden-element");
    
    const consoleId = `maint-console-${(mount || "").replace(/\//g, '-')}`;
    const cBox = el(consoleId) || { innerText: '', classList: { remove:()=>{} } };
    cBox.classList.remove("hidden-element"); cBox.innerText = `Merging ${newDev} into ${mount}...`;

    runCmd(["btrfs", "device", "add", "-f", newDev, mount])
        .then(out => { cBox.innerText = `Disk added successfully.\n\n${out}`; fetchBtrfsData(); })
        .catch(err => cBox.innerText = "Failed to add disk: " + err.message);
});

// --- 5. FETCH SUBVOLUME & SNAPSHOT LOGIC ---
function loadSubvols(mount, idx) {
    const list = el(`subvol-list-${idx}`);
    if(!list) return;
    list.innerHTML = "<p style='padding:15px; font-style: italic; color:var(--text-muted);'>Scanning subvolumes...</p>";

    runCmd(["btrfs", "subvolume", "list", mount])
        .then(out => {
            const html = out.trim().split("\n").filter(l => l.trim()).map((line, i) => {
                const m = line.match(/ID\s+(\d+).*path\s+(.+)$/i);
                if (!m) return "";
                const subId = m[1].trim();
                const p = m[2].trim();
                
                return `<div class="subvol-item animated-view" style="animation-delay: ${i * 0.05}s; align-items: start; flex-direction: column; gap: 10px;">
                            <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
                                <span><b class="btrfs-code" style="font-size:14px; background:none; padding:0;">Path: /${p}</b> <small style="color:var(--text-muted);">(ID: ${subId})</small></span>
                                <div class="subvol-actions">
                                    <button class="btn-restore btn-action" data-action="restore-subvol" data-mount="${mount}" data-path="${p}">Restore / Clone</button>
                                    <button class="btn-snapshot btn-action" data-action="snap-subvol" data-mount="${mount}" data-path="${p}">Snapshot</button>
                                    <button class="btn-danger-sm btn-action" data-action="del-subvol" data-mount="${mount}" data-path="${p}">Delete</button>
                                </div>
                            </div>
                            <div style="display: flex; gap: 5px;">
                                <button class="btn-secondary btn-sm btn-action" data-action="set-quota" data-mount="${mount}" data-path="${p}" style="font-size:11px; padding:2px 6px;">Set Quota Limit</button>
                                <button class="btn-secondary btn-sm btn-action" data-action="set-default" data-mount="${mount}" data-subid="${subId}" style="font-size:11px; padding:2px 6px;">Set as Default Mount</button>
                            </div>
                        </div>`;
            }).join("");
            list.innerHTML = html || "<p style='padding:15px; color:var(--text-muted);'>No custom subvolumes created yet.</p>";
        }).catch(err => list.innerHTML = `<p style='padding:15px; color:var(--btn-danger);'>Load failed: ${err.message}</p>`);
}

function takeSnapshot(mount, subvol) {
    const dt = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defName = subvol ? `${subvol.split("/").pop()}_snap_${dt}` : `root_snap_${dt}`;
    customPrompt(
        "Create Snapshot",
        `Enter new snapshot name:\n(Source: ${subvol || "Root Volume"})`,
        defName,
        "Create",
        (name) => {
            if(name && name.trim() !== '') {
                const src = subvol ? (mount === "/" ? `/${subvol}` : `${mount}/${subvol}`) : mount;
                const dst = mount === "/" ? `/${name}` : `${mount}/${name}`;
                runCmd(["btrfs", "subvolume", "snapshot", src, dst]).then(() => fetchBtrfsData()).catch(err => customAlert("Snapshot Failed", err.message));
            }
        }
    );
}

function restoreSnapshot(mount, snap, idx) {
    let defTgt = snap.split("_snap_")[0];
    if (defTgt === snap) defTgt += "_restored"; 
    
    customPrompt(
        "Restore / Clone",
        `Enter target subvolume name:`,
        defTgt,
        "Restore",
        (tgt) => {
            if(tgt && tgt.trim() !== '') {
                const src = mount === "/" ? `/${snap}` : `${mount}/${snap}`;
                const dst = mount === "/" ? `/${tgt}` : `${mount}/${tgt}`;
                runCmd(["btrfs", "subvolume", "snapshot", src, dst])
                    .then(() => { customAlert("Success", "Restore successful!"); loadSubvols(mount, idx); })
                    .catch(err => customAlert("Restore Failed", err.message));
            }
        }
    );
}

// --- 6. RAID CREATION & REFRESH ---
const formRaid = el("raid-form");
const statusTxt = el("format-status");
const btnExec = el("btn-execute-format");

el("btn-create-raid").addEventListener("click", () => {
    formRaid.classList.remove("hidden-element"); statusTxt.classList.add("hidden-element");
    el("available-disks").innerHTML = "Deep scanning block devices...";
    getEmptyDevices().then(safeDevs => {
        const html = safeDevs.map(d => `<label class="disk-label-item"><input type="checkbox" name="tgt-disk" value="/dev/${d.name}"> <span class="btrfs-code">/dev/${d.name}</span> - Capacity: ${d.size}</label>`).join("");
        el("available-disks").innerHTML = html || "<span style='color:var(--btn-danger); font-weight:bold;'>No safe empty disks found.</span>";
        btnExec.disabled = !html;
    }).catch(err => el("available-disks").innerHTML = "Scan failed: " + err.message);
});

el("btn-cancel-format").addEventListener("click", () => formRaid.classList.add("hidden-element"));

el("btn-refresh").addEventListener("click", () => { 
    fetchBtrfsData(); 
});

btnExec.addEventListener("click", () => {
    const disks = Array.from(document.querySelectorAll('input[name="tgt-disk"]:checked')).map(cb => cb.value);
    const prof = el("raid-profile").value;
    const lbl = el("volume-label").value.trim();

    if (!disks.length) return (statusTxt.innerText = "Error: No disks selected!", statusTxt.classList.remove("hidden-element"), statusTxt.style.color = "var(--btn-danger)");
    
    let cmd = ["mkfs.btrfs", "-d", prof, "-m", prof, "-f"];
    if (lbl) cmd.push("-L", lbl);
    cmd.push(...disks);

    statusTxt.classList.remove("hidden-element"); statusTxt.style.color = "var(--btn-primary)"; statusTxt.innerText = "> " + cmd.join(" ") + "\nFormatting..."; btnExec.disabled = true;

    runCmd(cmd).then(() => {
        statusTxt.style.color = "var(--console-text)"; statusTxt.innerText = "Volume created successfully!"; fetchBtrfsData();
        setTimeout(() => { formRaid.classList.add("hidden-element"); btnExec.disabled = false; }, 3000);
    }).catch(err => { statusTxt.style.color = "var(--btn-danger)"; statusTxt.innerText = "Failed:\n" + err.message; btnExec.disabled = false; });
});

fetchBtrfsData();