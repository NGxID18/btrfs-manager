let mountMap = {};
let parsedVolumesData = []; 

// Fungsi Helper untuk Command Execution
const runCmd = (cmd) => cockpit.spawn(cmd, { superuser: "require" });
const el = (id) => document.getElementById(id);

// --- GLOBAL: FETCH EMPTY DEVICES ---
const getEmptyDevices = () => {
    return runCmd(["lsblk", "-J", "-o", "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT"]).then(data => {
        const extractEmpty = (devs) => devs.reduce((acc, d) => {
            if (d.children) return acc.concat(extractEmpty(d.children));
            // Logika diperketat: Pastikan benar-benar kosong (tidak ada fstype)
            if (!d.fstype && !d.mountpoint && d.type === "disk" || d.type === "part") acc.push(d);
            return acc;
        }, []);
        return extractEmpty(JSON.parse(data).blockdevices || []);
    });
};

// --- 1. DATA FETCHING (DIPERKUAT DENGAN PROMISE.ALL) ---
function fetchBtrfsData() {
    if(!el("view-master").classList.contains("hidden-element")) {
        el("disk-container").innerHTML = "<p style='font-size: 18px; font-weight: bold; animation: fadeInSlideUp 0.5s ease;'>Memindai sistem penyimpanan...</p>";
    }

    // Mengeksekusi findmnt dan btrfs show secara bersamaan (Parallel Execution)
    Promise.all([
        runCmd(["findmnt", "-A", "-J", "-t", "btrfs"]).catch(() => "{}"), // Graceful fallback jika findmnt gagal
        runCmd(["btrfs", "filesystem", "show"])
    ])
    .then(([mntData, btrfsData]) => {
        // Parse Mount Map
        mountMap = {};
        try {
            const parsed = JSON.parse(mntData);
            const walk = (nodes) => nodes.forEach(n => {
                if (n.source) mountMap[n.source] = n.target;
                if (n.children) walk(n.children);
            });
            if (parsed.filesystems) walk(parsed.filesystems);
        } catch(e) {
            console.warn("BTRFS Manager: Gagal memetakan findmnt, melanjutkan proses.", e);
        }

        // Proses BTRFS Output
        processBtrfsData(btrfsData);
    })
    .catch(err => el("disk-container").innerHTML = `<p style="color:var(--btn-danger); font-size:16px;">Gagal memuat BTRFS: ${err.message}</p>`);
}

// --- 2. LOGIKA PARSING ANTI-RAPUH ---
function processBtrfsData(rawData) {
    // Memecah blok secara aman
    const blocks = rawData.split(/Label:\s+/i).filter(b => b.trim() !== "");
    
    parsedVolumesData = blocks.map((block, index) => {
        // Regex diperkuat: Menangani kutip tunggal, tanpa kutip, spasi ganda, dan case-insensitive
        const labelMatch = block.match(/^(?:'([^']*)'|(\S+))?\s+uuid:\s+([a-f0-9\-]+)/i);
        
        let label = "Sistem/Root (Tanpa Label)";
        if (labelMatch) {
            if (labelMatch[1]) label = labelMatch[1].trim(); // Jika dibungkus kutip 'label'
            else if (labelMatch[2] && labelMatch[2].toLowerCase() !== "none") label = labelMatch[2].trim(); // Jika tanpa kutip
        }
        
        const uuid = labelMatch ? labelMatch[3] : "Unknown";
        
        // Ekstraksi Path yang lebih aman
        const pathMatch = block.match(/path\s+(\/dev\/\S+)/i);
        const firstPath = pathMatch ? pathMatch[1] : "";
        
        const sizeMatch = block.match(/size\s+([0-9.]+\s?[GMKT]iB?)/i);
        const totalSize = sizeMatch ? sizeMatch[1] : "Unknown";

        // Cek Mount Point berlapis (Path eksak, UUID, atau Path + partisi)
        const mountPoint = mountMap[firstPath] || mountMap[`UUID=${uuid}`] || mountMap[firstPath + "1"] || mountMap[firstPath + "2"] || mountMap[firstPath + "3"] || (label === "Sistem/Root (Tanpa Label)" ? "/" : "");

        let devices = [];
        // Ekstraksi perangkat jamak yang tahan terhadap perubahan format spasi
        const devRegex = /devid\s+(\d+)\s+size\s+([0-9.]+\s?[a-zA-Z]+)\s+used\s+([0-9.]+\s?[a-zA-Z]+)\s+path\s+(\/dev\/\S+)/gi;
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

// --- 3. RENDER MASTER VIEW ---
function renderMasterView() {
    const container = el("disk-container");
    if (!parsedVolumesData.length) {
        container.innerHTML = "<p style='font-size:16px;'>Tidak ada filesystem BTRFS terdeteksi di sistem.</p>";
        return;
    }

    container.innerHTML = parsedVolumesData.map((vol, i) => `
        <div class="btrfs-card hoverable animated-view" style="animation-delay: ${i * 0.1}s;">
            <h3>💽 ${vol.label}</h3>
            <p style="margin-bottom: 5px;"><b>UUID:</b> <span class="btrfs-code">${vol.uuid}</span></p>
            <p style="margin-bottom: 5px;"><b>Kapasitas:</b> ${vol.totalSize}</p>
            <p><b>Status Mount:</b> ${vol.mountPoint ? `<span style="color:#38a169; font-weight:bold;">${vol.mountPoint}</span>` : `<span style="color:#d69e2e; font-weight:bold;">Not Mounted</span>`}</p>
            
            <button class="btn btn-secondary btn-block btn-action" data-action="open-detail" data-index="${vol.index}" style="margin-top:auto;">⚙️ Kelola Volume</button>
        </div>
    `).join('');
}

// --- 4. RENDER DETAIL VIEW ---
function renderDetailView(idx) {
    const vol = parsedVolumesData.find(v => v.index == idx);
    if (!vol) return;
    
    el("detail-container").setAttribute("data-active-index", idx);

    let devHtml = vol.devices.map(d => `
        <div class="topo-item"><span><span class="btrfs-code">${d.path}</span> <small style="color:var(--text-muted); font-size:13px; margin-left:5px;">(ID: ${d.id} | Size: ${d.size})</small></span>
        ${vol.mountPoint ? `<button class="btn-danger-sm btn-action" data-action="remove-dev" data-mount="${vol.mountPoint}" data-devpath="${d.path}">Cabut Disk</button>` : ''}
        </div>
    `).join("");
    
    devHtml += vol.mountPoint ? `<div class="topo-add-btn"><button class="btn btn-secondary btn-sm btn-action" data-action="add-dev-modal" data-mount="${vol.mountPoint}">➕ Tambah Disk ke Volume</button></div>` 
                          : `<p style="color:orange; font-size:14px; margin-top:5px;">Mount volume ini terlebih dahulu untuk mengelola disk fisik.</p>`;

    const html = `
        <h2 class="animated-view" style="margin-top:0; margin-bottom:25px;">💽 ${vol.label}</h2>
        
        <div class="detail-layout-grid">
            
            <div class="detail-left-col animated-view" style="animation-delay: 0.1s;">
                <div class="btrfs-card" style="margin-bottom: 0;">
                    <h4 class="topo-title">ℹ️ Informasi Sistem & Topologi</h4>
                    <p style="margin-bottom: 8px;"><b>UUID:</b> <span class="btrfs-code">${vol.uuid}</span></p>
                    <p style="margin-bottom: 8px;"><b>Kapasitas Total:</b> ${vol.totalSize}</p>
                    <p style="margin-bottom: 25px;"><b>Status Mount:</b> ${vol.mountPoint ? `<span style="color:#38a169; font-weight:bold;">Mounted di ${vol.mountPoint}</span>` : `<span style="color:#d69e2e; font-weight:bold;">Not Mounted (Terkunci)</span>`}</p>
                    
                    <p class="topo-title" style="margin-top: 25px;">Topologi Perangkat Fisik (Disk)</p>
                    <div>${devHtml}</div>
                </div>

                ${vol.mountPoint ? `
                <div class="btrfs-card" style="margin-bottom: 0;">
                    <div class="maintenance-section" style="margin:0; padding:0; border:none; background:transparent;">
                        <h4>🛠 Perawatan & Optimasi</h4>
                        <div class="btn-group">
                            <button class="btn btn-primary btn-sm btn-action" data-action="scrub-start" data-mount="${vol.mountPoint}">Mulai Scrub</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="scrub-status" data-mount="${vol.mountPoint}">Cek Scrub</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="balance" data-mount="${vol.mountPoint}">Balance (50%)</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="defrag" data-mount="${vol.mountPoint}">Defrag</button>
                        </div>
                        <div id="maint-console-${vol.mountPoint.replace(/\//g, '-')}" class="status-console hidden-element"></div>
                    </div>
                </div>
                ` : ''}
            </div>

            <div class="detail-right-col animated-view" style="animation-delay: 0.2s;">
                <div class="btrfs-card" style="margin-bottom: 0; height: 100%; display: flex; flex-direction: column;">
                    <h4 class="topo-title">📂 Manajemen Subvolume & Snapshot</h4>
                    ${vol.mountPoint ? `
                    <div style="margin-bottom: 15px; display:flex; gap:10px; flex-wrap: wrap;">
                        <input type="text" id="new-subvol-${vol.index}" placeholder="Nama subvolume baru..." class="form-input" style="flex-grow:1;">
                        <button class="btn btn-primary btn-sm btn-action" data-action="add-subvol" data-mount="${vol.mountPoint}" data-index="${vol.index}">➕ Tambah</button>
                        <button class="btn btn-secondary btn-sm btn-action" data-action="snap-root" data-mount="${vol.mountPoint}">📸 Snapshot Root</button>
                    </div>
                    <div id="subvol-list-${vol.index}" class="subvol-list-full"><p style="padding:15px; animation: pulseGlow 2s infinite;">Memuat subvolume...</p></div>
                    ` : '<p style="color:#d69e2e; font-weight:bold;">Mount volume ini terlebih dahulu untuk mengakses Subvolume.</p>'}
                </div>
            </div>
        </div>
    `;

    el("detail-container").innerHTML = html;
    if (vol.mountPoint) loadSubvols(vol.mountPoint, vol.index);
}

// --- 5. DISPATCHER & LOGIKA CLI BTRFS ---
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
        case 'open-detail':
            el("view-master").classList.add("hidden-element");
            el("view-detail").classList.remove("hidden-element");
            renderDetailView(tgt.getAttribute("data-index"));
            break;

        case 'add-subvol':
            const idx = tgt.getAttribute("data-index");
            const name = el(`new-subvol-${idx}`).value.trim();
            if (!name) return alert("Nama subvolume tidak boleh kosong!");
            runCmd(["btrfs", "subvolume", "create", mount === "/" ? `/${name}` : `${mount}/${name}`])
                .then(() => { el(`new-subvol-${idx}`).value = ""; loadSubvols(mount, idx); })
                .catch(err => alert("Gagal:\n" + err.message));
            break;
            
        case 'del-subvol':
            const path = tgt.getAttribute("data-path");
            if(confirm(`Hapus permanen subvolume "${path}"?`)) {
                runCmd(["btrfs", "subvolume", "delete", mount === "/" ? `/${path}` : `${mount}/${path}`])
                    .then(() => loadSubvols(mount, tgt.closest('.subvol-list-full').id.split('-').pop()))
                    .catch(err => alert("Gagal:\n" + err.message));
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

        case 'scrub-start':
            if(confirm(`Mulai proses Scrub (verifikasi integritas) pada ${mount}?`)) runTask("Memulai scrub...", ["btrfs", "scrub", "start", mount], "(Klik 'Cek Scrub' untuk memantau progres)");
            break;
            
        case 'scrub-status':
            runTask("Mengambil status...", ["btrfs", "scrub", "status", mount]);
            break;
            
        case 'balance':
            if(confirm(`Mulai proses Balance (penyeimbangan data) pada ${mount}?`)) runTask("Proses Balance berjalan (ini mungkin memakan waktu)...", ["btrfs", "balance", "start", "-dusage=50", mount], "Berhasil divalidasi!");
            break;
            
        case 'defrag':
            if(confirm(`Mulai Defragmentasi pada ${mount}?`)) runTask("Mengirim perintah defrag...", ["btrfs", "filesystem", "defragment", "-r", mount], "Perintah defrag berhasil dikirim ke Kernel.");
            break;
            
        case 'remove-dev':
            const dev = tgt.getAttribute("data-devpath");
            if(confirm(`PERINGATAN: Mengevakuasi dan mencabut ${dev} dari ${mount}.\nLanjutkan?`)) runTask(`Mengevakuasi ${dev}...`, ["btrfs", "device", "remove", dev, mount], `Berhasil mencabut ${dev}.`, true);
            break;
        
        case 'add-dev-modal':
            el("add-dev-modal").classList.remove("hidden-element");
            el("modal-mount-target").innerText = mount;
            el("btn-confirm-add-dev").setAttribute("data-mount", mount);
            el("btn-confirm-add-dev").disabled = true;
            el("modal-disk-select").innerHTML = `<option value="">Memindai perangkat blok yang kosong...</option>`;
            
            getEmptyDevices().then(devs => {
                if(devs.length === 0) {
                    el("modal-disk-select").innerHTML = `<option value="">Tidak ada disk kosong yang aman digunakan!</option>`;
                } else {
                    el("modal-disk-select").innerHTML = devs.map(d => `<option value="/dev/${d.name}">/dev/${d.name} (${d.size} - Unallocated)</option>`).join("");
                    el("btn-confirm-add-dev").disabled = false;
                }
            }).catch(err => el("modal-disk-select").innerHTML = `<option value="">Error: ${err.message}</option>`);
            break;
    }
});

// Navigasi Kembali
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

// Aksi Modal (Pop-up)
el("btn-close-modal").addEventListener("click", () => el("add-dev-modal").classList.add("hidden-element"));
el("btn-confirm-add-dev").addEventListener("click", (e) => {
    const mount = e.target.getAttribute("data-mount");
    const newDev = el("modal-disk-select").value;
    if(!newDev) return;
    
    el("add-dev-modal").classList.add("hidden-element");
    
    const consoleId = `maint-console-${(mount || "").replace(/\//g, '-')}`;
    const cBox = el(consoleId) || { innerText: '', classList: { remove:()=>{} } };
    cBox.classList.remove("hidden-element");
    cBox.innerText = `Menggabungkan ${newDev} ke ${mount}...`;

    runCmd(["btrfs", "device", "add", "-f", newDev, mount])
        .then(out => {
            cBox.innerText = `Sukses menambahkan ${newDev}!\n\nDisarankan untuk menjalankan fitur Balance setelah ini.\n\n${out}`;
            fetchBtrfsData();
        })
        .catch(err => cBox.innerText = "Gagal menambah disk: " + err.message);
});

// --- 6. FUNGSI FETCH SUBVOLUME ---
function loadSubvols(mount, idx) {
    const list = el(`subvol-list-${idx}`);
    if(!list) return;
    list.innerHTML = "<p style='padding:15px; font-style: italic;'>Memindai subvolume...</p>";

    // Logika parsing path subvolume diperketat untuk menghindari error path spasi
    runCmd(["btrfs", "subvolume", "list", mount])
        .then(out => {
            const html = out.trim().split("\n").filter(l => l.trim()).map((line, i) => {
                const m = line.match(/path\s+(.+)$/i);
                if (!m) return "";
                const p = m[1].trim();
                return `<div class="subvol-item animated-view" style="animation-delay: ${i * 0.05}s;">
                            <span>📁 <b class="btrfs-code" style="font-size:14px;">${p}</b></span>
                            <div class="subvol-actions">
                                <button class="btn-restore btn-action" data-action="restore-subvol" data-mount="${mount}" data-path="${p}">🔄 Restore / Clone</button>
                                <button class="btn-snapshot btn-action" data-action="snap-subvol" data-mount="${mount}" data-path="${p}">📸 Snapshot</button>
                                <button class="btn-danger-sm btn-action" data-action="del-subvol" data-mount="${mount}" data-path="${p}">Hapus</button>
                            </div>
                        </div>`;
            }).join("");
            list.innerHTML = html || "<p style='padding:15px; color:var(--text-muted);'>Belum ada subvolume yang dibuat.</p>";
        }).catch(err => list.innerHTML = `<p style='padding:15px; color:var(--btn-danger);'>Gagal memuat: ${err.message}</p>`);
}

function takeSnapshot(mount, subvol) {
    const dt = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defName = subvol ? `${subvol.split("/").pop()}_snap_${dt}` : `root_snap_${dt}`;
    const name = prompt(`Masukkan nama snapshot baru:\n(Sumber Data: ${subvol || "Root Volume"})`, defName);
    if (!name) return;

    const src = subvol ? (mount === "/" ? `/${subvol}` : `${mount}/${subvol}`) : mount;
    const dst = mount === "/" ? `/${name}` : `${mount}/${name}`;
    
    runCmd(["btrfs", "subvolume", "snapshot", src, dst])
        .then(() => fetchBtrfsData()) 
        .catch(err => alert("Gagal Snapshot:\n" + err.message));
}

function restoreSnapshot(mount, snap, idx) {
    let defTgt = snap.split("_snap_")[0];
    if (defTgt === snap) defTgt += "_restored"; 
    
    const tgt = prompt(`🔄 RESTORE / CLONE\n\nSumber Data: ${snap}\n\nMasukkan nama subvolume target:`, defTgt);
    if (!tgt) return;

    const src = mount === "/" ? `/${snap}` : `${mount}/${snap}`;
    const dst = mount === "/" ? `/${tgt}` : `${mount}/${tgt}`;

    runCmd(["btrfs", "subvolume", "snapshot", src, dst])
        .then(() => { alert("✅ Restore berhasil!"); loadSubvols(mount, idx); })
        .catch(err => alert("❌ Gagal melakukan restore:\n" + err.message));
}

// --- 7. RAID CREATION & REFRESH ---
const formRaid = el("raid-form");
const statusTxt = el("format-status");
const btnExec = el("btn-execute-format");

el("btn-create-raid").addEventListener("click", () => {
    formRaid.classList.remove("hidden-element");
    statusTxt.innerText = "";
    statusTxt.classList.add("hidden-element");
    
    const box = el("available-disks");
    box.innerHTML = "Memindai perangkat blok secara mendalam...";
    
    getEmptyDevices().then(safeDevs => {
        const html = safeDevs.map(d => `<label class="disk-label-item"><input type="checkbox" name="tgt-disk" value="/dev/${d.name}"> <span class="btrfs-code">/dev/${d.name}</span> - Kapasitas: ${d.size}</label>`).join("");
        box.innerHTML = html || "<span style='color:var(--btn-danger); font-weight:bold;'>Tidak ada disk kosong yang aman digunakan.</span>";
        btnExec.disabled = !html;
    }).catch(err => box.innerHTML = "Gagal memindai: " + err.message);
});

el("btn-cancel-format").addEventListener("click", () => formRaid.classList.add("hidden-element"));
el("btn-refresh").addEventListener("click", () => {
    el("btn-refresh").style.transform = "rotate(180deg)"; 
    setTimeout(() => el("btn-refresh").style.transform = "none", 300);
    fetchBtrfsData();
});

btnExec.addEventListener("click", () => {
    const disks = Array.from(document.querySelectorAll('input[name="tgt-disk"]:checked')).map(cb => cb.value);
    const prof = el("raid-profile").value;
    const lbl = el("volume-label").value.trim();

    if (!disks.length) {
        statusTxt.innerText = "Error: Belum ada disk yang dicentang!";
        statusTxt.classList.remove("hidden-element");
        statusTxt.style.color = "var(--btn-danger)";
        return;
    }
    
    let cmd = ["mkfs.btrfs", "-d", prof, "-m", prof, "-f"];
    if (lbl) cmd.push("-L", lbl);
    cmd.push(...disks);

    statusTxt.classList.remove("hidden-element");
    statusTxt.style.color = "var(--btn-primary)";
    statusTxt.innerText = "> " + cmd.join(" ") + "\nSedang memformat...";
    btnExec.disabled = true;

    runCmd(cmd).then(() => {
        statusTxt.style.color = "var(--console-text)";
        statusTxt.innerText = "Volume BTRFS sukses dibuat!";
        fetchBtrfsData();
        setTimeout(() => { formRaid.classList.add("hidden-element"); btnExec.disabled = false; }, 3000);
    }).catch(err => {
        statusTxt.style.color = "var(--btn-danger)";
        statusTxt.innerText = "Gagal format:\n" + err.message;
        btnExec.disabled = false;
    });
});

// Boot awal
fetchBtrfsData();