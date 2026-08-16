/* STREAMING_CHUNK:Initializing App Engine... */
window.App = {
  vols: [],
  hw: {},
  mnt: {},
  async fetch() {
    if (
      $("view-master") &&
      !$("view-master").classList.contains("hidden-element") &&
      $("disk-container")
    ) {
      $("disk-container").innerHTML =
        "<p class='loading-text'>Scanning BTRFS & Hardware Topologies...</p>";
    }
    try {
      const [btrfsOut, mntOut, lsblkOut] = await Promise.all([
        cmd(["btrfs", "filesystem", "show"]),
        cmd(["findmnt", "-A", "-J", "-t", "btrfs"]).catch(() => "{}"),
        cmd(["lsblk", "-J", "-o", "PATH,MODEL,VENDOR,TYPE"]).catch(() => "{}"),
      ]);

      this.mnt = {};
      const walk = (nodes) =>
        nodes.forEach((n) => {
          if (n.source && n.target) {
            const baseDev = n.source.split("[")[0];
            if (
              !this.mnt[baseDev] ||
              n.target.length < this.mnt[baseDev].length
            ) {
              this.mnt[baseDev] = n.target;
            }
            this.mnt[n.source] = n.target;
          }
          if (n.children) walk(n.children);
        });
      walk(JSON.parse(mntOut).filesystems || []);

      this.hw = {};
      const parseHw = (nodes, parentModel) =>
        nodes.forEach((n) => {
          let model =
            [n.vendor, n.model].filter(Boolean).join(" ").trim() || parentModel;
          if (n.path) this.hw[n.path] = model || "Generic Storage";
          if (n.children) parseHw(n.children, model);
        });
      parseHw(JSON.parse(lsblkOut).blockdevices || []);

      this.parseBtrfs(btrfsOut);
    } catch (err) {
      if ($("disk-container"))
        $("disk-container").innerHTML =
          `<p class="text-danger mt-15">Critical Fetch Error: ${err.message}</p>`;
    }
  },

  /* STREAMING_CHUNK:Parsing BTRFS Pool Data... */
  parseBtrfs(out) {
    this.vols = out
      .split(/Label:\s+/i)
      .filter((b) => b.trim() !== "")
      .map((block, idx) => {
        const mLabel = block.match(
          /^(?:'([^']*)'|(\S+))?\s+uuid:\s+([a-f0-9\-]+)/i,
        );
        const uuid = mLabel ? mLabel[3] : "Unknown";
        const mPath = block.match(/path\s+(\/dev\/\S+)/i);
        const rootPath = mPath ? mPath[1] : "";
        const mountPoint =
          this.mnt[rootPath] ||
          this.mnt[`UUID=${uuid}`] ||
          this.mnt[rootPath + "1"] ||
          this.mnt[rootPath + "2"] ||
          "";

        let devs = [];
        const lines = block.split("\n");
        lines.forEach((line) => {
          if (
            line.match(/devid/i) &&
            line.match(/size/i) &&
            line.match(/path/i)
          ) {
            const idMatch = line.match(/devid\s+(\d+)/i);
            const sizeMatch = line.match(/size\s+([0-9.]+\s?[a-zA-Z]+)/i);
            const pathMatch = line.match(/path\s+(\S+)/i);
            if (idMatch && sizeMatch && pathMatch) {
              devs.push({
                id: idMatch[1],
                size: sizeMatch[1],
                path: pathMatch[1],
              });
            }
          }
        });

        const rawSize = formatSize(
          devs.reduce((sum, d) => sum + parseSize(d.size), 0),
        );
        const hwList =
          [...new Set(devs.map((d) => this.hw[d.path]))]
            .filter(Boolean)
            .join(" & ") || "Unknown Device Hardware";

        return {
          idx,
          label:
            mLabel && (mLabel[1] || mLabel[2]) !== "none"
              ? mLabel[1] || mLabel[2]
              : "System/Root (No Label)",
          uuid,
          mountPoint,
          devs,
          rawSize,
          hwList,
          raid: "Loading...",
          usable: "Loading...",
          snapStatus: "Loading...",
        };
      });

    this.renderMaster();
    const activeIdx = $("detail-container")
      ? $("detail-container").getAttribute("data-active-index")
      : null;
    if (
      activeIdx !== null &&
      activeIdx !== "" &&
      $("view-detail") &&
      !$("view-detail").classList.contains("hidden-element")
    ) {
      const v = this.vols.find((vol) => vol.idx == activeIdx);
      if (v) {
        this.updateUI(v);
      } else {
        $("view-detail").classList.add("hidden-element");
        $("view-master").classList.remove("hidden-element");
        $("detail-container").setAttribute("data-active-index", "");
      }
    }
    this.fetchDynamicMetrics();
  },

  orphanedSnaps: [],
  async checkOrphanedSnapshots() {
    try {
      const script = `
if command -v snapper >/dev/null 2>&1; then
    snapper list-configs 2>/dev/null | awk 'NR>2 {print $1 "|" $3}' | while IFS="|" read -r cfg subvol; do
        [ -z "$cfg" ] && continue
        [ "$cfg" = "Config" ] && continue
        is_orphan=0
        if [ -z "$subvol" ] || [ ! -d "$subvol" ]; then
            is_orphan=1
        elif ! btrfs subvolume show "$subvol" >/dev/null 2>&1; then
            tgt=$(findmnt -n -o TARGET -T "$subvol" 2>/dev/null)
            if [ "$tgt" != "$subvol" ] && [ "$subvol" != "/" ]; then
                is_orphan=1
            elif ! findmnt -n -t btrfs -T "$subvol" >/dev/null 2>&1; then
                is_orphan=1
            fi
        fi
        if [ "$is_orphan" -eq 1 ]; then
            echo "$cfg|$subvol"
        fi
    done
fi
`;
      const out = await cmd(["sh", "-c", script]);
      this.orphanedSnaps = out
        .trim()
        .split("\n")
        .filter((l) => l.trim().includes("|"))
        .map((l) => {
          const [cfg, subvol] = l.split("|");
          return { cfg: cfg.trim(), subvol: (subvol || "").trim() };
        });
    } catch (e) {
      this.orphanedSnaps = [];
    }
    this.renderOrphanBanner();
  },

  renderOrphanBanner() {
    const el = $("orphan-snap-container");
    if (!el) return;
    if (!this.orphanedSnaps || this.orphanedSnaps.length === 0) {
      el.classList.add("hidden-element");
      el.innerHTML = "";
      return;
    }
    const count = this.orphanedSnaps.length;
    const itemsHtml = this.orphanedSnaps
      .map(
        (o) =>
          `<li><strong>${o.cfg}</strong> (target mount: <span class="btrfs-code">${o.subvol || "Missing"}</span>)</li>`,
      )
      .join("");
    el.innerHTML = `
      <div class="orphan-snap-content">
        <div class="orphan-snap-title">
          <span>⚠️ Broken / Orphaned Snapshot Schedules Detected</span>
          <span class="orphan-badge">${count} Stale ${count === 1 ? "Schedule" : "Schedules"}</span>
        </div>
        <div class="orphan-snap-desc">
          The following Snapper snapshot schedules point to filesystems that were deleted or formatted outside BTRFS Manager. When the hourly snapshot timer runs, this causes snapshot errors that <strong>can prevent snapshotting other healthy volumes</strong> (like root or home):
        </div>
        <ul class="danger-list orphan-item-list">
          ${itemsHtml}
        </ul>
      </div>
      <div class="orphan-snap-actions">
        <button class="btn btn-danger btn-sm btn-action" data-action="clean-orphaned-snaps">Clean Broken Schedules Now</button>
      </div>
    `;
    el.classList.remove("hidden-element");
  },

  /* STREAMING_CHUNK:Fetching Live Metrics and Snapper Configuration... */
  async fetchDynamicMetrics() {
    await this.checkOrphanedSnapshots();
    for (let v of this.vols) {
      if (!v.mountPoint) {
        v.raid = "Mount required";
        v.usable = "Locked (Not Mounted)";
        v.snapStatus = "Locked";
        this.updateUI(v);
        continue;
      }
      try {
        const snapScript = `
MNT="$1"
STATUS="Not Configured"
if command -v snapper >/dev/null 2>&1; then
    CFG=$(snapper list-configs 2>/dev/null | awk -v mnt="$MNT" '$3 == mnt || $3 == mnt"/" {print $1; exit}')
    if [ -n "$CFG" ] && [ "$CFG" != "Config" ]; then
        IS_ON=$(snapper -c "$CFG" get-config 2>/dev/null | awk '$1=="TIMELINE_CREATE"{print $3}')
        if [ "$IS_ON" = "yes" ]; then
            H=$(snapper -c "$CFG" get-config 2>/dev/null | awk '$1=="TIMELINE_LIMIT_HOURLY"{print $3}')
            D=$(snapper -c "$CFG" get-config 2>/dev/null | awk '$1=="TIMELINE_LIMIT_DAILY"{print $3}')
            W=$(snapper -c "$CFG" get-config 2>/dev/null | awk '$1=="TIMELINE_LIMIT_WEEKLY"{print $3}')
            M=$(snapper -c "$CFG" get-config 2>/dev/null | awk '$1=="TIMELINE_LIMIT_MONTHLY"{print $3}')
            if [ "$H" != "0" ] && [ -n "$H" ]; then STATUS="Hourly (Max $H Snaps via Snapper)"
            elif [ "$D" != "0" ] && [ -n "$D" ]; then STATUS="Daily (Max $D Snaps via Snapper)"
            elif [ "$W" != "0" ] && [ -n "$W" ]; then STATUS="Weekly (Max $W Snaps via Snapper)"
            elif [ "$M" != "0" ] && [ -n "$M" ]; then STATUS="Monthly (Max $M Snaps via Snapper)"
            else STATUS="Enabled (via Snapper)"; fi
        fi
    fi
fi
if [ "$STATUS" = "Not Configured" ]; then
    CRON=$(grep -l "btrfs subvolume snapshot.*$MNT" /etc/cron.hourly/* /etc/cron.daily/* /etc/cron.weekly/* /etc/cron.monthly/* 2>/dev/null | head -n 1)
    if [ -n "$CRON" ]; then
        FRQ=$(echo "$CRON" | awk -F'/' '{print $3}' | sed 's/cron\\.//' | awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }')
        LIM=$(grep "tail -n" "$CRON" | sed -E 's/.*tail -n \\+([0-9]+).*/\\1/')
        if [ -n "$LIM" ]; then
            STATUS="$FRQ (Max $((LIM - 1)) Snaps via Native Cron)"
        else
            STATUS="$FRQ (via Native Cron)"
        fi
    fi
fi
echo "$STATUS"
                `;

        const [dfOut, hOut, snapOut] = await Promise.all([
          cmd(["btrfs", "filesystem", "df", v.mountPoint]),
          cmd(["df", "-B1", v.mountPoint]),
          cmd(["sh", "-c", snapScript, "--", v.mountPoint]).catch(
            () => "Not Configured",
          ),
        ]);

        const dM = dfOut.match(/Data,\s*(.*?):/i),
          mM = dfOut.match(/Metadata,\s*(.*?):/i);
        v.raid =
          (dM
            ? `<span class="btrfs-code">Data: ${dM[1].toUpperCase()}</span>`
            : "") +
          (mM && dM && mM[1] !== dM[1]
            ? ` <span class="btrfs-code text-muted">Meta: ${mM[1].toUpperCase()}</span>`
            : "");

        const dfLines = hOut.trim().split("\n");
        v.usable =
          dfLines.length > 1
            ? formatSize(parseInt(dfLines[1].trim().split(/\s+/)[1], 10))
            : "Unknown";

        v.snapStatus = snapOut.trim() || "Not Configured";
      } catch (e) {
        v.raid = "Error Reading Profile";
        v.usable = "Error";
        v.snapStatus = "Error";
      }
      this.updateUI(v);
    }
  },

  /* STREAMING_CHUNK:Updating UI Nodes... */
  updateUI(v) {
    if ($(`master-usable-${v.idx}`)) {
      $(`master-usable-${v.idx}`).innerHTML = v.usable;
      if ($(`master-snap-${v.idx}`))
        $(`master-snap-${v.idx}`).innerHTML = v.snapStatus;
    }
    if ($(`raid-display-${v.idx}`)) {
      $(`raid-display-${v.idx}`).innerHTML = v.raid;
      $(`usable-display-${v.idx}`).innerHTML = v.usable;
      if ($(`snap-display-${v.idx}`))
        $(`snap-display-${v.idx}`).innerHTML = v.snapStatus;
    }
  },

  /* STREAMING_CHUNK:Rendering Dashboard Master View... */
  renderMaster() {
    this.renderOrphanBanner();
    if (!$("disk-container")) return;
    $("disk-container").innerHTML = this.vols.length
      ? this.vols
          .map(
            (v) => `
            <div class="btrfs-card hoverable animated-view h-100-col">
                <h3>${v.label}</h3>
                <p class="mb-5"><b>UUID:</b> <span class="btrfs-code">${v.uuid}</span></p>
                <p class="mb-5"><b>Hardware:</b> <span class="text-muted">${v.hwList}</span></p>
                <p class="mb-5"><b>Raw Capacity:</b> ${v.rawSize}</p>
                <p class="mb-5"><b>Usable Space:</b> <span id="master-usable-${v.idx}">${v.usable}</span></p>
                <p class="mb-5"><b>Auto-Snapshot:</b> <span id="master-snap-${v.idx}" class="text-primary fw-bold">${v.snapStatus}</span></p>
                <p class="mb-15"><b>Mount Status:</b> ${v.mountPoint ? `<span class="text-success">${v.mountPoint}</span>` : `<span class="text-warning">Not Mounted</span> <span class="text-muted text-sm">(Mount via Storage menu)</span>`}</p>
                <button class="btn btn-secondary w-100 mt-auto btn-action" data-action="open-detail" data-index="${v.idx}">Manage Volume</button>
            </div>`,
          )
          .join("")
      : "<p class='mt-15'>No active BTRFS storage pools detected.</p>";
  },

  /* STREAMING_CHUNK:Rendering Subvolume Details... */
  renderDetail(idx) {
    if (!$("detail-container")) return;
    const v = this.vols.find((vol) => vol.idx == idx);
    if (!v) return;
    $("detail-container").setAttribute("data-active-index", idx);
    const devHtml = v.devs
      .map(
        (d) =>
          `<div class="topo-item"><span><span class="btrfs-code">${d.path}</span> <span class="text-muted">(ID: ${d.id} | Size: ${d.size})</span></span> ${v.mountPoint ? `<button class="btn btn-danger btn-sm btn-action" data-action="remove-dev" data-mount="${v.mountPoint}" data-devpath="${d.path}">Remove</button>` : ""}</div>`,
      )
      .join("");

    const isRoot =
      v.mountPoint === "/" ||
      v.label.toLowerCase().includes("root") ||
      (this.mnt["/"] && v.devs.some((d) => this.mnt["/"] && d.path.includes(this.mnt["/"])));

    const boxSafe = (v.mountPoint || "root").replace(/[^a-zA-Z0-9]/g, "-");

    $("detail-container").innerHTML = `
            <h2 class="animated-view mb-25">${v.label}</h2>
            <div class="detail-layout-grid">
                <div class="detail-left-col animated-view">
                    <div class="btrfs-card">
                        <h4 class="section-title">System Information & Topology</h4>
                        <p class="mb-8"><b>UUID:</b> <span class="btrfs-code">${v.uuid}</span></p>
                        <p class="mb-8"><b>Hardware Infrastructure:</b> <span class="text-primary fw-bold">${v.hwList}</span></p>
                        <p class="mb-8"><b>Raw Capacity:</b> ${v.rawSize} <span class="text-muted">(Physical Pool Combined)</span></p>
                        <p class="mb-8"><b>Usable Space:</b> <span id="usable-display-${v.idx}" class="fw-bold">${v.usable}</span></p>
                        <p class="mb-8"><b>Active Profile:</b> <span id="raid-display-${v.idx}">${v.raid}</span></p>
                        <p class="mb-8"><b>Auto-Snapshot:</b> <span id="snap-display-${v.idx}" class="text-primary fw-bold">${v.snapStatus}</span></p>
                        <p class="mb-25"><b>Mount Status:</b> ${v.mountPoint ? `<span class="text-success">${v.mountPoint}</span>` : `<span class="text-warning">Not Mounted (Locked)</span>`}</p>
                        <p class="section-title mt-15">Physical Device Topology</p>
                        <div>${devHtml}</div>
                        ${v.mountPoint ? `<div class="advanced-topo-actions"><button class="btn btn-primary btn-sm btn-action" data-action="add-dev-modal" data-mount="${v.mountPoint}">Add Disk</button> <button class="btn btn-secondary btn-sm btn-action" data-action="convert-raid" data-mount="${v.mountPoint}">Convert RAID Profile</button> <button class="btn btn-secondary btn-sm btn-action" data-action="resize-vol" data-mount="${v.mountPoint}">Resize Volume</button></div>` : ""}
                    </div>
                    ${
                      v.mountPoint
                        ? `<div class="btrfs-card">
                        <h4 class="section-title">Advanced Maintenance & Optimization</h4>
                        <div class="flex-wrap-gap mb-15">
                            <button class="btn btn-primary btn-sm btn-action" id="btn-scrub-${boxSafe}" data-action="scrub" data-mount="${v.mountPoint}">Scrub</button> 
                            <button class="btn btn-secondary btn-sm btn-action" id="btn-balance-${boxSafe}" data-action="balance" data-mount="${v.mountPoint}">Balance</button> 
                            <button class="btn btn-secondary btn-sm btn-action" id="btn-defrag-${boxSafe}" data-action="defrag" data-mount="${v.mountPoint}">Defrag</button> 
                        </div>
                        <div class="terminal-window">
                            <div class="terminal-header">
                                <div class="terminal-controls">
                                    <span class="term-dot term-dot-red"></span>
                                    <span class="term-dot term-dot-yellow"></span>
                                    <span class="term-dot term-dot-green"></span>
                                </div>
                                <div class="terminal-title">btrfs@console:${v.mountPoint}#</div>
                                <div class="terminal-header-actions">
                                    <span id="term-status-${boxSafe}" class="term-status-badge">Idle</span>
                                    <button class="term-clear-btn btn-action" data-action="clear-terminal" data-box="${boxSafe}">Clear</button>
                                </div>
                            </div>
                            <div id="maint-console-${boxSafe}" class="terminal-body"><span class="term-muted">Console ready. Click any maintenance button above to execute live tasks.</span></div>
                        </div>
                    </div>`
                        : `<div class="warning-box"><p class="text-warning mb-5">Volume Locked</p><p class="text-muted">Please mount this volume via Cockpit's native Storage page to unlock subvolume and kernel maintenance tasks.</p></div>`
                    }
                    <div class="btrfs-card danger-card">
                        <h4 class="section-title">Danger Zone</h4>
                        <p class="danger-desc">Permanently remove this volume. This action will unmount the filesystem, purge all associated Snapper & cron snapshot configurations, and wipe all disk signatures.</p>
                        ${
                          isRoot
                            ? `<div class="warning-box"><p class="text-warning mb-0"><b>Protected System Volume:</b> This pool contains the operating system root filesystem (<code>/</code>) and cannot be destroyed.</p></div>`
                            : `<button class="btn btn-danger btn-sm btn-action" data-action="destroy-vol-modal" data-mount="${v.mountPoint || ""}" data-uuid="${v.uuid}" data-label="${v.label}" data-devs="${v.devs.map((d) => d.path).join(" ")}" data-index="${v.idx}">Destroy Volume & Wipe Disks</button>`
                        }
                    </div>
                </div>
                <div class="detail-right-col animated-view">
                    <!-- Kotak Atas: Subvolumes Management -->
                    <div class="btrfs-card mb-20">
                        <h4 class="section-title">Subvolumes Management</h4>
                        ${
                          v.mountPoint
                            ? `<div class="flex-wrap-gap mb-15">
                            <input type="text" id="new-subvol-${v.idx}" placeholder="New subvolume name..." class="form-input flex-grow">
                            <button class="btn btn-primary btn-sm btn-action" data-action="subvol-ops" data-op="create" data-mount="${v.mountPoint}" data-index="${v.idx}">Create Subvolume</button> 
                        </div>
                        <div id="subvol-list-${v.idx}" class="subvol-list-full"><p class="p-15-muted">Loading subvolumes...</p></div>`
                            : '<p class="text-warning">Mount pool filesystem to unlock subvolume operations.</p>'
                        }
                    </div>

                    <!-- Kotak Bawah: Snapshots & Rollback Management -->
                    <div class="btrfs-card">
                        <h4 class="section-title">Snapshots & Rollback Management</h4>
                        ${
                          v.mountPoint
                            ? `<div class="flex-wrap-gap mb-15">
                            <button class="btn btn-secondary btn-sm btn-action" data-action="subvol-ops" data-op="snap-root" data-mount="${v.mountPoint}">Snapshot (${v.mountPoint === "/" ? "Root" : v.mountPoint})</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="subvol-ops" data-op="auto-snap" data-path="" data-mount="${v.mountPoint}">Auto-Snap (Snapper)</button>
                            <button class="btn btn-danger btn-sm btn-action" data-action="subvol-ops" data-op="purge-snaps" data-mount="${v.mountPoint}">Purge Old</button>
                        </div>
                        <div id="snapshot-list-${v.idx}" class="subvol-list-full"><p class="p-15-muted">Loading snapshots...</p></div>`
                            : '<p class="text-warning">Mount pool filesystem to unlock snapshot operations.</p>'
                        }
                    </div>
                </div>
            </div>`;
    if (v.mountPoint) this.fetchSubvols(v.mountPoint, v.idx);
  },

  /* STREAMING_CHUNK:Fetching Live BTRFS Subvolumes & Snapshots... */
  async fetchSubvols(mount, idx) {
    if (!$(`subvol-list-${idx}`) && !$(`snapshot-list-${idx}`)) return;
    try {
      const script = `
mnt="$1"
# Robust device resolution for all distros (Arch, Debian/Ubuntu, Fedora/RHEL)
DEV=$(findmnt -n -o SOURCE -T "$mnt" 2>/dev/null | sed 's/\\[.*\\]//' | head -n 1)
if [ -z "$DEV" ]; then DEV=$(df "$mnt" 2>/dev/null | awk 'NR==2 {print $1}'); fi
if echo "$DEV" | grep -q "^UUID="; then DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1); fi
if echo "$DEV" | grep -q "^LABEL="; then DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1); fi

TMP=$(mktemp -d)
IS_MOUNTED=0

if [ -b "$DEV" ] || [ -n "$DEV" ]; then
    if mount -t btrfs -o subvolid=5 "$DEV" "$TMP" 2>/dev/null; then
        IS_MOUNTED=1
    elif mount -t btrfs -o subvolid=5,context="system_u:object_r:tmp_t:s0" "$DEV" "$TMP" 2>/dev/null; then
        IS_MOUNTED=1
    fi
fi

SCAN_DIR="$mnt"
[ "$IS_MOUNTED" -eq 1 ] && SCAN_DIR="$TMP"

btrfs subvolume list "$SCAN_DIR" 2>/dev/null | while read -r line; do
    [ -z "$line" ] && continue
    id=$(echo "$line" | awk '{print $2}')
    sub_path=$(echo "$line" | sed -n 's/.*path \\(.*\\)/\\1/p')
    [ -z "$id" ] && continue
    
    TARGET_DIR=""
    if [ "$IS_MOUNTED" -eq 1 ] && [ -e "$TMP/$sub_path" ]; then
        TARGET_DIR="$TMP/$sub_path"
    elif [ -e "$mnt/$sub_path" ]; then
        TARGET_DIR="$mnt/$sub_path"
    elif [ -e "/$sub_path" ]; then
        TARGET_DIR="/$sub_path"
    else
        FOUND_MNT=$(findmnt -n -o TARGET -t btrfs --source "*[$sub_path]" 2>/dev/null | head -n 1)
        [ -n "$FOUND_MNT" ] && TARGET_DIR="$FOUND_MNT"
    fi
    
    ctime="Unknown Time"
    if [ -n "$TARGET_DIR" ]; then
        ctime=$(btrfs subvolume show "$TARGET_DIR" 2>/dev/null | grep -i "Creation time:" | sed -e 's/^[[:space:]]*Creation time:[[:space:]]*//' | cut -d' ' -f1,2)
    fi
    [ -z "$ctime" ] || [ "$ctime" = "-" ] && ctime="Active Subvolume"
    
    nocow="false"
    if [ -n "$TARGET_DIR" ]; then
        attr=$(lsattr -d "$TARGET_DIR" 2>/dev/null | awk '{print $1}')
        if echo "$attr" | grep -q "C"; then nocow="true"; fi
    fi

    MOUNT_PT=$(findmnt -n -l -o TARGET,SOURCE -t btrfs 2>/dev/null | grep -v "^/tmp" | while read -r t_m s_m; do
        s_in=$(echo "$s_m" | sed -n "s/.*\\[\\/*\\(.*\\)\\]/\\1/p")
        if [ -n "$s_in" ] && [ "$s_in" = "$sub_path" ]; then
            echo "$t_m"
            break
        fi
    done)
    
    IN_FSTAB="false"
    if grep -qs -E "subvol=(/|@)?$sub_path\\b" /etc/fstab; then
        IN_FSTAB="true"
    fi

    echo "$id|$sub_path|$nocow|$ctime|$MOUNT_PT|$IN_FSTAB"
done

if [ "$IS_MOUNTED" -eq 1 ]; then
    umount "$TMP" 2>/dev/null || umount -l "$TMP" 2>/dev/null || true
fi
rmdir "$TMP" 2>/dev/null || true
`;
      const out = await cmd(["sh", "-c", script, "--", mount]);
      let subvolsHtml = "";
      let snapshotsHtml = "";

      out
        .trim()
        .split("\n")
        .filter((l) => l.trim())
        .forEach((line) => {
          const parts = line.split("|");
          if (parts.length < 4) return;
          const id = parts[0];
          const path = parts[1];
          const nocow = parts[2] === "true";
          const ctime = parts[3];
          const mountPt = parts[4] || "";
          const inFstab = parts[5] === "true";

          const isRootSubvol =
            mountPt === "/" ||
            (mount === "/" && (path === "@" || path === "" || path === "root" || path === "@root")) ||
            path === "@";

          const isProtected = isRootSubvol || Boolean(mountPt) || inFstab;

          const isSnapshot =
            path.includes(".snapshots") ||
            path.includes("snapshot") ||
            path.includes("_snap_") ||
            path.includes("snap-");

          if (isSnapshot) {
            snapshotsHtml += `<div class="subvol-item animated-view">
                <div class="subvol-info">
                    <span class="btrfs-code">/${path}</span>
                    <span class="text-primary mt-5" style="font-size: 13px; font-weight: 600;">Created: ${ctime}</span>
                    <span class="text-muted" style="font-size: 12px; margin-top: 2px;">ID: ${id} <span style="color: #9f7aea; border: 1px solid #9f7aea; border-radius: 3px; padding: 0 4px; margin-left: 6px; font-weight: bold; font-size: 10px; background: rgba(159, 122, 234, 0.15);">Snapshot</span></span>
                </div>
                <div class="flex-wrap-gap" style="align-items: center;">
                    <button class="btn btn-primary btn-sm btn-action" data-action="subvol-ops" data-op="default" data-mount="${mount}" data-path="${path}" data-subid="${id}" data-index="${idx}">Set as Default Mount</button>
                    <button class="btn btn-danger btn-sm btn-action" data-action="subvol-ops" data-op="del" data-mount="${mount}" data-path="${path}" data-subid="${id}" data-index="${idx}">Delete</button>
                </div>
            </div>`;
          } else {
            let badgeHtml = "";
            if (isRootSubvol) {
              badgeHtml = `<span style="color: #48bb78; border: 1px solid #48bb78; border-radius: 3px; padding: 0 4px; margin-left: 6px; font-weight: bold; font-size: 10px; background: rgba(72, 187, 120, 0.15);">OS Root (/)</span>`;
            } else if (mountPt) {
              badgeHtml = `<span style="color: #63b3ed; border: 1px solid #63b3ed; border-radius: 3px; padding: 0 4px; margin-left: 6px; font-weight: bold; font-size: 10px; background: rgba(66, 153, 225, 0.15);">Mounted: ${mountPt}</span>`;
            } else if (inFstab) {
              badgeHtml = `<span style="color: #d69e2e; border: 1px solid #d69e2e; border-radius: 3px; padding: 0 4px; margin-left: 6px; font-weight: bold; font-size: 10px; background: rgba(214, 158, 46, 0.15);">In /etc/fstab</span>`;
            }

            const cowBadge = nocow
              ? `<span style="color: #d69e2e; border: 1px solid #d69e2e; border-radius: 3px; padding: 0 4px; margin-left: 6px; font-weight: bold; font-size: 10px; background: rgba(214, 158, 46, 0.1);">CoW Disabled</span>`
              : "";

            subvolsHtml += `<div class="subvol-item animated-view">
                <div class="subvol-info">
                    <span class="btrfs-code">/${path}</span>
                    <span class="text-primary mt-5" style="font-size: 13px; font-weight: 600;">Created: ${ctime}</span>
                    <span class="text-muted" style="font-size: 12px; margin-top: 2px;">ID: ${id} ${badgeHtml} ${cowBadge}</span>
                </div>
                <div class="flex-wrap-gap" style="align-items: center;">
                    <button class="btn btn-secondary btn-sm btn-action" data-action="subvol-ops" data-op="${nocow ? 'enable-cow' : 'disable-cow'}" data-mount="${mount}" data-path="${path}" data-index="${idx}">
                        ${nocow ? 'Enable CoW (+C)' : 'Disable CoW (No_COW)'}
                    </button>
                    ${
                      !isProtected
                        ? `<button class="btn btn-danger btn-sm btn-action" data-action="subvol-ops" data-op="del" data-mount="${mount}" data-path="${path}" data-subid="${id}" data-index="${idx}">Delete</button>`
                        : ""
                    }
                </div>
            </div>`;
          }
        });

      if ($(`subvol-list-${idx}`)) {
        $(`subvol-list-${idx}`).innerHTML =
          subvolsHtml ||
          "<p class='p-15-muted'>No active user subvolumes found inside this pool root.</p>";
      }
      if ($(`snapshot-list-${idx}`)) {
        $(`snapshot-list-${idx}`).innerHTML =
          snapshotsHtml ||
          "<p class='p-15-muted'>No snapshots created yet for this volume.</p>";
      }
    } catch (e) {
      if ($(`subvol-list-${idx}`)) {
        $(`subvol-list-${idx}`).innerHTML =
          `<p class='text-danger mt-15'>Load failed: ${e.message}</p>`;
      }
    }
  },
};
