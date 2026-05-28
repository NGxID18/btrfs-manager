let mountMap = {};

// Helper functions for cleaner code
const runCmd = (cmd) => cockpit.spawn(cmd, { superuser: "require" });
const el = (id) => document.getElementById(id);

// --- 1. DATA FETCHING ---
function fetchBtrfsData() {
    const container = el("disk-container");
    container.innerHTML = "<p>Loading system data...</p>";

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
        .catch(() => runCmd(["btrfs", "filesystem", "show"])) // Fallback if findmnt fails
        .then(out => container.innerHTML = parseBtrfsOutput(out))
        .catch(err => container.innerHTML = `<p style="color:red;">Load failed: ${err.message}</p>`);
}

// --- 2. HTML RENDERER ---
function parseBtrfsOutput(rawData) {
    const blocks = rawData.split(/Label:\s+/).filter(b => b.trim() !== "");
    if (!blocks.length) return "<p>No BTRFS filesystems found.</p>";

    return blocks.map((block, index) => {
        const labelMatch = block.match(/^(.*?)?\s+uuid:\s+([a-z0-9\-]+)/);
        const label = (labelMatch && labelMatch[1] && labelMatch[1].trim() !== "none") ? labelMatch[1].replace(/'/g, "").trim() : "System/Root (No Label)";
        const uuid = labelMatch ? labelMatch[2] : "-";
        
        const pathMatch = block.match(/path\s+(\/dev\/\S+)/);
        const firstPath = pathMatch ? pathMatch[1] : "-";
        const mountPoint = mountMap[firstPath] || mountMap[`UUID=${uuid}`] || mountMap[firstPath + "1"] || (label === "System/Root (No Label)" ? "/" : "");

        let devHtml = `<div class="topo-box"><p class="topo-title">Physical Device Topology:</p>`;
        const devRegex = /devid\s+(\d+)\s+size\s+([0-9.]+\s?[a-zA-Z]+)\s+used\s+([0-9.]+\s?[a-zA-Z]+)\s+path\s+(\/dev\/\S+)/g;
        let match;
        while ((match = devRegex.exec(block))) {
            devHtml += `<div class="topo-item"><span><span class="btrfs-code">${match[4]}</span> <small>(ID: ${match[1]} | Size: ${match[2]})</small></span>`;
            if (mountPoint) devHtml += `<button class="btn-danger-sm btn-action" data-action="remove-dev" data-mount="${mountPoint}" data-devpath="${match[4]}">Remove</button>`;
            devHtml += `</div>`;
        }
        devHtml += mountPoint ? `<div class="topo-add-btn"><button class="btn btn-secondary btn-sm btn-action" data-action="add-dev" data-mount="${mountPoint}">➕ Add Disk to Volume</button></div>` 
                              : `<p style="color:orange; font-size:12px; margin-top:5px;">Mount volume to manage devices.</p>`;
        devHtml += `</div>`;

        return `
            <div class="btrfs-card">
                <h3>💽 ${label}</h3>
                <p><b>UUID:</b> <span class="btrfs-code">${uuid}</span></p>
                <p><b>Mount Status:</b> ${mountPoint ? `<span style="color:green; font-weight:bold;">Mounted at ${mountPoint}</span>` : `<span style="color:orange;">Not Mounted (Locked)</span>`}</p>
                ${devHtml}
                ${mountPoint ? `
                    <div class="subvol-section">
                        <button class="btn btn-secondary btn-sm btn-action" data-action="toggle-subvol" data-boxid="subvol-box-${index}" data-mount="${mountPoint}">📂 Manage Subvolumes</button>
                        <div id="subvol-box-${index}" class="hidden-element" style="margin-top: 10px;">
                            <div style="margin-bottom: 10px; display:flex; gap:10px; flex-wrap: wrap;">
                                <input type="text" id="new-subvol-${index}" placeholder="New subvolume name..." class="form-input" style="flex-grow:1;">
                                <button class="btn btn-primary btn-sm btn-action" data-action="add-subvol" data-mount="${mountPoint}" data-index="${index}">➕ Add</button>
                                <button class="btn btn-secondary btn-sm btn-action" data-action="snap-root" data-mount="${mountPoint}">📸 Snapshot Root</button>
                            </div>
                            <div id="subvol-list-${index}" class="subvol-list"><p style="padding:10px;">Loading...</p></div>
                        </div>
                    </div>
                    <div class="maintenance-section">
                        <h4>🛠 Maintenance & Optimization</h4>
                        <div class="btn-group">
                            <button class="btn btn-primary btn-sm btn-action" data-action="scrub-start" data-mount="${mountPoint}">Start Scrub</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="scrub-status" data-mount="${mountPoint}">Scrub Status</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="balance" data-mount="${mountPoint}">Balance (50%)</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="defrag" data-mount="${mountPoint}">Defragment</button>
                        </div>
                        <div id="maint-console-${mountPoint.replace(/\//g, '-')}" class="status-console hidden-element"></div>
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

// --- 3. EVENT DISPATCHER ---
el("disk-container").addEventListener("click", e => {
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
        // Subvolumes
        case 'toggle-subvol':
            const box = el(tgt.getAttribute("data-boxid"));
            box.classList.toggle("hidden-element");
            if (!box.classList.contains("hidden-element")) loadSubvols(mount, tgt.getAttribute("data-boxid").split('-').pop());
            break;
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
                    .then(() => loadSubvols(mount, tgt.closest('.subvol-box-class').id.split('-').pop()))
                    .catch(err => alert("Failed:\n" + err.message));
            }
            break;
        
        // Snapshots
        case 'snap-root':
            takeSnapshot(mount, "");
            break;
        case 'snap-subvol':
            takeSnapshot(mount, tgt.getAttribute("data-path"));
            break;
        case 'restore-subvol':
            restoreSnapshot(mount, tgt.getAttribute("data-path"), tgt.closest('.subvol-box-class').id.split('-').pop());
            break;

        // Maintenance
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

        // Device Management
        case 'remove-dev':
            const dev = tgt.getAttribute("data-devpath");
            if(confirm(`WARNING: Evacuating and removing ${dev} from ${mount}.\nProceed?`)) runTask(`Evacuating ${dev}...`, ["btrfs", "device", "remove", dev, mount], `Successfully removed ${dev}.`, true);
            break;
        case 'add-dev':
            const newDev = prompt(`ADD NEW DEVICE\nEnter blank device path (e.g., /dev/sdd):\nWARNING: All data on this disk will be wiped!`);
            if(newDev) runTask(`Adding ${newDev.trim()}...`, ["btrfs", "device", "add", "-f", newDev.trim(), mount], `Added ${newDev.trim()}. Recommend running Balance next.`, true);
            break;
    }
});

// --- 4. SUBVOLUME & SNAPSHOT LOGIC ---
function loadSubvols(mount, idx) {
    const list = el(`subvol-list-${idx}`);
    if(!list) return;
    list.innerHTML = "<p style='padding:10px;'>Scanning subvolumes...</p>";
    list.parentElement.classList.add("subvol-box-class");

    runCmd(["btrfs", "subvolume", "list", mount])
        .then(out => {
            const html = out.trim().split("\n").filter(l => l.trim()).map(line => {
                const m = line.match(/path\s+(.+)$/);
                if (!m) return "";
                const p = m[1];
                return `<div class="subvol-item">
                            <span>📁 <b class="btrfs-code">${p}</b></span>
                            <div class="subvol-actions">
                                <button class="btn-restore btn-action" data-action="restore-subvol" data-mount="${mount}" data-path="${p}">🔄 Restore/Clone</button>
                                <button class="btn-snapshot btn-action" data-action="snap-subvol" data-mount="${mount}" data-path="${p}">📸 Snapshot</button>
                                <button class="btn-danger-sm btn-action" data-action="del-subvol" data-mount="${mount}" data-path="${p}">Delete</button>
                            </div>
                        </div>`;
            }).join("");
            list.innerHTML = html || "<p style='padding:10px; color:gray;'>No custom subvolumes.</p>";
        }).catch(err => list.innerHTML = `<p style='padding:10px; color:red;'>Failed: ${err.message}</p>`);
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

// --- 5. RAID CREATION LOGIC ---
const formRaid = el("raid-form");
const statusTxt = el("format-status");
const btnExec = el("btn-execute-format");

el("btn-create-raid").addEventListener("click", () => {
    formRaid.classList.remove("hidden-element");
    statusTxt.innerText = "";
    statusTxt.classList.add("hidden-element");
    
    const box = el("available-disks");
    box.innerHTML = "Deep scanning block devices...";
    
    const extractEmpty = (devs) => devs.reduce((acc, d) => {
        if (d.children) return acc.concat(extractEmpty(d.children));
        if (!d.fstype && !d.mountpoint) acc.push(d);
        return acc;
    }, []);

    runCmd(["lsblk", "-J", "-o", "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT"])
        .then(data => {
            const safeDevs = extractEmpty(JSON.parse(data).blockdevices || []);
            const html = safeDevs.map(d => `<label class="disk-label-item"><input type="checkbox" name="tgt-disk" value="/dev/${d.name}"> <span class="btrfs-code">/dev/${d.name}</span> - ${d.size} (Unallocated)</label>`).join("");
            box.innerHTML = html || "<span style='color:#b30000; font-weight:bold;'>No safe empty disks found.</span>";
            btnExec.disabled = !html;
        }).catch(err => box.innerHTML = "Scan failed: " + err.message);
});

el("btn-cancel-format").addEventListener("click", () => formRaid.classList.add("hidden-element"));
el("btn-refresh").addEventListener("click", fetchBtrfsData);

btnExec.addEventListener("click", () => {
    const disks = Array.from(document.querySelectorAll('input[name="tgt-disk"]:checked')).map(cb => cb.value);
    const prof = el("raid-profile").value;
    const lbl = el("volume-label").value.trim();

    if (!disks.length) {
        statusTxt.innerText = "Error: No disks selected!";
        statusTxt.classList.remove("hidden-element");
        statusTxt.style.color = "#b30000";
        return;
    }
    
    let cmd = ["mkfs.btrfs", "-d", prof, "-m", prof, "-f"];
    if (lbl) cmd.push("-L", lbl);
    cmd.push(...disks);

    statusTxt.classList.remove("hidden-element");
    statusTxt.style.color = "#0066cc";
    statusTxt.innerText = "> " + cmd.join(" ") + "\nFormatting...";
    btnExec.disabled = true;

    runCmd(cmd).then(() => {
        statusTxt.style.color = "green";
        statusTxt.innerText = "Volume created successfully!";
        fetchBtrfsData();
        setTimeout(() => { formRaid.classList.add("hidden-element"); btnExec.disabled = false; }, 3000);
    }).catch(err => {
        statusTxt.style.color = "#b30000";
        statusTxt.innerText = "Format failed:\n" + err.message;
        btnExec.disabled = false;
    });
});

// Initialization
fetchBtrfsData();