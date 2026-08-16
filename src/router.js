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

let activeScrubTimer = null;
let activeBalanceTimer = null;

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
};

const setTermStatus = (mnt, text, isRunning = false) => {
  const boxSafe = (mnt || "root").replace(/[^a-zA-Z0-9]/g, "-");
  const badge = $(`term-status-${boxSafe}`);
  if (badge) {
    badge.innerText = text;
    badge.className = "term-status-badge" + (isRunning ? " running" : "");
  }
};

document.addEventListener("DOMContentLoaded", () => {
  App.fetch();

  document.body.addEventListener("click", (e) => {
    const tgt = e.target.closest(".btn-action");
    if (!tgt) return;
    const action = tgt.getAttribute("data-action");
    const mnt = tgt.getAttribute("data-mount");

    try {
      switch (action) {
        case "open-detail":
          $("view-master").classList.add("hidden-element");
          $("view-detail").classList.remove("hidden-element");
          App.renderDetail(tgt.getAttribute("data-index"));
          break;

        case "convert-raid":
          customSelect(
            "Online RAID Conversion",
            "Select new profile:",
            [
              { v: "single", l: "Single" },
              { v: "raid0", l: "RAID 0" },
              { v: "raid1", l: "RAID 1" },
              { v: "raid10", l: "RAID 10" },
            ],
            "Convert",
            (p) => {
              if (p) {
                termLog(mnt, `btrfs balance start -f -dconvert=${p} -mconvert=${p} ${mnt}`, "cmd");
                setTermStatus(mnt, "Converting...", true);
                cmd(["btrfs", "balance", "start", "-f", "-dconvert=" + p, "-mconvert=" + p, mnt])
                  .then((o) => {
                    termLog(mnt, `Conversion to ${p} executed successfully!\n${o}`, "success");
                    setTermStatus(mnt, "Idle", false);
                    App.fetch();
                  })
                  .catch((err) => {
                    termLog(mnt, `Conversion failed: ${err.message}`, "err");
                    setTermStatus(mnt, "Error", false);
                  });
              }
            },
          );
          break;

        case "resize-vol":
          customPrompt(
            "Resize Volume",
            "Target size (e.g. 'max', '+10G'):",
            "max",
            "Resize",
            (sz) => {
              if (sz) {
                termLog(mnt, `btrfs filesystem resize ${sz} ${mnt}`, "cmd");
                cmd(["btrfs", "filesystem", "resize", sz, mnt])
                  .then((o) => {
                    termLog(mnt, `Resized successfully:\n${o}`, "success");
                    App.fetch();
                  })
                  .catch((err) => termLog(mnt, `Resize error: ${err.message}`, "err"));
              }
            },
          );
          break;

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
                    if (activeScrubTimer) clearInterval(activeScrubTimer);
                    activeScrubTimer = null;
                    if (scrubBtn) {
                      scrubBtn.innerText = "Scrub";
                      scrubBtn.classList.remove("btn-danger");
                      scrubBtn.classList.add("btn-primary");
                      scrubBtn.removeAttribute("data-running");
                    }
                    setTermStatus(mnt, "Canceled", false);
                  })
                  .catch((err) => termLog(mnt, `Error canceling scrub: ${err.message}`, "err"));
              }
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
                  if (activeScrubTimer) clearInterval(activeScrubTimer);
                  activeScrubTimer = setInterval(() => {
                    cmd(["btrfs", "scrub", "status", "-d", mnt])
                      .then((out) => {
                        const isFinished = out.includes("finished") || out.includes("aborted") || out.includes("canceled");
                        termLog(mnt, `[Scrub Status]\n${out}`);
                        if (isFinished) {
                          clearInterval(activeScrubTimer);
                          activeScrubTimer = null;
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
                  }, 2000);
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
            }
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
                    if (activeBalanceTimer) clearInterval(activeBalanceTimer);
                    activeBalanceTimer = null;
                    if (balBtn) {
                      balBtn.innerText = "Balance";
                      balBtn.classList.remove("btn-danger");
                      balBtn.classList.add("btn-secondary");
                      balBtn.removeAttribute("data-running");
                    }
                    setTermStatus(mnt, "Canceled", false);
                  })
                  .catch((err) => termLog(mnt, `Error canceling balance: ${err.message}`, "err"));
              }
            );
            return;
          }

          customConfirm(
            "Start Balance",
            `Rebalance data & metadata chunks on ${mnt}?`,
            "Start Balance",
            () => {
              termLog(mnt, `btrfs balance start -dusage=50 -musage=50 ${mnt}`, "cmd");
              setTermStatus(mnt, "Balancing...", true);
              if (balBtn) {
                balBtn.innerText = "Cancel Balance";
                balBtn.classList.remove("btn-secondary");
                balBtn.classList.add("btn-danger");
                balBtn.setAttribute("data-running", "true");
              }

              cmd(["btrfs", "balance", "start", "-dusage=50", "-musage=50", mnt])
                .then((out) => {
                  termLog(mnt, out || "Balance finished successfully.", "success");
                  setTermStatus(mnt, "Complete", false);
                  if (balBtn) {
                    balBtn.innerText = "Balance";
                    balBtn.classList.remove("btn-danger");
                    balBtn.classList.add("btn-secondary");
                    balBtn.removeAttribute("data-running");
                  }
                  App.fetch();
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
            }
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

        case "clear-terminal": {
          const boxSafe = tgt.getAttribute("data-box");
          const b = $(`maint-console-${boxSafe}`);
          if (b) b.innerHTML = `<span class="term-muted">Console cleared. Ready for tasks.</span>`;
          break;
        }

        case "remove-dev":
          customConfirm(
            "Remove Device",
            `Evacuate and remove ${tgt.getAttribute("data-devpath")}?`,
            "Remove",
            () => {
              termLog(mnt, `btrfs device remove ${tgt.getAttribute("data-devpath")} ${mnt}`, "cmd");
              cmd(["btrfs", "device", "remove", tgt.getAttribute("data-devpath"), mnt])
                .then((o) => {
                  termLog(mnt, `Device removed successfully:\n${o}`, "success");
                  App.fetch();
                })
                .catch((err) => termLog(mnt, `Device removal error: ${err.message}`, "err"));
            },
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

        case "manage-subvol": {
          if (!$("manage-subvol-modal")) return;
          $("manage-subvol-modal").classList.remove("hidden-element");
          const p = tgt.getAttribute("data-path") || "";
          const subId = tgt.getAttribute("data-subid") || "";
          const isRootSubvol =
            tgt.getAttribute("data-is-root") === "true" ||
            (mnt === "/" && (p === "@" || p === "" || p === "root" || p === "@root")) ||
            p === "@";

          $("modal-subvol-path").innerText = "/" + p;
          $("modal-subvol-id").innerText = "(ID: " + subId + ")";

          const isNoCow = tgt.getAttribute("data-nocow") === "true";
          const cowBtn = $("btn-toggle-cow");
          if (cowBtn) {
            cowBtn.innerText = isNoCow
              ? "Enable CoW (+C)"
              : "Disable CoW (No_COW)";
            cowBtn.setAttribute(
              "data-op",
              isNoCow ? "enable-cow" : "disable-cow",
            );
          }

          // Safety guard for root subvolume deletion
          const delBtn = $("btn-delete-subvol");
          const rootWarning = $("modal-subvol-root-warning");
          if (delBtn) {
            if (isRootSubvol) {
              delBtn.classList.add("hidden-element");
              delBtn.disabled = true;
              if (rootWarning) rootWarning.classList.remove("hidden-element");
            } else {
              delBtn.classList.remove("hidden-element");
              delBtn.disabled = false;
              if (rootWarning) rootWarning.classList.add("hidden-element");
            }
          }

          document
            .querySelectorAll("#manage-subvol-modal .btn-action")
            .forEach((b) => {
              b.setAttribute("data-mount", mnt);
              b.setAttribute("data-path", p);
              b.setAttribute("data-subid", subId);
              b.setAttribute("data-index", tgt.getAttribute("data-index"));
              b.setAttribute("data-is-root", isRootSubvol ? "true" : "false");
            });
          break;
        }

        case "subvol-ops":
          if ($("manage-subvol-modal"))
            $("manage-subvol-modal").classList.add("hidden-element");
          const op = tgt.getAttribute("data-op");
          const p = tgt.getAttribute("data-path") || "";
          const i = tgt.getAttribute("data-index");
          const subId = tgt.getAttribute("data-subid") || "";
          const sName = (dt) =>
            p ? `${p.split("/").pop()}_snap_${dt}` : `root_snap_${dt}`;

          if (op === "auto-snap") {
            const targetName = p ? `/${p}` : "Root Volume";
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
                const cleanOldCron =
                  "rm -f /etc/cron.hourly/btrfs_* /etc/cron.daily/btrfs_* /etc/cron.weekly/btrfs_* 2>/dev/null || true;";

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
            const nm = $(`new-subvol-${i}`)?.value.trim();
            if (!nm) {
              customAlert("Error", "Name required!");
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
            const isRootSubvol =
              tgt.getAttribute("data-is-root") === "true" ||
              (mnt === "/" && (p === "@" || p === "" || p === "root" || p === "@root")) ||
              p === "@";

            if (isRootSubvol) {
              customAlert(
                "Protected Root Subvolume",
                "This subvolume is the active Operating System Root (/) and cannot be deleted to prevent system destruction.",
              );
              return;
            }

            customConfirm(
              "Delete Subvolume",
              `Delete subvolume "${p}"? All files inside will be permanently deleted.`,
              "Delete",
              () => {
                const script = `
MNT="$1"
SUB_PATH="$2"
SUB_ID="$3"

# Kernel safety check: Verify against active system root subvolume
ACTIVE_ROOT_SUBVOL=$(findmnt -n -o FSROOT -T "/" 2>/dev/null | sed 's/^\\///')
if [ -n "$ACTIVE_ROOT_SUBVOL" ] && [ "$ACTIVE_ROOT_SUBVOL" = "$SUB_PATH" ]; then
    echo "ERROR: Protected active OS Root subvolume. Deletion blocked."
    exit 1
fi
if [ "$SUB_PATH" = "@" ] && [ "$MNT" = "/" ]; then
    echo "ERROR: Protected active OS Root subvolume. Deletion blocked."
    exit 1
fi

DEV=$(findmnt -n -o SOURCE -T "$MNT" 2>/dev/null | sed 's/\\[.*\\]//' | head -n 1)
[ -z "$DEV" ] && DEV=$(df "$MNT" 2>/dev/null | awk 'NR==2 {print $1}')
echo "$DEV" | grep -q "^UUID=" && DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1)
echo "$DEV" | grep -q "^LABEL=" && DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1)

TMP=$(mktemp -d)
IS_MOUNTED=0
if [ -b "$DEV" ] || [ -n "$DEV" ]; then
    if mount -t btrfs -o subvolid=5 "$DEV" "$TMP" 2>/dev/null; then
        IS_MOUNTED=1
    elif mount -t btrfs -o subvolid=5,context="system_u:object_r:tmp_t:s0" "$DEV" "$TMP" 2>/dev/null; then
        IS_MOUNTED=1
    fi
fi

DELETED=0
if [ "$IS_MOUNTED" -eq 1 ] && [ -e "$TMP/$SUB_PATH" ]; then
    btrfs subvolume delete "$TMP/$SUB_PATH" 2>/dev/null && DELETED=1
fi

if [ "$DELETED" -eq 0 ]; then
    if [ -e "$MNT/$SUB_PATH" ]; then
        btrfs subvolume delete "$MNT/$SUB_PATH" 2>/dev/null && DELETED=1
    elif [ -e "/$SUB_PATH" ]; then
        btrfs subvolume delete "/$SUB_PATH" 2>/dev/null && DELETED=1
    elif [ -n "$SUB_ID" ]; then
        btrfs subvolume delete -i "$SUB_ID" "$MNT" 2>/dev/null && DELETED=1
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
    echo "Failed to delete subvolume '$SUB_PATH'."
    exit 1
fi
`;
                cmd(["sh", "-c", script, "--", mnt, p, subId])
                  .then(() => App.fetchSubvols(mnt, i))
                  .catch((e) => customAlert("Failed", e.message));
              },
            );
          } else if (op.startsWith("snap")) {
            customPrompt(
              "Snapshot",
              "Name:",
              sName(
                new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
              ),
              "Create",
              (n) => {
                if (n) {
                  const script = `
MNT="$1"
SRC="$2"
DEST="$3"

DEV=$(findmnt -n -o SOURCE -T "$MNT" 2>/dev/null | sed 's/\\[.*\\]//' | head -n 1)
[ -z "$DEV" ] && DEV=$(df "$MNT" 2>/dev/null | awk 'NR==2 {print $1}')
echo "$DEV" | grep -q "^UUID=" && DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1)

TMP=$(mktemp -d)
IS_MOUNTED=0
if [ -b "$DEV" ] || [ -n "$DEV" ]; then
    if mount -t btrfs -o subvolid=5 "$DEV" "$TMP" 2>/dev/null; then
        IS_MOUNTED=1
    elif mount -t btrfs -o subvolid=5,context="system_u:object_r:tmp_t:s0" "$DEV" "$TMP" 2>/dev/null; then
        IS_MOUNTED=1
    fi
fi

SNAP_DONE=0
if [ "$IS_MOUNTED" -eq 1 ]; then
    if [ -z "$SRC" ]; then
        btrfs subvolume snapshot "$MNT" "$TMP/$DEST" 2>/dev/null && SNAP_DONE=1
    else
        btrfs subvolume snapshot "$TMP/$SRC" "$TMP/$DEST" 2>/dev/null && SNAP_DONE=1
    fi
fi

if [ "$SNAP_DONE" -eq 0 ]; then
    TARGET_SRC="$MNT"
    [ -n "$SRC" ] && [ -e "$MNT/$SRC" ] && TARGET_SRC="$MNT/$SRC"
    [ -n "$SRC" ] && [ -e "/$SRC" ] && TARGET_SRC="/$SRC"
    btrfs subvolume snapshot "$TARGET_SRC" "$MNT/$DEST" 2>/dev/null && SNAP_DONE=1
fi

if [ "$IS_MOUNTED" -eq 1 ]; then
    umount "$TMP" 2>/dev/null || umount -l "$TMP" 2>/dev/null || true
fi
rmdir "$TMP" 2>/dev/null || true

if [ "$SNAP_DONE" -eq 1 ]; then
    echo "Success"
    exit 0
else
    echo "Failed to create snapshot."
    exit 1
fi
`;
                  cmd(["sh", "-c", script, "--", mnt, p, n])
                    .then(() =>
                      App.fetchSubvols(
                        mnt,
                        i || tgt.getAttribute("data-index"),
                      ),
                    )
                    .catch((e) => customAlert("Failed", e.message));
                }
              },
            );
          } else if (op === "restore") {
            customPrompt(
              "Restore/Clone",
              "Target name:",
              p.split("_snap_")[0] + "_restored",
              "Restore",
              (n) => {
                if (n) {
                  const script = `
MNT="$1"
SRC="$2"
DEST="$3"

DEV=$(findmnt -n -o SOURCE -T "$MNT" 2>/dev/null | sed 's/\\[.*\\]//' | head -n 1)
[ -z "$DEV" ] && DEV=$(df "$MNT" 2>/dev/null | awk 'NR==2 {print $1}')
echo "$DEV" | grep -q "^UUID=" && DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1)

TMP=$(mktemp -d)
IS_MOUNTED=0
if [ -b "$DEV" ] || [ -n "$DEV" ]; then
    if mount -t btrfs -o subvolid=5 "$DEV" "$TMP" 2>/dev/null; then
        IS_MOUNTED=1
    elif mount -t btrfs -o subvolid=5,context="system_u:object_r:tmp_t:s0" "$DEV" "$TMP" 2>/dev/null; then
        IS_MOUNTED=1
    fi
fi

RESTORE_DONE=0
if [ "$IS_MOUNTED" -eq 1 ] && [ -e "$TMP/$SRC" ]; then
    btrfs subvolume snapshot "$TMP/$SRC" "$TMP/$DEST" 2>/dev/null && RESTORE_DONE=1
fi

if [ "$RESTORE_DONE" -eq 0 ]; then
    TARGET_SRC="$MNT/$SRC"
    [ ! -e "$TARGET_SRC" ] && [ -e "/$SRC" ] && TARGET_SRC="/$SRC"
    btrfs subvolume snapshot "$TARGET_SRC" "$MNT/$DEST" 2>/dev/null && RESTORE_DONE=1
fi

if [ "$IS_MOUNTED" -eq 1 ]; then
    umount "$TMP" 2>/dev/null || umount -l "$TMP" 2>/dev/null || true
fi
rmdir "$TMP" 2>/dev/null || true

if [ "$RESTORE_DONE" -eq 1 ]; then
    echo "Success"
    exit 0
else
    echo "Failed to restore snapshot."
    exit 1
fi
`;
                  cmd(["sh", "-c", script, "--", mnt, p, n])
                    .then(() => App.fetchSubvols(mnt, i))
                    .catch((e) => customAlert("Failed", e.message));
                }
              },
            );
          } else if (op === "quota") {
            customPrompt(
              "Quota",
              `Set max limit (e.g. 50G):`,
              "50G",
              "Apply",
              (l) => {
                if (l) {
                  const script = `
MNT="$1"
SUB_PATH="$2"
LIMIT="$3"

DEV=$(findmnt -n -o SOURCE -T "$MNT" 2>/dev/null | sed 's/\\[.*\\]//' | head -n 1)
[ -z "$DEV" ] && DEV=$(df "$MNT" 2>/dev/null | awk 'NR==2 {print $1}')
echo "$DEV" | grep -q "^UUID=" && DEV=$(blkid -t "$DEV" -o device 2>/dev/null | head -n 1)

TMP=$(mktemp -d)
IS_MOUNTED=0
if [ -b "$DEV" ] || [ -n "$DEV" ]; then
    if mount -t btrfs -o subvolid=5 "$DEV" "$TMP" 2>/dev/null; then
        IS_MOUNTED=1
    elif mount -t btrfs -o subvolid=5,context="system_u:object_r:tmp_t:s0" "$DEV" "$TMP" 2>/dev/null; then
        IS_MOUNTED=1
    fi
fi

btrfs quota enable "$MNT" 2>/dev/null || true
TARGET_PATH=""
if [ "$IS_MOUNTED" -eq 1 ] && [ -e "$TMP/$SUB_PATH" ]; then
    TARGET_PATH="$TMP/$SUB_PATH"
elif [ -e "$MNT/$SUB_PATH" ]; then
    TARGET_PATH="$MNT/$SUB_PATH"
elif [ -e "/$SUB_PATH" ]; then
    TARGET_PATH="/$SUB_PATH"
fi

if [ -n "$TARGET_PATH" ]; then
    btrfs qgroup limit "$LIMIT" "$TARGET_PATH"
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
                  cmd(["sh", "-c", script, "--", mnt, p, l])
                    .then(() => customAlert("Success", "Quota Applied"))
                    .catch((e) => customAlert("Error", e.message));
                }
              },
            );
          } else if (op === "default") {
            customConfirm(
              "Set Default",
              `Make ID ${tgt.getAttribute("data-subid")} default?`,
              "Confirm",
              () =>
                cmd([
                  "btrfs",
                  "subvolume",
                  "set-default",
                  tgt.getAttribute("data-subid"),
                  mnt,
                ])
                  .then(() => customAlert("Success", "Set as default root."))
                  .catch((e) => customAlert("Error", e.message)),
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
              "Hapus semua snapshot yang sudah tidak terpakai menurut kebijakan Snapper/Cron?",
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
  on("btn-close-subvol-modal", "click", () =>
    $("manage-subvol-modal").classList.add("hidden-element"),
  );
  on("btn-close-add-modal", "click", () =>
    $("add-dev-modal").classList.add("hidden-element"),
  );

  on("btn-confirm-add-dev", "click", (e) => {
    const mnt = e.target.getAttribute("data-mount");
    const newDev = $("modal-disk-select").value;
    if (!newDev) return;
    $("add-dev-modal").classList.add("hidden-element");

    const boxId = `maint-console-${(mnt || "").replace(/\//g, "-")}`;
    const updateBox = (text) => {
      const b = $(boxId);
      if (b) {
        b.classList.remove("hidden-element");
        b.innerText = text;
      }
    };

    updateBox(`Merging ${newDev}...`);
    cmd(["btrfs", "device", "add", "-f", newDev, mnt])
      .then((o) => {
        updateBox(`Added successfully.\n\n${o}`);
        App.fetch();
      })
      .catch((e) => updateBox("Failed: " + e.message));
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
        customAlert(
          "Volume Destroyed",
          "The BTRFS volume and all associated snapshot schedules have been removed cleanly. Target member disks have been wiped and are now unallocated.",
        );
        $("view-detail").classList.add("hidden-element");
        $("view-master").classList.remove("hidden-element");
        $("detail-container").setAttribute("data-active-index", "");
        App.fetch();
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
  });
});
