/* STREAMING_CHUNK:Initializing App Engine... */
window.App = {
  vols: [],
  hw: {},
  mnt: {},
  hasSnapper: false,
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
      const [btrfsOut, mntOut, lsblkOut, snapperCheck] = await Promise.all([
        cmd(["btrfs", "filesystem", "show"]),
        cmd(["findmnt", "-A", "-J", "-t", "btrfs"]).catch(() => "{}"),
        cmd(["lsblk", "-J", "-o", "NAME,PATH,MODEL,VENDOR,TYPE"]).catch(() => "{}"),
        cmd(["sh", "-c", "command -v snapper >/dev/null 2>&1 && echo yes || echo no"]).catch(() => "no"),
      ]);
      this.hasSnapper = (snapperCheck || "").trim() === "yes";

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

        let devs = [];
        const lines = block.split("\n");
        lines.forEach((line) => {
          if (
            line.match(/devid/i) &&
            line.match(/path/i)
          ) {
            const idMatch = line.match(/devid\s+(\d+)/i);
            const sizeMatch = line.match(/size\s+([0-9.]+(?:[a-zA-Z]+)?)/i);
            const pathMatch = line.match(/path\s+(\S+)/i);
            const isMissing = line.includes("MISSING");
            if (idMatch && pathMatch) {
              devs.push({
                id: idMatch[1],
                size: sizeMatch ? sizeMatch[1] : "0",
                path: pathMatch[1],
                missing: isMissing,
              });
            }
          }
        });

        let mountPoint = this.mnt[`UUID=${uuid}`] || "";
        if (!mountPoint && rootPath) {
          mountPoint =
            this.mnt[rootPath] ||
            this.mnt[rootPath + "1"] ||
            this.mnt[rootPath + "2"] ||
            "";
        }
        if (!mountPoint) {
          for (let d of devs) {
            if (this.mnt[d.path]) {
              mountPoint = this.mnt[d.path];
              break;
            }
          }
        }

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
              : `Storage Pool (${uuid.slice(0, 8)})`,
          uuid,
          mountPoint,
          devs,
          rawSize,
          hwList,
          raid: "Loading...",
          usable: "Loading...",
          snapStatus: "Loading...",
          dataAlloc: null,
          metaAlloc: null,
          mountOptsHtml: "",
          healthHtml: "",
          devErrors: {},
          totalDevErrors: 0,
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
          `<li><strong>${escapeHtml(o.cfg)}</strong> (Target folder: <span class="btrfs-code">${escapeHtml(o.subvol || "Missing")}</span>)</li>`,
      )
      .join("");
    el.innerHTML = `
      <div class="orphan-snap-content">
        <div class="orphan-snap-title">
          <span>⚠️ Stale Backup Schedules Found</span>
          <span class="orphan-badge">${count} Stale ${count === 1 ? "Schedule" : "Schedules"}</span>
        </div>
        <div class="orphan-snap-desc">
          The following automatic backup schedules point to folders or drives that no longer exist. Removing them will prevent backup errors and keep other backups running normally:
        </div>
        <ul class="danger-list orphan-item-list">
          ${itemsHtml}
        </ul>
      </div>
      <div class="orphan-snap-actions">
        <button class="btn btn-danger btn-sm btn-action" data-action="clean-orphaned-snaps">Remove Stale Schedules</button>
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
            if [ "$H" != "0" ] && [ -n "$H" ]; then STATUS="Hourly (Keeps up to $H backups)"
            elif [ "$D" != "0" ] && [ -n "$D" ]; then STATUS="Daily (Keeps up to $D backups)"
            elif [ "$W" != "0" ] && [ -n "$W" ]; then STATUS="Weekly (Keeps up to $W backups)"
            elif [ "$M" != "0" ] && [ -n "$M" ]; then STATUS="Monthly (Keeps up to $M backups)"
            else STATUS="Enabled (Active)"; fi
        fi
    fi
fi
if [ "$STATUS" = "Not Configured" ]; then
    CRON=$(grep -l "btrfs subvolume snapshot.*$MNT" /etc/cron.hourly/* /etc/cron.daily/* /etc/cron.weekly/* /etc/cron.monthly/* 2>/dev/null | head -n 1)
    if [ -n "$CRON" ]; then
        FRQ=$(echo "$CRON" | awk -F'/' '{print $3}' | sed 's/cron\\.//' | awk '{ print toupper(substr($0, 1, 1)) substr($0, 2) }')
        LIM=$(grep "tail -n" "$CRON" | sed -E 's/.*tail -n \\+([0-9]+).*/\\1/')
        if [ -n "$LIM" ]; then
            STATUS="$FRQ (Keeps up to $((LIM - 1)) backups)"
        else
            STATUS="$FRQ (Automated)"
        fi
    fi
fi
echo "$STATUS"
                `;

        const [dfOut, hOut, snapOut, optsOut, statsOut] = await Promise.all([
          cmd(["btrfs", "filesystem", "df", v.mountPoint]),
          cmd(["df", "-B1", v.mountPoint]),
          cmd(["sh", "-c", snapScript, "--", v.mountPoint]).catch(
            () => "Not Configured",
          ),
          cmd(["findmnt", "-n", "-o", "OPTIONS", "-T", v.mountPoint]).catch(() => ""),
          cmd(["btrfs", "device", "stats", v.mountPoint]).catch(() => ""),
        ]);

        // Parse mount options & features
        if (optsOut) {
          const rawOpts = optsOut.trim().split(",");
          const importantOpts = [];
          const compOpt = rawOpts.find((o) => o.startsWith("compress"));
          if (compOpt) importantOpts.push(compOpt);
          const cacheOpt = rawOpts.find((o) => o.startsWith("space_cache"));
          if (cacheOpt) importantOpts.push(cacheOpt);
          const discOpt = rawOpts.find((o) => o.startsWith("discard"));
          if (discOpt) importantOpts.push(discOpt);
          if (rawOpts.includes("ro")) importantOpts.push("read-only");
          if (rawOpts.includes("ssd")) importantOpts.push("ssd");
          if (rawOpts.includes("autodefrag")) importantOpts.push("autodefrag");

          v.mountOptsHtml = importantOpts.length
            ? importantOpts.map((o) => `<span class="mount-opt-tag">${o}</span>`).join(" ")
            : '<span class="text-muted">Standard BTRFS options</span>';
        } else {
          v.mountOptsHtml = '<span class="text-muted">Default</span>';
        }

        // Parse btrfs device stats
        let totalDevErrors = 0;
        let devErrors = {};
        if (statsOut) {
          const statLines = statsOut.trim().split("\n");
          statLines.forEach((line) => {
            const m = line.match(/\[([^\]]+)\]\.(\w+)\s+(\d+)/);
            if (m) {
              const devPath = m[1];
              const count = parseInt(m[3], 10) || 0;
              devErrors[devPath] = (devErrors[devPath] || 0) + count;
              totalDevErrors += count;
            }
          });
        }
        v.devErrors = devErrors;
        v.totalDevErrors = totalDevErrors;
        v.healthHtml =
          totalDevErrors > 0
            ? `<span class="text-danger fw-bold">⚠️ ${totalDevErrors} Disk Error(s) Detected!</span>`
            : `<span class="text-success fw-bold">✓ Healthy (No Errors)</span>`;

        // Parse chunk allocations (Data & Metadata)
        let dataAlloc = null;
        let metaAlloc = null;
        const dMatch = dfOut.match(/Data,\s*([^:]+):\s*total=([^,]+),\s*used=([^\n]+)/i);
        if (dMatch) {
          const prof = dMatch[1].trim();
          const totalStr = dMatch[2].trim();
          const usedStr = dMatch[3].trim();
          const totalB = parseSize(totalStr);
          const usedB = parseSize(usedStr);
          const pct = totalB > 0 ? Math.min(100, Math.round((usedB / totalB) * 100)) : 0;
          dataAlloc = { profile: prof.toUpperCase(), totalStr, usedStr, pct };
        }
        const mMatch = dfOut.match(/Metadata,\s*([^:]+):\s*total=([^,]+),\s*used=([^\n]+)/i);
        if (mMatch) {
          const prof = mMatch[1].trim();
          const totalStr = mMatch[2].trim();
          const usedStr = mMatch[3].trim();
          const totalB = parseSize(totalStr);
          const usedB = parseSize(usedStr);
          const pct = totalB > 0 ? Math.min(100, Math.round((usedB / totalB) * 100)) : 0;
          metaAlloc = { profile: prof.toUpperCase(), totalStr, usedStr, pct };
        }
        v.dataAlloc = dataAlloc;
        v.metaAlloc = metaAlloc;

        const dProf = dataAlloc ? dataAlloc.profile : (dfOut.match(/Data,\s*(.*?):/i)?.[1]?.toUpperCase() || "SINGLE");
        const mProf = metaAlloc ? metaAlloc.profile : (dfOut.match(/Metadata,\s*(.*?):/i)?.[1]?.toUpperCase() || "DUP");
        v.raid = `<span class="btrfs-code">Data: ${dProf}</span> <span class="btrfs-code">Meta: ${mProf}</span>`;

        const dfLines = hOut.trim().split("\n");
        if (dfLines.length > 1) {
          const cols = dfLines[1].trim().split(/\s+/);
          const totalB = parseInt(cols[1], 10) || 0;
          const usedB = parseInt(cols[2], 10) || 0;
          const availB = parseInt(cols[3], 10) || 0;
          v.totalUsable = formatSize(totalB);
          v.used = formatSize(usedB);
          v.free = formatSize(availB);
          v.usable = `${formatSize(availB)} free of ${formatSize(totalB)}`;
        } else {
          v.usable = "Unknown";
        }

        v.snapStatus = snapOut.trim() || "Not Configured";
      } catch (e) {
        v.raid = "Error Reading Profile";
        v.usable = "Error";
        v.snapStatus = "Error";
      }
      this.updateUI(v);
    }
  },

  renderAllocBars(v, isDetail = false) {
    if (!v.mountPoint || !v.dataAlloc || !v.metaAlloc) return "";
    const d = v.dataAlloc;
    const m = v.metaAlloc;
    const dataClass = d.pct >= 90 ? "danger" : d.pct >= 75 ? "warn" : "data";
    const metaClass = m.pct >= 85 ? "danger" : m.pct >= 70 ? "warn" : "meta";

    return `
      <div class="${isDetail ? "alloc-section mb-15" : "alloc-section mt-10 mb-15"}">
        ${isDetail ? '<div class="alloc-section-title"><span>Storage Chunk Allocation</span><span class="text-muted text-sm">Raw chunks allocated by BTRFS</span></div>' : '<div class="alloc-section-title"><span>Chunk Allocation</span></div>'}
        <div class="alloc-bar-group">
          <div class="alloc-bar-header">
            <span class="alloc-bar-title">Data <span class="btrfs-code">${escapeHtml(d.profile)}</span></span>
            <span class="alloc-bar-stats">${escapeHtml(d.usedStr)} / ${escapeHtml(d.totalStr)} (${d.pct}%)</span>
          </div>
          <div class="alloc-bar-track">
            <div class="alloc-bar-fill ${dataClass}" style="width: ${d.pct}%;"></div>
          </div>
        </div>
        <div class="alloc-bar-group">
          <div class="alloc-bar-header">
            <span class="alloc-bar-title">Metadata <span class="btrfs-code">${escapeHtml(m.profile)}</span>${m.profile === "SINGLE" && v.mountPoint ? ` <button class="btn-xs-tag btn-action" data-action="quick-meta-dup" data-mount="${escapeHtml(v.mountPoint)}" data-index="${v.idx}" title="Upgrade metadata from Single to DUP for corruption protection">Upgrade to DUP</button>` : ""}</span>
            <span class="alloc-bar-stats">${escapeHtml(m.usedStr)} / ${escapeHtml(m.totalStr)} (${m.pct}%)</span>
          </div>
          <div class="alloc-bar-track">
            <div class="alloc-bar-fill ${metaClass}" style="width: ${m.pct}%;"></div>
          </div>
        </div>
      </div>
    `;
  },

  /* STREAMING_CHUNK:Updating UI Nodes... */
  updateUI(v) {
    if ($(`master-usable-${v.idx}`)) {
      $(`master-usable-${v.idx}`).innerHTML = v.usable;
      if ($(`master-snap-${v.idx}`))
        $(`master-snap-${v.idx}`).innerHTML = v.snapStatus;
      if ($(`master-raid-${v.idx}`))
        $(`master-raid-${v.idx}`).innerHTML = v.raid;
      if ($(`master-alloc-${v.idx}`))
        $(`master-alloc-${v.idx}`).innerHTML = this.renderAllocBars(v, false);
    }
    if ($(`raid-display-${v.idx}`)) {
      $(`raid-display-${v.idx}`).innerHTML = v.raid;
      $(`usable-display-${v.idx}`).innerHTML = v.usable;
      if ($(`snap-display-${v.idx}`))
        $(`snap-display-${v.idx}`).innerHTML = v.snapStatus;
      if ($(`health-display-${v.idx}`))
        $(`health-display-${v.idx}`).innerHTML = v.healthHtml;
      if ($(`opts-display-${v.idx}`))
        $(`opts-display-${v.idx}`).innerHTML = v.mountOptsHtml;
      if ($(`alloc-display-${v.idx}`))
        $(`alloc-display-${v.idx}`).innerHTML = this.renderAllocBars(v, true);
    }
  },

  /* STREAMING_CHUNK:Rendering Dashboard Master View... */
  renderMaster() {
    this.renderOrphanBanner();
    if (!$("disk-container")) return;
    $("disk-container").innerHTML = this.vols.length
      ? this.vols
          .map((v) => {
            const hasMissing = v.devs && v.devs.some((d) => d.missing);
            const hasErrors = v.totalDevErrors > 0;
            const alertBadge = hasMissing
              ? '<span class="badge-danger">Degraded (Disk Missing)</span>'
              : hasErrors
                ? '<span class="badge-meta-warn">⚠️ IO Errors</span>'
                : "";
            return `
            <div class="btrfs-card hoverable h-100-col">
                <div class="card-header-clean">
                    <div>
                        <h3 class="card-title-text">${escapeHtml(v.label)}</h3>
                        ${alertBadge ? `<div class="mt-5">${alertBadge}</div>` : ""}
                    </div>
                    <div class="card-status-tag">
                        ${v.mountPoint ? `<span class="badge-mounted">${escapeHtml(v.mountPoint)}</span>` : `<span class="badge-ro">Not Mounted</span>`}
                    </div>
                </div>
                <div class="spec-table mt-15 mb-20">
                    <div class="spec-row">
                        <span class="spec-label">UUID</span>
                        <span class="btrfs-code text-truncate" title="${escapeHtml(v.uuid)}">${escapeHtml(v.uuid)}</span>
                    </div>
                    <div class="spec-row">
                        <span class="spec-label">Hardware</span>
                        <span class="spec-val text-muted">${escapeHtml(v.hwList)}</span>
                    </div>
                    <div class="spec-row">
                        <span class="spec-label">Capacity</span>
                        <span class="spec-val"><b>${escapeHtml(v.rawSize)}</b> (Usable: <span id="master-usable-${v.idx}">${v.usable}</span>)</span>
                    </div>
                    <div class="spec-row">
                        <span class="spec-label">Protection</span>
                        <span class="spec-val" id="master-raid-${v.idx}">${v.raid}</span>
                    </div>
                    <div class="spec-row">
                        <span class="spec-label">Auto-Snapshot</span>
                        <span class="spec-val"><span id="master-snap-${v.idx}">${escapeHtml(v.snapStatus)}</span>${!this.hasSnapper && (v.snapStatus === "Not Configured" || v.snapStatus === "Loading...") ? ' <span class="badge-snapper-missing">No Snapper</span>' : ""}</span>
                    </div>
                </div>
                <div id="master-alloc-${v.idx}">
                  ${this.renderAllocBars(v, false)}
                </div>
                <button class="btn btn-secondary w-100 mt-auto btn-action" data-action="open-detail" data-index="${v.idx}">Manage Storage Pool</button>
            </div>`;
          })
          .join("")
      : "<p class='mt-15 text-muted'>No active BTRFS storage pools detected.</p>";
  },

  /* STREAMING_CHUNK:Rendering Subvolume Details... */
  renderDetail(idx) {
    if (!$("detail-container")) return;
    const v = this.vols.find((vol) => vol.idx == idx);
    if (!v) return;
    $("detail-container").setAttribute("data-active-index", idx);

    const devRows = v.devs
      .map((d) => {
        const errCount = (v.devErrors && v.devErrors[d.path]) || 0;
        const errBadge =
          errCount > 0
            ? `<span class="badge-danger">⚠️ ${errCount} IO Errors</span>`
            : `<span class="badge-healthy">Healthy</span>`;
        const missingBadge = d.missing
          ? `<span class="badge-danger">MISSING</span>`
          : "";
        const canRemove = v.devs && v.devs.length > 1;
        const removeBtn = v.mountPoint && canRemove
          ? d.missing
            ? `<button class="btn-tool btn-tool-danger btn-action" data-action="remove-missing-dev" data-mount="${escapeHtml(v.mountPoint)}">Remove Missing</button>`
            : `<button class="btn-tool btn-tool-danger btn-action" data-action="remove-dev" data-mount="${escapeHtml(v.mountPoint)}" data-devpath="${escapeHtml(d.path)}">Remove</button>`
          : "";
        return `<tr>
          <td><span class="btrfs-code ${d.missing ? "text-danger" : ""}">${escapeHtml(d.path)}</span></td>
          <td class="text-muted text-sm">${escapeHtml(d.id)}</td>
          <td class="text-sm fw-bold">${escapeHtml(d.size)}</td>
          <td>${missingBadge || errBadge}</td>
          <td class="text-right">${removeBtn}</td>
        </tr>`;
      })
      .join("");

    const rootDevices = Object.keys(this.mnt).filter(
      (k) => this.mnt[k] === "/"
    );
    const isRoot =
      v.mountPoint === "/" ||
      rootDevices.some((rd) =>
        v.devs.some(
          (d) => d.path === rd || rd.startsWith(d.path) || d.path.startsWith(rd),
        ),
      );

    const boxSafe = (v.mountPoint || "root").replace(/[^a-zA-Z0-9]/g, "-");

    $("detail-container").innerHTML = `
            <div class="pool-detail-header mb-20">
                <div class="pool-title-group">
                    <h2 class="pool-title">${escapeHtml(v.label)}</h2>
                    <div class="tag-group mt-5">
                        ${v.mountPoint ? `<span class="badge-mounted">Mounted: ${escapeHtml(v.mountPoint)}</span>` : `<span class="badge-ro">Not Mounted (Locked)</span>`}
                        <span class="btrfs-code">${escapeHtml(v.uuid)}</span>
                    </div>
                </div>
            </div>
            <div class="detail-layout-grid">
                <div class="detail-left-col">
                    <div class="btrfs-card">
                        <h4 class="section-title">Storage Pool Overview</h4>
                        <div class="spec-table mb-15">
                            <div class="spec-row"><span class="spec-label">Physical Hardware</span><span class="spec-val text-primary fw-bold">${escapeHtml(v.hwList)}</span></div>
                            <div class="spec-row"><span class="spec-label">Total Drive Space</span><span class="spec-val">${escapeHtml(v.rawSize)}</span></div>
                            <div class="spec-row"><span class="spec-label">Available Storage</span><span id="usable-display-${v.idx}" class="spec-val fw-bold">${v.usable}</span></div>
                            <div class="spec-row"><span class="spec-label">Data Protection</span><span id="raid-display-${v.idx}" class="spec-val">${v.raid}</span></div>
                            <div class="spec-row"><span class="spec-label">Automatic Backups</span><span id="snap-display-${v.idx}" class="spec-val fw-bold">${escapeHtml(v.snapStatus)}</span></div>
                            <div class="spec-row"><span class="spec-label">Drive Health</span><span id="health-display-${v.idx}" class="spec-val">${v.healthHtml || '<span class="text-success fw-bold">✓ Healthy (No Errors)</span>'}</span></div>
                            <div class="spec-row"><span class="spec-label">Active Features</span><span id="opts-display-${v.idx}" class="spec-val">${v.mountOptsHtml || '<span class="text-muted">Standard</span>'}</span></div>
                        </div>
                        <div id="alloc-display-${v.idx}">
                            ${this.renderAllocBars(v, true)}
                        </div>
                        <h5 class="sub-section-title mt-20 mb-10">Member Drives</h5>
                        <div class="table-scroll-container mb-15">
                            <table class="data-table">
                                <thead>
                                    <tr>
                                        <th>Drive Path</th>
                                        <th>Device ID</th>
                                        <th>Capacity</th>
                                        <th>Health</th>
                                        <th class="text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${devRows}
                                </tbody>
                            </table>
                        </div>
                        ${v.mountPoint ? `<div class="advanced-topo-actions"><button class="btn btn-primary btn-sm btn-action" data-action="add-dev-modal" data-mount="${escapeHtml(v.mountPoint)}">Add Drive</button> <button class="btn btn-secondary btn-sm btn-action" data-action="convert-raid" data-mount="${escapeHtml(v.mountPoint)}" data-index="${v.idx}">Change Protection</button></div>` : ""}
                    </div>
                    ${
                      v.mountPoint
                        ? `<div class="btrfs-card">
                        <h4 class="section-title">Storage Optimization & Health</h4>
                        <div class="toolbar-actions mb-15">
                            <button class="btn btn-primary btn-sm btn-action" id="btn-scrub-${boxSafe}" data-action="scrub" data-mount="${escapeHtml(v.mountPoint)}">Verify & Repair</button> 
                            <button class="btn btn-secondary btn-sm btn-action" id="btn-balance-${boxSafe}" data-action="balance" data-mount="${escapeHtml(v.mountPoint)}">Optimize Space</button> 
                            <button class="btn btn-secondary btn-sm btn-action" id="btn-defrag-${boxSafe}" data-action="defrag" data-mount="${escapeHtml(v.mountPoint)}">Defragment</button> 
                            <button class="btn btn-secondary btn-sm btn-action" data-action="device-stats" data-mount="${escapeHtml(v.mountPoint)}">Drive Diagnostics</button> 
                        </div>
                        <div class="terminal-window">
                            <div class="terminal-header">
                                <div class="terminal-title">Activity Log (${escapeHtml(v.mountPoint)})</div>
                                <div class="terminal-header-actions">
                                    <span id="term-status-${boxSafe}" class="term-status-badge">Idle</span>
                                    <button class="term-clear-btn btn-action" data-action="clear-terminal" data-box="${boxSafe}">Clear</button>
                                </div>
                            </div>
                            <div id="maint-console-${boxSafe}" class="terminal-body"><span class="term-muted">Ready. Select an optimization or health task above.</span></div>
                        </div>
                    </div>`
                        : `<div class="warning-box"><p class="text-warning mb-5">Storage Pool Locked</p><p class="text-muted">Please mount this storage pool to unlock subvolume and maintenance tasks.</p></div>`
                    }
                    <div class="btrfs-card danger-card">
                        <h4 class="section-title text-danger">Delete Storage Pool</h4>
                        <p class="danger-desc">Permanently remove this storage pool. Unmounts the drives, purges all backup schedules, and wipes drive signatures.</p>
                        ${
                          isRoot
                            ? `<div class="warning-box"><p class="text-warning mb-0"><b>Protected System Drive:</b> This pool contains the operating system root (<code>/</code>) and cannot be deleted.</p></div>`
                            : `<button class="btn btn-danger btn-sm btn-action" data-action="destroy-vol-modal" data-mount="${escapeHtml(v.mountPoint || "")}" data-uuid="${escapeHtml(v.uuid)}" data-label="${escapeHtml(v.label)}" data-devs="${escapeHtml(v.devs.map((d) => d.path).join(" "))}" data-index="${v.idx}">Permanently Delete Pool</button>`
                        }
                    </div>
                </div>
                <div class="detail-right-col">
                    <!-- Kotak Atas: Subvolumes Management -->
                    <div class="btrfs-card mb-20">
                        <div class="card-header-clean mb-15">
                            <h4 class="section-title mb-0">Subvolumes (Folders)</h4>
                        </div>
                        ${
                          v.mountPoint
                            ? `<div class="create-bar mb-15">
                            <input type="text" id="new-subvol-${v.idx}" placeholder="New subvolume name..." class="form-input flex-grow">
                            <button class="btn btn-primary btn-sm btn-action" data-action="subvol-ops" data-op="create" data-mount="${escapeHtml(v.mountPoint)}" data-index="${v.idx}">Create Subvolume</button> 
                        </div>
                        <div id="subvol-list-${v.idx}" class="table-scroll-container"><p class="p-15-muted">Loading subvolumes...</p></div>`
                            : '<p class="text-warning">Mount storage pool to view and manage subvolumes.</p>'
                        }
                    </div>

                    <!-- Kotak Bawah: Snapshots & Rollback Management -->
                    <div class="btrfs-card">
                        <div class="card-header-clean mb-15">
                            <h4 class="section-title mb-0">Snapshots (Backups)</h4>
                            ${
                              v.mountPoint
                                ? `<div class="toolbar-actions">
                                <button class="btn btn-secondary btn-sm btn-action" data-action="subvol-ops" data-op="snap-root" data-mount="${escapeHtml(v.mountPoint)}">Take Snapshot</button>
                                <button class="btn btn-secondary btn-sm btn-action" data-action="subvol-ops" data-op="auto-snap" data-path="" data-mount="${escapeHtml(v.mountPoint)}">Auto-Backups</button>
                                <button class="btn btn-danger btn-sm btn-action" data-action="subvol-ops" data-op="purge-snaps" data-mount="${escapeHtml(v.mountPoint)}">Clean Old</button>
                            </div>`
                                : ""
                            }
                        </div>
                        ${
                          v.mountPoint
                            ? `<div id="snapshot-list-${v.idx}" class="table-scroll-container"><p class="p-15-muted">Loading snapshots...</p></div>`
                            : '<p class="text-warning">Mount storage pool to view and manage snapshots.</p>'
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
DEV=$(findmnt -n -o SOURCE -T "$mnt" 2>/dev/null | head -n 1 | sed 's/\\[.*\\]//')
if [ -z "$DEV" ]; then DEV=$(df "$mnt" 2>/dev/null | awk 'NR==2 {print $1}'); fi
if echo "$DEV" | grep -q "^UUID="; then DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1); fi
if echo "$DEV" | grep -q "^LABEL="; then DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1); fi

TMP=$(mktemp -d)
trap 'umount "$TMP" 2>/dev/null || umount -l "$TMP" 2>/dev/null || true; rmdir "$TMP" 2>/dev/null || true' EXIT
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

SNAP_IDS=$(btrfs subvolume list -s "$SCAN_DIR" 2>/dev/null | awk '{print $2}')
RO_IDS=$(btrfs subvolume list -r "$SCAN_DIR" 2>/dev/null | awk '{print $2}')
DEFAULT_ID=$(btrfs subvolume get-default "$SCAN_DIR" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="ID") print $(i+1)}' | head -n 1)
ACTIVE_MOUNTS=$(findmnt -n -l -o TARGET,SOURCE -t btrfs 2>/dev/null | grep -v "^/tmp")

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
        FOUND_MNT=$(echo "$ACTIVE_MOUNTS" | while read -r m_tgt m_src; do
            s_clean=$(echo "$m_src" | sed -n 's/.*\\[\\/*\\(.*\\)\\]/\\1/p')
            if [ -n "$s_clean" ] && [ "$s_clean" = "$sub_path" ]; then
                echo "$m_tgt"
                break
            fi
        done)
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

    MOUNT_PT=$(echo "$ACTIVE_MOUNTS" | while read -r m_tgt m_src; do
        s_clean=$(echo "$m_src" | sed -n 's/.*\\[\\/*\\(.*\\)\\]/\\1/p')
        if [ -n "$s_clean" ] && [ "$s_clean" = "$sub_path" ]; then
            echo "$m_tgt"
            break
        fi
    done)
    
    IN_FSTAB="false"
    if grep -qs -E "subvol=(/|@)?$sub_path\\b" /etc/fstab; then
        IN_FSTAB="true"
    fi

    IS_SNAP="false"
    if [ "$sub_path" = ".snapshots" ] || [ "$sub_path" = "@snapshots" ] || echo "$sub_path" | grep -q -E "/\\.snapshots$|/@snapshots$"; then
        IS_SNAP="false"
    elif echo " $SNAP_IDS " | grep -q " $id "; then
        IS_SNAP="true"
    elif echo "$sub_path" | grep -q -E "\\.snapshots/|/snapshot|_snap_|snap-"; then
        IS_SNAP="true"
    fi

    IS_RO="false"
    if echo " $RO_IDS " | grep -q " $id "; then
        IS_RO="true"
    fi

    IS_DEF="false"
    if [ -n "$DEFAULT_ID" ] && [ "$id" = "$DEFAULT_ID" ]; then
        IS_DEF="true"
    fi

    echo "$id|$sub_path|$nocow|$ctime|$MOUNT_PT|$IN_FSTAB|$IS_SNAP|$IS_RO|$IS_DEF"
done

if [ "$IS_MOUNTED" -eq 1 ]; then
    umount "$TMP" 2>/dev/null || umount -l "$TMP" 2>/dev/null || true
fi
rmdir "$TMP" 2>/dev/null || true
`;
      const out = await cmd(["sh", "-c", script, "--", mount]);
      let subvolsRows = "";
      let snapshotsRows = "";

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
          let isSnapshot = parts[6] === "true";
          const isRo = parts[7] === "true";
          const isDef = parts[8] === "true";

          const isSnapshotContainer =
            path === ".snapshots" ||
            path === "@snapshots" ||
            path.endsWith("/.snapshots") ||
            path.endsWith("/@snapshots");

          if (isSnapshotContainer) {
            isSnapshot = false;
          }

          const isRootSubvol =
            mountPt === "/" ||
            (mount === "/" &&
              (path === "@" ||
                path === "" ||
                path === "root" ||
                path === "rootfs" ||
                path === "@root"));

          const isProtected =
            isSnapshotContainer || isRootSubvol || Boolean(mountPt) || inFstab;

          if (isSnapshot) {
            snapshotsRows += `<tr>
                <td><span class="btrfs-code">/${escapeHtml(path)}</span></td>
                <td class="text-muted text-sm">${escapeHtml(ctime)}</td>
                <td class="text-muted text-sm">${escapeHtml(id)}</td>
                <td>
                    <div class="tag-group">
                        ${isRo ? '<span class="badge-ro">Read-Only</span>' : '<span class="badge-rw">Writable</span>'}
                    </div>
                </td>
                <td class="text-right">
                    <div class="btn-group-sharp">
                        <button class="btn-tool btn-action" title="Restore this snapshot into a new writable folder" data-action="subvol-ops" data-op="clone-snap" data-mount="${escapeHtml(mount)}" data-path="${escapeHtml(path)}" data-subid="${escapeHtml(id)}" data-index="${idx}">Restore</button>
                        <button class="btn-tool btn-action" title="${isRo ? "Make writable to allow file modifications" : "Protect as Read-Only to prevent changes"}" data-action="subvol-ops" data-op="toggle-ro" data-ro="${isRo ? "false" : "true"}" data-mount="${escapeHtml(mount)}" data-path="${escapeHtml(path)}" data-index="${idx}">
                            ${isRo ? "Unlock" : "Lock"}
                        </button>
                        <button class="btn-tool btn-tool-danger btn-action" title="Permanently delete this backup snapshot" data-action="subvol-ops" data-op="del" data-mount="${escapeHtml(mount)}" data-path="${escapeHtml(path)}" data-subid="${escapeHtml(id)}" data-index="${idx}">Delete</button>
                    </div>
                </td>
            </tr>`;
          } else {
            let badgeHtml = "";
            if (isSnapshotContainer) {
              badgeHtml += `<span class="badge-fstab">Snapshot Storage</span>`;
            } else if (isRootSubvol) {
              badgeHtml += `<span class="badge-root">OS Root (/)</span>`;
            } else if (mountPt) {
              badgeHtml += `<span class="badge-mounted">${escapeHtml(mountPt)}</span>`;
            } else if (inFstab) {
              badgeHtml += `<span class="badge-fstab">In /etc/fstab</span>`;
            }
            if (isDef) {
              badgeHtml += `<span class="badge-default-mount">Default</span>`;
            }
            if (isRo) {
              badgeHtml += `<span class="badge-ro">RO</span>`;
            }

            const cowBadge = nocow
              ? `<span class="badge-nocow">NoCOW</span>`
              : "";

            const actionButtons = isSnapshotContainer
              ? `<span class="text-muted text-sm">Protected</span>`
              : `<div class="btn-group-sharp">
                  <button class="btn-tool btn-action" title="${nocow ? "Enable Copy-on-Write (+CoW) for data safety" : "Disable Copy-on-Write (NoCoW) for database and VM speed"}" data-action="subvol-ops" data-op="${nocow ? "enable-cow" : "disable-cow"}" data-mount="${escapeHtml(mount)}" data-path="${escapeHtml(path)}" data-index="${idx}">
                      ${nocow ? "+CoW" : "NoCoW"}
                  </button>
                  ${
                    !isProtected
                      ? `<button class="btn-tool btn-tool-danger btn-action" title="Delete subvolume" data-action="subvol-ops" data-op="del" data-mount="${escapeHtml(mount)}" data-path="${escapeHtml(path)}" data-subid="${escapeHtml(id)}" data-index="${idx}" data-mounted-at="${escapeHtml(mountPt)}" data-is-protected="${isProtected}">Delete</button>`
                      : ""
                  }
              </div>`;

            subvolsRows += `<tr>
                <td><span class="btrfs-code">/${escapeHtml(path)}</span></td>
                <td class="text-muted text-sm">${escapeHtml(ctime)}</td>
                <td class="text-muted text-sm">${escapeHtml(id)}</td>
                <td>
                    <div class="tag-group">
                        ${badgeHtml}
                        ${cowBadge}
                    </div>
                </td>
                <td class="text-right">
                    ${actionButtons}
                </td>
            </tr>`;
          }
        });

      if ($(`subvol-list-${idx}`)) {
        $(`subvol-list-${idx}`).innerHTML = subvolsRows
          ? `<table class="data-table">
              <thead>
                <tr>
                  <th>Subvolume Folder</th>
                  <th>Date Created</th>
                  <th>ID</th>
                  <th>Features</th>
                  <th class="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${subvolsRows}
              </tbody>
            </table>`
          : "<p class='p-15-muted'>No active user subvolumes found inside this pool root.</p>";
      }
      if ($(`snapshot-list-${idx}`)) {
        $(`snapshot-list-${idx}`).innerHTML = snapshotsRows
          ? `<table class="data-table">
              <thead>
                <tr>
                  <th>Snapshot Backup</th>
                  <th>Date Created</th>
                  <th>ID</th>
                  <th>Access</th>
                  <th class="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${snapshotsRows}
              </tbody>
            </table>`
          : "<p class='p-15-muted'>No snapshots created yet for this volume.</p>";
      }
    } catch (e) {
      if ($(`subvol-list-${idx}`)) {
        $(`subvol-list-${idx}`).innerHTML =
          `<p class='text-danger mt-15'>Load failed: ${e.message}</p>`;
      }
    }
  },
};
