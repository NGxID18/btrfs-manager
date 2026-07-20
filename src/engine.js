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
      $("view-detail") &&
      !$("view-detail").classList.contains("hidden-element")
    )
      this.renderDetail(activeIdx);
    this.fetchDynamicMetrics();
  },

  /* STREAMING_CHUNK:Fetching Live Metrics and Snapper Configuration... */
  async fetchDynamicMetrics() {
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
                        <div class="flex-wrap-gap">
                            <button class="btn btn-primary btn-sm btn-action" data-action="scrub" data-mount="${v.mountPoint}">Scrub</button> 
                            <button class="btn btn-secondary btn-sm btn-action" data-action="scrub-status" data-mount="${v.mountPoint}">Check Scrub</button> 
                            <button class="btn btn-secondary btn-sm btn-action" data-action="balance" data-mount="${v.mountPoint}">Balance (50%)</button> 
                            <button class="btn btn-secondary btn-sm btn-action" data-action="defrag" data-mount="${v.mountPoint}">Defrag Only</button> 
                        </div>
                        <div id="maint-console-${v.mountPoint.replace(/\//g, "-")}" class="status-console hidden-element"></div>
                    </div>`
                        : `<div class="warning-box"><p class="text-warning mb-5">Volume Locked</p><p class="text-muted">Please mount this volume via Cockpit's native Storage page to unlock subvolume and kernel maintenance tasks.</p></div>`
                    }
                </div>
                <div class="detail-right-col animated-view">
                    <div class="btrfs-card h-100-col">
                        <h4 class="section-title">Subvolumes & Snapshots</h4>
                        ${
                          v.mountPoint
                            ? `<div class="flex-wrap-gap mb-15">
                            <input type="text" id="new-subvol-${v.idx}" placeholder="New subvolume name..." class="form-input flex-grow">
                            <button class="btn btn-primary btn-sm btn-action" data-action="subvol-ops" data-op="create" data-mount="${v.mountPoint}" data-index="${v.idx}">Create</button> 
                            <button class="btn btn-secondary btn-sm btn-action" data-action="subvol-ops" data-op="snap-root" data-mount="${v.mountPoint}">Snap Root</button>
                            <button class="btn btn-secondary btn-sm btn-action" data-action="subvol-ops" data-op="auto-snap" data-path="" data-mount="${v.mountPoint}">Auto-Snap</button>
                            <button class="btn btn-danger btn-sm btn-action" data-action="subvol-ops" data-op="purge-snaps" data-mount="${v.mountPoint}">Purge Old</button>
                        </div>
                        <div id="subvol-list-${v.idx}" class="subvol-list-full"><p class="p-15-muted">Loading subvolumes...</p></div>`
                            : '<p class="text-warning">Mount pool filesystem to unlock subvolume tree operations.</p>'
                        }
                    </div>
                </div>
            </div>`;
    if (v.mountPoint) this.fetchSubvols(v.mountPoint, v.idx);
  },

  /* STREAMING_CHUNK:Fetching Live BTRFS Subvolumes via Subvolid 5... */
  async fetchSubvols(mount, idx) {
    if (!$(`subvol-list-${idx}`)) return;
    try {
      // FIX: Menggunakan '$TMP' pada perintah btrfs subvolume list
      // agar BTRFS mengembalikan absolute path yang sempurna (contoh: @/var/lib/machines)
      const script = `
mnt="$1"
DEV=$(findmnt -n -o SOURCE -T "$mnt" | head -n 1 | cut -d'[' -f1)
if [ -z "$DEV" ]; then DEV=$(df "$mnt" | awk 'NR==2 {print $1}'); fi
TMP=$(mktemp -d)

mount -t btrfs -o subvolid=5 "$DEV" "$TMP" 2>/dev/null

btrfs subvolume list "$TMP" | while read -r line; do
    id=$(echo "$line" | awk '{print $2}')
    sub_path=$(echo "$line" | sed -n 's/.*path \\(.*\\)/\\1/p')
    
    ctime=$(btrfs subvolume show "$TMP/$sub_path" 2>/dev/null | grep -i "Creation time:" | sed -e 's/^[[:space:]]*Creation time:[[:space:]]*//' | cut -d' ' -f1,2)
    if [ -z "$ctime" ] || [ "$ctime" = "-" ]; then ctime="Unknown Time"; fi
    
    attr=$(lsattr -d "$TMP/$sub_path" 2>/dev/null | awk '{print $1}')
    nocow="false"
    if echo "$attr" | grep -q "C"; then nocow="true"; fi

    echo "$id|$sub_path|$nocow|$ctime"
done

umount "$TMP" 2>/dev/null
rmdir "$TMP" 2>/dev/null
            `;
      const out = await cmd(["sh", "-c", script, "--", mount]);
      const html = out
        .trim()
        .split("\n")
        .filter((l) => l.trim())
        .map((line) => {
          const parts = line.split("|");
          if (parts.length < 4) return "";
          const id = parts[0];
          const path = parts[1];
          const nocow = parts[2] === "true";
          const ctime = parts.slice(3).join("|");

          const cowBadge = nocow
            ? `<span style="color: #d69e2e; border: 1px solid #d69e2e; border-radius: 3px; padding: 0 4px; margin-left: 6px; font-weight: bold; font-size: 10px; background: rgba(214, 158, 46, 0.1);">CoW Disabled</span>`
            : "";

          return `<div class="subvol-item animated-view">
                    <div class="subvol-info">
                        <span class="btrfs-code">/${path}</span>
                        <span class="text-primary mt-5" style="font-size: 13px; font-weight: 600;">Created: ${ctime}</span>
                        <span class="text-muted" style="font-size: 12px; margin-top: 2px;">ID: ${id} ${cowBadge}</span>
                    </div>
                    <button class="btn btn-secondary btn-sm btn-action" data-action="manage-subvol" data-mount="${mount}" data-path="${path}" data-subid="${id}" data-index="${idx}" data-nocow="${nocow}">Manage</button>
                </div>`;
        })
        .join("");

      $(`subvol-list-${idx}`).innerHTML =
        html ||
        "<p class='mt-15 text-muted'>No custom subvolumes found inside this pool root.</p>";
    } catch (e) {
      $(`subvol-list-${idx}`).innerHTML =
        `<p class='text-danger mt-15'>Load failed: ${e.message}</p>`;
    }
  },
};
