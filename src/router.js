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
            case 'convert-raid': customSelect("Online RAID Conversion", "Select new profile:", [{v:"single",l:"Single"},{v:"raid0",l:"RAID 0"},{v:"raid1",l:"RAID 1"},{v:"raid10",l:"RAID 10"}], "Convert", (p) => { if(p) task(`Converting to ${p}...`, ["btrfs", "balance", "start", "-f", "-dconvert="+p, "-mconvert="+p, mnt], `Conversion to ${p} executed!`); }); break;
            case 'resize-vol': customPrompt("Resize Volume", "Target size (e.g. 'max', '+10G'):", "max", "Resize", (sz) => { if(sz) task(`Resizing to ${sz}...`, ["btrfs", "filesystem", "resize", sz, mnt], "Resized!", true); }); break;
            case 'scrub': customConfirm("Start Scrub", `Start data scrubbing on ${mnt}?`, "Start", () => task("Scrubbing...", ["btrfs", "scrub", "start", mnt], "Started. Click 'Check Scrub' for progress.")); break;
            case 'scrub-status': task("Fetching scrub status...", ["btrfs", "scrub", "status", mnt], "Scrub Status Output:"); break;
            case 'balance': customConfirm("Start Balance", `Rebalance blocks (50% usage) on ${mnt}?`, "Start", () => task("Balancing...", ["btrfs", "balance", "start", "-dusage=50", mnt], "Done!")); break;
            
            // PEMISAHAN FUNGSI DEFRAG
            case 'defrag': customConfirm("Defragment Volume", `Run recursive defragmentation on ${mnt}?`, "Start", () => task("Defragging...", ["btrfs", "filesystem", "defragment", "-r", mnt], "Defrag command sent to kernel.")); break;
            case 'defrag-zstd': customConfirm("Defrag & Compress", `Run recursive ZSTD defragmentation on ${mnt}?`, "Start", () => task("Defragging & Compressing...", ["btrfs", "filesystem", "defragment", "-r", "-czstd", mnt], "Defrag+ZSTD command sent to kernel.")); break;
            
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

// --- INIT STATIC LISTENERS ---
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
    cmd(c).then(() => { $("format-status").style.color = "var(--console-text)"; $("format-status").innerText = "Success! Volume Formatted."; App.fetch(); setTimeout(() => { $("raid-form").classList.add("hidden-element"); $("btn-execute-format").disabled = false; }, 3000); }).catch(e => { $("format-status").style.color = "var(--btn-danger)"; $("format-status").innerText = "Failed:\n" + e.message; $("btn-execute-format").disabled = false; });
});

App.fetch();