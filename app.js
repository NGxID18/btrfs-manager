let mountMap = {};
let parsedVolumesData = []; 

const runCmd = (cmd) => cockpit.spawn(cmd, { superuser: "require" });
const el = (id) => document.getElementById(id);

// --- CUSTOM NATIVE MODAL LOGIC ---
let activeModalCallback = null;

function showCustomModal(title, message, isPrompt, inputType = "text", defaultInputOrOptions, confirmBtnText, callback) {
    el("generic-modal-title").innerText = title;
    el("generic-modal-message").innerText = message;
    el("generic-modal-confirm").innerText = confirmBtnText || "OK";

    if (isPrompt) {
        el("generic-modal-input-container").classList.remove("hidden-element");
        
        if (inputType === "select") {
            el("generic-modal-input").classList.add("hidden-element");
            const selectEl = el("generic-modal-select");
            selectEl.classList.remove("hidden-element");
            selectEl.innerHTML = defaultInputOrOptions.map(opt => `<option value="${opt.value}">${opt.label}</option>`).join("");
        } else {
            el("generic-modal-select").classList.add("hidden-element");
            el("generic-modal-input").classList.remove("hidden-element");
            el("generic-modal-input").value = defaultInputOrOptions || "";
            setTimeout(() => el("generic-modal-input").focus(), 100);
        }
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
    const isSelect = !el("generic-modal-select").classList.contains("hidden-element");
    const val = isSelect ? el("generic-modal-select").value : el("generic-modal-input").value;
    if (activeModalCallback) activeModalCallback(val);
});

function customAlert(title, message) { showCustomModal(title, message, false, "text", null, "OK", () => {}); }
function customConfirm(title, message, confirmBtnText, onConfirm) { showCustomModal(title, message, false, "text", null, confirmBtnText, onConfirm); }
function customPrompt(title, message, defaultVal, confirmBtnText, onConfirm) { showCustomModal(title, message, true, "text", defaultVal, confirmBtnText, onConfirm); }
function customSelect(title, message, options, confirmBtnText, onConfirm) { showCustomModal(title, message, true, "select", options, confirmBtnText, onConfirm); }

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
        el("disk-container").innerHTML = "<p class='loading-text'>Scanning BTRFS storage system...</p>";
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
    .catch(err => el("disk-container").innerHTML = `<p class="text-danger mt-15">Failed to load BTRFS: ${err.message}</p>`);
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

        return { index, label, uuid, totalSize, mountPoint, devices, raidProfile: "Loading..." };
    });

    renderMasterView();
    const activeIdx = el("detail-container").getAttribute("data-active-index");
    if(!el("view-detail").classList.contains("hidden-element") && activeIdx !== null) renderDetailView(activeIdx);

    parsedVolumesData.forEach((vol) => {
        if(vol.mountPoint) {
            runCmd(["btrfs", "filesystem", "df", vol.mountPoint])
                .then(dfOut => {
                    const dataMatch = dfOut.match(/Data,\s*(.*?):/i);
                    const metaMatch = dfOut.match(/Metadata,\s*(.*?):/i);
                    
                    let profileStr = "";
                    if(dataMatch) profileStr = `<span class="btrfs-code">Data: ${dataMatch[1].toUpperCase()}</span>`;
                    if(metaMatch && dataMatch && metaMatch[1] !== dataMatch[1]) {
                        profileStr += ` <span class="btrfs-code" style="background:#e2e8f0; color:#4a5568;">Meta: ${metaMatch[1].toUpperCase()}</span>`;
                    }
                    
                    vol.raidProfile = profileStr || "Single / Unknown";
                    
                    const currentDetailIdx = el("detail-container").getAttribute("data-active-index");
                    if(!el("view-detail").classList.contains("hidden-element") && currentDetailIdx == vol.index) {
                        const raidEl = el(`raid-display-${vol.index}`);
                        if(raidEl) raidEl.innerHTML = vol.raidProfile;
                    }
                })
                .catch(() => { vol.raidProfile = "Unable to read profile"; });
        } else {
            vol.raidProfile = "Mount required to read profile";
        }
    });
}

// --- 2. RENDER MASTER VIEW ---
function renderMasterView() {
    const container = el("disk-container");
    if (!parsedVolumesData.length) return container.innerHTML = "<p class='mt-15'>No BTRFS filesystems detected on the system.</p>";

    container.innerHTML = parsedVolumesData.map((vol) => `
        <div class="btrfs-card hoverable animated-view h-100-col">
            <h3>${vol.label}</h3>
            <p class="mb-5"><b>UUID:</b> <span class="btrfs-code">${vol.uuid}</span></p>
            <p class="mb-5"><b>Capacity:</b> ${vol.totalSize}</p>
            <p class="mb-15"><b>Mount Status:</b> ${vol.mountPoint ? 
                `<span class="text-success">Mounted at ${vol.mountPoint}</span>` : 
                `<span class="text-warning">Not Mounted</span> <button class="btn-primary btn-micro btn-action" data-action="mount-vol" data-uuid="${vol.uuid}">Mount</button>`}</p>
            <button class="btn btn-secondary w-100 mt-auto btn-action" data-action="open-detail" data-index="${vol.index}">Manage Volume</button>
        </div>
    `).join('');
}

// --- 3. RENDER DETAIL VIEW ---
function renderDetailView(idx) {
    const vol = parsedVolumesData.find(v => v.index == idx);
    if (!vol) return;
    el("detail-container").setAttribute("data-active-index", idx);

    let devHtml = vol.devices.map(d => `
        <div class="topo-item"><span><span class="btrfs-code">${d.path}</span> <span class="text-muted">(ID: ${d.id} | Size: ${d.size})</span></span>
        ${vol.mountPoint ? `<button class="btn btn-danger btn-sm btn-action" data-action="remove-dev" data-mount="${vol.mountPoint}" data-devpath="${d.path}">Remove</button>` : ''}
        </div>
    `).join("");
    
    let advancedTopoHtml = '';
    if (vol.mountPoint) {
        advancedTopoHtml = `
            <div class="advanced-topo-actions">
                <button class="btn btn-primary btn-sm btn-action" data-action="add-dev-modal" data-mount="${vol.mountPoint}">Add Disk</button>
                <button class="btn btn-secondary btn-sm btn-action" data-action="convert-raid" data-mount="${vol.mountPoint}">Convert RAID Profile</button>
                <button class="btn btn-secondary btn-sm btn-action" data-action="resize-vol" data-mount="${vol.mountPoint}">Resize Volume</button>
            </div>
        `;
    }

    const html = `
        <h2 class="animated-view mb-25">${vol.label}</h2>
        <div class="detail-layout-grid">
            <div class="detail-left-col animated-view">
                <div class="btrfs-card">
                    <h4 class="section-title">System Information & Topology</h4>
                    <p class="mb-8"><b>UUID:</b> <span class="btrfs-code">${vol.uuid}</span></p>
                    <p class="mb-8"><b>Total Capacity:</b> ${vol.totalSize}</p>
                    <p class="mb-8"><b>Active Profile:</b> <span id="raid-display-${vol.index}">${vol.raidProfile}</span></p>
                    <p class="mb-25"><b>Mount Status:</b> ${vol.mountPoint ? `<span class="text-success">Mounted at ${vol.mountPoint}</span>` : `<span class="text-warning">Not Mounted (Locked)</span>`}</p>
                    
                    <p class="section-title mt-15">Physical Device Topology</p>
                    <div>${devHtml}</div>
                    ${advancedTopoHtml}
                </div>

                ${vol.mountPoint ? `
                <div class="btrfs-card">
                    <h4 class="section-title">Advanced Maintenance & Optimization</h4>
                    <div class="flex-wrap-gap">
                        <button class="btn btn-primary btn-sm btn-action" data-action="scrub-start" data-mount="${vol.mountPoint}">Start Scrub</button>
                        <button class="btn btn-secondary btn-sm btn-action" data-action="scrub-status" data-mount="${vol.mountPoint}">Check Scrub</button>
                        <button class="btn btn-secondary btn-sm btn-action" data-action="balance" data-mount="${vol.mountPoint}">Balance (50%)</button>
                        <button class="btn btn-secondary btn-sm btn-action" data-action="defrag-compress" data-mount="${vol.mountPoint}">Defrag + Compress ZSTD</button>
                    </div>
                    <div id="maint-console-${vol.mountPoint.replace(/\//g, '-')}" class="status-console hidden-element"></div>
                </div>
                ` : `
                <div class="warning-box">
                    <p class="text-warning mb-5">Volume Not Mounted</p>
                    <p class="mb-15 text-muted">This volume must be mounted to access subvolumes and advanced maintenance features.</p>
                    <button class="btn btn-primary btn-sm btn-action" data-action="mount-vol" data-uuid="${vol.uuid}">Mount Volume</button>
                </div>
                `}
            </div>

            <div class="detail-right-col animated-view">
                <div class="btrfs-card h-100-col">
                    <h4 class="section-title">Subvolume & Snapshot Management</h4>
                    ${vol.mountPoint ? `
                    <div class="flex-wrap-gap mb-15">
                        <input type="text" id="new-subvol-${vol.index}" placeholder="New subvolume name..." class="form-input flex-grow">
                        <button class="btn btn-primary btn-sm btn-action" data-action="add-subvol" data-mount="${vol.mountPoint}" data-index="${vol.index}">Create</button>
                        <button class="btn btn-secondary btn-sm btn-action" data-action="snap-root" data-mount="${vol.mountPoint}">Snapshot Root</button>
                    </div>
                    <div id="subvol-list-${vol.index}" class="subvol-list-full"><p class="p-15-muted">Loading subvolumes...</p></div>
                    ` : '<p class="text-warning">Mount this volume first to access Subvolumes.</p>'}
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
            customPrompt("Mount Volume", "Enter the directory location (mount point) to attach this volume.\nExample: /mnt/data\n\nIf the directory doesn't exist, it will be created.", `/mnt/btrfs_${volUuid.substring(0,8)}`, "Mount",
                (targetDir) => {
                    if (targetDir && targetDir.trim() !== "") {
                        runCmd(["sh", "-c", `mkdir -p ${targetDir} && mount UUID=${volUuid} ${targetDir}`]).then(() => fetchBtrfsData()).catch(err => customAlert("Mount Failed", err.message));
                    }
                }
            );
            break;

        case 'convert-raid':
            const raidOptions = [
                { value: "single", label: "Single (1 Disk)" },
                { value: "raid0", label: "RAID 0 (Stripe - Min 2 Disks)" },
                { value: "raid1", label: "RAID 1 (Mirror - Min 2 Disks)" },
                { value: "raid10", label: "RAID 10 (Stripe+Mirror - Min 4 Disks)" }
            ];
            
            customSelect("Online RAID Profile Conversion", "Select a new target profile.\nWARNING: Ensure you have enough disks connected to the volume before proceeding.", raidOptions, "Convert Profile",
                (newProfile) => {
                    if(newProfile && newProfile.trim() !== "") {
                        // PENAMBAHAN FLAG "-f" (FORCE) UNTUK MELEWATI BLOKADE PENURUNAN INTEGRITAS METADATA OLEH KERNEL
                        runTask(`Starting online profile conversion to ${newProfile.toUpperCase()}. This process reorganizes blocks and may take a long time...`, 
                        ["btrfs", "balance", "start", "-f", "-dconvert=" + newProfile, "-mconvert=" + newProfile, mount], 
                        `Conversion to ${newProfile.toUpperCase()} successfully triggered!`);
                    }
                }
            );
            break;
            
        case 'resize-vol':
            customPrompt("Online Volume Resize", "Enter target size (e.g., 'max', '+10G', '-5G').", "max", "Resize",
                (size) => { if(size && size.trim() !== "") runTask(`Executing resize ${size}...`, ["btrfs", "filesystem", "resize", size, mount], `Successfully resized!`, true); }
            );
            break;

        case 'defrag-compress':
            customConfirm("Defragment & Compress", `Start recursive defragmentation with Transparent Compression (ZSTD) on ${mount}?\nThis will compress existing data in the background.`, "Start Defrag",
                () => runTask("Sending defrag & ZSTD compression command...", ["btrfs", "filesystem", "defragment", "-r", "-czstd", mount], "Command successfully sent to Kernel.")
            );
            break;

        case 'manage-subvol':
            el("manage-subvol-modal").classList.remove("hidden-element");
            el("modal-subvol-path").innerText = "/" + tgt.getAttribute("data-path");
            el("modal-subvol-id").innerText = "(ID: " + tgt.getAttribute("data-subid") + ")";

            const modalBtns = document.querySelectorAll("#manage-subvol-modal .btn-action");
            modalBtns.forEach(btn => {
                btn.setAttribute("data-mount", tgt.getAttribute("data-mount"));
                btn.setAttribute("data-path", tgt.getAttribute("data-path"));
                btn.setAttribute("data-subid", tgt.getAttribute("data-subid"));
                btn.setAttribute("data-index", tgt.getAttribute("data-index"));
            });
            break;

        case 'set-quota':
            el("manage-subvol-modal").classList.add("hidden-element");
            const qPath = mount === "/" ? `/${tgt.getAttribute("data-path")}` : `${mount}/${tgt.getAttribute("data-path")}`;
            customPrompt("Quota Management", `Enter the maximum capacity limit for this subvolume (e.g., 50G, 100G, 500M).\n\nQuota limit for ${qPath}:`, "50G", "Apply Limit",
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
            el("manage-subvol-modal").classList.add("hidden-element");
            const subId = tgt.getAttribute("data-subid");
            customConfirm("Set Default Mount", `Set Subvolume ID ${subId} as Default?\nIf enabled, when the disk is mounted, the system will automatically read this subvolume as its Root.`, "Set as Default",
                () => { runCmd(["btrfs", "subvolume", "set-default", subId, mount]).then(() => customAlert("Success", `ID ${subId} is now the default mount.`)).catch(err => customAlert("Failed", err.message)); }
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
            el("manage-subvol-modal").classList.add("hidden-element");
            const path = tgt.getAttribute("data-path");
            customConfirm("Delete Subvolume", `Permanently delete subvolume "${path}"?`, "Delete",
                () => { runCmd(["btrfs", "subvolume", "delete", mount === "/" ? `/${path}` : `${mount}/${path}`]).then(() => loadSubvols(mount, tgt.getAttribute("data-index"))).catch(err => customAlert("Failed", err.message)); }
            );
            break;
            
        case 'snap-root': takeSnapshot(mount, "", tgt.getAttribute("data-index")); break;
        
        case 'snap-subvol': 
            el("manage-subvol-modal").classList.add("hidden-element");
            takeSnapshot(mount, tgt.getAttribute("data-path"), tgt.getAttribute("data-index")); 
            break;
            
        case 'restore-subvol': 
            el("manage-subvol-modal").classList.add("hidden-element");
            restoreSnapshot(mount, tgt.getAttribute("data-path"), tgt.getAttribute("data-index")); 
            break;
        
        case 'scrub-start': 
            customConfirm("Start Scrub", `Start Scrub on ${mount}?`, "Start", () => runTask("Starting scrub...", ["btrfs", "scrub", "start", mount], "(Click 'Check Scrub Status' to monitor progress)")); 
            break;
            
        case 'scrub-status': runTask("Fetching status...", ["btrfs", "scrub", "status", mount]); break;
        
        case 'balance': 
            customConfirm("Start Balance", `Start Balance process on ${mount}?`, "Start", () => runTask("Balance process running...", ["btrfs", "balance", "start", "-dusage=50", mount], "Validation successful!")); 
            break;
            
        case 'remove-dev':
            const dev = tgt.getAttribute("data-devpath");
            customConfirm("Remove Device", `WARNING: Evacuating and removing ${dev} from ${mount}.\nProceed?`, "Remove",
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
});

el("btn-close-add-modal").addEventListener("click", () => el("add-dev-modal").classList.add("hidden-element"));
el("btn-close-subvol-modal").addEventListener("click", () => el("manage-subvol-modal").classList.add("hidden-element"));

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

// --- 5. FETCH SUBVOLUME ---
function loadSubvols(mount, idx) {
    const list = el(`subvol-list-${idx}`);
    if(!list) return;
    list.innerHTML = "<p class='mt-15 text-muted'>Scanning subvolumes...</p>";

    runCmd(["btrfs", "subvolume", "list", mount])
        .then(out => {
            const html = out.trim().split("\n").filter(l => l.trim()).map((line) => {
                const m = line.match(/ID\s+(\d+).*path\s+(.+)$/i);
                if (!m) return "";
                const subId = m[1].trim();
                const p = m[2].trim();
                
                return `<div class="subvol-item animated-view">
                            <div class="subvol-info">
                                <span class="btrfs-code">/${p}</span>
                                <span class="text-muted">ID: ${subId}</span>
                            </div>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="manage-subvol" data-mount="${mount}" data-path="${p}" data-subid="${subId}" data-index="${idx}">Manage</button>
                        </div>`;
            }).join("");
            list.innerHTML = html || "<p class='mt-15 text-muted'>No custom subvolumes created yet.</p>";
        }).catch(err => list.innerHTML = `<p class='text-danger mt-15'>Load failed: ${err.message}</p>`);
}

function takeSnapshot(mount, subvol, idx) {
    const dt = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defName = subvol ? `${subvol.split("/").pop()}_snap_${dt}` : `root_snap_${dt}`;
    customPrompt("Create Snapshot", `Enter new snapshot name:\n(Source: ${subvol || "Root Volume"})`, defName, "Create",
        (name) => {
            if(name && name.trim() !== '') {
                const src = subvol ? (mount === "/" ? `/${subvol}` : `${mount}/${subvol}`) : mount;
                const dst = mount === "/" ? `/${name}` : `${mount}/${name}`;
                runCmd(["btrfs", "subvolume", "snapshot", src, dst]).then(() => { if(idx) loadSubvols(mount, idx); else fetchBtrfsData(); }).catch(err => customAlert("Snapshot Failed", err.message));
            }
        }
    );
}

function restoreSnapshot(mount, snap, idx) {
    let defTgt = snap.split("_snap_")[0];
    if (defTgt === snap) defTgt += "_restored"; 
    customPrompt("Restore / Clone", `Enter target subvolume name:`, defTgt, "Restore",
        (tgt) => {
            if(tgt && tgt.trim() !== '') {
                const src = mount === "/" ? `/${snap}` : `${mount}/${snap}`;
                const dst = mount === "/" ? `/${tgt}` : `${mount}/${tgt}`;
                runCmd(["btrfs", "subvolume", "snapshot", src, dst]).then(() => { customAlert("Success", "Restore successful!"); loadSubvols(mount, idx); }).catch(err => customAlert("Restore Failed", err.message));
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
        el("available-disks").innerHTML = html || "<span class='text-danger'>No safe empty disks found.</span>";
        btnExec.disabled = !html;
    }).catch(err => el("available-disks").innerHTML = "Scan failed: " + err.message);
});

el("btn-cancel-format").addEventListener("click", () => formRaid.classList.add("hidden-element"));
el("btn-refresh").addEventListener("click", () => { fetchBtrfsData(); });

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