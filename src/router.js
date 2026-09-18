const {
  $,
  on,
  cmd,
  App,
  Modal,
  customAlert,
  customConfirm,
  customPrompt,
  customSelect,
} = window;

const getEmptyDevices = () => {
  return cmd(["lsblk", "-J", "-o", "NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT"]).then(
    (data) => {
      const extractEmpty = (devs) =>
        devs.reduce((acc, d) => {
          if (d.children) return acc.concat(extractEmpty(d.children));
          if (
            !d.fstype &&
            !d.mountpoint &&
            (d.type === "disk" || d.type === "part")
          )
            acc.push(d);
          return acc;
        }, []);
      return extractEmpty(JSON.parse(data).blockdevices || []);
    },
  );
};

const activeScrubTimers = {};
const activeBalanceTimers = {};

const updateLiveStatus = (mnt, text) => {
  const boxSafe = (mnt || "root").replace(/[^a-zA-Z0-9]/g, "-");
  const b = $(`maint-console-${boxSafe}`);
  if (!b) return;
  let liveEl = $(`term-live-${boxSafe}`);
  if (!liveEl) {
    liveEl = document.createElement("div");
    liveEl.id = `term-live-${boxSafe}`;
    liveEl.className = "term-line term-muted";
    b.appendChild(liveEl);
  }
  const escaped = (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  liveEl.innerHTML = `<span style="color:#60cdff; font-weight:600;">[Live Progress]</span>\n${escaped}`;
  b.scrollTop = b.scrollHeight;
};

const clearLiveStatus = (mnt) => {
  const boxSafe = (mnt || "root").replace(/[^a-zA-Z0-9]/g, "-");
  const liveEl = $(`term-live-${boxSafe}`);
  if (liveEl) liveEl.remove();
};

const startScrubMonitor = (mnt) => {
  const boxSafe = (mnt || "root").replace(/[^a-zA-Z0-9]/g, "-");
  const scrubBtn = $(`btn-scrub-${boxSafe}`);
  if (activeScrubTimers[mnt]) clearInterval(activeScrubTimers[mnt]);
  activeScrubTimers[mnt] = setInterval(() => {
    cmd(["btrfs", "scrub", "status", "-d", mnt])
      .then((out) => {
        const isFinished =
          out.includes("finished") ||
          out.includes("aborted") ||
          out.includes("canceled");
        updateLiveStatus(mnt, out.trim());
        if (isFinished) {
          clearInterval(activeScrubTimers[mnt]);
          delete activeScrubTimers[mnt];
          clearLiveStatus(mnt);
          if (scrubBtn) {
            scrubBtn.innerText = "Scrub";
            scrubBtn.classList.remove("btn-danger");
            scrubBtn.classList.add("btn-primary");
            scrubBtn.removeAttribute("data-running");
          }
          setTermStatus(mnt, "Finished", false);
          termLog(mnt, `> Scrub operation complete!`, "success");
        }
      })
      .catch(() => {});
  }, 2500);
};

const startBalanceMonitor = (mnt) => {
  const boxSafe = (mnt || "root").replace(/[^a-zA-Z0-9]/g, "-");
  const balBtn = $(`btn-balance-${boxSafe}`);
  if (activeBalanceTimers[mnt]) clearInterval(activeBalanceTimers[mnt]);
  activeBalanceTimers[mnt] = setInterval(() => {
    cmd(["btrfs", "balance", "status", mnt])
      .then((out) => {
        updateLiveStatus(mnt, out.trim());
        const isFinished =
          out.includes("No balance found") ||
          out.includes("finished") ||
          out.includes("Done") ||
          out.includes("aborted");
        if (isFinished) {
          clearInterval(activeBalanceTimers[mnt]);
          delete activeBalanceTimers[mnt];
          clearLiveStatus(mnt);
          if (balBtn) {
            balBtn.innerText = "Balance";
            balBtn.classList.remove("btn-danger");
            balBtn.classList.add("btn-secondary");
            balBtn.removeAttribute("data-running");
          }
          setTermStatus(mnt, "Complete", false);
          termLog(mnt, `> Balance operation complete!`, "success");
          App.fetch();
        }
      })
      .catch(() => {});
  }, 2500);
};

const checkBackgroundTasks = (mnt) => {
  if (!mnt) return;
  const boxSafe = (mnt || "root").replace(/[^a-zA-Z0-9]/g, "-");
  const scrubBtn = $(`btn-scrub-${boxSafe}`);
  const balBtn = $(`btn-balance-${boxSafe}`);

  cmd(["btrfs", "scrub", "status", mnt])
    .then((out) => {
      if (out.includes("running")) {
        if (scrubBtn) {
          scrubBtn.innerText = "Cancel Scrub";
          scrubBtn.classList.remove("btn-primary");
          scrubBtn.classList.add("btn-danger");
          scrubBtn.setAttribute("data-running", "true");
        }
        setTermStatus(mnt, "Scrubbing...", true);
        startScrubMonitor(mnt);
      }
    })
    .catch(() => {});

  cmd(["btrfs", "balance", "status", mnt])
    .then((out) => {
      if (
        !out.includes("No balance found") &&
        !out.includes("finished") &&
        !out.includes("aborted") &&
        !out.includes("Done")
      ) {
        if (balBtn) {
          balBtn.innerText = "Cancel Balance";
          balBtn.classList.remove("btn-secondary");
          balBtn.classList.add("btn-danger");
          balBtn.setAttribute("data-running", "true");
        }
        setTermStatus(mnt, "Balancing...", true);
        startBalanceMonitor(mnt);
      }
    })
    .catch(() => {});
};

const termLog = (mnt, text, type = "") => {
  const boxSafe = (mnt || "root").replace(/[^a-zA-Z0-9]/g, "-");
  const b = $(`maint-console-${boxSafe}`);
  if (!b) return;

  let line = text;
  if (type === "cmd") {
    line = `<div class="term-line"><span class="term-prompt">btrfs@${mnt || "pool"}#</span> <span style="color:#e2e8f0; font-weight:600;">${text}</span></div>`;
    b.innerHTML += line;
  } else if (type === "status") {
    line = `<div class="term-line term-muted">${text}</div>`;
    b.innerHTML += line;
  } else if (type === "success") {
    line = `<div class="term-line term-success">${text}</div>`;
    b.innerHTML += line;
  } else if (type === "warn") {
    line = `<div class="term-line term-warn">${text}</div>`;
    b.innerHTML += line;
  } else if (type === "err") {
    line = `<div class="term-line term-err">${text}</div>`;
    b.innerHTML += line;
  } else {
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    b.innerHTML += `<div class="term-line">${escaped}</div>`;
  }
  b.scrollTop = b.scrollHeight;
  while (b.childElementCount > 200) {
    if (b.firstElementChild.id && b.firstElementChild.id.startsWith("term-live-")) break;
    b.removeChild(b.firstElementChild);
  }
};

const setTermStatus = (mnt, text, isRunning = false) => {
  const boxSafe = (mnt || "root").replace(/[^a-zA-Z0-9]/g, "-");
  const badge = $(`term-status-${boxSafe}`);
  if (badge) {
    badge.innerText = text;
    badge.className = "term-status-badge" + (isRunning ? " running" : "");
  }
};

const initTheme = () => {
  const saved = localStorage.getItem("btrfs_manager_theme");
  const theme = saved || "dark";
  document.documentElement.setAttribute("data-theme", theme);
  updateThemeUi(theme);
};

const updateThemeUi = (theme) => {
  const lbl = $("theme-label");
  const icon = $("theme-icon");
  if (lbl) lbl.innerText = theme === "dark" ? "Light Theme" : "Dark Theme";
  if (icon) icon.innerText = theme === "dark" ? "☀️" : "🌙";
  const detailIcons = document.querySelectorAll(".theme-icon-sync");
  detailIcons.forEach((el) => {
    el.innerText = theme === "dark" ? "☀️" : "🌙";
  });
};

const toggleTheme = () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const target = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", target);
  localStorage.setItem("btrfs_manager_theme", target);
  updateThemeUi(target);
};

// Initial theme apply before render
initTheme();

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  App.fetch();

  document.body.addEventListener("click", (e) => {
    const tgt = e.target.closest(".btn-action");
    if (!tgt) return;
    const action = tgt.getAttribute("data-action");
    const mnt = tgt.getAttribute("data-mount");

    try {
      switch (action) {
        case "open-detail": {
          $("view-master").classList.add("hidden-element");
          $("view-detail").classList.remove("hidden-element");
          const idx = tgt.getAttribute("data-index");
          App.renderDetail(idx);
          const v = App.vols.find((vol) => vol.idx == idx);
          if (v && v.mountPoint) {
            checkBackgroundTasks(v.mountPoint);
          }
          break;
        }

        case "convert-raid": {
          const vIdx = tgt.getAttribute("data-index");
          const v = App.vols.find((vol) => vol.idx == vIdx);
          const devCount = v && v.devs ? v.devs.length : 1;
          customSelect(
            "Online RAID Conversion",
            `Select new profile (Current pool has ${devCount} disk${devCount > 1 ? "s" : ""}):`,
            [
              { v: "single", l: "Single (Min 1 Disk)" },
              { v: "dup", l: "DUP - Duplicate Chunks (Min 1 Disk)" },
              { v: "raid0", l: "RAID 0 - Striping (Min 2 Disks)" },
              { v: "raid1", l: "RAID 1 - Mirroring (Min 2 Disks)" },
              { v: "raid10", l: "RAID 10 - Stripe + Mirror (Min 4 Disks)" },
            ],
            "Convert",
            (p) => {
              if (!p) return;
              if ((p === "raid0" || p === "raid1") && devCount < 2) {
                customAlert(
                  "Insufficient Disks",
                  `The ${p.toUpperCase()} profile requires at least 2 physical disks in the volume (currently ${devCount}). Please add more disks first using 'Add Disk'.`,
                );
                return;
              }
              if (p === "raid10" && devCount < 4) {
                customAlert(
                  "Insufficient Disks",
                  `The RAID 10 profile requires at least 4 physical disks in the volume (currently ${devCount}). Please add more disks first using 'Add Disk'.`,
                );
                return;
              }

              const mProfile = p === "raid0" && devCount >= 2 ? "raid1" : p;
              termLog(
                mnt,
                `btrfs balance start --background -f -dconvert=${p} -mconvert=${mProfile} ${mnt}`,
                "cmd",
              );
              setTermStatus(mnt, "Converting...", true);
              cmd([
                "btrfs",
                "balance",
                "start",
                "--background",
                "-f",
                "-dconvert=" + p,
                "-mconvert=" + mProfile,
                mnt,
              ])
                .then((o) => {
                  termLog(
                    mnt,
                    `Conversion to ${p} (data: ${p}, meta: ${mProfile}) initiated in background.\n${o}`,
                    "status",
                  );
                  startBalanceMonitor(mnt);
                })
                .catch((err) => {
                  termLog(mnt, `Conversion failed: ${err.message}`, "err");
                  setTermStatus(mnt, "Error", false);
                });
            },
          );
          break;
        }

        case "scrub": {
          const boxSafe = (mnt || "root").replace(/[^a-zA-Z0-9]/g, "-");
          const scrubBtn = $(`btn-scrub-${boxSafe}`);
          const isRunning = scrubBtn && scrubBtn.getAttribute("data-running") === "true";

          if (isRunning) {
            customConfirm(
              "Cancel Scrub",
              `Cancel active scrub operation on ${mnt}?`,
              "Cancel Scrub",
              () => {
                termLog(mnt, `btrfs scrub cancel ${mnt}`, "cmd");
                cmd(["btrfs", "scrub", "cancel", mnt])
                  .then((o) => {
                    termLog(mnt, `Scrub canceled: ${o}`, "warn");
                    if (activeScrubTimers[mnt]) {
                      clearInterval(activeScrubTimers[mnt]);
                      delete activeScrubTimers[mnt];
                    }
                    if (scrubBtn) {
                      scrubBtn.innerText = "Scrub";
                      scrubBtn.classList.remove("btn-danger");
                      scrubBtn.classList.add("btn-primary");
                      scrubBtn.removeAttribute("data-running");
                    }
                    setTermStatus(mnt, "Canceled", false);
                  })
                  .catch((err) => termLog(mnt, `Error canceling scrub: ${err.message}`, "err"));
              },
              true,
            );
            return;
          }

          customConfirm(
            "Start Scrub",
            `Start background data scrubbing on ${mnt} to verify checksums and detect data corruption?`,
            "Start Scrub",
            () => {
              termLog(mnt, `btrfs scrub start ${mnt}`, "cmd");
              setTermStatus(mnt, "Scrubbing...", true);
              if (scrubBtn) {
                scrubBtn.innerText = "Cancel Scrub";
                scrubBtn.classList.remove("btn-primary");
                scrubBtn.classList.add("btn-danger");
                scrubBtn.setAttribute("data-running", "true");
              }

              cmd(["btrfs", "scrub", "start", mnt])
                .then(() => {
                  termLog(mnt, `> Scrub process initiated. Monitoring live progress...`, "status");
                  startScrubMonitor(mnt);
                })
                .catch((err) => {
                  termLog(mnt, `Scrub start failed: ${err.message}`, "err");
                  setTermStatus(mnt, "Error", false);
                  if (scrubBtn) {
                    scrubBtn.innerText = "Scrub";
                    scrubBtn.classList.remove("btn-danger");
                    scrubBtn.classList.add("btn-primary");
                    scrubBtn.removeAttribute("data-running");
                  }
                });
            },
          );
          break;
        }

        case "scrub-status": {
          termLog(mnt, `btrfs scrub status ${mnt}`, "cmd");
          cmd(["btrfs", "scrub", "status", mnt])
            .then((o) => termLog(mnt, o))
            .catch((err) => termLog(mnt, `Error reading scrub: ${err.message}`, "err"));
          break;
        }

        case "balance": {
          const boxSafe = (mnt || "root").replace(/[^a-zA-Z0-9]/g, "-");
          const balBtn = $(`btn-balance-${boxSafe}`);
          const isRunning = balBtn && balBtn.getAttribute("data-running") === "true";

          if (isRunning) {
            customConfirm(
              "Cancel Balance",
              `Cancel active balance operation on ${mnt}?`,
              "Cancel Balance",
              () => {
                termLog(mnt, `btrfs balance cancel ${mnt}`, "cmd");
                cmd(["btrfs", "balance", "cancel", mnt])
                  .then((o) => {
                    termLog(mnt, `Balance canceled: ${o}`, "warn");
                    if (activeBalanceTimers[mnt]) {
                      clearInterval(activeBalanceTimers[mnt]);
                      delete activeBalanceTimers[mnt];
                    }
                    if (balBtn) {
                      balBtn.innerText = "Balance";
                      balBtn.classList.remove("btn-danger");
                      balBtn.classList.add("btn-secondary");
                      balBtn.removeAttribute("data-running");
                    }
                    setTermStatus(mnt, "Canceled", false);
                  })
                  .catch((err) => termLog(mnt, `Error canceling balance: ${err.message}`, "err"));
              },
              true,
            );
            return;
          }

          customConfirm(
            "Start Balance",
            `Rebalance data & metadata chunks on ${mnt} (filters: -dusage=50 -musage=50)?`,
            "Start Balance",
            () => {
              termLog(mnt, `btrfs balance start --background -dusage=50 -musage=50 ${mnt}`, "cmd");
              setTermStatus(mnt, "Balancing...", true);
              if (balBtn) {
                balBtn.innerText = "Cancel Balance";
                balBtn.classList.remove("btn-secondary");
                balBtn.classList.add("btn-danger");
                balBtn.setAttribute("data-running", "true");
              }

              cmd(["btrfs", "balance", "start", "--background", "-dusage=50", "-musage=50", mnt])
                .then((out) => {
                  termLog(mnt, out || "Balance initiated in background. Monitoring progress...", "status");
                  startBalanceMonitor(mnt);
                })
                .catch((err) => {
                  termLog(mnt, `Balance failed: ${err.message}`, "err");
                  setTermStatus(mnt, "Error", false);
                  if (balBtn) {
                    balBtn.innerText = "Balance";
                    balBtn.classList.remove("btn-danger");
                    balBtn.classList.add("btn-secondary");
                    balBtn.removeAttribute("data-running");
                  }
                });
            },
          );
          break;
        }

        case "defrag": {
          customConfirm(
            "Defragment Volume",
            `Run recursive defragmentation on ${mnt}?`,
            "Start Defrag",
            () => {
              termLog(mnt, `btrfs filesystem defragment -r -v ${mnt}`, "cmd");
              setTermStatus(mnt, "Defragging...", true);

              const script = `
MNT="$1"
echo "> Initiating recursive defragmentation on $MNT..."
RAW=$(btrfs filesystem defragment -r -v "$MNT" 2>&1 || true)
TOTAL_LINES=$(echo "$RAW" | grep -c -v '^[[:space:]]*$' || true)
BUSY_COUNT=$(echo "$RAW" | grep -c "Text file busy" || true)

echo "$RAW" | head -n 25
if [ "$TOTAL_LINES" -gt 25 ]; then
    echo "... [Processed $(($TOTAL_LINES - 25)) more items]"
fi
echo "--------------------------------------------------"
if [ "$BUSY_COUNT" -gt 0 ]; then
    echo "> Defragmentation finished ($BUSY_COUNT active locked files skipped safely)."
else
    echo "> Defragmentation finished successfully with 0 errors."
fi
`;
              cmd(["sh", "-c", script, "--", mnt])
                .then((o) => {
                  termLog(mnt, o, "success");
                  setTermStatus(mnt, "Idle", false);
                })
                .catch((err) => {
                  termLog(mnt, `Defrag error: ${err.message}`, "err");
                  setTermStatus(mnt, "Error", false);
                });
            }
          );
          break;
        }

        case "device-stats": {
          termLog(mnt, `btrfs device stats -T ${mnt}`, "cmd");
          cmd(["btrfs", "device", "stats", "-T", mnt])
            .then((out) => {
              termLog(mnt, `[Device Health & I/O Stats]\n${out}`, "status");
            })
            .catch((err) => termLog(mnt, `Stats error: ${err.message}`, "err"));
          break;
        }

        case "clear-terminal": {
          const boxSafe = tgt.getAttribute("data-box");
          const b = $(`maint-console-${boxSafe}`);
          if (b) b.innerHTML = `<span class="term-muted">Console cleared. Ready for tasks.</span>`;
          break;
        }

        case "remove-missing-dev": {
          customConfirm(
            "Remove Missing Device",
            `Evacuate and permanently remove the missing / disconnected block device from ${mnt}?\n\nCommand: btrfs device remove missing ${mnt}`,
            "Remove Missing Device",
            () => {
              termLog(mnt, `btrfs device remove missing ${mnt}`, "cmd");
              setTermStatus(mnt, "Removing...", true);
              cmd(["btrfs", "device", "remove", "missing", mnt])
                .then((o) => {
                  termLog(mnt, `Missing device removed successfully:\n${o}`, "success");
                  setTermStatus(mnt, "Idle", false);
                  App.fetch();
                })
                .catch((err) => {
                  termLog(mnt, `Device removal error: ${err.message}`, "err");
                  setTermStatus(mnt, "Error", false);
                });
            },
            true,
          );
          break;
        }

        case "remove-dev":
          customConfirm(
            "Remove Device",
            `Evacuate and remove ${tgt.getAttribute("data-devpath")}?`,
            "Remove Device",
            () => {
              termLog(mnt, `btrfs device remove ${tgt.getAttribute("data-devpath")} ${mnt}`, "cmd");
              cmd(["btrfs", "device", "remove", tgt.getAttribute("data-devpath"), mnt])
                .then((o) => {
                  termLog(mnt, `Device removed successfully:\n${o}`, "success");
                  App.fetch();
                })
                .catch((err) => termLog(mnt, `Device removal error: ${err.message}`, "err"));
            },
            true,
          );
          break;

        case "add-dev-modal":
          if (!$("add-dev-modal")) return;
          $("add-dev-modal").classList.remove("hidden-element");
          $("modal-mount-target").innerText = mnt;
          $("btn-confirm-add-dev").setAttribute("data-mount", mnt);
          $("btn-confirm-add-dev").disabled = true;
          $("modal-disk-select").innerHTML =
            `<option value="">Scanning for empty block devices...</option>`;
          getEmptyDevices()
            .then((devs) => {
              if (devs.length === 0)
                $("modal-disk-select").innerHTML =
                  `<option value="">No safe empty disks found!</option>`;
              else {
                $("modal-disk-select").innerHTML = devs
                  .map(
                    (d) =>
                      `<option value="/dev/${d.name}">/dev/${d.name} (${d.size} - Unallocated)</option>`,
                  )
                  .join("");
                $("btn-confirm-add-dev").disabled = false;
              }
            })
            .catch(
              (err) =>
                ($("modal-disk-select").innerHTML =
                  `<option value="">Error: ${err.message}</option>`),
            );
          break;

        case "destroy-vol-modal": {
          const mount = tgt.getAttribute("data-mount") || "";
          const uuid = tgt.getAttribute("data-uuid") || "";
          const label = tgt.getAttribute("data-label") || "Volume";
          const devs = tgt.getAttribute("data-devs") || "";

          if (mount === "/" || label.toLowerCase().includes("root")) {
            customAlert("Protected", "Cannot destroy system root volume.");
            return;
          }

          $("destroy-vol-name").innerText = `${label} (${uuid})`;
          $("destroy-vol-devs").innerText = devs || "Member disks";

          const expectedText =
            label && label !== "System/Root (No Label)" ? label : "DELETE";
          $("destroy-vol-expected-text").innerText = expectedText;

          const confirmInput = $("destroy-vol-confirm-input");
          const execBtn = $("btn-execute-destroy-vol");
          confirmInput.value = "";
          execBtn.disabled = true;

          execBtn.setAttribute("data-mount", mount);
          execBtn.setAttribute("data-uuid", uuid);
          execBtn.setAttribute("data-devs", devs);
          execBtn.setAttribute("data-expected", expectedText);

          $("destroy-vol-modal").classList.remove("hidden-element");
          setTimeout(() => confirmInput.focus(), 100);
          break;
        }

        case "clean-orphaned-snaps":
          if (!App.orphanedSnaps || App.orphanedSnaps.length === 0) {
            customAlert("Notice", "No orphaned snapshot schedules found.");
            return;
          }
          const orphanNames = App.orphanedSnaps
            .map((o) => `• ${o.cfg} (Target: ${o.subvol || "Missing"})`)
            .join("\n");
          customConfirm(
            "Clean Broken Snapshot Schedules",
            `The following Snapper snapshot schedules belong to volumes that have been deleted or formatted outside BTRFS Manager:\n\n${orphanNames}\n\nRemove these broken configurations so they do not cause errors on active volumes?`,
            "Clean Up",
            () => {
              const script = `
CFG_LIST="$1"
for cfg in $CFG_LIST; do
    [ -z "$cfg" ] && continue
    if command -v snapper >/dev/null 2>&1; then
        snapper -c "$cfg" delete-config 2>/dev/null || true
    fi
    rm -f "/etc/snapper/configs/$cfg" 2>/dev/null || true
    for f in /etc/conf.d/snapper /etc/default/snapper /etc/sysconfig/snapper; do
        if [ -f "$f" ]; then
            sed -i -E "s/\\b$cfg\\b//g; s/\"[[:space:]]+/\"/; s/[[:space:]]+\"/\"/; s/[[:space:]]+/ /g" "$f" 2>/dev/null || true
        fi
    done
done
echo "Cleaned"
`;
              const cfgs = App.orphanedSnaps.map((o) => o.cfg).join(" ");
              cmd(["sh", "-c", script, "--", cfgs])
                .then(() => {
                  customAlert(
                    "Success",
                    "All broken snapshot schedules have been removed cleanly.",
                  );
                  App.orphanedSnaps = [];
                  App.renderOrphanBanner();
                  App.fetch();
                })
                .catch((err) =>
                  customAlert(
                    "Error",
                    "Failed to clean schedules: " + err.message,
                  ),
                );
            },
          );
          break;

        case "subvol-ops":
          const op = tgt.getAttribute("data-op");
          const p = tgt.getAttribute("data-path") || "";
          const i = tgt.getAttribute("data-index");
          const subId = tgt.getAttribute("data-subid") || "";
          const vClean = (mnt === "/" ? "root" : (mnt || "vol").replace(/\//g, "").replace(/[^a-zA-Z0-9]/g, "_")) || "vol";
          const sName = (dt) =>
            p ? `${p.split("/").pop()}_snap_${dt}` : `${vClean}_snap_${dt}`;

          if (op === "auto-snap") {
            if (!App.hasSnapper) {
              const script = `
if command -v dnf >/dev/null 2>&1; then echo "sudo dnf install snapper"
elif command -v pacman >/dev/null 2>&1; then echo "sudo pacman -S snapper"
elif command -v apt-get >/dev/null 2>&1; then echo "sudo apt install snapper"
else echo "Please install 'snapper' using your system package manager."
fi`;
              cmd(["sh", "-c", script])
                .then((cmdText) => {
                  customAlert(
                    "Snapper Required",
                    `The automated snapshot timeline feature requires the 'snapper' package.\n\nInstall it on this server by running:\n${cmdText.trim()}\n\nAfter installation, reload Cockpit to configure schedules.`,
                  );
                })
                .catch(() => {
                  customAlert(
                    "Snapper Required",
                    "The automated snapshot timeline feature requires 'snapper'. Please install it on your server (e.g. 'sudo dnf install snapper' or 'sudo pacman -S snapper').",
                  );
                });
              return;
            }
            const targetName = p ? `/${p}` : (mnt === "/" ? "Root Volume" : mnt);
            customSelect(
              "Snapper Integration",
              `Select Snapper timeline schedule for ${targetName}:`,
              [
                {
                  v: "disable",
                  l: "Disable Snapper Timeline (Delete Configuration)",
                },
                { v: "hourly", l: "Hourly Timeline (Hourly + Daily retention)" },
                { v: "daily", l: "Daily Timeline (Daily retention)" },
                { v: "weekly", l: "Weekly Timeline (Weekly retention)" },
              ],
              "Next",
              (freq) => {
                if (!freq) return;
                const targetDir = p
                  ? mnt === "/"
                    ? `/${p}`
                    : `${mnt}/${p}`
                  : mnt;
                const cleanOldCron = `
for cdir in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
    if [ -d "$cdir" ]; then
        for cfile in "$cdir"/btrfs_*; do
            [ -f "$cfile" ] || continue
            if grep -qs "$1" "$cfile"; then
                rm -f "$cfile" 2>/dev/null || true
            fi
        done
    fi
done
`;

                if (freq === "disable") {
                  const bashScript = `
TARGET="$1"
${cleanOldCron}
if ! command -v snapper >/dev/null 2>&1; then echo "ERROR: Snapper is not installed."; exit 1; fi;
CFG_NAME=$(snapper list-configs 2>/dev/null | awk -v mnt="$TARGET" '$3 == mnt || $3 == mnt"/" {print $1; exit}')
if [ -n "$CFG_NAME" ] && [ "$CFG_NAME" != "Config" ]; then
    snapper -c "$CFG_NAME" delete-config 2>/dev/null || true
    rm -f "/etc/snapper/configs/$CFG_NAME" 2>/dev/null || true
    for f in /etc/conf.d/snapper /etc/default/snapper /etc/sysconfig/snapper; do
        if [ -f "$f" ]; then
            sed -i -E "s/\\b$CFG_NAME\\b//g; s/\"[[:space:]]+/\"/; s/[[:space:]]+\"/\"/; s/[[:space:]]+/ /g" "$f" 2>/dev/null || true
        fi
    done
    echo "Snapper configuration '$CFG_NAME' disabled and deleted successfully."
else
    echo "No active Snapper config found for $TARGET, nothing to delete."
fi
`;
                  cmd(["sh", "-c", bashScript, "--", targetDir])
                    .then((out) => {
                      customAlert("Success", out);
                      App.fetch();
                    })
                    .catch((e) => customAlert("Error", e.message));
                } else {
                  setTimeout(() => {
                    customPrompt(
                      "Snapper Retention Limit",
                      "How many recent snapshots do you want Snapper to keep?",
                      "5",
                      "Apply to Snapper",
                      (limitStr) => {
                        if (!limitStr) return;
                        const limit = parseInt(limitStr, 10);
                        if (isNaN(limit) || limit < 1) {
                          customAlert("Error", "Invalid retention limit.");
                          return;
                        }

                        const bashScript = `
MNT_PT="$1"
FREQ="$2"
LIMIT="$3"
${cleanOldCron}
if ! command -v snapper >/dev/null 2>&1; then echo "ERROR: Snapper is not installed.\\nPlease install it first (e.g. dnf install snapper or apt install snapper or pacman -S snapper)."; exit 1; fi;

CFG_NAME=$(snapper list-configs 2>/dev/null | awk -v mnt="$MNT_PT" '$3 == mnt || $3 == mnt"/" {print $1; exit}')

if [ -z "$CFG_NAME" ] || [ "$CFG_NAME" = "Config" ]; then
    if [ "$MNT_PT" = "/" ]; then
        CFG_NAME="root"
    else
        CFG_NAME="vol_$(basename "$MNT_PT" | tr -dc 'a-zA-Z0-9')"
    fi
    snapper -c "$CFG_NAME" create-config "$MNT_PT" || { echo "ERROR: Failed to create snapper config for $MNT_PT."; exit 1; }
fi

H=0; D=0; W=0
[ "$FREQ" = "hourly" ] && H="$LIMIT"
[ "$FREQ" = "daily" ] && D="$LIMIT"
[ "$FREQ" = "weekly" ] && W="$LIMIT"

snapper -c "$CFG_NAME" set-config TIMELINE_CREATE=yes TIMELINE_LIMIT_HOURLY="$H" TIMELINE_LIMIT_DAILY="$D" TIMELINE_LIMIT_WEEKLY="$W" TIMELINE_LIMIT_MONTHLY=0 TIMELINE_LIMIT_YEARLY=0

systemctl enable --now snapper-timeline.timer snapper-cleanup.timer >/dev/null 2>&1 || true

printf "Snapper successfully configured!\\nConfig Name: %s\\nFrequency: %s\\nRetention Limit: %s\\n" "$CFG_NAME" "$FREQ" "$LIMIT"
`;
                        cmd([
                          "sh",
                          "-c",
                          bashScript,
                          "--",
                          targetDir,
                          freq,
                          limitStr,
                        ])
                          .then((out) => {
                            customAlert("Success", out);
                            App.fetch();
                          })
                          .catch((e) => customAlert("Error", e.message));
                      },
                    );
                  }, 300);
                }
              },
            );
          } else if (op === "create") {
            const rawNm = $(`new-subvol-${i}`)?.value.trim();
            const nm = rawNm ? rawNm.replace(/[^a-zA-Z0-9._-]/g, "") : "";
            if (!nm || nm === "." || nm === "..") {
              customAlert("Error", "Valid subvolume name required (letters, numbers, dashes, underscores).");
              return;
            }
            cmd([
              "btrfs",
              "subvolume",
              "create",
              mnt === "/" ? `/${nm}` : `${mnt}/${nm}`,
            ])
              .then(() => {
                if ($(`new-subvol-${i}`)) $(`new-subvol-${i}`).value = "";
                App.fetchSubvols(mnt, i);
              })
              .catch((e) => customAlert("Failed", e.message));
          } else if (op === "del") {
            const isSnapshotContainer =
              p === ".snapshots" ||
              p === "@snapshots" ||
              p.endsWith("/.snapshots") ||
              p.endsWith("/@snapshots");
            if (isSnapshotContainer) {
              customAlert(
                "Protected Snapshot Storage",
                "Cannot delete the parent snapshot storage directory.",
              );
              return;
            }

            const mountedAt = tgt.getAttribute("data-mounted-at") || "";
            const isProtected =
              tgt.getAttribute("data-is-protected") === "true" ||
              Boolean(mountedAt) ||
              (mnt === "/" &&
                (p === "@" ||
                  p === "" ||
                  p === "root" ||
                  p === "rootfs" ||
                  p === "@root"));

            if (isProtected) {
              customAlert(
                "Protected Active Subvolume",
                `This subvolume is currently mounted on "${mountedAt || "/"}" (or configured in /etc/fstab) and cannot be deleted while active on the system.`,
              );
              return;
            }

            customConfirm(
              "Delete Subvolume / Snapshot",
              `Delete "${p}"? All files inside will be permanently deleted.`,
              "Delete",
              () => {
                const script = `
MNT="$1"
SUB_PATH="$2"
SUB_ID="$3"

# 1. If this is a Snapper snapshot (.snapshots/<id>/snapshot), delete via snapper CLI to keep metadata clean
if echo "$SUB_PATH" | grep -q -E "(^|/)\\.snapshots/([0-9]+)/snapshot$"; then
    SNAP_NUM=$(echo "$SUB_PATH" | sed -n -E "s/.*\\.snapshots\\/([0-9]+)\\/snapshot$/\\1/p")
    if [ -n "$SNAP_NUM" ] && command -v snapper >/dev/null 2>&1; then
        CFG=$(snapper list-configs 2>/dev/null | awk -v mnt="$MNT" '$3 == mnt || $3 == mnt"/" {print $1; exit}')
        if [ -n "$CFG" ] && [ "$CFG" != "Config" ]; then
            if snapper -c "$CFG" delete "$SNAP_NUM" 2>/dev/null; then
                echo "Deleted via Snapper"
                exit 0
            fi
        fi
    fi
fi

# Safety check: Verify against any active real mountpoint or fstab
FOUND_MOUNT=$(findmnt -n -l -o TARGET,SOURCE -t btrfs 2>/dev/null | grep -v "^/tmp" | while read -r t_m s_m; do
    s_in=$(echo "$s_m" | sed -n "s/.*\\[\\/*\\(.*\\)\\]/\\1/p")
    if [ -n "$s_in" ] && [ "$s_in" = "$SUB_PATH" ]; then
        echo "$t_m"
        break
    fi
done)
if [ -n "$FOUND_MOUNT" ]; then
    echo "ERROR: Subvolume is actively mounted on $FOUND_MOUNT. Deletion blocked."
    exit 1
fi
if grep -qs -E "subvol=(/|@)?$SUB_PATH\\b" /etc/fstab; then
    echo "ERROR: Subvolume is referenced in /etc/fstab. Deletion blocked."
    exit 1
fi

DEV=$(findmnt -n -o SOURCE -T "$MNT" 2>/dev/null | head -n 1 | sed 's/\\[.*\\]//')
[ -z "$DEV" ] && DEV=$(df "$MNT" 2>/dev/null | awk 'NR==2 {print $1}')
echo "$DEV" | grep -q "^UUID=" && DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1)
echo "$DEV" | grep -q "^LABEL=" && DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1)

TMP=$(mktemp -d)
trap 'umount "$TMP" 2>/dev/null || umount -l "$TMP" 2>/dev/null || true; rmdir "$TMP" 2>/dev/null || true' EXIT
IS_MOUNTED=0
if [ -b "$DEV" ] || [ -n "$DEV" ]; then
    if mount -t btrfs -o subvolid=5 "$DEV" "$TMP" 2>/dev/null; then
        IS_MOUNTED=1
    fi
fi

DELETED=0
LAST_ERR=""
if [ "$IS_MOUNTED" -eq 1 ] && [ -e "$TMP/$SUB_PATH" ]; then
    ERR=$(btrfs subvolume delete "$TMP/$SUB_PATH" 2>&1) && DELETED=1 || LAST_ERR="$ERR"
fi

if [ "$DELETED" -eq 0 ]; then
    if [ -e "$MNT/$SUB_PATH" ]; then
        ERR=$(btrfs subvolume delete "$MNT/$SUB_PATH" 2>&1) && DELETED=1 || LAST_ERR="$ERR"
    elif [ -e "/$SUB_PATH" ]; then
        ERR=$(btrfs subvolume delete "/$SUB_PATH" 2>&1) && DELETED=1 || LAST_ERR="$ERR"
    elif [ -n "$SUB_ID" ]; then
        ERR=$(btrfs subvolume delete -i "$SUB_ID" "$MNT" 2>&1) && DELETED=1 || LAST_ERR="$ERR"
    fi
fi

if [ "$IS_MOUNTED" -eq 1 ]; then
    umount "$TMP" 2>/dev/null || umount -l "$TMP" 2>/dev/null || true
fi
rmdir "$TMP" 2>/dev/null || true

if [ "$DELETED" -eq 1 ]; then
    echo "Deleted"
    exit 0
else
    echo "Failed to delete subvolume '$SUB_PATH': \${LAST_ERR:-Unknown error}"
    exit 1
fi
`;
                cmd(["sh", "-c", script, "--", mnt, p, subId])
                  .then(() => App.fetchSubvols(mnt, i))
                  .catch((e) => customAlert("Failed", e.message));
              },
              true,
            );
          } else if (op === "clone-snap") {
            const snapBase = p.split("/").pop();
            const defaultCloneName = `${snapBase}_restored`;
            customPrompt(
              "Restore / Clone Snapshot",
              "Enter a name for the new subvolume (will be created as read-write):",
              defaultCloneName,
              "Clone Subvolume",
              (newSubvolName) => {
                if (!newSubvolName) return;
                const cleanSubvol = newSubvolName.trim().replace(/[^a-zA-Z0-9._-]/g, "");
                if (!cleanSubvol) {
                  customAlert("Error", "Valid subvolume name required (letters, numbers, dashes, underscores).");
                  return;
                }
                const script = `
MNT="$1"
SNAP_PATH="$2"
NEW_NAME="$3"

DEV=$(findmnt -n -o SOURCE -T "$MNT" 2>/dev/null | head -n 1 | sed 's/\\[.*\\]//')
[ -z "$DEV" ] && DEV=$(df "$MNT" 2>/dev/null | awk 'NR==2 {print $1}')
echo "$DEV" | grep -q "^UUID=" && DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1)

SRC_PATH=""
if [ -e "$MNT/$SNAP_PATH" ] && btrfs subvolume show "$MNT/$SNAP_PATH" >/dev/null 2>&1; then
    SRC_PATH="$MNT/$SNAP_PATH"
elif [ -e "/$SNAP_PATH" ] && btrfs subvolume show "/$SNAP_PATH" >/dev/null 2>&1; then
    SRC_PATH="/$SNAP_PATH"
else
    TMP=$(mktemp -d)
    trap 'umount "$TMP" 2>/dev/null || umount -l "$TMP" 2>/dev/null || true; rmdir "$TMP" 2>/dev/null || true' EXIT
    if [ -b "$DEV" ] && mount -t btrfs -o subvolid=5 "$DEV" "$TMP" 2>/dev/null; then
        if [ -e "$TMP/$SNAP_PATH" ]; then
            DEST_PATH="$MNT/$NEW_NAME"
            [ "$MNT" = "/" ] && DEST_PATH="/$NEW_NAME"
            ERR=$(btrfs subvolume snapshot "$TMP/$SNAP_PATH" "$DEST_PATH" 2>&1)
            RES=$?
            umount "$TMP" 2>/dev/null || true
            rmdir "$TMP" 2>/dev/null || true
            if [ $RES -eq 0 ]; then
                echo "Snapshot restored successfully to $DEST_PATH"
                exit 0
            else
                echo "ERROR: $ERR"
                exit 1
            fi
        fi
        umount "$TMP" 2>/dev/null || true
    fi
    rmdir "$TMP" 2>/dev/null || true
fi

DEST_PATH="$MNT/$NEW_NAME"
[ "$MNT" = "/" ] && DEST_PATH="/$NEW_NAME"

if [ -z "$SRC_PATH" ]; then
    echo "ERROR: Could not locate snapshot source '/$SNAP_PATH'."
    exit 1
fi

if [ -e "$DEST_PATH" ]; then
    echo "ERROR: Destination path '$DEST_PATH' already exists."
    exit 1
fi

ERR=$(btrfs subvolume snapshot "$SRC_PATH" "$DEST_PATH" 2>&1)
if [ $? -eq 0 ]; then
    echo "Snapshot restored successfully to $DEST_PATH"
    exit 0
else
    echo "ERROR: $ERR"
    exit 1
fi
`;
                cmd(["sh", "-c", script, "--", mnt, p, cleanSubvol])
                  .then((out) => {
                    customAlert("Restore / Clone Success", out);
                    App.fetchSubvols(mnt, i || tgt.getAttribute("data-index"));
                  })
                  .catch((e) => customAlert("Clone Failed", e.message));
              },
            );
          } else if (op === "toggle-ro") {
            const targetRo = tgt.getAttribute("data-ro") === "true";
            const actionWord = targetRo ? "Lock as Read-Only" : "Unlock as Read-Write";
            customConfirm(
              `${actionWord}`,
              `Change permissions for "/${p}" to ${targetRo ? "Read-Only (write-protected)" : "Read-Write"}?`,
              actionWord,
              () => {
                const script = `
MNT="$1"
SUB_PATH="$2"
VAL="$3"

DEV=$(findmnt -n -o SOURCE -T "$MNT" 2>/dev/null | head -n 1 | sed 's/\\[.*\\]//')
[ -z "$DEV" ] && DEV=$(df "$MNT" 2>/dev/null | awk 'NR==2 {print $1}')
echo "$DEV" | grep -q "^UUID=" && DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1)

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

TARGET_PATH=""
if [ "$IS_MOUNTED" -eq 1 ] && [ -e "$TMP/$SUB_PATH" ]; then
    TARGET_PATH="$TMP/$SUB_PATH"
elif [ -e "$MNT/$SUB_PATH" ]; then
    TARGET_PATH="$MNT/$SUB_PATH"
elif [ -e "/$SUB_PATH" ]; then
    TARGET_PATH="/$SUB_PATH"
fi

RES=1
if [ -n "$TARGET_PATH" ]; then
    btrfs property set "$TARGET_PATH" ro "$VAL"
    RES=$?
fi

if [ "$IS_MOUNTED" -eq 1 ]; then
    umount "$TMP" 2>/dev/null || umount -l "$TMP" 2>/dev/null || true
fi
rmdir "$TMP" 2>/dev/null || true
exit $RES
`;
                cmd(["sh", "-c", script, "--", mnt, p, targetRo ? "true" : "false"])
                  .then(() => {
                    customAlert("Success", `Subvolume /${p} permission changed to ${targetRo ? "Read-Only" : "Read-Write"}.`);
                    App.fetchSubvols(mnt, i || tgt.getAttribute("data-index"));
                  })
                  .catch((e) => customAlert("Error", "Failed to change property: " + e.message));
              },
            );
          } else if (op.startsWith("snap")) {
            const snapPromptTitle = p
              ? `Snapshot Subvolume (/${p})`
              : mnt === "/"
                ? "Snapshot Root (/)"
                : `Snapshot Volume (${mnt})`;
            customPrompt(
              snapPromptTitle,
              "Snapshot Name:",
              sName(
                new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
              ),
              "Create Snapshot",
              (n) => {
                if (!n) return;
                const cleanName = n.trim().replace(/[^a-zA-Z0-9._-]/g, "");
                if (!cleanName) {
                  customAlert("Error", "Valid snapshot name required (letters, numbers, dashes, underscores).");
                  return;
                }
                const script = `
MNT="$1"
SUB_PATH="$2"
DEST="$3"

DEV=$(findmnt -n -o SOURCE -T "$MNT" 2>/dev/null | head -n 1 | sed 's/\\[.*\\]//')
[ -z "$DEV" ] && DEV=$(df "$MNT" 2>/dev/null | awk 'NR==2 {print $1}')
echo "$DEV" | grep -q "^UUID=" && DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1)

# 1. Determine exact source subvolume
TARGET_SRC=""
if [ -n "$SUB_PATH" ]; then
    if [ -d "$MNT/$SUB_PATH" ] && btrfs subvolume show "$MNT/$SUB_PATH" >/dev/null 2>&1; then
        TARGET_SRC="$MNT/$SUB_PATH"
    elif [ -d "/$SUB_PATH" ] && btrfs subvolume show "/$SUB_PATH" >/dev/null 2>&1; then
        TARGET_SRC="/$SUB_PATH"
    fi
fi

if [ -z "$TARGET_SRC" ]; then
    if btrfs subvolume show "$MNT" >/dev/null 2>&1; then
        TARGET_SRC="$MNT"
    else
        FSROOT_DETECT=$(findmnt -n -o FSROOT -T "$MNT" 2>/dev/null | head -n 1 | sed 's/^\///')
        if [ -n "$FSROOT_DETECT" ] && [ "$FSROOT_DETECT" != "root" ] && [ -d "$MNT/$FSROOT_DETECT" ] && btrfs subvolume show "$MNT/$FSROOT_DETECT" >/dev/null 2>&1; then
            TARGET_SRC="$MNT/$FSROOT_DETECT"
        else
            TARGET_SRC="$MNT"
        fi
    fi
fi

# 2. Check if subvolid=5 temp mount is allowed (Arch Linux / non-SELinux standard)
TMP=$(mktemp -d)
trap 'umount "$TMP" 2>/dev/null || umount -l "$TMP" 2>/dev/null || true; rmdir "$TMP" 2>/dev/null || true' EXIT
IS_MOUNTED=0
if [ -b "$DEV" ] || [ -n "$DEV" ]; then
    if mount -t btrfs -o subvolid=5 "$DEV" "$TMP" 2>/dev/null; then
        IS_MOUNTED=1
    fi
fi

SNAP_DONE=0
ERROR_MSG=""

# Method A: Top-level pool snapshot (stores in top level subvolid=5)
if [ "$IS_MOUNTED" -eq 1 ]; then
    FSROOT_RAW=$(findmnt -n -o FSROOT -T "$TARGET_SRC" 2>/dev/null | head -n 1 | sed 's/^\///')
    SRC_IN_POOL=""
    if [ -n "$FSROOT_RAW" ] && [ -e "$TMP/$FSROOT_RAW" ]; then
        SRC_IN_POOL="$TMP/$FSROOT_RAW"
    elif [ -n "$SUB_PATH" ] && [ -e "$TMP/$SUB_PATH" ]; then
        SRC_IN_POOL="$TMP/$SUB_PATH"
    fi

    if [ -n "$SRC_IN_POOL" ]; then
        ERR=$(btrfs subvolume snapshot "$SRC_IN_POOL" "$TMP/$DEST" 2>&1) && SNAP_DONE=1 || ERROR_MSG="$ERR"
    else
        ERR=$(btrfs subvolume snapshot "$TARGET_SRC" "$TMP/$DEST" 2>&1) && SNAP_DONE=1 || ERROR_MSG="$ERR"
    fi
fi

# Method B: Universal local snapshot (works seamlessly on Fedora/RHEL with SELinux)
if [ "$SNAP_DONE" -eq 0 ]; then
    SNAP_DIR=""
    if [ -d "$MNT/.snapshots" ]; then
        SNAP_DIR="$MNT/.snapshots"
    elif [ "$MNT" = "/" ] && [ -d "/.snapshots" ]; then
        SNAP_DIR="/.snapshots"
    else
        if mkdir -p "$MNT/.snapshots" 2>/dev/null; then
            SNAP_DIR="$MNT/.snapshots"
        else
            SNAP_DIR="$MNT"
        fi
    fi

    TARGET_DEST="$SNAP_DIR/$DEST"
    ERR=$(btrfs subvolume snapshot "$TARGET_SRC" "$TARGET_DEST" 2>&1)
    if [ $? -eq 0 ]; then
        SNAP_DONE=1
    else
        ERROR_MSG="$ERR"
    fi
fi

if [ "$IS_MOUNTED" -eq 1 ]; then
    umount "$TMP" 2>/dev/null || umount -l "$TMP" 2>/dev/null || true
fi
rmdir "$TMP" 2>/dev/null || true

if [ "$SNAP_DONE" -eq 1 ]; then
    echo "Success"
    exit 0
else
    echo "ERROR: \${ERROR_MSG:-Failed to create snapshot. Ensure volume is mounted read-write.}"
    exit 1
fi
`;
                cmd(["sh", "-c", script, "--", mnt, p, cleanName])
                  .then(() =>
                    App.fetchSubvols(
                      mnt,
                      i || tgt.getAttribute("data-index"),
                    ),
                  )
                  .catch((e) => customAlert("Snapshot Failed", e.message));
              },
            );
          } else if (op === "disable-cow" || op === "enable-cow") {
            const isDisable = op === "disable-cow";
            const flag = isDisable ? "+C" : "-C";
            const actionWord = isDisable ? "Disable" : "Enable";
            const noteMsg = isDisable
              ? "Note: Disabling CoW (No_COW) is highly recommended for database folders or VM image directories. It will only apply to *new* files created inside this subvolume going forward."
              : "Note: Re-enabling CoW allows BTRFS to securely snapshot and checksum future files.";

            customConfirm(
              `${actionWord} CoW`,
              `${actionWord} Copy-on-Write for "/${p}"?\n\n${noteMsg}`,
              actionWord,
              () => {
                const script = `
MNT="$1"
SUB_PATH="$2"
FLAG="$3"

DEV=$(findmnt -n -o SOURCE -T "$MNT" 2>/dev/null | sed 's/\\[.*\\]//' | head -n 1)
[ -z "$DEV" ] && DEV=$(df "$MNT" 2>/dev/null | awk 'NR==2 {print $1}')
echo "$DEV" | grep -q "^UUID=" && DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1)

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

TARGET_PATH=""
if [ "$IS_MOUNTED" -eq 1 ] && [ -e "$TMP/$SUB_PATH" ]; then
    TARGET_PATH="$TMP/$SUB_PATH"
elif [ -e "$MNT/$SUB_PATH" ]; then
    TARGET_PATH="$MNT/$SUB_PATH"
elif [ -e "/$SUB_PATH" ]; then
    TARGET_PATH="/$SUB_PATH"
fi

if [ -n "$TARGET_PATH" ]; then
    chattr "$FLAG" "$TARGET_PATH"
    RES=$?
else
    RES=1
fi

if [ "$IS_MOUNTED" -eq 1 ]; then
    umount "$TMP" 2>/dev/null || umount -l "$TMP" 2>/dev/null || true
fi
rmdir "$TMP" 2>/dev/null || true
exit $RES
`;
                cmd(["sh", "-c", script, "--", mnt, p, flag])
                  .then(() => {
                    customAlert(
                      "Success",
                      `CoW successfully ${isDisable ? "disabled" : "enabled"} for /${p}`,
                    );
                    App.fetchSubvols(mnt, i);
                  })
                  .catch((e) =>
                    customAlert(
                      "Error",
                      "Failed to modify CoW attributes: " + e.message,
                    ),
                  );
              },
            );
          } else if (op === "purge-snaps") {
            customConfirm(
              "Purge Old Snapshots",
              "Purge all old snapshots that exceed Snapper / timeline retention policies?",
              "Purge Now",
              () => {
                const bashScript = `
TARGET="$1"
if command -v snapper >/dev/null 2>&1; then
    CFG=$(snapper list-configs 2>/dev/null | awk -v mnt="$TARGET" '$3 == mnt || $3 == mnt"/" {print $1; exit}')
    if [ -n "$CFG" ] && [ "$CFG" != "Config" ]; then
        snapper -c "$CFG" cleanup timeline
        snapper -c "$CFG" cleanup number
        echo "Snapper cleanup completed."
    else
        echo "No Snapper config found for this volume."
    fi
else
    echo "Snapper not installed."
fi
`;
                termLog(mnt, `snapper cleanup timeline on ${mnt}`, "cmd");
                cmd(["sh", "-c", bashScript, "--", mnt])
                  .then((o) => {
                    termLog(mnt, o, "success");
                    App.fetch();
                  })
                  .catch((err) => termLog(mnt, `Cleanup error: ${err.message}`, "err"));
              },
            );
          }
          break;
      }
    } catch (err) {
      customAlert("Execution Error", err.message);
    }
  });

  on("generic-modal-cancel", "click", () => Modal.close());
  on("generic-modal-confirm", "click", () => Modal.confirm());
  on("btn-back-master", "click", () => {
    $("view-detail").classList.add("hidden-element");
    $("view-master").classList.remove("hidden-element");
    $("detail-container").setAttribute("data-active-index", "");
  });
  on("btn-close-add-modal", "click", () =>
    $("add-dev-modal").classList.add("hidden-element"),
  );

  on("btn-confirm-add-dev", "click", (e) => {
    const mnt = e.target.getAttribute("data-mount");
    const newDev = $("modal-disk-select").value;
    if (!newDev) return;
    $("add-dev-modal").classList.add("hidden-element");

    termLog(mnt, `btrfs device add -f ${newDev} ${mnt}`, "cmd");
    setTermStatus(mnt, "Adding...", true);

    cmd(["btrfs", "device", "add", "-f", newDev, mnt])
      .then((o) => {
        termLog(mnt, `Device ${newDev} added successfully.\n${o}`, "success");
        setTermStatus(mnt, "Idle", false);
        App.fetch();
      })
      .catch((e) => {
        termLog(mnt, `Failed to add device: ${e.message}`, "err");
        setTermStatus(mnt, "Error", false);
      });
  });

  on("btn-create-raid", "click", () => {
    $("raid-form").classList.remove("hidden-element");
    $("format-status").classList.add("hidden-element");
    $("available-disks").innerHTML = "Scanning block devices...";
    getEmptyDevices()
      .then((devs) => {
        $("available-disks").innerHTML =
          devs
            .map(
              (d) =>
                `<label class="disk-label-item"><input type="checkbox" name="tgt-disk" value="/dev/${d.name}"> <span class="btrfs-code">/dev/${d.name}</span> - Capacity: ${d.size}</label>`,
            )
            .join("") ||
          "<span class='text-danger'>No safe empty disks found.</span>";
        $("btn-execute-format").disabled = !devs.length;
      })
      .catch(
        (err) =>
          ($("available-disks").innerHTML = "Scan failed: " + err.message),
      );
  });

  on("destroy-vol-confirm-input", "input", (e) => {
    const expected = $("btn-execute-destroy-vol").getAttribute("data-expected");
    $("btn-execute-destroy-vol").disabled =
      e.target.value.trim() !== expected;
  });

  on("btn-cancel-destroy-vol", "click", () => {
    $("destroy-vol-modal").classList.add("hidden-element");
  });

  on("btn-execute-destroy-vol", "click", (e) => {
    const mount = e.target.getAttribute("data-mount") || "";
    const uuid = e.target.getAttribute("data-uuid") || "";
    const devs = e.target.getAttribute("data-devs") || "";

    $("destroy-vol-modal").classList.add("hidden-element");

    const script = `
MNT="$1"
UUID="$2"
DEVS="$3"

# 1. Clean any Snapper config associated with this mount or subvolumes
if command -v snapper >/dev/null 2>&1; then
    CFGS=$(snapper list-configs 2>/dev/null | awk -v mnt="$MNT" 'NR>2 && ($3 == mnt || $3 ~ "^"mnt"/" || $3 == mnt) {print $1}')
    for cfg in $CFGS; do
        [ -n "$cfg" ] && [ "$cfg" != "Config" ] && snapper -c "$cfg" delete-config 2>/dev/null || true
        rm -f "/etc/snapper/configs/$cfg" 2>/dev/null || true
        for f in /etc/conf.d/snapper /etc/default/snapper /etc/sysconfig/snapper; do
            if [ -f "$f" ]; then
                sed -i -E "s/\\b$cfg\\b//g; s/\"[[:space:]]+/\"/; s/[[:space:]]+\"/\"/; s/[[:space:]]+/ /g" "$f" 2>/dev/null || true
            fi
        done
    done
fi

for cfg_file in /etc/snapper/configs/*; do
    [ -f "$cfg_file" ] || continue
    cfg_name=$(basename "$cfg_file")
    [ "$cfg_name" = "root" ] && continue
    subvol=$(grep -E "^SUBVOLUME=" "$cfg_file" 2>/dev/null | cut -d'=' -f2 | tr -d '"'\\')
    if [ -n "$subvol" ] && [ -n "$MNT" ] && { [ "$subvol" = "$MNT" ] || echo "$subvol" | grep -q "^$MNT/"; }; then
        snapper -c "$cfg_name" delete-config 2>/dev/null || true
        rm -f "$cfg_file" 2>/dev/null || true
        for f in /etc/conf.d/snapper /etc/default/snapper /etc/sysconfig/snapper; do
            if [ -f "$f" ]; then
                sed -i -E "s/\\b$cfg_name\\b//g; s/\"[[:space:]]+/\"/; s/[[:space:]]+\"/\"/; s/[[:space:]]+/ /g" "$f" 2>/dev/null || true
            fi
        done
    fi
done

# 2. Clean cron snapshot scripts for this mount
if [ -n "$MNT" ] && [ "$MNT" != "/" ]; then
    for crondir in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
        if [ -d "$crondir" ]; then
            for cronfile in "$crondir"/*; do
                [ -f "$cronfile" ] || continue
                if grep -q "$MNT" "$cronfile" 2>/dev/null; then
                    rm -f "$cronfile" 2>/dev/null || true
                fi
            done
        fi
    done
fi

# 3. Unmount all mount points associated with this filesystem
if [ -n "$MNT" ] && [ "$MNT" != "/" ]; then
    umount -R "$MNT" 2>/dev/null || umount -l "$MNT" 2>/dev/null || true
fi
if [ -n "$UUID" ]; then
    findmnt -n -o TARGET -t btrfs --source "UUID=$UUID" 2>/dev/null | while read -r t; do
        [ -n "$t" ] && [ "$t" != "/" ] && { umount -R "$t" 2>/dev/null || umount -l "$t" 2>/dev/null || true; }
    done
fi

# 4. Wipe filesystem magic signatures from all member block devices
for dev in $DEVS; do
    if [ -b "$dev" ]; then
        wipefs -a -f "$dev" 2>/dev/null || true
    fi
done

echo "DELETED"
`;

    cmd(["sh", "-c", script, "--", mount, uuid, devs])
      .then(() => {
        cmd(["sh", "-c", `grep -qs -E "${uuid}|${mount}" /etc/fstab && echo "YES" || echo "NO"`])
          .then((fstabCheck) => {
            const hasFstab = (fstabCheck || "").trim() === "YES";
            if (hasFstab) {
              customAlert(
                "Volume Destroyed - Notice: /etc/fstab",
                "The BTRFS volume and member disk signatures were successfully wiped.\n\nIMPORTANT WARNING: An entry matching this volume is still in /etc/fstab. Remember to remove or comment out this entry in /etc/fstab before restarting your system to prevent boot errors.",
              );
            } else {
              customAlert(
                "Volume Destroyed",
                "The BTRFS volume and all associated snapshot schedules have been removed cleanly. Target member disks have been wiped and are now unallocated.",
              );
            }
            $("view-detail").classList.add("hidden-element");
            $("view-master").classList.remove("hidden-element");
            $("detail-container").setAttribute("data-active-index", "");
            App.fetch();
          })
          .catch(() => {
            customAlert("Volume Destroyed", "The BTRFS volume has been removed cleanly.");
            $("view-detail").classList.add("hidden-element");
            $("view-master").classList.remove("hidden-element");
            $("detail-container").setAttribute("data-active-index", "");
            App.fetch();
          });
      })
      .catch((err) => {
        customAlert("Error Destroying Volume", err.message);
        App.fetch();
      });
  });

  on("btn-cancel-format", "click", () =>
    $("raid-form").classList.add("hidden-element"),
  );
  on("btn-refresh", "click", () => App.fetch());

  on("btn-execute-format", "click", () => {
    const disks = Array.from(
      document.querySelectorAll('input[name="tgt-disk"]:checked'),
    ).map((cb) => cb.value);
    const prof = $("raid-profile").value;
    const lbl = $("volume-label").value.trim();
    if (!disks.length)
      return (
        ($("format-status").innerText = "Error: No disks selected!"),
        $("format-status").classList.remove("hidden-element"),
        ($("format-status").style.color = "var(--btn-danger)")
      );

    if ((prof === "raid0" || prof === "raid1") && disks.length < 2) {
      customAlert(
        "Insufficient Disks",
        `The ${prof.toUpperCase()} profile requires at least 2 disks. You selected ${disks.length}.`,
      );
      return;
    }
    if (prof === "raid10" && disks.length < 4) {
      customAlert(
        "Insufficient Disks",
        `The RAID 10 profile requires at least 4 disks. You selected ${disks.length}.`,
      );
      return;
    }

    customConfirm(
      "Confirm Format & Pool Creation",
      `Are you sure you want to format ${disks.length} device(s) into a new BTRFS pool (${prof.toUpperCase()})?\n\nTarget devices: ${disks.join(", ")}\n\nWARNING: All existing data on these disks will be PERMANENTLY ERASED.`,
      "Format & Create",
      () => {
        let c = ["mkfs.btrfs", "-d", prof, "-m", prof, "-f"];
        if (lbl) c.push("-L", lbl);
        c.push(...disks);
        $("format-status").classList.remove("hidden-element");
        $("format-status").style.color = "var(--btn-primary)";
        $("format-status").innerText = "> Formatting...";
        $("btn-execute-format").disabled = true;
        cmd(c)
          .then(() => {
            $("format-status").style.color = "var(--console-text)";
            $("format-status").innerText = "Success! Volume Formatted.";
            App.fetch();
            setTimeout(() => {
              $("raid-form").classList.add("hidden-element");
              $("btn-execute-format").disabled = false;
            }, 3000);
          })
          .catch((e) => {
            $("format-status").style.color = "var(--btn-danger)";
            $("format-status").innerText = "Failed:\n" + e.message;
            $("btn-execute-format").disabled = false;
          });
      },
      true,
    );
  });

  on("btn-toggle-theme", "click", () => toggleTheme());
  on("btn-toggle-theme-detail", "click", () => toggleTheme());

  on("btn-refresh-detail", "click", () => {
    const activeIdx = $("detail-container")
      ? $("detail-container").getAttribute("data-active-index")
      : null;
    App.fetch().then(() => {
      if (activeIdx !== null && activeIdx !== "") {
        App.renderDetail(activeIdx);
      }
    });
  });

  on("btn-update-extension", "click", () => {
    customConfirm(
      "Update BTRFS Manager Extension",
      "Update the extension to the latest version from the official GitHub repository (https://github.com/NGxID18/btrfs-manager)?\n\nThe system will fetch the latest code from origin/main and reload the interface.",
      "Update Now",
      () => {
        customAlert(
          "Updating Extension",
          "Downloading the latest updates from GitHub repository...",
        );
        const updateScript = `
TARGET_DIR="/usr/share/cockpit/btrfs-manager"
if [ -d "$HOME/.local/share/cockpit/btrfs-manager" ]; then
    TARGET_DIR="$HOME/.local/share/cockpit/btrfs-manager"
fi

if [ -d "$TARGET_DIR/.git" ]; then
    cd "$TARGET_DIR"
    git config --global --add safe.directory "$TARGET_DIR" 2>/dev/null || true
    git fetch origin main 2>&1
    git reset --hard origin/main 2>&1
    echo "SUCCESS"
else
    TMP_DIR=$(mktemp -d)
    trap 'rm -rf "$TMP_DIR"' EXIT
    git clone https://github.com/NGxID18/btrfs-manager "$TMP_DIR" 2>&1
    cp -rf "$TMP_DIR"/. "$TARGET_DIR"/
    echo "SUCCESS"
fi
`;
        cmd(["sh", "-c", updateScript])
          .then(() => {
            customAlert(
              "Update Successful!",
              "The extension has been successfully updated. The page will reload now...",
            );
            setTimeout(() => window.location.reload(), 1800);
          })
          .catch((err) => {
            customAlert(
              "Update Failed",
              "Failed to update extension:\n" + err.message,
            );
          });
      },
    );
  });
});
