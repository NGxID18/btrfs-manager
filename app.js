// Global state untuk menyimpan data mount point
let mountMap = {};

// ==========================================
// 1. FUNGSI UTAMA & DETEKSI MOUNT POINT
// ==========================================
function fetchBtrfsData() {
    const container = document.getElementById("disk-container");
    container.innerHTML = "<p>Memuat data dari sistem...</p>";

    cockpit.spawn(["findmnt", "-A", "-J", "-t", "btrfs"])
        .then(function(mntData) {
            mountMap = {};
            try {
                const parsedMnt = JSON.parse(mntData);
                function walkMounts(nodes) {
                    nodes.forEach(node => {
                        if (node.source) mountMap[node.source] = node.target;
                        if (node.children) walkMounts(node.children);
                    });
                }
                if (parsedMnt.filesystems) walkMounts(parsedMnt.filesystems);
            } catch(e) { }
            
            return cockpit.spawn(["btrfs", "filesystem", "show"], { superuser: "require" });
        })
        .then(function(btrfsOutput) {
            container.innerHTML = parseBtrfsOutput(btrfsOutput);
        })
        .catch(function(error) {
            cockpit.spawn(["btrfs", "filesystem", "show"], { superuser: "require" })
                .then(function(btrfsOutput) {
                    container.innerHTML = parseBtrfsOutput(btrfsOutput);
                })
                .catch(function(err) {
                    container.innerHTML = `<p style="color:red;">Gagal memuat: ${err.message}</p>`;
                });
        });
}

// ==========================================
// 2. PARSING & RENDERING KARTU UI BTRFS
// ==========================================
function parseBtrfsOutput(rawData) {
    const blocks = rawData.split(/Label:\s+/).filter(b => b.trim() !== "");
    let htmlOutput = "";

    if (blocks.length === 0) return "<p>Tidak ada filesystem BTRFS ditemukan.</p>";

    blocks.forEach((block, index) => {
        const labelMatch = block.match(/^(.*?)?\s+uuid:\s+([a-z0-9\-]+)/);
        const labelRaw = labelMatch && labelMatch[1] ? labelMatch[1].trim() : "";
        const label = (labelRaw !== "none" && labelRaw !== "") ? labelRaw.replace(/'/g, "") : "Sistem/Root (Tanpa Label)";
        const uuid = labelMatch ? labelMatch[2] : "-";

        // Deteksi path pertama untuk pemetaan Mount Point
        const pathMatch = block.match(/path\s+(\/dev\/\S+)/);
        const firstPath = pathMatch ? pathMatch[1] : "-";
        const mountPoint = mountMap[firstPath] || mountMap[`UUID=${uuid}`] || mountMap[firstPath + "1"] || (label === "Sistem/Root (Tanpa Label)" ? "/" : "");

        // --- FASE 4: EKSTRAKSI MULTI-DEVICE ---
        let devicesHtml = `<div style="background: #fdfdfd; border: 1px solid #e0e0e0; padding: 10px; border-radius: 4px; margin-top: 10px; margin-bottom: 10px;">`;
        devicesHtml += `<p style="margin-top:0; font-weight:bold; border-bottom: 1px solid #ccc; padding-bottom: 5px; margin-bottom: 8px;">Topologi Perangkat Fisik:</p>`;

        const detailedDevRegex = /devid\s+(\d+)\s+size\s+([0-9.]+\s?[a-zA-Z]+)\s+used\s+([0-9.]+\s?[a-zA-Z]+)\s+path\s+(\/dev\/\S+)/g;
        let devMatch;
        while ((devMatch = detailedDevRegex.exec(block)) !== null) {
            devicesHtml += `
                <div style="display:flex; justify-content:space-between; align-items: center; margin-bottom: 5px;">
                    <span><span class="btrfs-code">${devMatch[4]}</span> <small>(ID: ${devMatch[1]} | Kapasitas: ${devMatch[2]})</small></span>
                    ${mountPoint ? `<button class="btn-danger-sm btn-action" data-action="remove-dev" data-mount="${mountPoint}" data-devpath="${devMatch[4]}" data-index="${index}" title="Evakuasi data lalu lepas disk ini">Cabut</button>` : ''}
                </div>
            `;
        }

        if (mountPoint) {
            devicesHtml += `
                <div style="margin-top: 8px; border-top: 1px dashed #ccc; padding-top: 8px;">
                    <button class="btn btn-secondary btn-sm btn-action" data-action="add-dev" data-mount="${mountPoint}" data-index="${index}">➕ Tambah Disk Baru ke Volume</button>
                </div>
            `;
        } else {
            devicesHtml += `<p style="color:orange; font-size:12px; margin-top:5px;">Mount volume untuk menambah/mencabut perangkat.</p>`;
        }
        devicesHtml += `</div>`;

        // Render struktur utama kartu
        htmlOutput += `
            <div class="btrfs-card">
                <h3>💽 ${label}</h3>
                <p><b>UUID:</b> <span class="btrfs-code">${uuid}</span></p>
                <p><b>Status Mount:</b> ${mountPoint ? `<span style="color:green; font-weight:bold;">Mounted di ${mountPoint}</span>` : `<span style="color:orange;">Not Mounted (Terkunci)</span>`}</p>
                
                ${devicesHtml}
                
                ${mountPoint ? `
                    <div class="subvol-section">
                        <button class="btn btn-secondary btn-sm btn-toggle-subvol" data-mount="${mountPoint}" data-boxid="subvol-box-${index}" data-index="${index}">
                            📂 Lihat & Kelola Subvolume
                        </button>
                        <div id="subvol-box-${index}" class="hidden-element" style="margin-top: 10px;">
                            <div style="margin-bottom: 10px; display:flex; gap:10px; flex-wrap: wrap;">
                                <input type="text" id="new-subvol-name-${index}" placeholder="Nama subvolume baru..." class="form-input" style="flex-grow:1; min-width: 150px;">
                                <button class="btn btn-primary btn-sm btn-add-subvol" data-mount="${mountPoint}" data-index="${index}">➕ Tambah</button>
                                <button class="btn btn-secondary btn-sm btn-snapshot-root" data-mount="${mountPoint}" data-index="${index}">📸 Snapshot Root Volume</button>
                            </div>
                            <div id="subvol-list-${index}" class="subvol-list"><p style="padding:10px;">Memuat subvolume...</p></div>
                        </div>
                    </div>
                    <div class="maintenance-section">
                        <h4>🛠 Perawatan Sistem & Optimasi</h4>
                        <div class="btn-group">
                            <button class="btn btn-primary btn-sm btn-action" data-action="scrub-start" data-mount="${mountPoint}" data-index="${index}">Mulai Scrub</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="scrub-status" data-mount="${mountPoint}" data-index="${index}">Cek Status Scrub</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="balance" data-mount="${mountPoint}" data-index="${index}">Balance (Filter 50%)</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="defrag" data-mount="${mountPoint}" data-index="${index}">Defragmentasi</button>
                        </div>
                        <div id="maint-console-${index}" class="status-console hidden-element"></div>
                    </div>
                ` : ''}
            </div>
        `;
    });
    return htmlOutput;
}

// ==========================================
// 3. EVENT DELEGATION
// ==========================================
document.getElementById("disk-container").addEventListener("click", function(e) {
    
    // --- AKSI SUBVOLUME & SNAPSHOT ---
    if (e.target.classList.contains("btn-toggle-subvol")) {
        const mountPoint = e.target.getAttribute("data-mount");
        const boxId = e.target.getAttribute("data-boxid");
        const index = e.target.getAttribute("data-index");
        const box = document.getElementById(boxId);
        box.classList.toggle("hidden-element");
        if (!box.classList.contains("hidden-element")) loadSubvolumes(mountPoint, index);
    }
    if (e.target.classList.contains("btn-add-subvol")) {
        createSubvolume(e.target.getAttribute("data-mount"), e.target.getAttribute("data-index"));
    }
    if (e.target.classList.contains("btn-delete-subvol")) {
        deleteSubvolume(e.target.getAttribute("data-mount"), e.target.getAttribute("data-path"), e.target.getAttribute("data-index"));
    }
    if (e.target.classList.contains("btn-snapshot-subvol")) {
        takeSnapshot(e.target.getAttribute("data-mount"), e.target.getAttribute("data-path"), e.target.getAttribute("data-index"));
    }
    if (e.target.classList.contains("btn-snapshot-root")) {
        takeSnapshot(e.target.getAttribute("data-mount"), "", e.target.getAttribute("data-index"));
    }
    if (e.target.classList.contains("btn-restore-subvol")) {
        restoreSnapshot(e.target.getAttribute("data-mount"), e.target.getAttribute("data-path"), e.target.getAttribute("data-index"));
    }

    // --- AKSI MAINTENANCE & MANAJEMEN PERANGKAT ---
    if (e.target.classList.contains("btn-action")) {
        const action = e.target.getAttribute("data-action");
        const mountPoint = e.target.getAttribute("data-mount");
        const index = e.target.getAttribute("data-index");
        const consoleBox = document.getElementById(`maint-console-${index}`);
        
        consoleBox.classList.remove("hidden-element");

        if (action === "scrub-start") {
            if(confirm(`Mulai proses Scrub pada ${mountPoint}?`)) {
                consoleBox.innerText = "Memulai scrub...";
                cockpit.spawn(["btrfs", "scrub", "start", mountPoint], { superuser: "require" })
                    .then(out => consoleBox.innerText = out + "\n\n(Klik 'Cek Status Scrub' untuk memantau progres)")
                    .catch(err => consoleBox.innerText = "Error: " + err.message);
            }
        }
        else if (action === "scrub-status") {
            consoleBox.innerText = "Mengambil status...";
            cockpit.spawn(["btrfs", "scrub", "status", mountPoint], { superuser: "require" })
                .then(out => consoleBox.innerText = out)
                .catch(err => consoleBox.innerText = "Error: " + err.message);
        }
        else if (action === "balance") {
            if(confirm(`Mulai proses Balance pada ${mountPoint}?`)) {
                consoleBox.innerText = "Proses Balance sedang berjalan...";
                cockpit.spawn(["btrfs", "balance", "start", "-dusage=50", mountPoint], { superuser: "require" })
                    .then(out => consoleBox.innerText = "Sukses!\n" + out)
                    .catch(err => consoleBox.innerText = "Error/Gagal: " + err.message);
            }
        }
        else if (action === "defrag") {
            if(confirm(`Mulai defragmentasi rekursif pada ${mountPoint}?`)) {
                consoleBox.innerText = "Defragmentasi sedang berjalan...";
                cockpit.spawn(["btrfs", "filesystem", "defragment", "-r", mountPoint], { superuser: "require" })
                    .then(() => consoleBox.innerText = "Defragmentasi selesai dikirim ke kernel.")
                    .catch(err => consoleBox.innerText = "Error: " + err.message);
            }
        }
        // FASE 4: LOGIKA TAMBAH/CABUT PERANGKAT
        else if (action === "remove-dev") {
            const devPath = e.target.getAttribute("data-devpath");
            if(confirm(`PERINGATAN: Anda akan mencabut ${devPath} dari ${mountPoint}.\n\nKernel akan mengevakuasi semua data ke disk lain yang tersisa di dalam volume ini. Proses ini bisa memakan waktu lama tergantung jumlah data Anda. Pastikan sisa disk memiliki ruang yang cukup.\n\nLanjutkan?`)) {
                consoleBox.innerText = `Memulai evakuasi data dan pelepasan ${devPath} (Proses ini mungkin memakan waktu)...`;
                cockpit.spawn(["btrfs", "device", "remove", devPath, mountPoint], { superuser: "require" })
                    .then(out => {
                        consoleBox.innerText = `Sukses mencabut ${devPath} dari volume.\n` + out;
                        fetchBtrfsData(); // Segarkan topologi
                    })
                    .catch(err => consoleBox.innerText = "Gagal mencabut perangkat: " + err.message);
            }
        }
        else if (action === "add-dev") {
            const newDev = prompt(`TAMBAH PERANGKAT BARU\n\nMasukkan path perangkat blok (disk/partisi) yang KOSONG (contoh: /dev/sdd atau /dev/sde1):\n\nAWAS: Pastikan disk tersebut tidak memiliki data, karena akan diformat dan digabungkan ke ${mountPoint}!`);
            if(newDev) {
                consoleBox.innerText = `Menambahkan ${newDev.trim()} ke volume...`;
                // Parameter -f memaksa btrfs untuk menimpa partisi lama di disk target
                cockpit.spawn(["btrfs", "device", "add", "-f", newDev.trim(), mountPoint], { superuser: "require" })
                    .then(out => {
                        consoleBox.innerText = `Sukses menambahkan ${newDev.trim()}.\nSangat disarankan untuk menjalankan fitur 'Balance' setelah ini agar data tersebar merata.`;
                        fetchBtrfsData(); // Segarkan topologi
                    })
                    .catch(err => consoleBox.innerText = "Gagal menambahkan perangkat: " + err.message);
            }
        }
    }
});

// --- FUNGSI RESTORE/CLONE SNAPSHOT ---
function restoreSnapshot(mountPoint, snapPath, index) {
    let defaultTarget = snapPath.split("_snap_")[0];
    if (defaultTarget === snapPath) defaultTarget = snapPath + "_restored"; 
    
    const targetName = prompt(`🔄 RESTORE / CLONE SNAPSHOT\n\nSumber Data: ${snapPath}\n\nMasukkan nama subvolume target untuk menampung hasil restore ini:`, defaultTarget);
    if (!targetName) return;

    const fullSourcePath = mountPoint === "/" ? `/${snapPath}` : `${mountPoint}/${snapPath}`;
    const fullTargetPath = mountPoint === "/" ? `/${targetName}` : `${mountPoint}/${targetName}`;

    cockpit.spawn(["btrfs", "subvolume", "snapshot", fullSourcePath, fullTargetPath], { superuser: "require" })
        .then(() => {
            alert(`✅ Sukses! Data dari '${snapPath}' berhasil di-restore/di-clone.`);
            loadSubvolumes(mountPoint, index);
        })
        .catch(err => alert("❌ Gagal melakukan restore:\n" + err.message));
}

// --- FUNGSI SNAPSHOT DASAR ---
function takeSnapshot(mountPoint, subvolPath, index) {
    const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defaultName = subvolPath ? `${subvolPath.split("/").pop()}_snap_${dateStr}` : `root_snap_${dateStr}`;
    
    const snapName = prompt(`Masukkan nama untuk snapshot baru:\n(Sumber: ${subvolPath || "Root Volume"})`, defaultName);
    if (!snapName) return; 

    const fullSourcePath = subvolPath ? (mountPoint === "/" ? `/${subvolPath}` : `${mountPoint}/${subvolPath}`) : mountPoint;
    const destPath = mountPoint === "/" ? `/${snapName}` : `${mountPoint}/${snapName}`;

    cockpit.spawn(["btrfs", "subvolume", "snapshot", fullSourcePath, destPath], { superuser: "require" })
        .then(() => loadSubvolumes(mountPoint, index))
        .catch(err => alert("Gagal mengambil snapshot:\n" + err.message));
}

// --- FUNGSI SUBVOLUME DASAR ---
function loadSubvolumes(mountPoint, index) {
    const listContainer = document.getElementById(`subvol-list-${index}`);
    listContainer.innerHTML = "<p style='padding:10px;'>Memindai subvolume...</p>";
    cockpit.spawn(["btrfs", "subvolume", "list", mountPoint], { superuser: "require" })
        .then(function(output) {
            const lines = output.trim().split("\n");
            let html = "";
            lines.forEach(line => {
                if (line.trim() === "") return;
                const pathMatch = line.match(/path\s+(.+)$/);
                if (pathMatch) {
                    html += `
                        <div class="subvol-item">
                            <span>📁 <b class="btrfs-code">${pathMatch[1]}</b></span>
                            <div class="subvol-actions">
                                <button class="btn-restore btn-restore-subvol" data-mount="${mountPoint}" data-path="${pathMatch[1]}" data-index="${index}">🔄 Restore / Clone</button>
                                <button class="btn-snapshot btn-snapshot-subvol" data-mount="${mountPoint}" data-path="${pathMatch[1]}" data-index="${index}">📸 Snapshot</button>
                                <button class="btn-danger-sm btn-delete-subvol" data-mount="${mountPoint}" data-path="${pathMatch[1]}" data-index="${index}">Hapus</button>
                            </div>
                        </div>
                    `;
                }
            });
            listContainer.innerHTML = html === "" ? "<p style='padding:10px; color:gray;'>Belum ada subvolume kustom.</p>" : html;
        }).catch(err => listContainer.innerHTML = `<p style='padding:10px; color:red;'>Gagal: ${err.message}</p>`);
}

function createSubvolume(mountPoint, index) {
    const input = document.getElementById(`new-subvol-name-${index}`);
    const name = input.value.trim();
    if (!name) return alert("Nama subvolume tidak boleh kosong!");
    const fullPath = mountPoint === "/" ? `/${name}` : `${mountPoint}/${name}`;
    cockpit.spawn(["btrfs", "subvolume", "create", fullPath], { superuser: "require" })
        .then(() => { input.value = ""; loadSubvolumes(mountPoint, index); })
        .catch(err => alert("Gagal:\n" + err.message));
}

function deleteSubvolume(mountPoint, subvolPath, index) {
    if (!confirm(`Hapus subvolume "${subvolPath}"?`)) return;
    const fullPath = mountPoint === "/" ? `/${subvolPath}` : `${mountPoint}/${subvolPath}`;
    cockpit.spawn(["btrfs", "subvolume", "delete", fullPath], { superuser: "require" })
        .then(() => loadSubvolumes(mountPoint, index))
        .catch(err => alert("Gagal:\n" + err.message));
}

// ==========================================
// 4. LOGIKA PEMBUATAN RAID BTRFS BARU 
// ==========================================
const btnCreate = document.getElementById("btn-create-raid");
const btnCancel = document.getElementById("btn-cancel-format");
const btnExecute = document.getElementById("btn-execute-format");
const raidForm = document.getElementById("raid-form");
const statusText = document.getElementById("format-status");

btnCreate.addEventListener("click", function() {
    raidForm.classList.remove("hidden-element");
    statusText.innerText = "";
    statusText.classList.add("hidden-element");
    fetchAvailableDisks();
});
btnCancel.addEventListener("click", () => raidForm.classList.add("hidden-element"));

function extractEmptyDevices(devices) {
    let emptyDevs = [];
    devices.forEach(dev => {
        if (dev.children) emptyDevs = emptyDevs.concat(extractEmptyDevices(dev.children));
        else if (!dev.fstype && !dev.mountpoint) emptyDevs.push(dev);
    });
    return emptyDevs;
}

function fetchAvailableDisks() {
    const container = document.getElementById("available-disks");
    container.innerHTML = "Memindai perangkat blok secara mendalam...";
    cockpit.spawn(["lsblk", "-J", "-o", "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT"], { superuser: "require" })
        .then(data => {
            const rawDevices = JSON.parse(data).blockdevices || [];
            const safeDevices = extractEmptyDevices(rawDevices);
            let html = "";
            safeDevices.forEach(dev => {
                html += `<label class="disk-label-item"><input type="checkbox" name="target-disk" value="/dev/${dev.name}"> 
                         <span class="btrfs-code">/dev/${dev.name}</span> - Kapasitas: ${dev.size} (Unallocated & Safe)</label>`;
            });
            container.innerHTML = html === "" ? "<span style='color:#b30000; font-weight:bold;'>Tidak ada disk kosong yang aman.</span>" : html;
            btnExecute.disabled = html === "";
        }).catch(err => container.innerHTML = "Gagal memindai: " + err.message);
}

btnExecute.addEventListener("click", function() {
    const checkboxes = document.querySelectorAll('input[name="target-disk"]:checked');
    const selectedDisks = Array.from(checkboxes).map(cb => cb.value);
    const profile = document.getElementById("raid-profile").value;
    const label = document.getElementById("volume-label").value;

    if (selectedDisks.length === 0) return (statusText.innerText = "Error: Belum mencentang disk!", statusText.classList.remove("hidden-element"));
    
    let cmd = ["mkfs.btrfs", "-d", profile, "-m", profile, "-f"];
    if (label.trim() !== "") cmd.push("-L", label.trim());
    cmd = cmd.concat(selectedDisks);

    statusText.classList.remove("hidden-element");
    statusText.style.color = "#0066cc";
    statusText.innerText = "> " + cmd.join(" ") + "\nMemformat...";
    btnExecute.disabled = true;

    cockpit.spawn(cmd, { superuser: "require" })
        .then(() => {
            statusText.style.color = "green";
            statusText.innerText = "Sukses dibuat!";
            fetchBtrfsData();
            setTimeout(() => { raidForm.classList.add("hidden-element"); btnExecute.disabled = false; }, 3000);
        }).catch(err => { statusText.style.color = "#b30000"; statusText.innerText = "Gagal:\n" + err.message; btnExecute.disabled = false; });
});

document.getElementById("btn-refresh").addEventListener("click", fetchBtrfsData);
fetchBtrfsData();