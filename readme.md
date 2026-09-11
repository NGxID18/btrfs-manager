# BTRFS Manager for Cockpit

## Project Details
BTRFS Manager is a lightweight, native web interface extension for the Cockpit Project. It is designed to provide comprehensive management of BTRFS filesystems directly from your web browser. 

Built entirely with Vanilla JavaScript, HTML, and custom CSS, this extension closely mimics the native PatternFly design system utilized by Cockpit—including automatic Dark Mode support—without requiring complex build tools, Node.js, or NPM. 

By leveraging Cockpit's native `spawn` API, the extension communicates directly with the system's command-line utilities. This ensures maximum portability, zero backend daemon requirements, and immediate execution of advanced filesystem commands.

### Core Features
* Master-Detail Dashboard: A responsive grid layout that provides a high-level overview of all BTRFS volumes, with dedicated detail pages for advanced management.
* Volume & RAID Creation: Format empty block devices into new BTRFS volumes with support for Single, DUP, RAID 0, RAID 1, and RAID 10 profiles, with strict safety checks for unallocated disks.
* Volume Deletion & Teardown: Safely destroy non-root BTRFS pools with automated unmounting, full Snapper/Cron snapshot schedule purge, and disk signature wipe (`wipefs`).
* Orphaned Snapshot Cleaner: Automatically detects broken or stale Snapper configs pointing to removed drives and provides 1-click cleanup to prevent systemwide snapshot failures.
* Physical Device Management: View physical device topology, add new blank disks online, remove disks, and easily evacuate disconnected/failed drives with missing-device recovery.
* Device Health & Diagnostics: Real-time monitoring of disk I/O and checksum corruption counters (`btrfs device stats`) to catch failing hardware before data loss occurs.
* Subvolumes & Snapshots: Create and delete subvolumes with granular controls (CoW toggle, Read-Only locking, defragmentation). Take instant snapshots, restore/clone them to read-write subvolumes, or rollback the default mount.
* Storage Breakdown & Features: Visual progress bars for Data and Metadata chunk allocation with usage warnings, alongside auto-detection of compression algorithms (`zstd`, `lzo`) and mount features.
* Maintenance & Optimization: Non-blocking background scrub and balance with live terminal tracking, multi-volume concurrency, and targeted subvolume defragmentation.

## Dependencies
Make sure the following packages are installed on your system:

* `cockpit`: The core Cockpit web console.
* `btrfs-progs`: BTRFS filesystem management CLI tools.
* `util-linux`: Provides `lsblk` and `findmnt` used for storage topology discovery.
* `snapper` *(recommended)*: Required for automated timeline snapshots, retention limits, and cleanup schedules.
  * **Fedora / RHEL**: `sudo dnf install snapper`
  * **Arch Linux**: `sudo pacman -S snapper`
  * **Debian / Ubuntu**: `sudo apt install snapper`

## Installation
Because this is a vanilla frontend extension, no build process is required. You can install it simply by cloning the repository into your Cockpit extensions directory:

### User-only (no root required)
```bash
git clone https://github.com/NGxID18/btrfs-manager ~/.local/share/cockpit/btrfs-manager
```

### System-wide (all users)
```bash
sudo git clone https://github.com/NGxID18/btrfs-manager /usr/share/cockpit/btrfs-manager
```

After cloning, log in to Cockpit (or refresh the page) and select **BTRFS** from the sidebar.

## Usage Notes
* **Master View**: Provides a dashboard grid of all detected BTRFS pools, showing raw size, usable space, active RAID profiles, and snapshot schedules.
* **Detail View**: Click "Manage Volume" on any volume card to access device topology, subvolume tree, snapshot history, and maintenance controls.
* **Device Selection**: Only unallocated disks without existing filesystems or active mount points are shown when creating volumes or adding disks.
* **System Root Protection**: The operating system root pool (`/`) cannot be destroyed or wiped from the UI.
* **Rollbacks**: To rollback to a snapshot, click **Set as Default Mount** on the target snapshot subvolume.
